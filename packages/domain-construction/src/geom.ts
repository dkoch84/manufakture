// Small vector helpers for member placements. Plain tuples, no classes, so member data stays
// structured-cloneable between the regen worker and the main thread.

export type Vec2 = readonly [number, number];
export type Vec3 = readonly [number, number, number];

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

/**
 * A half-space: every point with `dot(n, p) >= k`. `n` is a unit vector pointing into the
 * removed side when the plane is a cut.
 */
export interface Plane {
  readonly n: Vec3;
  readonly k: number;
}

/**
 * Where a member sits: its blank is `origin + a x + b y + c z` for `a` in [0, length], `b` in
 * [0, stock width], `c` in [0, stock depth], with `z = x cross y`. The axes are orthonormal and
 * right-handed: a rotation and a translation, never a mirror (T6.5a: a mirrored member is a
 * different shape).
 */
export interface Placement {
  readonly origin: Vec3;
  readonly x: Vec3;
  readonly y: Vec3;
}

export function zAxis(p: Placement): Vec3 {
  return cross(p.x, p.y);
}

/** A point in the member's local frame, in world coordinates. */
export function toWorld(p: Placement, l: Vec3): Vec3 {
  const z = zAxis(p);
  return [
    p.origin[0] + l[0] * p.x[0] + l[1] * p.y[0] + l[2] * z[0],
    p.origin[1] + l[0] * p.x[1] + l[1] * p.y[1] + l[2] * z[1],
    p.origin[2] + l[0] * p.x[2] + l[1] * p.y[2] + l[2] * z[2],
  ];
}

/** A world point in the member's local frame. */
export function toLocal(p: Placement, point: Vec3): Vec3 {
  const d = sub(point, p.origin);
  return [dot(d, p.x), dot(d, p.y), dot(d, zAxis(p))];
}

/** Column-major 4x4 matrix of a placement (three.js `Matrix4.elements` order). */
export function placementMatrix(p: Placement): number[] {
  const z = zAxis(p);
  const o = p.origin;
  return [
    p.x[0],
    p.x[1],
    p.x[2],
    0,
    p.y[0],
    p.y[1],
    p.y[2],
    0,
    z[0],
    z[1],
    z[2],
    0,
    o[0],
    o[1],
    o[2],
    1,
  ];
}
