// The profile operation (M5 plan, T5.2b; ADR 0014): cut along or around closed outlines, such as
// the plywood sign's outer cut. Sides (outside, inside, on), depth steps, a finishing pass,
// holding tabs, lead-in and lead-out moves, and entry by plunge, ramp along the path or helix.
//
// The tool centre path is the offset engine's offset of the input loops by the tool radius (plus
// the finishing allowance for the roughing passes), so lines stay lines and arcs stay arcs. Every
// pass walks one closed cut loop once at one depth; the README's "Profile operation" section
// describes the order of passes, the conventions and the warnings.

import type { ArcMove, FeedClass, IrEntry, LinearMove, Toolpath } from '../ir';
import { stockTopZ } from '../job';
import { offsetLoops, regionLoops } from '../offset/engine';
import { checkSegments } from '../offset/flatten';
import {
  distToLoops,
  loopArea,
  pointInLoops,
  sampleSegment,
  segmentLength,
  segmentPoint,
  segmentTangent,
} from '../offset/geometry';
import type { CamWarning, GeneratedToolpath, OperationContext } from '../worker/registry';
import {
  err,
  ok,
  type CamResult,
  type Lead,
  type Loop2,
  type ProfileInput,
  type Segment2,
  type Vec2,
  type Vec3,
} from '../types';
import { reverseLoop } from '../wcs';
import {
  MoveBudgetExceeded,
  OPERATION_MAX_MOVES,
  operationMoveCap,
  withMoveBudget,
} from './budget';
import { entryProblem, helixTooLong, helixTurns, rampTooLong } from './entry';

/**
 * Fields of a profile operation that `ProfileInput` (types.ts) does not have yet. All optional;
 * the core schema (T5.1b) and `ProfileInput` should take them over.
 */
export interface ProfileExtras {
  /**
   * Run a finishing pass at the final wall after the roughing passes. Default: true when
   * `finishAllowance` is greater than zero. With an allowance and `false`, the wall is left
   * oversize for a later operation.
   */
  readonly finishPass?: boolean;
  /**
   * Depth step of the finishing pass, mm. Default: the whole depth in one step when it is within
   * the tool's flute length, otherwise `stepdown`.
   */
  readonly finishStepdown?: number;
  /** Place tabs every `tabSpacing` mm along each cut loop instead of `tabs.count` per loop. */
  readonly tabSpacing?: number;
  /**
   * A loop around scrap (an inside profile, or a hole of an outside one) whose tool centre path
   * has a bounding box narrower than this, mm, gets no tabs: its slug is too small to need
   * holding. Default 25 mm.
   */
  readonly tabMinInsideSize?: number;
}

/** A profile operation as the generator reads it. */
export type ProfileOperation = ProfileInput & ProfileExtras;

/** Rapids stop this far above material the tool has already cut down to, mm. */
export const PROFILE_SAFE_ABOVE = 0.5;

/** The heights an operation that cuts down from `top` moves at, machine Z. */
export interface OperationHeights {
  /** Where the material starts: the stock top, or the operation's top when that is higher. */
  readonly materialTop: number;
  /** Sideways rapids within the operation: never below `materialTop + safeAbove`. */
  readonly retractZ: number;
  /** Where the operation starts and ends: at least the retract height. */
  readonly clearanceZ: number;
  /** Set when the operation's top is below the stock top (stock is left above it). */
  readonly warning?: CamWarning;
}

/**
 * The heights for an operation whose own top is `top`. The floor of the retract height is the
 * material's top, not the operation's: with the stock top above `top` (the origin on the stock
 * bottom with a top margin, say), a retract floor of `top + safeAbove` rapids sideways through
 * the stock. The first approach also feeds down from above the material for the same reason.
 */
export function operationHeights(
  context: OperationContext,
  top: number,
  safeAbove: number = PROFILE_SAFE_ABOVE,
): OperationHeights {
  const heights = context.setup.heights;
  const stockTop = stockTopZ(context.setup);
  const materialTop = Math.max(stockTop, top);
  const retractZ = Math.max(heights.retract, materialTop + safeAbove);
  const clearanceZ = Math.max(heights.clearance, retractZ);
  if (top >= stockTop - EPS) return { materialTop, retractZ, clearanceZ };
  return {
    materialTop,
    retractZ,
    clearanceZ,
    warning: warn(
      'top-below-stock',
      `The operation's top (Z ${fmtMm(top)} mm) is ${fmtMm(stockTop - top)} mm below the stock top (Z ${fmtMm(stockTop)} mm). Rapids stay above the stock and the tool feeds down from there; the first pass also cuts any stock left above its top.`,
    ),
  };
}

const fmtMm = (v: number): string => String(Math.round(v * 1000) / 1000);

/** Default `tabMinInsideSize`, mm. */
export const PROFILE_TAB_MIN_INSIDE_SIZE = 25;

/** A tab is kept at least this far, along the path, from a corner, a short arc or the start, mm. */
export const PROFILE_TAB_MARGIN = 0.5;

/**
 * The most tabs on one loop: `tabs.count` above it is refused, and a `tabSpacing` asking for more
 * gets this many. Far above any real part (a 1,200 mm square sheet's outline with a tab every
 * 50 mm has 96).
 */
export const PROFILE_MAX_TABS = 1000;

/** How close to the source outline a lead or helix may come beyond the cut itself, mm. */
const CLEARANCE_TOLERANCE = 0.005;

/** An arc whose centre lies this close to the source outline is a corner join, mm. */
const CORNER_CENTRE_TOLERANCE = 0.01;

/** Junction tangents further apart than this, radians, make a corner. */
const CORNER_ANGLE = 1e-3;

/** Arc pieces with a chord shorter than this become lines, mm. */
const MIN_ARC_CHORD = 1e-3;

const EPS = 1e-9;

const warn = (code: string, message: string): CamWarning => ({ code, message });

const add2 = (a: Vec2, b: Vec2, k = 1): Vec2 => [a[0] + b[0] * k, a[1] + b[1] * k];
const leftOf = (t: Vec2): Vec2 => [-t[1], t[0]];
const rightOf = (t: Vec2): Vec2 => [t[1], -t[0]];
const dist2 = (a: Vec2 | Vec3, b: Vec2 | Vec3): number => Math.hypot(a[0] - b[0], a[1] - b[1]);

// ---------------------------------------------------------------------------------------------
// Input checks

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const positive = (v: unknown): boolean => finite(v) && v > 0;

function checkLead(lead: Lead, what: string): string | undefined {
  switch (lead.kind) {
    case 'none':
      return undefined;
    case 'line':
      return positive(lead.length) ? undefined : `The ${what} length must be greater than zero.`;
    case 'arc':
      return positive(lead.radius) ? undefined : `The ${what} radius must be greater than zero.`;
    default:
      return `Unknown ${what} kind.`;
  }
}

function checkInput(op: ProfileOperation): string | undefined {
  if (op.side !== 'outside' && op.side !== 'inside' && op.side !== 'on') {
    return `Unknown side '${String(op.side)}'.`;
  }
  if (!positive(op.tool.diameter)) return 'The tool diameter must be greater than zero.';
  if (!finite(op.depth.top) || !finite(op.depth.bottom)) return 'The depths must be finite.';
  if (!(op.depth.top > op.depth.bottom)) return 'The bottom depth must be below the top.';
  if (!positive(op.stepdown)) return 'The stepdown must be greater than zero.';
  if (!finite(op.finishAllowance) || op.finishAllowance < 0) {
    return 'The finishing allowance must be zero or more.';
  }
  if (op.finishStepdown !== undefined && !positive(op.finishStepdown)) {
    return 'The finishing stepdown must be greater than zero.';
  }
  if (!positive(op.feeds.cut) || !positive(op.feeds.plunge)) {
    return 'The cut and plunge feeds must be greater than zero.';
  }
  if (op.feeds.ramp !== undefined && !positive(op.feeds.ramp)) {
    return 'The ramp feed must be greater than zero.';
  }
  if (op.feeds.lead !== undefined && !positive(op.feeds.lead)) {
    return 'The lead feed must be greater than zero.';
  }
  if (op.tabs) {
    const { count, width, height } = op.tabs;
    if (!Number.isInteger(count) || count < 0) return 'The tab count must be a whole number.';
    if (count > PROFILE_MAX_TABS) return `The tab count must be at most ${PROFILE_MAX_TABS}.`;
    if (!positive(width) || !positive(height)) {
      return 'The tab width and height must be greater than zero.';
    }
  }
  if (op.tabSpacing !== undefined && !positive(op.tabSpacing)) {
    return 'The tab spacing must be greater than zero.';
  }
  if (
    op.tabMinInsideSize !== undefined &&
    !(finite(op.tabMinInsideSize) && op.tabMinInsideSize >= 0)
  ) {
    return 'The smallest inside size for tabs must be zero or more.';
  }
  return (
    entryProblem(op.entry) ?? checkLead(op.leadIn, 'lead-in') ?? checkLead(op.leadOut, 'lead-out')
  );
}

// ---------------------------------------------------------------------------------------------
// Cut paths: a closed loop in the direction of travel, starting mid-way along its longest segment

export interface CutPath {
  readonly segments: readonly Segment2[];
  /** `cum[i]` is the path length before segment `i`; `cum[n]` is the whole length. */
  readonly cum: readonly number[];
  readonly length: number;
  /** The scrap (the side away from the wall being cut) is on the left of travel. */
  readonly scrapOnLeft: boolean;
  /** The loop encloses scrap: an inside cut, whose slug drops out. */
  readonly enclosesScrap: boolean;
  /** The distance the path keeps from the source outline (the tool radius plus any allowance). */
  readonly clearance: number;
  /** |area| of the loop, for ordering. */
  readonly area: number;
}

export function subSegment(s: Segment2, t0: number, t1: number): Segment2 {
  const a = t0 <= 0 ? s.start : t0 >= 1 ? s.end : segmentPoint(s, t0);
  const b = t1 >= 1 ? s.end : t1 <= 0 ? s.start : segmentPoint(s, t1);
  if (s.kind === 'line') return { kind: 'line', start: a, end: b };
  return { kind: 'arc', start: a, end: b, center: s.center, ccw: s.ccw };
}

function buildPath(
  loop: Loop2,
  side: ProfileInput['side'],
  climb: boolean,
  clearance: number,
): CutPath {
  const area = loopArea(loop);
  // In a loop's natural orientation (outer counter-clockwise, holes clockwise) the region is on
  // the left. With an M3 (clockwise) spindle the cut is conventional when the wall being cut is on
  // the left of travel and climb when it is on the right. Outside and on cuts have the wall on the
  // left of the natural orientation, inside cuts on the right.
  const naturalIsClimb = side === 'inside';
  const reverse = climb !== naturalIsClimb;
  const travel = reverse ? reverseLoop(loop) : loop;
  const segs = travel.segments;
  let longest = 0;
  for (let i = 1; i < segs.length; i++) {
    if (segmentLength(segs[i]!) > segmentLength(segs[longest]!) + EPS) longest = i;
  }
  const s = segs[longest]!;
  const rotated: Segment2[] = [
    subSegment(s, 0.5, 1),
    ...segs.slice(longest + 1),
    ...segs.slice(0, longest),
    subSegment(s, 0, 0.5),
  ];
  const cum = [0];
  for (const seg of rotated) cum.push(cum[cum.length - 1]! + segmentLength(seg));
  const scrapOnLeftNatural = side === 'inside';
  return {
    segments: rotated,
    cum,
    length: cum[cum.length - 1]!,
    scrapOnLeft: reverse ? !scrapOnLeftNatural : scrapOnLeftNatural,
    enclosesScrap: side === 'inside' ? area > 0 : area < 0,
    clearance,
    area: Math.abs(area),
  };
}

/** Index of the segment holding path position `s` in [0, length]. */
function segmentAt(path: CutPath, s: number): number {
  const n = path.segments.length;
  for (let i = 0; i < n; i++) if (s < path.cum[i + 1]! - EPS) return i;
  return n - 1;
}

function paramAt(path: CutPath, s: number): { seg: Segment2; t: number } {
  const i = segmentAt(path, s);
  const len = path.cum[i + 1]! - path.cum[i]!;
  const t = len > 0 ? Math.min(1, Math.max(0, (s - path.cum[i]!) / len)) : 0;
  return { seg: path.segments[i]!, t };
}

export function pointAt(path: CutPath, s: number): Vec2 {
  const { seg, t } = paramAt(path, s);
  return t <= 0 ? seg.start : t >= 1 ? seg.end : segmentPoint(seg, t);
}

export function tangentAt(path: CutPath, s: number): Vec2 {
  const { seg, t } = paramAt(path, s);
  return segmentTangent(seg, t);
}

/** Unit normal at `s` pointing into the scrap, away from the wall. */
export function scrapNormalAt(path: CutPath, s: number): Vec2 {
  const t = tangentAt(path, s);
  return path.scrapOnLeft ? leftOf(t) : rightOf(t);
}

/** The path position nearest `p`, and its distance. */
export function closestOnPath(path: CutPath, p: Vec2): { s: number; d: number } {
  let best = { s: 0, d: Infinity };
  path.segments.forEach((seg, i) => {
    const len = path.cum[i + 1]! - path.cum[i]!;
    let t: number;
    if (seg.kind === 'line') {
      const dx = seg.end[0] - seg.start[0];
      const dy = seg.end[1] - seg.start[1];
      const l2 = dx * dx + dy * dy;
      t = l2 > 0 ? ((p[0] - seg.start[0]) * dx + (p[1] - seg.start[1]) * dy) / l2 : 0;
      t = Math.min(1, Math.max(0, t));
    } else {
      // Sample, then refine: arcs here are at most a half turn, so the nearest sample brackets it.
      const n = 64;
      let bt = 0;
      let bd = Infinity;
      for (let k = 0; k <= n; k++) {
        const d = dist2(segmentPoint(seg, k / n), p);
        if (d < bd) {
          bd = d;
          bt = k / n;
        }
      }
      let lo = Math.max(0, bt - 1 / n);
      let hi = Math.min(1, bt + 1 / n);
      for (let k = 0; k < 60; k++) {
        const m1 = lo + (hi - lo) / 3;
        const m2 = hi - (hi - lo) / 3;
        if (dist2(segmentPoint(seg, m1), p) < dist2(segmentPoint(seg, m2), p)) hi = m2;
        else lo = m1;
      }
      t = (lo + hi) / 2;
    }
    const d = dist2(segmentPoint(seg, t), p);
    if (d < best.d) best = { s: path.cum[i]! + t * len, d };
  });
  return best;
}

function boundsMinSide(path: CutPath): number {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const seg of path.segments) {
    for (const p of sampleSegment(seg, seg.kind === 'arc' ? 16 : 1)) {
      minX = Math.min(minX, p[0]);
      minY = Math.min(minY, p[1]);
      maxX = Math.max(maxX, p[0]);
      maxY = Math.max(maxY, p[1]);
    }
  }
  return Math.min(maxX - minX, maxY - minY);
}

// ---------------------------------------------------------------------------------------------
// Tabs

interface Interval {
  readonly a: number;
  readonly b: number;
}

/**
 * Where a tab of `span` (along the path) may be centred: inside one run of the path, a stretch
 * with no corner (a sharp junction or a round join about a source vertex), no arc shorter than
 * the tab, and not across the start, kept `PROFILE_TAB_MARGIN` away from each end.
 */
function tabCentreRanges(path: CutPath, span: number, source: readonly Loop2[]): Interval[] {
  const segs = path.segments;
  const excluded = segs.map((seg, i) => {
    if (seg.kind !== 'arc') return false;
    const len = path.cum[i + 1]! - path.cum[i]!;
    return (
      len < span + 2 * PROFILE_TAB_MARGIN ||
      distToLoops(seg.center, source) < CORNER_CENTRE_TOLERANCE
    );
  });
  const runs: Interval[] = [];
  let start: number | undefined;
  for (let i = 0; i < segs.length; i++) {
    if (excluded[i]) {
      if (start !== undefined) runs.push({ a: start, b: path.cum[i]! });
      start = undefined;
      continue;
    }
    if (start !== undefined && i > 0) {
      const t0 = segmentTangent(segs[i - 1]!, 1);
      const t1 = segmentTangent(segs[i]!, 0);
      const angle = Math.abs(
        Math.atan2(t0[0] * t1[1] - t0[1] * t1[0], t0[0] * t1[0] + t0[1] * t1[1]),
      );
      if (angle > CORNER_ANGLE) {
        runs.push({ a: start, b: path.cum[i]! });
        start = undefined;
      }
    }
    start ??= path.cum[i]!;
  }
  if (start !== undefined) runs.push({ a: start, b: path.length });
  const half = span / 2 + PROFILE_TAB_MARGIN;
  return runs.filter((r) => r.b - r.a >= 2 * half).map((r) => ({ a: r.a + half, b: r.b - half }));
}

/** Tab centres on a path: `count` spread evenly by length, each moved to the nearest allowed spot. */
function placeTabs(
  path: CutPath,
  count: number,
  span: number,
  source: readonly Loop2[],
): { centres: number[]; dropped: number } {
  const ranges = tabCentreRanges(path, span, source);
  if (ranges.length === 0) return { centres: [], dropped: count };
  const L = path.length;
  const snapped: number[] = [];
  for (let k = 0; k < count; k++) {
    const want = (L * (k + 0.5)) / count;
    let best = NaN;
    let bestD = Infinity;
    for (const r of ranges) {
      for (const w of [want - L, want, want + L]) {
        const c = Math.min(r.b, Math.max(r.a, w));
        if (Math.abs(c - w) < bestD) {
          bestD = Math.abs(c - w);
          best = c;
        }
      }
    }
    snapped.push(best);
  }
  snapped.sort((a, b) => a - b);
  const kept: number[] = [];
  for (const c of snapped) {
    const last = kept[kept.length - 1];
    if (last !== undefined && c - last < span + PROFILE_TAB_MARGIN) continue;
    kept.push(c);
  }
  // The last tab must also clear the first one across the start.
  while (kept.length > 1 && kept[0]! + L - kept[kept.length - 1]! < span + PROFILE_TAB_MARGIN) {
    kept.pop();
  }
  return { centres: kept, dropped: count - kept.length };
}

// ---------------------------------------------------------------------------------------------
// Leads and helixes

interface LeadGeometry {
  readonly kind: 'line' | 'arc';
  readonly from: Vec2;
  readonly to: Vec2;
  readonly center?: Vec2;
  readonly ccw?: boolean;
  /** Points along it, for the clearance check. */
  readonly samples: readonly Vec2[];
}

/** A lead onto (`in`) or off (`out`) the path at `p`, tangent `t`, on the scrap side `n`. */
function leadGeometry(
  lead: Exclude<Lead, { kind: 'none' }>,
  dir: 'in' | 'out',
  p: Vec2,
  t: Vec2,
  n: Vec2,
  scrapOnLeft: boolean,
): LeadGeometry {
  if (lead.kind === 'line') {
    const far = add2(p, n, lead.length);
    const samples = Array.from({ length: 9 }, (_, k) => add2(p, n, (lead.length * k) / 8));
    return dir === 'in'
      ? { kind: 'line', from: far, to: p, samples }
      : { kind: 'line', from: p, to: far, samples };
  }
  // A quarter turn about a centre on the scrap side, tangent to the path at `p`. Turning toward
  // the scrap side: counter-clockwise when the scrap is on the left.
  const rho = lead.radius;
  const center = add2(p, n, rho);
  const far = add2(center, t, dir === 'in' ? -rho : rho);
  const a0 = Math.atan2(p[1] - center[1], p[0] - center[0]);
  const a1 = Math.atan2(far[1] - center[1], far[0] - center[0]);
  let sweep = a1 - a0;
  while (sweep > Math.PI) sweep -= 2 * Math.PI;
  while (sweep < -Math.PI) sweep += 2 * Math.PI;
  const samples = Array.from({ length: 17 }, (_, k): Vec2 => {
    const a = a0 + (sweep * k) / 16;
    return [center[0] + rho * Math.cos(a), center[1] + rho * Math.sin(a)];
  });
  return dir === 'in'
    ? { kind: 'arc', from: far, to: p, center, ccw: scrapOnLeft, samples }
    : { kind: 'arc', from: p, to: far, center, ccw: scrapOnLeft, samples };
}

/** Tests whether the tool, centred on each point, stays clear of the part (ADR plan risk). */
class ClearanceCheck {
  private readonly polylines: Vec2[][];

  constructor(
    private readonly side: ProfileInput['side'],
    private readonly source: readonly Loop2[],
  ) {
    this.polylines = source.map((loop) =>
      loop.segments.flatMap((s) => sampleSegment(s, s.kind === 'arc' ? 64 : 1).slice(0, -1)),
    );
  }

  /** Every point is at most `band` from the source outline. */
  within(points: readonly Vec2[], band: number): boolean {
    return points.every((p) => distToLoops(p, this.source) <= band + CLEARANCE_TOLERANCE);
  }

  clear(points: readonly Vec2[], clearance: number): boolean {
    if (this.side === 'on') return true;
    for (const p of points) {
      if (distToLoops(p, this.source) < clearance - CLEARANCE_TOLERANCE) return false;
      const inRegion = pointInLoops(p, this.polylines);
      if (this.side === 'outside' ? inRegion : !inRegion) return false;
    }
    return true;
  }
}

// ---------------------------------------------------------------------------------------------
// IR emission

export class Emitter {
  readonly entries: IrEntry[] = [];
  pass = 0;

  /**
   * `maxMoves` caps the entries (`OPERATION_MAX_MOVES` by default, `operationMoveCap` of the
   * context in the generators): adding one more throws `MoveBudgetExceeded`.
   */
  constructor(
    private readonly op: string,
    private readonly feeds: ProfileInput['feeds'],
    public cur: Vec3,
    readonly maxMoves: number = OPERATION_MAX_MOVES,
  ) {}

  /** Adds `entry`, or throws `MoveBudgetExceeded` when the toolpath is already at its cap. */
  push(entry: IrEntry): void {
    if (this.entries.length >= this.maxMoves) throw new MoveBudgetExceeded(this.maxMoves);
    this.entries.push(entry);
  }

  private feed(cls: FeedClass): number {
    switch (cls) {
      case 'cut':
        return this.feeds.cut;
      case 'plunge':
        return this.feeds.plunge;
      case 'ramp':
        return this.feeds.ramp ?? this.feeds.cut;
      case 'lead':
        return this.feeds.lead ?? this.feeds.cut;
    }
  }

  private same(to: Vec3): boolean {
    return dist2(this.cur, to) <= EPS && Math.abs(this.cur[2] - to[2]) <= EPS;
  }

  rapid(to: Vec3): void {
    if (this.same(to)) return;
    this.push({ kind: 'rapid', to, op: this.op, pass: this.pass });
    this.cur = to;
  }

  linear(to: Vec3, feedClass: FeedClass): void {
    if (this.same(to)) return;
    const move: LinearMove = {
      kind: 'linear',
      to,
      feed: this.feed(feedClass),
      feedClass,
      op: this.op,
      pass: this.pass,
    };
    this.push(move);
    this.cur = to;
  }

  /** An arc (or helix) from the current position; a tiny one becomes a line. */
  arc(to: Vec3, center: Vec2, ccw: boolean, feedClass: FeedClass, fullCircle = false): void {
    if (!fullCircle && dist2(this.cur, to) < MIN_ARC_CHORD) {
      this.linear(to, feedClass);
      return;
    }
    const move: ArcMove = {
      kind: 'arc',
      to,
      center,
      direction: ccw ? 'ccw' : 'cw',
      fullCircle,
      feed: this.feed(feedClass),
      feedClass,
      op: this.op,
      pass: this.pass,
    };
    this.push(move);
    this.cur = to;
  }

  /** A segment piece from the current position at `za` to its end at `zb`. */
  segment(piece: Segment2, za: number, zb: number): void {
    if (Math.abs(this.cur[2] - za) > EPS) {
      this.linear([this.cur[0], this.cur[1], za], za > this.cur[2] ? 'cut' : 'plunge');
    }
    if (dist2(this.cur, piece.start) > EPS)
      this.linear([piece.start[0], piece.start[1], za], 'cut');
    const cls: FeedClass = zb < za - EPS ? 'ramp' : 'cut';
    const to: Vec3 = [piece.end[0], piece.end[1], zb];
    if (piece.kind === 'line') this.linear(to, cls);
    else this.arc(to, piece.center, piece.ccw, cls);
  }

  lead(g: LeadGeometry, z: number): void {
    if (dist2(this.cur, g.from) > EPS) this.linear([g.from[0], g.from[1], z], 'lead');
    const to: Vec3 = [g.to[0], g.to[1], z];
    if (g.kind === 'line') this.linear(to, 'lead');
    else this.arc(to, g.center!, g.ccw!, 'lead');
  }
}

/** Z along a pass: a ramp from `from` at `s0` to `to` at `rampEnd`, then level. */
export interface ZProfile {
  readonly s0: number;
  readonly rampEnd: number;
  readonly from: number;
  readonly to: number;
}

function zAt(z: ZProfile, s: number): number {
  if (s >= z.rampEnd || z.rampEnd <= z.s0) return z.to;
  return z.from - ((s - z.s0) / (z.rampEnd - z.s0)) * (z.from - z.to);
}

/** Walk the path from `s0` to `s1` (which may wrap past its length), lifting over tabs. */
export function walk(
  em: Emitter,
  path: CutPath,
  s1: number,
  z: ZProfile,
  tabs: readonly Interval[],
  tabTop: number,
): void {
  const L = path.length;
  const s0 = z.s0;
  const breaks = new Set<number>([s0, s1]);
  const addBreak = (s: number): void => {
    if (s > s0 + EPS && s < s1 - EPS) breaks.add(s);
  };
  for (let k = Math.floor(s0 / L); k <= Math.floor(s1 / L); k++) {
    for (const c of path.cum) addBreak(k * L + c);
    for (const t of tabs) {
      addBreak(k * L + t.a);
      addBreak(k * L + t.b);
    }
  }
  addBreak(z.rampEnd);
  const sorted = [...breaks].sort((a, b) => a - b);
  for (let i = 0; i + 1 < sorted.length; i++) piece(sorted[i]!, sorted[i + 1]!);

  function piece(a: number, b: number): void {
    if (b - a < EPS) return;
    const k = Math.floor((a + b) / 2 / L);
    const la = a - k * L;
    const lb = b - k * L;
    const mid = (la + lb) / 2;
    const inTab = tabs.some((t) => mid > t.a && mid < t.b);
    let za = zAt(z, a);
    let zb = zAt(z, b);
    if (inTab) {
      if (za < tabTop !== zb < tabTop && Math.abs(za - zb) > EPS) {
        const sc = a + ((b - a) * (za - tabTop)) / (za - zb);
        if (sc - a > EPS && b - sc > EPS) {
          piece(a, sc);
          piece(sc, b);
          return;
        }
      }
      za = Math.max(za, tabTop);
      zb = Math.max(zb, tabTop);
    }
    const i = segmentAt(path, mid);
    const seg = path.segments[i]!;
    const len = path.cum[i + 1]! - path.cum[i]!;
    const t0 = len > 0 ? (la - path.cum[i]!) / len : 0;
    const t1 = len > 0 ? (lb - path.cum[i]!) / len : 1;
    em.segment(
      subSegment(seg, Math.abs(t0) < 1e-12 ? 0 : t0, Math.abs(t1 - 1) < 1e-12 ? 1 : t1),
      za,
      zb,
    );
  }
}

// ---------------------------------------------------------------------------------------------
// The generator

function cutLoops(
  loops: readonly Loop2[],
  side: ProfileInput['side'],
  distance: number,
): CamResult<Loop2[]> {
  if (side === 'on') {
    for (let i = 0; i < loops.length; i++) {
      const problem = checkSegments(loops[i]!.segments, true);
      if (problem) return err('invalid-input', `loop ${i}: ${problem}`);
    }
    return ok([...loops]);
  }
  const regions = offsetLoops(loops, side === 'outside' ? distance : -distance);
  if (!regions.ok) return regions;
  return ok(regionLoops(regions.value));
}

/** How far apart, mm along the path, `roughingCovers` samples a finishing loop. */
const COVER_STEP = 0.5;

/**
 * Whether roughing along `rough` cleared the whole way along the finishing loop `f`: every sample
 * of `f` lies within the allowance of a roughing path. A concave corner puts the two paths' sharp
 * vertices up to about 1.4 allowances apart (90 degrees), so the limit is 1.5 allowances; a
 * sharper concave corner fails the test and its loop is cut in roughing steps, which is safe.
 */
export function roughingCovers(f: CutPath, rough: readonly CutPath[], allowance: number): boolean {
  if (rough.length === 0) return false;
  const limit = 1.5 * allowance + CLEARANCE_TOLERANCE;
  for (const seg of f.segments) {
    const n = Math.max(1, Math.ceil(segmentLength(seg) / COVER_STEP));
    for (const p of sampleSegment(seg, n)) if (distToLoops(p, rough) > limit) return false;
  }
  return true;
}

/**
 * The most depth levels `levels` makes for one cut. A stepdown so small that it needs more is a
 * slip (0.001 mm typed for 1 mm, say), not a plan: 1000 levels is a 50 mm cut in 0.05 mm steps.
 */
export const MAX_DEPTH_LEVELS = 1000;

/**
 * Depth levels from below `top` down to `bottom` in equal steps of at most `step`; one level, at
 * `bottom`, when `bottom` is not below `top`. An error (never a silent empty or clamped list) when
 * a number is not finite, `step` is not greater than zero, or the cut would need more than
 * `MAX_DEPTH_LEVELS` levels: a clamped stepdown would cut deeper per pass than the user asked.
 */
export function levels(top: number, bottom: number, step: number): CamResult<number[]> {
  if (!finite(top) || !finite(bottom)) return err('invalid-input', 'The depths must be finite.');
  if (!positive(step)) return err('invalid-input', `The stepdown must be greater than zero.`);
  const count = (top - bottom) / step - 1e-9;
  if (count > MAX_DEPTH_LEVELS) {
    return err(
      'invalid-input',
      `A stepdown of ${step} mm over ${top - bottom} mm needs ${Math.ceil(count)} depth passes; at most ${MAX_DEPTH_LEVELS} are allowed. Use a larger stepdown.`,
    );
  }
  const n = Math.max(1, Math.ceil(count));
  return ok(
    Array.from({ length: n }, (_, k) =>
      k === n - 1 ? bottom : top - ((k + 1) * (top - bottom)) / n,
    ),
  );
}

interface PassPlan {
  readonly path: CutPath;
  readonly levels: readonly number[];
  readonly tabs: readonly Interval[];
  /**
   * For a finishing loop whose roughing came first: the furthest its tool centre may be from the
   * part while below the stock's top (the roughing path's offset). Beyond it lies uncut stock.
   */
  readonly band?: number;
}

/**
 * Generates a profile operation's toolpath (registered as the `profile` generator). Passes, in
 * order: every roughing loop (smallest first, so inner cuts finish while the part is still held)
 * at each depth step, then every finishing loop the same way. `pass` numbers them from 0.
 */
export async function generateProfile(
  input: ProfileInput,
  context: OperationContext,
): Promise<CamResult<GeneratedToolpath>> {
  return withMoveBudget(input.id, () => profileToolpath(input, context));
}

async function profileToolpath(
  input: ProfileInput,
  context: OperationContext,
): Promise<CamResult<GeneratedToolpath>> {
  const op = input as ProfileOperation;
  const problem = checkInput(op);
  if (problem) return err('invalid-input', `${op.id}: ${problem}`);
  if (op.loops.length === 0) return err('invalid-input', `${op.id}: the profile has no loops.`);

  const warnings: CamWarning[] = [];
  const warned = new Set<string>();
  const once = (code: string, message: string): void => {
    if (warned.has(code)) return;
    warned.add(code);
    warnings.push(warn(code, message));
  };

  const side = op.side;
  const r = op.tool.diameter / 2;
  const { top, bottom } = op.depth;
  const depth = top - bottom;
  if (side === 'on' && op.finishAllowance > 0) {
    once('allowance-ignored', 'A profile on the line has no finishing allowance; it is ignored.');
  }
  const allowance = side === 'on' ? 0 : op.finishAllowance;
  const finishing = side !== 'on' && (op.finishPass ?? allowance > 0);
  if (depth > op.tool.fluteLength) {
    once(
      'depth-exceeds-flutes',
      `The cut is ${depth} mm deep but the tool's flutes are ${op.tool.fluteLength} mm long.`,
    );
  }

  // The tool centre loops.
  const rough = cutLoops(op.loops, side, side === 'on' ? 0 : r + allowance);
  if (!rough.ok) return err(rough.error.code, `${op.id}: ${rough.error.message}`);
  const finish = finishing ? cutLoops(op.loops, side, r) : ok<Loop2[]>([]);
  if (!finish.ok) return err(finish.error.code, `${op.id}: ${finish.error.message}`);
  if (rough.value.length === 0 && finish.value.length === 0) {
    return err(
      'invalid-input',
      `${op.id}: the ${op.tool.diameter} mm tool does not fit inside the profile.`,
    );
  }
  // Loops around scrap the tool does not fit into at all: inside loops, and holes of an outside
  // profile (a hole shrinks as the region grows).
  if (side !== 'on') {
    const fit = finishing ? r : r + allowance;
    op.loops.forEach((loop, i) => {
      const area = loopArea(loop);
      const scrap =
        side === 'inside'
          ? area > 0
            ? loop
            : undefined
          : area < 0
            ? reverseLoop(loop)
            : undefined;
      if (!scrap) return;
      const alone = offsetLoops([scrap], -fit);
      if (alone.ok && alone.value.length === 0) {
        warnings.push(
          warn(
            'loop-too-small',
            `${side === 'inside' ? 'Loop' : 'Hole'} ${i} is too small for the ${op.tool.diameter} mm tool; it is not cut.`,
          ),
        );
      }
    });
  }

  const byArea = (a: CutPath, b: CutPath): number => a.area - b.area;
  const roughPaths = rough.value
    .map((l) => buildPath(l, side, op.climb, side === 'on' ? 0 : r + allowance))
    .sort(byArea);
  const finishPaths = finish.value.map((l) => buildPath(l, side, op.climb, r)).sort(byArea);

  // Tabs: placed on the loops that cut the final wall, then carried to the others by position.
  const tabs = op.tabs;
  const tabTop = bottom + (tabs?.height ?? 0);
  const tabsByPath = new Map<CutPath, Interval[]>();
  if (!tabs && op.tabSpacing !== undefined) {
    once(
      'tab-spacing-unused',
      'A tab spacing is set but no tab width and height: no tabs are made.',
    );
  }
  if (tabs && (tabs.count > 0 || op.tabSpacing !== undefined)) {
    if (tabTop >= top) {
      once(
        'tabs-unused',
        `The tabs are ${tabs.height} mm high, as deep as the cut: none are made.`,
      );
    } else {
      const span = tabs.width + op.tool.diameter;
      const reference = finishing ? finishPaths : roughPaths;
      const minInside = op.tabMinInsideSize ?? PROFILE_TAB_MIN_INSIDE_SIZE;
      const points: Vec2[] = [];
      let skipped = 0;
      let dropped = 0;
      for (const path of reference) {
        if (path.enclosesScrap && boundsMinSide(path) < minInside) {
          skipped++;
          continue;
        }
        let count =
          op.tabSpacing !== undefined
            ? Math.max(1, Math.round(path.length / op.tabSpacing))
            : tabs.count;
        if (count > PROFILE_MAX_TABS) {
          count = PROFILE_MAX_TABS;
          once(
            'tabs-capped',
            `The tab spacing of ${op.tabSpacing} mm asks for more than ${PROFILE_MAX_TABS} tabs on a loop; ${PROFILE_MAX_TABS} are placed.`,
          );
        }
        const placed = placeTabs(path, count, span, op.loops);
        dropped += placed.dropped;
        for (const c of placed.centres) points.push(pointAt(path, c));
      }
      if (skipped > 0) {
        warnings.push(
          warn(
            'tabs-skipped',
            `${skipped} loop(s) around scrap (inside cuts, or holes of an outside profile) whose tool centre path is narrower than ${minInside} mm get no tabs.`,
          ),
        );
      }
      /** Carries the tab points to the nearest of `paths`; returns how many had to be dropped. */
      const assign = (paths: readonly CutPath[]): number => {
        let lost = 0;
        for (const p of points) {
          let best: { path: CutPath; s: number; d: number } | undefined;
          for (const path of paths) {
            const c = closestOnPath(path, p);
            if (!best || c.d < best.d) best = { path, ...c };
          }
          if (!best || best.d > allowance + 0.1) continue;
          const a = best.s - span / 2;
          const b = best.s + span / 2;
          if (a < 0 || b > best.path.length) {
            lost++;
            continue;
          }
          const list = tabsByPath.get(best.path) ?? [];
          list.push({ a, b });
          tabsByPath.set(best.path, list);
        }
        return lost;
      };
      const roughLost = assign(roughPaths);
      if (finishing) {
        dropped += assign(finishPaths);
        if (roughLost > 0) {
          warnings.push(
            warn(
              'tabs-dropped',
              `${roughLost} tab(s) could not be kept in the roughing passes (they would cross a loop's start). The roughing cuts through at those spots, so there the part is held only by a sliver as thin as the finishing allowance (${allowance} mm).`,
            ),
          );
        }
      } else {
        dropped += roughLost;
      }
      if (dropped > 0) {
        warnings.push(
          warn(
            'tabs-dropped',
            `${dropped} tab(s) had no room clear of corners, short arcs and the start.`,
          ),
        );
      }
    }
  }

  const finishStep = op.finishStepdown ?? (depth <= op.tool.fluteLength ? depth : op.stepdown);
  // Each loop is roughed and finished before any loop enclosing it is cut: groups of roughing
  // loops (each with the finishing loop nearest its start), smallest finishing loop first. An
  // enclosed loop always has the smaller area.
  const roughLevels = levels(top, bottom, op.stepdown);
  if (!roughLevels.ok) return err(roughLevels.error.code, `${op.id}: ${roughLevels.error.message}`);
  const finishLevels = levels(top, bottom, finishStep);
  if (!finishLevels.ok) {
    return err(finishLevels.error.code, `${op.id}: ${finishLevels.error.message}`);
  }
  const plan = (path: CutPath, lv: readonly number[], band?: number): PassPlan => ({
    path,
    levels: lv,
    tabs: tabsByPath.get(path) ?? [],
    ...(band !== undefined ? { band } : {}),
  });
  const plans: PassPlan[] = [];
  if (finishPaths.length === 0) {
    for (const path of roughPaths) plans.push(plan(path, roughLevels.value));
  } else {
    const groups = new Map<CutPath, CutPath[]>(finishPaths.map((f) => [f, []]));
    for (const rp of roughPaths) {
      const p = pointAt(rp, 0);
      let best = finishPaths[0]!;
      let bestD = Infinity;
      for (const f of finishPaths) {
        const d = closestOnPath(f, p).d;
        if (d < bestD) {
          bestD = d;
          best = f;
        }
      }
      groups.get(best)!.push(rp);
    }
    const roughed: CutPath[] = [];
    let unroughed = 0;
    for (const f of finishPaths) {
      const rough = groups.get(f)!;
      for (const rp of rough) plans.push(plan(rp, roughLevels.value));
      roughed.push(...rough);
      // A finishing loop is finished in one go only where the roughing cleared along all of it.
      // Where the roughing offset pinched off or merged (a neck or a gap narrower than the
      // allowance), or the allowance closed the loop, it is cut in roughing steps instead.
      if (roughingCovers(f, roughed, allowance)) {
        plans.push(plan(f, finishLevels.value, r + allowance));
      } else {
        if (rough.length > 0) unroughed++;
        plans.push(plan(f, roughLevels.value));
      }
    }
    if (unroughed > 0) {
      warnings.push(
        warn(
          'finish-steps-down',
          `${unroughed} finishing loop(s) run where the roughing could not reach (a neck or gap narrower than the allowance); they are cut in stepdown steps.`,
        ),
      );
    }
  }

  const opHeights = operationHeights(context, top);
  const { materialTop, retractZ, clearanceZ } = opHeights;
  if (opHeights.warning) once(opHeights.warning.code, opHeights.warning.message);
  const check = new ClearanceCheck(side, op.loops);

  const em = new Emitter(op.id, op.feeds, [0, 0, clearanceZ], operationMoveCap(context));
  let startPos: Vec3 | undefined;

  if (op.entry.kind === 'ramp' && op.leadIn.kind !== 'none') {
    once('lead-in-ignored', 'A ramp entry starts on the path, so the lead-in is not used.');
  }

  for (const plan of plans) {
    const { path } = plan;
    const p0 = pointAt(path, 0);
    const t0 = tangentAt(path, 0);
    const n0 = scrapNormalAt(path, 0);

    /** Whether a lead may be cut: clear of the part, and inside the roughed slot when finishing. */
    const leadAllowed = (g: LeadGeometry): boolean => {
      if (!check.clear(g.samples, path.clearance)) {
        once(
          'lead-collision',
          'A lead move would cut into the part; the operation goes without it.',
        );
        return false;
      }
      if (plan.band !== undefined && !check.within(g.samples, plan.band)) {
        once(
          'finish-lead-dropped',
          'A finishing lead would leave the roughed slot and cut uncut stock at full depth; the finishing pass goes without it.',
        );
        return false;
      }
      return true;
    };

    let leadIn: LeadGeometry | undefined;
    if (op.entry.kind !== 'ramp' && op.leadIn.kind !== 'none') {
      leadIn = leadGeometry(op.leadIn, 'in', p0, t0, n0, path.scrapOnLeft);
      if (!leadAllowed(leadIn)) leadIn = undefined;
    }
    const entryXY = leadIn ? leadIn.from : p0;

    let helix: { center: Vec2; radius: number; angle: number } | undefined;
    const entry = op.entry;
    if (entry.kind === 'helix') {
      const center = add2(entryXY, n0, entry.radius);
      const ring = Array.from({ length: 33 }, (_, k): Vec2 => {
        const a = (2 * Math.PI * k) / 32;
        return [center[0] + entry.radius * Math.cos(a), center[1] + entry.radius * Math.sin(a)];
      });
      if (
        check.clear(ring, path.clearance) &&
        (plan.band === undefined || check.within(ring, plan.band))
      ) {
        helix = { center, radius: entry.radius, angle: entry.angle };
      } else {
        once(
          'helix-fallback',
          'The helix would cut into the part or into uncut stock; those passes plunge instead.',
        );
      }
    }

    if (!startPos) {
      // The toolpath starts at clearance height above the first entry point.
      startPos = [entryXY[0], entryXY[1], clearanceZ];
      em.cur = startPos;
    }

    // The first pass of each loop comes down from above the material, not the operation's top.
    let cleared = materialTop;
    for (const z of plan.levels) {
      await context.checkpoint();
      // Move to the entry point, unless the last pass left the tool right there.
      const feedFrom = Math.min(retractZ, cleared + PROFILE_SAFE_ABOVE);
      if (!(dist2(em.cur, entryXY) <= EPS && em.cur[2] <= feedFrom + EPS)) {
        if (em.cur[2] < retractZ) em.rapid([em.cur[0], em.cur[1], retractZ]);
        em.rapid([entryXY[0], entryXY[1], em.cur[2]]);
        em.rapid([entryXY[0], entryXY[1], feedFrom]);
      }

      // Down to depth.
      let s1 = path.length;
      let zp: ZProfile = { s0: 0, rampEnd: 0, from: z, to: z };
      if (op.entry.kind === 'ramp') {
        const rampLength = (cleared - z) / Math.tan(op.entry.angle);
        const tooLong = rampTooLong(
          rampLength,
          path.length,
          path.segments.length,
          plan.tabs.length,
        );
        if (tooLong) return err('invalid-input', `${op.id}: ${tooLong}`);
        em.linear([entryXY[0], entryXY[1], Math.min(em.cur[2], cleared)], 'plunge');
        zp = { s0: 0, rampEnd: rampLength, from: cleared, to: z };
        s1 = rampLength + path.length;
      } else if (helix) {
        const drop = cleared - z;
        const turns = helixTurns(drop, helix.radius, helix.angle);
        const tooLong = helixTooLong(turns, drop, helix.radius, helix.angle);
        if (tooLong) return err('invalid-input', `${op.id}: ${tooLong}`);
        em.linear([entryXY[0], entryXY[1], Math.min(em.cur[2], cleared)], 'plunge');
        for (let k = 1; k <= turns; k++) {
          const zk = k === turns ? z : cleared - (drop * k) / turns;
          em.arc([entryXY[0], entryXY[1], zk], helix.center, path.scrapOnLeft, 'ramp', true);
        }
      } else {
        em.linear([entryXY[0], entryXY[1], z], 'plunge');
      }

      if (leadIn) em.lead(leadIn, z);
      walk(em, path, s1, zp, plan.tabs, tabTop);

      if (op.leadOut.kind !== 'none') {
        const sEnd = s1 % path.length;
        const out = leadGeometry(
          op.leadOut,
          'out',
          [em.cur[0], em.cur[1]],
          tangentAt(path, sEnd),
          scrapNormalAt(path, sEnd),
          path.scrapOnLeft,
        );
        if (leadAllowed(out)) em.lead(out, em.cur[2]);
      }
      cleared = z;
      em.pass++;
    }
  }
  em.pass = Math.max(0, em.pass - 1);
  em.rapid([em.cur[0], em.cur[1], clearanceZ]);

  const toolpath: Toolpath = { start: startPos ?? [0, 0, clearanceZ], entries: em.entries };
  return ok(warnings.length > 0 ? { toolpath, warnings } : { toolpath });
}
