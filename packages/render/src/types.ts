// Plain data shared by the renderer's modules, and its errors (as data, never thrown).

import type { StandardViewName } from '@manufakture/core';

/** A 3D point or vector in model millimetres (or unitless for directions). */
export type Vec3 = readonly [number, number, number];

/** An 8-bit colour. */
export type Rgb = readonly [number, number, number];

/** The longest image side `render` accepts, in pixels (the M8 plan's "Limits"). */
export const MAX_IMAGE_SIDE = 2048;

/**
 * The most supersampled pixels one image may need (width x height x supersample squared),
 * about 64 million: bounds the renderer's buffers (some 25 bytes a sample). With
 * `MAX_IMAGE_SIDE` and supersampling at most 3 no image reaches it; it holds if either grows.
 */
export const MAX_SAMPLES = 64 * 1024 * 1024;

/** The most images one `renderViews` call makes (the M8 plan's "Limits"). */
export const MAX_IMAGES_PER_CALL = 8;

/**
 * Where the camera looks from. Every camera is orthographic. Unless `extent` is given, the image
 * is fitted to what it frames: the names in `fit` (bodies, members, faces or edges, as
 * `highlight` matches them), or everything drawn.
 *
 * - a standard view by name (core's `STANDARD_VIEWS`: third angle, Z up);
 * - `{ view }`, the same with framing options;
 * - `{ direction, up }`: `direction` the way the eye looks, into the model; `up` the model
 *   direction shown upwards (default Z, or Y when looking along Z);
 * - `{ position, target, up }`: the direction from `position` to `target`.
 */
export type Camera =
  | StandardViewName
  | ({ view: StandardViewName } & Framing)
  | ({ direction: Vec3; up?: Vec3 } & Framing)
  | ({ position: Vec3; target: Vec3; up?: Vec3 } & Framing);

export interface Framing {
  /** Frame these names (patterns as in `RenderOptions.highlight`) instead of everything drawn. */
  fit?: readonly string[];
  /**
   * Model millimetres across the image's shorter side, instead of a fit. The image is centred on
   * `target` when the camera has one, else on the centre of what it would fit. An extent
   * (or a fit) narrower than the larger of 0.001 mm and 1e-4 of the diagonal of everything
   * drawn is widened to that, so the scale stays bounded.
   */
  extent?: number;
}

/** A section: everything on the side `normal` points to is cut away, and the cut is filled. */
export interface SectionPlane {
  origin: Vec3;
  normal: Vec3;
}

export interface RenderOptions {
  /** Default `isometric`. */
  camera?: Camera;
  /** Image size in pixels; default 1024 x 768, at most `MAX_IMAGE_SIDE` on either side. */
  width?: number;
  height?: number;
  /**
   * Names drawn in the highlight colour: body ids (`extrude#1`), member ids
   * (`extension#7:king-1`), face and edge names from regen's name table
   * (`extrude#1:side:e3`). Each may be qualified with its part (`part#1/extrude#1`), and a
   * trailing `*` matches any suffix (`extension#7:*`).
   */
  highlight?: readonly string[];
  /** Bodies and members not drawn, by the same patterns (faces and edges are not hidden alone). */
  hide?: readonly string[];
  /** Draw only bodies, or only framing members (the framing without its layer bodies). */
  only?: 'bodies' | 'members';
  section?: SectionPlane;
  /** Supersampling per axis, 1 to 3; default 2; at most `MAX_SAMPLES` samples in all. */
  supersample?: number;
  /** Draw B-rep edges and member creases; default true. */
  edges?: boolean;
  /** Draw silhouettes from depth jumps; default true. */
  outlines?: boolean;
}

export interface RenderedView {
  png: Uint8Array;
  width: number;
  height: number;
  /** Model millimetres per output pixel. */
  mmPerPixel: number;
  /** `highlight` patterns that matched nothing drawn. */
  unmatched: string[];
}

export type RenderErrorCode =
  /** A side over `MAX_IMAGE_SIDE`, or more than `MAX_IMAGES_PER_CALL` images. */
  | 'too-large'
  /** A size, supersampling factor, extent or vector that is not valid. */
  | 'invalid-options'
  /** A camera direction that is zero, or an `up` parallel to it. */
  | 'invalid-camera'
  /** `fit` names that match nothing drawn. */
  | 'unknown-name'
  /** Nothing to draw: no bodies or members, or all of them hidden. */
  | 'empty'
  /** A body or member set the regen result carries no mesh for, and the input supplies none. */
  | 'missing-mesh';

export interface RenderError {
  readonly code: RenderErrorCode;
  readonly message: string;
}

export type RenderResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: RenderError };

export function ok<T>(value: T): RenderResult<T> {
  return { ok: true, value };
}

export function err<T = never>(code: RenderErrorCode, message: string): RenderResult<T> {
  return { ok: false, error: { code, message } };
}
