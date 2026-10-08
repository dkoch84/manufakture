// Approach 2: hidden-line views from the drawing pipeline, rasterised to PNG. Exactly what a
// drawing sheet does in the app: a drawing with one sheet per view is added to the document with
// a command, `RegenEngine.drawingView` projects the view (the kernel's `project` op, OCCT HLR),
// `drawingSheet` lays the sheet out with `packages/drawing`, `drawingToSvg` (`packages/io`) writes
// the SVG, and the SVG is rasterised:
//
// - with sharp (libvips and librsvg, native; in the tree only as a transitive dependency of
//   gltf-transform), as a stand-in for any SVG rasteriser package;
// - with a few lines of TypeScript that stroke the display list's curves directly (no SVG parse,
//   no native code), supersampled like the mesh rasteriser.
//
// Each view gets its own sheet (400 x 300 mm, 1024 x 768 px at 2.56 px/mm), scaled to fit; the
// frame is dropped from the display list. Hidden lines are off, smooth (tangent) edges on.

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import {
  applyCommand,
  type Command,
  type DrawingView,
  type ManufaktureDocument,
} from '../../../packages/core/src/index.ts';
import { curvePoints, viewBounds, type DisplayList } from '../../../packages/drawing/src/index.ts';
import { drawingToSvg } from '../../../packages/io/src/index.ts';
import type { Session } from './fixtures';
import { encodePng } from './png';

// librsvg draws SVG text with the system's fonts through fontconfig. A minimal container has none
// (every glyph a box); FONTCONFIG_FILE, or the unpacked fonts of the README's recipe, fix that.
const FONTS = '/tmp/chromelibs/fonts.conf';
if (!process.env.FONTCONFIG_FILE && existsSync(FONTS)) process.env.FONTCONFIG_FILE = FONTS;

const require = createRequire(import.meta.url);
type Sharp = typeof import('sharp').default;
const sharp: Sharp = require(
  join(import.meta.dirname, '../../../node_modules/.pnpm/node_modules/sharp'),
);

export const SHEET_W = 400;
export const SHEET_H = 300;
const MARGIN = 10;
const D = 'drawing#1';
const PART = 'part#1';

export interface HlrView {
  name: string;
  direction: DrawingView['direction'];
  /** A domain view's source (the shed's framing elevation); default a view of the part. */
  domain?: Record<string, unknown>;
}

export const HLR_VIEWS: readonly HlrView[] = [
  { name: 'iso', direction: 'isometric' },
  { name: 'front', direction: 'front' },
  { name: 'top', direction: 'top' },
  { name: 'right', direction: 'right' },
];

/** The shed's front wall as a framing elevation (a construction domain view, M6 T6.4a). */
export const SHED_ELEVATION: HlrView = {
  name: 'elevation',
  direction: 'front',
  domain: { kind: 'elevation', wall: 'extension#1' },
};

const mm = (v: number) => ({ source: String(v), lengthUnit: 'mm', angleUnit: 'deg' });

function withDrawing(
  doc: ManufaktureDocument,
  views: readonly HlrView[],
  fit: (i: number) => { scale: number; position: [number, number] },
): ManufaktureDocument {
  const drawing = {
    id: D,
    name: 'Renders',
    nextIds: { sheet: views.length + 1, view: views.length + 1 },
    sheets: views.map((v, i) => {
      const { scale, position } = fit(i);
      const view: DrawingView = {
        id: `view#${i + 1}`,
        source: v.domain
          ? {
              domain: 'construction',
              part: PART,
              schemaVersion: 1,
              params: v.domain as Record<string, never>,
            }
          : { part: PART },
        direction: v.direction,
        // paper : model, both in mm.
        scale: { paper: mm(1), model: mm(1 / scale) } as DrawingView['scale'],
        position,
        options: { hidden: false, smooth: true },
      };
      return {
        id: `sheet#${i + 1}`,
        name: v.name,
        size: { width: mm(SHEET_W), height: mm(SHEET_H) },
        orientation: 'landscape' as const,
        views: [view],
        dimensions: [],
        notes: [],
      };
    }),
  };
  const r = applyCommand(doc, { type: 'addDrawing', drawing } as Command);
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value.document;
}

export interface HlrResult {
  name: string;
  /** View coordinates, model mm. */
  bounds: { min: [number, number]; max: [number, number] } | null;
  edges: number;
  /** Paper mm per model mm. */
  scale: number;
  display: DisplayList;
  svg: string;
  ms: { project: number; layout: number; svg: number };
}

/**
 * Every view of `views` for `doc`, which `s.engine` has just regenerated. `project` is the first,
 * uncached projection; `layout` the sheet request after it (the projection then comes from the
 * drawing stage's cache, since the scale is not part of its key).
 */
export async function hlrViews(
  s: Session,
  doc: ManufaktureDocument,
  views: readonly HlrView[],
): Promise<HlrResult[]> {
  const probe = withDrawing(doc, views, () => ({ scale: 1, position: [0, 0] }));
  const out: HlrResult[] = [];
  for (let i = 0; i < views.length; i++) {
    let t0 = performance.now();
    const v = await s.engine.drawingView(probe, D, `view#${i + 1}`);
    const project = performance.now() - t0;
    if (!v) throw new Error('superseded');
    if (v.diagnostics.length) throw new Error(JSON.stringify(v.diagnostics));
    // A domain view (the framing elevation) has no HLR bounds: its curves are an overlay.
    const b = v.bounds ?? (v.input ? viewBounds(v.input) : null);
    const w = b ? b.max[0] - b.min[0] : 1;
    const h = b ? b.max[1] - b.min[1] : 1;
    const scale = Math.min((SHEET_W - 2 * MARGIN) / w, (SHEET_H - 2 * MARGIN) / h);
    const cx = b ? (b.min[0] + b.max[0]) / 2 : 0;
    const cy = b ? (b.min[1] + b.max[1]) / 2 : 0;
    const position: [number, number] = [SHEET_W / 2 - cx * scale, SHEET_H / 2 - cy * scale];
    const fitted = withDrawing(doc, views, (j) =>
      j === i ? { scale, position } : { scale: 1, position: [0, 0] },
    );
    t0 = performance.now();
    const sheet = await s.engine.drawingSheet(fitted, D, `sheet#${i + 1}`);
    const layout = performance.now() - t0;
    if (!sheet?.display) throw new Error(`no display list for ${views[i]!.name}`);
    const display: DisplayList = {
      ...sheet.display,
      // No frame, and no title block: the construction domain puts its disclaimer there.
      items: sheet.display.items.filter(
        (it) => it.layer !== 'border' && it.layer !== 'titleBlock' && it.owner !== 'titleBlock',
      ),
    };
    t0 = performance.now();
    const svg = drawingToSvg(display, { title: views[i]!.name });
    const svgMs = performance.now() - t0;
    out.push({
      name: views[i]!.name,
      bounds: b ? { min: [b.min[0], b.min[1]], max: [b.max[0], b.max[1]] } : null,
      edges: v.edges.length + (v.input?.overlay?.length ?? 0),
      scale,
      display,
      svg,
      ms: { project, layout, svg: svgMs },
    });
  }
  return out;
}

const BACKGROUND = { r: 0xf6, g: 0xf7, b: 0xf9 };

/** The SVG as a 1024 x 768 PNG through sharp (librsvg), on the renders' background. */
export async function svgToPngSharp(svg: string, width = 1024, height = 768): Promise<Uint8Array> {
  // Through sharp, librsvg's output for an SVG sized in mm grows with density squared over 72
  // (measured: 72 dpi gives 1134 px for 400 mm, 96 dpi 2016, 144 dpi 4535), so the density for
  // `width` pixels is the geometric mean of the wanted dpi and 72. The resize is then a no-op
  // that only guards against rounding.
  const density = Math.sqrt((width / SHEET_W) * 25.4 * 72);
  const buf = await sharp(Buffer.from(svg), { density })
    .resize(width, height, { fit: 'fill' })
    .flatten({ background: BACKGROUND })
    .removeAlpha()
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toBuffer();
  return new Uint8Array(buf);
}

/**
 * The display list stroked in TypeScript: every curve item (lines, arcs, ellipse arcs, polylines)
 * flattened by `curvePoints` and drawn as a square brush of its layer's weight, supersampled.
 * Text, hatches and dashes are left out (the review views have none: no dimensions, no hidden
 * lines, no sections).
 */
export function rasterizeDisplay(
  list: DisplayList,
  width = 1024,
  height = 768,
  ss = 3,
): { rgb: Uint8Array; png: Uint8Array; rasterMs: number; encodeMs: number } {
  const t0 = performance.now();
  const W = width * ss;
  const H = height * ss;
  const k = (W / list.width) as number; // supersampled px per paper mm
  const ink = new Uint8Array(W * H);
  for (const item of list.items) {
    if (item.kind === 'text' || item.kind === 'hatch') continue;
    const style = list.layers[item.layer];
    if (!style) continue;
    const half = Math.max(0.5, (style.weight * k) / 2);
    const pts = curvePoints(item as never, 0.02);
    if (item.kind === 'polyline' && item.closed && pts.length > 1) pts.push(pts[0]!);
    for (let i = 0; i + 1 < pts.length; i++) {
      const ax = pts[i]![0] * k;
      const ay = H - pts[i]![1] * k;
      const bx = pts[i + 1]![0] * k;
      const by = H - pts[i + 1]![1] * k;
      const steps = Math.max(1, Math.ceil(Math.max(Math.abs(bx - ax), Math.abs(by - ay))));
      for (let s = 0; s <= steps; s++) {
        const x = ax + ((bx - ax) * s) / steps;
        const y = ay + ((by - ay) * s) / steps;
        const x0 = Math.max(0, Math.round(x - half));
        const x1 = Math.min(W - 1, Math.round(x + half) - 1);
        const y0 = Math.max(0, Math.round(y - half));
        const y1 = Math.min(H - 1, Math.round(y + half) - 1);
        for (let yy = y0; yy <= y1; yy++) ink.fill(1, yy * W + x0, yy * W + x1 + 1);
      }
    }
  }
  const rgb = new Uint8Array(width * height * 3);
  const n = ss * ss;
  const bg = [BACKGROUND.r, BACKGROUND.g, BACKGROUND.b];
  const fg = [0x1f, 0x23, 0x28];
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      let c = 0;
      for (let j = 0; j < ss; j++)
        for (let i = 0; i < ss; i++) c += ink[(y * ss + j) * W + x * ss + i]!;
      for (let ch = 0; ch < 3; ch++)
        rgb[3 * (y * width + x) + ch] = ((bg[ch]! * (n - c) + fg[ch]! * c + (n >> 1)) / n) | 0;
    }
  const rasterMs = performance.now() - t0;
  const t1 = performance.now();
  const png = encodePng(rgb, width, height);
  return { rgb, png, rasterMs, encodeMs: performance.now() - t1 };
}
