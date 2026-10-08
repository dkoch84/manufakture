// Framing members in STL and 3MF export (ADR 0015 decision 4; moved here from the app in M8 plan
// T8.1b): each member is its shared shape mesh under its own transform, exported next to the layer
// bodies with no B-rep: one 3MF object per member, named by its full id, and appended to the STL's
// triangle soup. Shape meshes are closed shells (boxes, or Manifold's for cut members), and a
// rigid transform keeps them closed, so the export's watertight check holds for them as for
// bodies. Typed structurally: regen's member sets and shape meshes fit, and so does the app's view
// of them.

import type { ExportBody } from './export';
import type { TriMesh } from './mesh';
import { transformMesh, type Matrix3x4 } from './placement';

/** Members that share a shape: the shape's key, a full id and a matrix per member. */
export interface MemberInstancesLike {
  readonly shape: string;
  readonly ids: readonly string[];
  /** A column-major 4x4 per member (three.js `Matrix4.elements` order), member to world, mm. */
  readonly matrices: Float32Array;
}

/** Framing members to export: the shape meshes by key, and the sets that place them. */
export interface MemberExportSource {
  readonly meshes: ReadonlyMap<string, TriMesh>;
  readonly sets: readonly { readonly instances: readonly MemberInstancesLike[] }[];
}

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
 * Every member placed in world coordinates, named by its full id, in set order and then instance
 * order. A member whose shape mesh is missing is left out.
 */
export function memberExportBodies(source: MemberExportSource): ExportBody[] {
  const out: ExportBody[] = [];
  for (const set of source.sets) {
    for (const list of set.instances) {
      const mesh = source.meshes.get(list.shape);
      if (!mesh) continue;
      list.ids.forEach((id, i) => {
        out.push({ name: id, mesh: transformMesh(mesh, matrix3x4(list.matrices, i * 16)) });
      });
    }
  }
  return out;
}
