// The meshes the print workspace checks and draws: each body tessellated at the export tolerance
// (ADR 0012 decision 5: overhangs, thickness and gaps are measured at the tolerance the part is
// exported with, 0.02 mm chordal at `normal`), finer than the viewport's own meshes (0.1 mm).
// Asked from the kernel through the exchanger, once per regenerated body and again after a request
// fails; until one arrives, or where there is no kernel (the test scenes), the body's viewport mesh
// stands in.
//
// The finer mesh is of the same B-rep, so it has the same faces and edges in the same order: it
// takes the names of the viewport mesh (`faceNames`, `edgeNames` index the regen reply's name
// table, which the viewport body carries), so picks and references name the same faces. A mesh
// whose face or edge count differs (the body changed meanwhile) is not used.

import type { Deflection, MeshData } from '@manufakture/kernel';
import type { Exchanger } from '../io/exchange';
import type { BodyInput } from '../viewport/bodies';

/** The export tolerance `normal` of `@manufakture/io` (0.02 mm, 0.25 rad), as a kernel deflection. */
export const PRINT_DEFLECTION: Deflection = { linear: 0.02, angular: 0.25 };

/**
 * The wait before asking again for a body whose request failed, after its first failure (ms); it
 * doubles with every further failure up to `MAX_RETRY_MS`. A request fails mostly because a regen
 * superseded it (every document change takes a new kernel generation and drops the batches before
 * it, so adding an item or laying one flat drops the request in flight); it is asked again until
 * the kernel answers, never given up on, so a body is never checked on its viewport mesh for good.
 */
export const RETRY_MS = 400;
export const MAX_RETRY_MS = 5000;

export interface PrintMeshes {
  /** The export-tolerance version of a body, or the body itself while there is none. */
  meshOf(view: BodyInput): BodyInput;
  /**
   * Ask the kernel for the bodies that have no finer mesh yet. Resolves to true when some
   * arrived (draw and check again), false when nothing changed; never rejects.
   */
  request(views: readonly BodyInput[]): Promise<boolean>;
  /**
   * True while some of `views` still stand in for their finer mesh: they are checked on the
   * viewport mesh for now, and a finer one may still come. False once each has its finer mesh, or
   * the kernel answered that it has none of the same shape, or there is no kernel.
   */
  waiting(views: readonly BodyInput[]): boolean;
  /** How long to wait before asking again for those of `views` still waiting (ms), or null. */
  retryIn(views: readonly BodyInput[]): number | null;
}

/** The finer mesh with the viewport mesh's names, or null when the two do not match. */
export function withNames(view: BodyInput, fine: MeshData): BodyInput | null {
  const m = view.mesh;
  if (fine.faceRanges.length !== m.faceRanges.length) return null;
  if (fine.edgeRanges.length !== m.edgeRanges.length) return null;
  return {
    ...view,
    mesh: {
      ...fine,
      faceNames: m.faceNames,
      faceFragile: m.faceFragile,
      edgeNames: m.edgeNames,
      edgeFragile: m.edgeFragile,
    },
  };
}

export function createPrintMeshes(exchanger: Pick<Exchanger, 'tessellate'> | null): PrintMeshes {
  // By viewport mesh: the finer body (or the view itself when the kernel's mesh does not match),
  // and the failed requests since the last answer.
  const done = new WeakMap<MeshData, BodyInput>();
  const failures = new WeakMap<MeshData, number>();
  const pending = new WeakSet<MeshData>();

  const settled = (view: BodyInput) => !exchanger || done.has(view.mesh);
  const failed = (views: readonly BodyInput[]) => {
    for (const v of views) failures.set(v.mesh, (failures.get(v.mesh) ?? 0) + 1);
  };

  return {
    meshOf(view) {
      const fine = done.get(view.mesh);
      // The finer body keeps the id, colour and transform of the view asking for it.
      return fine && fine !== view ? { ...view, mesh: fine.mesh } : view;
    },
    waiting(views) {
      return views.some((v) => !settled(v));
    },
    retryIn(views) {
      let most = -1;
      for (const v of views) {
        if (!settled(v)) most = Math.max(most, failures.get(v.mesh) ?? 0);
      }
      if (most < 0) return null;
      return Math.min(RETRY_MS * 2 ** Math.max(0, most - 1), MAX_RETRY_MS);
    },
    async request(views) {
      if (!exchanger) return false;
      // Once per viewport mesh: copies of an item (and items of the same body) share it.
      const wanted: BodyInput[] = [];
      for (const v of views) {
        if (done.has(v.mesh) || pending.has(v.mesh)) continue;
        pending.add(v.mesh);
        wanted.push(v);
      }
      if (wanted.length === 0) return false;
      let changed = false;
      try {
        const r = await exchanger.tessellate(
          wanted.map((v) => v.id),
          PRINT_DEFLECTION,
        );
        if (!r.ok) {
          // Dropped by a regen, or the kernel busy restarting: asked again later, never given up.
          failed(wanted);
          return false;
        }
        wanted.forEach((v, i) => {
          const fine = r.value[i] ? withNames(v, r.value[i]!.mesh) : null;
          done.set(v.mesh, fine ?? v);
          failures.delete(v.mesh);
          changed ||= fine !== null;
        });
      } catch {
        failed(wanted);
      } finally {
        for (const v of wanted) pending.delete(v.mesh);
      }
      return changed;
    },
  };
}
