// Export of B-rep bodies as files (M1 to M6; moved here from the app's export action in M8 plan
// T8.1b): binary STL (all bodies in one file, or one file per body), 3MF (one named object per
// body) or STEP (one named product per body). The geometry comes through a `BodyExchanger`: the
// app's kernel exchange, or `kernelExchanger` over a kernel service and the bodies of a regen
// result, for a headless session. Mesh exports are tessellated at an export tolerance and must be
// watertight.

import type { Deflection, KernelService, MeshData, ShapeId } from '@manufakture/kernel';
import {
  EXPORT_TOLERANCES,
  NotWatertightError,
  deflectionOf,
  export3mf,
  exportStl,
  fileName,
  type ExportBody,
  type ExportTolerancePreset,
} from './export';
import { exportAllowed, type ExportSource } from './export-gate';
import { FABRICATION_MIME, type FabricationFile } from './fabrication';
import { withStepDescription } from './step-header';

/** `stl`: one file of every body; `stl-each`: a file per body. */
export type BodyFileFormat = 'stl' | 'stl-each' | '3mf' | 'step';

export type ExchangeOutcome<T> = { ok: true; value: T } | { ok: false; message: string };

/** Where the bodies' geometry comes from: the kernel that holds them, by body id. */
export interface BodyExchanger {
  /** The bodies an export writes when none are chosen, in order. */
  bodies(): readonly { id: string; name: string }[];
  /** Meshes of the bodies, each named `names.get(id)`, or the body's own name. */
  tessellate(
    ids: readonly string[],
    deflection: Deflection,
    names?: ReadonlyMap<string, string>,
  ): Promise<ExchangeOutcome<{ name: string; mesh: MeshData }[]>>;
  /** One STEP file of the bodies, each a named product (`names.get(id)`, or its own name). */
  exportStep(
    ids: readonly string[],
    names?: ReadonlyMap<string, string>,
  ): Promise<ExchangeOutcome<Uint8Array>>;
  /**
   * One STEP file of the bodies and of framing members of `partId` (full ids), whose B-reps are
   * built on demand. `failed` lists the members it could not build. Optional: only a kernel that
   * frames members has it.
   */
  exportStepWithMembers?(
    ids: readonly string[],
    names: ReadonlyMap<string, string> | undefined,
    partId: string,
    memberIds: readonly string[],
  ): Promise<ExchangeOutcome<{ data: Uint8Array; members: number; failed: string[] }>>;
}

export interface BodyFileOptions {
  /**
   * The branch the bodies' document comes from: STL, 3MF and STEP are fabrication files, so an
   * agent's branch that is not approved is refused (`exportAllowed`, ADR 0016 decision 12).
   */
  source: ExportSource | null;
  /** Mesh exports' tolerance (default `normal`). */
  tolerance?: ExportTolerancePreset;
  /** Names the file when there are several bodies. */
  documentName?: string;
  /** The bodies to write, under these names (default: every body of the exchanger). */
  bodies?: readonly { id: string; name: string }[];
  /** The file name, without extension, whatever the bodies are. */
  fileBase?: string;
  /** Framing members, placed and named (`memberExportBodies`); none by default. */
  members?: readonly ExportBody[];
  /** The part studio the members belong to: STEP builds their B-reps there. */
  partId?: string;
  /** The STEP header's description (FILE_DESCRIPTION), in place of the kernel's. */
  stepDescription?: string;
}

/** The files, and a sentence about the members to add to the export's message (or ''). */
export type BodyFiles =
  { ok: true; files: FabricationFile[]; note: string } | { ok: false; message: string };

/**
 * The files of B-rep bodies: `options.bodies` (under the names given), or every body of the
 * exchanger. The files are named after the one body, or the document when there are several
 * (`options.fileBase` overrides both).
 *
 * Framing members (`options.members`) go into mesh exports after the bodies (ADR 0015 decision 4):
 * one 3MF object per member named by its full id, appended to a merged STL, or one more STL of
 * them all when each body gets a file. STEP writes them as B-reps in the same file as the bodies,
 * each a product named by its full id, built on demand (`exportStepWithMembers`) when
 * `options.partId` names the part they belong to; an exchanger that builds no members leaves them
 * out and says so. With `options.stepDescription`, a STEP file's header description is that text
 * (the construction disclaimer). Refused, before the exchanger is asked for anything, when
 * `options.source` is an agent's unreviewed branch or is not known (`exportAllowed`).
 */
export async function exportBodyFiles(
  exchanger: BodyExchanger,
  format: BodyFileFormat,
  options: BodyFileOptions,
): Promise<BodyFiles> {
  const gate = exportAllowed(options?.source);
  if (!gate.ok) return gate;
  const bodies = options.bodies ?? exchanger.bodies();
  const members = options.members ?? [];
  const stepMembers =
    format === 'step' &&
    members.length > 0 &&
    options.partId !== undefined &&
    exchanger.exportStepWithMembers !== undefined;
  if (bodies.length === 0 && (members.length === 0 || (format === 'step' && !stepMembers))) {
    return { ok: false, message: 'There is nothing to export.' };
  }
  const ids = bodies.map((b) => b.id);
  const names = options.bodies ? new Map(bodies.map((b) => [b.id, b.name])) : undefined;
  const base =
    options.fileBase ??
    (bodies.length === 1 ? bodies[0]!.name : (options.documentName ?? 'bodies'));
  let files: FabricationFile[];
  let note = '';
  if (format === 'step') {
    let bytes: Uint8Array;
    if (stepMembers) {
      const step = await exchanger.exportStepWithMembers!(
        ids,
        names,
        options.partId!,
        members.map((m) => m.name),
      );
      if (!step.ok) return step;
      bytes = step.value.data;
      note = ` ${step.value.members} framing ${step.value.members === 1 ? 'member' : 'members'} as B-reps.`;
      if (step.value.failed.length > 0)
        note += ` Left out, not built: ${step.value.failed.join(', ')}.`;
    } else {
      const step = names ? await exchanger.exportStep(ids, names) : await exchanger.exportStep(ids);
      if (!step.ok) return step;
      bytes = step.value;
      if (members.length > 0) note = ' Framing members are not exported to STEP here.';
    }
    if (options.stepDescription !== undefined)
      bytes = withStepDescription(bytes, options.stepDescription);
    files = [{ name: fileName(base, 'step'), bytes, type: FABRICATION_MIME.step }];
  } else {
    const tolerance = EXPORT_TOLERANCES[options.tolerance ?? 'normal'];
    const deflection = deflectionOf(tolerance);
    const meshes =
      ids.length === 0
        ? { ok: true as const, value: [] }
        : names
          ? await exchanger.tessellate(ids, deflection, names)
          : await exchanger.tessellate(ids, deflection);
    if (!meshes.ok) return meshes;
    const all = [...meshes.value, ...members];
    try {
      if (format === '3mf') {
        files = [
          {
            name: fileName(base, '3mf'),
            bytes: export3mf(all, { title: base }),
            type: FABRICATION_MIME['3mf'],
          },
        ];
      } else if (format === 'stl') {
        files = exportStl(all, { merge: true, fileName: base }).map((f) => ({
          ...f,
          type: FABRICATION_MIME.stl,
        }));
      } else {
        // One file per body; the members, often hundreds, together in one more.
        files = [
          ...exportStl(meshes.value, { merge: false }),
          ...(members.length > 0
            ? exportStl(members, { merge: true, fileName: `${base} members` })
            : []),
        ].map((f) => ({ ...f, type: FABRICATION_MIME.stl }));
      }
    } catch (e) {
      if (e instanceof NotWatertightError) return { ok: false, message: e.message };
      throw e;
    }
  }
  return { ok: true, files, note };
}

/** The message for a batch a newer generation superseded. */
const DROPPED = 'The kernel dropped the request; try again.';

/** A body of a regen result as `kernelExchanger` exports it. */
export interface KernelExchangeBody {
  /** Its id in the export (`options.bodies`): the app uses `<part id>/<body id>`. */
  id: string;
  /** The name it is exported under (a STEP product, a 3MF object, an STL file). */
  name: string;
  /** Its shape in the kernel arena (regen's `BodyResult.shape`). */
  shape: ShapeId;
}

/**
 * Framing members' B-reps built on request, as regen's `RegenEngine.memberBodies` builds them with
 * `step: true`: one STEP file of the bodies `with` and every member found. Null when a newer regen
 * superseded the request.
 */
export type MemberBodiesLike = (
  partId: string,
  memberIds: readonly string[],
  options: { step: true; with: readonly { shape: ShapeId; name: string }[] },
) => Promise<{
  bodies: readonly { id: string; ok: boolean }[];
  missing: readonly string[];
  step: Uint8Array | null;
} | null>;

/**
 * A `BodyExchanger` over a kernel service and bodies a regen built in it, for a headless session:
 * meshes and STEP from the kernel's `tessellate` and `exportStep` ops at `generation` (the regen's,
 * so an export never cancels it). With `memberBodies` (the regen engine's), STEP also writes
 * framing members as B-reps; without it, STEP leaves members out and says so.
 */
export function kernelExchanger(options: {
  kernel: Pick<KernelService, 'run'>;
  generation: number | (() => number);
  bodies: readonly KernelExchangeBody[];
  memberBodies?: MemberBodiesLike;
}): BodyExchanger {
  const byId = new Map(options.bodies.map((b) => [b.id, b]));
  const generation = () =>
    typeof options.generation === 'function' ? options.generation() : options.generation;
  const found = (
    ids: readonly string[],
    names?: ReadonlyMap<string, string>,
  ): ExchangeOutcome<{ shape: ShapeId; name: string }[]> => {
    const out: { shape: ShapeId; name: string }[] = [];
    for (const id of ids) {
      const body = byId.get(id);
      if (body === undefined) return { ok: false, message: `There is no body ${id} to export.` };
      out.push({ shape: body.shape, name: names?.get(id) ?? body.name });
    }
    return { ok: true, value: out };
  };
  const exchanger: BodyExchanger = {
    bodies: () => options.bodies.map((b) => ({ id: b.id, name: b.name })),
    async tessellate(ids, deflection, names) {
      const bodies = found(ids, names);
      if (!bodies.ok) return bodies;
      const reply = await options.kernel.run({
        generation: generation(),
        ops: bodies.value.map((b) => ({ op: 'tessellate', shape: b.shape, deflection })),
      });
      if (reply.status !== 'done') return { ok: false, message: DROPPED };
      const out: { name: string; mesh: MeshData }[] = [];
      for (const [i, r] of reply.results.entries()) {
        if (!r.ok) return { ok: false, message: `Meshing failed: ${r.error.message}` };
        out.push({ name: bodies.value[i]!.name, mesh: r.value as MeshData });
      }
      return { ok: true, value: out };
    },
    async exportStep(ids, names) {
      const bodies = found(ids, names);
      if (!bodies.ok) return bodies;
      const reply = await options.kernel.run({
        generation: generation(),
        ops: [{ op: 'exportStep', bodies: bodies.value }],
      });
      if (reply.status !== 'done') return { ok: false, message: DROPPED };
      const r = reply.results[0];
      if (r === undefined) return { ok: false, message: 'STEP export failed: no reply.' };
      if (!r.ok) return { ok: false, message: `STEP export failed: ${r.error.message}` };
      return { ok: true, value: (r.value as { data: Uint8Array }).data };
    },
  };
  const memberBodies = options.memberBodies;
  if (memberBodies) {
    exchanger.exportStepWithMembers = async (ids, names, partId, memberIds) => {
      const bodies = ids.length === 0 ? { ok: true as const, value: [] } : found(ids, names);
      if (!bodies.ok) return bodies;
      const r = await memberBodies(partId, memberIds, { step: true, with: bodies.value });
      if (r === null) return { ok: false, message: DROPPED };
      if (r.step === null) return { ok: false, message: 'There is nothing to export.' };
      const failed = [...r.bodies.filter((b) => !b.ok).map((b) => b.id), ...r.missing];
      return {
        ok: true,
        value: { data: r.step, members: r.bodies.filter((b) => b.ok).length, failed },
      };
    };
  }
  return exchanger;
}
