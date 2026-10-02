// The offset engine's public operations (M5 plan, T5.2a; ADR 0014 decision 12): offsets of closed
// loops (round joins, for tool compensation), offsets of open paths, and booleans, on line/arc
// loops in millimetres, with results rebuilt into lines and arcs by the tagged refit.
//
// clipper2-ts does the polygon work behind this adapter, which owns the integer scale, the range
// checks, the Z tags and their callback. Nothing else in the package imports clipper2-ts.

import {
  ClipType,
  Clipper64,
  ClipperOffset,
  EndType,
  FillRule,
  JoinType,
  PolyTree64,
  type Point64,
  type PolyPath64,
} from 'clipper2-ts';
import { err, ok, type CamResult, type Loop2, type Segment2, type Vec2 } from '../types';
import { analyticOffset } from './analytic';
import { checkSegments, tagPath, TagTable } from './flatten';
import { loopArea, sampleSegment } from './geometry';
import { refitClosed } from './refit';
import { CLIPPER_SCALE, GRBL_CHECK_DECIMALS, JOIN_TOLERANCE, REFIT_TOLERANCE } from './tolerances';

/**
 * A region: one counter-clockwise outer loop and the clockwise holes directly inside it. An island
 * inside a hole is a region of its own.
 */
export interface Region2 {
  readonly outer: Loop2;
  readonly holes: readonly Loop2[];
}

/** An open chain of lines and arcs, each starting where the previous one ends. */
export interface OpenPath2 {
  readonly segments: readonly Segment2[];
}

export interface OffsetOptions {
  /**
   * Use the analytic fast path where it applies (a lone circle, or a convex loop offset
   * outward). Default true; false always goes through Clipper.
   */
  readonly analytic?: boolean;
  /** Decimals the refit's Grbl arc check rounds to (default 3, the posts' default). */
  readonly decimals?: number;
}

export interface OpenOffsetOptions {
  /** End caps: `round` (a half circle about each end) or `butt` (square at the end). Default round. */
  readonly ends?: 'round' | 'butt';
  readonly decimals?: number;
}

/** Miter limit handed to Clipper; unused with round joins, set for completeness. */
const MITER_LIMIT = 2;

/** Offsets smaller than this (mm) are below Clipper's resolution and treated as zero. */
const MIN_DELTA = 0.5 / CLIPPER_SCALE;

/**
 * Gives an intersection Clipper's own Z rule leaves untagged the tag of the nearest of the four
 * edge ends that carries one, which is what the refit needs (T5.0a spike, "Z tags").
 */
function nearestTag(bot1: Point64, top1: Point64, bot2: Point64, top2: Point64, ip: Point64): void {
  let best = 0;
  let bestD = Infinity;
  for (const e of [bot1, top1, bot2, top2]) {
    if (!e.z) continue;
    const d = Math.hypot(ip.x - e.x, ip.y - e.y);
    if (d < bestD) {
      bestD = d;
      best = e.z;
    }
  }
  ip.z = best;
}

function tagLoops(
  table: TagTable,
  loops: readonly { readonly segments: readonly Segment2[] }[],
  closed: boolean,
  what: string,
): CamResult<Point64[][]> {
  const paths: Point64[][] = [];
  for (let i = 0; i < loops.length; i++) {
    const problem = checkSegments(loops[i]!.segments, closed);
    if (problem) return err('invalid-input', `${what} ${i}: ${problem}`);
    paths.push(tagPath(table, loops[i]!.segments, closed));
  }
  return ok(paths);
}

function refitPolygon(
  polygon: readonly Point64[],
  table: TagTable,
  delta: number,
  decimals: number,
): Loop2 | undefined {
  const pts: Vec2[] = polygon.map((p) => [p.x / CLIPPER_SCALE, p.y / CLIPPER_SCALE]);
  const tags = polygon.map((p) => p.z ?? 0);
  const segments = refitClosed(pts, tags, table, delta, { decimals });
  return segments.length > 0 ? { segments } : undefined;
}

/** Regions from a Clipper tree: outers at even depth, their holes below, islands as new regions. */
function treeToRegions(
  tree: PolyPath64,
  table: TagTable,
  delta: number,
  decimals: number,
): Region2[] {
  const regions: Region2[] = [];
  const visitOuter = (node: PolyPath64): void => {
    const outer = node.polygon ? refitPolygon(node.polygon, table, delta, decimals) : undefined;
    const holes: Loop2[] = [];
    for (let h = 0; h < node.count; h++) {
      const hole = node.child(h);
      const loop = hole.polygon ? refitPolygon(hole.polygon, table, delta, decimals) : undefined;
      if (loop) holes.push(loop);
      for (let k = 0; k < hole.count; k++) visitOuter(hole.child(k));
    }
    if (outer) regions.push({ outer, holes });
  };
  for (let i = 0; i < tree.count; i++) visitOuter(tree.child(i));
  return cleanRegions(regions);
}

/** A loop that fits in a square `2 * REFIT_TOLERANCE` wide: too small to mean anything. */
function negligible(loop: Loop2): boolean {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const s of loop.segments) {
    for (const p of sampleSegment(s, 4)) {
      minX = Math.min(minX, p[0]);
      minY = Math.min(minY, p[1]);
      maxX = Math.max(maxX, p[0]);
      maxY = Math.max(maxY, p[1]);
    }
  }
  return Math.max(maxX - minX, maxY - minY) <= 2 * REFIT_TOLERANCE;
}

/**
 * The same last filter for every path (Clipper or analytic): negligible loops are dropped, and so,
 * as a guard, is any outer that is not counter-clockwise, so no result ever holds one.
 */
function cleanRegions(regions: readonly Region2[]): Region2[] {
  return regions
    .filter((r) => !negligible(r.outer) && loopArea(r.outer) > 0)
    .map((r) => ({ outer: r.outer, holes: r.holes.filter((h) => !negligible(h)) }));
}

function checkDelta(delta: number): CamResult<number> {
  if (!Number.isFinite(delta))
    return err('invalid-input', `offset ${delta} is not a finite number`);
  return ok(delta);
}

function booleanOp(
  clipType: ClipType,
  subject: readonly Loop2[],
  clip: readonly Loop2[],
  decimals: number,
): CamResult<Region2[]> {
  const table = new TagTable();
  const s = tagLoops(table, subject, true, 'loop');
  if (!s.ok) return s;
  const c = tagLoops(table, clip, true, 'clip loop');
  if (!c.ok) return c;
  const clipper = new Clipper64();
  clipper.zCallback = nearestTag;
  clipper.addSubject(s.value);
  if (c.value.length > 0) clipper.addClip(c.value);
  const tree = new PolyTree64();
  clipper.execute(clipType, FillRule.Positive, tree);
  return ok(treeToRegions(tree, table, 0, decimals));
}

/**
 * Offsets closed loops by `delta` mm: positive grows the material (outward from outer loops, into
 * holes), negative shrinks it. Loops follow the `Loop2` convention: outer loops counter-clockwise,
 * holes clockwise. They are united first with positive winding as inside, so overlapping outers
 * merge and a clockwise loop that no counter-clockwise loop encloses encloses nothing (a lone one
 * gives an empty list). Corners get round joins. A shape can split into several regions or vanish
 * (an empty list); loops that fit within `REFIT_TOLERANCE` are dropped.
 */
export function offsetLoops(
  loops: readonly Loop2[],
  delta: number,
  options: OffsetOptions = {},
): CamResult<Region2[]> {
  const d = checkDelta(delta);
  if (!d.ok) return d;
  const decimals = options.decimals ?? GRBL_CHECK_DECIMALS;
  if (loops.length === 0) return ok([]);
  if (Math.abs(delta) < MIN_DELTA) return booleanOp(ClipType.Union, loops, [], decimals);
  if (options.analytic !== false && loops.length === 1) {
    const problem = checkSegments(loops[0]!.segments, true);
    if (problem) return err('invalid-input', `loop 0: ${problem}`);
    const fast = analyticOffset(loops[0]!, delta, decimals);
    if (fast) return ok(cleanRegions(fast.map((outer) => ({ outer, holes: [] }))));
  }
  const table = new TagTable();
  const paths = tagLoops(table, loops, true, 'loop');
  if (!paths.ok) return paths;
  // Normalise first: Clipper's offset treats a set whose lowest loop is clockwise as reversed, so
  // a lone or stray clockwise loop would come back as a clockwise outer. A union with the
  // positive fill rule keeps only what the convention calls inside (tags pass through).
  const norm = new Clipper64();
  norm.zCallback = nearestTag;
  norm.addSubject(paths.value);
  const united: Point64[][] = [];
  norm.execute(ClipType.Union, FillRule.Positive, united);
  if (united.length === 0) return ok([]);
  const co = new ClipperOffset(MITER_LIMIT, JOIN_TOLERANCE * CLIPPER_SCALE);
  co.zCallback = nearestTag;
  co.addPaths(united, JoinType.Round, EndType.Polygon);
  const tree = new PolyTree64();
  co.execute(delta * CLIPPER_SCALE, tree);
  return ok(treeToRegions(tree, table, delta, decimals));
}

/**
 * Offsets open paths by `delta` mm (greater than zero) to both sides: the closed outline of a
 * stroke `2 delta` wide along each path, with round or butt ends. Overlapping outlines are united.
 */
export function offsetOpenPaths(
  paths: readonly OpenPath2[],
  delta: number,
  options: OpenOffsetOptions = {},
): CamResult<Region2[]> {
  const d = checkDelta(delta);
  if (!d.ok) return d;
  if (!(delta >= MIN_DELTA)) {
    return err('invalid-input', `an open path offset must be greater than zero, got ${delta}`);
  }
  if (paths.length === 0) return ok([]);
  const table = new TagTable();
  const tagged = tagLoops(table, paths, false, 'path');
  if (!tagged.ok) return tagged;
  const co = new ClipperOffset(MITER_LIMIT, JOIN_TOLERANCE * CLIPPER_SCALE);
  co.zCallback = nearestTag;
  co.addPaths(
    tagged.value,
    JoinType.Round,
    (options.ends ?? 'round') === 'round' ? EndType.Round : EndType.Butt,
  );
  const tree = new PolyTree64();
  co.execute(delta * CLIPPER_SCALE, tree);
  return ok(treeToRegions(tree, table, delta, options.decimals ?? GRBL_CHECK_DECIMALS));
}

/** The union of closed loops (positive winding is inside). */
export function unionLoops(
  loops: readonly Loop2[],
  options: Pick<OffsetOptions, 'decimals'> = {},
): CamResult<Region2[]> {
  return booleanOp(ClipType.Union, loops, [], options.decimals ?? GRBL_CHECK_DECIMALS);
}

/** `subject` minus `clip`: stock minus part, pocket minus islands. */
export function differenceLoops(
  subject: readonly Loop2[],
  clip: readonly Loop2[],
  options: Pick<OffsetOptions, 'decimals'> = {},
): CamResult<Region2[]> {
  return booleanOp(ClipType.Difference, subject, clip, options.decimals ?? GRBL_CHECK_DECIMALS);
}

/** The intersection of `subject` and `clip`. */
export function intersectLoops(
  subject: readonly Loop2[],
  clip: readonly Loop2[],
  options: Pick<OffsetOptions, 'decimals'> = {},
): CamResult<Region2[]> {
  return booleanOp(ClipType.Intersection, subject, clip, options.decimals ?? GRBL_CHECK_DECIMALS);
}

/** Every loop of the regions, outers and holes, in order. */
export function regionLoops(regions: readonly Region2[]): Loop2[] {
  return regions.flatMap((r) => [r.outer, ...r.holes]);
}

/** Exact area of a region, mm2: its outer loop's minus its holes'. */
export function regionArea(region: Region2): number {
  return region.holes.reduce((a, h) => a + loopArea(h), loopArea(region.outer));
}
