// How export, import, measuring and reference picking reach the kernel
// worker. The scene loader owns the kernel client and knows which kernel
// shape each viewport body is (the part bodies regen made, and imported
// reference bodies), so it provides an `Exchanger`, a `Measurer` and a
// `Referencer`. Imported STEP reference bodies are built here directly: one
// `feature` op with an `import` feature (faces named `import#k:face:<n>`),
// kept in the worker next to the part bodies; regen leaves reference imports
// out of the part. Reference bodies are measured but never exported, and are
// released once their import feature can no longer come back (see `retain`).
// After the kernel lost every shape (a recycle or a restart) they are read
// again from their files (see `reimport`).
//
// Every batch goes at the client's current generation: only a regen may take a
// new one, since a newer generation cancels the regen in flight and nothing
// would report in its place. Releases are not batches at all (see `release`).

import type {
  Deflection,
  EdgeRef,
  ExportStepOp,
  FaceRef,
  FeatureOutcome,
  Frame,
  KernelOp,
  MeshData,
  SectionLoops,
  ShapeId,
  StepAssemblyLayout,
  Topology,
  VertexRef,
} from '@manufakture/kernel';
import type { KernelClient } from '@manufakture/kernel/kernel-client';
import type { RegenClient } from '@manufakture/regen/client';
import type { Measurer } from '../measure/measurer';
import type { BodyInput } from '../viewport/bodies';
import { fillPlaceholderNames } from '../viewport/naming';

/** A body the kernel holds as a B-rep, by its viewport body id. */
export interface KernelBody {
  shape: ShapeId;
  /** The name it is exported under (a STEP product, a 3MF object). */
  name: string;
  /**
   * `part`: a body of the model, which export writes. `reference`: an
   * imported body, shown and measured next to the model but never exported
   * (like an STL reference, which the kernel never holds).
   */
  role: 'part' | 'reference';
  /**
   * For a reference body: the import feature it was read for, which names its faces. Feature ids
   * repeat across part studios, so the registry key (the viewport id) is part-qualified.
   */
  featureId?: string;
}

export type ExchangeResult<T> = { ok: true; value: T } | { ok: false; message: string };

export interface Exchanger {
  /** The part bodies that export writes, in scene order; never reference bodies. */
  bodies(): { id: string; name: string }[];
  /**
   * Tessellate bodies for a mesh export; each is named `names.get(id)`, or its registered name.
   */
  tessellate(
    ids: readonly string[],
    deflection: Deflection,
    names?: ReadonlyMap<string, string>,
  ): Promise<ExchangeResult<{ name: string; mesh: MeshData }[]>>;
  /**
   * One STEP file of the bodies, each a named product (`names.get(id)`, or its registered name);
   * with `assembly`, an assembly of them: each part once, each instance a placed component.
   */
  exportStep(
    ids: readonly string[],
    names?: ReadonlyMap<string, string>,
    assembly?: StepAssemblyLayout,
  ): Promise<ExchangeResult<Uint8Array>>;
  /**
   * One STEP file of the bodies (as `exportStep`, none allowed) and of framing members of the
   * last regen of `partId` (full ids), whose B-reps the regen worker builds on demand, one kernel
   * batch per owner, and releases at once. `failed` lists the members it could not build or no
   * longer has. Optional: only a regen worker's kernel holds members.
   */
  exportStepWithMembers?(
    ids: readonly string[],
    names: ReadonlyMap<string, string> | undefined,
    partId: string,
    memberIds: readonly string[],
  ): Promise<ExchangeResult<{ data: Uint8Array; members: number; failed: string[] }>>;
  /**
   * Read a STEP file into a reference body named after the import feature
   * `featureId`; the body's viewport id is `bodyId` (default: the feature id), which the app
   * qualifies with the part studio (`importBodyId`), since feature ids repeat across parts.
   */
  importStep(
    bytes: Uint8Array,
    featureId: string,
    name: string,
    bodyId?: string,
  ): Promise<ExchangeResult<BodyInput>>;
  /**
   * Keep only the reference bodies whose ids are in `ids`: every other one is
   * forgotten and its kernel shape released. Part bodies are untouched.
   * Returns the ids released.
   */
  retain(ids: ReadonlySet<string>): string[];
  /**
   * Read STEP reference bodies again after the kernel lost every shape: `files` maps viewport
   * body ids to their STEP files. Only bodies still registered are rebuilt (one pruned meanwhile is
   * released again); returns the ids rebuilt. The viewport meshes stay as they are.
   */
  reimport(files: ReadonlyMap<string, Uint8Array>): Promise<string[]>;
  /**
   * The section of a part body (by viewport id) by `frame`'s plane moved `height` along its
   * normal: nested loops in the frame's 2D coordinates (the kernel's `section` op), for the laser
   * and plasma export. Optional: scenes without a kernel have none.
   */
  section?(
    bodyId: string,
    frame: Frame,
    height: number,
    deflection?: number,
  ): Promise<ExchangeResult<SectionLoops>>;
}

/**
 * Turns a picked face or edge into the reference a feature stores (ADR 0007 decision 8): the
 * kernel's minimal `FaceRef` or `EdgeRef` for the sub-shape, by its 1-based index on the body.
 */
export interface Referencer {
  reference(
    bodyId: string,
    kind: 'face' | 'edge',
    index: number,
  ): Promise<ExchangeResult<FaceRef | EdgeRef>>;
  /**
   * The `VertexRef` a mate connector stores for vertex `index` (1-based) of a body: the sorted
   * names of the faces around it, with an ordinal only when another vertex has the same faces.
   */
  vertex?(bodyId: string, index: number): Promise<ExchangeResult<VertexRef>>;
}

const DROPPED = 'The kernel dropped the request; try again.';
export const RESTARTED = 'The kernel restarted during the export; try again.';

/**
 * Whether a member export failed because the kernel was recycled under it: the bodies written
 * with the members were shapes of the old instance (the kernel's `unknown-shape` error, which the
 * regen worker passes on as its message), or the regen worker's own retries ran out.
 */
export function lostToRecycle(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /unknown shape id|kernel shapes were lost to a recycle/.test(message);
}

/**
 * The kernel side of export, import and measuring for the bodies in
 * `registry` (viewport id to kernel shape). `client` is read on every call,
 * since the loader spawns it lazily.
 */
/** The kernel client export runs on: a regen worker's also builds member B-reps. */
export type ExchangeClient = KernelClient & Partial<Pick<RegenClient, 'memberBodies'>>;

export function kernelExchange(
  client: () => ExchangeClient | null,
  registry: Map<string, KernelBody>,
): { exchanger: Exchanger; measurer: Measurer; referencer: Referencer } {
  const shapesOf = (
    ids: readonly string[],
    names?: ReadonlyMap<string, string>,
  ): ExchangeResult<KernelBody[]> => {
    const out: KernelBody[] = [];
    for (const id of ids) {
      const body = registry.get(id);
      if (!body || body.role !== 'part') {
        return { ok: false, message: `The kernel has no body ${id}.` };
      }
      const name = names?.get(id);
      out.push(name === undefined ? body : { ...body, name });
    }
    return out.length === 0
      ? { ok: false, message: 'There is nothing to export.' }
      : { ok: true, value: out };
  };

  // Outside the batch queue (`KernelClient.release`): a release batch, even at the current
  // generation, is cancelled by the regen the same document change asks for, leaking the
  // shapes. Nobody waits for it: an id already gone (a recycle) is simply unknown.
  const release = (shapes: ShapeId[]): void => {
    const c = client();
    if (c === null) return;
    void c.release(shapes).catch(() => undefined);
  };

  type Read =
    { ok: true; shape: ShapeId; body: ExchangeResult<BodyInput> } | { ok: false; message: string };

  // One STEP file into a kept `import` feature body, meshed. At the current generation: an
  // import must not cancel the regen in flight (ADR 0007 decision 4).
  const readStep = async (
    c: KernelClient,
    bytes: Uint8Array,
    featureId: string,
    bodyId: string,
  ): Promise<Read> => {
    const reply = await c.submit(
      [
        {
          op: 'feature',
          bodies: [],
          feature: { kind: 'import', id: featureId, step: bytes, mode: 'new' },
        },
        { op: 'tessellate', shape: { result: 0 } },
        { op: 'topology', shape: { result: 0 } },
      ] as const,
      c.latestGeneration,
    );
    if (reply === null || reply.status !== 'done') return { ok: false, message: DROPPED };
    const [feature, mesh, topology] = reply.results;
    if (!feature.ok) return { ok: false, message: feature.error.message };
    const outcome: FeatureOutcome = feature.value;
    const shape = outcome.bodies[0]?.shape ?? null;
    if (!outcome.ok || shape === null) {
      const why = outcome.errors.map((e) => e.message).join('; ') || 'nothing was imported';
      return { ok: false, message: `The STEP file could not be imported: ${why}` };
    }
    if (!mesh.ok || !topology.ok) {
      return {
        ok: true,
        shape,
        body: { ok: false, message: 'The imported body could not be meshed.' },
      };
    }
    return {
      ok: true,
      shape,
      body: {
        ok: true,
        value: {
          id: bodyId,
          mesh: mesh.value,
          names: fillPlaceholderNames(mesh.value, reply.names),
          topology: topology.value as Topology,
        },
      },
    };
  };

  const exchanger: Exchanger = {
    bodies: () =>
      [...registry].flatMap(([id, b]) => (b.role === 'part' ? [{ id, name: b.name }] : [])),

    async tessellate(ids, deflection, names) {
      const c = client();
      const found = shapesOf(ids, names);
      if (!found.ok) return found;
      if (c === null) return { ok: false, message: 'The kernel is not running.' };
      // At the current generation: an export never cancels an edit in flight.
      const ops: KernelOp[] = found.value.map((b) => ({
        op: 'tessellate',
        shape: b.shape,
        deflection,
      }));
      const reply = await c.submit(ops, c.latestGeneration);
      if (reply === null || reply.status !== 'done') return { ok: false, message: DROPPED };
      const out: { name: string; mesh: MeshData }[] = [];
      for (const [i, r] of reply.results.entries()) {
        if (!r.ok) return { ok: false, message: `Meshing failed: ${r.error.message}` };
        out.push({ name: found.value[i]!.name, mesh: r.value as MeshData });
      }
      return { ok: true, value: out };
    },

    async exportStep(ids, names, assembly) {
      const c = client();
      const found = shapesOf(ids, names);
      if (!found.ok) return found;
      if (c === null) return { ok: false, message: 'The kernel is not running.' };
      const op: ExportStepOp = {
        op: 'exportStep',
        bodies: found.value.map((b) => ({ shape: b.shape, name: b.name })),
      };
      if (assembly !== undefined) op.assembly = assembly;
      const reply = await c.submit([op] as const, c.latestGeneration);
      if (reply === null || reply.status !== 'done') return { ok: false, message: DROPPED };
      const [r] = reply.results;
      if (!r.ok) return { ok: false, message: `STEP export failed: ${r.error.message}` };
      return { ok: true, value: r.value.data };
    },

    async exportStepWithMembers(ids, names, partId, memberIds) {
      const c = client();
      const found: ExchangeResult<KernelBody[]> =
        ids.length === 0 ? { ok: true, value: [] } : shapesOf(ids, names);
      if (!found.ok) return found;
      if (c === null) return { ok: false, message: 'The kernel is not running.' };
      if (c.memberBodies === undefined) {
        return { ok: false, message: 'This kernel builds no framing members.' };
      }
      let r: Awaited<ReturnType<NonNullable<ExchangeClient['memberBodies']>>>;
      try {
        r = await c.memberBodies(partId, memberIds, {
          step: true,
          with: found.value.map((b) => ({ shape: b.shape, name: b.name })),
        });
      } catch (error) {
        if (lostToRecycle(error)) return { ok: false, message: RESTARTED };
        throw error;
      }
      if (r === null) return { ok: false, message: DROPPED };
      if (r.step === null) return { ok: false, message: 'There is nothing to export.' };
      const failed = [...r.bodies.filter((b) => !b.ok).map((b) => b.id), ...r.missing];
      return {
        ok: true,
        value: { data: r.step, members: r.bodies.filter((b) => b.ok).length, failed },
      };
    },

    async section(bodyId, frame, height, deflection) {
      const c = client();
      const found = shapesOf([bodyId]);
      if (!found.ok) return found;
      if (c === null) return { ok: false, message: 'The kernel is not running.' };
      // At the current generation: an export never cancels an edit in flight.
      const reply = await c.submit(
        [
          {
            op: 'section',
            shape: found.value[0]!.shape,
            frame,
            height,
            ...(deflection === undefined ? {} : { deflection }),
          },
        ] as const,
        c.latestGeneration,
      );
      if (reply === null || reply.status !== 'done') return { ok: false, message: DROPPED };
      const [r] = reply.results;
      if (!r.ok) return { ok: false, message: `The section failed: ${r.error.message}` };
      return { ok: true, value: r.value };
    },

    async importStep(bytes, featureId, name, bodyId = featureId) {
      const c = client();
      if (c === null) return { ok: false, message: 'The kernel is not running.' };
      const read = await readStep(c, bytes, featureId, bodyId);
      if (!read.ok) return read;
      // A re-import under the same id (never in practice) must not leak the old shape.
      const previous = registry.get(bodyId);
      registry.set(bodyId, {
        shape: read.shape,
        name,
        role: 'reference',
        ...(bodyId === featureId ? {} : { featureId }),
      });
      if (previous && previous.shape !== read.shape) release([previous.shape]);
      return read.body;
    },

    retain(ids) {
      const dropped: string[] = [];
      const shapes: ShapeId[] = [];
      for (const [id, b] of registry) {
        if (b.role !== 'reference' || ids.has(id)) continue;
        registry.delete(id);
        dropped.push(id);
        shapes.push(b.shape);
      }
      if (shapes.length > 0) release(shapes);
      return dropped;
    },

    async reimport(files) {
      const rebuilt: string[] = [];
      for (const [id, bytes] of files) {
        const c = client();
        if (c === null) break;
        const known = registry.get(id);
        if (known?.role !== 'reference') continue;
        const read = await readStep(c, bytes, known.featureId ?? id, id);
        if (!read.ok) continue;
        // Pruned while it was read (its import can no longer come back): not wanted any more.
        const entry = registry.get(id);
        if (entry?.role !== 'reference') {
          release([read.shape]);
          continue;
        }
        // The old shape died with the instance; nothing to release.
        registry.set(id, { ...entry, shape: read.shape });
        rebuilt.push(id);
      }
      return rebuilt;
    },
  };

  const measurer: Measurer = {
    async measure(bodyId, targets, body) {
      const c = client();
      const entry = registry.get(bodyId);
      if (c === null || !entry) return { ok: false, message: `The kernel has no body ${bodyId}.` };
      // At the current generation: a measurement never cancels an edit in flight.
      const reply = await c.submit(
        [{ op: 'measure', shape: entry.shape, targets, body }] as const,
        c.latestGeneration,
      );
      if (reply === null) return null;
      const [r] = reply.results;
      if (reply.status !== 'done' || r === undefined) return null;
      return r.ok ? { ok: true, result: r.value } : { ok: false, message: r.error.message };
    },
  };

  const referencer: Referencer = {
    async reference(bodyId, kind, index) {
      const c = client();
      const entry = registry.get(bodyId);
      if (c === null || !entry || entry.role !== 'part') {
        return { ok: false, message: 'Only faces and edges of the part can be referenced.' };
      }
      // At the current generation: picking never cancels an edit in flight.
      const reply = await c.submit(
        [{ op: 'pick', shape: entry.shape, kind, index }] as const,
        c.latestGeneration,
      );
      if (reply === null || reply.status !== 'done') return { ok: false, message: DROPPED };
      const [r] = reply.results;
      if (!r.ok) return { ok: false, message: r.error.message };
      if (r.value.ref === null) {
        return { ok: false, message: `That ${kind} has no stable name to refer to.` };
      }
      return { ok: true, value: r.value.ref as FaceRef | EdgeRef };
    },
    async vertex(bodyId, index) {
      const c = client();
      const entry = registry.get(bodyId);
      if (c === null || !entry || entry.role !== 'part') {
        return { ok: false, message: 'Only vertices of the parts can be referenced.' };
      }
      const reply = await c.submit(
        [{ op: 'pick', shape: entry.shape, kind: 'vertex', index }] as const,
        c.latestGeneration,
      );
      if (reply === null || reply.status !== 'done') return { ok: false, message: DROPPED };
      const [r] = reply.results;
      if (!r.ok) return { ok: false, message: r.error.message };
      const ref = r.value.ref;
      if (ref === null || !('faces' in ref) || 'ends' in ref) {
        return { ok: false, message: 'That vertex has no stable name to refer to.' };
      }
      return { ok: true, value: ref as VertexRef };
    },
  };

  return { exchanger, measurer, referencer };
}
