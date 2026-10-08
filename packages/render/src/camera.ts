// Cameras: a standard view, a direction, or a position and a target, all orthographic, resolved
// to an orthonormal view basis (r right, u up, d into the screen) and the framing options.

import { STANDARD_VIEWS, STANDARD_VIEW_NAMES, type StandardViewName } from '@manufakture/core';
import { err, ok, type Camera, type RenderResult, type Vec3 } from './types';

export interface ViewBasis {
  r: Vec3;
  u: Vec3;
  d: Vec3;
  fit: readonly string[] | null;
  extent: number | null;
  /** The image centre in model space, when the camera fixes it (`extent` with a `target`). */
  target: Vec3 | null;
}

const finite = (v: unknown): v is Vec3 =>
  Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number' && Number.isFinite(x));

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

export function normalize(v: Vec3): Vec3 {
  const l = Math.sqrt(dot(v, v));
  return [v[0] / l, v[1] / l, v[2] / l];
}

const isViewName = (v: unknown): v is StandardViewName =>
  typeof v === 'string' && (STANDARD_VIEW_NAMES as readonly string[]).includes(v);

/** The view basis of `camera`, or why it is not a camera. */
export function resolveCamera(camera: Camera): RenderResult<ViewBasis> {
  let direction: Vec3;
  let up: Vec3 | undefined;
  let target: Vec3 | null = null;
  let fit: readonly string[] | null = null;
  let extent: number | null = null;
  if (typeof camera === 'string') {
    if (!isViewName(camera)) return err('invalid-camera', `unknown view "${String(camera)}"`);
    ({ direction, up } = STANDARD_VIEWS[camera]);
  } else if (typeof camera !== 'object' || camera === null || Array.isArray(camera)) {
    return err('invalid-camera', 'a camera is a view name or an object');
  } else {
    if ('view' in camera) {
      if (!isViewName(camera.view))
        return err('invalid-camera', `unknown view "${String(camera.view)}"`);
      ({ direction, up } = STANDARD_VIEWS[camera.view]);
    } else if ('position' in camera) {
      if (!finite(camera.position) || !finite(camera.target))
        return err('invalid-camera', 'position and target must be three finite numbers');
      direction = [
        camera.target[0] - camera.position[0],
        camera.target[1] - camera.position[1],
        camera.target[2] - camera.position[2],
      ];
      target = camera.target;
      up = camera.up;
    } else {
      if (!finite(camera.direction))
        return err('invalid-camera', 'direction must be three finite numbers');
      direction = camera.direction;
      up = camera.up;
    }
    if (camera.fit !== undefined) {
      if (!Array.isArray(camera.fit) || camera.fit.some((n) => typeof n !== 'string'))
        return err('invalid-options', 'fit must be a list of names');
      if (camera.fit.length > 0) fit = camera.fit;
    }
    if (camera.extent !== undefined) {
      if (!(typeof camera.extent === 'number' && camera.extent > 0 && camera.extent < Infinity))
        return err('invalid-options', 'extent must be a positive number of millimetres');
      extent = camera.extent;
    }
  }
  const dl = Math.sqrt(dot(direction, direction));
  if (!(dl > 0)) return err('invalid-camera', 'the view direction is zero');
  const d = normalize(direction);
  if (up === undefined) {
    // Z up, unless looking along Z: then Y up looking down (as `top`), -Y looking up.
    up = Math.abs(d[2]) > 0.999999 ? (d[2] < 0 ? [0, 1, 0] : [0, -1, 0]) : [0, 0, 1];
  } else if (!finite(up)) {
    return err('invalid-camera', 'up must be three finite numbers');
  }
  const ul = Math.sqrt(dot(up, up));
  const side = cross(d, up);
  if (!(ul > 0) || Math.sqrt(dot(side, side)) / ul < 1e-9)
    return err('invalid-camera', 'up must not be zero or parallel to the view direction');
  const r = normalize(side);
  const u = cross(r, d);
  return ok({ r, u, d, fit, extent, target: extent !== null ? target : null });
}
