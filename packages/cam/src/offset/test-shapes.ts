// Shapes and measurements for the offset engine's tests.

import type { ArcSegment2, LineSegment2, Loop2, Segment2, SourceTag, Vec2 } from '../types';
import { reverseLoop } from '../wcs';
import type { Region2 } from './engine';
import { distToLoops, sampleSegment } from './geometry';

const line = (start: Vec2, end: Vec2, source?: SourceTag): LineSegment2 =>
  source ? { kind: 'line', start, end, source } : { kind: 'line', start, end };

const arc = (start: Vec2, end: Vec2, center: Vec2, ccw = true): ArcSegment2 => ({
  kind: 'arc',
  start,
  end,
  center,
  ccw,
});

/** A counter-clockwise rectangle from (x, y), `w` by `h`; lines tagged `e0` to `e3` when `tag`. */
export function rect(x: number, y: number, w: number, h: number, tag = false): Loop2 {
  const p: Vec2[] = [
    [x, y],
    [x + w, y],
    [x + w, y + h],
    [x, y + h],
  ];
  const src = (i: number): SourceTag | undefined =>
    tag ? { kind: 'sketch', sketch: 'sketch#1', entity: `e${i}` } : undefined;
  return { segments: p.map((a, i) => line(a, p[(i + 1) % 4]!, src(i))) };
}

/** A counter-clockwise rectangle centred on the origin with corner radius `r`. */
export function roundedRect(w: number, h: number, r: number): Loop2 {
  const x = w / 2;
  const y = h / 2;
  return {
    segments: [
      line([-x + r, -y], [x - r, -y]),
      arc([x - r, -y], [x, -y + r], [x - r, -y + r]),
      line([x, -y + r], [x, y - r]),
      arc([x, y - r], [x - r, y], [x - r, y - r]),
      line([x - r, y], [-x + r, y]),
      arc([-x + r, y], [-x, y - r], [-x + r, y - r]),
      line([-x, y - r], [-x, -y + r]),
      arc([-x, -y + r], [-x + r, -y], [-x + r, -y + r]),
    ],
  };
}

/** A counter-clockwise full circle. */
export function circle(c: Vec2, r: number, source?: SourceTag): Loop2 {
  const s: ArcSegment2 = { ...arc([c[0] + r, c[1]], [c[0] + r, c[1]], c), fullCircle: true };
  return { segments: [source ? { ...s, source } : s] };
}

/** A counter-clockwise slot (stadium) centred at `c`: `length` between end centres, `width` wide. */
export function slot(c: Vec2, length: number, width: number): Loop2 {
  const x = length / 2;
  const r = width / 2;
  const [cx, cy] = c;
  return {
    segments: [
      line([cx - x, cy - r], [cx + x, cy - r]),
      arc([cx + x, cy - r], [cx + x, cy + r], [cx + x, cy]),
      line([cx + x, cy + r], [cx - x, cy + r]),
      arc([cx - x, cy + r], [cx - x, cy - r], [cx - x, cy]),
    ],
  };
}

/** Two r10 lobes centred at (+-20, 0), joined by a neck `neck` wide. */
export function dumbbell(neck = 4): Loop2 {
  const h = neck / 2;
  const a = Math.sqrt(100 - h * h);
  return {
    segments: [
      line([-20 + a, -h], [20 - a, -h]),
      arc([20 - a, -h], [20 - a, h], [20, 0]),
      line([20 - a, h], [-20 + a, h]),
      arc([-20 + a, h], [-20 + a, -h], [-20, 0]),
    ],
  };
}

/** A closed polygon of lines through `points`. */
export function polygon(points: readonly Vec2[]): Loop2 {
  return { segments: points.map((p, i) => line(p, points[(i + 1) % points.length]!)) };
}

export const hole = reverseLoop;

/** A deterministic random number generator (mulberry32). */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A random star-shaped polygon about the origin: `n` vertices, radii in [rMin, rMax]. */
export function starPolygon(random: () => number, n: number, rMin: number, rMax: number): Loop2 {
  const pts: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const a = ((i + 0.2 + 0.6 * random()) / n) * 2 * Math.PI;
    const r = rMin + (rMax - rMin) * random();
    pts.push([r * Math.cos(a), r * Math.sin(a)]);
  }
  return polygon(pts);
}

/** A random convex polygon: `n` points on an ellipse at random angles. */
export function convexPolygon(random: () => number, n: number, rx: number, ry: number): Loop2 {
  const angles = Array.from({ length: n }, () => random() * 2 * Math.PI).sort((a, b) => a - b);
  const pts: Vec2[] = [];
  for (const a of angles) {
    const p: Vec2 = [rx * Math.cos(a), ry * Math.sin(a)];
    const prev = pts[pts.length - 1];
    if (!prev || Math.hypot(p[0] - prev[0], p[1] - prev[1]) > 1) pts.push(p);
  }
  return polygon(pts);
}

export function allLoops(regions: readonly Region2[]): Loop2[] {
  return regions.flatMap((r) => [r.outer, ...r.holes]);
}

export function allSegments(regions: readonly Region2[]): Segment2[] {
  return allLoops(regions).flatMap((l) => l.segments);
}

/** Points along every segment, `n` intervals per segment. */
export function samples(loops: readonly Loop2[], n = 8): Vec2[] {
  return loops.flatMap((l) => l.segments.flatMap((s) => sampleSegment(s, n)));
}

/**
 * The largest deviation of the result's boundary from the exact offset of `source` by `d`: every
 * point on the boundary of an exact offset is at distance |d| from the source's boundary.
 */
export function offsetDeviation(result: readonly Loop2[], source: readonly Loop2[], d: number) {
  let worst = 0;
  for (const p of samples(result)) {
    worst = Math.max(worst, Math.abs(distToLoops(p, source) - Math.abs(d)));
  }
  return worst;
}

/** Symmetric Hausdorff distance between two sets of loops, sampled. */
export function hausdorff(a: readonly Loop2[], b: readonly Loop2[], n = 8): number {
  let worst = 0;
  for (const p of samples(a, n)) worst = Math.max(worst, distToLoops(p, b));
  for (const p of samples(b, n)) worst = Math.max(worst, distToLoops(p, a));
  return worst;
}
