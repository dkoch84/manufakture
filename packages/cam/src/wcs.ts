// Work coordinate systems: from model space to machine coordinates (M5 plan, T5.1c). Machine
// coordinates follow the usual router convention: +X to the operator's right, +Y away from the
// operator (towards the back of the machine), +Z up, out of the stock towards the spindle.
//
// Two steps. `setupRotation` turns the model so the WCS up direction is +Z (the setup frame, in
// which the stock box lives); `wcsFrame` then moves the origin to the chosen point on the stock.

import { err, ok } from './types';
import type {
  Box3,
  CamResult,
  DrillPoint,
  Loop2,
  MachineDrillPoint,
  MachineLoops,
  PlanarLoops,
  Segment2,
  Stock,
  UpAxis,
  Vec2,
  Vec3,
  Wcs,
  WcsCorner,
  WcsFrame,
  WcsUp,
} from './types';
import { add, cross, dot, isFiniteVec, normalize, scale, sub } from './vec';

/** Largest angle, radians, by which a plane or axis may be off the setup's Z and still count. */
export const PARALLEL_TOLERANCE = 1e-6;

/** The setup frame's axes in model coordinates: orthonormal and right-handed. */
export interface SetupRotation {
  readonly xAxis: Vec3;
  readonly yAxis: Vec3;
  readonly zAxis: Vec3;
}

const AXES: Record<UpAxis, Vec3> = {
  '+x': [1, 0, 0],
  '-x': [-1, 0, 0],
  '+y': [0, 1, 0],
  '-y': [0, -1, 0],
  '+z': [0, 0, 1],
  '-z': [0, 0, -1],
};

/**
 * The rotation that makes the WCS up direction machine +Z. Without an explicit `xDir`, it is the
 * smallest rotation taking up to +Z (about the horizontal axis `up x Z`), and for up = -Z a half
 * turn about X. So for the model axes:
 *
 * | up | machine X | machine Y | machine Z |
 * | -- | --------- | --------- | --------- |
 * | +z | +x        | +y        | +z        |
 * | -z | +x        | -y        | -z        |
 * | +y | +x        | -z        | +y        |
 * | -y | +x        | +z        | -y        |
 * | +x | -z        | +y        | +x        |
 * | -x | +z        | +y        | -x        |
 */
export function setupRotation(up: WcsUp): CamResult<SetupRotation> {
  const raw = up.kind === 'axis' ? AXES[up.axis] : up.normal;
  const zAxis = isFiniteVec(raw) ? normalize(raw) : undefined;
  if (!zAxis) return err('invalid-input', 'The WCS up direction is not a valid direction.');
  let xAxis: Vec3 | undefined;
  if (up.kind === 'face' && up.xDir) {
    const x = up.xDir;
    xAxis = isFiniteVec(x) ? normalize(sub(x, scale(zAxis, dot(x, zAxis)))) : undefined;
    if (!xAxis) {
      return err('invalid-input', 'The WCS X direction is zero or parallel to the up direction.');
    }
  } else {
    xAxis = minimalRotationX(zAxis);
  }
  return ok({ xAxis, yAxis: cross(zAxis, xAxis), zAxis });
}

/** Machine X, in model coordinates, of the smallest rotation taking unit `n` to +Z. */
function minimalRotationX(n: Vec3): Vec3 {
  // R^T e_x, with R the rotation by theta about k = n x Z (Rodrigues).
  const k: Vec3 = [n[1], -n[0], 0];
  const s = Math.hypot(k[0], k[1]);
  const c = n[2];
  if (s < 1e-12) return [1, 0, 0]; // +Z: identity; -Z: half turn about X keeps X.
  const kh: Vec3 = [k[0] / s, k[1] / s, 0];
  const ex: Vec3 = [1, 0, 0];
  // R^T v = v cos - (k x v) sin + k (k . v)(1 - cos)
  return add(sub(scale(ex, c), scale(cross(kh, ex), s)), scale(kh, dot(kh, ex) * (1 - c)));
}

/** A model point or direction in the setup frame (rotation only, no origin). */
export function toSetup(rotation: SetupRotation, p: Vec3): Vec3 {
  return [dot(p, rotation.xAxis), dot(p, rotation.yAxis), dot(p, rotation.zAxis)];
}

/**
 * The bounds, in the setup frame, of a model-space box: the box of its eight corners. Exact for
 * the six axis ups (the rotation only permutes and flips axes); for a tilted face up it encloses
 * the body but may be loose, so pass the body's points to `pointsBoundsInSetup` for a tight box.
 */
export function boundsInSetup(rotation: SetupRotation, box: Box3): Box3 {
  const corners: Vec3[] = [];
  for (const x of [box.min[0], box.max[0]]) {
    for (const y of [box.min[1], box.max[1]]) {
      for (const z of [box.min[2], box.max[2]]) corners.push(toSetup(rotation, [x, y, z]));
    }
  }
  return boxOf(corners);
}

/** Tight bounds, in the setup frame, of xyz points (a mesh's `positions`). */
export function pointsBoundsInSetup(rotation: SetupRotation, positions: ArrayLike<number>): Box3 {
  const points: Vec3[] = [];
  for (let i = 0; i + 2 < positions.length; i += 3) {
    points.push(toSetup(rotation, [positions[i]!, positions[i + 1]!, positions[i + 2]!]));
  }
  return boxOf(points);
}

function boxOf(points: readonly Vec3[]): Box3 {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const p of points) {
    for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i]!, p[i]!);
      max[i] = Math.max(max[i]!, p[i]!);
    }
  }
  return { min: [min[0]!, min[1]!, min[2]!], max: [max[0]!, max[1]!, max[2]!] };
}

/** The WCS origin, in the setup frame, on a stock box. */
export function wcsOriginInSetup(stock: Stock, origin: Wcs['origin']): Vec3 {
  const xy = cornerXY(stock, origin.xy);
  return [xy[0], xy[1], origin.z === 'top' ? stock.max[2] : stock.min[2]];
}

function cornerXY(stock: Stock, corner: WcsCorner): Vec2 {
  const { min, max } = stock;
  switch (corner) {
    case 'front-left':
      return [min[0], min[1]];
    case 'front-right':
      return [max[0], min[1]];
    case 'back-left':
      return [min[0], max[1]];
    case 'back-right':
      return [max[0], max[1]];
    case 'centre':
      return [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2];
  }
}

/**
 * The resolved WCS: machine axes and origin in model coordinates, for a stock built in the same
 * setup frame (`setupRotation(wcs.up)`).
 */
export function wcsFrame(wcs: Wcs, stock: Stock): CamResult<WcsFrame> {
  const rotation = setupRotation(wcs.up);
  if (!rotation.ok) return rotation;
  const { xAxis, yAxis, zAxis } = rotation.value;
  const o = wcsOriginInSetup(stock, wcs.origin);
  const origin = add(add(scale(xAxis, o[0]), scale(yAxis, o[1])), scale(zAxis, o[2]));
  return ok({ origin, xAxis, yAxis, zAxis });
}

/** A model point in machine coordinates. */
export function toMachine(frame: WcsFrame, p: Vec3): Vec3 {
  const d = sub(p, frame.origin);
  return [dot(d, frame.xAxis), dot(d, frame.yAxis), dot(d, frame.zAxis)];
}

/** A model direction in machine coordinates (rotation only). */
export function directionToMachine(frame: WcsFrame, v: Vec3): Vec3 {
  return [dot(v, frame.xAxis), dot(v, frame.yAxis), dot(v, frame.zAxis)];
}

/** A machine point back in model coordinates. */
export function toModel(frame: WcsFrame, q: Vec3): Vec3 {
  return add(
    frame.origin,
    add(add(scale(frame.xAxis, q[0]), scale(frame.yAxis, q[1])), scale(frame.zAxis, q[2])),
  );
}

/**
 * Planar loops (model coordinates) in machine XY at their plane's machine Z. The plane must be
 * parallel to the machine XY plane within `tolerance` radians, facing up or down; otherwise the
 * result is a `not-parallel` error, never a projection (ADR 0014 decision 5). A plane facing down
 * is seen mirrored from above, so its loops are reversed to keep outer loops counter-clockwise
 * and holes clockwise. Source tags and full-circle flags are kept.
 */
export function planarLoopsToMachine(
  frame: WcsFrame,
  planar: PlanarLoops,
  tolerance = PARALLEL_TOLERANCE,
): CamResult<MachineLoops> {
  const n = isFiniteVec(planar.normal) ? normalize(planar.normal) : undefined;
  if (!n) return err('invalid-input', 'The plane normal is not a valid direction.');
  const xd = isFiniteVec(planar.xDir)
    ? normalize(sub(planar.xDir, scale(n, dot(planar.xDir, n))))
    : undefined;
  if (!xd) return err('invalid-input', 'The plane X direction is zero or parallel to its normal.');
  const yd = cross(n, xd);
  const c = dot(n, frame.zAxis);
  if (Math.abs(c) < Math.cos(tolerance)) {
    return err('not-parallel', 'The plane is not parallel to the setup XY plane.');
  }
  const z = toMachine(frame, planar.origin)[2];
  const map = (p: Vec2): Vec2 => {
    const q = toMachine(frame, add(planar.origin, add(scale(xd, p[0]), scale(yd, p[1]))));
    return [q[0], q[1]];
  };
  const flipped = c < 0;
  const loops = planar.loops.map((loop) => {
    const mapped: Segment2[] = loop.segments.map((s) =>
      s.kind === 'line'
        ? { ...s, start: map(s.start), end: map(s.end) }
        : {
            ...s,
            start: map(s.start),
            end: map(s.end),
            center: map(s.center),
            ccw: flipped ? !s.ccw : s.ccw,
          },
    );
    return flipped ? reverseLoop({ segments: mapped }) : { segments: mapped };
  });
  return ok({ z, loops });
}

/** The same loop traversed the other way. */
export function reverseLoop(loop: Loop2): Loop2 {
  const segments = [...loop.segments]
    .reverse()
    .map((s): Segment2 =>
      s.kind === 'line'
        ? { ...s, start: s.end, end: s.start }
        : { ...s, start: s.end, end: s.start, ccw: !s.ccw },
    );
  return { segments };
}

/**
 * A hole in machine coordinates. Its axis must point down the machine Z axis (into the stock
 * from above) within `tolerance` radians; otherwise the result is a `not-parallel` error.
 */
export function drillPointToMachine(
  frame: WcsFrame,
  point: DrillPoint,
  tolerance = PARALLEL_TOLERANCE,
): CamResult<MachineDrillPoint> {
  const axis = isFiniteVec(point.axis) ? normalize(point.axis) : undefined;
  if (!axis) return err('invalid-input', 'The hole axis is not a valid direction.');
  if (!isFiniteVec(point.position)) return err('invalid-input', 'The hole position is not finite.');
  if (!(point.diameter > 0) || !Number.isFinite(point.diameter)) {
    return err('invalid-input', 'The hole diameter must be greater than zero.');
  }
  if (!(point.depth > 0) || !Number.isFinite(point.depth)) {
    return err('invalid-input', 'The hole depth must be greater than zero.');
  }
  if (dot(axis, frame.zAxis) > -Math.cos(tolerance)) {
    return err('not-parallel', 'The hole axis does not point down the setup Z axis.');
  }
  const top = toMachine(frame, point.position);
  return ok({
    at: [top[0], top[1]],
    depth: { top: top[2], bottom: top[2] - point.depth },
    diameter: point.diameter,
    ...(point.through !== undefined ? { through: point.through } : {}),
    ...(point.clearBelow !== undefined ? { clearBelow: point.clearBelow } : {}),
    ...(point.entryTilt !== undefined ? { entryTilt: point.entryTilt } : {}),
    ...(point.source ? { source: point.source } : {}),
  });
}
