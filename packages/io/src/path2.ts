// The shared 2D layer under the SVG, DXF and PDF writers: a sheet of paths and text on named
// layers, in millimetres with y up. Drawings (T4.4f, through `drawing-export.ts`) and the CAM
// laser and plasma export (M5 T5.6a) both map their own geometry onto it, so neither depends on
// the other and the writers exist once.

import { HELVETICA_CAP_HEIGHT, HELVETICA_DESCENT, helveticaTextWidth } from './helvetica';

export type Vec2 = readonly [number, number];

/**
 * One piece of a path. Angles are radians, counter-clockwise from +x with y up. An arc runs from
 * `start` to `end`: counter-clockwise when `end > start`, clockwise when `end < start`, and a
 * difference of 2 pi (either sign) is a full circle. An ellipse arc's angles are eccentric
 * anomalies (the parameter `t` of `center + major cos(t) u + minor sin(t) v`, with `u` at
 * `rotation` and `v` a quarter turn counter-clockwise from it), with the same sign rule.
 */
export type Segment2 =
  | { readonly kind: 'line'; readonly a: Vec2; readonly b: Vec2 }
  | {
      readonly kind: 'arc';
      readonly center: Vec2;
      readonly radius: number;
      readonly start: number;
      readonly end: number;
    }
  | {
      readonly kind: 'ellipseArc';
      readonly center: Vec2;
      readonly major: number;
      readonly minor: number;
      readonly rotation: number;
      readonly start: number;
      readonly end: number;
    };

/**
 * A path: segments in order, each meant to start where the previous one ends (writers start a
 * new subpath where one does not, within `JOIN_TOLERANCE`). `closed` joins the last end back to
 * the first start with a line when they differ. `fill` fills it (non-zero) with the layer colour
 * as well as stroking it.
 */
export interface Path2 {
  readonly kind: 'path';
  readonly layer: string;
  readonly segments: readonly Segment2[];
  readonly closed?: boolean;
  readonly fill?: boolean;
  /** What the path belongs to (`view#1`, `dim#2`, a loop id); SVG writes it as `data-owner`. */
  readonly owner?: string;
}

export type TextAnchor = 'start' | 'middle' | 'end';
/** Where `at` is on the text: the baseline (`bottom`), half the cap height or the cap height. */
export type TextBaseline = 'bottom' | 'middle' | 'top';

export interface Text2 {
  readonly kind: 'text';
  readonly layer: string;
  readonly at: Vec2;
  readonly text: string;
  /** Cap height, millimetres. */
  readonly height: number;
  /** Counter-clockwise, radians. */
  readonly rotation: number;
  readonly anchor: TextAnchor;
  readonly baseline: TextBaseline;
  readonly owner?: string;
}

export type Item2 = Path2 | Text2;

export interface Layer2 {
  /** Unique; DXF layer names drop `<>/\":;?*|=` and backquote (replaced by `_`). */
  readonly name: string;
  /** Stroke width, millimetres (default 0.25). */
  readonly weight?: number;
  /** Dash pattern in millimetres, alternating dash and gap; empty or absent is continuous. */
  readonly dash?: readonly number[];
  /** DXF linetype name for a dashed layer (default `DASHED`); continuous layers use `CONTINUOUS`. */
  readonly lineType?: string;
  /** `#rrggbb` (default black). */
  readonly color?: string;
}

/**
 * What a writer writes: layers in drawing order (later layers on top) and items, each on a layer.
 * `size` is the paper in millimetres with the origin at its bottom left; without it, the writers
 * that need a page (SVG, PDF) use the items' bounds.
 */
export interface Sheet2 {
  readonly size?: { readonly width: number; readonly height: number };
  readonly layers: readonly Layer2[];
  readonly items: readonly Item2[];
  /** A title for the file's metadata (SVG `<title>`, PDF `/Title`). */
  readonly title?: string;
}

/** Endpoints closer than this (mm) count as joined. */
export const JOIN_TOLERANCE = 1e-6;

export const TAU = 2 * Math.PI;

export function line(a: Vec2, b: Vec2): Segment2 {
  return { kind: 'line', a, b };
}

/** Straight segments through `points`; `closed` joins the last point to the first. */
export function polylinePath(
  layer: string,
  points: readonly Vec2[],
  options: { closed?: boolean; fill?: boolean; owner?: string } = {},
): Path2 {
  const segments: Segment2[] = [];
  for (let i = 0; i + 1 < points.length; i++) segments.push(line(points[i]!, points[i + 1]!));
  return { kind: 'path', layer, segments, ...options };
}

/** The signed sweep, clamped to one turn either way. */
export function signedSweep(seg: { start: number; end: number }): number {
  const s = seg.end - seg.start;
  return Math.max(-TAU, Math.min(TAU, s));
}

export function isFullTurn(seg: { start: number; end: number }): boolean {
  return Math.abs(signedSweep(seg)) >= TAU - 1e-9;
}

export function ellipsePoint(
  e: Extract<Segment2, { kind: 'ellipseArc' }>,
  t: number,
): [number, number] {
  const c = Math.cos(e.rotation);
  const s = Math.sin(e.rotation);
  const x = e.major * Math.cos(t);
  const y = e.minor * Math.sin(t);
  return [e.center[0] + x * c - y * s, e.center[1] + x * s + y * c];
}

export function segmentPoint(seg: Segment2, which: 'start' | 'end'): Vec2 {
  switch (seg.kind) {
    case 'line':
      return which === 'start' ? seg.a : seg.b;
    case 'arc': {
      const t = which === 'start' ? seg.start : seg.start + signedSweep(seg);
      return [seg.center[0] + seg.radius * Math.cos(t), seg.center[1] + seg.radius * Math.sin(t)];
    }
    case 'ellipseArc':
      return ellipsePoint(seg, which === 'start' ? seg.start : seg.start + signedSweep(seg));
  }
}

export const samePoint = (a: Vec2, b: Vec2, tol = JOIN_TOLERANCE): boolean =>
  Math.abs(a[0] - b[0]) <= tol && Math.abs(a[1] - b[1]) <= tol;

/**
 * A path's segments split into runs that join end to start: each run is one connected stroke
 * (an SVG or PDF subpath, a DXF polyline).
 */
export function connectedRuns(segments: readonly Segment2[]): Segment2[][] {
  const runs: Segment2[][] = [];
  let run: Segment2[] = [];
  for (const seg of segments) {
    const prev = run[run.length - 1];
    if (prev && !samePoint(segmentPoint(prev, 'end'), segmentPoint(seg, 'start'))) {
      runs.push(run);
      run = [];
    }
    run.push(seg);
  }
  if (run.length) runs.push(run);
  return runs;
}

export interface Bounds2 {
  readonly min: Vec2;
  readonly max: Vec2;
}

/** Arc and ellipse arc angles beyond this many radians either way are refused. */
export const MAX_ANGLE = 1e6;

/** Bounds of a segment: endpoints plus the axis extremes the sweep passes. */
export function segmentBounds(seg: Segment2): Bounds2 {
  const pts: Vec2[] = [segmentPoint(seg, 'start'), segmentPoint(seg, 'end')];
  if (seg.kind === 'arc' || seg.kind === 'ellipseArc') {
    // A huge angle would make `k++` below stop changing `k` (and the loop never end), and has
    // lost all its precision anyway.
    for (const a of [seg.start, seg.end])
      if (!(Math.abs(a) <= MAX_ANGLE)) throw new RangeError(`Arc angle out of range: ${a}`);
    const sweep = signedSweep(seg);
    // Start within one turn, so the loop below runs at most a few times per candidate.
    const start = seg.start - Math.floor(seg.start / TAU) * TAU;
    const lo = Math.min(start, start + sweep);
    const hi = Math.max(start, start + sweep);
    // Extremes in x and y: where d/dt of each coordinate is zero.
    const candidates: number[] = [];
    if (seg.kind === 'arc') candidates.push(0, Math.PI / 2);
    else {
      const c = Math.cos(seg.rotation);
      const s = Math.sin(seg.rotation);
      candidates.push(Math.atan2(-seg.minor * s, seg.major * c));
      candidates.push(Math.atan2(seg.minor * c, seg.major * s));
    }
    for (const base of candidates) {
      for (let k = Math.ceil((lo - base) / Math.PI); base + k * Math.PI <= hi; k++) {
        const t = base + k * Math.PI;
        pts.push(
          seg.kind === 'arc'
            ? [seg.center[0] + seg.radius * Math.cos(t), seg.center[1] + seg.radius * Math.sin(t)]
            : ellipsePoint(seg, t),
        );
      }
    }
  }
  return boundsOfPoints(pts);
}

function boundsOfPoints(pts: readonly Vec2[]): Bounds2 {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of pts) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  return { min: [x0, y0], max: [x1, y1] };
}

/**
 * Bounds of every item. Text counts by an estimate of its box: Helvetica's advance widths (what
 * the PDF writer sets it in, close to what SVG and DXF readers substitute) from the descender to
 * the cap height, turned with the text. Empty sheets give `{ min: [0, 0], max: [0, 0] }`.
 */
export function sheetBounds(sheet: Sheet2): Bounds2 {
  const pts: Vec2[] = [];
  for (const item of sheet.items) {
    if (item.kind === 'text') pts.push(...textCorners(item));
    else
      for (const seg of item.segments) {
        const b = segmentBounds(seg);
        pts.push(b.min, b.max);
      }
  }
  return pts.length ? boundsOfPoints(pts) : { min: [0, 0], max: [0, 0] };
}

/** The four corners of a text's estimated box (see `sheetBounds`), in sheet coordinates. */
export function textCorners(t: Text2): Vec2[] {
  const size = t.height / HELVETICA_CAP_HEIGHT;
  const width = helveticaTextWidth(t.text, size);
  const x0 = t.anchor === 'middle' ? -width / 2 : t.anchor === 'end' ? -width : 0;
  const y0 = -HELVETICA_DESCENT * size;
  const p = baselinePoint(t);
  const c = Math.cos(t.rotation);
  const s = Math.sin(t.rotation);
  return [
    [x0, y0],
    [x0 + width, y0],
    [x0 + width, t.height],
    [x0, t.height],
  ].map(([x, y]) => [p[0] + x! * c - y! * s, p[1] + x! * s + y! * c] as const);
}

/** The smallest page side, millimetres, for a sheet without a size whose items are thinner. */
export const MIN_PAGE_SIDE = 1;

/**
 * The page a writer draws on: the sheet's size, or its items' bounds, each side at least
 * `MIN_PAGE_SIDE` (widened about the middle). A sheet with neither a size nor items has no page:
 * an error.
 */
export function pageOf(sheet: Sheet2): { origin: Vec2; width: number; height: number } {
  if (sheet.size) return { origin: [0, 0], ...sheet.size };
  if (!sheet.items.length) throw new Error('A sheet without a size needs items to set its page');
  const b = sheetBounds(sheet);
  const side = (lo: number, hi: number): [number, number] => {
    const len = hi - lo;
    return len >= MIN_PAGE_SIDE ? [lo, len] : [(lo + hi - MIN_PAGE_SIDE) / 2, MIN_PAGE_SIDE];
  };
  const [x, width] = side(b.min[0], b.max[0]);
  const [y, height] = side(b.min[1], b.max[1]);
  return { origin: [x, y], width, height };
}

/**
 * A layer's dash pattern with negative entries taken as 0; empty (continuous) when absent, empty,
 * or all zero (which PDF forbids and draws nothing useful elsewhere).
 */
export function layerDash(layer: Layer2): number[] {
  const dash = (layer.dash ?? []).map((v) => Math.max(0, v));
  return dash.some((v) => v > 0) ? dash : [];
}

/**
 * Items in drawing order: by layer, in the sheet's layer order, then in item order. Items on a
 * layer the sheet does not declare are an error.
 */
export function itemsByLayer(sheet: Sheet2): { layer: Layer2; items: Item2[] }[] {
  const groups = new Map<string, { layer: Layer2; items: Item2[] }>();
  for (const layer of sheet.layers) {
    if (groups.has(layer.name)) throw new Error(`Duplicate layer "${layer.name}"`);
    groups.set(layer.name, { layer, items: [] });
  }
  for (const item of sheet.items) {
    const g = groups.get(item.layer);
    if (!g) throw new Error(`Item on undeclared layer "${item.layer}"`);
    g.items.push(item);
  }
  return [...groups.values()];
}

/**
 * A number for a text format: at most `digits` decimals, no trailing zeros, no negative zero, and
 * never an exponent. Throws a `RangeError` for a value that is not finite, or that is 1e21 or more
 * in size (where `toFixed` would write an exponent; millimetres never get there).
 */
export function formatNumber(n: number, digits = 6): string {
  if (!Number.isFinite(n)) throw new RangeError(`Not a finite number: ${n}`);
  const f = 10 ** digits;
  const r = Math.round(n * f) / f;
  if (!Number.isFinite(r) || Math.abs(r) >= 1e21)
    throw new RangeError(`Number too large to write: ${n}`);
  if (r === 0) return '0';
  let s = r.toFixed(digits);
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s;
}

/** Up to four cubic Beziers per turn for a circular or elliptical sweep, as control points. */
export function segmentBeziers(seg: Segment2): [Vec2, Vec2, Vec2, Vec2][] {
  if (seg.kind === 'line') return [];
  const sweep = signedSweep(seg);
  const n = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2) - 1e-9));
  const step = sweep / n;
  const k = (4 / 3) * Math.tan(step / 4);
  const [rx, ry, rot] =
    seg.kind === 'arc' ? [seg.radius, seg.radius, 0] : [seg.major, seg.minor, seg.rotation];
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  const map = (x: number, y: number): Vec2 => [
    seg.center[0] + rx * x * c - ry * y * s,
    seg.center[1] + rx * x * s + ry * y * c,
  ];
  const out: [Vec2, Vec2, Vec2, Vec2][] = [];
  for (let i = 0; i < n; i++) {
    const t0 = seg.start + i * step;
    const t1 = t0 + step;
    const [c0, s0, c1, s1] = [Math.cos(t0), Math.sin(t0), Math.cos(t1), Math.sin(t1)];
    out.push([
      map(c0, s0),
      map(c0 - k * s0, s0 + k * c0),
      map(c1 + k * s1, s1 - k * c1),
      map(c1, s1),
    ]);
  }
  return out;
}

/** The point on the text's baseline at its anchor: `at` moved down by the baseline rule. */
export function baselinePoint(t: Text2): Vec2 {
  const drop = t.baseline === 'top' ? t.height : t.baseline === 'middle' ? t.height / 2 : 0;
  // Down along the text's own up direction (a quarter turn counter-clockwise from its run).
  return [t.at[0] + drop * Math.sin(t.rotation), t.at[1] - drop * Math.cos(t.rotation)];
}

// ---------------------------------------------------------------------------------------------
// Closed 2D loops (laser and plasma outlines, M5 T5.6a)

/**
 * A line of a loop, from `start` to `end`. The loop types here have the shape of
 * `packages/cam`'s `Loop2` (its `source` tags are ignored), declared again so this package does
 * not depend on cam (ADR 0014 decision 1 keeps cam free of io, and the other way round keeps the
 * writers shared with drawings without a CAM dependency).
 */
export interface LoopLine2 {
  readonly kind: 'line';
  readonly start: Vec2;
  readonly end: Vec2;
}

/**
 * An arc of a loop about `center`, from `start` to `end`, counter-clockwise when `ccw`. A full
 * circle has `fullCircle: true` (and `start` equal to `end`); it is never implied by equal ends.
 */
export interface LoopArc2 {
  readonly kind: 'arc';
  readonly start: Vec2;
  readonly end: Vec2;
  readonly center: Vec2;
  readonly ccw: boolean;
  readonly fullCircle?: boolean;
}

export type LoopSegment2 = LoopLine2 | LoopArc2;

/**
 * A closed loop: each segment starts where the previous one ends and the last ends at the first's
 * start. Outer loops counter-clockwise and holes clockwise, by cam's convention; the writers keep
 * whatever direction they are given. `id` is written as the path's owner (SVG `data-owner`).
 */
export interface Loop2 {
  readonly segments: readonly LoopSegment2[];
  readonly id?: string;
}

/** A layer of loops: the layer's style (as `Layer2`) and its loops, one layer per source. */
export interface LoopLayer2 extends Layer2 {
  readonly loops: readonly Loop2[];
}

export interface LoopSheetOptions {
  /** The page, origin at (0, 0); without it the page is the loops' bounds. */
  readonly size?: { readonly width: number; readonly height: number };
  readonly title?: string;
  /**
   * The largest gap, mm, between a segment's start and the previous segment's end that is closed
   * by moving the start onto that end (default `LOOP_SNAP_TOLERANCE`); a wider gap is an error.
   */
  readonly snapTolerance?: number;
}

/**
 * The default largest gap closed in a loop, mm: cam's arc tolerance (`DEFAULT_ARC_TOLERANCE`), a
 * tenth of Grbl's arc radius check.
 */
export const LOOP_SNAP_TOLERANCE = 0.0005;

/**
 * Loops as a sheet of closed paths, a layer per `LoopLayer2` in the given order, a path per loop.
 * Ends are kept exactly: each segment starts at the previous segment's end (gaps up to the snap
 * tolerance closed), and an arc whose ends lie at different distances from its centre (cam allows
 * up to its arc tolerance) gets the centre moved onto the ends' perpendicular bisector, the
 * nearest point at which both ends lie on one circle. Throws a `RangeError` for an empty loop, a
 * gap wider than the tolerance, an arc that is not a full circle but has equal ends, or a point
 * that is not finite.
 */
export function loopsToSheet(
  layers: readonly LoopLayer2[],
  options: LoopSheetOptions = {},
): Sheet2 {
  const tol = options.snapTolerance ?? LOOP_SNAP_TOLERANCE;
  const items: Path2[] = [];
  for (const layer of layers)
    layer.loops.forEach((loop, i) => {
      const where = `layer "${layer.name}", loop ${i}`;
      items.push({
        kind: 'path',
        layer: layer.name,
        segments: loopSegments(loop, tol, where),
        closed: true,
        ...(loop.id === undefined ? {} : { owner: loop.id }),
      });
    });
  return {
    layers: layers.map(layerStyle),
    items,
    ...(options.size ? { size: options.size } : {}),
    ...(options.title === undefined ? {} : { title: options.title }),
  };
}

/** A loop layer's style alone, without its loops. */
function layerStyle(layer: LoopLayer2): Layer2 {
  const style: { -readonly [K in keyof Layer2]: Layer2[K] } = { name: layer.name };
  if (layer.weight !== undefined) style.weight = layer.weight;
  if (layer.dash !== undefined) style.dash = layer.dash;
  if (layer.lineType !== undefined) style.lineType = layer.lineType;
  if (layer.color !== undefined) style.color = layer.color;
  return style;
}

function loopSegments(loop: Loop2, tol: number, where: string): Segment2[] {
  const segs = loop.segments;
  if (!segs.length) throw new RangeError(`Empty loop (${where})`);
  const out: Segment2[] = [];
  segs.forEach((seg, i) => {
    for (const p of [seg.start, seg.end, ...(seg.kind === 'arc' ? [seg.center] : [])])
      if (!Number.isFinite(p[0]) || !Number.isFinite(p[1]))
        throw new RangeError(`Point not finite (${where}, segment ${i})`);
    const prevEnd = segs[(i + segs.length - 1) % segs.length]!.end;
    const gap = Math.hypot(seg.start[0] - prevEnd[0], seg.start[1] - prevEnd[1]);
    if (gap > tol)
      throw new RangeError(
        `Loop not closed: segment ${i} starts ${gap} mm from the previous end (${where})`,
      );
    // A full circle is closed on itself: its start is its own end.
    const start = seg.kind === 'arc' && seg.fullCircle ? seg.start : prevEnd;
    if (seg.kind === 'line') out.push(line(start, seg.end));
    else out.push(loopArc(seg, start, where, i));
  });
  return out;
}

function loopArc(seg: LoopArc2, start: Vec2, where: string, i: number): Segment2 {
  if (seg.fullCircle) {
    const radius = Math.hypot(start[0] - seg.center[0], start[1] - seg.center[1]);
    if (!(radius > 0)) throw new RangeError(`Circle of zero radius (${where}, segment ${i})`);
    const a0 = Math.atan2(start[1] - seg.center[1], start[0] - seg.center[0]);
    return { kind: 'arc', center: seg.center, radius, start: a0, end: a0 + (seg.ccw ? TAU : -TAU) };
  }
  const end = seg.end;
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const chord = Math.hypot(dx, dy);
  if (!(chord > 0))
    throw new RangeError(`Arc with equal ends that is not a full circle (${where}, segment ${i})`);
  // The centre projected onto the perpendicular bisector of the chord.
  const mid: Vec2 = [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2];
  const u: Vec2 = [-dy / chord, dx / chord];
  const along = (seg.center[0] - mid[0]) * u[0] + (seg.center[1] - mid[1]) * u[1];
  const center: Vec2 = [mid[0] + along * u[0], mid[1] + along * u[1]];
  const radius = Math.hypot(start[0] - center[0], start[1] - center[1]);
  const a0 = Math.atan2(start[1] - center[1], start[0] - center[0]);
  const a1 = Math.atan2(end[1] - center[1], end[0] - center[0]);
  let sweep = a1 - a0;
  if (seg.ccw) while (sweep <= 0) sweep += TAU;
  else while (sweep >= 0) sweep -= TAU;
  return { kind: 'arc', center, radius, start: a0, end: a0 + sweep };
}
