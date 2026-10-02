// Z-level slices of a mesh for 3D roughing (M5 plan T5.5a): where material stands at or above a
// height, as loops in machine XY, conservatively (never smaller than the truth).
//
// A grid of `cell` mm holds, at each node, the highest point of the mesh within `reach` of it in
// XY: a flat cutter of radius `reach` dropped there (`DropCutter`). With `reach` at least the
// cell's diagonal, any XY point under material at height h lies in a grid triangle whose three
// corners all hold at least h, so the piecewise-linear interpolant of the grid (two triangles per
// cell) is at least h there too. The region where that interpolant exceeds a level, traced by
// marching triangles, therefore contains every point with material above the level. The region's
// loops are then simplified within `simplify` mm, which `reach` must also cover (a point under
// material is then `simplify` deep inside the traced region, so the simplified loop still holds it).
// The regions of falling levels are nested: the interpolant is one function.

import type { Loop2, Vec2 } from '../types';
import type { SurfaceSampler } from './dropcutter';

/** Node heights over a grid in machine XY: node (i, j) is at `(x0 + i * cell, y0 + j * cell)`. */
export interface HeightGrid {
  readonly x0: number;
  readonly y0: number;
  readonly cell: number;
  readonly nx: number;
  readonly ny: number;
  /** `nx * ny` heights, row by row (j major); `empty` where no material is within reach. */
  readonly values: Float64Array;
  /** The value of a node with nothing within reach (below every level asked about). */
  readonly empty: number;
}

/** Grids larger than this many nodes are refused. */
export const MAX_GRID_NODES = 16e6;

/**
 * The height grid over `[minX, maxX] x [minY, maxY]`, with one ring of `empty` nodes added
 * around it so every traced loop closes. `sampler` is a flat drop-cutter whose radius is the
 * reach. `onRow` is awaited every 16 rows (for cancellation). Undefined when too large.
 */
export async function heightGrid(
  sampler: SurfaceSampler,
  box: {
    readonly minX: number;
    readonly minY: number;
    readonly maxX: number;
    readonly maxY: number;
  },
  cell: number,
  empty: number,
  onRow?: () => Promise<void>,
): Promise<HeightGrid | undefined> {
  const x0 = box.minX - cell;
  const y0 = box.minY - cell;
  const nx = Math.ceil((box.maxX - box.minX) / cell) + 3;
  const ny = Math.ceil((box.maxY - box.minY) / cell) + 3;
  if (!(nx > 0 && ny > 0) || nx * ny > MAX_GRID_NODES) return undefined;
  const values = new Float64Array(nx * ny).fill(empty);
  for (let j = 1; j < ny - 1; j++) {
    if (onRow && j % 16 === 0) await onRow();
    const y = y0 + j * cell;
    for (let i = 1; i < nx - 1; i++) values[j * nx + i] = sampler.drop(x0 + i * cell, y, empty);
  }
  return { x0, y0, cell, nx, ny, values, empty };
}

/**
 * The loops around where the grid's interpolant is above `level`: outer loops counter-clockwise,
 * holes clockwise (the `Loop2` convention, the region on the left), simplified within `simplify`
 * mm, with loops of less than `minArea` mm2 dropped.
 */
export function superLevelLoops(
  grid: HeightGrid,
  level: number,
  simplify: number,
  minArea = 1e-4,
): Loop2[] {
  const { nx, ny, values: g, x0, y0, cell } = grid;
  const N = nx * ny;
  const key = (u: number, w: number): number => (u < w ? u * N + w : w * N + u);
  /** Exit edge key to entry edge key, per triangle crossed. */
  const next = new Map<number, number>();
  const edgeEnds = new Map<number, [number, number]>();
  const inside = (v: number): boolean => g[v]! > level;
  const tri = (a: number, b: number, c: number): void => {
    const ia = inside(a);
    const ib = inside(b);
    const ic = inside(c);
    if (ia === ib && ib === ic) return;
    const verts = [a, b, c];
    const ins = [ia, ib, ic];
    let exit = -1;
    let entry = -1;
    for (let e = 0; e < 3; e++) {
      const p = verts[e]!;
      const q = verts[(e + 1) % 3]!;
      if (ins[e] && !ins[(e + 1) % 3]) {
        exit = key(p, q);
        edgeEnds.set(exit, [p, q]);
      } else if (!ins[e] && ins[(e + 1) % 3]) {
        entry = key(p, q);
        edgeEnds.set(entry, [p, q]);
      }
    }
    next.set(exit, entry);
  };
  for (let j = 0; j + 1 < ny; j++) {
    for (let i = 0; i + 1 < nx; i++) {
      const v00 = j * nx + i;
      const v10 = v00 + 1;
      const v01 = v00 + nx;
      const v11 = v01 + 1;
      tri(v00, v10, v11);
      tri(v00, v11, v01);
    }
  }
  const point = (k: number): Vec2 => {
    const [u, w] = edgeEnds.get(k)!;
    const gu = g[u]!;
    const gw = g[w]!;
    const t = (level - gu) / (gw - gu);
    const ux = x0 + (u % nx) * cell;
    const uy = y0 + Math.floor(u / nx) * cell;
    const wx = x0 + (w % nx) * cell;
    const wy = y0 + Math.floor(w / nx) * cell;
    return [ux + (wx - ux) * t, uy + (wy - uy) * t];
  };
  const loops: Loop2[] = [];
  const seen = new Set<number>();
  for (const start of next.keys()) {
    if (seen.has(start)) continue;
    const pts: Vec2[] = [];
    let k = start;
    while (!seen.has(k)) {
      seen.add(k);
      const p = point(k);
      const last = pts[pts.length - 1];
      if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > 1e-9) pts.push(p);
      const n = next.get(k);
      if (n === undefined) break;
      k = n;
    }
    if (pts.length > 1) {
      const a = pts[0]!;
      const b = pts[pts.length - 1]!;
      if (Math.hypot(a[0] - b[0], a[1] - b[1]) <= 1e-9) pts.pop();
    }
    const simple = simplifyClosed(pts, simplify);
    if (simple.length < 3 || Math.abs(polygonArea(simple)) < minArea) continue;
    loops.push({
      segments: simple.map((p, i) => ({
        kind: 'line' as const,
        start: p,
        end: simple[(i + 1) % simple.length]!,
      })),
    });
  }
  return loops;
}

/** Signed area of a closed polygon, positive counter-clockwise. */
export function polygonArea(pts: readonly Vec2[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!;
    const q = pts[(i + 1) % pts.length]!;
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

function distToChord(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.min(1, Math.max(0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

/**
 * Douglas-Peucker on a closed polygon: every dropped point within `tol` of the chord that
 * replaces it. Split at the point furthest from the first, so both halves are open chains.
 */
export function simplifyClosed(pts: readonly Vec2[], tol: number): Vec2[] {
  const n = pts.length;
  if (n < 4 || !(tol > 0)) return [...pts];
  const a = pts[0]!;
  let far = 1;
  let farD = -1;
  for (let i = 1; i < n; i++) {
    const d = Math.hypot(pts[i]![0] - a[0], pts[i]![1] - a[1]);
    if (d > farD) {
      farD = d;
      far = i;
    }
  }
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[far] = 1;
  const stack: [number, number][] = [
    [0, far],
    [far, n],
  ];
  while (stack.length > 0) {
    const [i, j] = stack.pop()!;
    const pa = pts[i]!;
    const pb = pts[j % n]!;
    let worst = -1;
    let at = -1;
    for (let k = i + 1; k < j; k++) {
      const d = distToChord(pts[k]!, pa, pb);
      if (d > worst) {
        worst = d;
        at = k;
      }
    }
    if (at >= 0 && worst > tol) {
      keep[at] = 1;
      stack.push([i, at], [at, j]);
    }
  }
  const out: Vec2[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(pts[i]!);
  return out;
}
