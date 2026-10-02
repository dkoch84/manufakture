// Outlines: paths of lines and quadratic and cubic Beziers (glyph outlines,
// and later SVG paths) turned into closed region loops a profile can use.
//
// A path is a list of `moveTo`, `lineTo`, `quadTo`, `cubicTo` and `close`
// commands, the shape TrueType and CFF glyphs and SVG path data share. Each
// `moveTo` starts a contour; a contour is closed with a straight segment when
// it does not end where it started (fonts and SVG fill do the same).
//
// When no contours cross or touch, the winding number of every contour's
// inside and outside follows from the others alone, so the fill rule (nonzero,
// what TrueType and CFF glyphs use, or even-odd) decides which contours bound
// the filled area: a contour with fill on exactly one side is kept, outer
// loops (fill inside) counter-clockwise and holes (fill outside) clockwise,
// each hole under the smallest outer loop around it. A contour with fill on
// both sides or neither (a redundant inner contour) bounds nothing and is
// dropped.
//
// Contours that cross or touch (the components of a composite glyph such as
// "Ç" or "Ø", the overlaps of a variable-font instance, overlapping SVG
// shapes) are merged: every segment is split where another meets it, the
// pieces with fill on exactly one side are kept, turned so the fill is on
// their left, and chained into new loops. Beziers are split exactly (de
// Casteljau), so merged loops are still lines and Beziers. A `merged` issue
// says so. Only when merging fails (coincident curves) is the path refused
// with a `crossing` error and no regions, never passed on as overlapping
// loops.
//
// Segments of zero length are dropped, and a Bezier whose control points lie
// on its chord becomes a line. With `arcs`, every Bezier is replaced by lines
// and circular arcs within a tolerance, for consumers that take lines and arcs
// only.
//
// Merging and the crossing test grow faster than linearly with the number of
// segments (hundreds of contours all overlapping take seconds; a hostile font
// or SVG could take minutes). A path of more than `MAX_OUTLINE_COMMANDS`
// commands is refused up front, and every step past reading the path draws on
// a work budget of `MAX_OUTLINE_WORK` elementary steps (a chord or segment
// test, a polygon vertex visited by a winding count, an arc fit sample). Either
// way the result is a `too-complex` error and no regions. Real glyphs use a
// tiny fraction of both.
//
// This module knows nothing about fonts or SVG; units are whatever the path
// uses (millimetres in a sketch). Everything is plain data.

import type { PathCommand, Vec2 } from './model';

/** Default tolerance relative to the path's extent, as `detectRegions` uses. */
const RELATIVE_TOLERANCE = 1e-6;
/** Bezier flattening for the crossing and containment tests, relative to the extent. */
const RELATIVE_FLATTENING = 1e-5;
/** Most chords one Bezier is flattened into for those tests. */
const MAX_CHORDS = 256;
/** Deepest subdivision when fitting arcs; a piece that still does not fit becomes a line. */
const MAX_ARC_DEPTH = 24;
/** Points on each piece checked against its fitted arc. */
const ARC_SAMPLES = 32;
/** Most path commands `outlineRegions` accepts. */
export const MAX_OUTLINE_COMMANDS = 100_000;
/** Elementary steps one `outlineRegions` call may take; see the module comment. */
export const MAX_OUTLINE_WORK = 250_000_000;
/** Polygon vertices one call may make by flattening, which bounds its memory. */
export const MAX_OUTLINE_POINTS = 1_000_000;

/** Thrown when a call runs out of its work budget. */
class TooComplex extends Error {}

/**
 * What a call may still spend: by default each call gets its own (`MAX_OUTLINE_WORK` steps,
 * `MAX_OUTLINE_POINTS` vertices). Pass one as `OutlineOptions.budget` to share it between calls,
 * so that many calls together are bounded too (an SVG outline's paths, `outline-svg.ts`).
 */
export class OutlineBudget {
  private steps: number;
  private points: number;
  private readonly fullSteps: number;
  private readonly fullPoints: number;
  constructor(steps: number = MAX_OUTLINE_WORK, points: number = MAX_OUTLINE_POINTS) {
    this.steps = this.fullSteps = steps;
    this.points = this.fullPoints = points;
  }
  /**
   * Whether anything was spent yet. A call refused for a budget that was untouched when it
   * began is too complex on its own; one refused after other calls spent part of it may not be.
   */
  get used(): boolean {
    return this.steps !== this.fullSteps || this.points !== this.fullPoints;
  }
  spend(steps: number): void {
    this.steps -= steps;
    if (this.steps < 0) throw new TooComplex('too complex');
  }
  /** Whether the budget has run out: a call that spent it all was refused as `too-complex`. */
  get exhausted(): boolean {
    return this.steps < 0 || this.points < 0;
  }
  /** Vertices made by flattening; they count as steps too. */
  flattened(points: number): void {
    this.points -= points;
    if (this.points < 0) throw new TooComplex('too complex');
    this.spend(points);
  }
}

// Public types ----------------------------------------------------------------------

export type { PathCommand } from './model';

/**
 * Where a segment comes from. `contour`, `index`, `split` and `piece` together
 * are unique within one result, and stable as long as the path is: consumers
 * build edge names from them.
 */
interface SegmentSource {
  /** The contour: its position among the path's contours, from 0. */
  contour: number;
  /**
   * The drawing command, counted from 0 within its contour (the `moveTo` is
   * not counted). The closing segment a contour gets when it ends away from
   * its start has the next index.
   */
  index: number;
  /**
   * 0, or the position (from 0, along the command) among the pieces the
   * command was cut into where other contours meet it, when contours were merged.
   */
  split: number;
  /** 0, or the position (from 0, along the command) among the lines and arcs `arcs` made. */
  piece: number;
  /** Runs against the command's own direction. */
  reversed: boolean;
}

/**
 * One segment of a loop, in loop order. A `bezier` has 3 (quadratic) or 4
 * (cubic) control points, the first its start and the last its end. Arcs
 * appear only with the `arcs` option.
 */
export type OutlineSegment = SegmentSource &
  (
    | { kind: 'line'; start: Vec2; end: Vec2 }
    | { kind: 'bezier'; points: Vec2[] }
    | { kind: 'arc'; center: Vec2; start: Vec2; end: Vec2; clockwise: boolean }
  );

export interface OutlineLoop {
  /** The contour the loop comes from (the lowest, when contours were merged into it). */
  contour: number;
  segments: OutlineSegment[];
  /** Signed enclosed area of the original (Bezier) loop: positive when counter-clockwise. */
  area: number;
}

export interface OutlineRegion {
  /** Counter-clockwise. */
  outer: OutlineLoop;
  /** Clockwise, ordered by contour. */
  holes: OutlineLoop[];
}

export type OutlineIssueCode =
  | 'crossing'
  | 'merged'
  | 'touching'
  | 'not-finite'
  | 'too-complex'
  | 'open-contour'
  | 'empty-contour';

export interface OutlineIssue {
  code: OutlineIssueCode;
  /** `error` issues mean no regions were made. */
  severity: 'error' | 'warning' | 'info';
  message: string;
  /** The contours involved, by position in the path. */
  contours: number[];
  /** Where contours meet, for `crossing`; where loops touch, for `touching`. */
  point?: Vec2;
}

export interface OutlineResult {
  /** Ordered by the outer loop's contour. Empty when there is an error. */
  regions: OutlineRegion[];
  issues: OutlineIssue[];
}

export interface OutlineOptions {
  /**
   * Points closer than this are one point, and shorter segments are dropped.
   * Finite and above 0. Default: 1e-6 times the path's extent, at least 1e-9.
   */
  tolerance?: number;
  /** Default `nonzero`, what TrueType and CFF glyphs use; SVG may ask for `evenodd`. */
  fillRule?: 'nonzero' | 'evenodd';
  /**
   * Replace every Bezier by lines and circular arcs that stay within `tolerance`
   * of it (in path units, finite and above 0). Off by default: Beziers are kept.
   */
  arcs?: { tolerance: number };
  /** Work to spend, shared with other calls; default a fresh `OutlineBudget` per call. */
  budget?: OutlineBudget;
}

// Bezier helpers --------------------------------------------------------------------

/** The point at `t` of a Bezier with any number of control points (de Casteljau). */
export function bezierPoint(points: readonly Vec2[], t: number): Vec2 {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  for (let n = points.length - 1; n > 0; n--) {
    for (let i = 0; i < n; i++) {
      xs[i] = xs[i]! + (xs[i + 1]! - xs[i]!) * t;
      ys[i] = ys[i]! + (ys[i + 1]! - ys[i]!) * t;
    }
  }
  return [xs[0]!, ys[0]!];
}

/** The derivative at `t`. */
function bezierTangent(points: readonly Vec2[], t: number): Vec2 {
  const n = points.length - 1;
  const diff: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    diff.push([n * (points[i + 1]![0] - points[i]![0]), n * (points[i + 1]![1] - points[i]![1])]);
  }
  return n === 1 ? diff[0]! : bezierPoint(diff, t);
}

/** Splits a Bezier at `t` into two of the same degree. */
function splitBezier(points: readonly Vec2[], t: number): [Vec2[], Vec2[]] {
  const left: Vec2[] = [];
  const right: Vec2[] = [];
  let level: Vec2[] = [...points];
  while (level.length > 0) {
    left.push(level[0]!);
    right.unshift(level[level.length - 1]!);
    const next: Vec2[] = [];
    for (let i = 0; i + 1 < level.length; i++) {
      const a = level[i]!;
      const b = level[i + 1]!;
      next.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
    level = next;
  }
  return [left, right];
}

/** Chords for a Bezier so that no chord is further than `tolerance` from the curve. */
function bezierChordCount(points: readonly Vec2[], tolerance: number, max = MAX_CHORDS): number {
  const degree = points.length - 1;
  if (degree < 2) return 1;
  let d = 0;
  for (let i = 0; i + 2 < points.length; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    const c = points[i + 2]!;
    d = Math.max(d, Math.hypot(a[0] - 2 * b[0] + c[0], a[1] - 2 * b[1] + c[1]));
  }
  // The flattening bound: deviation <= degree (degree - 1) / 8 * max second difference / n^2.
  const n = Math.ceil(Math.sqrt((degree * (degree - 1) * d) / (8 * tolerance)));
  return Math.min(max, Math.max(1, n));
}

/** Points along a segment, start included, end excluded. */
function flattenInto(segment: OutlineSegment, tolerance: number, out: Vec2[]): void {
  if (segment.kind === 'line') {
    out.push(segment.start);
  } else if (segment.kind === 'bezier') {
    const n = bezierChordCount(segment.points, tolerance);
    for (let i = 0; i < n; i++) out.push(bezierPoint(segment.points, i / n));
  } else {
    const { center, start } = segment;
    const r = Math.hypot(start[0] - center[0], start[1] - center[1]);
    const sweep = arcSweep(segment);
    const step = r > tolerance ? 2 * Math.acos(Math.max(-1, 1 - tolerance / r)) : Math.PI;
    const n = Math.min(MAX_CHORDS, Math.max(1, Math.ceil(Math.abs(sweep) / step)));
    const a0 = Math.atan2(start[1] - center[1], start[0] - center[0]);
    for (let i = 0; i < n; i++) {
      const a = a0 + (sweep * i) / n;
      out.push([center[0] + r * Math.cos(a), center[1] + r * Math.sin(a)]);
    }
  }
}

/**
 * Points along a segment from its start to its end (both included), no chord
 * further than `tolerance` from it, in at most 256 chords. For drawing.
 * `tolerance` must be finite and above 0, else it throws a RangeError.
 */
export function flattenSegment(segment: OutlineSegment, tolerance: number): Vec2[] {
  if (!(Number.isFinite(tolerance) && tolerance > 0)) {
    throw new RangeError(`The flattening tolerance must be finite and above 0, not ${tolerance}.`);
  }
  const out: Vec2[] = [];
  flattenInto(segment, tolerance, out);
  out.push(segmentEnd(segment));
  return out;
}

/** Signed sweep of an arc segment in radians: positive counter-clockwise. */
function arcSweep(segment: { center: Vec2; start: Vec2; end: Vec2; clockwise: boolean }): number {
  const { center, start, end, clockwise } = segment;
  const a0 = Math.atan2(start[1] - center[1], start[0] - center[0]);
  const a1 = Math.atan2(end[1] - center[1], end[0] - center[0]);
  let sweep = a1 - a0;
  if (clockwise) {
    while (sweep >= 0) sweep -= 2 * Math.PI;
  } else {
    while (sweep <= 0) sweep += 2 * Math.PI;
  }
  return sweep;
}

function segmentEnd(segment: OutlineSegment): Vec2 {
  return segment.kind === 'bezier' ? segment.points[segment.points.length - 1]! : segment.end;
}

// Gauss-Legendre nodes on [0, 1]: three points integrate the degree-5 polynomial
// x y' - y x' of a cubic Bezier exactly.
const GAUSS_T = [0.5 - Math.sqrt(0.15), 0.5, 0.5 + Math.sqrt(0.15)];
const GAUSS_W = [5 / 18, 8 / 18, 5 / 18];

/** Twice the signed area a segment contributes (Green's theorem), exact for lines, Beziers and arcs. */
function doubleArea(segment: OutlineSegment): number {
  if (segment.kind === 'line') {
    return segment.start[0] * segment.end[1] - segment.end[0] * segment.start[1];
  }
  if (segment.kind === 'arc') {
    const { center, start, end } = segment;
    const r2 = (start[0] - center[0]) ** 2 + (start[1] - center[1]) ** 2;
    const sweep = arcSweep(segment);
    // The chord's term plus the circular segment between chord and arc.
    const chord = start[0] * end[1] - end[0] * start[1];
    return chord + r2 * (sweep - Math.sin(sweep));
  }
  let sum = 0;
  for (let i = 0; i < 3; i++) {
    const t = GAUSS_T[i]!;
    const p = bezierPoint(segment.points, t);
    const d = bezierTangent(segment.points, t);
    sum += GAUSS_W[i]! * (p[0] * d[1] - p[1] * d[0]);
  }
  return sum;
}

/** Signed area of a closed loop of segments: positive when counter-clockwise. */
export function loopArea(segments: readonly OutlineSegment[]): number {
  let sum = 0;
  for (const segment of segments) sum += doubleArea(segment);
  return sum / 2;
}

/** Filled area of a region: its outer loop less its holes. */
export function outlineRegionArea(region: OutlineRegion): number {
  return Math.abs(region.outer.area) - region.holes.reduce((s, h) => s + Math.abs(h.area), 0);
}

function sourceOf(segment: SegmentSource): SegmentSource {
  const { contour, index, split, piece, reversed } = segment;
  return { contour, index, split, piece, reversed };
}

function reverseSegment(segment: OutlineSegment): OutlineSegment {
  const source = { ...sourceOf(segment), reversed: !segment.reversed };
  if (segment.kind === 'line') {
    return { kind: 'line', ...source, start: segment.end, end: segment.start };
  }
  if (segment.kind === 'bezier') {
    return { kind: 'bezier', ...source, points: [...segment.points].reverse() };
  }
  return {
    kind: 'arc',
    ...source,
    center: segment.center,
    start: segment.end,
    end: segment.start,
    clockwise: !segment.clockwise,
  };
}

// Contours ---------------------------------------------------------------------------

interface Contour {
  index: number;
  segments: OutlineSegment[];
  /** Flattened polygon, closed implicitly. */
  polygon: Vec2[];
  area: number;
}

const distance = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Distance from `p` to the line through `a` and `b`, and where along it (0 at a, 1 at b). */
function chordOffset(p: Vec2, a: Vec2, b: Vec2): { d: number; t: number } {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return { d: distance(p, a), t: 0 };
  const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
  const d = Math.abs((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / Math.sqrt(len2);
  return { d, t };
}

/** A drawing command as a segment, or null when it is degenerate (zero length). */
function toSegment(
  points: Vec2[],
  source: SegmentSource,
  tolerance: number,
): OutlineSegment | null {
  const start = points[0]!;
  const end = points[points.length - 1]!;
  if (points.every((p) => distance(p, start) <= tolerance)) return null;
  if (points.length > 2) {
    // A Bezier whose control points sit on its chord, between its ends, is a line.
    const flat = points.slice(1, -1).every((p) => {
      const { d, t } = chordOffset(p, start, end);
      return d <= tolerance && t >= 0 && t <= 1;
    });
    if (flat && distance(start, end) > tolerance) {
      return { kind: 'line', ...source, start, end };
    }
    return { kind: 'bezier', ...source, points };
  }
  return { kind: 'line', ...source, start, end };
}

/** Splits a path into contours of segments, joined end to start exactly, each closed. */
function readContours(
  path: readonly PathCommand[],
  tolerance: number,
  issues: OutlineIssue[],
): Contour[] {
  const contours: Contour[] = [];
  let raw: Vec2[][] = [];
  let first: Vec2 | null = null;
  let pen: Vec2 | null = null;
  let closed = false;
  let count = 0;

  const finish = () => {
    if (first === null) return;
    const index = count++;
    if (raw.length === 0) {
      // A bare moveTo draws nothing; it keeps its contour number and is skipped quietly.
      first = null;
      pen = null;
      closed = false;
      return;
    }
    if (pen && distance(pen, first) > tolerance) {
      raw.push([pen, first]);
      if (!closed) {
        issues.push({
          code: 'open-contour',
          severity: 'warning',
          message: `Contour ${index} does not end where it starts; it is closed with a straight segment.`,
          contours: [index],
        });
      }
    }
    const segments: OutlineSegment[] = [];
    raw.forEach((points, i) => {
      const source = { contour: index, index: i, split: 0, piece: 0, reversed: false };
      const segment = toSegment(points, source, tolerance);
      if (!segment) return;
      if (
        segment.kind === 'bezier' &&
        distance(points[0]!, points[points.length - 1]!) <= tolerance
      ) {
        // A Bezier that closes on itself (a contour drawn as one curve) is cut in half, so
        // no segment starts where it ends: chaining, the crossing test and the kernel's
        // edges all need two distinct ends. The halves are pieces 0 and 1 of the command.
        const [left, right] = splitBezier(points, 0.5);
        segments.push({ ...segment, points: left }, { ...segment, split: 1, points: right });
        return;
      }
      segments.push(segment);
    });
    contours.push({ index, segments, polygon: [], area: 0 });
    raw = [];
    first = null;
    pen = null;
    closed = false;
  };

  for (const command of path) {
    if (command.kind === 'moveTo') {
      finish();
      first = command.to;
      pen = command.to;
      continue;
    }
    if (command.kind === 'close') {
      closed = true;
      continue;
    }
    if (pen === null || first === null) {
      // A path that draws before any moveTo starts at the origin.
      first = [0, 0];
      pen = first;
    }
    if (closed) {
      // Drawing after `close` continues from the contour's start, as SVG does: a new contour.
      const start: Vec2 = first;
      finish();
      first = start;
      pen = start;
    }
    if (command.kind === 'lineTo') raw.push([pen, command.to]);
    else if (command.kind === 'quadTo') raw.push([pen, command.control, command.to]);
    else raw.push([pen, command.control1, command.control2, command.to]);
    pen = command.to;
  }
  finish();

  // Join segments exactly: after dropping degenerate ones, each starts where the
  // previous ended (they agree within the tolerance), and the last ends at the first.
  for (const contour of contours) {
    const { segments } = contour;
    for (let i = 0; i < segments.length; i++) {
      const previous = segments[(i + segments.length - 1) % segments.length]!;
      const anchor = segmentEnd(previous);
      const segment = segments[i]!;
      if (segment.kind === 'bezier') segment.points[0] = anchor;
      else segment.start = anchor;
    }
  }
  return contours;
}

// Crossings ----------------------------------------------------------------------------

interface Chord {
  contour: number;
  /** Position in the contour's polygon. */
  index: number;
  /** Chords in the contour's polygon. */
  count: number;
  a: Vec2;
  b: Vec2;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

const orient = (a: Vec2, b: Vec2, c: Vec2) =>
  (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);

/** Where two chords meet (cross, touch or overlap), or null. */
function chordsMeet(p: Chord, q: Chord, tolerance: number): Vec2 | null {
  const lenP = distance(p.a, p.b) || 1;
  const lenQ = distance(q.a, q.b) || 1;
  const d1 = orient(p.a, p.b, q.a) / lenP;
  const d2 = orient(p.a, p.b, q.b) / lenP;
  const d3 = orient(q.a, q.b, p.a) / lenQ;
  const d4 = orient(q.a, q.b, p.b) / lenQ;
  const side = (d: number) => (Math.abs(d) <= tolerance ? 0 : Math.sign(d));
  const s1 = side(d1);
  const s2 = side(d2);
  const s3 = side(d3);
  const s4 = side(d4);
  if (s1 * s2 < 0 && s3 * s4 < 0) {
    const t = d3 / (d3 - d4);
    return [p.a[0] + (p.b[0] - p.a[0]) * t, p.a[1] + (p.b[1] - p.a[1]) * t];
  }
  // Touching: an end of one chord on the other.
  const on = (pt: Vec2, c: Chord) => {
    const { d, t } = chordOffset(pt, c.a, c.b);
    const len = distance(c.a, c.b) || 1;
    return d <= tolerance && t >= -tolerance / len && t <= 1 + tolerance / len;
  };
  if (s1 === 0 && on(q.a, p)) return q.a;
  if (s2 === 0 && on(q.b, p)) return q.b;
  if (s3 === 0 && on(p.a, q)) return p.a;
  if (s4 === 0 && on(p.b, q)) return p.b;
  return null;
}

/** Chords that follow each other in one polygon share an end by construction. */
function adjacent(p: Chord, q: Chord): boolean {
  if (p.contour !== q.contour) return false;
  const diff = Math.abs(p.index - q.index);
  return diff === 1 || diff === p.count - 1;
}

/** The first crossing, touch or overlap between chords not adjacent in one contour. */
function findCrossing(
  contours: readonly Contour[],
  tolerance: number,
  budget: OutlineBudget,
): OutlineIssue | null {
  const chords: Chord[] = [];
  for (const contour of contours) {
    const { polygon } = contour;
    for (let i = 0; i < polygon.length; i++) {
      const a = polygon[i]!;
      const b = polygon[(i + 1) % polygon.length]!;
      chords.push({
        contour: contour.index,
        index: i,
        count: polygon.length,
        a,
        b,
        minX: Math.min(a[0], b[0]) - tolerance,
        maxX: Math.max(a[0], b[0]) + tolerance,
        minY: Math.min(a[1], b[1]) - tolerance,
        maxY: Math.max(a[1], b[1]) + tolerance,
      });
    }
  }
  budget.spend(chords.length * Math.ceil(Math.log2(chords.length + 1)));
  chords.sort((p, q) => p.minX - q.minX);
  const active: Chord[] = [];
  for (const chord of chords) {
    budget.spend(2 * active.length + 1);
    for (let i = active.length - 1; i >= 0; i--) {
      if (active[i]!.maxX < chord.minX) active.splice(i, 1);
    }
    for (const other of active) {
      if (other.maxY < chord.minY || other.minY > chord.maxY) continue;
      if (adjacent(chord, other)) continue;
      const point = chordsMeet(chord, other, tolerance);
      if (point) {
        const ids = [...new Set([chord.contour, other.contour])].sort((a, b) => a - b);
        const message =
          ids.length === 1
            ? `Contour ${ids[0]} crosses or touches itself; overlapping outlines are not supported.`
            : `Contours ${ids[0]} and ${ids[1]} cross or touch; overlapping outlines are not supported.`;
        return { code: 'crossing', severity: 'error', message, contours: ids, point };
      }
    }
    active.push(chord);
  }
  return null;
}

// Nesting ----------------------------------------------------------------------------------

/** Winding number of a closed polygon around `p` (p not on it). */
function winding(polygon: readonly Vec2[], p: Vec2): number {
  let w = 0;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i]!;
    const b = polygon[(i + 1) % polygon.length]!;
    if (a[1] <= p[1]) {
      if (b[1] > p[1] && orient(a, b, p) > 0) w++;
    } else if (b[1] <= p[1] && orient(a, b, p) < 0) {
      w--;
    }
  }
  return w;
}

function toLoop(contour: Contour, counterClockwise: boolean): OutlineLoop {
  const reversed = contour.area > 0 !== counterClockwise;
  const segments = reversed
    ? contour.segments.map(reverseSegment).reverse()
    : contour.segments.map((s) => ({ ...s }));
  return { contour: contour.index, segments, area: reversed ? -contour.area : contour.area };
}

// Merging ------------------------------------------------------------------------------------

/** Most intersections between two segments before they count as coincident. */
const MAX_PAIR_INTERSECTIONS = 32;
/** Subdivision steps for one pair of segments before giving up. */
const MAX_PAIR_WORK = 20000;
/** Flattening for the fill tests of merged pieces, relative to the extent. */
const RELATIVE_FINE_FLATTENING = 1e-7;
/** Chords one Bezier may be flattened into for those tests. */
const MAX_FINE_CHORDS = 8192;

class MergeError extends Error {}

/** Control points of a line or Bezier segment. */
function controlPoints(segment: OutlineSegment): Vec2[] {
  return segment.kind === 'bezier' ? segment.points : [segment.start, segment.end];
}

interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function boxOf(points: readonly Vec2[]): Box {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return { minX, minY, maxX, maxY };
}

const boxesMeet = (a: Box, b: Box, tolerance: number) =>
  a.minX <= b.maxX + tolerance &&
  b.minX <= a.maxX + tolerance &&
  a.minY <= b.maxY + tolerance &&
  b.minY <= a.maxY + tolerance;

/** All inner control points within `tolerance` of the chord's line. */
function isFlat(points: readonly Vec2[], tolerance: number): boolean {
  const a = points[0]!;
  const b = points[points.length - 1]!;
  for (let i = 1; i + 1 < points.length; i++) {
    if (chordOffset(points[i]!, a, b).d > tolerance) return false;
  }
  return true;
}

/** The same curve: equal control points, in the same or the opposite order. */
function sameCurve(a: readonly Vec2[], b: readonly Vec2[], tolerance: number): boolean {
  if (a.length !== b.length) return false;
  const n = a.length;
  let forward = true;
  let backward = true;
  for (let i = 0; i < n; i++) {
    if (distance(a[i]!, b[i]!) > tolerance) forward = false;
    if (distance(a[i]!, b[n - 1 - i]!) > tolerance) backward = false;
  }
  return forward || backward;
}

/** Parameters `[t, u]` where two straight chords meet, including the ends of collinear overlaps. */
function chordIntersections(
  a0: Vec2,
  a1: Vec2,
  b0: Vec2,
  b1: Vec2,
  tolerance: number,
): [number, number][] {
  const r: Vec2 = [a1[0] - a0[0], a1[1] - a0[1]];
  const s: Vec2 = [b1[0] - b0[0], b1[1] - b0[1]];
  const lr = Math.hypot(r[0], r[1]);
  const ls = Math.hypot(s[0], s[1]);
  if (lr === 0 || ls === 0) return [];
  const qp: Vec2 = [b0[0] - a0[0], b0[1] - a0[1]];
  const denom = r[0] * s[1] - r[1] * s[0];
  const er = tolerance / lr;
  const es = tolerance / ls;
  const inside = (t: number, e: number) => t >= -e && t <= 1 + e;
  const clamp = (t: number) => Math.min(1, Math.max(0, t));
  if (Math.abs(denom) > 1e-12 * lr * ls) {
    const t = (qp[0] * s[1] - qp[1] * s[0]) / denom;
    const u = (qp[0] * r[1] - qp[1] * r[0]) / denom;
    // Nearly parallel chords: the crossing must also be close to both.
    if (inside(t, er) && inside(u, es)) return [[clamp(t), clamp(u)]];
    return [];
  }
  // Parallel: only collinear chords meet, at the ends of their overlap.
  if (chordOffset(b0, a0, a1).d > tolerance) return [];
  const out: [number, number][] = [];
  const onA = (p: Vec2) => chordOffset(p, a0, a1).t;
  const onB = (p: Vec2) => chordOffset(p, b0, b1).t;
  if (inside(onB(a0), es)) out.push([0, clamp(onB(a0))]);
  if (inside(onB(a1), es)) out.push([1, clamp(onB(a1))]);
  if (inside(onA(b0), er)) out.push([clamp(onA(b0)), 0]);
  if (inside(onA(b1), er)) out.push([clamp(onA(b1)), 1]);
  return out;
}

/** Where two lines or Beziers meet, as parameters `[t, u]`, by subdividing until both are flat. */
function segmentIntersections(
  a: readonly Vec2[],
  b: readonly Vec2[],
  tolerance: number,
  budget: OutlineBudget,
): [number, number][] {
  const out: [number, number][] = [];
  let work = 0;
  const visit = (
    pa: readonly Vec2[],
    ta0: number,
    ta1: number,
    pb: readonly Vec2[],
    tb0: number,
    tb1: number,
    depth: number,
  ) => {
    if (++work > MAX_PAIR_WORK || out.length > MAX_PAIR_INTERSECTIONS) {
      throw new MergeError('coincident');
    }
    // A visit allocates and tests two control polygons, about 100 steps' worth.
    budget.spend(100);
    const boxA = boxOf(pa);
    const boxB = boxOf(pb);
    if (!boxesMeet(boxA, boxB, tolerance)) return;
    const flatA = isFlat(pa, tolerance / 4);
    const flatB = isFlat(pb, tolerance / 4);
    if ((flatA && flatB) || depth > 52) {
      const hits = chordIntersections(
        pa[0]!,
        pa[pa.length - 1]!,
        pb[0]!,
        pb[pb.length - 1]!,
        tolerance,
      );
      for (const [t, u] of hits) out.push([ta0 + (ta1 - ta0) * t, tb0 + (tb1 - tb0) * u]);
      return;
    }
    const sizeA = boxA.maxX - boxA.minX + boxA.maxY - boxA.minY;
    const sizeB = boxB.maxX - boxB.minX + boxB.maxY - boxB.minY;
    if (!flatA && (flatB || sizeA >= sizeB)) {
      const [left, right] = splitBezier(pa, 0.5);
      const mid = (ta0 + ta1) / 2;
      visit(left, ta0, mid, pb, tb0, tb1, depth + 1);
      visit(right, mid, ta1, pb, tb0, tb1, depth + 1);
    } else {
      const [left, right] = splitBezier(pb, 0.5);
      const mid = (tb0 + tb1) / 2;
      visit(pa, ta0, ta1, left, tb0, mid, depth + 1);
      visit(pa, ta0, ta1, right, mid, tb1, depth + 1);
    }
  };
  visit(a, 0, 1, b, 0, 1, 0);
  return out;
}

interface Cut {
  t: number;
  point: Vec2;
}

/** Cuts a segment at parameters (sorted, inside (0, 1)), each piece ending exactly at its cut point. */
function cutSegment(segment: OutlineSegment, cuts: readonly Cut[]): OutlineSegment[] {
  const source = sourceOf(segment);
  const pieces: Vec2[][] = [];
  let rest = controlPoints(segment);
  let done = 0;
  for (const cut of cuts) {
    const [left, right] = splitBezier(rest, (cut.t - done) / (1 - done));
    left[left.length - 1] = cut.point;
    right[0] = cut.point;
    pieces.push(left);
    rest = right;
    done = cut.t;
  }
  pieces.push(rest);
  return pieces.map((points, split) =>
    points.length === 2
      ? { kind: 'line', ...source, split, start: points[0]!, end: points[1]! }
      : { kind: 'bezier', ...source, split, points },
  );
}

interface Edge {
  segment: OutlineSegment;
  start: Vec2;
  end: Vec2;
  /** Unit directions leaving the start and arriving at the end. */
  out: Vec2;
  in: Vec2;
  used: boolean;
}

function unit(v: Vec2, fallback: Vec2): Vec2 {
  const l = Math.hypot(v[0], v[1]);
  if (l > 0) return [v[0] / l, v[1] / l];
  const f = Math.hypot(fallback[0], fallback[1]) || 1;
  return [fallback[0] / f, fallback[1] / f];
}

function toEdge(segment: OutlineSegment): Edge {
  const points = controlPoints(segment);
  const start = points[0]!;
  const end = points[points.length - 1]!;
  const chord: Vec2 = [end[0] - start[0], end[1] - start[1]];
  return {
    segment,
    start,
    end,
    out: unit(bezierTangent(points, 0), chord),
    in: unit(bezierTangent(points, 1), chord),
    used: false,
  };
}

function segmentStart(segment: OutlineSegment): Vec2 {
  return segment.kind === 'bezier' ? segment.points[0]! : segment.start;
}

/**
 * Splits a closed loop of segments where it passes through one point twice
 * (within `snap`), so every part is a simple loop; each part is joined exactly
 * (its first segment starts where its last ends). A loop that never comes back
 * through a point is returned as it is, as the only part.
 */
function splitPinchedLoop(
  segments: readonly OutlineSegment[],
  snap: number,
  budget: OutlineBudget,
  pinches: Vec2[],
): OutlineSegment[][] {
  const parts: OutlineSegment[][] = [];
  const stack: OutlineSegment[] = [];
  for (const segment of segments) {
    budget.spend(stack.length + 1);
    const start = segmentStart(segment);
    // The latest earlier segment starting here closes a loop: the stretch since it.
    let at = -1;
    for (let i = stack.length - 1; i >= 0; i--) {
      if (distance(segmentStart(stack[i]!), start) <= snap) {
        at = i;
        break;
      }
    }
    if (at >= 0) {
      parts.push(stack.splice(at));
      pinches.push(start);
    }
    stack.push(segment);
  }
  if (stack.length > 0) parts.push(stack);
  if (parts.length === 1) return parts;
  return parts.map((part) =>
    part.map((segment, k) => {
      const end = segmentEnd(part[(k + part.length - 1) % part.length]!);
      if (segment.kind === 'bezier') {
        return { ...segment, points: [end, ...segment.points.slice(1)] };
      }
      return { ...segment, start: end };
    }),
  );
}

/**
 * Merges contours that cross or touch into loops around the filled area. Throws
 * `MergeError` when it cannot (coincident curves, loops that do not close).
 */
function mergeContours(
  contours: readonly Contour[],
  filled: (w: number) => boolean,
  tolerance: number,
  extent: number,
  budget: OutlineBudget,
  touching: Vec2[],
): OutlineLoop[] {
  const segments = contours.flatMap((c) => c.segments);
  const boxes = segments.map((s) => boxOf(controlPoints(s)));
  const cuts: Cut[][] = segments.map(() => []);
  const near = (t: number, length: number) =>
    t * length <= tolerance || (1 - t) * length <= tolerance;
  const lengths = segments.map((s) => {
    const p = controlPoints(s);
    let l = 0;
    for (let i = 0; i + 1 < p.length; i++) l += distance(p[i]!, p[i + 1]!);
    return l;
  });

  for (let i = 0; i < segments.length; i++) {
    budget.spend(segments.length - i);
    for (let j = i + 1; j < segments.length; j++) {
      if (!boxesMeet(boxes[i]!, boxes[j]!, tolerance)) continue;
      const pa = controlPoints(segments[i]!);
      const pb = controlPoints(segments[j]!);
      // The same curve twice meets only at its ends; the duplicate piece is dropped below.
      if (sameCurve(pa, pb, tolerance)) continue;
      for (const [t, u] of segmentIntersections(pa, pb, tolerance, budget)) {
        // Two Bezier evaluations and a cut each, about 100 steps' worth.
        budget.spend(100);
        // Meetings at an end are already vertices; chaining joins them by position.
        const cutA = !near(t, lengths[i]!);
        const cutB = !near(u, lengths[j]!);
        if (!cutA && !cutB) continue;
        const qa = bezierPoint(pa, t);
        const qb = bezierPoint(pb, u);
        // Where one is cut at the other's end, the end is the point.
        const point: Vec2 = !cutA
          ? t < 0.5
            ? pa[0]!
            : pa[pa.length - 1]!
          : !cutB
            ? u < 0.5
              ? pb[0]!
              : pb[pb.length - 1]!
            : [(qa[0] + qb[0]) / 2, (qa[1] + qb[1]) / 2];
        if (cutA) cuts[i]!.push({ t, point });
        if (cutB) cuts[j]!.push({ t: u, point });
      }
    }
  }

  // Cut every segment, dropping cuts that fall on top of each other.
  const pieces: OutlineSegment[] = [];
  segments.forEach((segment, i) => {
    // Each cut splits a Bezier and makes a piece, about 100 steps' worth.
    budget.spend(100 * cuts[i]!.length + 1);
    const sorted = cuts[i]!.sort((p, q) => p.t - q.t);
    const kept: Cut[] = [];
    for (const cut of sorted) {
      const last = kept[kept.length - 1];
      if (last && distance(last.point, cut.point) <= tolerance) continue;
      kept.push(cut);
    }
    for (const piece of cutSegment(segment, kept)) {
      const p = controlPoints(piece);
      if (p.every((q) => distance(q, p[0]!) <= tolerance)) continue;
      pieces.push(piece);
    }
  });

  // Keep the pieces with fill on exactly one side, turned to have it on their left.
  const fine = Math.max(tolerance / 10, extent * RELATIVE_FINE_FLATTENING);
  // The fine polygons, and their chords with the command each comes from.
  const fineChords: { a: Vec2; b: Vec2; source: string }[] = [];
  const polygons = contours.map((c) => {
    const out: Vec2[] = [];
    for (const s of c.segments) {
      const p = controlPoints(s);
      const n = bezierChordCount(p, fine, MAX_FINE_CHORDS);
      budget.flattened(n);
      const source = `${s.contour},${s.index}`;
      for (let k = 0; k < n; k++) {
        fineChords.push({ a: bezierPoint(p, k / n), b: bezierPoint(p, (k + 1) / n), source });
        out.push(fineChords[fineChords.length - 1]!.a);
      }
    }
    return out;
  });
  const vertices = polygons.reduce((sum, polygon) => sum + polygon.length, 0);
  const windingAt = (p: Vec2) => polygons.reduce((w, polygon) => w + winding(polygon, p), 0);
  /** Distance from `p` to the nearest chord of another command than `source`. */
  const clearance = (p: Vec2, source: string, limit: number) => {
    let best = limit;
    for (const c of fineChords) {
      if (c.source === source) continue;
      if (
        Math.min(c.a[0], c.b[0]) - best > p[0] ||
        Math.max(c.a[0], c.b[0]) + best < p[0] ||
        Math.min(c.a[1], c.b[1]) - best > p[1] ||
        Math.max(c.a[1], c.b[1]) + best < p[1]
      ) {
        continue;
      }
      const { t } = chordOffset(p, c.a, c.b);
      const q = t <= 0 ? c.a : t >= 1 ? c.b : bezierPoint([c.a, c.b], t);
      best = Math.min(best, distance(p, q));
    }
    return best;
  };
  const edges: Edge[] = [];
  for (const piece of pieces) {
    budget.spend(3 * vertices + edges.length);
    const p = controlPoints(piece);
    const mid = bezierPoint(p, 0.5);
    const chord: Vec2 = [p[p.length - 1]![0] - p[0]![0], p[p.length - 1]![1] - p[0]![1]];
    const [dx, dy] = unit(bezierTangent(p, 0.5), chord);
    const length = Math.hypot(chord[0], chord[1]);
    // Probe each side a little off the piece, closer than any other curve comes: a short
    // piece next to a shallow crossing (an ogonek leaving the bowl of "Ų") has the other
    // curve within a hair of it, and a probe past that curve reads the wrong side's fill.
    const wanted = Math.min(extent * 1e-5, Math.max(length * 0.05, fine * 20));
    const room = clearance(mid, `${piece.contour},${piece.index}`, wanted * 2);
    const offset = Math.min(wanted, Math.max(room / 2, fine * 2));
    const left = filled(windingAt([mid[0] - dy * offset, mid[1] + dx * offset]));
    const right = filled(windingAt([mid[0] + dy * offset, mid[1] - dx * offset]));
    if (left === right) continue;
    const edge = toEdge(left ? piece : reverseSegment(piece));
    // A piece twice (coincident contours running the same way) bounds the fill once.
    if (
      edges.some((e) => sameCurve(controlPoints(e.segment), controlPoints(edge.segment), tolerance))
    ) {
      continue;
    }
    edges.push(edge);
  }

  // Chain the kept pieces into loops. Where several leave one point (loops that
  // touch there), take the sharpest left turn, so each loop stays simple.
  edges.sort((p, q) => {
    const a = p.segment;
    const b = q.segment;
    return a.contour - b.contour || a.index - b.index || a.split - b.split;
  });
  const snap = tolerance * 16;
  const loops: OutlineLoop[] = [];
  for (const first of edges) {
    if (first.used) continue;
    first.used = true;
    const chain: Edge[] = [first];
    for (;;) {
      budget.spend(edges.length);
      const current = chain[chain.length - 1]!;
      let best: Edge | null = null;
      let bestTurn = -Infinity;
      for (const candidate of edges) {
        if (candidate.used && candidate !== first) continue;
        if (distance(candidate.start, current.end) > snap) continue;
        const turn = Math.atan2(
          current.in[0] * candidate.out[1] - current.in[1] * candidate.out[0],
          current.in[0] * candidate.out[0] + current.in[1] * candidate.out[1],
        );
        if (turn > bestTurn) {
          best = candidate;
          bestTurn = turn;
        }
      }
      if (best === null) throw new MergeError('open');
      if (best === first) break;
      best.used = true;
      chain.push(best);
      if (chain.length > edges.length) throw new MergeError('open');
    }
    // Join exactly: each piece starts where the previous one ends.
    const loopSegments = chain.map((edge, k) => {
      const previous = chain[(k + chain.length - 1) % chain.length]!;
      const segment = { ...edge.segment };
      if (segment.kind === 'bezier') {
        segment.points = [...segment.points];
        segment.points[0] = previous.end;
      } else {
        segment.start = previous.end;
      }
      return segment;
    });
    // A chain that comes back through a point it passed (a hole touching the outline
    // there) is split into simple loops at that point: the kernel refuses a pinched wire.
    const parts = splitPinchedLoop(loopSegments, snap, budget, touching);
    for (const part of parts) {
      const area = loopArea(part);
      if (Math.abs(area) <= tolerance * extent) continue;
      // A loop, not Math.min(...spread): a loop can have more segments than the
      // engine allows arguments.
      let contour = Infinity;
      for (const s of part) contour = Math.min(contour, s.contour);
      loops.push({ contour, segments: part, area });
    }
  }
  return loops;
}

// Arcs ----------------------------------------------------------------------------------------

/** The circle through three points, or null when they are (nearly) collinear. */
function circleThrough(a: Vec2, b: Vec2, c: Vec2): { center: Vec2; r: number } | null {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  if (d === 0) return null;
  const a2 = a[0] * a[0] + a[1] * a[1];
  const b2 = b[0] * b[0] + b[1] * b[1];
  const c2 = c[0] * c[0] + c[1] * c[1];
  const x = (a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d;
  const y = (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d;
  const center: Vec2 = [x, y];
  return { center, r: distance(center, a) };
}

type Piece =
  | { kind: 'line'; start: Vec2; end: Vec2 }
  | { kind: 'arc'; center: Vec2; start: Vec2; end: Vec2; clockwise: boolean };

/** Lines and arcs within `tolerance` of a Bezier, by fitting and halving. */
function bezierToArcs(
  points: readonly Vec2[],
  tolerance: number,
  depth: number,
  out: Piece[],
  budget: OutlineBudget,
): void {
  // A fit evaluates the Bezier at every sample, about 20 steps' worth each.
  budget.spend(20 * ARC_SAMPLES);
  const start = points[0]!;
  const end = points[points.length - 1]!;
  // Straight enough: the inner control points lie within the tolerance of the
  // chord and between its ends, so the whole curve does (convex hull).
  const straight = points.slice(1, -1).every((p) => {
    const { d, t } = chordOffset(p, start, end);
    return d <= tolerance && t >= 0 && t <= 1;
  });
  if (straight) {
    out.push({ kind: 'line', start, end });
    return;
  }
  const mid = bezierPoint(points, 0.5);
  const circle = circleThrough(start, mid, end);
  if (circle && depth < MAX_ARC_DEPTH) {
    const { center, r } = circle;
    const clockwise = orient(start, mid, end) < 0;
    const samples: Vec2[] = [];
    for (let i = 1; i < ARC_SAMPLES; i++) samples.push(bezierPoint(points, i / ARC_SAMPLES));
    const fits = samples.every((p) => Math.abs(distance(p, center) - r) <= tolerance);
    // The curve must also turn less than half a circle, so the arc follows it rather than its complement.
    const sweep = arcSweep({ center, start, end, clockwise });
    if (fits && Math.abs(sweep) <= Math.PI) {
      out.push({ kind: 'arc', center, start, end, clockwise });
      return;
    }
  }
  if (depth >= MAX_ARC_DEPTH) {
    out.push({ kind: 'line', start, end });
    return;
  }
  const [left, right] = splitBezier(points, 0.5);
  bezierToArcs(left, tolerance, depth + 1, out, budget);
  bezierToArcs(right, tolerance, depth + 1, out, budget);
}

function loopToArcs(loop: OutlineLoop, tolerance: number, budget: OutlineBudget): OutlineLoop {
  const segments: OutlineSegment[] = [];
  for (const segment of loop.segments) {
    if (segment.kind !== 'bezier') {
      segments.push(segment);
      continue;
    }
    const pieces: Piece[] = [];
    bezierToArcs(segment.points, tolerance, 0, pieces, budget);
    // Pieces are numbered along the source command, whichever way the loop runs it.
    pieces.forEach((p, i) => {
      const piece = segment.reversed ? pieces.length - 1 - i : i;
      segments.push({ ...p, ...sourceOf(segment), piece });
    });
  }
  return { ...loop, segments };
}

// Entry point -------------------------------------------------------------------------------

function extentOf(path: readonly PathCommand[]): number {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const add = (p: Vec2) => {
    minX = Math.min(minX, p[0]);
    minY = Math.min(minY, p[1]);
    maxX = Math.max(maxX, p[0]);
    maxY = Math.max(maxY, p[1]);
  };
  for (const c of path) {
    if (c.kind === 'close') continue;
    add(c.to);
    if (c.kind === 'quadTo') add(c.control);
    if (c.kind === 'cubicTo') {
      add(c.control1);
      add(c.control2);
    }
  }
  return maxX >= minX ? Math.max(maxX - minX, maxY - minY) : 0;
}

function allFinite(path: readonly PathCommand[]): boolean {
  const ok = (p: Vec2) => Number.isFinite(p[0]) && Number.isFinite(p[1]);
  return path.every((c) => {
    if (c.kind === 'close') return true;
    if (c.kind === 'quadTo') return ok(c.to) && ok(c.control);
    if (c.kind === 'cubicTo') return ok(c.to) && ok(c.control1) && ok(c.control2);
    return ok(c.to);
  });
}

/**
 * Turns a path into region loops: outer loops counter-clockwise with their
 * holes clockwise, filled by the fill rule. See the module comment.
 */
export function outlineRegions(
  path: readonly PathCommand[],
  options: OutlineOptions = {},
): OutlineResult {
  const positive = (value: number | undefined) =>
    value === undefined || (Number.isFinite(value) && value > 0);
  if (!positive(options.tolerance)) {
    throw new RangeError(
      `The outline tolerance must be finite and above 0, not ${options.tolerance}.`,
    );
  }
  if (options.arcs && !positive(options.arcs.tolerance)) {
    throw new RangeError(
      `The arc tolerance must be finite and above 0, not ${options.arcs.tolerance}.`,
    );
  }
  const tooComplex = (): OutlineResult => ({
    regions: [],
    issues: [
      {
        code: 'too-complex',
        severity: 'error',
        message: 'The outline has too many segments or overlaps to be converted.',
        contours: [],
      },
    ],
  });
  if (path.length > MAX_OUTLINE_COMMANDS) return tooComplex();
  try {
    return convert(path, options, options.budget ?? new OutlineBudget());
  } catch (error) {
    if (error instanceof TooComplex) return tooComplex();
    throw error;
  }
}

function convert(
  path: readonly PathCommand[],
  options: OutlineOptions,
  budget: OutlineBudget,
): OutlineResult {
  const issues: OutlineIssue[] = [];
  if (!allFinite(path)) {
    issues.push({
      code: 'not-finite',
      severity: 'error',
      message: 'The path has a coordinate that is not a finite number.',
      contours: [],
    });
    return { regions: [], issues };
  }
  const extent = extentOf(path);
  const tolerance = options.tolerance ?? Math.max(1e-9, extent * RELATIVE_TOLERANCE);
  const flattening = Math.max(tolerance, extent * RELATIVE_FLATTENING);
  const evenOdd = options.fillRule === 'evenodd';

  const contours = readContours(path, tolerance, issues).filter((contour) => {
    contour.area = loopArea(contour.segments);
    const polygon: Vec2[] = [];
    for (const segment of contour.segments) {
      const before = polygon.length;
      flattenInto(segment, flattening, polygon);
      budget.flattened(polygon.length - before);
    }
    contour.polygon = polygon;
    // Nothing enclosed: fewer than two segments, or no area to speak of.
    if (contour.segments.length < 2 || Math.abs(contour.area) <= tolerance * extent) {
      issues.push({
        code: 'empty-contour',
        severity: 'warning',
        message: `Contour ${contour.index} encloses no area; it is ignored.`,
        contours: [contour.index],
      });
      return false;
    }
    return true;
  });

  const filled = (w: number) => (evenOdd ? w % 2 !== 0 : w !== 0);
  let loops: OutlineLoop[];
  const touching: Vec2[] = [];
  const crossing = findCrossing(contours, tolerance, budget);
  if (crossing) {
    try {
      loops = mergeContours(contours, filled, tolerance, extent, budget, touching);
    } catch (error) {
      if (!(error instanceof MergeError)) throw error;
      issues.push({
        ...crossing,
        message: `${crossing.message.replace(/;.*$/, '')}, and the overlap could not be merged (curves that run on top of each other).`,
      });
      return { regions: [], issues };
    }
    const merged = new Set<number>();
    for (const loop of loops) {
      const sources = new Set(loop.segments.map((s) => s.contour));
      for (const s of loop.segments) if (s.split > 0 || sources.size > 1) merged.add(s.contour);
    }
    for (const c of crossing.contours) merged.add(c);
    issues.push({
      code: 'merged',
      severity: 'info',
      message: 'Contours that cross or touch were merged into one outline.',
      contours: [...merged].sort((a, b) => a - b),
    });
    if (touching.length > 0) {
      issues.push({
        code: 'touching',
        severity: 'warning',
        message:
          'Loops of the outline touch at a single point; they are kept as separate loops, but a solid made from them is non-manifold there.',
        contours: [...merged].sort((a, b) => a - b),
        point: touching[0]!,
      });
    }
  } else {
    // Disjoint contours: every point of a contour has the same winding number with
    // respect to the others, so its outside's winding is that number, and its
    // inside's is one more or one less, by its own direction. A contour whose
    // box does not hold the point cannot wind around it.
    loops = [];
    const boxes = contours.map((c) => boxOf(c.polygon));
    for (const contour of contours) {
      const at = contour.polygon[0]!;
      let outside = 0;
      budget.spend(contours.length);
      contours.forEach((other, k) => {
        if (other === contour) return;
        const box = boxes[k]!;
        if (at[0] < box.minX || at[0] > box.maxX || at[1] < box.minY || at[1] > box.maxY) return;
        budget.spend(other.polygon.length);
        outside += winding(other.polygon, at);
      });
      const inside = outside + Math.sign(contour.area);
      if (filled(inside) && !filled(outside)) loops.push(toLoop(contour, true));
      else if (filled(outside) && !filled(inside)) loops.push(toLoop(contour, false));
    }
  }

  // Outer loops run counter-clockwise, holes clockwise; each hole goes under the
  // smallest outer loop around it (loops do not cross, so one point decides).
  const flattened = (loop: OutlineLoop) => {
    const polygon: Vec2[] = [];
    for (const segment of loop.segments) {
      const before = polygon.length;
      flattenInto(segment, flattening, polygon);
      budget.flattened(polygon.length - before);
    }
    return polygon;
  };
  const byContour = (a: OutlineLoop, b: OutlineLoop) =>
    a.contour - b.contour ||
    a.segments[0]!.index - b.segments[0]!.index ||
    a.segments[0]!.split - b.segments[0]!.split;
  const regions = loops
    .filter((loop) => loop.area > 0)
    .sort(byContour)
    .map((outer) => ({ outer, polygon: flattened(outer), holes: [] as OutlineLoop[] }));
  for (const hole of loops.filter((loop) => loop.area < 0).sort(byContour)) {
    const at = bezierPoint(controlPoints(hole.segments[0]!), 0.5);
    let best: (typeof regions)[number] | null = null;
    for (const region of regions) {
      budget.spend(region.polygon.length);
      if (winding(region.polygon, at) === 0) continue;
      if (!best || region.outer.area < best.outer.area) best = region;
    }
    // Every hole has fill outside it, so some outer loop surrounds it.
    best?.holes.push(hole);
  }

  const result: OutlineRegion[] = regions.map(({ outer, holes }) => {
    if (!options.arcs) return { outer, holes };
    const t = options.arcs.tolerance;
    return {
      outer: loopToArcs(outer, t, budget),
      holes: holes.map((loop) => loopToArcs(loop, t, budget)),
    };
  });
  return { regions: result, issues };
}

// Several paths --------------------------------------------------------------------------

/** A segment of `outlinePartsRegions`: `contour` counts within its own path, `part`. */
export type OutlinePartSegment = OutlineSegment & {
  /** The path it comes from, by position in the list. */
  part: number;
};

export interface OutlinePartLoop {
  /** The path and contour of the loop (the lowest, when contours were merged into it). */
  part: number;
  contour: number;
  segments: OutlinePartSegment[];
  area: number;
}

export interface OutlinePartRegion {
  outer: OutlinePartLoop;
  holes: OutlinePartLoop[];
}

export type OutlinePartIssue = Omit<OutlineIssue, 'contours'> & {
  /** The paths involved (for SVG artwork, the first few: see `partCount`). */
  parts: number[];
  /** How many paths are involved, when `parts` names only the first few of them. */
  partCount?: number;
  /** The contours involved, as `[part, contour]`. */
  contours: [number, number][];
};

export interface OutlinePartsResult {
  /** Ordered by the outer loop's path, then contour. */
  regions: OutlinePartRegion[];
  issues: OutlinePartIssue[];
}

/** How many contours `outlineRegions` counts in a path (bare `moveTo`s included). */
function contourCount(path: readonly PathCommand[]): number {
  let count = 0;
  let open = false;
  let closed = false;
  const finish = () => {
    if (!open) return;
    count++;
    open = false;
    closed = false;
  };
  for (const command of path) {
    if (command.kind === 'moveTo') {
      finish();
      open = true;
      continue;
    }
    if (command.kind === 'close') {
      closed = true;
      continue;
    }
    open = true;
    if (closed) {
      finish();
      open = true;
    }
  }
  finish();
  return count;
}

function pathBox(path: readonly PathCommand[]): Box | null {
  const points: Vec2[] = [];
  for (const c of path) {
    if (c.kind === 'close') continue;
    points.push(c.to);
    if (c.kind === 'quadTo') points.push(c.control);
    if (c.kind === 'cubicTo') points.push(c.control1, c.control2);
  }
  return points.length > 0 ? boxOf(points) : null;
}

/**
 * Turns several paths (the glyphs of a text) into region loops at once. Paths whose bounding
 * boxes overlap are converted together, so where they really overlap (glyphs that touch after
 * kerning, a script font's joins) they are merged into one outline; every other path is
 * converted on its own, which keeps the cost of merging to the paths that need it. Segments,
 * loops and issues say which path (`part`) and which of its contours they come from; contours
 * are counted within each path as `outlineRegions` counts them. Each group of paths is one
 * `outlineRegions` call with its own limits; the options apply to every group.
 */
export function outlinePartsRegions(
  paths: readonly (readonly PathCommand[])[],
  options: OutlineOptions = {},
): OutlinePartsResult {
  const boxes = paths.map(pathBox);
  // Group overlapping boxes: sweep by left edge, union what meets.
  const parent = paths.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  };
  const order = paths.map((_, i) => i).filter((i) => boxes[i] !== null);
  order.sort((a, b) => boxes[a]!.minX - boxes[b]!.minX || a - b);
  const active: number[] = [];
  for (const i of order) {
    const box = boxes[i]!;
    for (let k = active.length - 1; k >= 0; k--) {
      if (boxes[active[k]!]!.maxX < box.minX) active.splice(k, 1);
    }
    for (const j of active) {
      const other = boxes[j]!;
      if (other.maxY < box.minY || other.minY > box.maxY) continue;
      parent[find(i)] = find(j);
    }
    active.push(i);
  }
  const groups = new Map<number, number[]>();
  for (const i of order.sort((a, b) => a - b)) {
    const root = find(i);
    groups.set(root, [...(groups.get(root) ?? []), i]);
  }

  const regions: OutlinePartRegion[] = [];
  const issues: OutlinePartIssue[] = [];
  for (const members of [...groups.values()].sort((a, b) => a[0]! - b[0]!)) {
    // Every path starts a contour of its own: one that draws before any moveTo starts at the
    // origin, as it would alone.
    const offsets: number[] = [];
    const combined: PathCommand[] = [];
    let total = 0;
    for (const i of members) {
      const path = paths[i]!;
      const own: PathCommand[] =
        path[0]?.kind === 'moveTo' ? [...path] : [{ kind: 'moveTo', to: [0, 0] }, ...path];
      offsets.push(total);
      total += contourCount(own);
      combined.push(...own);
    }
    const locate = (contour: number): [number, number] => {
      let k = 0;
      while (k + 1 < members.length && offsets[k + 1]! <= contour) k++;
      return [members[k]!, contour - offsets[k]!];
    };
    const result = outlineRegions(combined, options);
    const loop = (l: OutlineLoop): OutlinePartLoop => {
      const [part, contour] = locate(l.contour);
      return {
        part,
        contour,
        area: l.area,
        segments: l.segments.map((s) => {
          const [p, c] = locate(s.contour);
          return { ...s, part: p, contour: c };
        }),
      };
    };
    for (const r of result.regions)
      regions.push({ outer: loop(r.outer), holes: r.holes.map(loop) });
    for (const issue of result.issues) {
      const contours = issue.contours.map(locate);
      const parts = [...new Set(contours.map(([p]) => p))].sort((a, b) => a - b);
      issues.push({ ...issue, contours, parts: parts.length > 0 ? parts : [...members] });
    }
  }
  regions.sort((a, b) => a.outer.part - b.outer.part || a.outer.contour - b.outer.contour);
  return { regions, issues };
}

/** How big an `outlinePartsRegions` result is: what callers cap before placing it. */
export interface OutlinePartsSize {
  /** Outer loops and holes. */
  loops: number;
  /** Segments of every loop. */
  curves: number;
  /** Points of every segment: two per line or arc, the control points of a Bezier. */
  points: number;
}

export function outlinePartsSize(result: OutlinePartsResult): OutlinePartsSize {
  const size: OutlinePartsSize = { loops: 0, curves: 0, points: 0 };
  for (const region of result.regions) {
    for (const loop of [region.outer, ...region.holes]) {
      size.loops++;
      size.curves += loop.segments.length;
      for (const s of loop.segments) size.points += s.kind === 'bezier' ? s.points.length : 2;
    }
  }
  return size;
}
