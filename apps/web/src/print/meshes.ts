// The meshes the print workspace checks and draws: each body tessellated at the export tolerance
// (ADR 0012 decision 5: overhangs, thickness and gaps are measured at the tolerance the part is
// exported with, 0.02 mm chordal at `normal`), finer than the viewport's own meshes (0.1 mm).
// Asked from the kernel through the exchanger, once per regenerated body; until one arrives, or
// where there is no kernel (the test scenes), the body's viewport mesh stands in.
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

/** Tries per body before its viewport mesh is used for good (a request dropped by a regen is retried). */
export const MAX_TRIES = 4;

export interface PrintMeshes {
  /** The export-tolerance version of a body, or the body itself while there is none. */
  meshOf(view: BodyInput): BodyInput;
  /**
   * Ask the kernel for the bodies that have no finer mesh yet. Resolves to true when some
   * arrived (draw and check again), false when nothing changed; never rejects.
   */
  request(views: readonly BodyInput[]): Promise<boolean>;
  /** True while some of `views` may still get a finer mesh (a retry is worth it). */
  waiting(views: readonly BodyInput[]): boolean;
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
  // By viewport mesh: the finer body (or the view itself once given up on), and tries so far.
  const done = new WeakMap<MeshData, BodyInput>();
  const tries = new WeakMap<MeshData, number>();
  const pending = new WeakSet<MeshData>();

  const settled = (view: BodyInput) => !exchanger || done.has(view.mesh);

  return {
    meshOf(view) {
      const fine = done.get(view.mesh);
      // The finer body keeps the id, colour and transform of the view asking for it.
      return fine && fine !== view ? { ...view, mesh: fine.mesh } : view;
    },
    waiting(views) {
      return views.some((v) => !settled(v));
    },
    async request(views) {
      if (!exchanger) return false;
      const wanted = views.filter((v) => !done.has(v.mesh) && !pending.has(v.mesh));
      if (wanted.length === 0) return false;
      for (const v of wanted) pending.add(v.mesh);
      let changed = false;
      try {
        const r = await exchanger.tessellate(
          wanted.map((v) => v.id),
          PRINT_DEFLECTION,
        );
        wanted.forEach((v, i) => {
          if (r.ok) {
            const fine = r.value[i] ? withNames(v, r.value[i]!.mesh) : null;
            done.set(v.mesh, fine ?? v);
            changed ||= fine !== null;
            return;
          }
          const n = (tries.get(v.mesh) ?? 0) + 1;
          tries.set(v.mesh, n);
          if (n >= MAX_TRIES) done.set(v.mesh, v);
        });
      } catch {
        for (const v of wanted) done.set(v.mesh, v);
      } finally {
        for (const v of wanted) pending.delete(v.mesh);
      }
      return changed;
    },
  };
}
