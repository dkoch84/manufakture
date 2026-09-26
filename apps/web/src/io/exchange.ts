// How export and import reach the kernel worker. The scene loader owns the
// kernel client and knows which kernel shape each viewport body is, so it
// provides an `Exchanger` (like its `Measurer`). Until the regen engine is
// wired in, imported STEP bodies are built here directly: one `feature` op
// with an `import` feature (faces named `import#k:face:<n>`), kept in the
// worker as a reference body next to the demo part. Reference bodies are
// measured but never exported, and are released once their import feature
// can no longer come back (see `retain`).

import type {
  Deflection,
  FeatureOutcome,
  KernelOp,
  MeshData,
  ShapeId,
  Topology,
} from '@manufakture/kernel';
import type { KernelClient } from '@manufakture/kernel/client';
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
}

export type ExchangeResult<T> = { ok: true; value: T } | { ok: false; message: string };

export interface Exchanger {
  /** The part bodies that export writes, in scene order; never reference bodies. */
  bodies(): { id: string; name: string }[];
  /** Tessellate bodies for a mesh export. */
  tessellate(
    ids: readonly string[],
    deflection: Deflection,
  ): Promise<ExchangeResult<{ name: string; mesh: MeshData }[]>>;
  /** One STEP file of the bodies, each a named product. */
  exportStep(ids: readonly string[]): Promise<ExchangeResult<Uint8Array>>;
  /**
   * Read a STEP file into a reference body named after the import feature
   * `featureId`; the body's viewport id is the feature id.
   */
  importStep(
    bytes: Uint8Array,
    featureId: string,
    name: string,
  ): Promise<ExchangeResult<BodyInput>>;
  /**
   * Keep only the reference bodies whose ids are in `ids`: every other one is
   * forgotten and its kernel shape released. Part bodies are untouched.
   * Returns the ids released.
   */
  retain(ids: ReadonlySet<string>): string[];
}

const DROPPED = 'The kernel dropped the request; try again.';

/**
 * The kernel side of export, import and measuring for the bodies in
 * `registry` (viewport id to kernel shape). `client` is read on every call,
 * since the loader spawns it lazily.
 */
export function kernelExchange(
  client: () => KernelClient | null,
  registry: Map<string, KernelBody>,
): { exchanger: Exchanger; measurer: Measurer } {
  const shapesOf = (ids: readonly string[]): ExchangeResult<KernelBody[]> => {
    const out: KernelBody[] = [];
    for (const id of ids) {
      const body = registry.get(id);
      if (!body || body.role !== 'part') {
        return { ok: false, message: `The kernel has no body ${id}.` };
      }
      out.push(body);
    }
    return out.length === 0
      ? { ok: false, message: 'There is nothing to export.' }
      : { ok: true, value: out };
  };

  // At the current generation, so a release never cancels an edit in flight.
  // Nobody waits for it: an id already gone (a recycle) is simply unknown.
  const release = (shapes: ShapeId[]): void => {
    const c = client();
    if (c === null) return;
    void c.submit([{ op: 'release', shapes }] as const, c.latestGeneration).catch(() => undefined);
  };

  const exchanger: Exchanger = {
    bodies: () =>
      [...registry].flatMap(([id, b]) => (b.role === 'part' ? [{ id, name: b.name }] : [])),

    async tessellate(ids, deflection) {
      const c = client();
      const found = shapesOf(ids);
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

    async exportStep(ids) {
      const c = client();
      const found = shapesOf(ids);
      if (!found.ok) return found;
      if (c === null) return { ok: false, message: 'The kernel is not running.' };
      const reply = await c.submit(
        [
          {
            op: 'exportStep',
            bodies: found.value.map((b) => ({ shape: b.shape, name: b.name })),
          },
        ] as const,
        c.latestGeneration,
      );
      if (reply === null || reply.status !== 'done') return { ok: false, message: DROPPED };
      const [r] = reply.results;
      if (!r.ok) return { ok: false, message: `STEP export failed: ${r.error.message}` };
      return { ok: true, value: r.value.data };
    },

    async importStep(bytes, featureId, name) {
      const c = client();
      if (c === null) return { ok: false, message: 'The kernel is not running.' };
      const reply = await c.submit([
        {
          op: 'feature',
          body: null,
          feature: { kind: 'import', id: featureId, step: bytes, mode: 'new' },
        },
        { op: 'tessellate', shape: { result: 0 } },
        { op: 'topology', shape: { result: 0 } },
      ] as const);
      if (reply === null || reply.status !== 'done') return { ok: false, message: DROPPED };
      const [feature, mesh, topology] = reply.results;
      if (!feature.ok) return { ok: false, message: feature.error.message };
      const outcome: FeatureOutcome = feature.value;
      if (!outcome.ok || outcome.shape === null) {
        const why = outcome.errors.map((e) => e.message).join('; ') || 'nothing was imported';
        return { ok: false, message: `The STEP file could not be imported: ${why}` };
      }
      // A re-import under the same id (never in practice) must not leak the old shape.
      const previous = registry.get(featureId);
      registry.set(featureId, { shape: outcome.shape, name, role: 'reference' });
      if (previous && previous.shape !== outcome.shape) release([previous.shape]);
      if (!mesh.ok || !topology.ok) {
        return { ok: false, message: 'The imported body could not be meshed.' };
      }
      const body: BodyInput = {
        id: featureId,
        mesh: mesh.value,
        names: fillPlaceholderNames(mesh.value, reply.names),
        topology: topology.value as Topology,
      };
      return { ok: true, value: body };
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

  return { exchanger, measurer };
}
