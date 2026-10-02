// Correctness metrics: how far an offset (Clipper's polylines, or the refit lines
// and arcs) is from the exact offset of the line/arc source.
//
// The exact offset of a region R by d is the set of points at distance |d| from
// R's boundary on the side d points to. So:
//
// - forward (result to exact): for points along the result, | dist(p, boundary) - |d| |;
// - backward (exact to result): sample the exact offset (each curve moved along its
//   normal, plus the round join around every corner on the offset side), keep the
//   samples that really are at distance |d| from the whole boundary (the rest are
//   trimmed away by other parts of the shape), and measure their distance to the
//   result.
//
// The Hausdorff distance is the larger of the two.

import type { Curve, P, Shape, TaggedPath } from './geometry.ts';
import {
  curveLength,
  curveNormal,
  curvePoint,
  curveTangent,
  distToSegment,
  distToShape,
} from './geometry.ts';
import { type Element, arcSweep, distToElement, sampleElement } from './refit.ts';

/** A uniform grid for nearest-item queries. */
export class NearestIndex<T> {
  private readonly cells = new Map<string, T[]>();
  private readonly h: number;
  private readonly distance: (p: P, item: T) => number;
  constructor(h: number, distance: (p: P, item: T) => number) {
    this.h = h;
    this.distance = distance;
  }

  add(item: T, bbox: readonly [number, number, number, number]): void {
    const [x0, y0, x1, y1] = bbox;
    for (let i = Math.floor(x0 / this.h); i <= Math.floor(x1 / this.h); i++) {
      for (let j = Math.floor(y0 / this.h); j <= Math.floor(y1 / this.h); j++) {
        const k = `${i},${j}`;
        const list = this.cells.get(k);
        if (list) list.push(item);
        else this.cells.set(k, [item]);
      }
    }
  }

  nearest(p: P, maxRing = 10_000): number {
    const ci = Math.floor(p[0] / this.h);
    const cj = Math.floor(p[1] / this.h);
    let best = Infinity;
    for (let ring = 0; ring <= maxRing; ring++) {
      for (let i = ci - ring; i <= ci + ring; i++) {
        for (let j = cj - ring; j <= cj + ring; j++) {
          if (Math.max(Math.abs(i - ci), Math.abs(j - cj)) !== ring) continue;
          for (const item of this.cells.get(`${i},${j}`) ?? []) {
            best = Math.min(best, this.distance(p, item));
          }
        }
      }
      // Anything in a farther ring is at least `ring * h` away.
      if (best <= ring * this.h) break;
    }
    return best;
  }
}

const segBox = (a: P, b: P): [number, number, number, number] => [
  Math.min(a[0], b[0]),
  Math.min(a[1], b[1]),
  Math.max(a[0], b[0]),
  Math.max(a[1], b[1]),
];

/** Index over the segments of closed polylines. */
export function indexPaths(paths: readonly TaggedPath[], h = 1): NearestIndex<[P, P]> {
  const idx = new NearestIndex<[P, P]>(h, (p, s) => distToSegment(p, s[0], s[1]));
  for (const { xy } of paths) {
    const n = xy.length / 2;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const a: P = [xy[2 * i]!, xy[2 * i + 1]!];
      const b: P = [xy[2 * j]!, xy[2 * j + 1]!];
      idx.add([a, b], segBox(a, b));
    }
  }
  return idx;
}

/** Index over refit elements. */
export function indexElements(loops: readonly Element[][], h = 1): NearestIndex<Element> {
  const idx = new NearestIndex<Element>(h, distToElement);
  for (const loop of loops) {
    for (const e of loop) {
      if (e.kind === 'line') idx.add(e, segBox(e.a, e.b));
      else {
        // The box of 64 chords, grown by their sagitta.
        const pts = sampleElement(e, 64);
        const r = Math.hypot(e.a[0] - e.c[0], e.a[1] - e.c[1]);
        const sag = r * (1 - Math.cos(Math.abs(arcSweep(e)) / 128));
        const xs = pts.map((p) => p[0]);
        const ys = pts.map((p) => p[1]);
        idx.add(e, [
          Math.min(...xs) - sag,
          Math.min(...ys) - sag,
          Math.max(...xs) + sag,
          Math.max(...ys) + sag,
        ]);
      }
    }
  }
  return idx;
}

/** Index over the exact source curves, for distance-to-boundary queries. */
export function indexShape(shape: Shape, h = 2): (p: P) => number {
  const curves = shape.loops.flat();
  if (curves.length < 64) return (p) => distToShape(p, shape);
  const idx = new NearestIndex<Curve>(h, (p, c) => distToShape(p, { loops: [[c]] }));
  for (const c of curves) {
    if (c.kind === 'line') idx.add(c, segBox(c.a, c.b));
    else idx.add(c, [c.c[0] - c.r, c.c[1] - c.r, c.c[0] + c.r, c.c[1] + c.r]);
  }
  return (p) => idx.nearest(p);
}

/** Points along closed polylines: vertices and segment midpoints. */
export function pathSamples(paths: readonly TaggedPath[]): P[] {
  const out: P[] = [];
  for (const { xy } of paths) {
    const n = xy.length / 2;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      out.push([xy[2 * i]!, xy[2 * i + 1]!]);
      out.push([(xy[2 * i]! + xy[2 * j]!) / 2, (xy[2 * i + 1]! + xy[2 * j + 1]!) / 2]);
    }
  }
  return out;
}

/** Points along refit elements: `perElement + 1` each. */
export function elementSamples(loops: readonly Element[][], perElement = 16): P[] {
  return loops.flatMap((l) => l.flatMap((e) => sampleElement(e, perElement)));
}

/**
 * Samples of the exact offset of `shape` by `delta` (positive outward), about
 * `spacing` mm apart, with the trimmed parts removed.
 */
export function exactOffsetSamples(shape: Shape, delta: number, spacing = 0.05): P[] {
  const d = Math.abs(delta);
  const s = Math.sign(delta);
  const distB = indexShape(shape);
  const keep = (p: P) => distB(p) >= d - 1e-7;
  const out: P[] = [];
  for (const loop of shape.loops) {
    loop.forEach((c, ci) => {
      const n = Math.max(2, Math.ceil(curveLength(c) / spacing));
      for (let k = 0; k <= n; k++) {
        const t = k / n;
        const q = curvePoint(c, t);
        const nn = curveNormal(c, t);
        const p: P = [q[0] + delta * nn[0], q[1] + delta * nn[1]];
        if (keep(p)) out.push(p);
      }
      // Round join at the corner where this curve starts, when it opens on the offset side.
      const prev = loop[(ci + loop.length - 1) % loop.length]!;
      const n0 = curveNormal(prev, 1);
      const n1 = curveNormal(c, 0);
      const t0 = curveTangent(prev, 1);
      const turn = t0[0] * curveTangent(c, 0)[1] - t0[1] * curveTangent(c, 0)[0];
      // Outward offsets get joins at left turns (convex corners); inward ones at right turns.
      if (s * turn <= 1e-12) return;
      const v = curvePoint(c, 0);
      const a0 = Math.atan2(s * n0[1], s * n0[0]);
      let a1 = Math.atan2(s * n1[1], s * n1[0]);
      // The join turns the same way as the corner.
      if (s > 0) while (a1 < a0) a1 += 2 * Math.PI;
      else while (a1 > a0) a1 -= 2 * Math.PI;
      const m = Math.max(2, Math.ceil((Math.abs(a1 - a0) * d) / spacing));
      for (let k = 1; k < m; k++) {
        const a = a0 + ((a1 - a0) * k) / m;
        const p: P = [v[0] + d * Math.cos(a), v[1] + d * Math.sin(a)];
        if (keep(p)) out.push(p);
      }
    });
  }
  return out;
}

export interface Deviation {
  /** Result to exact: max | dist(p, boundary) - |d| |. */
  forward: number;
  /** Exact to result. */
  backward: number;
  hausdorff: number;
}

export function deviationOfPaths(
  paths: readonly TaggedPath[],
  shape: Shape,
  delta: number,
  exact: readonly P[],
): Deviation {
  const distB = indexShape(shape);
  const d = Math.abs(delta);
  let forward = 0;
  for (const p of pathSamples(paths)) forward = Math.max(forward, Math.abs(distB(p) - d));
  let backward = 0;
  if (paths.length > 0) {
    const idx = indexPaths(paths);
    for (const p of exact) backward = Math.max(backward, idx.nearest(p));
  } else if (exact.length > 0) backward = Infinity;
  return { forward, backward, hausdorff: Math.max(forward, backward) };
}

export function deviationOfElements(
  loops: readonly Element[][],
  shape: Shape,
  delta: number,
  exact: readonly P[],
): Deviation {
  const distB = indexShape(shape);
  const d = Math.abs(delta);
  let forward = 0;
  for (const p of elementSamples(loops)) forward = Math.max(forward, Math.abs(distB(p) - d));
  let backward = 0;
  if (loops.length > 0) {
    const idx = indexElements(loops);
    for (const p of exact) backward = Math.max(backward, idx.nearest(p));
  } else if (exact.length > 0) backward = Infinity;
  return { forward, backward, hausdorff: Math.max(forward, backward) };
}

/** Max distance between refit elements and the polylines they replace, both ways. */
export function refitVsPolyline(paths: readonly TaggedPath[], loops: readonly Element[][]): number {
  const pIdx = indexPaths(paths);
  const eIdx = indexElements(loops);
  let m = 0;
  for (const p of elementSamples(loops)) m = Math.max(m, pIdx.nearest(p));
  for (const p of pathSamples(paths)) m = Math.max(m, eIdx.nearest(p));
  return m;
}
