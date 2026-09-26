// Where a sketch sits in 3D: an origin, a plane normal and the direction of
// the sketch x axis. The sketch y axis is `normal x xDir`, so the frame is
// right-handed and the normal points towards a viewer who sees the sketch
// with x to the right and y up. Plain data (ADR 0004), in millimetres.

import type { Vec2, Vec3 } from './model';

export interface SketchPlacement {
  origin: Vec3;
  /** Unit plane normal. */
  normal: Vec3;
  /** Unit direction of the sketch x axis, perpendicular to `normal`. */
  xDir: Vec3;
}

/** The orthonormal frame of a placement. */
export interface PlacementFrame {
  origin: Vec3;
  x: Vec3;
  y: Vec3;
  z: Vec3;
}

/** Sketch x = world X, y = world Y. */
export const XY_PLANE: SketchPlacement = { origin: [0, 0, 0], normal: [0, 0, 1], xDir: [1, 0, 0] };
/** Sketch x = world X, y = world Z (normal -Y, as in FreeCAD). */
export const XZ_PLANE: SketchPlacement = { origin: [0, 0, 0], normal: [0, -1, 0], xDir: [1, 0, 0] };
/** Sketch x = world Y, y = world Z. */
export const YZ_PLANE: SketchPlacement = { origin: [0, 0, 0], normal: [1, 0, 0], xDir: [0, 1, 0] };

const EPS = 1e-9;

export function dot3(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function cross3(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function length3(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2]);
}

function scale3(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}

function finite3(a: Vec3): boolean {
  return a.length === 3 && a.every(Number.isFinite);
}

/**
 * A placement from an origin and a normal (any length), with the x direction
 * projected into the plane and normalised. Without `xDir`, or when it is
 * parallel to the normal, the world axis least aligned with the normal is
 * projected instead (X for planes facing Z, so `placementFromNormal(o, [0,0,1])`
 * is the XY plane moved to `o`). Throws on a zero or non-finite normal.
 */
export function placementFromNormal(origin: Vec3, normal: Vec3, xDir?: Vec3): SketchPlacement {
  if (!finite3(origin) || !finite3(normal)) throw new Error('Placement must be finite');
  const n = length3(normal);
  if (n < EPS) throw new Error('Placement normal must not be zero');
  const z = scale3(normal, 1 / n);
  const project = (d: Vec3): Vec3 | null => {
    if (!finite3(d)) return null;
    const p: Vec3 = [d[0] - z[0] * dot3(d, z), d[1] - z[1] * dot3(d, z), d[2] - z[2] * dot3(d, z)];
    const l = length3(p);
    return l < EPS * Math.max(1, length3(d)) ? null : scale3(p, 1 / l);
  };
  let x = xDir ? project(xDir) : null;
  if (!x) {
    const axes: Vec3[] = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ];
    const least = axes.reduce((best, a) =>
      Math.abs(dot3(a, z)) < Math.abs(dot3(best, z)) ? a : best,
    );
    x = project(least)!;
  }
  return { origin: [...origin], normal: z, xDir: x };
}

/** Whether a placement is finite with a unit normal and a unit x direction in the plane. */
export function isValidPlacement(p: SketchPlacement, tolerance = 1e-9): boolean {
  return (
    finite3(p.origin) &&
    finite3(p.normal) &&
    finite3(p.xDir) &&
    Math.abs(length3(p.normal) - 1) < tolerance &&
    Math.abs(length3(p.xDir) - 1) < tolerance &&
    Math.abs(dot3(p.normal, p.xDir)) < tolerance
  );
}

/** The right-handed frame: x = xDir, y = normal x xDir, z = normal. */
export function placementFrame(p: SketchPlacement): PlacementFrame {
  return { origin: p.origin, x: p.xDir, y: cross3(p.normal, p.xDir), z: p.normal };
}

/** A sketch point in world coordinates. */
export function sketchToWorld(p: SketchPlacement, point: Vec2): Vec3 {
  const f = placementFrame(p);
  return [
    f.origin[0] + f.x[0] * point[0] + f.y[0] * point[1],
    f.origin[1] + f.x[1] * point[0] + f.y[1] * point[1],
    f.origin[2] + f.x[2] * point[0] + f.y[2] * point[1],
  ];
}

/** A sketch direction (no translation) in world coordinates. */
export function sketchDirectionToWorld(p: SketchPlacement, direction: Vec2): Vec3 {
  const f = placementFrame(p);
  return [
    f.x[0] * direction[0] + f.y[0] * direction[1],
    f.x[1] * direction[0] + f.y[1] * direction[1],
    f.x[2] * direction[0] + f.y[2] * direction[1],
  ];
}

/** A world point projected onto the sketch plane, in sketch coordinates. */
export function worldToSketch(p: SketchPlacement, point: Vec3): Vec2 {
  const f = placementFrame(p);
  const d: Vec3 = [point[0] - f.origin[0], point[1] - f.origin[1], point[2] - f.origin[2]];
  return [dot3(d, f.x), dot3(d, f.y)];
}

/** Signed distance of a world point from the sketch plane, along the normal. */
export function distanceFromPlane(p: SketchPlacement, point: Vec3): number {
  const d: Vec3 = [point[0] - p.origin[0], point[1] - p.origin[1], point[2] - p.origin[2]];
  return dot3(d, p.normal);
}

/**
 * The 4x4 sketch-to-world matrix, column-major (the layout three.js's
 * `Matrix4.fromArray` and WebGL expect).
 */
export function placementMatrix(p: SketchPlacement): number[] {
  const f = placementFrame(p);
  return [...f.x, 0, ...f.y, 0, ...f.z, 0, ...f.origin, 1];
}
