// Small vector helpers for the framing spike. Plain tuples, no classes, so the same code runs in
// Node and in the browser page.

export type Vec3 = [number, number, number];

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const length = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
export const normalize = (a: Vec3): Vec3 => scale(a, 1 / length(a));

/**
 * A half-space to remove: every point with `dot(n, p) >= k`. `n` is a unit vector pointing into
 * the removed side.
 */
export interface Plane {
  n: Vec3;
  k: number;
}

/**
 * A member's placement: its box is `origin + a x + b y + c z` for `a` in [0, length],
 * `b` in [0, width], `c` in [0, depth], with `z = x cross y`. The axes are orthonormal.
 */
export interface Placement {
  origin: Vec3;
  x: Vec3;
  y: Vec3;
}

export function zAxis(p: Placement): Vec3 {
  return cross(p.x, p.y);
}

/** A world point in the member's local coordinates. */
export function toLocal(p: Placement, point: Vec3): Vec3 {
  const d = sub(point, p.origin);
  return [dot(d, p.x), dot(d, p.y), dot(d, zAxis(p))];
}

/** A world plane in the member's local coordinates. */
export function planeToLocal(p: Placement, plane: Plane): Plane {
  const n: Vec3 = [dot(plane.n, p.x), dot(plane.n, p.y), dot(plane.n, zAxis(p))];
  // dot(n, origin + R l) >= k  <=>  dot(R^T n, l) >= k - dot(n, origin)
  return { n, k: plane.k - dot(plane.n, p.origin) };
}

/** Column-major 4x4 matrix (three.js `Matrix4.elements` order) of a placement. */
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

/** Transform a local point to world. */
export function toWorld(p: Placement, l: Vec3): Vec3 {
  const z = zAxis(p);
  return [
    p.origin[0] + l[0] * p.x[0] + l[1] * p.y[0] + l[2] * z[0],
    p.origin[1] + l[0] * p.x[1] + l[1] * p.y[1] + l[2] * z[1],
    p.origin[2] + l[0] * p.x[2] + l[1] * p.y[2] + l[2] * z[2],
  ];
}
