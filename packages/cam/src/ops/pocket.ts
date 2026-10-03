// The pocket operation (M5 plan, T5.2c; ADR 0014): clear an area to a depth, leaving islands
// standing, such as the plywood sign's recessed border. Contour-parallel clearing by repeated
// inward offsets with a stepover, cut from the inside out and linked at depth where the link stays
// in cleared material; helical entry with a ramp or plunge fallback; a floor allowance with a floor
// pass; a finishing wall pass; and areas the tool cannot reach reported with their area.
//
// The geometry (`pocketGeometry`) is separate from the toolpath so other operations can reuse it:
// V-carve's flat-bottom clearing (T5.2f) calls `generatePocket`, and 3D roughing (T5.5a) clears
// its z-level slices with `generatePocketLayers`. The README's "Pocket operation" section describes
// the order of moves, the conventions and the warnings.

import {
  differenceLoops,
  offsetLoops,
  offsetOpenPaths,
  regionArea,
  regionLoops,
  unionLoops,
} from '../offset/engine';
import type { Region2 } from '../offset/engine';
import { flattenSegments } from '../offset/flatten';
import {
  distToLoops,
  distToSegment,
  loopArea,
  pointInLoops,
  segmentLength,
  signedSweep,
} from '../offset/geometry';
import type { CamWarning, GeneratedToolpath, OperationContext } from '../worker/registry';
import {
  err,
  ok,
  type ArcSegment2,
  type CamResult,
  type Loop2,
  type PocketInput,
  type Segment2,
  type Vec2,
  type Vec3,
} from '../types';
import { reverseLoop } from '../wcs';
import { operationMoveCap, withMoveBudget } from './budget';
import { entryProblem, helixTooLong, helixTurns, rampTooLong } from './entry';
import {
  Emitter,
  PROFILE_SAFE_ABOVE,
  closestOnPath,
  levels,
  pointAt,
  roughingCovers,
  scrapNormalAt,
  subSegment,
  walk,
  type CutPath,
  type ZProfile,
} from './profile';

/**
 * Fields of a pocket operation that `PocketInput` (types.ts) does not have yet. All optional; the
 * core schema (T5.1b) and `PocketInput` should take them over.
 */
export interface PocketExtras {
  /**
   * Run a finishing pass along the walls (and around the islands) after the clearing. Default:
   * true when `finishAllowance` is greater than zero. With an allowance and `false`, the walls
   * are left oversize for a later operation.
   */
  readonly finishPass?: boolean;
  /**
   * Depth step of the finishing pass, mm. Default: the whole depth in one step when it is within
   * the tool's flute length, otherwise `stepdown`.
   */
  readonly finishStepdown?: number;
  /** Material the clearing leaves on the floor, mm. Default 0. */
  readonly floorAllowance?: number;
  /**
   * Clear the floor allowance in one more pass at the bottom. Default: true when `floorAllowance`
   * is greater than zero.
   */
  readonly floorPass?: boolean;
}

/** A pocket operation as the generator reads it. */
export type PocketOperation = PocketInput & PocketExtras;

/** One z-level of `generatePocketLayers`: the loops to clear at machine Z `z`. */
export interface PocketLayer {
  readonly z: number;
  readonly loops: readonly Loop2[];
}

/** Rapids stop this far above material the tool has already cut down to, mm. */
export const POCKET_SAFE_ABOVE = PROFILE_SAFE_ABOVE;

/**
 * A helix narrower than this fraction of the tool radius is no helix: the entry ramps along the
 * innermost ring instead.
 */
export const POCKET_MIN_HELIX_FACTOR = 0.2;

/**
 * Uncut areas smaller than this times the tool radius squared are not reported. A round tool
 * leaves about 0.215 r^2 in every square corner, which no flat end mill can reach and no user
 * wants a warning for; anything larger (a sharper corner, a neck, a gap) is reported.
 */
export const POCKET_UNREACHABLE_MIN_AREA_FACTOR = 0.25;

/** Coverage is computed with the tool this much wider, mm, so offset noise makes no slivers. */
const COVER_TOLERANCE = 0.01;

/** How close a tool centre may come to the part beyond the cut's own offset, mm. */
const CLEARANCE_TOLERANCE = 0.005;

/** Uncovered areas below this, mm2, are noise. */
const CUSP_MIN_AREA = 1e-3;

/** Rounds of clean-up spots added for stepover cusps. */
const CLEANUP_ROUNDS = 3;

/** More rings than this means a stepover far too small for the pocket. */
const MAX_RINGS = 20000;

/** A drop into cleared space keeps the tool this far inside what the tool cleared, mm. */
const DROP_MARGIN = 0.05;

/** Links are checked every this many mm. */
const LINK_STEP = 0.5;

const EPS = 1e-9;

const warn = (code: string, message: string): CamWarning => ({ code, message });
const dist2 = (a: Vec2 | Vec3, b: Vec2 | Vec3): number => Math.hypot(a[0] - b[0], a[1] - b[1]);
const fmt = (v: number, d = 1): string => (Math.round(v * 10 ** d) / 10 ** d + 0).toFixed(d);

// ---------------------------------------------------------------------------------------------
// Exact distance from a straight move to the pocket's loops

/** Distance from `p` to the segment `a`-`b`. */
function distToLine(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.min(1, Math.max(0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

const cross = (o: Vec2, a: Vec2, b: Vec2): number =>
  (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

/** Whether the angle of `p` about the arc's centre lies within the arc's sweep. */
function onArc(arc: ArcSegment2, p: Vec2): boolean {
  const sweep = signedSweep(arc);
  if (Math.abs(sweep) >= 2 * Math.PI - 1e-12) return true;
  const a0 = Math.atan2(arc.start[1] - arc.center[1], arc.start[0] - arc.center[0]);
  const a = Math.atan2(p[1] - arc.center[1], p[0] - arc.center[0]);
  const tau = 2 * Math.PI;
  const d = sweep > 0 ? (((a - a0) % tau) + tau) % tau : (((a0 - a) % tau) + tau) % tau;
  return d <= Math.abs(sweep) + 1e-12;
}

/** Exact distance between the segment `a`-`b` and a line or arc segment. */
function lineToSegment(a: Vec2, b: Vec2, seg: Segment2): number {
  if (seg.kind === 'line') {
    const c = seg.start;
    const d = seg.end;
    const d1 = cross(a, b, c);
    const d2 = cross(a, b, d);
    const d3 = cross(c, d, a);
    const d4 = cross(c, d, b);
    if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
      return 0;
    }
    return Math.min(
      distToLine(a, c, d),
      distToLine(b, c, d),
      distToLine(c, a, b),
      distToLine(d, a, b),
    );
  }
  const ctr = seg.center;
  const rad = Math.hypot(seg.start[0] - ctr[0], seg.start[1] - ctr[1]);
  let best = Math.min(
    distToSegment(a, seg),
    distToSegment(b, seg),
    distToLine(seg.start, a, b),
    distToLine(seg.end, a, b),
  );
  // The point of the move nearest the centre, and where the move crosses the circle.
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  if (l2 > 0) {
    const t = ((ctr[0] - a[0]) * dx + (ctr[1] - a[1]) * dy) / l2;
    const tc = Math.min(1, Math.max(0, t));
    const q: Vec2 = [a[0] + tc * dx, a[1] + tc * dy];
    const dq = Math.hypot(q[0] - ctr[0], q[1] - ctr[1]);
    if (dq > EPS && onArc(seg, q)) best = Math.min(best, Math.abs(dq - rad));
    const foot = Math.hypot(a[0] + t * dx - ctr[0], a[1] + t * dy - ctr[1]);
    if (foot <= rad) {
      const half = Math.sqrt((rad * rad - foot * foot) / l2);
      for (const u of [t - half, t + half]) {
        if (u >= 0 && u <= 1 && onArc(seg, [a[0] + u * dx, a[1] + u * dy])) return 0;
      }
    }
  }
  return best;
}

/** Exact distance between the segment `a`-`b` and the loops. */
function lineToLoops(a: Vec2, b: Vec2, loops: readonly Loop2[]): number {
  let best = Infinity;
  for (const loop of loops)
    for (const seg of loop.segments) best = Math.min(best, lineToSegment(a, b, seg));
  return best;
}

// ---------------------------------------------------------------------------------------------
// Geometry

/** A clearing ring: a tool centre loop at `offset` from the pocket's walls and islands. */
export interface PocketRing {
  readonly loop: Loop2;
  readonly offset: number;
}

/**
 * One region of the inward offset at `offset`: an outer ring and the rings around islands inside
 * it. `children` are the regions of the next offset inside it (a region splits at a neck).
 */
export interface PocketNode {
  readonly outer: Loop2;
  readonly holes: readonly Loop2[];
  readonly offset: number;
  readonly children: readonly PocketNode[];
}

/** An area left uncut, mm2, with a point inside it for messages. */
export interface UncutArea {
  readonly loops: readonly Loop2[];
  readonly area: number;
  readonly at: Vec2;
}

/** A clean-up spot: the tool centre visits `at` after cutting `ring`, to clear a stepover cusp. */
export interface PocketSpot {
  readonly at: Vec2;
  readonly ring: Loop2;
}

export interface PocketGeometryOptions {
  /** Tool radius, mm. */
  readonly toolRadius: number;
  /** Distance between rings, mm, in (0, 2 * toolRadius]. */
  readonly stepover: number;
  /** Material the clearing leaves on the walls, mm. */
  readonly allowance: number;
  /** A finishing pass follows at the tool radius (changes what counts as unreachable). */
  readonly finishing: boolean;
}

export interface PocketGeometry {
  readonly options: PocketGeometryOptions;
  /** The pocket's loops, united: outers counter-clockwise, islands clockwise. */
  readonly source: readonly Loop2[];
  /** Regions of the first ring (`toolRadius + allowance` in), each with its nested rings. */
  readonly roots: readonly PocketNode[];
  readonly rings: readonly PocketRing[];
  readonly spots: readonly PocketSpot[];
  /** Tool centre loops of the finishing pass (at the tool radius); empty without finishing. */
  readonly finishLoops: readonly Loop2[];
  /** Areas the tool cannot reach at all: narrower than the tool, or sharp corners. */
  readonly unreachable: readonly UncutArea[];
  /** Area the rings and clean-up spots still leave between rings, mm2 (normally 0). */
  readonly cuspArea: number;
  /** How far `p` is inside the pocket from its nearest wall or island; -1 outside. */
  depthIn(p: Vec2): number;
  /** Whether the tool centre may stand at `p`: inside, at least `clearance` from every wall. */
  centreAllowed(p: Vec2, clearance?: number): boolean;
  /**
   * Whether the tool centre may move straight from `a` to `b`: `a` inside and the whole move
   * at least `clearance` from every wall and island (an exact distance, not samples).
   */
  moveAllowed(a: Vec2, b: Vec2, clearance?: number): boolean;
}

const polysOf = (loops: readonly Loop2[]): Vec2[][] =>
  loops.map((l) => flattenSegments(l.segments, true, 0.01));

/** A point well inside the region (the most inside of a grid of samples and the centroid). */
function interiorPoint(loops: readonly Loop2[]): Vec2 {
  const polys = polysOf(loops);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of polys[0] ?? []) {
    minX = Math.min(minX, p[0]);
    minY = Math.min(minY, p[1]);
    maxX = Math.max(maxX, p[0]);
    maxY = Math.max(maxY, p[1]);
  }
  const candidates: Vec2[] = [];
  const outer = polys[0] ?? [];
  if (outer.length > 0) {
    candidates.push([
      outer.reduce((a, p) => a + p[0], 0) / outer.length,
      outer.reduce((a, p) => a + p[1], 0) / outer.length,
    ]);
  }
  const n = 16;
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= n; j++) {
      candidates.push([minX + ((maxX - minX) * i) / n, minY + ((maxY - minY) * j) / n]);
    }
  }
  let best: Vec2 | undefined;
  let bestD = -Infinity;
  for (const c of candidates) {
    if (!pointInLoops(c, polys)) continue;
    const d = distToLoops(c, loops);
    if (d > bestD) {
      bestD = d;
      best = c;
    }
  }
  if (best) return best;
  const s = loops[0]!.segments[0]!;
  return s.start;
}

const circleLoop = (center: Vec2, radius: number): Loop2 => {
  const start: Vec2 = [center[0] + radius, center[1]];
  const arc: ArcSegment2 = { kind: 'arc', start, end: start, center, ccw: true, fullCircle: true };
  return { segments: [arc] };
};

const prefixed = <T>(r: CamResult<T>, what: string): CamResult<T> =>
  r.ok ? r : err(r.error.code, `${what}: ${r.error.message}`);

/**
 * The pocket's clearing geometry: rings at `toolRadius + allowance + k * stepover` from the walls
 * and islands as a tree of regions, clean-up spots for stepover cusps, the finishing loops, and
 * the areas the tool cannot reach. Pure geometry; no depths, no feeds.
 */
export function pocketGeometry(
  loops: readonly Loop2[],
  options: PocketGeometryOptions,
): CamResult<PocketGeometry> {
  const { toolRadius: r, stepover: s, allowance: a, finishing } = options;
  if (!(r > 0) || !(s > 0) || !(s <= 2 * r + EPS) || !(a >= 0)) {
    return err('invalid-input', 'pocket geometry: bad tool radius, stepover or allowance.');
  }
  const united = unionLoops(loops);
  if (!united.ok) return united;
  const source = regionLoops(united.value);
  const sourcePolys = polysOf(source);
  const depthIn = (p: Vec2): number => (pointInLoops(p, sourcePolys) ? distToLoops(p, source) : -1);
  const d0 = r + a;
  const centreAllowed = (p: Vec2, clearance = d0): boolean =>
    depthIn(p) >= clearance - CLEARANCE_TOLERANCE;
  const moveAllowed = (p: Vec2, q: Vec2, clearance = d0): boolean =>
    centreAllowed(p, clearance) && lineToLoops(p, q, source) >= clearance - CLEARANCE_TOLERANCE;

  // Rings, as a tree of regions.
  interface Node {
    readonly outer: Loop2;
    readonly holes: readonly Loop2[];
    readonly offset: number;
    readonly children: Node[];
    readonly polys: Vec2[][];
  }
  const rings: PocketRing[] = [];
  const roots: Node[] = [];
  let previous: Node[] = [];
  for (let k = 0; ; k++) {
    if (k > MAX_RINGS) {
      return err('invalid-input', `the stepover gives more than ${MAX_RINGS} rings.`);
    }
    const offset = d0 + k * s;
    const regions = offsetLoops(loops, -offset);
    if (!regions.ok) return regions;
    if (regions.value.length === 0) break;
    const current: Node[] = [];
    for (const region of regions.value) {
      const node: Node = {
        outer: region.outer,
        holes: region.holes,
        offset,
        children: [],
        polys: polysOf([region.outer, ...region.holes]),
      };
      for (const loop of [region.outer, ...region.holes]) rings.push({ loop, offset });
      if (k === 0) roots.push(node);
      else {
        const p = region.outer.segments[0]!.start;
        const parent = previous.find((n) => pointInLoops(p, n.polys)) ?? previous[0];
        parent?.children.push(node);
      }
      current.push(node);
    }
    previous = current;
  }

  // Stepover cusps: what roughing can reach minus what the rings sweep, cleaned up with spots.
  const spots: PocketSpot[] = [];
  let cuspArea = 0;
  if (rings.length > 0) {
    const reach = offsetLoops(
      regionLoops(roots.map((n) => ({ outer: n.outer, holes: n.holes }))),
      r,
    );
    if (!reach.ok) return prefixed(reach, 'pocket coverage');
    const covered = offsetOpenPaths(
      rings.map((ring) => ({ segments: ring.loop.segments })),
      r + COVER_TOLERANCE,
    );
    if (!covered.ok) return prefixed(covered, 'pocket coverage');
    const clip = regionLoops(covered.value);
    let left: Region2[] = [];
    for (let round = 0; round <= CLEANUP_ROUNDS; round++) {
      const diff = differenceLoops(regionLoops(reach.value), clip);
      if (!diff.ok) return prefixed(diff, 'pocket coverage');
      left = diff.value.filter((region) => regionArea(region) > CUSP_MIN_AREA);
      if (left.length === 0 || round === CLEANUP_ROUNDS) break;
      let added = 0;
      for (const region of left) {
        const at = interiorPoint([region.outer, ...region.holes]);
        if (!centreAllowed(at)) continue;
        const depth = depthIn(at);
        let ring: PocketRing | undefined;
        let ringD = Infinity;
        for (const candidate of rings) {
          if (candidate.offset > depth + CLEARANCE_TOLERANCE) continue;
          const d = distToLoops(at, [candidate.loop]);
          if (d < ringD) {
            ringD = d;
            ring = candidate;
          }
        }
        if (!ring) continue;
        spots.push({ at, ring: ring.loop });
        clip.push(circleLoop(at, r + COVER_TOLERANCE));
        added++;
      }
      if (added === 0) break;
    }
    cuspArea = left.reduce((sum, region) => sum + regionArea(region), 0);
  }

  // Finishing loops, and what nothing reaches.
  let finishLoops: Loop2[] = [];
  if (finishing) {
    const f = offsetLoops(loops, -r);
    if (!f.ok) return f;
    finishLoops = regionLoops(f.value);
  }
  const wall = finishing ? r : d0;
  const target = finishing ? ok(united.value) : offsetLoops(loops, -a);
  if (!target.ok) return target;
  const centres = offsetLoops(loops, -wall);
  if (!centres.ok) return centres;
  const reachable = offsetLoops(regionLoops(centres.value), r + COVER_TOLERANCE);
  if (!reachable.ok) return reachable;
  const uncut = differenceLoops(regionLoops(target.value), regionLoops(reachable.value));
  if (!uncut.ok) return uncut;
  const unreachable: UncutArea[] = uncut.value
    .map((region) => {
      const regionLoopsList = [region.outer, ...region.holes];
      return {
        loops: regionLoopsList,
        area: regionArea(region),
        at: interiorPoint(regionLoopsList),
      };
    })
    .filter((u) => u.area >= POCKET_UNREACHABLE_MIN_AREA_FACTOR * r * r);

  const publicNode = (n: Node): PocketNode => ({
    outer: n.outer,
    holes: n.holes,
    offset: n.offset,
    children: n.children.map(publicNode),
  });
  return ok({
    options,
    source,
    roots: roots.map(publicNode),
    rings,
    spots,
    finishLoops,
    unreachable,
    cuspArea,
    depthIn,
    centreAllowed,
    moveAllowed,
  });
}

// ---------------------------------------------------------------------------------------------
// Paths

/** Full circles become two half circles, so every piece of a path has a definite start and end. */
function splitFullCircles(loop: Loop2): Segment2[] {
  return loop.segments.flatMap((seg): Segment2[] => {
    if (seg.kind !== 'arc' || !seg.fullCircle) return [seg];
    const mid = subSegment(seg, 0, 0.5).end;
    const half = (start: Vec2, end: Vec2): ArcSegment2 =>
      seg.source
        ? { kind: 'arc', start, end, center: seg.center, ccw: seg.ccw, source: seg.source }
        : { kind: 'arc', start, end, center: seg.center, ccw: seg.ccw };
    return [half(seg.start, mid), half(mid, seg.start)];
  });
}

function pathFrom(segments: readonly Segment2[], scrapOnLeft: boolean, clearance: number): CutPath {
  const cum = [0];
  for (const seg of segments) cum.push(cum[cum.length - 1]! + segmentLength(seg));
  const loop = { segments };
  const area = loopArea(loop);
  return {
    segments,
    cum,
    length: cum[cum.length - 1]!,
    scrapOnLeft,
    enclosesScrap: area > 0,
    clearance,
    area: Math.abs(area),
  };
}

/**
 * A ring or wall loop as a cut path in the direction of travel, starting at its point nearest
 * `near`. In a loop's natural orientation the pocket is on the left, so the material being cut
 * (toward the walls, or toward an island) is on the right: climb milling with an M3 spindle.
 */
function ringPath(loop: Loop2, near: Vec2, climb: boolean, clearance: number): CutPath {
  const travel = splitFullCircles(climb ? loop : reverseLoop(loop));
  const whole = pathFrom(travel, climb, clearance);
  const { s } = closestOnPath(whole, near);
  let i = 0;
  while (i < travel.length - 1 && s >= whole.cum[i + 1]! - EPS) i++;
  const len = whole.cum[i + 1]! - whole.cum[i]!;
  const t = len > 0 ? (s - whole.cum[i]!) / len : 0;
  let rotated: Segment2[];
  if (t <= 1e-9) rotated = [...travel.slice(i), ...travel.slice(0, i)];
  else if (t >= 1 - 1e-9) rotated = [...travel.slice(i + 1), ...travel.slice(0, i + 1)];
  else {
    const seg = travel[i]!;
    rotated = [
      subSegment(seg, t, 1),
      ...travel.slice(i + 1),
      ...travel.slice(0, i),
      subSegment(seg, 0, t),
    ];
  }
  return pathFrom(rotated, climb, clearance);
}

// ---------------------------------------------------------------------------------------------
// Input checks

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const positive = (v: unknown): boolean => finite(v) && v > 0;

function checkInput(op: PocketOperation): string | undefined {
  if (!positive(op.tool.diameter)) return 'The tool diameter must be greater than zero.';
  if (!finite(op.depth.top) || !finite(op.depth.bottom)) return 'The depths must be finite.';
  if (!(op.depth.top > op.depth.bottom)) return 'The bottom depth must be below the top.';
  if (!positive(op.stepdown)) return 'The stepdown must be greater than zero.';
  if (!(finite(op.stepover) && op.stepover > 0 && op.stepover <= 1)) {
    return 'The stepover must be greater than 0 and at most 1 (a fraction of the tool diameter).';
  }
  if (!finite(op.finishAllowance) || op.finishAllowance < 0) {
    return 'The finishing allowance must be zero or more.';
  }
  if (op.finishStepdown !== undefined && !positive(op.finishStepdown)) {
    return 'The finishing stepdown must be greater than zero.';
  }
  const fa = op.floorAllowance ?? 0;
  if (!finite(fa) || fa < 0) return 'The floor allowance must be zero or more.';
  if (fa >= op.depth.top - op.depth.bottom) {
    return 'The floor allowance must be less than the depth of the pocket.';
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
  return entryProblem(op.entry);
}

// ---------------------------------------------------------------------------------------------
// The cutter: emits clearing layers and finishing passes

class PocketCutter {
  readonly em: Emitter;
  readonly warnings: CamWarning[] = [];
  /** Why the toolpath is refused (an entry too long to emit), set by `clearLayer`. */
  failure: string | undefined;
  private readonly warned = new Set<string>();
  private startPos: Vec3 | undefined;
  private readonly r: number;
  private readonly retractZ: number;
  private readonly clearanceZ: number;

  constructor(
    private readonly op: PocketOperation,
    private readonly context: OperationContext,
  ) {
    this.r = op.tool.diameter / 2;
    const heights = context.setup.heights;
    this.retractZ = Math.max(heights.retract, op.depth.top + POCKET_SAFE_ABOVE);
    this.clearanceZ = Math.max(heights.clearance, this.retractZ);
    this.em = new Emitter(op.id, op.feeds, [0, 0, this.clearanceZ], operationMoveCap(context));
  }

  once(code: string, message: string): void {
    if (this.warned.has(code)) return;
    this.warned.add(code);
    this.warnings.push(warn(code, message));
  }

  /** Over `xy`, at `fromZ + POCKET_SAFE_ABOVE` (or retract), by rapids over the retract height. */
  private moveAbove(xy: Vec2, fromZ: number): void {
    const em = this.em;
    const feedFrom = Math.min(this.retractZ, fromZ + POCKET_SAFE_ABOVE);
    if (!this.startPos) {
      this.startPos = [xy[0], xy[1], this.clearanceZ];
      em.cur = this.startPos;
    }
    if (dist2(em.cur, xy) <= EPS && em.cur[2] <= feedFrom + EPS) return;
    if (em.cur[2] < this.retractZ) em.rapid([em.cur[0], em.cur[1], this.retractZ]);
    em.rapid([xy[0], xy[1], em.cur[2]]);
    em.rapid([xy[0], xy[1], feedFrom]);
  }

  /** Clears one layer: every region from the inside out, linked at depth where it can be. */
  async clearLayer(
    geom: PocketGeometry,
    z: number,
    previous: { readonly geom: PocketGeometry; readonly z: number } | undefined,
  ): Promise<void> {
    const op = this.op;
    const em = this.em;
    const r = this.r;
    const s = geom.options.stepover;
    const top = op.depth.top;
    const cut: Loop2[] = [];
    const visited: Vec2[] = [];
    let atDepth = false;
    /** The ring the tool is on, and where along it: the way back into cleared material. */
    let last: { path: CutPath; s: number } | undefined;
    const cutPaths: CutPath[] = [];
    const spotsOf = new Map<Loop2, Vec2[]>();
    for (const spot of geom.spots) {
      const list = spotsOf.get(spot.ring) ?? [];
      list.push(spot.at);
      spotsOf.set(spot.ring, list);
    }

    /** The Z this layer's entry starts from at points `pts`: the layer above where it cleared them. */
    const fromZ = (pts: readonly Vec2[]): number => {
      if (!previous) return top;
      if (previous.geom === geom || pts.every((p) => previous.geom.centreAllowed(p))) {
        return previous.z;
      }
      return top;
    };

    /**
     * A straight move at depth keeps the tool centre clear of the walls and islands (exactly)
     * and within a stepover of what is cut (checked every quarter stepover).
     */
    const linkAllowed = (from: Vec2, to: Vec2): boolean => {
      if (!geom.moveAllowed(from, to)) return false;
      const n = Math.max(1, Math.ceil(dist2(from, to) / Math.min(LINK_STEP, s / 4)));
      for (let k = 0; k <= n; k++) {
        const p: Vec2 = [
          from[0] + ((to[0] - from[0]) * k) / n,
          from[1] + ((to[1] - from[1]) * k) / n,
        ];
        const near =
          distToLoops(p, cut) <= s + CLEARANCE_TOLERANCE ||
          visited.some((v) => dist2(v, p) <= s + CLEARANCE_TOLERANCE);
        if (!near) return false;
      }
      return true;
    };

    const level: ZProfile = { s0: 0, rampEnd: 0, from: z, to: z };

    /** Walks `path` from its start to `s1` (past its length for more than a lap). */
    const cutAlong = (path: CutPath, s1: number, zp: ZProfile = level): void => {
      walk(em, path, s1, zp, [], -Infinity);
      last = { path, s: s1 % path.length };
      cutPaths.push(path);
    };

    /** Down to `z` along the ring by a ramp, then a full lap; or a plunge and a lap. */
    const rampOrPlunge = (path: CutPath, allowRamp: boolean): void => {
      const start = pointAt(path, 0);
      const entry = op.entry;
      const from = fromZ(path.segments.map((seg) => seg.start));
      this.moveAbove(start, from);
      const cleared = Math.min(em.cur[2], from);
      if (allowRamp && entry.kind !== 'plunge' && path.length >= op.tool.diameter) {
        const rampLength = (cleared - z) / Math.tan(entry.angle);
        const tooLong = rampTooLong(rampLength, path.length, path.segments.length);
        if (tooLong) {
          this.failure ??= tooLong;
          return;
        }
        em.linear([start[0], start[1], cleared], 'plunge');
        cutAlong(path, rampLength + path.length, {
          s0: 0,
          rampEnd: rampLength,
          from: cleared,
          to: z,
        });
        return;
      }
      if (allowRamp && entry.kind !== 'plunge') {
        this.once(
          'entry-plunge',
          'A ring is too short to ramp along (shorter than the tool diameter); the tool plunges there.',
        );
      }
      em.linear([start[0], start[1], z], 'plunge');
      cutAlong(path, path.length);
    };

    /** Enters a leaf region by a helix about its most inside point, or falls back. */
    const enterLeaf = (node: PocketNode, loop: Loop2): void => {
      const entry = op.entry;
      if (entry.kind !== 'helix') {
        rampOrPlunge(ringPath(loop, loop.segments[0]!.start, op.climb, node.offset), true);
        return;
      }
      const center = interiorPoint([node.outer, ...node.holes]);
      const space = geom.depthIn(center) - (r + geom.options.allowance) - CLEARANCE_TOLERANCE;
      const radius = Math.min(entry.radius, space);
      if (!(radius >= POCKET_MIN_HELIX_FACTOR * r)) {
        this.once(
          'helix-fallback',
          `A helix does not fit in part of the pocket (room for a ${fmt(Math.max(0, space), 2)} mm radius); the tool ramps along the ring there instead.`,
        );
        rampOrPlunge(ringPath(loop, center, op.climb, node.offset), true);
        return;
      }
      const target = ringPath(loop, center, op.climb, node.offset);
      const ringStart = pointAt(target, 0);
      const toward = dist2(ringStart, center);
      const dir: Vec2 =
        toward > EPS
          ? [(ringStart[0] - center[0]) / toward, (ringStart[1] - center[1]) / toward]
          : [1, 0];
      const start: Vec2 = [center[0] + dir[0] * radius, center[1] + dir[1] * radius];
      const ring: Vec2[] = Array.from({ length: 33 }, (_, k): Vec2 => {
        const a = (2 * Math.PI * k) / 32;
        return [center[0] + radius * Math.cos(a), center[1] + radius * Math.sin(a)];
      });
      const from = fromZ(ring);
      this.moveAbove(start, from);
      const cleared = Math.min(em.cur[2], from);
      const drop = cleared - z;
      const turns = helixTurns(drop, radius, entry.angle);
      const tooLong = helixTooLong(turns, drop, radius, entry.angle);
      if (tooLong) {
        this.failure ??= tooLong;
        return;
      }
      em.linear([start[0], start[1], cleared], 'plunge');
      for (let k = 1; k <= turns; k++) {
        const zk = k === turns ? z : cleared - (drop * k) / turns;
        em.arc([start[0], start[1], zk], center, op.climb, 'ramp', true);
      }
      // One level turn at depth flattens the helix's sloped floor.
      em.arc([start[0], start[1], z], center, op.climb, 'cut', true);
      cut.push(circleLoop(center, radius));
      atDepth = true;
      const path = ringPath(loop, start, op.climb, node.offset);
      const p0 = pointAt(path, 0);
      if (!geom.moveAllowed(start, p0)) {
        rampOrPlunge(path, false);
        return;
      }
      em.linear([p0[0], p0[1], z], 'cut');
      cutAlong(path, path.length);
    };

    /**
     * Starts `loop` where it passes through material this layer has already cleared (its point
     * nearest a cut ring, within the tool radius of it), by rapids over to just above the floor
     * of the layer before and a plunge feed down from there. False when no point of it is that
     * close to what is cut.
     */
    const dropIntoCleared = (loop: Loop2, node: PocketNode): boolean => {
      if (cut.length === 0) return false;
      const probe = ringPath(loop, loop.segments[0]!.start, op.climb, node.offset);
      const n = Math.max(8, Math.ceil(probe.length / LINK_STEP));
      let best: Vec2 | undefined;
      let bestD = Infinity;
      for (let k = 0; k < n; k++) {
        const p = pointAt(probe, (probe.length * k) / n);
        const d = distToLoops(p, cut);
        if (d < bestD) {
          bestD = d;
          best = p;
        }
      }
      if (!best || bestD > r - DROP_MARGIN) return false;
      const path = ringPath(loop, best, op.climb, node.offset);
      const p0 = pointAt(path, 0);
      // Part of the tool disk may still be over this layer's material: rapids stop above the
      // floor the layer before left there, and the rest is fed.
      this.moveAbove(p0, fromZ([p0]));
      em.linear([p0[0], p0[1], z], 'plunge');
      cutAlong(path, path.length);
      return true;
    };

    /** Up to 32 points along a path, for nearest-point searches between rings. */
    const probePoints = (path: CutPath): Vec2[] => {
      const n = Math.min(32, Math.max(8, Math.ceil(path.length / LINK_STEP)));
      return Array.from({ length: n }, (_, k) => pointAt(path, (path.length * k) / n));
    };

    /** The point of `targets` nearest `on`, with its position `s` along `on` and the distance. */
    const nearestBetween = (on: CutPath, targets: readonly Vec2[]) => {
      let best = { t: targets[0]!, s: 0, d: Infinity };
      for (const t of targets) {
        const c = closestOnPath(on, t);
        if (c.d < best.d) best = { t, ...c };
      }
      return best;
    };

    /** Runs on along `path` (already cut, so cleared) from `s0` forward to `s`. */
    const runOn = (path: CutPath, s0: number, s: number): void => {
      const s1 = s >= s0 ? s : s + path.length;
      if (s1 - s0 > EPS) walk(em, path, s1, { ...level, s0, rampEnd: s0 }, [], -Infinity);
    };

    /**
     * Reaches `loop` at depth through cleared material: along the ring the tool is on to the
     * point nearest `loop` and across, or by way of one other ring cut in this layer. Returns the
     * point of `loop` reached (the tool is there), or undefined when there is no such way.
     */
    const routeTo = (loop: Loop2, node: PocketNode): Vec2 | undefined => {
      if (!last || Math.abs(em.cur[2] - z) > EPS) return undefined;
      const on = last;
      const targets = probePoints(ringPath(loop, loop.segments[0]!.start, op.climb, node.offset));
      const direct = nearestBetween(on.path, targets);
      if (direct.d <= 2 * r && linkAllowed(pointAt(on.path, direct.s), direct.t)) {
        runOn(on.path, on.s, direct.s);
        em.linear([direct.t[0], direct.t[1], z], 'cut');
        return direct.t;
      }
      const candidates = cutPaths
        .filter((p) => p !== on.path)
        .map((p) => ({ p, d: distToLoops(targets[0]!, [p]) }))
        .sort((x, y) => x.d - y.d)
        .slice(0, 8);
      for (const { p } of candidates) {
        const last2 = nearestBetween(p, targets);
        if (last2.d > 2 * r || !linkAllowed(pointAt(p, last2.s), last2.t)) continue;
        const first = nearestBetween(on.path, probePoints(p));
        if (first.d > 2 * r || !linkAllowed(pointAt(on.path, first.s), first.t)) continue;
        runOn(on.path, on.s, first.s);
        em.linear([first.t[0], first.t[1], z], 'cut');
        runOn(p, closestOnPath(p, first.t).s, last2.s);
        em.linear([last2.t[0], last2.t[1], z], 'cut');
        return last2.t;
      }
      return undefined;
    };

    const viaCutRings = (loop: Loop2, node: PocketNode): boolean => {
      const at = routeTo(loop, node);
      if (!at) return false;
      const path = ringPath(loop, at, op.climb, node.offset);
      const p0 = pointAt(path, 0);
      em.linear([p0[0], p0[1], z], 'cut');
      cutAlong(path, path.length);
      return true;
    };

    const cutLoop = async (node: PocketNode, loop: Loop2, leaf: boolean): Promise<void> => {
      await this.context.checkpoint();
      const here: Vec2 = [em.cur[0], em.cur[1]];
      const path = ringPath(loop, here, op.climb, node.offset);
      const p0 = pointAt(path, 0);
      if (atDepth && Math.abs(em.cur[2] - z) <= EPS && linkAllowed(here, p0)) {
        em.linear([p0[0], p0[1], z], 'cut');
        cutAlong(path, path.length);
      } else if (!viaCutRings(loop, node) && !dropIntoCleared(loop, node)) {
        if (leaf) enterLeaf(node, loop);
        else rampOrPlunge(path, true);
      }
      atDepth = true;
      cut.push(loop);
      for (const at of spotsOf.get(loop) ?? []) {
        const from: Vec2 = [em.cur[0], em.cur[1]];
        if (linkAllowed(from, at)) em.linear([at[0], at[1], z], 'cut');
        else {
          this.moveAbove(at, fromZ([at]));
          em.linear([at[0], at[1], z], 'plunge');
        }
        visited.push(at);
        last = undefined;
      }
    };

    /** Removes and returns the item of `items` nearest the tool, by `distance`. */
    const takeNearest = <T>(items: T[], distance: (item: T, here: Vec2) => number): T => {
      const here: Vec2 = [em.cur[0], em.cur[1]];
      let best = 0;
      let bestD = Infinity;
      items.forEach((item, i) => {
        const d = distance(item, here);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      });
      return items.splice(best, 1)[0]!;
    };

    const cutNode = async (node: PocketNode, enterHere: boolean): Promise<void> => {
      const remaining = [node.outer, ...node.holes];
      let first = enterHere;
      while (remaining.length > 0) {
        const loop = takeNearest(remaining, (l, here) => distToLoops(here, [l]));
        await cutLoop(node, loop, first);
        first = false;
      }
    };

    const area = (node: PocketNode): number =>
      node.holes.reduce((sum, h) => sum + loopArea(h), loopArea(node.outer));

    // Inside out along the largest child at each split, so the entry is in the middle of the
    // largest piece. The other children (corner blobs, the far side of a neck) are surrounded by
    // cut rings by then, so they are cut from the outside in, linked at depth from those rings.
    const outsideIn = async (node: PocketNode): Promise<void> => {
      await cutNode(node, false);
      const rest = [...node.children];
      while (rest.length > 0) {
        await outsideIn(takeNearest(rest, (n, here) => distToLoops(here, [n.outer, ...n.holes])));
      }
    };
    const insideOut = async (node: PocketNode): Promise<void> => {
      const children = [...node.children].sort((a, b) => area(b) - area(a));
      const main = children.shift();
      if (main) await insideOut(main);
      await cutNode(node, !main);
      while (children.length > 0) {
        await outsideIn(
          takeNearest(children, (n, here) => distToLoops(here, [n.outer, ...n.holes])),
        );
      }
    };

    const roots = [...geom.roots];
    while (roots.length > 0) {
      await insideOut(takeNearest(roots, (n, here) => distToLoops(here, [n.outer, ...n.holes])));
    }
  }

  /** The finishing pass along every wall loop, in `finishLevels` (or stepdown steps where needed). */
  async finish(
    geom: PocketGeometry,
    finishLevels: readonly number[],
    roughLevels: readonly number[],
    floor: number,
  ): Promise<void> {
    const op = this.op;
    const em = this.em;
    const r = this.r;
    const a = geom.options.allowance;
    const first = geom.rings[0]?.offset;
    const ring0 = geom.rings
      .filter((ring) => ring.offset === first)
      .map((ring) => ringPath(ring.loop, ring.loop.segments[0]!.start, op.climb, ring.offset));
    const remaining = [...geom.finishLoops];
    let unroughed = 0;
    while (remaining.length > 0) {
      const here: Vec2 = [em.cur[0], em.cur[1]];
      let best = 0;
      let bestD = Infinity;
      remaining.forEach((loop, i) => {
        const d = distToLoops(here, [loop]);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      });
      const [loop] = remaining.splice(best, 1);
      const nearest = ringPath(loop!, here, op.climb, r);
      const covered = roughingCovers(nearest, ring0, a);
      if (!covered) unroughed++;
      const lv = covered ? finishLevels : roughLevels;
      // Enter from the cleared pocket, `a` in from the wall: at the point nearest the tool, or
      // else half-way along a segment (longest first), where the wall's normal is well defined.
      let path = nearest;
      let entryXY = pointAt(path, 0);
      // Where the pass plunges at the wall, the allowance there is uncut from the top down.
      let atWall = false;
      if (covered && a > 0) {
        const starts = [
          nearest,
          ...nearest.segments
            .map((seg, i) => ({ i, len: segmentLength(seg) }))
            .sort((x, y) => y.len - x.len)
            .map(({ i, len }) =>
              ringPath(loop!, pointAt(nearest, nearest.cum[i]! + len / 2), op.climb, r),
            ),
        ];
        const found = starts.find((candidate) => {
          const q = pointAt(candidate, 0);
          const n = scrapNormalAt(candidate, 0);
          const inside: Vec2 = [q[0] + n[0] * a, q[1] + n[1] * a];
          return geom.centreAllowed(inside) && geom.moveAllowed(inside, q, r);
        });
        if (found) {
          path = found;
          const q = pointAt(found, 0);
          const n = scrapNormalAt(found, 0);
          entryXY = [q[0] + n[0] * a, q[1] + n[1] * a];
        } else {
          atWall = true;
          this.once(
            'finish-plunge-at-wall',
            'A finishing pass has no room to lead in from the cleared pocket; it plunges at the wall, through the allowance.',
          );
        }
      }
      const p0 = pointAt(path, 0);
      // Rapids stop above what is cleared under the entry: the clearing's floor where the entry is
      // in the cleared pocket, else the top (the allowance at the wall, or a wall nothing cleared),
      // and after that the level this pass reached.
      let cleared = covered && !atWall ? floor : op.depth.top;
      for (const z of lv) {
        await this.context.checkpoint();
        this.moveAbove(entryXY, Math.max(z, cleared));
        em.linear([entryXY[0], entryXY[1], z], 'plunge');
        if (dist2(entryXY, p0) > EPS) em.linear([p0[0], p0[1], z], 'lead');
        walk(em, path, path.length, { s0: 0, rampEnd: 0, from: z, to: z }, [], -Infinity);
        if (dist2(entryXY, p0) > EPS) em.linear([entryXY[0], entryXY[1], z], 'lead');
        if (!covered || atWall) cleared = z;
        em.pass++;
      }
    }
    if (unroughed > 0) {
      this.warnings.push(
        warn(
          'finish-steps-down',
          `${unroughed} finishing loop(s) run where the clearing could not reach (a neck or gap narrower than the tool plus the allowance); they are cut in stepdown steps.`,
        ),
      );
    }
  }

  result(): GeneratedToolpath {
    const em = this.em;
    em.pass = Math.max(0, em.pass - 1);
    em.rapid([em.cur[0], em.cur[1], this.clearanceZ]);
    const toolpath = { start: this.startPos ?? [0, 0, this.clearanceZ], entries: em.entries };
    return this.warnings.length > 0 ? { toolpath, warnings: this.warnings } : { toolpath };
  }
}

/**
 * Counter-clockwise loops inside another counter-clockwise loop: meant as islands, but by the
 * `Loop2` convention (islands clockwise) they merge into the pocket and get cut.
 */
function islandOrientationWarning(cutter: PocketCutter, loops: readonly Loop2[]): void {
  const outers = loops
    .map((loop, i) => ({ i, loop, area: loopArea(loop) }))
    .filter((o) => o.area > 0)
    .map((o) => ({ ...o, poly: flattenSegments(o.loop.segments, true, 0.01) }));
  const inner = outers.filter((o) =>
    outers.some(
      (other) =>
        other !== o && other.area > o.area && pointInLoops(o.loop.segments[0]!.start, [other.poly]),
    ),
  );
  if (inner.length > 0) {
    cutter.once(
      'island-orientation',
      `Loop(s) ${inner.map((o) => o.i).join(', ')} lie inside another loop but run counter-clockwise, so they are cut as part of the pocket, not left as islands; islands must run clockwise.`,
    );
  }
}

function geometryWarnings(cutter: PocketCutter, geom: PocketGeometry, diameter: number): void {
  for (const u of geom.unreachable) {
    cutter.warnings.push(
      warn(
        'unreachable',
        `An area of ${fmt(u.area)} mm2 around (${fmt(u.at[0], 2)}, ${fmt(u.at[1], 2)}) is narrower than the ${diameter} mm tool can reach; it is left uncut.`,
      ),
    );
  }
  if (geom.cuspArea > 0) {
    cutter.once(
      'stepover-cusps',
      `The stepover leaves ${fmt(geom.cuspArea, 2)} mm2 uncut between rings; use a smaller stepover.`,
    );
  }
}

function depthWarning(cutter: PocketCutter, op: PocketOperation): void {
  const depth = op.depth.top - op.depth.bottom;
  if (depth > op.tool.fluteLength) {
    cutter.once(
      'depth-exceeds-flutes',
      `The pocket is ${depth} mm deep but the tool's flutes are ${op.tool.fluteLength} mm long.`,
    );
  }
}

// ---------------------------------------------------------------------------------------------
// The generators

/**
 * Generates a pocket operation's toolpath (registered as the `pocket` generator). Passes, in
 * order: one clearing pass per depth level from `top` down to `bottom + floorAllowance`, a floor
 * pass at `bottom` when there is a floor allowance, then the finishing pass along each wall loop
 * at each finishing level. `pass` numbers them from 0.
 */
export async function generatePocket(
  input: PocketInput,
  context: OperationContext,
): Promise<CamResult<GeneratedToolpath>> {
  return withMoveBudget(input.id, () => pocketToolpath(input, context));
}

async function pocketToolpath(
  input: PocketInput,
  context: OperationContext,
): Promise<CamResult<GeneratedToolpath>> {
  const op = input as PocketOperation;
  const problem = checkInput(op);
  if (problem) return err('invalid-input', `${op.id}: ${problem}`);
  if (op.loops.length === 0) return err('invalid-input', `${op.id}: the pocket has no loops.`);

  const r = op.tool.diameter / 2;
  const { top, bottom } = op.depth;
  const depth = top - bottom;
  const allowance = op.finishAllowance;
  const finishing = op.finishPass ?? allowance > 0;
  const geom = pocketGeometry(op.loops, {
    toolRadius: r,
    stepover: op.stepover * op.tool.diameter,
    allowance,
    finishing,
  });
  if (!geom.ok) return err(geom.error.code, `${op.id}: ${geom.error.message}`);
  if (geom.value.roots.length === 0 && geom.value.finishLoops.length === 0) {
    return err(
      'invalid-input',
      `${op.id}: the ${op.tool.diameter} mm tool does not fit inside the pocket.`,
    );
  }

  const cutter = new PocketCutter(op, context);
  depthWarning(cutter, op);
  islandOrientationWarning(cutter, op.loops);
  geometryWarnings(cutter, geom.value, op.tool.diameter);

  const fa = op.floorAllowance ?? 0;
  const floorPass = fa > 0 && (op.floorPass ?? true);
  const roughLevels = levels(top, bottom + fa, op.stepdown);
  if (!roughLevels.ok) return err(roughLevels.error.code, `${op.id}: ${roughLevels.error.message}`);
  const layers = floorPass ? [...roughLevels.value, bottom] : roughLevels.value;
  let previous: { geom: PocketGeometry; z: number } | undefined;
  if (geom.value.roots.length > 0) {
    for (const z of layers) {
      await context.checkpoint();
      await cutter.clearLayer(geom.value, z, previous);
      if (cutter.failure) return err('invalid-input', `${op.id}: ${cutter.failure}`);
      previous = { geom: geom.value, z };
      cutter.em.pass++;
    }
  }
  if (finishing) {
    const floor = floorPass || fa === 0 ? bottom : bottom + fa;
    const finishStep = op.finishStepdown ?? (depth <= op.tool.fluteLength ? depth : op.stepdown);
    const reached = geom.value.roots.length > 0 ? layers[layers.length - 1]! : top;
    const finishLevels = levels(top, floor, finishStep);
    if (!finishLevels.ok) {
      return err(finishLevels.error.code, `${op.id}: ${finishLevels.error.message}`);
    }
    const stepLevels = levels(top, floor, op.stepdown);
    if (!stepLevels.ok) return err(stepLevels.error.code, `${op.id}: ${stepLevels.error.message}`);
    await cutter.finish(geom.value, finishLevels.value, stepLevels.value, reached);
  }
  return ok(cutter.result());
}

/**
 * Clears z-level layers, each with its own loops, from the top down: what 3D roughing does with
 * its slices of the part. No floor or finishing pass; areas the tool cannot reach are not
 * reported (every slice of a curved part has some). Layers must be in descending `z`, below
 * `op.depth.top`; `op.depth.bottom`, `stepdown` and the finishing fields are not read.
 */
export async function generatePocketLayers(
  op: PocketOperation,
  layers: readonly PocketLayer[],
  context: OperationContext,
): Promise<CamResult<GeneratedToolpath>> {
  return withMoveBudget(op.id, () => pocketLayersToolpath(op, layers, context));
}

async function pocketLayersToolpath(
  op: PocketOperation,
  layers: readonly PocketLayer[],
  context: OperationContext,
): Promise<CamResult<GeneratedToolpath>> {
  const problem = checkInput({
    ...op,
    depth: { top: op.depth.top, bottom: op.depth.top - 1 },
    stepdown: 1,
    finishStepdown: 1,
    floorAllowance: 0,
  });
  if (problem) return err('invalid-input', `${op.id}: ${problem}`);
  for (let i = 0; i < layers.length; i++) {
    const z = layers[i]!.z;
    if (!finite(z) || z >= op.depth.top || (i > 0 && z >= layers[i - 1]!.z)) {
      return err('invalid-input', `${op.id}: layer ${i} is not below the top and the layer above.`);
    }
  }
  const r = op.tool.diameter / 2;
  const cutter = new PocketCutter(op, context);
  const cache = new Map<readonly Loop2[], PocketGeometry>();
  let previous: { geom: PocketGeometry; z: number } | undefined;
  for (const layer of layers) {
    await context.checkpoint();
    let geom = cache.get(layer.loops);
    if (!geom) {
      const g = pocketGeometry(layer.loops, {
        toolRadius: r,
        stepover: op.stepover * op.tool.diameter,
        allowance: op.finishAllowance,
        finishing: false,
      });
      if (!g.ok) return err(g.error.code, `${op.id}: layer at ${layer.z}: ${g.error.message}`);
      geom = g.value;
      cache.set(layer.loops, geom);
    }
    if (geom.roots.length === 0) continue;
    await cutter.clearLayer(geom, layer.z, previous);
    if (cutter.failure) return err('invalid-input', `${op.id}: ${cutter.failure}`);
    if (geom.cuspArea > 0) {
      cutter.once(
        'stepover-cusps',
        `The stepover leaves ${fmt(geom.cuspArea, 2)} mm2 uncut between rings in the layer at ${fmt(layer.z, 2)}; use a smaller stepover.`,
      );
    }
    previous = { geom, z: layer.z };
    cutter.em.pass++;
  }
  return ok(cutter.result());
}
