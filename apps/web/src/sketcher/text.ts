// Text in the sketcher (M3 plan, T3.2d): what the Text tool places, how a text entity becomes a
// request to the regen worker's text outliner (the same code, fonts and watchdog regen uses), and
// how the reply is placed, drawn and hit tested while the sketch is edited.
//
// The outliner lays a text out in its own frame (anchor at the origin, unturned); the sketcher
// places that at the entity's current anchor and angle (`placeOutline`), so dragging the anchor
// moves the text at once without asking the worker again. A preview is keyed by what the layout
// depends on (font, string, evaluated size and spacing, alignment), never by the anchor.
//
// SVG artwork (an outline with an `svg` source, M5 T5.8) is previewed the same way, but its
// regions are made here on the main thread (`svgPreviewOf`): its paths are already in the
// document, and `svgOutlineRegions` caches by paths array (the session keeps an artwork's source
// object across solves, `keepSvgSources`), so a preview is made once per artwork and scale, and a
// drag only places it again. All the SVG previews of one pass share one work budget,
// `SVG_PREVIEW_WORK` (a second or two at most), so a document of many costly outlines cannot hold
// the page up; one that runs out shows an error here (tried again in a later pass when other
// outlines had spent part of the budget, never when it alone spent all of it), and the model is
// built anyway.
//
// User fonts are untrusted input (ADR 0011 decision 7 and its amendment). The main thread only
// checks a file's name, size and first four bytes (`checkFontFile`) and never parses it: reading
// its names and permissions is the text worker's job, under the regen worker's watchdog
// (`Texter.readFont`). Everything read from a font is shown as plain React text.

import {
  MAX_FONT_TOTAL_BYTES,
  MAX_IMPORT_BYTES,
  fontBytes,
  type DocumentFont,
  type OutlineAlign,
  type OutlineEntity,
  type StoredExpression,
  type SvgOutlineSource,
  type TextOutlineSource,
} from '@manufakture/core';
import type {
  FontReadReply,
  FontSummary,
  TextPreviewOptions,
  TextReply,
  TextRequest,
} from '@manufakture/regen';
import {
  MAX_FLATTEN_POINTS,
  flattenRegion,
  flattenSegment,
  OutlineBudget,
  placeOutline,
  svgOutlineRegions,
  type OutlinePartsResult,
  type Region,
  type OutlineShape,
  type RegionCurve,
} from '@manufakture/sketch/geometry';
import type { SketchEntity, Vec2 } from '@manufakture/sketch/model';
import { evaluate } from '@manufakture/units';
import type { Variables } from './values';

/** What the sketcher needs of the regen worker for text; absent in kernel-free scenes. */
export interface Texter {
  /**
   * Lay out one text in its own frame. Null when the worker went away before it answered. The
   * texts asked for in one pass of the sketcher give the same `pass`: they share a time budget in
   * the worker (`TextPreviewOptions`), as a regen's texts do.
   */
  outline(request: TextRequest, options?: TextPreviewOptions): Promise<TextReply | null>;
  /** Read a user font's names and permissions, under the watchdog. Null as for `outline`. */
  readFont(fileName: string, bytes: Uint8Array): Promise<FontReadReply | null>;
}

// Defaults ------------------------------------------------------------------------------------

/** A new text's string, selected in the panel so typing replaces it. */
export const DEFAULT_TEXT = 'Text';
/** A new text's cap height: well above the recommended minimum for the bundled font. */
export const DEFAULT_TEXT_SIZE_MM = 6;
export const DEFAULT_ALIGN: OutlineAlign = { horizontal: 'center', vertical: 'middle' };
/**
 * The smallest cap height at which the bundled font's stems clear the minimum wall at a 0.4 mm
 * nozzle (packages/text README, "Checks": the 300-unit stem of "l" against 0.84 mm).
 */
export const RECOMMENDED_MIN_SIZE_MM = 4.2;

/**
 * How long the sketcher waits after the last change of a text before it asks for a new layout:
 * typing a word sends one request, not one per key. Measured (docs/user/text.md): a warm layout of
 * a short label takes a few milliseconds in the text worker; the first one, which starts the
 * worker and loads the font, about 75 ms.
 */
export const TEXT_PREVIEW_DEBOUNCE_MS = 120;

/** A stored length in millimetres, as the document stores what the user types. */
export function millimetres(value: number): StoredExpression {
  return { source: String(value), lengthUnit: 'mm', angleUnit: 'deg' };
}

/** An outline whose source is text. */
export type TextOutline = OutlineEntity & { source: TextOutlineSource };
/** An outline whose source is SVG artwork. */
export type SvgOutline = OutlineEntity & { source: SvgOutlineSource };

export function isTextOutline(e: { kind: string; source?: unknown }): e is TextOutline {
  return e.kind === 'outline' && (e as OutlineEntity).source.kind === 'text';
}

export function isSvgOutline(e: { kind: string; source?: unknown }): e is SvgOutline {
  return e.kind === 'outline' && (e as OutlineEntity).source.kind === 'svg';
}

// Requests -----------------------------------------------------------------------------------

export type TextRequestOutcome =
  { ok: true; key: string; request: TextRequest } | { ok: false; key: string; message: string };

function evaluated(
  expression: StoredExpression | undefined,
  kind: 'length' | 'number',
  fallback: number,
  variables: Variables,
): number | null {
  if (!expression) return fallback;
  const r = evaluate(expression.source, {
    expected: kind,
    lengthUnit: expression.lengthUnit,
    angleUnit: expression.angleUnit,
    variables: (n) => variables[n],
  });
  return r.ok && Number.isFinite(r.value) ? r.value : null;
}

/**
 * What to ask the outliner for a text entity, with the key its layout depends on; or why it
 * cannot be laid out (a font the sketch does not have, a size that does not evaluate).
 */
export function textRequestOf(
  entity: TextOutline,
  fonts: readonly DocumentFont[],
  variables: Variables,
): TextRequestOutcome {
  const { source } = entity;
  const font = fonts.find((f) => f.id === source.font);
  const size = evaluated(source.size, 'length', Number.NaN, variables);
  const letterSpacing = evaluated(source.letterSpacing, 'length', 0, variables);
  const lineSpacing = evaluated(source.lineSpacing, 'number', 1, variables);
  const key = JSON.stringify([
    source.font,
    font?.source.sha256 ?? null,
    source.text,
    size,
    letterSpacing,
    lineSpacing,
    source.align.horizontal,
    source.align.vertical,
  ]);
  if (!font) return { ok: false, key, message: `The font ${source.font} is not in the document.` };
  if (size === null || !(size > 0)) {
    return { ok: false, key, message: 'The size must be a length above 0.' };
  }
  if (letterSpacing === null)
    return { ok: false, key, message: 'The letter spacing must be a length.' };
  if (lineSpacing === null)
    return { ok: false, key, message: 'The line spacing must be a number.' };
  const request: TextRequest = {
    font:
      font.source.kind === 'bundled'
        ? { kind: 'bundled', id: font.source.id }
        : {
            kind: 'file',
            fileName: font.source.fileName,
            size: font.source.size,
            sha256: font.source.sha256,
            data: font.source.data,
          },
    text: source.text,
    size,
    align: source.align,
    letterSpacing,
    lineSpacing,
  };
  return { ok: true, key, request };
}

// Previews -----------------------------------------------------------------------------------

/** The layout of one text, as the sketcher last got it. */
export interface TextPreview {
  /** `textRequestOf(...).key` of what this answers. */
  key: string;
  /** The glyph regions in the text's frame, and per path the glyph's position in the text. */
  layout: { glyphs: number[]; result: OutlinePartsResult } | null;
  /** Why the text cannot be shown, if it cannot. */
  error: string | null;
  /** Characters the font lacks, and other warnings about the layout. */
  warnings: string[];
}

/** A reply of the outliner as a preview. */
export function previewOf(key: string, reply: TextReply | null): TextPreview {
  if (reply === null) {
    return { key, layout: null, error: 'The text could not be laid out.', warnings: [] };
  }
  if (!reply.ok) return { key, layout: null, error: reply.message, warnings: [] };
  const warnings = [...reply.warnings];
  if (reply.missing.length > 0) {
    warnings.unshift(
      `The font has no glyph for ${reply.missing.map((c) => `"${c}"`).join(', ')}; ${reply.missing.length === 1 ? 'it is' : 'they are'} left out.`,
    );
  }
  for (const issue of reply.result.issues) {
    if (issue.severity !== 'info') warnings.push(issue.message);
  }
  return { key, layout: { glyphs: reply.glyphs, result: reply.result }, error: null, warnings };
}

/**
 * Work all the SVG previews of one pass may spend together on the main thread: 100 million of
 * `OutlineBudget`'s steps, about a second or two (regen's per-pass budget is 250 million, in its
 * worker).
 */
export const SVG_PREVIEW_WORK = 100_000_000;

/** A budget for the SVG previews of one pass. */
export function svgPreviewBudget(): OutlineBudget {
  return new OutlineBudget(SVG_PREVIEW_WORK);
}

/** Numbers for paths arrays, so a preview key changes when the artwork is replaced. */
const pathsIds = new WeakMap<object, number>();
let nextPathsId = 1;

/** What an SVG preview depends on: the paths (by identity) and the evaluated scale. */
export function svgPreviewKey(entity: SvgOutline, variables: Variables): string {
  const { source } = entity;
  let id = pathsIds.get(source.paths);
  if (id === undefined) {
    id = nextPathsId++;
    pathsIds.set(source.paths, id);
  }
  return JSON.stringify(['svg', id, evaluated(source.scale, 'number', 1, variables)]);
}

/**
 * The preview of SVG artwork, made at once: its regions at its evaluated scale, keyed by the
 * paths (by identity) and the scale. An error when the scale does not evaluate to a number above
 * 0, or when the artwork cannot be converted.
 */
export function svgPreviewOf(
  entity: SvgOutline,
  variables: Variables,
  budget: OutlineBudget = svgPreviewBudget(),
): TextPreview {
  const { source } = entity;
  const scale = evaluated(source.scale, 'number', 1, variables);
  const key = svgPreviewKey(entity, variables);
  if (scale === null || !(scale > 0)) {
    return { key, layout: null, error: 'The scale must be a number above 0.', warnings: [] };
  }
  const shared = budget.used;
  const result = svgOutlineRegions(source.paths, scale, { budget });
  const failed = result.issues.find((i) => i.severity === 'error');
  if (failed && budget.exhausted) {
    // Refused for the budget. When earlier previews of the pass had spent part of it, that says
    // nothing about this artwork: stored under a key no pass asks for, so the next pass tries it
    // again. When this artwork alone spent a whole budget, it would again: kept under its key.
    return {
      key: shared ? `${key}#budget` : key,
      layout: null,
      error:
        'The SVG artwork of this sketch is too complex to show here; the model is still built from it.',
      warnings: [],
    };
  }
  if (failed) {
    return {
      key,
      layout: null,
      error: `The artwork cannot be shown: ${failed.message}`,
      warnings: [],
    };
  }
  return {
    key,
    layout: { glyphs: source.paths.map((_, i) => i), result },
    error: null,
    warnings: result.issues.filter((i) => i.severity === 'warning').map((i) => i.message),
  };
}

/** The placed shapes of a text, at its current anchor and angle; none until it is laid out. */
export function placedText(
  entity: OutlineEntity,
  preview: TextPreview | undefined,
): OutlineShape[] {
  if (!preview?.layout) return [];
  return placeOutline(entity, preview.layout.glyphs, preview.layout.result);
}

/** The placed shapes of every text in the sketch with a preview, by entity id. */
export function placedTexts(
  entities: readonly SketchEntity[],
  previews: Readonly<Record<string, TextPreview>>,
): Map<string, OutlineShape[]> {
  const out = new Map<string, OutlineShape[]>();
  for (const e of entities) {
    if (e.kind !== 'outline') continue;
    const shapes = placedText(e, previews[e.id]);
    if (shapes.length > 0) out.set(e.id, shapes);
  }
  return out;
}

/**
 * `placedTexts` that remembers its last answer: a text whose layout, anchor and angle did not
 * change keeps its placed shapes, and when no text changed the same map comes back, so drawing a
 * drag of other geometry does not place (and flatten) every text again on every frame.
 */
export function placedTextsCache(): (
  entities: readonly SketchEntity[],
  previews: Readonly<Record<string, TextPreview>>,
) => Map<string, OutlineShape[]> {
  type Entry = { layout: TextPreview['layout']; x: number; y: number; angle: number };
  let last = new Map<string, OutlineShape[]>();
  let entries = new Map<string, Entry>();
  return (entities, previews) => {
    const out = new Map<string, OutlineShape[]>();
    const next = new Map<string, Entry>();
    let same = true;
    for (const e of entities) {
      if (e.kind !== 'outline') continue;
      const layout = previews[e.id]?.layout ?? null;
      if (!layout) continue;
      const entry: Entry = { layout, x: e.anchor[0], y: e.anchor[1], angle: e.angle };
      const was = entries.get(e.id);
      const kept = last.get(e.id);
      let shapes: OutlineShape[];
      if (
        kept &&
        was &&
        was.layout === layout &&
        was.x === entry.x &&
        was.y === entry.y &&
        was.angle === entry.angle
      ) {
        shapes = kept;
      } else {
        shapes = placedText(e, previews[e.id]);
        same = false;
      }
      next.set(e.id, entry);
      if (shapes.length > 0) out.set(e.id, shapes);
    }
    if (same && out.size === last.size && [...out.keys()].every((k) => last.has(k))) return last;
    last = out;
    entries = next;
    return out;
  };
}

// Drawing and hit testing ----------------------------------------------------------------------

/** Points along a curve from its start to its end (both included), within `tolerance`. */
export function curvePoints(c: RegionCurve, tolerance: number): Vec2[] {
  switch (c.kind) {
    case 'line':
      return [c.start, c.end];
    case 'bezier':
      return flattenSegment(
        {
          kind: 'bezier',
          points: c.points,
          contour: 0,
          index: 0,
          split: 0,
          piece: 0,
          reversed: false,
        },
        tolerance,
      );
    case 'arc':
    case 'circle': {
      const sense = c.reversed ? -1 : 1;
      const a0 = Math.atan2(c.start[1] - c.center[1], c.start[0] - c.center[0]);
      let sweep = 2 * Math.PI;
      if (c.kind === 'arc') {
        const a1 = Math.atan2(c.end[1] - c.center[1], c.end[0] - c.center[0]);
        sweep =
          ((((a1 - a0) * sense) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) || 2 * Math.PI;
      }
      const step = tolerance < c.radius ? 2 * Math.acos(1 - tolerance / c.radius) : Math.PI / 2;
      const n = Math.min(256, Math.max(1, Math.ceil(sweep / Math.max(step, 1e-3))));
      const out: Vec2[] = [];
      for (let k = 0; k <= n; k++) {
        const a = a0 + (sense * sweep * k) / n;
        out.push([c.center[0] + c.radius * Math.cos(a), c.center[1] + c.radius * Math.sin(a)]);
      }
      return out;
    }
  }
}

/** One glyph of a placed text: its loops (outer and holes) as closed polygons. */
export interface GlyphOutline {
  /** `<entity id>.g<glyph>`. */
  key: string;
  loops: Vec2[][];
  /**
   * Drawn coarser than asked: past the point budget (`GLYPH_POINT_BUDGET`) a glyph is drawn as
   * its control polygon, or as its box when even that does not fit.
   */
  approximate: boolean;
}

/**
 * Most points `glyphOutlines` flattens one drawing's glyphs to, all together: every text of every
 * sketch the drawing shows shares one `PointBudget`. A text may have up to `MAX_TEXT_CURVES`
 * (500,000) curves and a Bezier up to 256 points at a fine tolerance, and a document may hold any
 * number of sketches, so a shared document with a hostile font could otherwise make drawing it
 * take the tab down. Past the budget the remaining glyphs are drawn as control polygons, then as
 * boxes (four points each).
 */
export const GLYPH_POINT_BUDGET = 200_000;

/**
 * Points left to flatten glyphs to, shared by the `glyphOutlines` calls of one drawing (every
 * text of the sketch being edited, or every committed sketch): each call takes what it flattens
 * from `left`. `exhausted` is set once a glyph did not fit; from then on no call flattens
 * anything, so a failed attempt (which may flatten up to `left` points before it gives up)
 * happens once per drawing, not once per call.
 */
export interface PointBudget {
  left: number;
  exhausted: boolean;
}

/** A fresh `PointBudget` of `points` (default `GLYPH_POINT_BUDGET`). */
export function pointBudget(points: number = GLYPH_POINT_BUDGET): PointBudget {
  return { left: points, exhausted: false };
}

/**
 * The finest tolerance a glyph is flattened to, as a fraction of its size: zooming far in on a
 * letter does not make its curves cost more than a thousandth of its height.
 */
export const GLYPH_TOLERANCE_FRACTION = 1e-3;

/** The glyph part of a shape key: `e5.g3.c0#2` gives `e5.g3`. */
function glyphKey(shapeKey: string): string {
  const at = shapeKey.lastIndexOf('.c');
  return at < 0 ? shapeKey : shapeKey.slice(0, at);
}

/** The box around loops of curves (Bezier control points and whole circles included). */
function curvesBox(loops: readonly (readonly RegionCurve[])[]): Box | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const add = (x: number, y: number) => {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  };
  for (const curves of loops) {
    for (const c of curves) {
      add(c.start[0], c.start[1]);
      if (c.kind === 'bezier') for (const p of c.points) add(p[0], p[1]);
      else if (c.kind !== 'line') {
        add(c.center[0] - c.radius, c.center[1] - c.radius);
        add(c.center[0] + c.radius, c.center[1] + c.radius);
      }
    }
  }
  return Number.isFinite(x0) && Number.isFinite(x1) ? { min: [x0, y0], max: [x1, y1] } : null;
}

/** Loops flattened within `tolerance`, or null as soon as they pass `limit` points. */
function flattenLoops(
  loops: readonly (readonly RegionCurve[])[],
  tolerance: number,
  limit: number,
): { loops: Vec2[][]; points: number } | null {
  const out: Vec2[][] = [];
  let points = 0;
  for (const curves of loops) {
    const loop: Vec2[] = [];
    for (const c of curves) {
      const pts = curvePoints(c, tolerance);
      points += pts.length - 1;
      if (points > limit) return null;
      for (let i = 0; i < pts.length - 1; i++) loop.push(pts[i]!);
    }
    out.push(loop);
  }
  return { loops: out, points };
}

/** Points of loops drawn as their control polygons: each curve's start and control points. */
function controlPointCount(loops: readonly (readonly RegionCurve[])[]): number {
  let n = 0;
  for (const curves of loops) {
    for (const c of curves) n += c.kind === 'bezier' ? Math.max(1, c.points.length - 1) : 1;
  }
  return n;
}

function controlPolygons(loops: readonly (readonly RegionCurve[])[]): Vec2[][] {
  return loops.map((curves) => {
    const loop: Vec2[] = [];
    for (const c of curves) {
      if (c.kind === 'bezier' && c.points.length > 1) loop.push(...c.points.slice(0, -1));
      else loop.push(c.start);
    }
    return loop;
  });
}

/**
 * A placed text as one outline per glyph (the M3 plan's "one path per glyph": a paragraph of
 * text draws as a few dozen paths, not thousands), each loop flattened within `tolerance` (but no
 * finer than `GLYPH_TOLERANCE_FRACTION` of the glyph's size).
 *
 * The flattened points of all glyphs together stay under `budget` (a number of points, or a
 * `PointBudget` shared with the drawing's other calls, which this call consumes): once a glyph
 * does not fit, it and every glyph after it are drawn as control polygons while those fit, then
 * as boxes. The work is bounded the same way: no more than the budget's points are ever
 * flattened, and the rest costs one pass over the curves.
 */
export function glyphOutlines(
  shapes: readonly OutlineShape[],
  tolerance: number,
  budget: number | PointBudget = GLYPH_POINT_BUDGET,
): GlyphOutline[] {
  const shared = typeof budget === 'number' ? pointBudget(budget) : budget;
  const byGlyph = new Map<string, RegionCurve[][]>();
  for (const s of shapes) {
    const key = glyphKey(s.key);
    let loops = byGlyph.get(key);
    if (!loops) byGlyph.set(key, (loops = []));
    loops.push(s.outer.curves, ...s.holes.map((h) => h.curves));
  }
  const out: GlyphOutline[] = [];
  for (const [key, loops] of byGlyph) {
    const box = curvesBox(loops);
    if (!box) continue;
    const extent = Math.max(box.max[0] - box.min[0], box.max[1] - box.min[1]);
    let t = Math.max(tolerance, extent * GLYPH_TOLERANCE_FRACTION);
    if (!(Number.isFinite(t) && t > 0)) t = Number.isFinite(extent) && extent > 0 ? extent : 1;
    if (!shared.exhausted) {
      const flat = flattenLoops(loops, t, shared.left);
      if (flat) {
        shared.left -= flat.points;
        out.push({ key, loops: flat.loops, approximate: false });
        continue;
      }
      // From here on nothing more is flattened, in this call or the drawing's next ones, so the
      // work stays bounded too.
      shared.exhausted = true;
    }
    const n = controlPointCount(loops);
    if (n <= shared.left) {
      shared.left -= n;
      out.push({ key, loops: controlPolygons(loops), approximate: true });
      continue;
    }
    const { min, max } = box;
    out.push({
      key,
      loops: [[min, [max[0], min[1]], max, [min[0], max[1]]]],
      approximate: true,
    });
  }
  return out;
}

/** Most points the region fills of one sketch are flattened to, all regions together. */
export const FILL_POINT_BUDGET = 200_000;

/**
 * The fills of a sketch's regions (letters included) as polygons, flattened under `maxPoints`
 * points in all. A region that does not fit (`flattenRegion` throws a `RangeError` after
 * flattening up to what was left) ends the fills: it and every region after it draw their
 * outline only, so the work stays within about `maxPoints` points however many regions there
 * are, on every frame of a drag. No one region gets more than `MAX_FLATTEN_POINTS`, and one
 * whose refining runs past `MAX_REFINE_WORK` throws the same `RangeError`. A region that
 * fails otherwise (degenerate) is skipped.
 */
export function regionFills(
  regions: readonly Region[],
  maxPoints: number = FILL_POINT_BUDGET,
  flatten: typeof flattenRegion = flattenRegion,
): Vec2[][][] {
  const out: Vec2[][][] = [];
  let left = maxPoints;
  for (const r of regions) {
    if (left <= 0) break;
    try {
      const loops = flatten(
        r,
        { linear: 0.05, angular: 0.2 },
        {
          maxPoints: Math.min(left, MAX_FLATTEN_POINTS),
        },
      );
      left -= loops.reduce((n, l) => n + l.length, 0);
      out.push(loops);
    } catch (error) {
      if (error instanceof RangeError) break;
    }
  }
  return out;
}

export interface Box {
  min: Vec2;
  max: Vec2;
}

/** The box around a placed text's loops (Bezier control points included), or null. */
export function shapesBox(shapes: readonly OutlineShape[]): Box | null {
  let min: Vec2 = [Infinity, Infinity];
  let max: Vec2 = [-Infinity, -Infinity];
  const add = (p: Vec2) => {
    min = [Math.min(min[0], p[0]), Math.min(min[1], p[1])];
    max = [Math.max(max[0], p[0]), Math.max(max[1], p[1])];
  };
  for (const s of shapes) {
    for (const c of s.outer.curves) {
      add(c.start);
      if (c.kind === 'bezier') c.points.forEach(add);
      else if (c.kind !== 'line') {
        add([c.center[0] - c.radius, c.center[1] - c.radius]);
        add([c.center[0] + c.radius, c.center[1] + c.radius]);
      }
    }
  }
  return Number.isFinite(min[0]) ? { min, max } : null;
}

/** Distance from `p` to a box: 0 inside it. */
export function boxDistance(box: Box, p: Vec2): number {
  const dx = Math.max(box.min[0] - p[0], 0, p[0] - box.max[0]);
  const dy = Math.max(box.min[1] - p[1], 0, p[1] - box.max[1]);
  return Math.hypot(dx, dy);
}

// Fonts -----------------------------------------------------------------------------------------

/** The extensions **Add font** accepts: TrueType and OpenType files (ADR 0011 decision 7). */
export const FONT_EXTENSIONS = ['.ttf', '.otf'] as const;

/**
 * Why a file cannot be a font to add, or null: checked on the main thread before anything reads
 * it, from its name, its size and its first four bytes (the sfnt version). Collections, WOFF and
 * WOFF2 are refused with a message that says so. The worker parses it only after this passes.
 */
export function checkFontFile(name: string, size: number, head: Uint8Array): string | null {
  const lower = name.toLowerCase();
  if (!FONT_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
    if (lower.endsWith('.ttc') || lower.endsWith('.otc')) {
      return 'Font collections (.ttc) are not supported: add one font of it as a .ttf or .otf file.';
    }
    if (lower.endsWith('.woff') || lower.endsWith('.woff2')) {
      return 'WOFF and WOFF2 web fonts are not supported: add the .ttf or .otf file.';
    }
    return 'Choose a TrueType (.ttf) or OpenType (.otf) font file.';
  }
  if (size <= 0) return 'The file is empty.';
  if (size > MAX_IMPORT_BYTES) {
    return `The file is ${(size / 1048576).toFixed(1)} MiB; a font may be at most ${MAX_IMPORT_BYTES / 1048576} MiB.`;
  }
  const tag = String.fromCharCode(...head.subarray(0, 4));
  const truetype = head[0] === 0 && head[1] === 1 && head[2] === 0 && head[3] === 0;
  if (truetype || tag === 'OTTO' || tag === 'true') return null;
  if (tag === 'ttcf')
    return 'Font collections are not supported: add one font as a .ttf or .otf file.';
  if (tag === 'wOFF' || tag === 'wOF2') {
    return 'WOFF and WOFF2 web fonts are not supported: add the .ttf or .otf file.';
  }
  return 'The file is not a TrueType or OpenType font.';
}

/** How a font's embedding permissions read (OS/2 `fsType`, ADR 0011 decision 7). */
export function embeddingLabel(embedding: FontSummary['embedding']): string {
  const level = {
    installable: 'Installable: may be embedded and kept',
    restricted: "Restricted: may not be embedded without the owner's permission",
    'preview-and-print': 'Preview and print: may be embedded for viewing and printing only',
    editable: 'Editable: may be embedded and edited',
  }[embedding.level];
  const flags = [
    embedding.noSubsetting ? 'no subsetting' : null,
    embedding.bitmapOnly ? 'bitmap embedding only' : null,
  ].filter((f): f is string => f !== null);
  return flags.length > 0 ? `${level} (${flags.join(', ')})` : level;
}

/**
 * `s` cut to at most `max` UTF-16 code units (the length core's schema checks), never between
 * the two halves of a surrogate pair.
 */
export function cutUtf16(s: string, max: number): string {
  if (s.length <= max) return s;
  let end = max;
  const last = s.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return s.slice(0, end);
}

/** A user font as the document stores it: its bytes as base64, size and SHA-256. */
export function documentFont(
  id: string,
  summary: Pick<FontSummary, 'family' | 'style'>,
  fileName: string,
  bytes: Uint8Array,
  sha256: string,
  toBase64: (bytes: Uint8Array) => string,
): DocumentFont {
  // Core caps the names at 200 characters (and the file name at 255) and requires them
  // non-empty. Core counts UTF-16 code units, as JavaScript strings do, so cut in those.
  const name = (s: string, fallback: string) => cutUtf16(s.trim() || fallback, 200);
  return {
    id,
    family: name(summary.family, 'Unnamed font'),
    style: name(summary.style, 'Regular'),
    source: {
      kind: 'file',
      fileName: cutUtf16(fileName, 255) || 'font.ttf',
      size: bytes.length,
      sha256,
      data: toBase64(bytes),
    },
  };
}

const mib = (n: number) => `${(n / (1024 * 1024)).toFixed(1)} MiB`;

/**
 * Why a font of `size` bytes cannot be added to a document holding `fonts`, or null: core keeps a
 * document's fonts under `MAX_FONT_TOTAL_BYTES` in all, and refuses the font otherwise.
 */
export function fontTotalProblem(fonts: readonly DocumentFont[], size: number): string | null {
  const total = fontBytes([...fonts, { source: { kind: 'file', size } }]);
  if (total <= MAX_FONT_TOTAL_BYTES) return null;
  return `The document's fonts would hold ${mib(total)}; at most ${mib(MAX_FONT_TOTAL_BYTES)} of fonts are allowed: delete a font first.`;
}

/** How a font is listed: family and style, and where it comes from. */
export function fontLabel(font: DocumentFont): string {
  return `${font.family} ${font.style}${font.source.kind === 'bundled' ? ' (built in)' : ''}`;
}
