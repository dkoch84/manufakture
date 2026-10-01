// Rigid placements for assembly exports: an instance's pose (a unit quaternion
// and a translation, as regen solves it) as the 3 x 4 matrix 3MF writes, and
// meshes moved by such a matrix (STL has no transforms, so an assembly's STL
// is its meshes moved into place and merged).

import type { TriMesh } from './mesh';

/** Where an instance is: local to world, p_world = R p_local + t; `rotation` is [x, y, z, w]. */
export interface Placement {
  translation: readonly [number, number, number];
  rotation: readonly [number, number, number, number];
}

/**
 * An affine transform in 3MF's order: `m00 m01 m02 m10 m11 m12 m20 m21 m22 m30 m31 m32`, for
 * row vectors, so a point maps as `[x y z 1] M`: `x' = x m00 + y m10 + z m20 + m30`, and so on.
 * Rows 0 to 2 are the images of the x, y and z axes, row 3 the translation.
 */
export type Matrix3x4 = readonly number[];

export const IDENTITY_MATRIX: Matrix3x4 = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];

/** A placement as a 3MF matrix. The quaternion is normalised; a zero one is refused. */
export function placementMatrix(p: Placement): number[] {
  const [qx, qy, qz, qw] = p.rotation;
  const n = Math.hypot(qx, qy, qz, qw);
  if (!(n > 0) || !Number.isFinite(n)) throw new RangeError('the rotation is not a quaternion');
  const [x, y, z, w] = [qx / n, qy / n, qz / n, qw / n];
  // R in the column-vector convention; 3MF stores its transpose (m_ij = R_ji).
  const r00 = 1 - 2 * (y * y + z * z);
  const r01 = 2 * (x * y - z * w);
  const r02 = 2 * (x * z + y * w);
  const r10 = 2 * (x * y + z * w);
  const r11 = 1 - 2 * (x * x + z * z);
  const r12 = 2 * (y * z - x * w);
  const r20 = 2 * (x * z - y * w);
  const r21 = 2 * (y * z + x * w);
  const r22 = 1 - 2 * (x * x + y * y);
  const [tx, ty, tz] = p.translation;
  return [r00, r10, r20, r01, r11, r21, r02, r12, r22, tx, ty, tz];
}

/** `a` then `b`: the matrix that maps a point as `a` does and then as `b` does. */
export function composeMatrices(a: Matrix3x4, b: Matrix3x4): number[] {
  const out: number[] = [];
  // Linear rows of a times b's linear part, then a's translation through b.
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 3; c++) {
      let v = r === 3 ? b[9 + c]! : 0;
      for (let k = 0; k < 3; k++) v += a[r * 3 + k]! * b[k * 3 + c]!;
      out.push(v);
    }
  }
  return out;
}

/** The determinant of the linear part: 1 for a rigid motion, negative for a mirror. */
export function matrixDeterminant(m: Matrix3x4): number {
  return (
    m[0]! * (m[4]! * m[8]! - m[5]! * m[7]!) -
    m[1]! * (m[3]! * m[8]! - m[5]! * m[6]!) +
    m[2]! * (m[3]! * m[7]! - m[4]! * m[6]!)
  );
}

export function isIdentity(m: Matrix3x4, tolerance = 1e-12): boolean {
  return m.length === 12 && m.every((v, i) => Math.abs(v - IDENTITY_MATRIX[i]!) <= tolerance);
}

/**
 * A copy of `mesh` moved by `m` (vertices only: triangles and winding are kept, which stays
 * outward for a matrix with a positive determinant). Computed in float64, stored as float32.
 */
export function transformMesh(mesh: TriMesh, m: Matrix3x4): TriMesh {
  const src = mesh.positions;
  const out = new Float32Array(src.length);
  for (let v = 0; v + 2 < src.length; v += 3) {
    const x = src[v]!;
    const y = src[v + 1]!;
    const z = src[v + 2]!;
    out[v] = x * m[0]! + y * m[3]! + z * m[6]! + m[9]!;
    out[v + 1] = x * m[1]! + y * m[4]! + z * m[7]! + m[10]!;
    out[v + 2] = x * m[2]! + y * m[5]! + z * m[8]! + m[11]!;
  }
  return { positions: out, indices: mesh.indices };
}
