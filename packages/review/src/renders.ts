// Renders of base and head at the same cameras (ADR 0016 decision 11): isometric and the three
// principal views, plus any asked for at submit. A view that names no framing of its own is
// framed on everything either side draws, so the two images line up pixel for pixel and a
// change in size shows as one. Images are PNGs from `@manufakture/render`, stored by the caller.

import {
  MAX_IMAGE_SIDE,
  render,
  resolveCamera,
  type Camera,
  type RenderOptions,
  type Scene,
  type SectionPlane,
  type Vec3,
} from '@manufakture/render';
import { MAX_POSE_TRANSLATION, PoseSchema } from '@manufakture/core';
import type { AssemblyAt } from './assembly';
import { round, shown } from './text';
import { LIMITS } from './types';

/** A view asked for at submit, besides the fixed four. */
export interface ReviewView {
  /** Shown with the images; 1 to 64 characters. */
  name: string;
  /** Default `isometric`. With `fit` or `extent` it is used as given; else framed on both sides. */
  camera?: Camera;
  highlight?: readonly string[];
  hide?: readonly string[];
  only?: 'bodies' | 'members';
  section?: SectionPlane;
  /**
   * Draw this assembly instead of the part studio: at its solved poses, or with mates held at
   * values and instances placed by hand (`AssemblyAt`). Names then also match qualified with an
   * instance (`inst#2/extrude#1`).
   */
  assembly?: AssemblyAt;
}

/** Mate values, and instance poses, one assembly view may give (each). */
export const MAX_VIEW_POSES = 64;

/** The fixed views every bundle has. */
export const FIXED_VIEWS: readonly ReviewView[] = [
  { name: 'isometric', camera: 'isometric' },
  { name: 'front', camera: 'front' },
  { name: 'top', camera: 'top' },
  { name: 'right', camera: 'right' },
];

export interface ImageSize {
  width: number;
  height: number;
}

export const DEFAULT_IMAGE_SIZE: ImageSize = { width: 800, height: 600 };
/** Pixels left round what a view frames, as the renderer's own fit leaves. */
const MARGIN = 24;

/** The views of a bundle: the fixed four and those asked for, checked. */
export function reviewViews(extra: readonly ReviewView[] = []): ReviewView[] {
  if (extra.length > LIMITS.views - FIXED_VIEWS.length) {
    throw new Error(`At most ${LIMITS.views - FIXED_VIEWS.length} views can be asked for.`);
  }
  for (const v of extra) {
    if (typeof v.name !== 'string' || v.name.length < 1 || v.name.length > 64) {
      throw new Error('A view name is 1 to 64 characters.');
    }
    if (v.assembly !== undefined) checkAssemblyAt(v.assembly);
  }
  return [...FIXED_VIEWS, ...extra.map((v) => ({ ...v, name: shown(v.name, 64) }))];
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isId = (v: unknown): v is string => typeof v === 'string' && v.length >= 1 && v.length <= 120;

/** An assembly view's request, checked: bounded ids, finite values and poses. */
function checkAssemblyAt(at: AssemblyAt): void {
  if (typeof at !== 'object' || at === null || !isId(at.assemblyId)) {
    throw new Error(
      "A view's assembly is { assemblyId, mates?, poses? }, its ids 1 to 120 characters.",
    );
  }
  const mates = Object.entries(at.mates ?? {});
  const poses = Object.entries(at.poses ?? {});
  if (mates.length > MAX_VIEW_POSES || poses.length > MAX_VIEW_POSES) {
    throw new Error(
      `A view holds at most ${MAX_VIEW_POSES} mate values and ${MAX_VIEW_POSES} poses.`,
    );
  }
  for (const [id, v] of mates) {
    if (!isId(id) || !finite(v))
      throw new Error('A mate value is a finite number by mate id (1 to 120 characters).');
  }
  for (const [id, p] of poses) {
    // Core's own check, as the MCP schema has it: finite, each translation component within
    // MAX_POSE_TRANSLATION, the rotation a unit quaternion to 1e-6.
    if (!isId(id) || !PoseSchema.safeParse(p).success) {
      throw new Error(
        `A pose, by instance id (1 to 120 characters), is { translation: [x, y, z], rotation: [x, y, z, w] }: translation at most ${MAX_POSE_TRANSLATION} mm on each axis, rotation a unit quaternion.`,
      );
    }
  }
}

type Box = { min: [number, number, number]; max: [number, number, number] };

function grow(box: Box | null, p: readonly number[]): Box {
  if (box === null) return { min: [p[0]!, p[1]!, p[2]!], max: [p[0]!, p[1]!, p[2]!] };
  for (let k = 0; k < 3; k++) {
    box.min[k] = Math.min(box.min[k]!, p[k]!);
    box.max[k] = Math.max(box.max[k]!, p[k]!);
  }
  return box;
}

function corners(b: Box): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (let i = 0; i < 8; i++) {
    out.push([
      i & 1 ? b.max[0] : b.min[0],
      i & 2 ? b.max[1] : b.min[1],
      i & 4 ? b.max[2] : b.min[2],
    ]);
  }
  return out;
}

/** The box round everything a scene draws, in model space. */
export function sceneBox(scene: Scene): Box | null {
  let box: Box | null = null;
  for (const mesh of scene.meshes) {
    let local: Box | null = null;
    const p = mesh.positions;
    for (let i = 0; i + 2 < p.length; i += 3) local = grow(local, [p[i]!, p[i + 1]!, p[i + 2]!]);
    if (local === null) continue;
    if (mesh.matrices === null) {
      box = grow(grow(box, local.min), local.max);
      continue;
    }
    const m = mesh.matrices;
    for (let k = 0; k + 15 < m.length; k += 16) {
      for (const c of corners(local)) {
        box = grow(box, [
          m[k]! * c[0] + m[k + 4]! * c[1] + m[k + 8]! * c[2] + m[k + 12]!,
          m[k + 1]! * c[0] + m[k + 5]! * c[1] + m[k + 9]! * c[2] + m[k + 13]!,
          m[k + 2]! * c[0] + m[k + 6]! * c[1] + m[k + 10]! * c[2] + m[k + 14]!,
        ]);
      }
    }
  }
  return box;
}

const dot = (a: readonly number[], b: readonly number[]) =>
  a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;

/**
 * The camera `view` is drawn with on both sides: as given when it frames itself (`fit` or
 * `extent`), else looking the same way, centred on `box` and wide enough for it.
 */
export function sharedCamera(view: ReviewView, box: Box | null, size: ImageSize): Camera {
  const camera = view.camera ?? 'isometric';
  if (box === null) return camera;
  if (typeof camera === 'object' && (camera.fit !== undefined || camera.extent !== undefined)) {
    return camera;
  }
  const basis = resolveCamera(camera);
  if (!basis.ok) return camera;
  const { r, u, d } = basis.value;
  let r0 = Infinity;
  let r1 = -Infinity;
  let u0 = Infinity;
  let u1 = -Infinity;
  for (const c of corners(box)) {
    r0 = Math.min(r0, dot(c, r));
    r1 = Math.max(r1, dot(c, r));
    u0 = Math.min(u0, dot(c, u));
    u1 = Math.max(u1, dot(c, u));
  }
  const perPixel = Math.max(
    (r1 - r0) / Math.max(1, size.width - 2 * MARGIN),
    (u1 - u0) / Math.max(1, size.height - 2 * MARGIN),
  );
  const extent = round(Math.max(perPixel * Math.min(size.width, size.height), 1e-3));
  const target = [0, 1, 2].map((k) => round((box.min[k]! + box.max[k]!) / 2)) as unknown as Vec3;
  const position = [0, 1, 2].map((k) => round(target[k]! - d[k]!)) as unknown as Vec3;
  return { position, target, up: u.map(round) as unknown as Vec3, extent };
}

export interface RenderedPair {
  name: string;
  camera: Camera;
  base: { png: Uint8Array; width: number; height: number } | { error: string } | null;
  head: { png: Uint8Array; width: number; height: number } | { error: string } | null;
}

type SceneOrError = { ok: true; value: Scene } | { ok: false; message: string };

/** What one side draws: one scene for every view, or a scene per view (assembly views). */
export type SceneSource = SceneOrError | ((view: ReviewView, index: number) => SceneOrError);

function draw(
  scene: SceneOrError,
  options: RenderOptions,
): { png: Uint8Array; width: number; height: number } | { error: string } {
  if (!scene.ok) return { error: shown(scene.message) };
  const r = render(scene.value, options);
  if (!r.ok) return { error: shown(r.error.message) };
  if (r.value.png.length > LIMITS.imageBytes) {
    return { error: `The image is ${r.value.png.length} bytes; at most ${LIMITS.imageBytes}.` };
  }
  return { png: r.value.png, width: r.value.width, height: r.value.height };
}

/** Every view of both sides, each pair at one camera. */
export function renderPairs(
  base: SceneSource,
  head: SceneSource,
  views: readonly ReviewView[],
  size: ImageSize = DEFAULT_IMAGE_SIZE,
): RenderedPair[] {
  if (
    !Number.isSafeInteger(size.width) ||
    !Number.isSafeInteger(size.height) ||
    size.width < 64 ||
    size.height < 64 ||
    size.width > MAX_IMAGE_SIDE ||
    size.height > MAX_IMAGE_SIDE
  ) {
    throw new Error(`Images are 64 to ${MAX_IMAGE_SIDE} pixels a side.`);
  }
  const boxes = new WeakMap<Scene, Box | null>();
  const boxOf = (s: Scene): Box | null => {
    if (!boxes.has(s)) boxes.set(s, sceneBox(s));
    return boxes.get(s)!;
  };
  return views.map((view, i) => {
    const sides = [base, head].map((s) => (typeof s === 'function' ? s(view, i) : s));
    const [b, h] = sides as [SceneOrError, SceneOrError];
    let box: Box | null = null;
    for (const s of sides) {
      const found = s.ok ? boxOf(s.value) : null;
      if (found) box = grow(grow(box, found.min), found.max);
    }
    const camera = sharedCamera(view, box, size);
    const options: RenderOptions = {
      camera,
      width: size.width,
      height: size.height,
      ...(view.highlight ? { highlight: view.highlight } : {}),
      ...(view.hide ? { hide: view.hide } : {}),
      ...(view.only ? { only: view.only } : {}),
      ...(view.section ? { section: view.section } : {}),
    };
    return { name: view.name, camera, base: draw(b, options), head: draw(h, options) };
  });
}
