// Representation B's mesher: a member's mesh computed in TypeScript. A box with no cuts is 12
// triangles. Plane cuts clip the box as a convex polyhedron; a notch (the intersection of two
// half-spaces removed) splits it into two convex pieces, the part outside the first plane and the
// part inside it but outside the second. The two pieces share an inner face, so the mesh renders
// correctly but is not one closed shell (STL or 3MF export would need it welded).

import { cross, dot, normalize, sub, type Plane, type Vec3 } from './geom.ts';
import type { Cut } from './members.ts';

export interface MeshData {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
}

type Polygon = Vec3[];
/** A convex polyhedron as outward-facing polygons (counter-clockwise seen from outside). */
type Polyhedron = Polygon[];

const EPS = 1e-9;

function boxPolyhedron(l: number, w: number, d: number): Polyhedron {
  const v = (x: number, y: number, z: number): Vec3 => [x * l, y * w, z * d];
  return [
    [v(0, 0, 0), v(0, 1, 0), v(1, 1, 0), v(1, 0, 0)], // z = 0, normal -z
    [v(0, 0, 1), v(1, 0, 1), v(1, 1, 1), v(0, 1, 1)], // z = d
    [v(0, 0, 0), v(1, 0, 0), v(1, 0, 1), v(0, 0, 1)], // y = 0
    [v(0, 1, 0), v(0, 1, 1), v(1, 1, 1), v(1, 1, 0)], // y = w
    [v(0, 0, 0), v(0, 0, 1), v(0, 1, 1), v(0, 1, 0)], // x = 0
    [v(1, 0, 0), v(1, 1, 0), v(1, 1, 1), v(1, 0, 1)], // x = l
  ];
}

/** Keep the part with `dot(n, p) <= k`; the cap faces +n. */
function clip(poly: Polyhedron, n: Vec3, k: number): Polyhedron {
  const out: Polyhedron = [];
  const onPlane: Vec3[] = [];
  for (const face of poly) {
    const kept: Vec3[] = [];
    for (let i = 0; i < face.length; i++) {
      const a = face[i]!;
      const b = face[(i + 1) % face.length]!;
      const da = dot(n, a) - k;
      const db = dot(n, b) - k;
      if (da <= EPS) kept.push(a);
      if (Math.abs(da) <= EPS) onPlane.push(a);
      if ((da < -EPS && db > EPS) || (da > EPS && db < -EPS)) {
        const t = da / (da - db);
        const p: Vec3 = [
          a[0] + t * (b[0] - a[0]),
          a[1] + t * (b[1] - a[1]),
          a[2] + t * (b[2] - a[2]),
        ];
        kept.push(p);
        onPlane.push(p);
      }
    }
    if (kept.length >= 3) out.push(kept);
  }
  if (out.length === 0) return out;
  // Cap: the points on the plane, in order around their centroid, counter-clockwise about +n.
  const unique: Vec3[] = [];
  for (const p of onPlane)
    if (
      !unique.some(
        (q) => Math.abs(q[0] - p[0]) + Math.abs(q[1] - p[1]) + Math.abs(q[2] - p[2]) < 1e-7,
      )
    )
      unique.push(p);
  if (unique.length >= 3) {
    const c: Vec3 = [0, 0, 0];
    for (const p of unique) for (let i = 0; i < 3; i++) c[i]! += p[i]! / unique.length;
    const u = normalize(sub(unique[0]!, c));
    const v = cross(n, u);
    unique.sort((p, q) => {
      const dp = sub(p, c);
      const dq = sub(q, c);
      return Math.atan2(dot(dp, v), dot(dp, u)) - Math.atan2(dot(dq, v), dot(dq, u));
    });
    out.push(unique);
  }
  return out;
}

const neg = (p: Plane): Plane => ({ n: [-p.n[0], -p.n[1], -p.n[2]], k: -p.k });

/** Convex pieces of a member: the box, clipped by its plane cuts, split by its notches. */
export function pieces(
  length: number,
  width: number,
  depth: number,
  cuts: readonly Cut[],
): Polyhedron[] {
  let parts: Polyhedron[] = [boxPolyhedron(length, width, depth)];
  for (const c of cuts)
    if (c.kind === 'plane') parts = parts.map((p) => clip(p, c.plane.n, c.plane.k));
  for (const c of cuts) {
    if (c.kind !== 'notch') continue;
    parts = parts.flatMap((p) => {
      // Outside the first half-space, and inside it but outside the second.
      const a = clip(p, c.a.n, c.a.k);
      const inA = clip(p, neg(c.a).n, neg(c.a).k);
      const b = clip(inA, c.b.n, c.b.k);
      return [a, b];
    });
  }
  return parts.filter((p) => p.length >= 4);
}

/** Flat-shaded triangles of convex pieces (a fan per face). */
export function meshPieces(parts: readonly Polyhedron[]): MeshData {
  let verts = 0;
  let tris = 0;
  for (const p of parts)
    for (const f of p) {
      verts += f.length;
      tris += f.length - 2;
    }
  const positions = new Float32Array(verts * 3);
  const normals = new Float32Array(verts * 3);
  const indices = new Uint32Array(tris * 3);
  let vi = 0;
  let ii = 0;
  for (const p of parts)
    for (const f of p) {
      const nrm = normalize(cross(sub(f[1]!, f[0]!), sub(f[2]!, f[0]!)));
      const base = vi;
      for (const q of f) {
        positions.set(q, vi * 3);
        normals.set(nrm, vi * 3);
        vi++;
      }
      for (let i = 1; i + 1 < f.length; i++) {
        indices[ii++] = base;
        indices[ii++] = base + i;
        indices[ii++] = base + i + 1;
      }
    }
  return { positions, normals, indices };
}

export function clipMesh(m: {
  length: number;
  stock: { width: number; depth: number };
  cuts: readonly Cut[];
}): MeshData {
  return meshPieces(pieces(m.length, m.stock.width, m.stock.depth, m.cuts));
}

/** Enclosed volume of a closed (or piecewise closed) triangle mesh. */
export function meshVolume(mesh: {
  positions: ArrayLike<number>;
  indices: ArrayLike<number>;
}): number {
  const p = mesh.positions;
  let v = 0;
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const a = mesh.indices[i]! * 3;
    const b = mesh.indices[i + 1]! * 3;
    const c = mesh.indices[i + 2]! * 3;
    v +=
      p[a]! * (p[b + 1]! * p[c + 2]! - p[b + 2]! * p[c + 1]!) -
      p[a + 1]! * (p[b]! * p[c + 2]! - p[b + 2]! * p[c]!) +
      p[a + 2]! * (p[b]! * p[c + 1]! - p[b + 1]! * p[c]!);
  }
  return v / 6;
}

export function triangleCount(m: MeshData): number {
  return m.indices.length / 3;
}
