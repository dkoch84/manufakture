// Exact 2D geometry of lines and arcs (`Segment2`): sweeps, points, tangents, distances, areas.
// The offset engine flattens and refits with these, and tests measure results with them.

import type { ArcSegment2, Loop2, Segment2, Vec2 } from '../types';

const TAU = 2 * Math.PI;

export const dist = (a: Vec2, b: Vec2): number => Math.hypot(a[0] - b[0], a[1] - b[1]);

export const midpoint = (a: Vec2, b: Vec2): Vec2 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];

const normAngle = (a: number): number => {
  const r = a % TAU;
  return r < 0 ? r + TAU : r;
};

/** Radius of an arc: the distance of its start from its centre. */
export function arcRadius(arc: ArcSegment2): number {
  return dist(arc.start, arc.center);
}

/**
 * Signed sweep of an arc, radians: positive counter-clockwise, plus or minus 2 pi for a full
 * circle, zero for a degenerate arc whose ends coincide without `fullCircle`.
 */
export function signedSweep(arc: ArcSegment2): number {
  if (arc.fullCircle) return arc.ccw ? TAU : -TAU;
  const a0 = Math.atan2(arc.start[1] - arc.center[1], arc.start[0] - arc.center[0]);
  const a1 = Math.atan2(arc.end[1] - arc.center[1], arc.end[0] - arc.center[0]);
  return arc.ccw ? normAngle(a1 - a0) : -normAngle(a0 - a1);
}

/** Point at parameter `t` in [0, 1] along the segment. */
export function segmentPoint(s: Segment2, t: number): Vec2 {
  if (s.kind === 'line') {
    return [s.start[0] + t * (s.end[0] - s.start[0]), s.start[1] + t * (s.end[1] - s.start[1])];
  }
  const r = arcRadius(s);
  const a = Math.atan2(s.start[1] - s.center[1], s.start[0] - s.center[0]) + t * signedSweep(s);
  return [s.center[0] + r * Math.cos(a), s.center[1] + r * Math.sin(a)];
}

/** Unit tangent in the direction of travel at parameter `t`, or [0, 0] for a zero segment. */
export function segmentTangent(s: Segment2, t: number): Vec2 {
  if (s.kind === 'line') {
    const l = dist(s.start, s.end);
    return l > 0 ? [(s.end[0] - s.start[0]) / l, (s.end[1] - s.start[1]) / l] : [0, 0];
  }
  const a = Math.atan2(s.start[1] - s.center[1], s.start[0] - s.center[0]) + t * signedSweep(s);
  return s.ccw ? [-Math.sin(a), Math.cos(a)] : [Math.sin(a), -Math.cos(a)];
}

export function segmentLength(s: Segment2): number {
  return s.kind === 'line' ? dist(s.start, s.end) : Math.abs(signedSweep(s)) * arcRadius(s);
}

/** Is angle `a` within the sweep that starts at `a0` (signed)? */
function angleOnSweep(a0: number, sweep: number, a: number): boolean {
  if (Math.abs(sweep) >= TAU - 1e-12) return true;
  const d = sweep > 0 ? normAngle(a - a0) : normAngle(a0 - a);
  return d <= Math.abs(sweep) + 1e-12;
}

export function distToLine(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  let t = l2 === 0 ? 0 : ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

/** Distance from `p` to the segment (a line or the arc itself, not its full circle). */
export function distToSegment(p: Vec2, s: Segment2): number {
  if (s.kind === 'line') return distToLine(p, s.start, s.end);
  const a0 = Math.atan2(s.start[1] - s.center[1], s.start[0] - s.center[0]);
  const a = Math.atan2(p[1] - s.center[1], p[0] - s.center[0]);
  if (angleOnSweep(a0, signedSweep(s), a)) return Math.abs(dist(p, s.center) - arcRadius(s));
  return Math.min(dist(p, s.start), dist(p, s.end));
}

/** Distance from `p` to the nearest segment of any loop. */
export function distToLoops(p: Vec2, loops: readonly { segments: readonly Segment2[] }[]): number {
  let best = Infinity;
  for (const loop of loops)
    for (const s of loop.segments) best = Math.min(best, distToSegment(p, s));
  return best;
}

/** Exact signed area of a closed loop of lines and arcs, mm2: positive counter-clockwise. */
export function loopArea(loop: Loop2): number {
  let a = 0;
  for (const s of loop.segments) {
    a += (s.start[0] * s.end[1] - s.end[0] * s.start[1]) / 2;
    if (s.kind === 'arc') {
      // The circular segment between chord and arc, signed with the sweep.
      const sw = signedSweep(s);
      const r = arcRadius(s);
      a += (r * r * (sw - Math.sin(sw))) / 2;
    }
  }
  return a;
}

/** Total length of a loop's segments, mm. */
export function loopLength(loop: Loop2): number {
  return loop.segments.reduce((sum, s) => sum + segmentLength(s), 0);
}

/** `n + 1` points along a segment, both ends included. */
export function sampleSegment(s: Segment2, n: number): Vec2[] {
  const out: Vec2[] = [];
  for (let k = 0; k <= n; k++) out.push(segmentPoint(s, k / n));
  return out;
}

/** Even-odd point-in-polygon test over closed polylines (for example `flattenLoop` output). */
export function pointInLoops(p: Vec2, polylines: readonly (readonly Vec2[])[]): boolean {
  let inside = false;
  for (const pts of polylines) {
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const a = pts[i]!;
      const b = pts[j]!;
      if (a[1] > p[1] !== b[1] > p[1]) {
        const x = a[0] + ((p[1] - a[1]) * (b[0] - a[0])) / (b[1] - a[1]);
        if (p[0] < x) inside = !inside;
      }
    }
  }
  return inside;
}
