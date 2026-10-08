// The entry points: options checked against the limits, the camera resolved, the scene rasterised
// and encoded. Every failure is returned as data.

import { resolveCamera } from './camera';
import { encodePng } from './png';
import { rasterize, type RasterImage } from './raster';
import type { Scene } from './scene';
import {
  MAX_IMAGES_PER_CALL,
  MAX_IMAGE_SIDE,
  MAX_SAMPLES,
  err,
  ok,
  type RenderOptions,
  type RenderResult,
  type RenderedView,
  type Vec3,
} from './types';

export const DEFAULT_WIDTH = 1024;
export const DEFAULT_HEIGHT = 768;
export const DEFAULT_SUPERSAMPLE = 2;

const finite = (v: unknown): v is Vec3 =>
  Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number' && Number.isFinite(x));

const names = (v: unknown): v is readonly string[] =>
  Array.isArray(v) && v.every((x) => typeof x === 'string');

/** Render `scene` to RGB bytes (no PNG): for callers that compose or inspect pixels. */
export function renderRgb(scene: Scene, options: RenderOptions = {}): RenderResult<RasterImage> {
  // Callers may pass anything (a tool's JSON arguments): check it is an object at all.
  if (typeof options !== 'object' || options === null || Array.isArray(options))
    return err('invalid-options', 'options must be an object');
  const width = options.width ?? DEFAULT_WIDTH;
  const height = options.height ?? DEFAULT_HEIGHT;
  for (const [name, v] of [
    ['width', width],
    ['height', height],
  ] as const)
    if (!Number.isInteger(v) || v < 1)
      return err('invalid-options', `${name} must be a whole number of pixels, at least 1`);
  if (width > MAX_IMAGE_SIDE || height > MAX_IMAGE_SIDE)
    return err(
      'too-large',
      `${width} x ${height} is over the limit of ${MAX_IMAGE_SIDE} pixels on the long side`,
    );
  const ss = options.supersample ?? DEFAULT_SUPERSAMPLE;
  if (!Number.isInteger(ss) || ss < 1 || ss > 3)
    return err('invalid-options', 'supersample must be 1, 2 or 3');
  if (width * height * ss * ss > MAX_SAMPLES)
    return err(
      'invalid-options',
      `${width} x ${height} at supersample ${ss} is over ${MAX_SAMPLES} samples: supersample less`,
    );
  if (options.highlight !== undefined && !names(options.highlight))
    return err('invalid-options', 'highlight must be a list of names');
  if (options.hide !== undefined && !names(options.hide))
    return err('invalid-options', 'hide must be a list of names');
  const only = options.only ?? null;
  if (only !== null && only !== 'bodies' && only !== 'members')
    return err('invalid-options', 'only must be "bodies" or "members"');
  const section = options.section ?? null;
  if (section) {
    const n = section.normal;
    if (!finite(section.origin) || !finite(n) || n[0] * n[0] + n[1] * n[1] + n[2] * n[2] === 0)
      return err('invalid-options', 'a section needs a finite origin and a non-zero normal');
  }
  const view = resolveCamera(options.camera ?? 'isometric');
  if (!view.ok) return view;
  return rasterize(scene, view.value, {
    width,
    height,
    ss,
    edges: options.edges ?? true,
    outlines: options.outlines ?? true,
    highlight: options.highlight ?? [],
    hide: options.hide ?? [],
    only,
    section,
  });
}

/** Render `scene` as a PNG. */
export function render(scene: Scene, options: RenderOptions = {}): RenderResult<RenderedView> {
  const image = renderRgb(scene, options);
  if (!image.ok) return image;
  const { rgb, width, height, mmPerPixel, unmatched } = image.value;
  return ok({ png: encodePng(rgb, width, height), width, height, mmPerPixel, unmatched });
}

/**
 * Render several views of one scene, at most `MAX_IMAGES_PER_CALL`; the first failure is the
 * result.
 */
export function renderViews(
  scene: Scene,
  views: readonly RenderOptions[],
): RenderResult<RenderedView[]> {
  if (views.length > MAX_IMAGES_PER_CALL)
    return err(
      'too-large',
      `${views.length} images is over the limit of ${MAX_IMAGES_PER_CALL} per call`,
    );
  const out: RenderedView[] = [];
  for (const options of views) {
    const view = render(scene, options);
    if (!view.ok) return view;
    out.push(view.value);
  }
  return ok(out);
}
