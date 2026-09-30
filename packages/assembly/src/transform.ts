// Rigid transforms: a unit quaternion and a translation.
//
// Two layers. The public one works on plain `Pose` objects and allocates, for
// callers and tests. The internal one works on poses packed seven numbers at a
// time into a Float64Array ([tx, ty, tz, qx, qy, qz, qw] at an offset), so the
// solver's inner loops allocate nothing. Every packed function reads all of its
// inputs before it writes its output, so `out` may alias an input.
//
// Conventions: a pose maps local coordinates to world coordinates, p_world =
// R p_local + t. `compose(a, b)` is a then b in the local frame of a, so
// compose(a, b) applied to p is a(b(p)). Quaternions are [x, y, z, w].

export type Vec3 = readonly [number, number, number];
/** A unit quaternion, [x, y, z, w] (the order three.js uses). */
export type Quat = readonly [number, number, number, number];

export interface Pose {
  translation: Vec3;
  rotation: Quat;
}

/** A twist in se(3): [rho_x, rho_y, rho_z, phi_x, phi_y, phi_z], translation part first. */
export type Twist = readonly [number, number, number, number, number, number];

/** Numbers per packed pose. */
export const POSE = 7;

// Packed poses ---------------------------------------------------------------

export function setIdentity(out: Float64Array, o: number): void {
  out[o] = 0;
  out[o + 1] = 0;
  out[o + 2] = 0;
  out[o + 3] = 0;
  out[o + 4] = 0;
  out[o + 5] = 0;
  out[o + 6] = 1;
}

export function copyPose(out: Float64Array, o: number, a: Float64Array, ao: number): void {
  for (let k = 0; k < POSE; k++) out[o + k] = a[ao + k]!;
}

/** out = a * b. */
export function mul(
  out: Float64Array,
  o: number,
  a: Float64Array,
  ao: number,
  b: Float64Array,
  bo: number,
): void {
  const atx = a[ao]!,
    aty = a[ao + 1]!,
    atz = a[ao + 2]!;
  const ax = a[ao + 3]!,
    ay = a[ao + 4]!,
    az = a[ao + 5]!,
    aw = a[ao + 6]!;
  const btx = b[bo]!,
    bty = b[bo + 1]!,
    btz = b[bo + 2]!;
  const bx = b[bo + 3]!,
    by = b[bo + 4]!,
    bz = b[bo + 5]!,
    bw = b[bo + 6]!;
  // t = ta + Ra tb, with v' = v + 2w (u x v) + 2 u x (u x v).
  const cx = ay * btz - az * bty,
    cy = az * btx - ax * btz,
    cz = ax * bty - ay * btx;
  const ddx = ay * cz - az * cy,
    ddy = az * cx - ax * cz,
    ddz = ax * cy - ay * cx;
  out[o] = atx + btx + 2 * (aw * cx + ddx);
  out[o + 1] = aty + bty + 2 * (aw * cy + ddy);
  out[o + 2] = atz + btz + 2 * (aw * cz + ddz);
  out[o + 3] = aw * bx + ax * bw + ay * bz - az * by;
  out[o + 4] = aw * by - ax * bz + ay * bw + az * bx;
  out[o + 5] = aw * bz + ax * by - ay * bx + az * bw;
  out[o + 6] = aw * bw - ax * bx - ay * by - az * bz;
}

/** out = a^-1. */
export function inv(out: Float64Array, o: number, a: Float64Array, ao: number): void {
  const tx = a[ao]!,
    ty = a[ao + 1]!,
    tz = a[ao + 2]!;
  const x = -a[ao + 3]!,
    y = -a[ao + 4]!,
    z = -a[ao + 5]!,
    w = a[ao + 6]!;
  // t' = -(R^-1 t), rotating by the conjugate.
  const cx = y * tz - z * ty,
    cy = z * tx - x * tz,
    cz = x * ty - y * tx;
  const ddx = y * cz - z * cy,
    ddy = z * cx - x * cz,
    ddz = x * cy - y * cx;
  out[o] = -(tx + 2 * (w * cx + ddx));
  out[o + 1] = -(ty + 2 * (w * cy + ddy));
  out[o + 2] = -(tz + 2 * (w * cz + ddz));
  out[o + 3] = x;
  out[o + 4] = y;
  out[o + 5] = z;
  out[o + 6] = w;
}

/** out = a^-1 * b. */
export function mulInv(
  out: Float64Array,
  o: number,
  a: Float64Array,
  ao: number,
  b: Float64Array,
  bo: number,
): void {
  inv(SCRATCH, 0, a, ao);
  mul(out, o, SCRATCH, 0, b, bo);
}

const SCRATCH = new Float64Array(POSE);

/** Rotates the vector at v[vo..vo+2] by the pose's rotation, into out[oo..oo+2]. */
export function rotateVec(
  out: Float64Array,
  oo: number,
  p: Float64Array,
  po: number,
  vx: number,
  vy: number,
  vz: number,
): void {
  const x = p[po + 3]!,
    y = p[po + 4]!,
    z = p[po + 5]!,
    w = p[po + 6]!;
  const cx = y * vz - z * vy,
    cy = z * vx - x * vz,
    cz = x * vy - y * vx;
  out[oo] = vx + 2 * (w * cx + y * cz - z * cy);
  out[oo + 1] = vy + 2 * (w * cy + z * cx - x * cz);
  out[oo + 2] = vz + 2 * (w * cz + x * cy - y * cx);
}

/** Normalises the quaternion part in place; returns its norm before (0 if degenerate). */
export function normalizeRotation(a: Float64Array, o: number): number {
  const n = Math.hypot(a[o + 3]!, a[o + 4]!, a[o + 5]!, a[o + 6]!);
  if (!(n > 0) || !Number.isFinite(n)) return 0;
  a[o + 3] = a[o + 3]! / n;
  a[o + 4] = a[o + 4]! / n;
  a[o + 5] = a[o + 5]! / n;
  a[o + 6] = a[o + 6]! / n;
  return n;
}

/**
 * The rotation vector of the quaternion at q[o+3..o+6] (the so(3) log), into out[oo..oo+2].
 * The shorter way round: the angle is in [0, pi].
 */
export function rotationLog(out: Float64Array, oo: number, q: Float64Array, o: number): void {
  let x = q[o + 3]!,
    y = q[o + 4]!,
    z = q[o + 5]!,
    w = q[o + 6]!;
  if (w < 0) {
    x = -x;
    y = -y;
    z = -z;
    w = -w;
  }
  const s = Math.hypot(x, y, z);
  // phi = v * theta / sin(theta / 2), theta = 2 atan2(s, w); as s -> 0 the factor is 2 / w.
  const f = s < 1e-8 ? (2 / w) * (1 - (s * s) / (3 * w * w)) : (2 * Math.atan2(s, w)) / s;
  out[oo] = x * f;
  out[oo + 1] = y * f;
  out[oo + 2] = z * f;
}

/** The quaternion of the rotation vector (the so(3) exp), into out[o+3..o+6]. */
export function rotationExp(
  out: Float64Array,
  o: number,
  px: number,
  py: number,
  pz: number,
): void {
  const t2 = px * px + py * py + pz * pz;
  const t = Math.sqrt(t2);
  // sin(theta / 2) / theta, with its series near 0.
  const f = t < 1e-6 ? 0.5 - t2 / 48 : Math.sin(t / 2) / t;
  out[o + 3] = px * f;
  out[o + 4] = py * f;
  out[o + 5] = pz * f;
  out[o + 6] = Math.cos(t / 2);
}

/**
 * The coefficient b(theta) in V^-1 = I - 1/2 [phi]x + b [phi]x^2, where V is the left
 * Jacobian of SO(3) (also the translation matrix of the SE(3) exp). Finite up to pi.
 */
export function leftJacobianInverseCoefficient(theta: number): number {
  if (theta < 1e-4) return 1 / 12 + (theta * theta) / 720;
  if (theta > Math.PI - 1e-6) theta = Math.PI - 1e-6;
  return 1 / (theta * theta) - (1 + Math.cos(theta)) / (2 * theta * Math.sin(theta));
}

/**
 * out = V^-1(phi) v, the inverse left Jacobian of SO(3) at phi applied to v. With -phi it is
 * the inverse right Jacobian.
 */
export function applyLeftJacobianInverse(
  out: Float64Array,
  oo: number,
  px: number,
  py: number,
  pz: number,
  vx: number,
  vy: number,
  vz: number,
): void {
  const t = Math.sqrt(px * px + py * py + pz * pz);
  const b = leftJacobianInverseCoefficient(t);
  // [phi]x v and [phi]x^2 v.
  const cx = py * vz - pz * vy,
    cy = pz * vx - px * vz,
    cz = px * vy - py * vx;
  const ddx = py * cz - pz * cy,
    ddy = pz * cx - px * cz,
    ddz = px * cy - py * cx;
  out[oo] = vx - 0.5 * cx + b * ddx;
  out[oo + 1] = vy - 0.5 * cy + b * ddy;
  out[oo + 2] = vz - 0.5 * cz + b * ddz;
}

// Public, allocating API -------------------------------------------------------

export const IDENTITY: Pose = Object.freeze({
  translation: Object.freeze([0, 0, 0]) as unknown as Vec3,
  rotation: Object.freeze([0, 0, 0, 1]) as unknown as Quat,
});

export function pose(translation: Vec3, rotation: Quat = [0, 0, 0, 1]): Pose {
  return { translation, rotation };
}

export function packPose(out: Float64Array, o: number, p: Pose): void {
  out[o] = p.translation[0];
  out[o + 1] = p.translation[1];
  out[o + 2] = p.translation[2];
  out[o + 3] = p.rotation[0];
  out[o + 4] = p.rotation[1];
  out[o + 5] = p.rotation[2];
  out[o + 6] = p.rotation[3];
}

export function unpackPose(a: Float64Array, o: number): Pose {
  return {
    translation: [a[o]!, a[o + 1]!, a[o + 2]!],
    rotation: [a[o + 3]!, a[o + 4]!, a[o + 5]!, a[o + 6]!],
  };
}

function packed(p: Pose): Float64Array {
  const a = new Float64Array(POSE);
  packPose(a, 0, p);
  return a;
}

/** a * b: first b, then a. */
export function compose(a: Pose, b: Pose): Pose {
  const out = new Float64Array(POSE);
  mul(out, 0, packed(a), 0, packed(b), 0);
  return unpackPose(out, 0);
}

export function invert(a: Pose): Pose {
  const out = new Float64Array(POSE);
  inv(out, 0, packed(a), 0);
  return unpackPose(out, 0);
}

export function transformPoint(p: Pose, v: Vec3): Vec3 {
  const out = new Float64Array(3);
  rotateVec(out, 0, packed(p), 0, v[0], v[1], v[2]);
  return [out[0]! + p.translation[0], out[1]! + p.translation[1], out[2]! + p.translation[2]];
}

export function rotateVector(q: Quat, v: Vec3): Vec3 {
  const out = new Float64Array(3);
  rotateVec(out, 0, packed({ translation: [0, 0, 0], rotation: q }), 0, v[0], v[1], v[2]);
  return [out[0]!, out[1]!, out[2]!];
}

/** The quaternion rotating by `angle` radians about `axis` (normalised here). */
export function quatFromAxisAngle(axis: Vec3, angle: number): Quat {
  const n = Math.hypot(axis[0], axis[1], axis[2]);
  const s = Math.sin(angle / 2) / n;
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(angle / 2)];
}

export function quatFromRotationVector(v: Vec3): Quat {
  const out = new Float64Array(POSE);
  rotationExp(out, 0, v[0], v[1], v[2]);
  return [out[3]!, out[4]!, out[5]!, out[6]!];
}

export function rotationVector(q: Quat): Vec3 {
  const a = packed({ translation: [0, 0, 0], rotation: q });
  const out = new Float64Array(3);
  rotationLog(out, 0, a, 0);
  return [out[0]!, out[1]!, out[2]!];
}

/** The SE(3) exp of a twist [rho; phi]: R = exp(phi), t = V(phi) rho. */
export function exp(xi: Twist): Pose {
  const [rx, ry, rz, px, py, pz] = xi;
  const t2 = px * px + py * py + pz * pz;
  const t = Math.sqrt(t2);
  // V = I + a [phi]x + b [phi]x^2.
  const a = t < 1e-4 ? 0.5 - t2 / 24 : (1 - Math.cos(t)) / t2;
  const b = t < 1e-4 ? 1 / 6 - t2 / 120 : (t - Math.sin(t)) / (t2 * t);
  const cx = py * rz - pz * ry,
    cy = pz * rx - px * rz,
    cz = px * ry - py * rx;
  const ddx = py * cz - pz * cy,
    ddy = pz * cx - px * cz,
    ddz = px * cy - py * cx;
  return {
    translation: [rx + a * cx + b * ddx, ry + a * cy + b * ddy, rz + a * cz + b * ddz],
    rotation: quatFromRotationVector([px, py, pz]),
  };
}

/** The SE(3) log: the twist whose exp is `p`, with the rotation angle in [0, pi]. */
export function log(p: Pose): Twist {
  const [px, py, pz] = rotationVector(p.rotation);
  const out = new Float64Array(3);
  const [tx, ty, tz] = p.translation;
  applyLeftJacobianInverse(out, 0, px, py, pz, tx, ty, tz);
  return [out[0]!, out[1]!, out[2]!, px, py, pz];
}
