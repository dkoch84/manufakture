// The rigid transform a print item's orientation stands for (plan T3.1b; `PrintItem.orientation`
// in core). Core stores expressions; the caller evaluates them, so angles arrive here as numbers
// in radians, and a lay-flat face arrives as its outward normal (`FaceInfo.normal` from the
// kernel's topology, exact from the B-rep).
//
// Every orientation ends with the body dropped onto the bed: translated along z so its lowest
// point is at z = 0, as a slicer does on import. x and y are left alone; placing the body on the
// bed is the caller's (and the slicer's) business.

import {
  IDENTITY_QUAT,
  normalize,
  quatFromAxisAngle,
  quatMultiply,
  quatToMatrix,
  type Placement,
  type Quat,
  type Vec3,
} from './geometry';

export type Orientation =
  /** The body as modelled: no rotation. */
  | { kind: 'asModelled' }
  /**
   * The planar face with this outward normal faces down onto the bed, then the body turns by
   * `turn` radians about the bed's z axis (default 0).
   */
  | { kind: 'layFlat'; normal: Vec3; turn?: number }
  /**
   * Rotations in radians about the bed's fixed x, y and z axes, applied in that order: first x,
   * then y, then z (extrinsic x-y-z, so the matrix is Rz * Ry * Rx).
   */
  | { kind: 'rotate'; x: number; y: number; z: number };

/**
 * The rotation that turns `normal` to -z, the bed's down direction: the shortest one, about the
 * horizontal axis normal x (-z). A normal already pointing down needs none; one pointing straight
 * up turns half a revolution about x. A zero normal gives the identity.
 */
export function layFlatRotation(normal: Vec3): Quat {
  const n = normalize(normal);
  if (!n) return IDENTITY_QUAT;
  const horizontal = Math.hypot(n[0], n[1]);
  if (horizontal === 0) return n[2] < 0 ? IDENTITY_QUAT : quatFromAxisAngle([1, 0, 0], Math.PI);
  // n x (0, 0, -1) = (-ny, nx, 0); the angle between n and -z, accurate near 0 and pi.
  return quatFromAxisAngle([-n[1], n[0], 0], Math.atan2(horizontal, -n[2]));
}

/** Rotation about the bed's x, then y, then z axis (radians). */
export function eulerRotation(x: number, y: number, z: number): Quat {
  const qx = quatFromAxisAngle([1, 0, 0], x);
  const qy = quatFromAxisAngle([0, 1, 0], y);
  const qz = quatFromAxisAngle([0, 0, 1], z);
  return quatMultiply(qz, quatMultiply(qy, qx));
}

/** The rotation part of an orientation, without the drop onto the bed. */
export function orientationRotation(orientation: Orientation): Quat {
  switch (orientation.kind) {
    case 'asModelled':
      return IDENTITY_QUAT;
    case 'layFlat':
      return quatMultiply(
        quatFromAxisAngle([0, 0, 1], orientation.turn ?? 0),
        layFlatRotation(orientation.normal),
      );
    case 'rotate':
      return eulerRotation(orientation.x, orientation.y, orientation.z);
  }
}

/**
 * The lowest z of the points (xyz triples, a mesh's `positions`), after `rotation`. Infinity
 * when there are no points.
 */
export function lowestZ(
  positions: ArrayLike<number> | readonly ArrayLike<number>[],
  rotation: Quat = IDENTITY_QUAT,
): number {
  const m = quatToMatrix(rotation);
  let lowest = Infinity;
  for (const p of meshList(positions)) {
    for (let i = 0; i + 2 < p.length; i += 3) {
      const z = m[6] * p[i]! + m[7] * p[i + 1]! + m[8] * p[i + 2]!;
      if (z < lowest) lowest = z;
    }
  }
  return lowest;
}

/**
 * The placement an orientation stands for: its rotation, then a translation along z that puts
 * the lowest of `positions` (all the meshes printed as one item) at z = 0. With no points the
 * translation is zero.
 */
export function orientationPlacement(
  orientation: Orientation,
  positions: ArrayLike<number> | readonly ArrayLike<number>[],
): Placement {
  const rotation = orientationRotation(orientation);
  const low = lowestZ(positions, rotation);
  return { rotation, translation: [0, 0, Number.isFinite(low) ? 0 - low : 0] };
}

function meshList(
  positions: ArrayLike<number> | readonly ArrayLike<number>[],
): ArrayLike<number>[] {
  if (positions.length === 0) return [];
  return typeof (positions as ArrayLike<unknown>)[0] === 'number'
    ? [positions as ArrayLike<number>]
    : [...(positions as readonly ArrayLike<number>[])];
}
