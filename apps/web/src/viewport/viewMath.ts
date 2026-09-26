// Camera math for the viewport, kept free of rendering so it can be tested.
//
// World convention: Z up, millimetres, front view looks along +Y (the camera
// sits on the -Y side), right view looks along -X, top view looks down -Z.
//
// A view is a target point, an orientation and a half height: the half height
// of the visible area in the plane through the target, facing the camera. An
// orthographic camera shows exactly that; a perspective camera is placed at
// `perspectiveDistance(halfHeight, fov)` so the target plane looks the same,
// which makes switching projections keep the apparent size.

import { Matrix4, Quaternion, Vector3 } from 'three';

export type Vec3Tuple = readonly [number, number, number];

export interface ViewState {
  target: Vector3;
  orientation: Quaternion;
  halfHeight: number;
}

export const WORLD_UP: Vec3Tuple = [0, 0, 1];

/** Smallest and largest half height the zoom allows, in mm. */
export const ZOOM_LIMITS = { min: 1e-3, max: 1e6 } as const;

export function cloneView(v: ViewState): ViewState {
  return { target: v.target.clone(), orientation: v.orientation.clone(), halfHeight: v.halfHeight };
}

/** Unit vector from the target towards the eye. */
export function eyeDirection(q: Quaternion): Vector3 {
  return new Vector3(0, 0, 1).applyQuaternion(q);
}

export function screenUp(q: Quaternion): Vector3 {
  return new Vector3(0, 1, 0).applyQuaternion(q);
}

export function screenRight(q: Quaternion): Vector3 {
  return new Vector3(1, 0, 0).applyQuaternion(q);
}

/** The up vector for a view from `dir`: world Z, except straight above or below. */
export function upForDirection(dir: Vec3Tuple): Vector3 {
  const d = new Vector3(...dir).normalize();
  if (Math.abs(d.z) > 0.999) return new Vector3(0, d.z > 0 ? 1 : -1, 0);
  return new Vector3(...WORLD_UP);
}

/** Camera orientation looking at the target from direction `dir` (eye = target + dir). */
export function orientationFor(dir: Vec3Tuple, up: Vector3 = upForDirection(dir)): Quaternion {
  const eye = new Vector3(...dir).normalize();
  const m = new Matrix4().lookAt(eye, new Vector3(0, 0, 0), up);
  return new Quaternion().setFromRotationMatrix(m);
}

export type StandardView = 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom' | 'iso';

export const STANDARD_VIEWS: Readonly<Record<StandardView, Vec3Tuple>> = {
  front: [0, -1, 0],
  back: [0, 1, 0],
  right: [1, 0, 0],
  left: [-1, 0, 0],
  top: [0, 0, 1],
  bottom: [0, 0, -1],
  iso: [1, -1, 1],
};

export function withDirection(view: ViewState, dir: Vec3Tuple): ViewState {
  return { ...cloneView(view), orientation: orientationFor(dir) };
}

/** Distance of a perspective camera that shows `halfHeight` at the target plane. */
export function perspectiveDistance(halfHeight: number, fovDeg: number): number {
  return halfHeight / Math.tan((fovDeg * Math.PI) / 360);
}

/**
 * For a perspective view, how far `point` is from the eye along the view
 * axis, relative to the target plane: panning by that much more (or less)
 * makes the point, not the target plane, follow the cursor. Clamped, so a
 * point almost at the eye cannot stall the pan.
 */
export function panDepthScale(view: ViewState, point: Vector3, fovDeg: number): number {
  const dist = perspectiveDistance(view.halfHeight, fovDeg);
  const eyeDir = eyeDirection(view.orientation);
  const eye = view.target.clone().addScaledVector(eyeDir, dist);
  const depth = eye.sub(point).dot(eyeDir);
  return clamp(depth / dist, 0.05, 20);
}

/** World units per CSS pixel at the target plane. */
export function worldPerPixel(halfHeight: number, heightPx: number): number {
  return (2 * halfHeight) / Math.max(1, heightPx);
}

/**
 * Turntable orbit: horizontal drag spins about world Z, vertical drag tilts
 * about the screen's horizontal axis. Dragging right turns the model right.
 */
export function orbit(view: ViewState, dxPx: number, dyPx: number, radPerPx = 0.008): ViewState {
  const yaw = new Quaternion().setFromAxisAngle(new Vector3(...WORLD_UP), -dxPx * radPerPx);
  const pitch = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -dyPx * radPerPx);
  const orientation = yaw.multiply(view.orientation).multiply(pitch).normalize();
  return { ...cloneView(view), orientation };
}

/**
 * Pan so a point follows the cursor. `depthScale` is the grabbed point's
 * depth relative to the target plane (see `panDepthScale`): 1 moves points in
 * the target plane exactly with the cursor.
 */
export function pan(
  view: ViewState,
  dxPx: number,
  dyPx: number,
  heightPx: number,
  depthScale = 1,
): ViewState {
  const k = worldPerPixel(view.halfHeight, heightPx) * depthScale;
  const target = view.target
    .clone()
    .addScaledVector(screenRight(view.orientation), -dxPx * k)
    .addScaledVector(screenUp(view.orientation), dyPx * k);
  return { ...cloneView(view), target };
}

/**
 * The point in the target plane under normalised device coordinates `ndc`
 * (x right, y up, both -1..1). Exact for both projections.
 */
export function pointInTargetPlane(view: ViewState, ndc: { x: number; y: number }, aspect: number) {
  return view.target
    .clone()
    .addScaledVector(screenRight(view.orientation), ndc.x * view.halfHeight * aspect)
    .addScaledVector(screenUp(view.orientation), ndc.y * view.halfHeight);
}

/**
 * Zoom by `factor` (below 1 zooms in) about a world point: the camera, the
 * target and the view size all scale about `pivot`, so the pivot stays at the
 * same place on screen in both projections, wherever it is in depth.
 */
export function zoomAbout(view: ViewState, pivot: Vector3, factor: number): ViewState {
  const halfHeight = clamp(view.halfHeight * factor, ZOOM_LIMITS.min, ZOOM_LIMITS.max);
  const k = halfHeight / view.halfHeight;
  const target = pivot.clone().add(view.target.clone().sub(pivot).multiplyScalar(k));
  return { ...cloneView(view), target, halfHeight };
}

/**
 * Zoom by `factor` keeping the target-plane point under the cursor fixed:
 * the fallback when the cursor is not over the model.
 */
export function zoomAt(
  view: ViewState,
  ndc: { x: number; y: number },
  factor: number,
  aspect: number,
): ViewState {
  return zoomAbout(view, pointInTargetPlane(view, ndc, aspect), factor);
}

export interface Sphere {
  center: Vector3;
  radius: number;
}

/** Frame a bounding sphere, keeping the orientation. */
export function fitSphere(
  view: ViewState,
  sphere: Sphere,
  aspect: number,
  margin = 1.15,
): ViewState {
  const r = Math.max(sphere.radius, ZOOM_LIMITS.min);
  const halfHeight = r * margin * Math.max(1, 1 / Math.max(aspect, 1e-6));
  return { ...cloneView(view), target: sphere.center.clone(), halfHeight };
}

export function easeInOutCubic(t: number): number {
  const x = clamp(t, 0, 1);
  return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
}

/** A point on an animated transition; `t` is linear time 0..1, eased here. */
export function interpolateView(a: ViewState, b: ViewState, t: number): ViewState {
  const e = easeInOutCubic(t);
  return {
    target: a.target.clone().lerp(b.target, e),
    orientation: a.orientation.clone().slerp(b.orientation, e),
    // Interpolate the zoom on a log scale so it feels even at every size.
    halfHeight: Math.exp(Math.log(a.halfHeight) * (1 - e) + Math.log(b.halfHeight) * e),
  };
}

export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

// View cube --------------------------------------------------------------------------
//
// The cube is a 3 x 3 x 3 grid of pieces with widths `bevel`, `1 - 2 bevel`,
// `bevel` along each axis; the 26 outer pieces are the clickable regions (6
// faces, 12 edges, 8 corners). A region's direction has components in
// {-1, 0, 1} and is also the view direction it selects.

export type CubeRegionKind = 'face' | 'edge' | 'corner';

export interface CubeRegion {
  dir: Vec3Tuple;
  kind: CubeRegionKind;
  label: string;
}

const AXIS_NAMES: readonly (readonly [string, string])[] = [
  ['Left', 'Right'],
  ['Front', 'Back'],
  ['Bottom', 'Top'],
];

export function regionLabel(dir: Vec3Tuple): string {
  // Top/Bottom first, then Front/Back, then Left/Right, like "Top Front Right".
  const parts: string[] = [];
  for (const axis of [2, 1, 0]) {
    const c = dir[axis]!;
    if (c !== 0) parts.push(AXIS_NAMES[axis]![c > 0 ? 1 : 0]!);
  }
  return parts.join(' ');
}

export const CUBE_REGIONS: readonly CubeRegion[] = (() => {
  const out: CubeRegion[] = [];
  for (const x of [-1, 0, 1])
    for (const y of [-1, 0, 1])
      for (const z of [-1, 0, 1]) {
        const nonZero = Number(x !== 0) + Number(y !== 0) + Number(z !== 0);
        if (nonZero === 0) continue;
        const dir: Vec3Tuple = [x, y, z];
        const kind: CubeRegionKind = nonZero === 1 ? 'face' : nonZero === 2 ? 'edge' : 'corner';
        out.push({ dir, kind, label: regionLabel(dir) });
      }
  return out;
})();

/** Centre and size of a region's piece in a unit cube centred on the origin. */
export function cubePiece(dir: Vec3Tuple, bevel: number): { center: Vec3Tuple; size: Vec3Tuple } {
  const center = dir.map((c) => (c === 0 ? 0 : c * (0.5 - bevel / 2))) as unknown as Vec3Tuple;
  const size = dir.map((c) => (c === 0 ? 1 - 2 * bevel : bevel)) as unknown as Vec3Tuple;
  return { center, size };
}

export function regionKey(dir: Vec3Tuple): string {
  return dir.join(',');
}
