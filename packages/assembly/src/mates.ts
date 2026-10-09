// Mate kinds as relative transforms of their free coordinates.
//
// A mate holds connector b's frame, relative to connector a's frame (after the offset), at
// J(q): the joint transform of the free coordinates q. With G the frame of connector a and
// the offset in world coordinates and X = G J(q), the mate is satisfied when X is connector
// b's frame in world coordinates.
//
//   fastened     J = I                         q = []
//   revolute     J = Rz(angle)                 q = [angle]
//   slider       J = T(0, 0, d)                q = [d]
//   planar       J = T(x, y, 0) Rz(angle)      q = [x, y, angle]
//   cylindrical  J = T(0, 0, d) Rz(angle)      q = [d, angle]
//   ball         J = R(exp(phi))               q = [phi_x, phi_y, phi_z]
//
// Every coordinate but a ball's is additive. A ball's is a rotation vector updated by a
// left increment in G's frame, which keeps its tangent directions G's axes everywhere.

import type { MateKind, MateLimits } from './model';
import { POSE, rotationExp, rotationLog, rotateVec } from './transform';

export const MATE_KINDS: readonly MateKind[] = [
  'fastened',
  'revolute',
  'slider',
  'planar',
  'cylindrical',
  'ball',
];

export function coordinateCount(kind: MateKind): number {
  switch (kind) {
    case 'fastened':
      return 0;
    case 'revolute':
    case 'slider':
      return 1;
    case 'cylindrical':
      return 2;
    case 'planar':
    case 'ball':
      return 3;
  }
}

/**
 * The names of a kind's free coordinates, in the order `MateReport.coordinates` holds them: a
 * revolute's angle, a slider's distance, a planar's x, y and angle, a cylindrical's distance and
 * angle, a ball's rotation vector x, y and z.
 */
export function coordinateNames(kind: MateKind): readonly string[] {
  switch (kind) {
    case 'fastened':
      return [];
    case 'revolute':
      return ['angle'];
    case 'slider':
      return ['distance'];
    case 'planar':
      return ['x', 'y', 'angle'];
    case 'cylindrical':
      return ['distance', 'angle'];
    case 'ball':
      return ['x', 'y', 'z'];
  }
}

/** Whether a kind takes limits on its coordinate: revolute (radians) and slider (mm). */
export function hasLimits(kind: MateKind): boolean {
  return kind === 'revolute' || kind === 'slider';
}

/** A coordinate past one of its mate's limits. */
export interface LimitViolation {
  bound: 'min' | 'max';
  /** The limit passed. */
  limit: number;
  /** The coordinate. */
  value: number;
}

/**
 * Where a revolute's or slider's coordinate lies against its limits: null within them (or
 * within `tolerance` of them, in the coordinate's unit), else the limit it passes. A bound left
 * out does not limit. The same test the solver clamps and warns by, for callers that check a
 * value of their own (a pose they are about to try, a sweep over a mate's travel).
 */
export function limitViolation(
  value: number,
  limits: MateLimits | undefined,
  tolerance = 0,
): LimitViolation | null {
  if (limits === undefined) return null;
  if (limits.min !== undefined && value < limits.min - tolerance) {
    return { bound: 'min', limit: limits.min, value };
  }
  if (limits.max !== undefined && value > limits.max + tolerance) {
    return { bound: 'max', limit: limits.max, value };
  }
  return null;
}

/** The value held within the limits (a bound left out does not limit). */
export function clampToLimits(value: number, limits: MateLimits | undefined): number {
  if (limits === undefined) return value;
  if (limits.min !== undefined && value < limits.min) return limits.min;
  if (limits.max !== undefined && value > limits.max) return limits.max;
  return value;
}

/** Whether coordinate `k` of the kind is an angle (radians) rather than a length (mm). */
export function isAngular(kind: MateKind, k: number): boolean {
  switch (kind) {
    case 'fastened':
    case 'slider':
      return false;
    case 'revolute':
    case 'ball':
      return true;
    case 'planar':
      return k === 2;
    case 'cylindrical':
      return k === 1;
  }
}

/** Writes J(q) (q at q[qo..]) into out[o..o+6]. */
export function jointTransform(
  kind: MateKind,
  q: Float64Array,
  qo: number,
  out: Float64Array,
  o: number,
): void {
  out[o] = 0;
  out[o + 1] = 0;
  out[o + 2] = 0;
  out[o + 3] = 0;
  out[o + 4] = 0;
  out[o + 5] = 0;
  out[o + 6] = 1;
  switch (kind) {
    case 'fastened':
      return;
    case 'revolute':
      setRz(out, o, q[qo]!);
      return;
    case 'slider':
      out[o + 2] = q[qo]!;
      return;
    case 'planar':
      out[o] = q[qo]!;
      out[o + 1] = q[qo + 1]!;
      setRz(out, o, q[qo + 2]!);
      return;
    case 'cylindrical':
      out[o + 2] = q[qo]!;
      setRz(out, o, q[qo + 1]!);
      return;
    case 'ball':
      rotationExp(out, o, q[qo]!, q[qo + 1]!, q[qo + 2]!);
      return;
  }
}

function setRz(out: Float64Array, o: number, angle: number): void {
  out[o + 5] = Math.sin(angle / 2);
  out[o + 6] = Math.cos(angle / 2);
}

/** Wraps an angle into (-pi, pi]. */
export function wrapAngle(a: number): number {
  const t = 2 * Math.PI;
  a = a - t * Math.floor((a + Math.PI) / t);
  return a <= -Math.PI ? a + t : a;
}

/** The angle about z of the twist-swing split of the rotation at rel[o+3..o+6]. */
function twistAboutZ(rel: Float64Array, o: number): number {
  const z = rel[o + 5]!,
    w = rel[o + 6]!;
  if (z === 0 && w === 0) return 0;
  return wrapAngle(2 * Math.atan2(z, w));
}

/**
 * The coordinates of the joint transform nearest the measured relative transform `rel`
 * (connector b relative to connector a after the offset), into q[qo..]. Exact when rel is
 * a joint transform of the kind; otherwise the projection that drops the constrained
 * components (the tilt of a revolute, the sideways part of a slider).
 */
export function extractCoordinates(
  kind: MateKind,
  rel: Float64Array,
  o: number,
  q: Float64Array,
  qo: number,
): void {
  switch (kind) {
    case 'fastened':
      return;
    case 'revolute':
      q[qo] = twistAboutZ(rel, o);
      return;
    case 'slider':
      q[qo] = rel[o + 2]!;
      return;
    case 'planar':
      q[qo] = rel[o]!;
      q[qo + 1] = rel[o + 1]!;
      q[qo + 2] = twistAboutZ(rel, o);
      return;
    case 'cylindrical':
      q[qo] = rel[o + 2]!;
      q[qo + 1] = twistAboutZ(rel, o);
      return;
    case 'ball':
      rotationLog(q, qo, rel, o);
      return;
  }
}

const BALL = new Float64Array(POSE);
const STEP = new Float64Array(POSE);

/** q <- q (+) delta: additive except a ball's rotation vector, which composes on the left. */
export function retract(
  kind: MateKind,
  q: Float64Array,
  qo: number,
  delta: Float64Array,
  d: number,
): void {
  if (kind !== 'ball') {
    const n = coordinateCount(kind);
    for (let k = 0; k < n; k++) q[qo + k] = q[qo + k]! + delta[d + k]!;
    return;
  }
  rotationExp(BALL, 0, q[qo]!, q[qo + 1]!, q[qo + 2]!);
  rotationExp(STEP, 0, delta[d]!, delta[d + 1]!, delta[d + 2]!);
  // exp(delta) * exp(q), quaternion product only.
  const ax = STEP[3]!,
    ay = STEP[4]!,
    az = STEP[5]!,
    aw = STEP[6]!;
  const bx = BALL[3]!,
    by = BALL[4]!,
    bz = BALL[5]!,
    bw = BALL[6]!;
  BALL[3] = aw * bx + ax * bw + ay * bz - az * by;
  BALL[4] = aw * by - ax * bz + ay * bw + az * bx;
  BALL[5] = aw * bz + ax * by - ay * bx + az * bw;
  BALL[6] = aw * bw - ax * bx - ay * by - az * bz;
  rotationLog(q, qo, BALL, 0);
}

/**
 * The world twist of coordinate k: the instantaneous motion of connector b's side relative to
 * connector a's side per unit of the coordinate, as an angular velocity w and the velocity v0
 * of the point at the world origin (a point p moves by w x p + v0). Written to out[o..o+5] as
 * [wx, wy, wz, v0x, v0y, v0z]. G and X are the joint's world frames before and after J(q).
 */
export function coordinateTwist(
  kind: MateKind,
  k: number,
  g: Float64Array,
  go: number,
  x: Float64Array,
  xo: number,
  out: Float64Array,
  o: number,
): void {
  // Translations are along G's axes; rotations are about X's origin (G's for a ball, the same
  // point since a ball does not translate), and about X's z (= G's z) for the others.
  let rotational: boolean;
  let axis: number; // 0, 1, 2: x, y, z of G
  switch (kind) {
    case 'fastened':
      rotational = false;
      axis = 2;
      break;
    case 'revolute':
      rotational = true;
      axis = 2;
      break;
    case 'slider':
      rotational = false;
      axis = 2;
      break;
    case 'planar':
      rotational = k === 2;
      axis = k === 2 ? 2 : k;
      break;
    case 'cylindrical':
      rotational = k === 1;
      axis = 2;
      break;
    case 'ball':
      rotational = true;
      axis = k;
      break;
  }
  rotateVec(out, o, g, go, axis === 0 ? 1 : 0, axis === 1 ? 1 : 0, axis === 2 ? 1 : 0);
  if (rotational) {
    const wx = out[o]!,
      wy = out[o + 1]!,
      wz = out[o + 2]!;
    const cx = x[xo]!,
      cy = x[xo + 1]!,
      cz = x[xo + 2]!;
    // v0 = -(w x c).
    out[o + 3] = -(wy * cz - wz * cy);
    out[o + 4] = -(wz * cx - wx * cz);
    out[o + 5] = -(wx * cy - wy * cx);
  } else {
    out[o + 3] = out[o]!;
    out[o + 4] = out[o + 1]!;
    out[o + 5] = out[o + 2]!;
    out[o] = 0;
    out[o + 1] = 0;
    out[o + 2] = 0;
  }
}
