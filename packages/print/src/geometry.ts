// Small vector, rotation and polygon helpers for the print checks. Everything is float64; mesh
// input arrives as float32 (`MeshData`) and is widened on read.
//
// Rotations are unit quaternions [x, y, z, w], as in the kernel's `Placement` and the assembly
// solver's `Pose`. A placement maps body coordinates to bed coordinates: p_bed = R p + t.

import type { Placement, Vec2, Vec3 } from '@manufakture/kernel';

export type { Placement, Vec2, Vec3 };

/** A unit quaternion, [x, y, z, w]. */
export type Quat = readonly [number, number, number, number];

/** A 3x3 rotation matrix, row-major. */
export type Mat3 = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

export const IDENTITY_QUAT: Quat = [0, 0, 0, 1];

export const IDENTITY_PLACEMENT: Placement = { translation: [0, 0, 0], rotation: IDENTITY_QUAT };

export function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

export function length(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2]);
}

/** `a` scaled to unit length, or null for a zero (or non-finite) vector. */
export function normalize(a: Vec3): Vec3 | null {
  const l = length(a);
  if (!(l > 0) || !Number.isFinite(l)) return null;
  return [a[0] / l, a[1] / l, a[2] / l];
}

/** The rotation by `angle` radians about `axis` (any length but zero), right-handed. */
export function quatFromAxisAngle(axis: Vec3, angle: number): Quat {
  const n = normalize(axis);
  if (!n) return IDENTITY_QUAT;
  const s = Math.sin(angle / 2);
  return [n[0] * s, n[1] * s, n[2] * s, Math.cos(angle / 2)];
}

/** a * b: the rotation b, then a. */
export function quatMultiply(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

/** The rotation matrix of a quaternion, normalised first (a zero quaternion is the identity). */
export function quatToMatrix(q: Quat): Mat3 {
  const l = Math.hypot(q[0], q[1], q[2], q[3]);
  if (!(l > 0)) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const x = q[0] / l,
    y = q[1] / l,
    z = q[2] / l,
    w = q[3] / l;
  return [
    1 - 2 * (y * y + z * z),
    2 * (x * y - z * w),
    2 * (x * z + y * w),
    2 * (x * y + z * w),
    1 - 2 * (x * x + z * z),
    2 * (y * z - x * w),
    2 * (x * z - y * w),
    2 * (y * z + x * w),
    1 - 2 * (x * x + y * y),
  ];
}

export function mulMat3Vec3(m: Mat3, v: Vec3): Vec3 {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

/** The rotation matrix of a placement (row-major), for callers that want a 3x4 matrix. */
export function placementMatrix(p: Placement): Mat3 {
  return quatToMatrix(p.rotation);
}

/** A point in body coordinates, placed: R p + t. */
export function applyPlacement(p: Placement, point: Vec3): Vec3 {
  const r = mulMat3Vec3(quatToMatrix(p.rotation), point);
  return [r[0] + p.translation[0], r[1] + p.translation[1], r[2] + p.translation[2]];
}

/** A direction (a normal, say) in body coordinates, rotated: R d. Translation does not apply. */
export function rotateDirection(p: Placement, direction: Vec3): Vec3 {
  return mulMat3Vec3(quatToMatrix(p.rotation), direction);
}

// Polygons -------------------------------------------------------------------
//
// Bed polygons are convex and counter-clockwise seen from above (+z), the way OrcaSlicer's
// printable areas are listed. The functions below rely on convexity; `isConvexCcw` checks it.

/** Twice the signed area: positive for a counter-clockwise polygon. */
export function signedArea2(polygon: readonly Vec2[]): number {
  let s = 0;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i]!;
    const b = polygon[(i + 1) % polygon.length]!;
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s;
}

/** True when the polygon is convex, counter-clockwise and has a positive area. */
export function isConvexCcw(polygon: readonly Vec2[]): boolean {
  if (polygon.length < 3 || !(signedArea2(polygon) > 0)) return false;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i]!;
    const b = polygon[(i + 1) % polygon.length]!;
    const c = polygon[(i + 2) % polygon.length]!;
    const turn = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (turn < 0) return false;
  }
  return true;
}

export interface Bounds2 {
  min: Vec2;
  max: Vec2;
}

export function polygonBounds(polygon: readonly Vec2[]): Bounds2 {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const [x, y] of polygon) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  return { min: [x0, y0], max: [x1, y1] };
}

/** The rectangle as a counter-clockwise polygon. */
export function rectangle(min: Vec2, max: Vec2): Vec2[] {
  return [
    [min[0], min[1]],
    [max[0], min[1]],
    [max[0], max[1]],
    [min[0], max[1]],
  ];
}

/**
 * The intersection of two convex counter-clockwise polygons (Sutherland-Hodgman clipping of
 * `subject` by `clip`). Empty when they do not overlap with a positive area.
 */
export function intersectConvex(subject: readonly Vec2[], clip: readonly Vec2[]): Vec2[] {
  let out: Vec2[] = [...subject];
  for (let i = 0; i < clip.length && out.length > 0; i++) {
    const a = clip[i]!;
    const b = clip[(i + 1) % clip.length]!;
    const side = (p: Vec2) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
    const input = out;
    out = [];
    for (let j = 0; j < input.length; j++) {
      const p = input[j]!;
      const q = input[(j + 1) % input.length]!;
      const sp = side(p);
      const sq = side(q);
      if (sp >= 0) out.push(p);
      if (sp >= 0 !== sq >= 0) {
        const t = sp / (sp - sq);
        out.push([p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])]);
      }
    }
  }
  return out.length >= 3 && signedArea2(out) > 0 ? out : [];
}

/**
 * How far `point` lies outside the convex counter-clockwise polygon: the largest distance past
 * any edge line, 0 or negative inside.
 */
export function outsideDistance(polygon: readonly Vec2[], point: Vec2): number {
  let worst = -Infinity;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i]!;
    const b = polygon[(i + 1) % polygon.length]!;
    const ex = b[0] - a[0];
    const ey = b[1] - a[1];
    const l = Math.hypot(ex, ey);
    if (!(l > 0)) continue;
    // Outward normal of a counter-clockwise edge is (ey, -ex) / l.
    const d = (ey * (point[0] - a[0]) - ex * (point[1] - a[1])) / l;
    worst = Math.max(worst, d);
  }
  return worst;
}

/**
 * How deep two convex polygons overlap: the smallest penetration over the separating axes (edge
 * normals of both). 0 or negative when they are apart or only touch.
 */
export function overlapDepth(a: readonly Vec2[], b: readonly Vec2[]): number {
  let depth = Infinity;
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i]!;
      const q = poly[(i + 1) % poly.length]!;
      const nx = q[1] - p[1];
      const ny = p[0] - q[0];
      const l = Math.hypot(nx, ny);
      if (!(l > 0)) continue;
      const [a0, a1] = project(a, nx / l, ny / l);
      const [b0, b1] = project(b, nx / l, ny / l);
      depth = Math.min(depth, Math.min(a1, b1) - Math.max(a0, b0));
    }
  }
  return depth;
}

function project(poly: readonly Vec2[], nx: number, ny: number): [number, number] {
  let lo = Infinity,
    hi = -Infinity;
  for (const [x, y] of poly) {
    const d = x * nx + y * ny;
    lo = Math.min(lo, d);
    hi = Math.max(hi, d);
  }
  return [lo, hi];
}
