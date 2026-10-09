// The `render` tool: PNG views of the session's head through `@manufakture/render` (ADR 0016
// decision 5), and with `compare` of the branch's base version too, each pair at one camera
// (`@manufakture/review`'s shared framing, as the review bundle draws them). Both sides are
// regenerated in the workshop. Images carry no text: what each one is travels as data beside it.
//
// Bounds: at most `MAX_IMAGES_PER_CALL` images a call (views times sides), each side at most
// `MAX_IMAGE_SIDE` pixels, each PNG at most `imageBytes` and all of them `totalImageBytes`; an
// image over a bound is left out and listed in `failed`.
//
// A view with `assembly` draws that assembly instead of the part studio (`@manufakture/review`'s
// `assemblyScene`): its instances' bodies at the solved poses, or with sliders and revolutes held
// at values and instances placed by hand, and the pose read back beside the image (each mate's
// coordinates, warnings for a value past a limit or a pose off its mate). With `compare`, the
// base is drawn at the same request.
//
// Scripts: the workshop's engine runs in this thread with no script engine (a run here could not
// be ended), so a scripted feature fails in these renders, as in exports; a session's own regen
// and the review bundle run the branch's scripts in a worker (packages/session, "Scripts").

import type { ManufaktureDocument } from '@manufakture/core';
import type { MemberMesh, RegenResult } from '@manufakture/regen';
import { buildScene, render, type RenderOptions, type Scene } from '@manufakture/render';
import {
  assemblyScene,
  sceneBox,
  sharedCamera,
  type AssemblyAt,
  type PosedAssemblyView,
} from '@manufakture/review';
import type { z } from 'zod';
import type { View } from './schemas';
import type { Workshop } from './workshop';

export type ViewInput = z.infer<typeof View>;

export interface ImageLimits {
  /** One PNG, bytes. */
  imageBytes: number;
  /** Every PNG of one call, bytes. */
  totalImageBytes: number;
}

export const DEFAULT_IMAGE_LIMITS: ImageLimits = {
  imageBytes: 8 * 1024 * 1024,
  totalImageBytes: 16 * 1024 * 1024,
};

export interface Drawn {
  view: number;
  side: 'head' | 'base';
  png: Uint8Array;
  width: number;
  height: number;
  mmPerPixel: number;
  unmatched: string[];
  /** For a view of an assembly: the pose drawn, read back. */
  assembly?: PosedAssemblyView;
}

export interface Failed {
  view: number;
  side: 'head' | 'base';
  code: string;
  message: string;
}

type SceneOrError =
  | { ok: true; value: Scene; posed?: PosedAssemblyView }
  | { ok: false; code: string; message: string };

function sceneOf(document: ManufaktureDocument, result: RegenResult): SceneOrError {
  const memberMeshes = new Map<string, MemberMesh>(
    (result.memberMeshes?.added ?? []).map((m) => [m.key, m]),
  );
  const scene = buildScene({ result, memberMeshes, document });
  return scene.ok ? scene : { ok: false, code: scene.error.code, message: scene.error.message };
}

function options(view: ViewInput): RenderOptions {
  const o: RenderOptions = {};
  if (view.camera !== undefined) o.camera = view.camera as NonNullable<RenderOptions['camera']>;
  if (view.width !== undefined) o.width = view.width;
  if (view.height !== undefined) o.height = view.height;
  if (view.highlight !== undefined) o.highlight = view.highlight;
  if (view.hide !== undefined) o.hide = view.hide;
  if (view.only !== undefined) o.only = view.only;
  if (view.section !== undefined) o.section = view.section;
  if (view.supersample !== undefined) o.supersample = view.supersample;
  if (view.edges !== undefined) o.edges = view.edges;
  if (view.outlines !== undefined) o.outlines = view.outlines;
  return o;
}

/** One side's scene per view: the part studio's, or an assembly's at the view's pose. */
function scenesOf(
  document: ManufaktureDocument,
  result: RegenResult,
  views: readonly ViewInput[],
): SceneOrError[] {
  let part: SceneOrError | null = null;
  return views.map((view) => {
    if (view.assembly === undefined) return (part ??= sceneOf(document, result));
    const r = assemblyScene(document, result, view.assembly as AssemblyAt);
    return r.ok ? { ok: true, value: r.scene, posed: r.posed } : r;
  });
}

type Box = NonNullable<ReturnType<typeof sceneBox>>;

function union(a: Box | null, b: Box | null): Box | null {
  if (a === null) return b === null ? null : { min: [...b.min], max: [...b.max] };
  if (b === null) return a;
  return {
    min: [0, 1, 2].map((k) => Math.min(a.min[k]!, b.min[k]!)) as Box['min'],
    max: [0, 1, 2].map((k) => Math.max(a.max[k]!, b.max[k]!)) as Box['max'],
  };
}

/** Draw `views` of `head` (and of `base` at the same cameras), bounded by `limits`. */
export async function renderViews(
  workshop: Workshop,
  regenMs: number,
  views: readonly ViewInput[],
  head: ManufaktureDocument,
  base: ManufaktureDocument | null,
  limits: ImageLimits,
): Promise<{ drawn: Drawn[]; failed: Failed[] }> {
  const headScenes = await workshop.run(head, regenMs, async (b) =>
    scenesOf(head, b.result, views),
  );
  const baseScenes =
    base === null
      ? null
      : await workshop.run(base, regenMs, async (b) => scenesOf(base, b.result, views));

  // With a comparison, a view that does not frame itself is framed on what both sides draw.
  const boxes = new Map<Scene, Box | null>();
  const boxOf = (s: SceneOrError): Box | null => {
    if (!s.ok) return null;
    if (!boxes.has(s.value)) boxes.set(s.value, sceneBox(s.value));
    return boxes.get(s.value)!;
  };

  const drawn: Drawn[] = [];
  const failed: Failed[] = [];
  let total = 0;
  views.forEach((view, i) => {
    const o = options(view);
    const headScene = headScenes[i]!;
    const baseScene = baseScenes === null ? null : baseScenes[i]!;
    if (baseScene !== null) {
      o.camera = sharedCamera(
        { name: 'view', ...(o.camera !== undefined ? { camera: o.camera } : {}) },
        union(boxOf(headScene), boxOf(baseScene)),
        { width: o.width ?? 1024, height: o.height ?? 768 },
      );
    }
    const sides: ['head' | 'base', SceneOrError][] = [['head', headScene]];
    if (baseScene !== null) sides.push(['base', baseScene]);
    for (const [side, scene] of sides) {
      if (!scene.ok) {
        failed.push({ view: i, side, code: scene.code, message: scene.message });
        continue;
      }
      const r = render(scene.value, o);
      if (!r.ok) {
        failed.push({ view: i, side, code: r.error.code, message: r.error.message });
        continue;
      }
      const size = r.value.png.length;
      if (size > limits.imageBytes || total + size > limits.totalImageBytes) {
        failed.push({
          view: i,
          side,
          code: 'too-large',
          message: `The image is ${size} bytes; at most ${limits.imageBytes} each and ${limits.totalImageBytes} a call. Ask for fewer or smaller views.`,
        });
        continue;
      }
      total += size;
      drawn.push({
        view: i,
        side,
        png: r.value.png,
        width: r.value.width,
        height: r.value.height,
        mmPerPixel: r.value.mmPerPixel,
        unmatched: r.value.unmatched,
        ...(scene.posed !== undefined ? { assembly: scene.posed } : {}),
      });
    }
  });
  return { drawn, failed };
}
