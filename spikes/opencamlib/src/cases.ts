// The inputs every probe shares: meshes, cutters and raster settings, plus the checks of a
// result that do not trust either drop-cutter.

import type { Cutter } from './dropcutter.ts';
import { bounds, pointTriangleDistance2, triangleCoords, type Mesh } from './geometry.ts';
import { buildMeshes, readCached, type MeshName } from './meshes.ts';

export async function meshes(): Promise<Record<MeshName, Mesh>> {
  const b = readCached('bracket');
  const f = readCached('filleted');
  if (b && f) return { bracket: b, filleted: f };
  return buildMeshes();
}

export interface NamedCutter {
  name: string;
  cutter: Cutter;
}

/** Shapeoko-typical tools: 1/4" flat and ball, 1/8" ball, 1/4" 60 degree V-bit. */
export const CUTTERS: NamedCutter[] = [
  { name: 'flat 6.35', cutter: { kind: 'flat', diameter: 6.35 } },
  { name: 'ball 6.35', cutter: { kind: 'ball', diameter: 6.35 } },
  { name: 'ball 3.175', cutter: { kind: 'ball', diameter: 3.175 } },
  { name: 'vbit 60 6.35', cutter: { kind: 'vbit', diameter: 6.35, angle: 60 } },
];

/** A finishing raster: 0.5 mm stepover, 0.1 mm sampling along X. */
export const RASTER = { stepover: 0.5, sampling: 0.1 };

export function minZ(mesh: Mesh): number {
  return bounds(mesh).min[2] - 1;
}

/** Profile height f(r) of a cutter above its tip. */
export function profileHeight(c: Cutter, r: number): number {
  const R = c.diameter / 2;
  if (c.kind === 'flat') return 0;
  if (c.kind === 'ball') return R - Math.sqrt(Math.max(0, R * R - r * r));
  return r / Math.tan(((c.angle / 2) * Math.PI) / 180);
}

/** A bucket grid of triangles by XY box, for the checks; independent of DropCutter's index. */
class Buckets {
  readonly t: Float64Array;
  private readonly map = new Map<number, number[]>();
  constructor(
    mesh: Mesh,
    private readonly cell: number,
  ) {
    this.t = triangleCoords(mesh);
    for (let i = 0; i < this.t.length / 9; i++) {
      const o = i * 9;
      const xs = [this.t[o]!, this.t[o + 3]!, this.t[o + 6]!];
      const ys = [this.t[o + 1]!, this.t[o + 4]!, this.t[o + 7]!];
      for (let cx = this.k(Math.min(...xs)); cx <= this.k(Math.max(...xs)); cx++)
        for (let cy = this.k(Math.min(...ys)); cy <= this.k(Math.max(...ys)); cy++) {
          const key = cx * 100_003 + cy;
          const list = this.map.get(key);
          if (list) list.push(i);
          else this.map.set(key, [i]);
        }
    }
  }
  private k(v: number): number {
    return Math.floor(v / this.cell);
  }
  near(x: number, y: number, r: number): Set<number> {
    const out = new Set<number>();
    for (let cx = this.k(x - r); cx <= this.k(x + r); cx++)
      for (let cy = this.k(y - r); cy <= this.k(y + r); cy++)
        for (const i of this.map.get(cx * 100_003 + cy) ?? []) out.add(i);
    return out;
  }
}

export interface Sanity {
  checked: number;
  /** Ball only: the deepest the ball reaches into the mesh (R minus the centre's distance). */
  maxBallPenetration: number | null;
  /** Ball only: points whose ball touches nothing within 1e-6 mm (resting on minZ excluded). */
  ballNotTouching: number | null;
  /** Any cutter: the most any mesh vertex under the tool pokes into it. */
  maxVertexPenetration: number;
}

/**
 * Checks of a drop-cutter result that share no code with either cutter: for a ball, the distance
 * from its centre to the mesh is at least R (and equals R where it rests on the part); for every
 * cutter, no vertex lies inside the tool. Points are x, y, z triples; every `stride`-th is checked.
 */
export function sanity(
  mesh: Mesh,
  c: Cutter,
  points: Float64Array,
  floor: number,
  stride = 1,
): Sanity {
  const R = c.diameter / 2;
  const b = new Buckets(mesh, Math.max(R, 1));
  const p = mesh.positions;
  const ix = mesh.indices;
  let maxBall = -Infinity;
  let notTouching = 0;
  let maxVertex = -Infinity;
  let checked = 0;
  for (let i = 0; i < points.length / 3; i += stride) {
    const x = points[i * 3]!,
      y = points[i * 3 + 1]!,
      z = points[i * 3 + 2]!;
    checked++;
    const near = b.near(x, y, R);
    let best2 = Infinity;
    for (const ti of near) {
      if (c.kind === 'ball') {
        best2 = Math.min(best2, pointTriangleDistance2(x, y, z + R, b.t, ti * 9));
      }
      for (let k = 0; k < 3; k++) {
        const v = ix[ti * 3 + k]! * 3;
        const r = Math.hypot(p[v]! - x, p[v + 1]! - y);
        if (r <= R) maxVertex = Math.max(maxVertex, p[v + 2]! - (z + profileHeight(c, r)));
      }
    }
    if (c.kind === 'ball' && best2 < Infinity) {
      const d = Math.sqrt(best2);
      maxBall = Math.max(maxBall, R - d);
      if (z > floor + 1e-9 && d - R > 1e-6) notTouching++;
    }
  }
  return {
    checked,
    maxBallPenetration: c.kind === 'ball' ? maxBall : null,
    ballNotTouching: c.kind === 'ball' ? notTouching : null,
    maxVertexPenetration: maxVertex,
  };
}

/**
 * A lower bound on the true drop height by brute force: sample every triangle under the tool on
 * an n-step barycentric grid and drop the cutter on each sample as if it were a vertex. It
 * converges to the exact answer from below, so a result under this bound gouges.
 */
export function sampledBound(mesh: Mesh, c: Cutter, x: number, y: number, n: number): number {
  const R = c.diameter / 2;
  const p = mesh.positions;
  const ix = mesh.indices;
  let best = -Infinity;
  for (let t = 0; t < ix.length; t += 3) {
    const a = ix[t]! * 3,
      b = ix[t + 1]! * 3,
      d = ix[t + 2]! * 3;
    if (
      Math.min(p[a]!, p[b]!, p[d]!) > x + R ||
      Math.max(p[a]!, p[b]!, p[d]!) < x - R ||
      Math.min(p[a + 1]!, p[b + 1]!, p[d + 1]!) > y + R ||
      Math.max(p[a + 1]!, p[b + 1]!, p[d + 1]!) < y - R
    )
      continue;
    for (let i = 0; i <= n; i++) {
      for (let j = 0; j <= n - i; j++) {
        const u = i / n,
          v = j / n,
          w = 1 - u - v;
        const px = w * p[a]! + u * p[b]! + v * p[d]!;
        const py = w * p[a + 1]! + u * p[b + 1]! + v * p[d + 1]!;
        const r = Math.hypot(px - x, py - y);
        if (r > R) continue;
        const pz = w * p[a + 2]! + u * p[b + 2]! + v * p[d + 2]!;
        best = Math.max(best, pz - profileHeight(c, r));
      }
    }
  }
  return best;
}
