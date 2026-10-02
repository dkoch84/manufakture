// Point filtering for 3D toolpaths (M5 plan T5.5a): a dense polyline of cutter locations becomes
// lines and arcs, each within a tolerance of every point it replaces, before posting. Greedy from
// the start: the longest run of points one straight line holds, against the longest run one arc
// holds (an arc in the XY plane, its Z changing linearly with the angle: a flat arc or a helix, the
// only arcs the IR has), and the longer wins (a line on a tie). Runs are found by galloping and
// bisection; every accepted element is checked against every point it covers, so the result is
// within the tolerance whatever the run search guessed.
//
// A straight raster line lies in a vertical plane, so it can only become lines; arcs come from
// cutter locations that run around in XY (a contour at one height, a spiral).

import { grblArcPrecheck } from '../offset/grbl';
import { MAX_ARC_SWEEP, MAX_FIT_RADIUS } from '../offset/tolerances';
import type { ArcSegment2, Vec2, Vec3 } from '../types';

/** One fitted element, from the end of the one before (or the first point) to `to`. */
export type FitElement =
  | { readonly kind: 'line'; readonly to: Vec3 }
  | { readonly kind: 'arc'; readonly to: Vec3; readonly center: Vec2; readonly ccw: boolean };

/** An arc must cover at least this many points (start and end included) to be tried. */
const MIN_ARC_POINTS = 4;

/** An arc tighter than this radius, mm, is not fitted: such a run is better left as lines. */
const MIN_ARC_RADIUS = 0.05;

const TAU = 2 * Math.PI;

/** Distance from `p` to the segment `a`-`b`, in 3D. */
export function distToSegment3(p: Vec3, a: Vec3, b: Vec3): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const dz = b[2] - a[2];
  const l2 = dx * dx + dy * dy + dz * dz;
  let t = l2 > 0 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy + (p[2] - a[2]) * dz) / l2 : 0;
  t = Math.min(1, Math.max(0, t));
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy, p[2] - a[2] - t * dz);
}

function lineHolds(pts: readonly Vec3[], i: number, j: number, tol: number): boolean {
  const a = pts[i]!;
  const b = pts[j]!;
  for (let k = i + 1; k < j; k++) if (distToSegment3(pts[k]!, a, b) > tol) return false;
  return true;
}

interface ArcFit {
  readonly center: Vec2;
  readonly ccw: boolean;
}

/** The XY circle through three points, or undefined when they are (nearly) collinear. */
function circle3(a: Vec3, b: Vec3, c: Vec3): { center: Vec2; r: number } | undefined {
  const bx = b[0] - a[0];
  const by = b[1] - a[1];
  const cx = c[0] - a[0];
  const cy = c[1] - a[1];
  const d = 2 * (bx * cy - by * cx);
  if (Math.abs(d) < 1e-12) return undefined;
  const b2 = bx * bx + by * by;
  const c2 = cx * cx + cy * cy;
  const ux = (cy * b2 - by * c2) / d;
  const uy = (bx * c2 - cx * b2) / d;
  return { center: [a[0] + ux, a[1] + uy], r: Math.hypot(ux, uy) };
}

/** Does one arc (or helix) from point i to point j hold every point between, within `tol`? */
function arcHolds(pts: readonly Vec3[], i: number, j: number, tol: number): ArcFit | undefined {
  if (j - i + 1 < MIN_ARC_POINTS) return undefined;
  const a = pts[i]!;
  const b = pts[j]!;
  const m = pts[(i + j) >> 1]!;
  const c = circle3(a, m, b);
  if (!c || c.r < MIN_ARC_RADIUS || c.r > MAX_FIT_RADIUS) return undefined;
  const [cx, cy] = c.center;
  const ang = (p: Vec3): number => Math.atan2(p[1] - cy, p[0] - cx);
  const a0 = ang(a);
  // Direction from the middle point: the arc runs from a through m to b.
  const cross = (m[0] - a[0]) * (b[1] - a[1]) - (m[1] - a[1]) * (b[0] - a[0]);
  const ccw = cross > 0;
  const along = (p: Vec3): number => {
    const d = ang(p) - a0;
    const n = ((d % TAU) + TAU) % TAU;
    return ccw ? n : (TAU - n) % TAU;
  };
  const sweep = along(b);
  if (!(sweep > 1e-9) || sweep > MAX_ARC_SWEEP) return undefined;
  let prev = 0;
  for (let k = i + 1; k <= j; k++) {
    const p = pts[k]!;
    const t = k === j ? sweep : along(p);
    // Points run forwards along the arc, never back past the start or beyond the end.
    if (t < prev - 1e-9 || t > sweep + 1e-9) return undefined;
    prev = t;
    if (k === j) break;
    const radial = Math.hypot(p[0] - cx, p[1] - cy) - c.r;
    const dz = p[2] - (a[2] + ((b[2] - a[2]) * t) / sweep);
    if (Math.hypot(radial, dz) > tol) return undefined;
  }
  // The chords between neighbouring points must not cut across the arc's inside either.
  for (let k = i; k < j; k++) {
    const p = pts[k]!;
    const q = pts[k + 1]!;
    const mid: Vec3 = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (p[2] + q[2]) / 2];
    if (Math.abs(Math.hypot(mid[0] - cx, mid[1] - cy) - c.r) > tol) return undefined;
  }
  const seg: ArcSegment2 = {
    kind: 'arc',
    start: [a[0], a[1]],
    end: [b[0], b[1]],
    center: c.center,
    ccw,
  };
  if (!grblArcPrecheck(seg).ok) return undefined;
  return { center: c.center, ccw };
}

/** The largest j in (i, n) for which `holds(i, j)`, by galloping then bisection. */
function longestRun(n: number, i: number, holds: (j: number) => boolean, minJ: number): number {
  let good = -1;
  let step = 1;
  let j = Math.max(i + 1, minJ);
  if (j >= n) return -1;
  let bad = n;
  while (j < n) {
    if (holds(j)) {
      good = j;
      j += step;
      step *= 2;
    } else {
      bad = j;
      break;
    }
  }
  if (good < 0) return -1;
  // Bisection between the last good and the first bad (or the end).
  let lo = good;
  let hi = Math.min(bad, n);
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (holds(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

/**
 * Lines and arcs through `points` (cutter locations in order), each within `tolerance` mm of every
 * point it replaces; the first element starts at `points[0]`, the last ends at the last point.
 * Fewer than two points give no elements.
 */
export function fitPolyline(points: readonly Vec3[], tolerance: number): FitElement[] {
  const out: FitElement[] = [];
  const n = points.length;
  let i = 0;
  while (i < n - 1) {
    const jLine = Math.max(
      i + 1,
      longestRun(n, i, (j) => lineHolds(points, i, j, tolerance), i + 1),
    );
    const jArc = longestRun(
      n,
      i,
      (j) => arcHolds(points, i, j, tolerance) !== undefined,
      i + MIN_ARC_POINTS - 1,
    );
    if (jArc > jLine) {
      const fit = arcHolds(points, i, jArc, tolerance)!;
      out.push({ kind: 'arc', to: points[jArc]!, center: fit.center, ccw: fit.ccw });
      i = jArc;
    } else {
      out.push({ kind: 'line', to: points[jLine]! });
      i = jLine;
    }
  }
  return out;
}
