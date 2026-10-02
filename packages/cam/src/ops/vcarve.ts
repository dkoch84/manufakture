// The V-carve operation (M5 plan, T5.2f; ADR 0014): V-bit carving whose depth follows the width of
// the shape, for sign lettering. At a point p of the shape, the carved surface lies at depth
// f(p) / tan(a) below the top, where f is the distance to the outline and a the bit's half angle,
// down to a maximum depth. A V-bit whose tip stands on the shape's centre line (its medial axis) at
// depth (f - tip radius) / tan(a) touches the outline with its rim at the top and leaves exactly
// that surface on both flanks, so one pass along the centre line carves the whole shape.
//
// The centre line is found from stepped insets, with no Voronoi library: the outline is offset
// inward in steps, and wherever an inset collapses before the next one (a point stepped inward
// along the inset's normal stops getting farther from the outline) the ridge it meets is a point of
// the centre line, found by bisection. Where the shape is wider than the maximum depth allows, the
// bit cuts the inset at that depth (its outer flank finishes the slope) and clears the flat floor
// inside with more insets, or leaves the floor to a clearing end mill (`generateVCarveClearing`,
// which reuses the pocket operation). The README's "V-carve operation" section has the details.

import {
  differenceLoops,
  offsetLoops,
  regionArea,
  regionLoops,
  unionLoops,
} from '../offset/engine';
import { flattenSegments } from '../offset/flatten';
import {
  distToSegment,
  loopArea,
  signedSweep,
  segmentLength,
  segmentPoint,
  segmentTangent,
} from '../offset/geometry';
import { stockTopZ } from '../job';
import type { CamWarning, GeneratedToolpath, OperationContext } from '../worker/registry';
import {
  err,
  ok,
  type CamResult,
  type Entry,
  type Feeds,
  type Loop2,
  type Segment2,
  type Tool,
  type VCarveInput,
  type Vec2,
  type Vec3,
} from '../types';
import { generatePocket, type PocketOperation } from './pocket';
import {
  Emitter,
  PROFILE_SAFE_ABOVE,
  closestOnPath,
  levels,
  pointAt,
  subSegment,
  walk,
  type CutPath,
} from './profile';

/** A flat end mill that clears the floor of a V-carve limited by `maxDepth`. */
export interface VCarveClearing {
  /** A `flat` or `bull` end mill. */
  readonly tool: Tool;
  readonly feeds: Feeds;
  /** Depth step of the clearing, mm. */
  readonly stepdown: number;
  /** Fraction of the clearing tool's diameter, in (0, 1]. */
  readonly stepover: number;
  /** Default: a 3 degree helix of half the clearing tool's radius. */
  readonly entry?: Entry;
}

/**
 * Fields of a V-carve operation that `VCarveInput` (types.ts) does not have yet. All optional; the
 * core schema and `VCarveInput` should take them over.
 */
export interface VCarveExtras {
  /** Depth step, mm: the carve is cut in levels no deeper than this. Default: one level. */
  readonly stepdown?: number;
  /**
   * Distance between the V-bit's rings on a flat floor (where `maxDepth` or the bit's size limits
   * the depth), mm. Default: rings close enough to leave ridges no higher than `VCARVE_FLAT_RIDGE`.
   */
  readonly flatStepover?: number;
  /**
   * Clear the flat floor with an end mill instead (`generateVCarveClearing`); the V-bit then
   * runs its floor rings only as far in as the end mill cannot reach.
   */
  readonly clearing?: VCarveClearing;
}

/** A V-carve operation as the generator reads it. */
export type VCarveOperation = VCarveInput & VCarveExtras;

/** Rapids stop this far above the stock top (or `top`, when higher), mm. */
export const VCARVE_SAFE_ABOVE = PROFILE_SAFE_ABOVE;

/** Inset step between the insets that locate the centre line, mm (before the level cap). */
export const VCARVE_INSET_STEP = 0.5;

/** Most insets used to locate the centre line; more makes the inset step coarser (a warning). */
export const VCARVE_MAX_LEVELS = 200;

/** Default height of the ridges a V-bit leaves between its rings on a flat floor, mm. */
export const VCARVE_FLAT_RIDGE = 0.2;

/** Most V-bit rings on a flat floor; more makes the floor stepover coarser (a warning). */
export const VCARVE_MAX_FLAT_RINGS = 400;

/** Distance between the points sampled along an inset to find the centre line, mm. */
export const VCARVE_SAMPLE = 0.25;

/**
 * How far a cut may reach past the carved surface, mm: the slack of every exact check against the
 * outline, for the offsets' refit tolerance.
 */
export const VCARVE_TOLERANCE = 0.005;

/**
 * A fed link between two centre-line pieces stays at least this far from the outline, mm, and
 * inside the shape; otherwise the tool goes over the top.
 */
export const VCARVE_LINK_MARGIN = 0.05;

/**
 * An inset corner that turns by less than this, radians (8 degrees), is treated as smooth: the
 * outline is a polyline standing for a curve (a flattened Bezier) and its vertices need no carving
 * of their own. The error left at such a vertex is below 0.003 times its distance to the outline.
 */
const SMOOTH_TURN = (8 * Math.PI) / 180;
const RATE = Math.cos(SMOOTH_TURN);

/** Tolerance of the ridge test along an inset's normal, mm. */
const RIDGE_TOLERANCE = 0.002;

/** Simplification tolerance of the centre lines, mm (in the plane and in the cone's reach). */
const SIMPLIFY_TOLERANCE = 0.002;

/** Bisections that find where the distance stops rising along a normal (to 0.5 mm / 2^16). */
const RIDGE_BISECTIONS = 16;

/** The ridge's highest point along a normal is found to this, mm. */
const RIDGE_SEARCH_TOLERANCE = 1e-6;

/** Centre-line pieces that never go deeper than this, mm, cut nothing and are dropped. */
const MIN_DEPTH = 0.01;

/** Bisections when refining samples along an inset. */
const REFINE_DEPTH = 6;

/** Centre-line samples are added until the line between them is within this of it, mm. */
const REFINE_TOLERANCE = 0.01;

/** The collapse test looks this far past the next inset, mm. */
const RIDGE_OVERLAP = 0.02;

const EPS = 1e-9;

const warn = (code: string, message: string): CamWarning => ({ code, message });
const dist2 = (a: Vec2 | Vec3, b: Vec2 | Vec3): number => Math.hypot(a[0] - b[0], a[1] - b[1]);
const fmt = (v: number, d = 2): string => String(Math.round(v * 10 ** d) / 10 ** d + 0);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const positive = (v: unknown): boolean => finite(v) && v > 0;

// ---------------------------------------------------------------------------------------------
// Distance to the outline, with a grid of buckets

/**
 * Distance to the outline's segments, with a bucket grid for speed, and an inside test. Lines are
 * kept in flat arrays and measured in squared distance, so a query costs a few multiplications per
 * nearby segment; arcs use the exact arc distance.
 */
export class OutlineDistance {
  private readonly segs: Segment2[];
  /**
   * Per segment. A line: start x, start y, dx, dy, 1 / length squared (0 for a point). An arc:
   * centre x, centre y, radius, and the unit directions from the centre to where its
   * counter-clockwise sweep starts and ends (in `ux`, `uy`, `vx`, `vy`).
   */
  private readonly lx: Float64Array;
  private readonly ly: Float64Array;
  private readonly ldx: Float64Array;
  private readonly ldy: Float64Array;
  private readonly linv: Float64Array;
  private readonly ux: Float64Array;
  private readonly uy: Float64Array;
  private readonly vx: Float64Array;
  private readonly vy: Float64Array;
  /** 0 a line, 1 an arc of at most a half turn, 2 a longer arc, 3 a full circle. */
  private readonly kind: Uint8Array;
  private readonly buckets: (number[] | undefined)[];
  private readonly x0: number;
  private readonly y0: number;
  private readonly cell: number;
  private readonly nx: number;
  private readonly ny: number;
  private readonly seen: Int32Array;
  private tick = 0;
  /** The outline flattened to edges (x0, y0, x1, y1), bucketed by grid row, for `inside`. */
  private readonly edges: Float64Array;
  private readonly rows: (number[] | undefined)[];

  constructor(loops: readonly Loop2[]) {
    this.segs = loops.flatMap((l) => l.segments);
    const n = this.segs.length;
    this.lx = new Float64Array(n);
    this.ly = new Float64Array(n);
    this.ldx = new Float64Array(n);
    this.ldy = new Float64Array(n);
    this.linv = new Float64Array(n);
    this.ux = new Float64Array(n);
    this.uy = new Float64Array(n);
    this.vx = new Float64Array(n);
    this.vy = new Float64Array(n);
    this.kind = new Uint8Array(n);
    const boxes = this.segs.map((s, k): [number, number, number, number] => {
      if (s.kind === 'line') {
        const dx = s.end[0] - s.start[0];
        const dy = s.end[1] - s.start[1];
        const l2 = dx * dx + dy * dy;
        this.lx[k] = s.start[0];
        this.ly[k] = s.start[1];
        this.ldx[k] = dx;
        this.ldy[k] = dy;
        this.linv[k] = l2 > 0 ? 1 / l2 : 0;
        return [
          Math.min(s.start[0], s.end[0]),
          Math.min(s.start[1], s.end[1]),
          Math.max(s.start[0], s.end[0]),
          Math.max(s.start[1], s.end[1]),
        ];
      }
      const r = Math.hypot(s.start[0] - s.center[0], s.start[1] - s.center[1]);
      const sweep = signedSweep(s);
      const [from, to] = s.ccw ? [s.start, s.end] : [s.end, s.start];
      this.lx[k] = s.center[0];
      this.ly[k] = s.center[1];
      this.ldx[k] = r;
      const unit = (q: Vec2): Vec2 => {
        const dx = q[0] - s.center[0];
        const dy = q[1] - s.center[1];
        const l = Math.hypot(dx, dy);
        return l > 0 ? [dx / l, dy / l] : [1, 0];
      };
      const u = unit(from);
      const v = unit(to);
      this.ux[k] = u[0];
      this.uy[k] = u[1];
      this.vx[k] = v[0];
      this.vy[k] = v[1];
      this.kind[k] =
        Math.abs(sweep) >= 2 * Math.PI - 1e-12 ? 3 : Math.abs(sweep) <= Math.PI ? 1 : 2;
      // The arc's own box: its ends, and the circle's extreme points that it sweeps through.
      const box: [number, number, number, number] = [
        Math.min(s.start[0], s.end[0]),
        Math.min(s.start[1], s.end[1]),
        Math.max(s.start[0], s.end[0]),
        Math.max(s.start[1], s.end[1]),
      ];
      if (this.within(k, 1, 0)) box[2] = Math.max(box[2], s.center[0] + r);
      if (this.within(k, 0, 1)) box[3] = Math.max(box[3], s.center[1] + r);
      if (this.within(k, -1, 0)) box[0] = Math.min(box[0], s.center[0] - r);
      if (this.within(k, 0, -1)) box[1] = Math.min(box[1], s.center[1] - r);
      return box;
    });
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const b of boxes) {
      minX = Math.min(minX, b[0]);
      minY = Math.min(minY, b[1]);
      maxX = Math.max(maxX, b[2]);
      maxY = Math.max(maxY, b[3]);
    }
    const w = Math.max(maxX - minX, 1e-6);
    const h = Math.max(maxY - minY, 1e-6);
    // Cells about a few segments long: a query near the outline then looks at few segments.
    let total = 0;
    for (const b of boxes) total += Math.max(b[2] - b[0], b[3] - b[1]);
    let cell = Math.max(
      0.25,
      Math.min(Math.sqrt((w * h) / Math.max(1, n)), (2 * total) / Math.max(1, n)),
    );
    while ((w / cell + 1) * (h / cell + 1) > 1e6) cell *= 2;
    this.x0 = minX;
    this.y0 = minY;
    this.cell = cell;
    this.nx = Math.floor(w / cell) + 1;
    this.ny = Math.floor(h / cell) + 1;
    this.buckets = new Array<number[] | undefined>(this.nx * this.ny);
    boxes.forEach((b, k) => {
      const i0 = this.ix(b[0]);
      const i1 = this.ix(b[2]);
      const j0 = this.iy(b[1]);
      const j1 = this.iy(b[3]);
      for (let i = i0; i <= i1; i++) {
        for (let j = j0; j <= j1; j++) (this.buckets[i + j * this.nx] ??= []).push(k);
      }
    });
    this.seen = new Int32Array(n);

    // The inside test: crossings of a ray in +x with the outline flattened to 0.1 micrometre,
    // looking only at the edges that span the query's grid row.
    const flat: number[] = [];
    for (const loop of loops) {
      const pts = flattenSegments(loop.segments, true, 1e-4);
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i]!;
        const b = pts[(i + 1) % pts.length]!;
        if (a[1] !== b[1]) flat.push(a[0], a[1], b[0], b[1]);
      }
    }
    this.edges = Float64Array.from(flat);
    this.rows = new Array<number[] | undefined>(this.ny);
    for (let e = 0; e < this.edges.length; e += 4) {
      const j0 = this.iy(Math.min(this.edges[e + 1]!, this.edges[e + 3]!));
      const j1 = this.iy(Math.max(this.edges[e + 1]!, this.edges[e + 3]!));
      for (let j = j0; j <= j1; j++) (this.rows[j] ??= []).push(e);
    }
  }

  private ix(x: number): number {
    return Math.min(this.nx - 1, Math.max(0, Math.floor((x - this.x0) / this.cell)));
  }

  private iy(y: number): number {
    return Math.min(this.ny - 1, Math.max(0, Math.floor((y - this.y0) / this.cell)));
  }

  /** Whether the direction (cx, cy) from arc `k`'s centre is within its sweep. */
  private within(k: number, cx: number, cy: number): boolean {
    const kind = this.kind[k]!;
    if (kind === 3) return true;
    const ux = this.ux[k]!;
    const uy = this.uy[k]!;
    const vx = this.vx[k]!;
    const vy = this.vy[k]!;
    if (kind === 1) return ux * cy - uy * cx >= 0 && cx * vy - cy * vx >= 0;
    return !(vx * cy - vy * cx > 0 && cx * uy - cy * ux > 0);
  }

  /** Squared distance from (px, py) to segment `k`. */
  private seg2(k: number, px: number, py: number): number {
    const kind = this.kind[k]!;
    if (kind === 0) {
      const ax = px - this.lx[k]!;
      const ay = py - this.ly[k]!;
      const dx = this.ldx[k]!;
      const dy = this.ldy[k]!;
      let t = (ax * dx + ay * dy) * this.linv[k]!;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = ax - t * dx;
      const ey = ay - t * dy;
      return ex * ex + ey * ey;
    }
    const cx = px - this.lx[k]!;
    const cy = py - this.ly[k]!;
    const r = this.ldx[k]!;
    if (this.within(k, cx, cy)) {
      const d = Math.sqrt(cx * cx + cy * cy) - r;
      return d * d;
    }
    const seg = this.segs[k]!;
    const sx = px - seg.start[0];
    const sy = py - seg.start[1];
    const ex = px - seg.end[0];
    const ey = py - seg.end[1];
    return Math.min(sx * sx + sy * sy, ex * ex + ey * ey);
  }

  /** The distance from `p` to the nearest segment. */
  dist(p: Vec2): number {
    const px = p[0];
    const py = p[1];
    const c = this.cell;
    const fx = (px - this.x0) / c;
    const fy = (py - this.y0) / c;
    let best = Infinity;
    if (fx < 0 || fy < 0 || fx >= this.nx || fy >= this.ny) {
      for (let k = 0; k < this.segs.length; k++) {
        const d = this.seg2(k, px, py);
        if (d < best) best = d;
      }
      return Math.sqrt(best);
    }
    const i0 = Math.floor(fx);
    const j0 = Math.floor(fy);
    const stamp = ++this.tick;
    const nx = this.nx;
    const ny = this.ny;
    const seen = this.seen;
    const maxR = Math.max(nx, ny);
    for (let r = 0; r <= maxR; r++) {
      const jLo = j0 - r;
      const jHi = j0 + r;
      for (let j = jLo; j <= jHi; j++) {
        if (j < 0 || j >= ny) continue;
        // The ring's top and bottom rows in full, its sides at the two ends only.
        const edge = j === jLo || j === jHi;
        const step = edge || r === 0 ? 1 : 2 * r;
        for (let i = i0 - r; i <= i0 + r; i += step) {
          if (i < 0 || i >= nx) continue;
          const bucket = this.buckets[i + j * nx];
          if (!bucket) continue;
          for (let m = 0; m < bucket.length; m++) {
            const k = bucket[m]!;
            if (seen[k] === stamp) continue;
            seen[k] = stamp;
            const d = this.seg2(k, px, py);
            if (d < best) best = d;
          }
        }
      }
      // Every cell outside ring r is at least this far from p.
      const reach = Math.min(fx - i0 + r, i0 + r + 1 - fx, fy - j0 + r, j0 + r + 1 - fy) * c;
      if (best <= reach * reach) break;
    }
    return Math.sqrt(best);
  }

  /**
   * Whether `p` is inside the outline (even-odd over all loops). Points within about 0.1
   * micrometre of the outline may go either way.
   */
  inside(p: Vec2): boolean {
    const px = p[0];
    const py = p[1];
    if (py < this.y0 || py > this.y0 + this.ny * this.cell) return false;
    const row = this.rows[this.iy(py)];
    if (!row) return false;
    const e = this.edges;
    let inside = false;
    for (const k of row) {
      const ay = e[k + 1]!;
      const by = e[k + 3]!;
      if (ay > py !== by > py) {
        const ax = e[k]!;
        const x = ax + ((py - ay) * (e[k + 2]! - ax)) / (by - ay);
        if (px < x) inside = !inside;
      }
    }
    return inside;
  }
}

// ---------------------------------------------------------------------------------------------
// Input checks

function checkInput(op: VCarveOperation): string | undefined {
  const t = op.tool;
  if (t.kind !== 'vbit' && t.kind !== 'engraver') {
    return `A V-carve needs a V-bit or an engraver, not a ${t.kind} tool.`;
  }
  if (!positive(t.diameter)) return 'The tool diameter must be greater than zero.';
  if (!(finite(t.angle) && t.angle > 0 && t.angle < Math.PI)) {
    return 'The V-bit angle must be greater than 0 and less than 180 degrees.';
  }
  const tip = t.tipDiameter ?? 0;
  if (!(finite(tip) && tip >= 0 && tip < t.diameter)) {
    return 'The tip diameter must be zero or more and less than the tool diameter.';
  }
  if (!positive(t.fluteLength)) return 'The flute length must be greater than zero.';
  if (!finite(op.top)) return 'The top must be finite.';
  if (op.maxDepth !== undefined && !positive(op.maxDepth)) {
    return 'The maximum depth must be greater than zero.';
  }
  if (op.stepdown !== undefined && !positive(op.stepdown)) {
    return 'The stepdown must be greater than zero.';
  }
  if (op.flatStepover !== undefined && !positive(op.flatStepover)) {
    return 'The flat stepover must be greater than zero.';
  }
  if (!positive(op.feeds.cut) || !positive(op.feeds.plunge)) {
    return 'The cut and plunge feeds must be greater than zero.';
  }
  const c = op.clearing;
  if (c) {
    if (c.tool.kind !== 'flat' && c.tool.kind !== 'bull') {
      return `The clearing tool must be a flat or bull end mill, not a ${c.tool.kind} tool.`;
    }
    if (!positive(c.tool.diameter)) return 'The clearing tool diameter must be greater than zero.';
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// The carve's geometry

/** The depth limits of a V-carve: how deep it goes and where its flat floor starts. */
interface Limits {
  /** Half the included angle, radians. */
  readonly half: number;
  readonly tan: number;
  /** Tip radius, mm. */
  readonly rt: number;
  /** Deepest the carve goes below `top`, mm. */
  readonly depth: number;
  /** Inset of the tool centre at that depth: `rt + depth * tan`. */
  readonly deltaMax: number;
}

function limitsOf(op: VCarveOperation): { limits: Limits; capped: 'tool' | 'flutes' | undefined } {
  const t = op.tool;
  const half = t.angle! / 2;
  const tan = Math.tan(half);
  const rt = (t.tipDiameter ?? 0) / 2;
  const byCone = (t.diameter / 2 - rt) / tan;
  const toolDepth = Math.min(byCone, t.fluteLength);
  const depth = Math.min(op.maxDepth ?? Infinity, toolDepth);
  const capped =
    op.maxDepth !== undefined && op.maxDepth <= toolDepth
      ? undefined
      : byCone <= t.fluteLength
        ? 'tool'
        : 'flutes';
  return { limits: { half, tan, rt, depth, deltaMax: rt + depth * tan }, capped };
}

/** A point on an inset with its unit normal into the shape, and what stepping along it finds. */
interface Sample {
  readonly piece: number;
  readonly u: number;
  readonly q: Vec2;
  readonly n: Vec2;
  /** The ridge was met before the next inset: this sample is on a collapsing stretch. */
  readonly collapsed: boolean;
  /** The centre-line point (the ridge), or the point on the next inset. */
  readonly m: Vec2;
  /** Distance from `m` to the outline. */
  readonly f: number;
}

/** One stretch of an inset: a segment, or a fan of normals about a reflex vertex. */
type Piece =
  | { readonly kind: 'seg'; readonly seg: Segment2; readonly length: number }
  | {
      readonly kind: 'fan';
      readonly at: Vec2;
      readonly n0: Vec2;
      /** Signed turn of the normal, radians (negative: clockwise). */
      readonly turn: number;
      readonly length: number;
    };

const leftOf = (t: Vec2): Vec2 => [-t[1], t[0]];
const rotate = (v: Vec2, a: number): Vec2 => [
  v[0] * Math.cos(a) - v[1] * Math.sin(a),
  v[0] * Math.sin(a) + v[1] * Math.cos(a),
];

/** The stretches of an inset loop (natural orientation: the shape on the left). */
function piecesOf(loop: Loop2, step: number): Piece[] {
  const segs = loop.segments.filter((s) => segmentLength(s) > EPS);
  const out: Piece[] = [];
  segs.forEach((seg, i) => {
    out.push({ kind: 'seg', seg, length: segmentLength(seg) });
    const next = segs[(i + 1) % segs.length]!;
    const t0 = segmentTangent(seg, 1);
    const t1 = segmentTangent(next, 0);
    const turn = Math.atan2(t0[0] * t1[1] - t0[1] * t1[0], t0[0] * t1[0] + t0[1] * t1[1]);
    // A right turn is a reflex vertex of the shape: its normals fan out about the vertex.
    if (turn < -1e-6) {
      out.push({
        kind: 'fan',
        at: seg.end,
        n0: leftOf(t0),
        turn,
        length: Math.abs(turn) * Math.max(step, VCARVE_SAMPLE),
      });
    }
  });
  return out;
}

function evalPiece(p: Piece, u: number): { q: Vec2; n: Vec2 } {
  if (p.kind === 'fan') return { q: p.at, n: rotate(p.n0, p.turn * u) };
  return { q: segmentPoint(p.seg, u), n: leftOf(segmentTangent(p.seg, u)) };
}

/** A carve piece: a centre-line polyline (x, y, z), open or closed. */
interface Polyline {
  readonly points: Vec3[];
  readonly closed: boolean;
}

/** Everything the V-bit cuts, before levels and order. */
interface CarvePlan {
  readonly lines: Polyline[];
  /** Rings at the full depth: the inset at `deltaMax` and the floor rings inside it. */
  readonly rings: Loop2[];
  readonly warnings: CamWarning[];
}

class Carver {
  readonly field: OutlineDistance;

  constructor(
    readonly source: readonly Loop2[],
    readonly top: number,
    readonly lim: Limits,
  ) {
    this.field = new OutlineDistance(source);
  }

  /** Depth of the carved surface where the tool centre is `f` from the outline. */
  depthAt(f: number): number {
    const { rt, tan, depth } = this.lim;
    return Math.min(depth, Math.max(0, (f - rt) / tan));
  }

  /**
   * Whether the straight move from `a` to `b` keeps the V-bit inside the carved surface: at every
   * point, the cone's reach at the top (`rt + depth * tan`) is within the distance to the outline.
   * Exact up to `VCARVE_TOLERANCE`: the distance is 1-Lipschitz, so a stretch whose midpoint has
   * room to spare for half its length needs no closer look.
   */
  chordAllowed(a: Vec3, b: Vec3): boolean {
    return this.clearAlong(a, b, -Infinity);
  }

  /**
   * Whether a fed link from `a` to `b` stays in the carve. Stricter than `chordAllowed`: with its
   * tip at the top a sharp V-bit has no reach, so `chordAllowed` passes any move there, including
   * one across the face between two letters. A link must also keep `VCARVE_LINK_MARGIN` from the
   * outline all the way (so it never crosses it) and run inside the shape.
   */
  linkAllowed(a: Vec3, b: Vec3): boolean {
    // A move straight up or down crosses nothing in the plane.
    if (dist2(a, b) < EPS) return this.chordAllowed(a, b);
    if (!this.clearAlong(a, b, VCARVE_LINK_MARGIN)) return false;
    return this.field.inside([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
  }

  /** `chordAllowed`, with the distance to the outline also at least `margin` everywhere. */
  private clearAlong(a: Vec3, b: Vec3, margin: number): boolean {
    const { rt, tan } = this.lim;
    const top = this.top;
    const L = dist2(a, b);
    const at = (u: number): Vec3 => [
      a[0] + (b[0] - a[0]) * u,
      a[1] + (b[1] - a[1]) * u,
      a[2] + (b[2] - a[2]) * u,
    ];
    const need = (p: Vec3): number => Math.max(rt + (top - p[2]) * tan - VCARVE_TOLERANCE, margin);
    if (L < EPS) {
      const deep = a[2] < b[2] ? a : b;
      return this.field.dist([deep[0], deep[1]]) >= need(deep);
    }
    const k = (Math.abs(b[2] - a[2]) / L) * tan;
    const stack: [number, number][] = [[0, 1]];
    while (stack.length > 0) {
      const [u0, u1] = stack.pop()!;
      const p = at((u0 + u1) / 2);
      const half = ((u1 - u0) / 2) * L;
      const f = this.field.dist([p[0], p[1]]);
      const n = need(p);
      if (f < n) return false;
      if (f - half * (1 + k) >= n || half < 1e-3) continue;
      const mid = (u0 + u1) / 2;
      stack.push([u0, mid], [mid, u1]);
    }
    return true;
  }

  /** Samples one inset loop at `delta`, the next inset `step` further in. */
  private sampleLoop(loop: Loop2, step: number): Sample[] {
    const pieces = piecesOf(loop, step);
    const field = this.field;
    // A ridge exactly at the next inset leaves that inset with nothing there (the offset drops
    // slivers), so the test looks a little past it.
    const reach = step + RIDGE_OVERLAP;
    const make = (piece: number, u: number): Sample => {
      const { q, n } = evalPiece(pieces[piece]!, u);
      const fq = field.dist(q);
      const at = (t: number): Vec2 => [q[0] + n[0] * t, q[1] + n[1] * t];
      const rising = (t: number): boolean => field.dist(at(t)) >= fq + RATE * t - RIDGE_TOLERANCE;
      // The distance is unsigned, so near a very sharp tip the normal can cross the outline within
      // the ridge tolerance and keep "rising" outside. A point outside the shape is no centre-line
      // point: the sample falls back to the tool standing on the inset itself, which touches the
      // outline and no more.
      const own = (): Sample => ({ piece, u, q, n, collapsed: true, m: q, f: fq });
      if (rising(reach)) {
        const m = at(step);
        if (!field.inside(m)) return own();
        return { piece, u, q, n, collapsed: false, m, f: field.dist(m) };
      }
      // Where the distance stops rising (about as fast as the step), then its highest point
      // before there: the ridge.
      let lo = 0;
      let hi = reach;
      for (let k = 0; k < RIDGE_BISECTIONS; k++) {
        const t = (lo + hi) / 2;
        if (rising(t)) lo = t;
        else hi = t;
      }
      // Golden-section search for the highest distance on [0, lo], one evaluation per step.
      const g = (Math.sqrt(5) - 1) / 2;
      let a = 0;
      let b = lo;
      let t1 = b - g * (b - a);
      let t2 = a + g * (b - a);
      let f1 = field.dist(at(t1));
      let f2 = field.dist(at(t2));
      for (let k = 0; k < 60 && b - a > RIDGE_SEARCH_TOLERANCE; k++) {
        if (f1 < f2) {
          a = t1;
          t1 = t2;
          f1 = f2;
          t2 = a + g * (b - a);
          f2 = field.dist(at(t2));
        } else {
          b = t2;
          t2 = t1;
          f2 = f1;
          t1 = b - g * (b - a);
          f1 = field.dist(at(t1));
        }
      }
      const m = at((a + b) / 2);
      if (!field.inside(m)) return own();
      return { piece, u, q, n, collapsed: true, m, f: field.dist(m) };
    };
    /** How far `mid`'s centre-line point is from the chord of `a`'s and `b`'s (x, y and f). */
    const deviation = (a: Sample, b: Sample, mid: Sample): number => {
      const d = [b.m[0] - a.m[0], b.m[1] - a.m[1], b.f - a.f] as const;
      const p = [mid.m[0] - a.m[0], mid.m[1] - a.m[1], mid.f - a.f] as const;
      const l2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
      const t =
        l2 > 0 ? Math.min(1, Math.max(0, (p[0] * d[0] + p[1] * d[1] + p[2] * d[2]) / l2)) : 0;
      return Math.hypot(p[0] - t * d[0], p[1] - t * d[1], p[2] - t * d[2]);
    };
    const refine = (a: Sample, b: Sample, depth: number, out: Sample[]): void => {
      if (depth >= REFINE_DEPTH || (!a.collapsed && !b.collapsed)) return;
      const mid = make(a.piece, (a.u + b.u) / 2);
      if (a.collapsed && b.collapsed && mid.collapsed && deviation(a, b, mid) <= REFINE_TOLERANCE) {
        return;
      }
      refine(a, mid, depth + 1, out);
      out.push(mid);
      refine(mid, b, depth + 1, out);
    };
    const out: Sample[] = [];
    pieces.forEach((piece, i) => {
      const n = Math.max(1, Math.ceil(piece.length / VCARVE_SAMPLE));
      let prev = make(i, 0);
      out.push(prev);
      for (let k = 1; k <= n; k++) {
        const s = make(i, k / n);
        refine(prev, s, 0, out);
        out.push(s);
        prev = s;
      }
    });
    return out;
  }

  /** The centre-line polylines found from one inset loop. */
  centreLines(loop: Loop2, step: number): Polyline[] {
    const samples = this.sampleLoop(loop, step);
    const n = samples.length;
    if (n === 0 || !samples.some((s) => s.collapsed)) return [];
    const point = (s: Sample): Vec3 => [s.m[0], s.m[1], this.top - this.depthAt(s.f)];
    let raw: Polyline[];
    if (samples.every((s) => s.collapsed)) {
      raw = [{ points: samples.map(point), closed: true }];
    } else {
      // Rotate so the list starts on a sample that does not collapse, then take the runs that
      // do, each with the sample on either side (its point is on the next inset).
      const first = samples.findIndex((s) => !s.collapsed);
      const ring = [...samples.slice(first), ...samples.slice(0, first)];
      raw = [];
      let i = 0;
      while (i < n) {
        if (!ring[i]!.collapsed) {
          i++;
          continue;
        }
        let j = i;
        while (j + 1 < n && ring[j + 1]!.collapsed) j++;
        const run = ring.slice(i - 1, j + 2 > n ? n : j + 2);
        if (j + 1 >= n) run.push(ring[0]!);
        raw.push({ points: run.map(point), closed: false });
        i = j + 1;
      }
    }
    return raw.flatMap((p) => this.splitAndSimplify(p));
  }

  /** Splits a polyline where a chord leaves the carve, then simplifies each piece. */
  private splitAndSimplify(line: Polyline): Polyline[] {
    const pts: Vec3[] = [];
    for (const p of line.points) {
      const last = pts[pts.length - 1];
      if (!last || dist2(last, p) > 1e-6 || Math.abs(last[2] - p[2]) > 1e-6) pts.push(p);
    }
    if (line.closed && pts.length > 1) {
      const a = pts[0]!;
      const b = pts[pts.length - 1]!;
      if (dist2(a, b) <= 1e-6 && Math.abs(a[2] - b[2]) <= 1e-6) pts.pop();
    }
    if (pts.length < 2) return [];
    const ok = (a: Vec3, b: Vec3): boolean => this.chordAllowed(a, b);
    const pieces: Vec3[][] = [];
    let closed = line.closed;
    if (closed) {
      const breakAt = pts.findIndex((p, i) => !ok(p, pts[(i + 1) % pts.length]!));
      if (breakAt >= 0) {
        closed = false;
        // Start after the break: the points up to it go to the end.
        const head = pts.splice(0, breakAt + 1);
        for (const p of head) pts.push(p);
      } else pts.push(pts[0]!);
    }
    let cur: Vec3[] = [pts[0]!];
    for (let i = 1; i < pts.length; i++) {
      if (ok(pts[i - 1]!, pts[i]!)) cur.push(pts[i]!);
      else {
        pieces.push(cur);
        cur = [pts[i]!];
      }
    }
    pieces.push(cur);
    const deepest = (ps: readonly Vec3[]): number => {
      let z = Infinity;
      for (const p of ps) z = Math.min(z, p[2]);
      return z;
    };
    return pieces
      .filter((ps) => ps.length >= 2 && this.top - deepest(ps) > MIN_DEPTH)
      .map((ps) => ({ points: this.simplify(ps), closed: closed && pieces.length === 1 }));
  }

  /** Douglas-Peucker in the plane and the cone's reach, keeping only chords that stay inside. */
  private simplify(pts: readonly Vec3[]): Vec3[] {
    const tan = this.lim.tan;
    const err = (a: Vec3, b: Vec3, p: Vec3): number => {
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const dz = (b[2] - a[2]) * tan;
      const l2 = dx * dx + dy * dy + dz * dz;
      const px = p[0] - a[0];
      const py = p[1] - a[1];
      const pz = (p[2] - a[2]) * tan;
      const t = l2 > 0 ? Math.min(1, Math.max(0, (px * dx + py * dy + pz * dz) / l2)) : 0;
      return Math.hypot(px - t * dx, py - t * dy, pz - t * dz);
    };
    const keep = new Uint8Array(pts.length);
    keep[0] = 1;
    keep[pts.length - 1] = 1;
    const stack: [number, number][] = [[0, pts.length - 1]];
    while (stack.length > 0) {
      const [i, j] = stack.pop()!;
      if (j - i < 2) continue;
      let worst = -1;
      let at = i;
      for (let k = i + 1; k < j; k++) {
        const e = err(pts[i]!, pts[j]!, pts[k]!);
        if (e > worst) {
          worst = e;
          at = k;
        }
      }
      if (worst <= SIMPLIFY_TOLERANCE && this.chordAllowed(pts[i]!, pts[j]!)) continue;
      keep[at] = 1;
      stack.push([i, at], [at, j]);
    }
    return pts.filter((_, k) => keep[k] === 1);
  }
}

const prefixed = <T>(r: CamResult<T>, id: string): CamResult<T> =>
  r.ok ? r : err(r.error.code, `${id}: ${r.error.message}`);

/** Inset of `source` by `delta` (the outline itself at zero). */
function inset(source: readonly Loop2[], delta: number): CamResult<Loop2[]> {
  if (delta <= 0) return ok([...source]);
  const r = offsetLoops(source, -delta);
  return r.ok ? ok(regionLoops(r.value)) : r;
}

/** The largest inset that is not empty, to within 0.01 mm (the shape's inradius). */
function inradius(source: readonly Loop2[], from: number, hint: number): CamResult<number> {
  let lo = from;
  let hi = Math.max(hint, from + 0.01);
  for (;;) {
    const r = offsetLoops(source, -hi);
    if (!r.ok) return r;
    if (r.value.length === 0) break;
    lo = hi;
    hi *= 2;
  }
  while (hi - lo > 0.01) {
    const mid = (lo + hi) / 2;
    const r = offsetLoops(source, -mid);
    if (!r.ok) return r;
    if (r.value.length > 0) lo = mid;
    else hi = mid;
  }
  return ok(lo);
}

/** Plans the V-bit's cuts: the centre lines, the full-depth inset and the floor rings. */
async function plan(
  op: VCarveOperation,
  carver: Carver,
  context: OperationContext,
): Promise<CamResult<CarvePlan>> {
  const { source, lim } = carver;
  const warnings: CamWarning[] = [];
  const { rt, tan, deltaMax } = lim;
  const lines: Polyline[] = [];
  const rings: Loop2[] = [];

  // The insets that locate the centre line, from the tip radius in to `deltaMax`.
  const span = deltaMax - rt;
  let count = Math.max(1, Math.ceil(span / VCARVE_INSET_STEP - 1e-9));
  if (count > VCARVE_MAX_LEVELS) {
    count = VCARVE_MAX_LEVELS;
    warnings.push(
      warn(
        'levels-capped',
        `The carve needs more than ${VCARVE_MAX_LEVELS} insets; the inset step is ${fmt(span / count, 3)} mm instead of ${VCARVE_INSET_STEP} mm.`,
      ),
    );
  }
  const deltas = Array.from({ length: count + 1 }, (_, k) =>
    k === count ? deltaMax : rt + (span * k) / count,
  );
  for (let k = 0; k < count; k++) {
    await context.checkpoint();
    const loops = inset(source, deltas[k]!);
    if (!loops.ok) return loops;
    if (loops.value.length === 0) break;
    for (const loop of loops.value) {
      for (const l of carver.centreLines(loop, deltas[k + 1]! - deltas[k]!)) lines.push(l);
    }
  }

  // The full-depth inset, and the floor inside it.
  const full = inset(source, deltaMax);
  if (!full.ok) return full;
  if (full.value.length > 0) {
    const clearing = op.clearing;
    const limit = clearing ? deltaMax + clearing.tool.diameter / 2 : Infinity;
    const deepest = inradius(source, deltaMax, deltaMax + 1);
    if (!deepest.ok) return deepest;
    const reach = Math.min(deepest.value, limit);
    let s = op.flatStepover ?? 2 * (rt + VCARVE_FLAT_RIDGE * tan);
    let n = Math.max(0, Math.ceil((reach - deltaMax) / s - 1e-9));
    if (n > VCARVE_MAX_FLAT_RINGS) {
      n = VCARVE_MAX_FLAT_RINGS;
      s = (reach - deltaMax) / n;
      warnings.push(
        warn(
          'flat-stepover-coarsened',
          `The flat floor would need more than ${VCARVE_MAX_FLAT_RINGS} rings; they are ${fmt(s, 3)} mm apart instead.`,
        ),
      );
    }
    for (let j = 0; ; j++) {
      await context.checkpoint();
      const delta = deltaMax + j * s;
      if (delta > limit + EPS) break;
      const loops = inset(source, delta);
      if (!loops.ok) return loops;
      if (loops.value.length === 0) break;
      for (const loop of loops.value) {
        rings.push(loop);
        for (const l of carver.centreLines(loop, s)) lines.push(l);
      }
    }
    const floor = inset(source, deltaMax - rt);
    if (!floor.ok) return floor;
    const floorArea = floor.value.reduce((a, l) => a + loopArea(l), 0);
    if (op.maxDepth === undefined) {
      warnings.push(
        warn(
          'tool-depth-limit',
          `Parts of the shape are wider than the V-bit can carve to a point; they are carved flat at its full depth of ${fmt(lim.depth)} mm.`,
        ),
      );
    }
    if (!clearing && floorArea > 0) {
      const ridge = Math.max(0, s / 2 - rt) / tan;
      warnings.push(
        warn(
          'flat-floor',
          `The V-bit clears ${fmt(floorArea, 1)} mm2 of flat floor at ${fmt(lim.depth)} mm in rings ${fmt(s, 3)} mm apart, leaving ridges up to ${fmt(ridge, 3)} mm high; a clearing end mill does it faster and flatter.`,
        ),
      );
    }
  }

  // What the tip is too wide to reach.
  if (rt > 0) {
    const tips = offsetLoops(source, -rt);
    if (!tips.ok) return tips;
    const reached = offsetLoops(regionLoops(tips.value), rt);
    if (!reached.ok) return reached;
    const left = differenceLoops(source, regionLoops(reached.value));
    if (!left.ok) return left;
    const area = left.value.reduce((a, r) => a + regionArea(r), 0);
    if (area > Math.max(1e-3, 0.25 * rt * rt * left.value.length)) {
      warnings.push(
        warn(
          'too-narrow',
          `${fmt(area, 2)} mm2 of the shape is narrower than the ${fmt(2 * rt)} mm flat tip (or a corner sharper than it); it is left uncut.`,
        ),
      );
    }
  }
  return ok({ lines, rings, warnings });
}

// ---------------------------------------------------------------------------------------------
// Toolpath

/** A loop as a cut path in its natural direction (climb for an M3 spindle), starting near `near`. */
function ringPath(loop: Loop2, near: Vec2): CutPath {
  const segs = loop.segments.flatMap((seg): Segment2[] => {
    if (seg.kind !== 'arc' || !seg.fullCircle) return [seg];
    const mid = subSegment(seg, 0, 0.5).end;
    return [
      { kind: 'arc', start: seg.start, end: mid, center: seg.center, ccw: seg.ccw },
      { kind: 'arc', start: mid, end: seg.start, center: seg.center, ccw: seg.ccw },
    ];
  });
  const build = (segments: Segment2[]): CutPath => {
    const cum = [0];
    for (const seg of segments) cum.push(cum[cum.length - 1]! + segmentLength(seg));
    const area = loopArea({ segments });
    return {
      segments,
      cum,
      length: cum[cum.length - 1]!,
      scrapOnLeft: true,
      enclosesScrap: area > 0,
      clearance: 0,
      area: Math.abs(area),
    };
  };
  const whole = build(segs);
  const { s } = closestOnPath(whole, near);
  let i = 0;
  while (i < segs.length - 1 && s >= whole.cum[i + 1]! - EPS) i++;
  const len = whole.cum[i + 1]! - whole.cum[i]!;
  const t = len > 0 ? (s - whole.cum[i]!) / len : 0;
  if (t <= 1e-9) return build([...segs.slice(i), ...segs.slice(0, i)]);
  if (t >= 1 - 1e-9) return build([...segs.slice(i + 1), ...segs.slice(0, i + 1)]);
  const seg = segs[i]!;
  return build([
    subSegment(seg, t, 1),
    ...segs.slice(i + 1),
    ...segs.slice(0, i),
    subSegment(seg, 0, t),
  ]);
}

type Job =
  | { readonly kind: 'line'; readonly points: readonly Vec3[]; readonly closed: boolean }
  | { readonly kind: 'ring'; readonly loop: Loop2; readonly z: number };

/** The parts of `line` deeper than `above`, clamped to no deeper than `floor`. */
function clipLine(line: Polyline, above: number, floor: number): Job[] {
  const pts = line.points.map((p): Vec3 => [p[0], p[1], Math.max(p[2], floor)]);
  const active = line.points.map((p) => p[2] < above - 1e-6);
  if (active.every(Boolean)) return [{ kind: 'line', points: pts, closed: line.closed }];
  if (!active.some(Boolean)) return [];
  const n = pts.length;
  const order = line.closed
    ? (() => {
        const first = active.findIndex((a) => !a);
        return Array.from({ length: n }, (_, k) => (first + k) % n);
      })()
    : Array.from({ length: n }, (_, k) => k);
  const out: Job[] = [];
  let k = 0;
  while (k < n) {
    if (!active[order[k]!]) {
      k++;
      continue;
    }
    let j = k;
    while (j + 1 < n && active[order[j + 1]!]) j++;
    const idx: number[] = [];
    if (k > 0) idx.push(order[k - 1]!);
    for (let m = k; m <= j; m++) idx.push(order[m]!);
    if (j + 1 < n) idx.push(order[j + 1]!);
    else if (line.closed) idx.push(order[0]!);
    out.push({ kind: 'line', points: idx.map((i) => pts[i]!), closed: false });
    k = j + 1;
  }
  return out;
}

/** A job's bounding box in the plane: min x, min y, max x, max y. */
function boxOf(job: Job): [number, number, number, number] {
  const box: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  const add = (x: number, y: number): void => {
    box[0] = Math.min(box[0], x);
    box[1] = Math.min(box[1], y);
    box[2] = Math.max(box[2], x);
    box[3] = Math.max(box[3], y);
  };
  if (job.kind === 'line') {
    for (const p of job.points) add(p[0], p[1]);
    return box;
  }
  for (const s of job.loop.segments) {
    add(s.start[0], s.start[1]);
    if (s.kind === 'arc') {
      const r = Math.hypot(s.start[0] - s.center[0], s.start[1] - s.center[1]);
      add(s.center[0] - r, s.center[1] - r);
      add(s.center[0] + r, s.center[1] + r);
    }
  }
  return box;
}

/**
 * How far `here` is from where the job can start: an end of an open line, any point of a closed
 * one, anywhere on a ring. `Infinity` once it is clear the job is no nearer than `bound`.
 */
function nearestOf(job: Job, here: Vec2, bound: number): number {
  if (job.kind === 'line') {
    const pts = job.points;
    if (!job.closed) return Math.min(dist2(pts[0]!, here), dist2(pts[pts.length - 1]!, here));
    let d = Infinity;
    for (const p of pts) d = Math.min(d, dist2(p, here));
    return d;
  }
  let d = bound;
  for (const s of job.loop.segments) {
    // Each segment's own box first: the distance to it is at least the distance to its box.
    const r = s.kind === 'arc' ? Math.hypot(s.start[0] - s.center[0], s.start[1] - s.center[1]) : 0;
    const x0 = s.kind === 'arc' ? s.center[0] - r : Math.min(s.start[0], s.end[0]);
    const x1 = s.kind === 'arc' ? s.center[0] + r : Math.max(s.start[0], s.end[0]);
    const y0 = s.kind === 'arc' ? s.center[1] - r : Math.min(s.start[1], s.end[1]);
    const y1 = s.kind === 'arc' ? s.center[1] + r : Math.max(s.start[1], s.end[1]);
    const dx = Math.max(x0 - here[0], 0, here[0] - x1);
    const dy = Math.max(y0 - here[1], 0, here[1] - y1);
    if (Math.hypot(dx, dy) >= d) continue;
    d = Math.min(d, distToSegment(here, s));
  }
  return d;
}

class VCarveEmitter {
  readonly em: Emitter;
  private startPos: Vec3 | undefined;
  readonly approachZ: number;
  readonly retractZ: number;
  readonly clearanceZ: number;
  private readonly maxLink: number;

  constructor(
    op: VCarveOperation,
    context: OperationContext,
    private readonly carver: Carver,
  ) {
    const startZ = Math.max(stockTopZ(context.setup), op.top);
    const heights = context.setup.heights;
    this.approachZ = startZ + VCARVE_SAFE_ABOVE;
    this.retractZ = Math.max(heights.retract, this.approachZ);
    this.clearanceZ = Math.max(heights.clearance, this.retractZ);
    this.maxLink = op.tool.diameter;
    this.em = new Emitter(op.id, op.feeds, [0, 0, this.clearanceZ]);
  }

  /** To `to` (on the carve): fed across when the move stays in the carve, else over the top. */
  goTo(to: Vec3): void {
    const em = this.em;
    const cur = em.cur;
    if (
      this.startPos &&
      cur[2] < this.approachZ - EPS &&
      dist2(cur, to) <= this.maxLink &&
      this.carver.linkAllowed(cur, to)
    ) {
      em.linear(to, 'cut');
      return;
    }
    if (!this.startPos) {
      this.startPos = [to[0], to[1], this.clearanceZ];
      em.cur = this.startPos;
    } else {
      if (cur[2] < this.retractZ) em.rapid([cur[0], cur[1], this.retractZ]);
      em.rapid([to[0], to[1], em.cur[2]]);
    }
    em.rapid([to[0], to[1], this.approachZ]);
    em.linear(to, 'plunge');
  }

  async cut(jobs: readonly Job[], context: OperationContext): Promise<void> {
    const em = this.em;
    // Each job's bounding box, so the nearest-first search skips the jobs that cannot be nearer
    // than the best so far; and closed lines without their repeated closing point.
    const left = jobs.map((job) => {
      if (job.kind === 'line' && job.closed) {
        const pts = job.points;
        const a = pts[0]!;
        const b = pts[pts.length - 1]!;
        if (pts.length > 2 && dist2(a, b) <= EPS && Math.abs(a[2] - b[2]) <= EPS) {
          return { job: { ...job, points: pts.slice(0, -1) }, box: boxOf(job) };
        }
      }
      return { job, box: boxOf(job) };
    });
    while (left.length > 0) {
      await context.checkpoint();
      const here: Vec2 = [em.cur[0], em.cur[1]];
      let best = 0;
      let bestD = Infinity;
      for (let i = 0; i < left.length; i++) {
        const { job, box } = left[i]!;
        const dx = Math.max(box[0] - here[0], 0, here[0] - box[2]);
        const dy = Math.max(box[1] - here[1], 0, here[1] - box[3]);
        if (Math.hypot(dx, dy) >= bestD) continue;
        const d = nearestOf(job, here, bestD);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      const { job } = left.splice(best, 1)[0]!;
      if (job.kind === 'ring') {
        const path = ringPath(job.loop, here);
        const p0 = pointAt(path, 0);
        this.goTo([p0[0], p0[1], job.z]);
        walk(em, path, path.length, { s0: 0, rampEnd: 0, from: job.z, to: job.z }, [], -Infinity);
        continue;
      }
      let pts: readonly Vec3[] = job.points;
      if (job.closed) {
        let at = 0;
        for (let i = 1; i < pts.length; i++) {
          if (dist2(pts[i]!, here) < dist2(pts[at]!, here)) at = i;
        }
        // Round from the nearest point and back to it (the closing point is not repeated).
        const rotated: Vec3[] = [];
        for (let k = 0; k <= pts.length; k++) rotated.push(pts[(at + k) % pts.length]!);
        pts = rotated;
      } else if (dist2(pts[pts.length - 1]!, here) < dist2(pts[0]!, here)) {
        pts = [...pts].reverse();
      }
      this.goTo(pts[0]!);
      for (let i = 1; i < pts.length; i++) em.linear(pts[i]!, 'cut');
    }
  }

  result(warnings: readonly CamWarning[]): GeneratedToolpath {
    const em = this.em;
    em.rapid([em.cur[0], em.cur[1], this.clearanceZ]);
    const toolpath = { start: this.startPos ?? [0, 0, this.clearanceZ], entries: em.entries };
    return warnings.length > 0 ? { toolpath, warnings } : { toolpath };
  }
}

function prepare(
  input: VCarveInput,
): CamResult<{ op: VCarveOperation; source: Loop2[]; lim: Limits; notes: CamWarning[] }> {
  const op = input as VCarveOperation;
  const problem = checkInput(op);
  if (problem) return err('invalid-input', `${op.id}: ${problem}`);
  if (op.loops.length === 0) return err('invalid-input', `${op.id}: the V-carve has no loops.`);
  const united = unionLoops(op.loops);
  if (!united.ok) return prefixed(united, op.id);
  const source = regionLoops(united.value);
  if (source.length === 0) return err('invalid-input', `${op.id}: the loops enclose nothing.`);
  const { limits, capped } = limitsOf(op);
  const notes: CamWarning[] = [];
  if (op.maxDepth !== undefined && capped) {
    notes.push(
      warn(
        'max-depth-limited',
        `The maximum depth of ${fmt(op.maxDepth)} mm is deeper than the ${capped === 'tool' ? "V-bit's cone" : "tool's flutes"} reach; the carve stops at ${fmt(limits.depth)} mm.`,
      ),
    );
  }
  return ok({ op, source, lim: limits, notes });
}

// ---------------------------------------------------------------------------------------------
// The generators

/**
 * Generates a V-carve operation's toolpath (registered as the `vcarve` generator): the centre-line
 * passes, the full-depth inset and the floor rings, in one IR `pass` per depth level (one level
 * unless `stepdown` is set), each level in nearest-first order.
 */
export async function generateVCarve(
  input: VCarveInput,
  context: OperationContext,
): Promise<CamResult<GeneratedToolpath>> {
  const prep = prepare(input);
  if (!prep.ok) return prep;
  const { op, source, lim, notes } = prep.value;
  const carver = new Carver(source, op.top, lim);
  const planned = await plan(op, carver, context);
  if (!planned.ok) return prefixed(planned, op.id);
  const { lines, rings, warnings } = planned.value;
  if (lines.length === 0 && rings.length === 0) {
    return err('invalid-input', `${op.id}: the shape is too small for the V-bit to carve.`);
  }
  const out = new VCarveEmitter(op, context, carver);
  // The levels go down to the deepest point the carve has, not the deepest it may have.
  let floor = op.top - lim.depth;
  if (rings.length === 0) {
    floor = Infinity;
    for (const l of lines) for (const p of l.points) floor = Math.min(floor, p[2]);
  }
  const lv = op.stepdown !== undefined ? levels(op.top, floor, op.stepdown) : ok([floor]);
  if (!lv.ok) return prefixed(lv, op.id);
  const zs = lv.value;
  for (let i = 0; i < zs.length; i++) {
    const z = zs[i]!;
    const above = i === 0 ? op.top : zs[i - 1]!;
    const jobs: Job[] = [
      ...lines.flatMap((line) => clipLine(line, above, z)),
      ...rings.map((loop): Job => ({ kind: 'ring', loop, z })),
    ];
    await out.cut(jobs, context);
    out.em.pass++;
  }
  out.em.pass = Math.max(0, out.em.pass - 1);
  return ok(out.result([...notes, ...warnings]));
}

/**
 * Whether the V-carve would feed straight from `a` to `b` when linking two of its pieces, rather
 * than going over the top: the move keeps the cone inside the carve, stays
 * `VCARVE_LINK_MARGIN` from the outline and runs inside the shape. For tests and previews.
 */
export function vcarveLinkAllowed(input: VCarveInput, a: Vec3, b: Vec3): CamResult<boolean> {
  const prep = prepare(input);
  if (!prep.ok) return prep;
  const { op, source, lim } = prep.value;
  return ok(new Carver(source, op.top, lim).linkAllowed(a, b));
}

/**
 * The flat-floor clearing of a V-carve with `clearing` set, as its own toolpath for the clearing
 * tool (run it before the V-carve): a pocket of the floor, the shape inset to where the V-bit's
 * flanks meet the floor at the maximum depth, from the stock top (or `top`) down to that depth.
 * An empty toolpath with a warning when the carve has no floor or the end mill fits nowhere on it.
 */
export async function generateVCarveClearing(
  input: VCarveInput,
  context: OperationContext,
): Promise<CamResult<GeneratedToolpath>> {
  const prep = prepare(input);
  if (!prep.ok) return prep;
  const { op, source, lim } = prep.value;
  const c = op.clearing;
  if (!c) return err('invalid-input', `${op.id}: the V-carve has no clearing tool.`);
  const heights = context.setup.heights;
  const empty = (code: string, message: string): CamResult<GeneratedToolpath> =>
    ok({
      toolpath: { start: [0, 0, Math.max(heights.clearance, heights.retract)], entries: [] },
      warnings: [warn(code, message)],
    });
  const floor = inset(source, lim.deltaMax - lim.rt);
  if (!floor.ok) return prefixed(floor, op.id);
  if (floor.value.length === 0) {
    return empty('no-floor', 'The carve has no flat floor to clear; the V-bit carves it all.');
  }
  const rc = c.tool.diameter / 2;
  const fits = offsetLoops(floor.value, -rc);
  if (!fits.ok) return prefixed(fits, op.id);
  if (fits.value.length === 0) {
    return empty(
      'clearing-tool-does-not-fit',
      `The ${fmt(c.tool.diameter)} mm clearing tool fits nowhere on the floor; the V-bit clears it.`,
    );
  }
  const top = Math.max(stockTopZ(context.setup), op.top);
  const pocket: PocketOperation = {
    kind: 'pocket',
    id: op.id,
    name: op.name,
    tool: c.tool,
    feeds: c.feeds,
    loops: floor.value,
    depth: { top, bottom: op.top - lim.depth },
    stepdown: c.stepdown,
    stepover: c.stepover,
    finishAllowance: 0,
    entry: c.entry ?? { kind: 'helix', angle: (3 * Math.PI) / 180, radius: rc / 2 },
    climb: true,
  };
  const result = await generatePocket(pocket, context);
  if (!result.ok) return result;
  // Corners the end mill cannot reach are the V-bit's floor rings' work, not uncut areas.
  const warnings = (result.value.warnings ?? []).filter((w) => w.code !== 'unreachable');
  return ok(
    warnings.length > 0
      ? { toolpath: result.value.toolpath, warnings }
      : { toolpath: result.value.toolpath },
  );
}
