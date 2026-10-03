// Framing members in STL and 3MF export (ADR 0015 decision 4): each member is its shared shape
// mesh under its own transform, exported next to the layer bodies with no B-rep: one 3MF object
// per member, named by its full id, and appended to the STL's triangle soup. Shape meshes are
// closed shells (boxes, or Manifold's for cut members), and a rigid transform keeps them closed,
// so the export's watertight check holds for them as for bodies.

import { transformMesh, type ExportBody, type Matrix3x4 } from '@manufakture/io';
import type { MemberView } from '../viewport/members';
import { memberStore, shownMemberView, type MemberStore } from '../viewport/memberStore';

/** A column-major 4x4 at `m[at..at+16]` as 3MF's 3x4 (`x' = x m0 + y m3 + z m6 + m9`, ...). */
export function matrix3x4(m: Float32Array, at: number): Matrix3x4 {
  return [
    m[at]!,
    m[at + 1]!,
    m[at + 2]!,
    m[at + 4]!,
    m[at + 5]!,
    m[at + 6]!,
    m[at + 8]!,
    m[at + 9]!,
    m[at + 10]!,
    m[at + 12]!,
    m[at + 13]!,
    m[at + 14]!,
  ];
}

/**
 * Every member of a view placed in world coordinates, named by its full id, in set order and
 * then instance order. A member whose shape mesh is missing is left out.
 */
export function memberExportBodies(view: MemberView): ExportBody[] {
  const out: ExportBody[] = [];
  for (const set of view.sets) {
    for (const list of set.instances) {
      const mesh = view.meshes.get(list.shape);
      if (!mesh) continue;
      list.ids.forEach((id, i) => {
        out.push({ name: id, mesh: transformMesh(mesh, matrix3x4(list.matrices, i * 16)) });
      });
    }
  }
  return out;
}

/** The members the viewport shows now (the active part's), as export bodies. */
export function shownMemberExports(store: MemberStore = memberStore): ExportBody[] {
  return memberExportBodies(shownMemberView(store.getState()));
}
