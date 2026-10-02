// Arc geometry shared by the IR statistics, bounds and validator: sweep, length and the true
// extremes of an arc (helices included).

import type { Box3, Vec2, Vec3 } from './types';

const TAU = 2 * Math.PI;

/** Angle, cosine and sine of the four axis crossings, exact (no cos(pi/2) = 6e-17). */
const AXIS_CROSSINGS: readonly (readonly [number, number, number])[] = [
  [0, 1, 0],
  [Math.PI / 2, 0, 1],
  [Math.PI, -1, 0],
  [(3 * Math.PI) / 2, 0, -1],
];

/** An arc in the XY plane from `start` to `end` (Z may differ: a helix). */
export interface Arc3 {
  readonly start: Vec3;
  readonly end: Vec3;
  readonly center: Vec2;
  readonly direction: 'cw' | 'ccw';
  readonly fullCircle: boolean;
}

/** `a` reduced to [0, 2 pi). */
export function normalizeAngle(a: number): number {
  const r = a % TAU;
  return r < 0 ? r + TAU : r;
}

/** Angle of `p` about `center`, radians in (-pi, pi]. */
export function angleAbout(center: Vec2, p: Vec2 | Vec3): number {
  return Math.atan2(p[1] - center[1], p[0] - center[0]);
}

/** Distance of `p` (XY) from `center`. */
export function radiusAbout(center: Vec2, p: Vec2 | Vec3): number {
  return Math.hypot(p[0] - center[0], p[1] - center[1]);
}

/**
 * The arc's sweep, radians: 2 pi for a full circle, otherwise the angle from start to end in the
 * arc's direction, in [0, 2 pi). Zero means start and end lie at the same angle without a full
 * circle being intended: a degenerate arc (the validator rejects it).
 */
export function arcSweep(arc: Arc3): number {
  if (arc.fullCircle) return TAU;
  const a0 = angleAbout(arc.center, arc.start);
  const a1 = angleAbout(arc.center, arc.end);
  return normalizeAngle(arc.direction === 'ccw' ? a1 - a0 : a0 - a1);
}

/** Path length of the arc, helix included: sqrt((r * sweep)^2 + dz^2) with the start radius. */
export function arcLength(arc: Arc3): number {
  const r = radiusAbout(arc.center, arc.start);
  return Math.hypot(r * arcSweep(arc), arc.end[2] - arc.start[2]);
}

/**
 * The arc's exact bounding box: its end points plus every axis crossing (0, pi/2, pi, 3 pi/2)
 * the sweep passes, on the start radius. Z runs linearly with the angle on a helix, so its
 * extremes are the end points' Z.
 */
export function arcBounds(arc: Arc3): Box3 {
  const r = radiusAbout(arc.center, arc.start);
  const sweep = arcSweep(arc);
  const a0 = angleAbout(arc.center, arc.start);
  const xs = [arc.start[0], arc.end[0]];
  const ys = [arc.start[1], arc.end[1]];
  for (const [theta, cx, cy] of AXIS_CROSSINGS) {
    const along = normalizeAngle(arc.direction === 'ccw' ? theta - a0 : a0 - theta);
    if (along <= sweep) {
      xs.push(arc.center[0] + r * cx);
      ys.push(arc.center[1] + r * cy);
    }
  }
  return {
    min: [Math.min(...xs), Math.min(...ys), Math.min(arc.start[2], arc.end[2])],
    max: [Math.max(...xs), Math.max(...ys), Math.max(arc.start[2], arc.end[2])],
  };
}
