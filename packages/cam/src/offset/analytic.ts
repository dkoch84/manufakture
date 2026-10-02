// The analytic fast path (M5 plan, T5.2a): the exact offset of a single line/arc loop, without
// Clipper, in the cases where it provably does not self-intersect:
//
// - a lone full circle, counter-clockwise, offset by any delta that leaves a positive radius;
// - a convex counter-clockwise loop (lines and counter-clockwise arcs, every junction turning
//   left or tangent, total turning one full turn) offset outward (delta > 0): every segment moves
//   out along its normal and every sharp corner gets a round join of radius delta. Not when a
//   corner's join would be within `DEMOTE_SAGITTA` of its chord (a dense polygon), since the
//   refit rebuilds such a polygon's offset as a few arcs.
//
// Anything else returns undefined and goes through Clipper. The result is exact: no flattening.

import type { ArcSegment2, LineSegment2, Loop2, Segment2, Vec2 } from '../types';
import { arcRadius, dist, segmentTangent, signedSweep } from './geometry';
import { demoteSegments } from './refit';
import { DEMOTE_SAGITTA, GRBL_CHECK_DECIMALS, MAX_ARC_SWEEP, TANGENT_ANGLE } from './tolerances';

const TAU = 2 * Math.PI;

const cross = (a: Vec2, b: Vec2): number => a[0] * b[1] - a[1] * b[0];
const dot = (a: Vec2, b: Vec2): number => a[0] * b[0] + a[1] * b[1];
const along = (p: Vec2, n: Vec2, d: number): Vec2 => [p[0] + n[0] * d, p[1] + n[1] * d];
/** The outward normal of a counter-clockwise loop: the right of the tangent. */
const rightOf = (t: Vec2): Vec2 => [t[1], -t[0]];

function withSource<T extends Segment2>(s: T, from: Segment2): T {
  return from.source ? { ...s, source: from.source } : s;
}

/** A circle about `c` of radius `r`, counter-clockwise, as two half arcs from angle `a0`. */
function circleHalves(c: Vec2, r: number, a0: number, from: Segment2): Segment2[] {
  const p0: Vec2 = [c[0] + r * Math.cos(a0), c[1] + r * Math.sin(a0)];
  const p1: Vec2 = [c[0] - r * Math.cos(a0), c[1] - r * Math.sin(a0)];
  const half = (start: Vec2, end: Vec2): ArcSegment2 =>
    withSource({ kind: 'arc', start, end, center: c, ccw: true }, from);
  return [half(p0, p1), half(p1, p0)];
}

/**
 * The offset of `loop` by `delta` (mm, positive outward) when the fast path applies: a list of
 * loops (empty when a circle vanishes), or undefined when Clipper must do it. `decimals` is the
 * precision of the Grbl pre-check in the last step (`demoteSegments`).
 */
export function analyticOffset(
  loop: Loop2,
  delta: number,
  decimals = GRBL_CHECK_DECIMALS,
): Loop2[] | undefined {
  const segs = loop.segments;
  if (segs.length === 1) {
    const s = segs[0]!;
    if (s.kind !== 'arc' || !s.fullCircle || !s.ccw) return undefined;
    const r = arcRadius(s) + delta;
    // A radius under the refit tolerance is dropped by the engine's common filter, as Clipper's is.
    if (r <= 0) return [];
    const a0 = Math.atan2(s.start[1] - s.center[1], s.start[0] - s.center[0]);
    return [{ segments: demoteSegments(circleHalves(s.center, r, a0, s), decimals) }];
  }
  if (!(delta > 0)) return undefined;
  // Convex and counter-clockwise: arcs turn left, junctions turn left (or not at all), and the
  // turning adds up to one full turn.
  let turning = 0;
  const turns: number[] = [];
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]!;
    if (s.kind === 'arc') {
      if (!s.ccw || s.fullCircle) return undefined;
      turning += signedSweep(s);
    }
    const next = segs[(i + 1) % segs.length]!;
    const t0 = segmentTangent(s, 1);
    const t1 = segmentTangent(next, 0);
    if (dot(t0, t0) === 0 || dot(t1, t1) === 0) return undefined;
    const turn = Math.atan2(cross(t0, t1), dot(t0, t1));
    if (turn < -TANGENT_ANGLE || turn >= Math.PI - 1e-9) return undefined;
    // A dense polygon's tiny corner joins would all become lines; the refit does better there.
    if (turn > TANGENT_ANGLE && delta * (1 - Math.cos(turn / 2)) <= DEMOTE_SAGITTA) {
      return undefined;
    }
    turns.push(Math.max(0, turn));
    turning += turn;
  }
  if (Math.abs(turning - TAU) > 1e-6) return undefined;

  const out: Segment2[] = [];
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]!;
    if (s.kind === 'line') {
      const n = rightOf(segmentTangent(s, 0));
      const line: LineSegment2 = {
        kind: 'line',
        start: along(s.start, n, delta),
        end: along(s.end, n, delta),
      };
      out.push(withSource(line, s));
    } else {
      const r = arcRadius(s);
      const k = (r + delta) / r;
      const scaled = (p: Vec2): Vec2 => [
        s.center[0] + (p[0] - s.center[0]) * k,
        s.center[1] + (p[1] - s.center[1]) * k,
      ];
      // Split past half a turn, as the refit does.
      const sweep = signedSweep(s);
      const pieces = Math.ceil(sweep / MAX_ARC_SWEEP - 1e-9);
      const a0 = Math.atan2(s.start[1] - s.center[1], s.start[0] - s.center[0]);
      let a = scaled(s.start);
      for (let p = 1; p <= pieces; p++) {
        const b: Vec2 =
          p === pieces
            ? scaled(s.end)
            : [
                s.center[0] + (r + delta) * Math.cos(a0 + (sweep * p) / pieces),
                s.center[1] + (r + delta) * Math.sin(a0 + (sweep * p) / pieces),
              ];
        const arc: ArcSegment2 = { kind: 'arc', start: a, end: b, center: s.center, ccw: true };
        out.push(withSource(arc, s));
        a = b;
      }
    }
    // The join at the end of segment i.
    const next = segs[(i + 1) % segs.length]!;
    const v = s.end;
    const from = along(v, rightOf(segmentTangent(s, 1)), delta);
    const to = along(v, rightOf(segmentTangent(next, 0)), delta);
    const turn = turns[i]!;
    if (turn > TANGENT_ANGLE) {
      const pieces = Math.ceil(turn / MAX_ARC_SWEEP);
      let a = from;
      const a0 = Math.atan2(from[1] - v[1], from[0] - v[0]);
      for (let p = 1; p <= pieces; p++) {
        const b: Vec2 =
          p === pieces
            ? to
            : [
                v[0] + delta * Math.cos(a0 + (turn * p) / pieces),
                v[1] + delta * Math.sin(a0 + (turn * p) / pieces),
              ];
        out.push({ kind: 'arc', start: a, end: b, center: v, ccw: true });
        a = b;
      }
    }
  }
  // Close tiny gaps at tangent junctions: each segment starts exactly where the previous ends.
  const joined = out.map((s, i): Segment2 => {
    const prev = out[(i + out.length - 1) % out.length]!;
    if (dist(prev.end, s.start) === 0) return s;
    return { ...s, start: prev.end };
  });
  return [{ segments: demoteSegments(joined, decimals) }];
}
