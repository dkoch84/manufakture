// The oriented bounding box of a body (M4 plan, T4.3b): what the cut list needs to size a body that
// is not a board, such as an imported or extruded panel. `BRepBndLib.AddOBB` builds it from the
// exact geometry (never the mesh, never enlarged by tolerances), in its optimal mode unless asked
// otherwise. The tight axis-aligned box (`BRepBndLib.AddOptimal`) is computed too: it is the
// fallback when the OBB fails, and it is used whenever it is the tighter of the two.
//
// The result is normalised so that it does not depend on the axis order OCCT happens to pick:
// axes sorted by size, longest first; the first two each pointing where their largest component
// is positive; the third their cross product, so the frame is right-handed. An oriented box is
// not unique for a symmetric body (a cylinder's two cross axes may turn freely about its axis),
// but its sizes are, and the sizes are what the cut list reads.

import type { TopoDS_Shape } from 'libcascade/single/init';
import { KernelError } from './errors';
import { cross, toVec3, type Oc, type Scope } from './occt';
import type { Vec3 } from './types';

export interface OrientedBoxOptions {
  /**
   * OCCT's optimal mode (default true): more candidate axes are tried, so the box is usually
   * tighter, at some cost in time.
   */
  optimal?: boolean;
}

export interface OrientedBox {
  /** Centre of the box, in mm. */
  center: Vec3;
  /**
   * Unit axes of the box, along its length, width and thickness: `axes[2]` is
   * `axes[0] x axes[1]`, and each of the first two points where its largest component is positive.
   */
  axes: readonly [Vec3, Vec3, Vec3];
  /** Half the box's size along each axis, largest first. */
  halfSizes: Vec3;
  /** The box's size along each axis: length >= width >= thickness, in mm. */
  sizes: Vec3;
  /**
   * `obb` when the oriented box was used; `aabb` when the axis-aligned box was, because it was
   * tighter or because the oriented box could not be computed.
   */
  source: 'obb' | 'aabb';
}

/** Components smaller than this are snapped to 0 (no -0, no 1e-17 noise in the axes). */
const AXIS_EPS = 1e-12;
/** Components within this of each other count as equal when picking an axis's sign. */
const SIGN_TIE = 1e-9;
/** Half sizes within this fraction of each other are equal when ordering the axes. */
const SIZE_TIE = 1e-9;
/** The axis-aligned box replaces the oriented one only when smaller by more than this fraction. */
const VOLUME_TOL = 1e-9;

/**
 * The oriented bounding box of `shape`. Everything is owned by `s`. `fail` turns an error thrown
 * while building the OBB into a `KernelError` (decoding and freeing an OCCT exception); a fatal
 * one is rethrown, any other falls back to the axis-aligned box.
 */
export function orientedBoxOf(
  oc: Oc,
  s: Scope,
  shape: TopoDS_Shape,
  options: OrientedBoxOptions,
  fail: (error: unknown) => KernelError,
): OrientedBox {
  const aabb = s.own(new oc.Bnd_Box());
  oc.BRepBndLib.AddOptimal(shape, aabb, false, false);
  const aligned = aabb.IsVoid()
    ? null
    : alignedBox(toVec3(s.own(aabb.CornerMin())), toVec3(s.own(aabb.CornerMax())));

  let oriented: OrientedBox | null = null;
  try {
    const obb = s.own(new oc.Bnd_OBB());
    // No triangulation: a meshed body would otherwise be bounded by its mesh. No tolerances.
    oc.BRepBndLib.AddOBB(shape, obb, false, options.optimal ?? true, false);
    if (!obb.IsVoid()) {
      oriented = normaliseBox(
        toVec3(s.own(obb.Center())),
        [
          [toVec3(s.own(obb.XDirection())), obb.XHSize()],
          [toVec3(s.own(obb.YDirection())), obb.YHSize()],
          [toVec3(s.own(obb.ZDirection())), obb.ZHSize()],
        ],
        'obb',
      );
    }
  } catch (error) {
    const e = fail(error);
    // Nothing more may be released into a dead instance.
    if (e.code === 'fatal') throw e;
  }

  if (oriented !== null && aligned !== null) {
    return volume(aligned) < volume(oriented) * (1 - VOLUME_TOL) ? aligned : oriented;
  }
  const box = oriented ?? aligned;
  if (box === null) {
    throw new KernelError('obb', 'the shape is empty: it has nothing to bound', {
      code: 'invalid-argument',
    });
  }
  return box;
}

/** An axis-aligned box from its corners, as an `OrientedBox`. */
export function alignedBox(min: Vec3, max: Vec3): OrientedBox {
  return normaliseBox(
    [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
    [
      [[1, 0, 0], (max[0] - min[0]) / 2],
      [[0, 1, 0], (max[1] - min[1]) / 2],
      [[0, 0, 1], (max[2] - min[2]) / 2],
    ],
    'aabb',
  );
}

/**
 * Sort three (unit axis, half size) pairs longest first, give the first two their canonical sign
 * and make the third their cross product. Sizes equal to 1e-9 (a square section, a cylinder's
 * cross axes) are ordered by their axes instead, the one nearest world x first, then y, so the
 * order does not depend on OCCT's.
 */
export function normaliseBox(
  center: Vec3,
  components: readonly (readonly [Vec3, number])[],
  source: OrientedBox['source'],
): OrientedBox {
  if (components.length !== 3) throw new Error('an oriented box has three axes');
  const sorted = components
    .map(([axis, half]) => ({ axis: canonical(axis), half: Math.max(0, half) }))
    .sort((a, b) => {
      if (Math.abs(a.half - b.half) > SIZE_TIE * Math.max(1, a.half, b.half)) {
        return b.half - a.half;
      }
      for (let c = 0; c < 3; c++) {
        const d = Math.abs(b.axis[c]!) - Math.abs(a.axis[c]!);
        if (Math.abs(d) > SIGN_TIE) return d;
      }
      return 0;
    });
  const a0 = sorted[0]!.axis;
  const a1 = sorted[1]!.axis;
  const a2 = clean(cross(a0, a1));
  const halfSizes: Vec3 = [sorted[0]!.half, sorted[1]!.half, sorted[2]!.half];
  return {
    center: clean(center),
    axes: [a0, a1, a2],
    halfSizes,
    sizes: [2 * halfSizes[0], 2 * halfSizes[1], 2 * halfSizes[2]],
    source,
  };
}

/** `v` (unit length) with the sign that makes its largest component positive; x, y, z break ties. */
function canonical(v: Vec3): Vec3 {
  const n = Math.hypot(v[0], v[1], v[2]);
  const u: Vec3 = n > 0 ? [v[0] / n, v[1] / n, v[2] / n] : v;
  const largest = Math.max(Math.abs(u[0]), Math.abs(u[1]), Math.abs(u[2]));
  const lead = u.findIndex((c) => Math.abs(c) >= largest - SIGN_TIE);
  const sign = u[lead]! < 0 ? -1 : 1;
  return clean([sign * u[0], sign * u[1], sign * u[2]]);
}

function clean(v: Vec3): Vec3 {
  const c = (x: number) => (Math.abs(x) < AXIS_EPS ? 0 : x);
  return [c(v[0]), c(v[1]), c(v[2])];
}

function volume(box: OrientedBox): number {
  return box.sizes[0] * box.sizes[1] * box.sizes[2];
}
