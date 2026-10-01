// Sketch regions: the closed areas a solved sketch encloses, which extrude
// and revolve consume as profiles.
//
// The non-construction lines, arcs and circles are split wherever they meet
// (crossings, T-junctions, tangencies, collinear or concentric overlaps) and
// joined into a planar graph. Dangling edges and bridges are removed, and the
// faces of what is left are traced with the usual "next edge clockwise"
// rule, ordering edges that leave a vertex in the same direction by their
// curvature. Every bounded face is a candidate region; loops that do not
// touch are nested by containment, and nesting depth decides even-odd: faces
// at even depth are regions, faces at odd depth are voids (the holes).
//
// Naming (see README, "Regions"):
//
// - An edge is named after the entity it lies on. When the regions use the
//   entity in several separate stretches (because other geometry meets it),
//   the stretches are `<id>#1`, `<id>#2`, ... in order along the entity and
//   flagged fragile: `#<digits>` is positional (T0.5), so the naming layer
//   reads `e2` as their ancestor and warns when a reference rests on them.
// - A region's id is the set of entities on its outer loop, each with the
//   side the region lies on (`/L` left, `/R` right of the entity's own
//   direction, `/LR` both), sorted and joined by `+`: `c1/L+l1/R`. Holes are
//   left out, so adding or removing a hole keeps the id. When two faces still
//   get the same id, they are told apart by position (`#1`, `#2`, ...) and
//   flagged fragile.
//
// Units are millimetres; everything is plain data.

import type { SketchEntity, Vec2 } from './model';
import { bezierPoint } from './outline';

const TAU = 2 * Math.PI;
/** Directions leaving a vertex closer than this (radians) are ordered by curvature. */
const ANGLE_TOLERANCE = 1e-8;
/** Default tolerance relative to the sketch's extent. */
const RELATIVE_TOLERANCE = 1e-6;

// Public types ----------------------------------------------------------------------

interface RegionEdgeInfo {
  /**
   * The edge's name: the entity id when the regions use the entity in one
   * stretch, else `<entity id>#<k>` (k from 1, in order along the entity).
   * Extruding the region names its side face `<feature>:side:<edgeId>`.
   */
  edgeId: string;
  /** The sketch entity the edge lies on. */
  entityId: string;
  /** `edgeId` is positional (`#<k>`), so references to it are fragile (T0.5). */
  fragile: boolean;
  /**
   * Traversed against the entity's own direction (lines run from start to end,
   * arcs and circles counter-clockwise).
   */
  reversed: boolean;
}

/**
 * One stretch of an entity along a region loop, in loop order. Arcs turn clockwise when
 * `reversed`. Beziers come only from outline entities (glyphs): 3 (quadratic) or 4 (cubic)
 * control points, the first `start` and the last `end`.
 */
export type RegionCurve = RegionEdgeInfo &
  (
    | { kind: 'line'; start: Vec2; end: Vec2 }
    | { kind: 'bezier'; points: Vec2[]; start: Vec2; end: Vec2 }
    | { kind: 'arc'; center: Vec2; radius: number; start: Vec2; end: Vec2 }
    | {
        kind: 'circle';
        center: Vec2;
        radius: number;
        /** Where the loop starts and ends: a point it touches other geometry at, if any. */
        start: Vec2;
      }
  );

export interface RegionLoop {
  /** Consecutive curves: each ends where the next starts. A circle is a loop on its own. */
  curves: RegionCurve[];
  /** Signed area: positive when the loop runs counter-clockwise. */
  area: number;
}

export interface Region {
  /** Stable id from the outer loop's entities and sides; see the file comment. */
  id: string;
  /** The id needed a positional `#k` to be unique. */
  fragile: boolean;
  /** Counter-clockwise outer boundary. */
  outer: RegionLoop;
  /** Clockwise holes. */
  holes: RegionLoop[];
  /** Enclosed area: the outer loop's minus the holes'. */
  area: number;
  /**
   * How many other loops enclose it: even for regions, odd for voids. Outline regions (the
   * letters of a text) are always regions, whatever their depth.
   */
  depth: number;
  /** Every entity on any of its loops, sorted. */
  entityIds: string[];
  /**
   * Set on the counter of an outline (the inside of an "O") that lies in another face: the
   * entities that select it, which are that face's (its outer loop's), not the outline's. So
   * listing a plate's lines picks the plate with letter-shaped holes and the counters, and
   * listing the text picks the letters alone. Sorted.
   */
  selectedWith?: string[];
}

/**
 * One region of an outline entity (a glyph, or glyphs merged where they overlap), placed in the
 * sketch: `placeOutline` makes them from `outlinePartsRegions`. Its curves are lines and
 * Beziers whose `entityId` is the outline's.
 */
export interface OutlineShape {
  /** The outline entity. */
  entityId: string;
  /** Unique within the sketch: `<entity id>.g<glyph>.c<contour>` of the outer loop's first contour. */
  key: string;
  /** The key needed a positional `#k` to be unique (merging split one contour into several loops). */
  fragile: boolean;
  /** Counter-clockwise. */
  outer: RegionLoop;
  /** Clockwise, each with the key of its contour (for the counter's region id). */
  holes: (RegionLoop & { key: string })[];
}

export type RegionDiagnosticCode =
  /** An entity has no usable geometry (zero length or radius, an arc off its circle); ignored. */
  | 'degenerate'
  /** Connected geometry that encloses nothing: an open chain. */
  | 'open-profile'
  /** An entity that bounds no region, although what it touches does. */
  | 'dangling-edge'
  /** Part of an entity runs past where it meets other geometry and bounds nothing. */
  | 'overhang'
  /** Two entities lie on top of each other over some length; the one with the smaller id keeps the edge. */
  | 'overlap'
  /** Two entities cross between their ends, so the loops are split there. */
  | 'crossing'
  /** A loop touches itself or another loop of the same region at a single point. */
  | 'touching'
  /** Two faces got the same id; they are numbered by position. */
  | 'ambiguous-id'
  /**
   * An outline (text) crosses other sketch geometry or another outline, or encloses some: its
   * regions are kept as they are and overlap the others' (the kernel fuses what is extruded
   * together), and it cuts no hole in the face around it.
   */
  | 'outline-overlap';

export interface RegionDiagnostic {
  code: RegionDiagnosticCode;
  severity: 'info' | 'warning';
  message: string;
  /** The entities involved, sorted. */
  entityIds: string[];
  /** Where: open ends, crossings, touching points. */
  points?: Vec2[];
}

export interface SketchRegions {
  /** Faces at even depth, sorted by id: what "the whole sketch" extrudes to. */
  regions: Region[];
  /** Faces at odd depth (inside a hole), sorted by id. Selectable, not filled by default. */
  voids: Region[];
  diagnostics: RegionDiagnostic[];
  /** The distance below which points count as coincident, in millimetres. */
  tolerance: number;
}

export interface RegionOptions {
  /** Coincidence tolerance in millimetres (default 1e-6 times the sketch extent, at least 1e-6). */
  tolerance?: number;
  /**
   * The regions of the sketch's non-construction outline entities, placed (`placeOutline`).
   * Outline entities themselves are not curves of the planar graph; without this they bound
   * nothing.
   */
  outlines?: readonly OutlineShape[];
  /**
   * The work budget for joining `outlines` to the faces (default `MAX_OUTLINE_PLACEMENT_WORK`);
   * lower it in tests.
   */
  outlineWork?: number;
  /**
   * Most polygon points for flattening the faces and `outlines` (default
   * `MAX_OUTLINE_POLYGON_POINTS`); lower it in tests.
   */
  outlinePoints?: number;
}

// Curves ----------------------------------------------------------------------------

interface Curve {
  index: number;
  id: string;
  kind: 'line' | 'arc' | 'circle';
  /** Line ends; arc ends; for a circle the point at angle 0. */
  start: Vec2;
  end: Vec2;
  /** Arcs and circles. */
  center: Vec2;
  r: number;
  /** Start angle (0 for circles) and counter-clockwise sweep (2 pi for circles). */
  a0: number;
  sweep: number;
  length: number;
  box: readonly [number, number, number, number];
}

const sub = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];
const dot = (a: Vec2, b: Vec2): number => a[0] * b[0] + a[1] * b[1];
const cross = (a: Vec2, b: Vec2): number => a[0] * b[1] - a[1] * b[0];
const dist = (a: Vec2, b: Vec2): number => Math.hypot(a[0] - b[0], a[1] - b[1]);
const midpoint = (a: Vec2, b: Vec2): Vec2 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
const mod = (x: number, m: number): number => ((x % m) + m) % m;
const finite2 = (p: Vec2): boolean => Number.isFinite(p[0]) && Number.isFinite(p[1]);

function makeCurve(e: SketchEntity, index: number, tol: number): Curve | string {
  switch (e.kind) {
    case 'point':
      return 'a point bounds nothing';
    case 'outline':
      return 'an outline is not a curve';
    case 'line': {
      if (!finite2(e.start) || !finite2(e.end)) return 'coordinates are not finite';
      const length = dist(e.start, e.end);
      if (length <= tol) return 'zero-length line';
      return {
        index,
        id: e.id,
        kind: 'line',
        start: e.start,
        end: e.end,
        center: [0, 0],
        r: 0,
        a0: 0,
        sweep: 0,
        length,
        box: [
          Math.min(e.start[0], e.end[0]),
          Math.min(e.start[1], e.end[1]),
          Math.max(e.start[0], e.end[0]),
          Math.max(e.start[1], e.end[1]),
        ],
      };
    }
    case 'circle': {
      if (!finite2(e.center) || !Number.isFinite(e.radius)) return 'coordinates are not finite';
      if (!(e.radius > tol)) return 'zero radius';
      const r = e.radius;
      const [cx, cy] = e.center;
      return {
        index,
        id: e.id,
        kind: 'circle',
        start: [cx + r, cy],
        end: [cx + r, cy],
        center: e.center,
        r,
        a0: 0,
        sweep: TAU,
        length: TAU * r,
        box: [cx - r, cy - r, cx + r, cy + r],
      };
    }
    case 'arc': {
      if (!finite2(e.center) || !finite2(e.start) || !finite2(e.end)) {
        return 'coordinates are not finite';
      }
      const r = dist(e.center, e.start);
      if (!(r > tol)) return 'zero radius';
      if (Math.abs(dist(e.center, e.end) - r) > tol) return 'the arc does not end on its circle';
      if (dist(e.start, e.end) <= tol) return 'the arc starts where it ends';
      const a0 = Math.atan2(e.start[1] - e.center[1], e.start[0] - e.center[0]);
      const a1 = Math.atan2(e.end[1] - e.center[1], e.end[0] - e.center[0]);
      let sweep = mod(a1 - a0, TAU);
      if (sweep === 0) sweep = TAU;
      const [cx, cy] = e.center;
      return {
        index,
        id: e.id,
        kind: 'arc',
        start: e.start,
        end: e.end,
        center: e.center,
        r,
        a0,
        sweep,
        length: r * sweep,
        box: [cx - r, cy - r, cx + r, cy + r],
      };
    }
  }
}

/** The point at arc length `s` from the curve's start (angle 0 for circles). */
function pointAt(c: Curve, s: number): Vec2 {
  if (c.kind === 'line') {
    const t = s / c.length;
    return [c.start[0] + (c.end[0] - c.start[0]) * t, c.start[1] + (c.end[1] - c.start[1]) * t];
  }
  const a = c.a0 + s / c.r;
  return [c.center[0] + c.r * Math.cos(a), c.center[1] + c.r * Math.sin(a)];
}

/** Unit tangent at `s`, in the direction of increasing `s`. */
function tangentAt(c: Curve, s: number): Vec2 {
  if (c.kind === 'line') {
    return [(c.end[0] - c.start[0]) / c.length, (c.end[1] - c.start[1]) / c.length];
  }
  const a = c.a0 + s / c.r;
  return [-Math.sin(a), Math.cos(a)];
}

/** The parameter of the point of `c` nearest `p`, if it is within the curve's extent (with tolerance). */
function paramOf(c: Curve, p: Vec2, tol: number): { s: number; dist: number } | null {
  let s: number;
  if (c.kind === 'line') {
    const d = sub(c.end, c.start);
    s = dot(sub(p, c.start), d) / c.length;
    if (s < -tol || s > c.length + tol) return null;
    s = Math.min(c.length, Math.max(0, s));
  } else {
    const off = mod(Math.atan2(p[1] - c.center[1], p[0] - c.center[0]) - c.a0, TAU);
    if (c.kind === 'circle' || off <= c.sweep) s = off * c.r;
    else if ((off - c.sweep) * c.r <= tol) s = c.length;
    else if ((TAU - off) * c.r <= tol) s = 0;
    else return null;
  }
  return { s, dist: dist(p, pointAt(c, s)) };
}

/**
 * The parameter of `p` on the full curve of `c`, near `s` (its clamped
 * parameter from `paramOf`): past the ends of an arc it is below 0 or above
 * the length.
 */
function unclampedParam(c: Curve, p: Vec2, s: number): number {
  if (c.kind === 'line') return s;
  const at = c.a0 + s / c.r;
  const off = mod(Math.atan2(p[1] - c.center[1], p[0] - c.center[0]) - at + Math.PI, TAU) - Math.PI;
  return s + off * c.r;
}

function boxesMeet(a: Curve['box'], b: Curve['box'], tol: number): boolean {
  return a[0] <= b[2] + tol && b[0] <= a[2] + tol && a[1] <= b[3] + tol && b[1] <= a[3] + tol;
}

/**
 * Where the (full) curves of `a` and `b` meet; filtered to their extents by the
 * caller. Curves within `tol` of tangency touch at one point, halfway between
 * the two curves, so it is within `tol / 2` of each and both leave it in the
 * same direction (the face tracing orders them by curvature).
 */
function intersections(a: Curve, b: Curve, tol: number): Vec2[] {
  if (a.kind === 'line' && b.kind === 'line') {
    const d1 = sub(a.end, a.start);
    const d2 = sub(b.end, b.start);
    const den = cross(d1, d2);
    // Parallel: overlaps are found by projecting endpoints.
    if (Math.abs(den) <= 1e-12 * a.length * b.length) return [];
    const t = cross(sub(b.start, a.start), d2) / den;
    return [[a.start[0] + t * d1[0], a.start[1] + t * d1[1]]];
  }
  if (a.kind === 'line' || b.kind === 'line') {
    const [l, c] = a.kind === 'line' ? [a, b] : [b, a];
    const d: Vec2 = [(l.end[0] - l.start[0]) / l.length, (l.end[1] - l.start[1]) / l.length];
    const t0 = dot(sub(c.center, l.start), d);
    const foot: Vec2 = [l.start[0] + t0 * d[0], l.start[1] + t0 * d[1]];
    const h = dist(foot, c.center);
    if (h > c.r + tol) return [];
    // Tangency is decided by distance, not by the half-chord: that grows like
    // sqrt(2 r depth), so a 1e-10 mm dip would give two crossings far more
    // than the tolerance apart and a sliver face between them.
    if (Math.abs(h - c.r) <= tol && h > 0) {
      const touch: Vec2 = [
        c.center[0] + ((foot[0] - c.center[0]) * c.r) / h,
        c.center[1] + ((foot[1] - c.center[1]) * c.r) / h,
      ];
      return [midpoint(foot, touch)];
    }
    const k = Math.sqrt(Math.max(0, c.r * c.r - h * h));
    return [
      [foot[0] - k * d[0], foot[1] - k * d[1]],
      [foot[0] + k * d[0], foot[1] + k * d[1]],
    ];
  }
  // Two arcs or circles.
  const dd = dist(a.center, b.center);
  // Concentric: equal circles overlap (found by projecting endpoints), others never meet.
  if (dd <= tol) return [];
  if (dd > a.r + b.r + tol || dd < Math.abs(a.r - b.r) - tol) return [];
  const u: Vec2 = [(b.center[0] - a.center[0]) / dd, (b.center[1] - a.center[1]) / dd];
  // Tangent by distance (see above): the contact lies on the line of centres,
  // outward from both (external) or on the side of the smaller circle (internal).
  const external = Math.abs(dd - (a.r + b.r)) <= tol;
  if (external || Math.abs(dd - Math.abs(a.r - b.r)) <= tol) {
    const sa = external || a.r >= b.r ? 1 : -1;
    const sb = external ? -1 : sa;
    return [
      midpoint(
        [a.center[0] + sa * a.r * u[0], a.center[1] + sa * a.r * u[1]],
        [b.center[0] + sb * b.r * u[0], b.center[1] + sb * b.r * u[1]],
      ),
    ];
  }
  const along = (dd * dd + a.r * a.r - b.r * b.r) / (2 * dd);
  const h = Math.sqrt(Math.max(0, a.r * a.r - along * along));
  const m: Vec2 = [a.center[0] + along * u[0], a.center[1] + along * u[1]];
  return [
    [m[0] - h * u[1], m[1] + h * u[0]],
    [m[0] + h * u[1], m[1] - h * u[0]],
  ];
}

// Graph -----------------------------------------------------------------------------

interface Cut {
  s: number;
  point: Vec2;
  /**
   * Where a tangent contact lies, as a parameter of this curve: not clamped
   * to its extent, so it may fall just outside it. Edges leave a vertex made
   * from this cut in the direction the curve has there (see `cutsOf`).
   */
  contact?: number | undefined;
}

interface Piece {
  curve: Curve;
  s0: number;
  s1: number;
  /** Parameters at which the piece's leaving directions are taken: `s0` and `s1` unless a tangent contact was merged into that end. */
  d0: number;
  d1: number;
  v0: number;
  v1: number;
  mid: Vec2;
  alive: boolean;
  dead?: 'overlap' | 'dangling' | 'bridge';
  edgeId: string;
  fragile: boolean;
}

interface HalfEdge {
  piece: Piece;
  forward: boolean;
  from: number;
  to: number;
  angle: number;
  curvature: number;
}

/** Welds points closer than `tol` into shared vertices. */
class Welder {
  readonly points: Vec2[] = [];
  private readonly grid = new Map<string, number[]>();
  constructor(private readonly tol: number) {}

  add(p: Vec2): number {
    const gx = Math.floor(p[0] / this.tol);
    const gy = Math.floor(p[1] / this.tol);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const i of this.grid.get(`${gx + dx},${gy + dy}`) ?? []) {
          if (dist(this.points[i]!, p) <= this.tol) return i;
        }
      }
    }
    const i = this.points.length;
    this.points.push(p);
    const key = `${gx},${gy}`;
    const cell = this.grid.get(key);
    if (cell) cell.push(i);
    else this.grid.set(key, [i]);
    return i;
  }
}

/**
 * Where each curve is cut: its ends plus every split, deduplicated, in order.
 *
 * Splits closer than `tol` are one cut (and one vertex). When a tangent
 * contact is among them, the cut keeps the contact's parameter for the
 * leaving direction: curves at a tangency leave it in the same direction and
 * are ordered by curvature, but a curve end or a T-junction up to `tol` from
 * the contact is turned by up to about sqrt(2 tol / r), far more than
 * `ANGLE_TOLERANCE`, and would be ordered by that angle instead (on the
 * overshoot side, the wrong way round). An arc that starts where its circle
 * dips 1e-14 mm below a line is already turned by 4.5e-8 rad at r = 10.
 */
function cutsOf(c: Curve, splits: Cut[], tol: number): Cut[] {
  const merge = (sorted: Cut[]): Cut[] => {
    const out: Cut[] = [];
    for (const x of sorted) {
      const last = out[out.length - 1];
      if (!last || x.s - last.s > tol) out.push({ ...x });
      else if (last.contact === undefined && x.contact !== undefined) last.contact = x.contact;
    }
    return out;
  };
  if (c.kind !== 'circle') {
    const inner = merge(
      splits.filter((x) => x.s > tol && x.s < c.length - tol).sort((a, b) => a.s - b.s),
    );
    const contactNear = (s: number) =>
      splits.find((x) => x.contact !== undefined && Math.abs(x.s - s) <= tol)?.contact;
    return [
      { s: 0, point: c.start, contact: contactNear(0) },
      ...inner,
      { s: c.length, point: c.end, contact: contactNear(c.length) },
    ];
  }
  const out = merge(
    splits
      .map((x) => {
        const s = mod(x.s, c.length);
        return {
          s,
          point: x.point,
          contact: x.contact === undefined ? undefined : x.contact - x.s + s,
        };
      })
      .sort((a, b) => a.s - b.s),
  );
  if (out.length > 1 && out[0]!.s + c.length - out[out.length - 1]!.s <= tol) {
    const last = out.pop()!;
    if (out[0]!.contact === undefined && last.contact !== undefined) {
      out[0]!.contact = last.contact - c.length;
    }
  }
  // A circle needs two vertices to be two edges; the extra ones have degree 2
  // and never show in names.
  if (out.length === 0) out.push({ s: 0, point: pointAt(c, 0) });
  if (out.length === 1) {
    const s = mod(out[0]!.s + c.length / 2, c.length);
    out.push({ s, point: pointAt(c, s) });
    out.sort((a, b) => a.s - b.s);
  }
  return out;
}

class UnionFind {
  private readonly parent: number[];
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
  }
  find(i: number): number {
    while (this.parent[i] !== i) {
      this.parent[i] = this.parent[this.parent[i]!]!;
      i = this.parent[i]!;
    }
    return i;
  }
  union(a: number, b: number): void {
    this.parent[this.find(a)] = this.find(b);
  }
}

function halfEdgeOf(p: Piece, forward: boolean): HalfEdge {
  const c = p.curve;
  const t = forward ? tangentAt(c, p.d0) : tangentAt(c, p.d1);
  const dir: Vec2 = forward ? t : [-t[0], -t[1]];
  let angle = Math.atan2(dir[1], dir[0]);
  if (angle > Math.PI - ANGLE_TOLERANCE) angle -= TAU;
  return {
    piece: p,
    forward,
    from: forward ? p.v0 : p.v1,
    to: forward ? p.v1 : p.v0,
    angle,
    // Leaving in the same direction, the curve turning more to the left comes
    // later counter-clockwise.
    curvature: c.kind === 'line' ? 0 : (forward ? 1 : -1) / c.r,
  };
}

/** Traversal-ordered start and end points of a half-edge, on the exact curve. */
function endsOf(h: HalfEdge): [Vec2, Vec2] {
  const a = pointAt(h.piece.curve, h.piece.s0);
  const b = pointAt(h.piece.curve, h.piece.s1);
  return h.forward ? [a, b] : [b, a];
}

/** The integral of (x dy - y dx) / 2 along a half-edge: summed over a loop, its signed area. */
function areaTerm(h: HalfEdge): number {
  const c = h.piece.curve;
  if (c.kind === 'line') {
    const [a, b] = endsOf(h);
    return cross(a, b) / 2;
  }
  let t0 = c.a0 + h.piece.s0 / c.r;
  let t1 = c.a0 + h.piece.s1 / c.r;
  if (!h.forward) [t0, t1] = [t1, t0];
  const [cx, cy] = c.center;
  return (
    (c.r * cx * (Math.sin(t1) - Math.sin(t0)) -
      c.r * cy * (Math.cos(t1) - Math.cos(t0)) +
      c.r * c.r * (t1 - t0)) /
    2
  );
}

/** Winding number of a closed loop of half-edges around `p` (which must not be on it). */
function winding(loop: readonly HalfEdge[], p: Vec2): number {
  let total = 0;
  for (const h of loop) {
    const [a, b] = endsOf(h);
    const u = sub(a, p);
    const v = sub(b, p);
    let delta = Math.atan2(cross(u, v), dot(u, v));
    const c = h.piece.curve;
    if (c.kind !== 'line' && dist(p, c.center) < c.r) {
      // Seen from inside its circle, an arc turns monotonically with its sense.
      const sense = h.forward ? 1 : -1;
      if (delta * sense <= 0) delta += sense * TAU;
    }
    total += delta;
  }
  return Math.round(total / TAU);
}

/** Split a face cycle where it passes through a vertex twice. */
function splitPinches(cycle: readonly HalfEdge[]): HalfEdge[][] {
  const out: HalfEdge[][] = [];
  const stack: HalfEdge[] = [];
  const at = new Map<number, number>();
  for (const h of cycle) {
    const i = at.get(h.from);
    if (i !== undefined) {
      const loop = stack.splice(i);
      for (const e of loop) at.delete(e.from);
      out.push(loop);
    }
    at.set(h.from, stack.length);
    stack.push(h);
  }
  if (stack.length > 0) out.push(stack);
  return out;
}

const loopArea = (loop: readonly HalfEdge[]): number => loop.reduce((a, h) => a + areaTerm(h), 0);

// Detection -------------------------------------------------------------------------

/**
 * Find the regions of a sketch: every closed area its non-construction lines,
 * arcs and circles enclose, split where they cross, with holes and even-odd
 * nesting. Pure; the entities should carry solved coordinates.
 */
export function detectRegions(
  entities: readonly SketchEntity[],
  options: RegionOptions = {},
): SketchRegions {
  const diagnostics: RegionDiagnostic[] = [];
  const candidates = entities.filter(
    (e) => !e.construction && e.kind !== 'point' && e.kind !== 'outline',
  );

  let extent = 0;
  for (const e of candidates) {
    const coords =
      e.kind === 'line'
        ? [...e.start, ...e.end]
        : e.kind === 'circle'
          ? [...e.center, e.radius]
          : e.kind === 'arc'
            ? [...e.center, ...e.start, ...e.end]
            : [];
    for (const v of coords) if (Number.isFinite(v)) extent = Math.max(extent, Math.abs(v));
  }
  // Control points too, as the outline's own flattening does (`outlineRegions`), so the outlines
  // are never flattened here more finely than they were there.
  for (const shape of options.outlines ?? []) {
    for (const c of shape.outer.curves) {
      const coords =
        c.kind === 'bezier'
          ? c.points.flat()
          : c.kind === 'line'
            ? c.start
            : [...c.start, ...c.center, c.radius];
      for (const v of coords) if (Number.isFinite(v)) extent = Math.max(extent, Math.abs(v));
    }
  }
  const tol = options.tolerance ?? RELATIVE_TOLERANCE * Math.max(1, 2 * extent);

  const curves: Curve[] = [];
  for (const e of candidates) {
    const c = makeCurve(e, curves.length, tol);
    if (typeof c === 'string') {
      diagnostics.push({
        code: 'degenerate',
        severity: 'warning',
        message: `Entity '${e.id}' is ignored: ${c}`,
        entityIds: [e.id],
      });
    } else {
      curves.push(c);
    }
  }

  // Split points ----------------------------------------------------------------
  const splits: Cut[][] = curves.map(() => []);
  const crossings = new Map<string, { ids: [string, string]; points: Vec2[] }>();
  for (let i = 0; i < curves.length; i++) {
    const a = curves[i]!;
    for (let j = i + 1; j < curves.length; j++) {
      const b = curves[j]!;
      if (!boxesMeet(a.box, b.box, tol)) continue;
      const points = intersections(a, b, tol);
      // A single point between curves that are not both lines is a tangency: they touch.
      const tangent = points.length === 1 && (a.kind !== 'line' || b.kind !== 'line');
      for (const p of points) {
        const pa = paramOf(a, p, tol);
        const pb = paramOf(b, p, tol);
        if (!pa || !pb || pa.dist > tol || pb.dist > tol) continue;
        if (tangent) {
          splits[i]!.push({ s: pa.s, point: p, contact: unclampedParam(a, p, pa.s) });
          splits[j]!.push({ s: pb.s, point: p, contact: unclampedParam(b, p, pb.s) });
        } else {
          splits[i]!.push({ s: pa.s, point: p });
          splits[j]!.push({ s: pb.s, point: p });
        }
        const interior = (c: Curve, s: number) =>
          c.kind === 'circle' || (s > tol && s < c.length - tol);
        if (!tangent && interior(a, pa.s) && interior(b, pb.s)) {
          const key = `${i},${j}`;
          const entry = crossings.get(key) ?? { ids: [a.id, b.id], points: [] };
          entry.points.push(p);
          crossings.set(key, entry);
        }
      }
    }
  }
  // Endpoints on other curves: T-junctions, and collinear or concentric overlaps.
  for (const b of curves) {
    if (b.kind === 'circle') continue;
    for (const q of [b.start, b.end]) {
      for (const a of curves) {
        if (a === b || !boxesMeet(a.box, [q[0], q[1], q[0], q[1]], tol)) continue;
        const pr = paramOf(a, q, tol);
        if (pr && pr.dist <= tol) splits[a.index]!.push({ s: pr.s, point: q });
      }
    }
  }
  for (const { ids, points } of crossings.values()) {
    diagnostics.push({
      code: 'crossing',
      severity: 'info',
      message: `'${ids[0]}' and '${ids[1]}' cross; the loops are split there`,
      entityIds: [...ids].sort(),
      points,
    });
  }

  // Pieces ------------------------------------------------------------------------
  const welder = new Welder(tol);
  const pieces: Piece[] = [];
  const piecesOf: Piece[][] = curves.map(() => []);
  for (const c of curves) {
    const cuts = cutsOf(c, splits[c.index]!, tol);
    const vs = cuts.map((x) => welder.add(x.point));
    const closed = c.kind === 'circle';
    const count = closed ? cuts.length : cuts.length - 1;
    for (let k = 0; k < count; k++) {
      const s0 = cuts[k]!.s;
      const wraps = k + 1 >= cuts.length;
      const s1 = wraps ? cuts[0]!.s + c.length : cuts[k + 1]!.s;
      const end = cuts[(k + 1) % cuts.length]!;
      const p: Piece = {
        curve: c,
        s0,
        s1,
        d0: cuts[k]!.contact ?? s0,
        d1: end.contact === undefined ? s1 : end.contact + (wraps ? c.length : 0),
        v0: vs[k]!,
        v1: vs[(k + 1) % cuts.length]!,
        mid: pointAt(c, (s0 + s1) / 2),
        alive: true,
        edgeId: c.id,
        fragile: false,
      };
      piecesOf[c.index]!.push(p);
      if (p.v0 === p.v1) {
        // Shorter than the tolerance: its ends are one vertex.
        p.alive = false;
        continue;
      }
      pieces.push(p);
    }
  }

  // Overlaps: pieces with the same ends and the same midpoint are one edge.
  // It belongs to the entity with the smallest id (plain string order), so the
  // edge ids and messages do not depend on the order the entities are listed in.
  const byEnds = new Map<string, Piece[][]>();
  for (const p of pieces) {
    const key = p.v0 < p.v1 ? `${p.v0},${p.v1}` : `${p.v1},${p.v0}`;
    const groups = byEnds.get(key) ?? [];
    const group = groups.find((g) => dist(g[0]!.mid, p.mid) <= 2 * tol);
    if (group) group.push(p);
    else groups.push([p]);
    byEnds.set(key, groups);
  }
  const overlaps = new Map<string, { kept: string; dropped: string }>();
  for (const groups of byEnds.values()) {
    for (const group of groups) {
      if (group.length < 2) continue;
      const keep = group.reduce((best, p) => (p.curve.id < best.curve.id ? p : best));
      for (const p of group) {
        if (p === keep) continue;
        p.alive = false;
        p.dead = 'overlap';
        if (p.curve.id !== keep.curve.id) {
          overlaps.set(`${keep.curve.id}\n${p.curve.id}`, {
            kept: keep.curve.id,
            dropped: p.curve.id,
          });
        }
      }
    }
  }
  const overlapKeys = [...overlaps.keys()].sort();
  for (const { kept, dropped } of overlapKeys.map((k) => overlaps.get(k)!)) {
    diagnostics.push({
      code: 'overlap',
      severity: 'warning',
      message: `'${kept}' and '${dropped}' lie on top of each other; the shared stretch belongs to '${kept}'`,
      entityIds: [kept, dropped].sort(),
    });
  }

  const graph = pieces.filter((p) => p.alive);
  const vertexCount = welder.points.length;
  const initial = new UnionFind(vertexCount);
  for (const p of graph) initial.union(p.v0, p.v1);
  const initialDegree = new Array<number>(vertexCount).fill(0);
  for (const p of graph) {
    initialDegree[p.v0]!++;
    initialDegree[p.v1]!++;
  }

  // Prune dangling edges and bridges, then trace faces ------------------------------
  const incident: Piece[][] = Array.from({ length: vertexCount }, () => []);
  for (const p of graph) {
    incident[p.v0]!.push(p);
    incident[p.v1]!.push(p);
  }
  const degree = [...initialDegree];
  const kill = (p: Piece, why: 'dangling' | 'bridge') => {
    p.alive = false;
    p.dead = why;
    degree[p.v0]!--;
    degree[p.v1]!--;
  };
  const pruneDangling = () => {
    const queue: number[] = [];
    for (let v = 0; v < vertexCount; v++) if (degree[v] === 1) queue.push(v);
    while (queue.length > 0) {
      const v = queue.pop()!;
      if (degree[v] !== 1) continue;
      const p = incident[v]!.find((q) => q.alive)!;
      kill(p, 'dangling');
      const other = p.v0 === v ? p.v1 : p.v0;
      if (degree[other] === 1) queue.push(other);
    }
  };

  let halfEdges: HalfEdge[] = [];
  let cycles: number[][];
  for (;;) {
    pruneDangling();
    const live = graph.filter((p) => p.alive);
    halfEdges = live.flatMap((p) => [halfEdgeOf(p, true), halfEdgeOf(p, false)]);
    const outgoing: number[][] = Array.from({ length: vertexCount }, () => []);
    halfEdges.forEach((h, i) => outgoing[h.from]!.push(i));
    const position = new Array<number>(halfEdges.length).fill(0);
    // Counter-clockwise order around each vertex. Comparing angles with a
    // tolerance inside the sort would not be transitive (a ~ b and b ~ c
    // without a ~ c), so the edges are first sorted by angle, runs of
    // neighbours closer than ANGLE_TOLERANCE become one direction, and edges
    // in the same direction are ordered by curvature.
    const direction = new Array<number>(halfEdges.length).fill(0);
    for (const list of outgoing) {
      list.sort((i, j) => halfEdges[i]!.angle - halfEdges[j]!.angle || i - j);
      list.forEach((h, k) => {
        const prev = list[k - 1];
        direction[h] =
          prev !== undefined && halfEdges[h]!.angle - halfEdges[prev]!.angle <= ANGLE_TOLERANCE
            ? direction[prev]!
            : k;
      });
      list.sort(
        (i, j) =>
          direction[i]! - direction[j]! ||
          halfEdges[i]!.curvature - halfEdges[j]!.curvature ||
          i - j,
      );
      list.forEach((h, k) => (position[h] = k));
    }
    // The next edge of a face (on the left) is the one just clockwise of the twin.
    const next = halfEdges.map((h, i) => {
      const list = outgoing[h.to]!;
      return list[(position[i ^ 1]! - 1 + list.length) % list.length]!;
    });
    const cycleOf = new Array<number>(halfEdges.length).fill(-1);
    cycles = [];
    for (let i = 0; i < halfEdges.length; i++) {
      if (cycleOf[i] !== -1) continue;
      const cycle: number[] = [];
      for (let h = i; cycleOf[h] === -1; h = next[h]!) {
        cycleOf[h] = cycles.length;
        cycle.push(h);
      }
      cycles.push(cycle);
    }
    // A bridge has the same face on both sides and bounds nothing.
    const bridges = live.filter((_, k) => cycleOf[2 * k] === cycleOf[2 * k + 1]);
    if (bridges.length === 0) break;
    for (const p of bridges) kill(p, 'bridge');
  }

  // Edge names ------------------------------------------------------------------------
  for (const c of curves) {
    const alive = piecesOf[c.index]!.filter((p) => p.alive);
    if (alive.length === 0) continue;
    // Consecutive live pieces join where nothing else meets them.
    const joins = (a: Piece, b: Piece) => a.v1 === b.v0 && degree[a.v1] === 2;
    const runs: Piece[][] = [];
    for (const p of alive) {
      const last = runs[runs.length - 1];
      if (last && joins(last[last.length - 1]!, p)) last.push(p);
      else runs.push([p]);
    }
    if (c.kind === 'circle' && runs.length > 1) {
      const last = runs[runs.length - 1]!;
      if (joins(last[last.length - 1]!, runs[0]![0]!)) runs[0] = [...runs.pop()!, ...runs[0]!];
    }
    runs.sort((a, b) => mod(a[0]!.s0, c.length) - mod(b[0]!.s0, c.length));
    runs.forEach((run, k) => {
      for (const p of run) {
        p.edgeId = runs.length === 1 ? c.id : `${c.id}#${k + 1}`;
        p.fragile = runs.length > 1;
      }
    });
  }

  // Unused geometry -------------------------------------------------------------------
  const components = new Map<number, Piece[]>();
  for (const p of graph) {
    const root = initial.find(p.v0);
    const list = components.get(root) ?? [];
    list.push(p);
    components.set(root, list);
  }
  const usedCurves = new Set(graph.filter((p) => p.alive).map((p) => p.curve.index));
  const reported = new Set<number>();
  for (const list of components.values()) {
    if (list.some((p) => p.alive)) continue;
    const ids = [...new Set(list.map((p) => p.curve.id))].sort();
    for (const p of list) reported.add(p.curve.index);
    const ends = [...new Set(list.flatMap((p) => [p.v0, p.v1]))].filter(
      (v) => initialDegree[v] === 1,
    );
    const diagnostic: RegionDiagnostic = {
      code: 'open-profile',
      severity: 'warning',
      message: `${ids.map((id) => `'${id}'`).join(', ')} ${ids.length === 1 ? 'does' : 'do'} not close a loop`,
      entityIds: ids,
    };
    if (ends.length > 0) diagnostic.points = ends.map((v) => welder.points[v]!);
    diagnostics.push(diagnostic);
  }
  for (const c of curves) {
    if (reported.has(c.index)) continue;
    const own = piecesOf[c.index]!;
    const unused = own.filter((p) => p.dead === 'dangling' || p.dead === 'bridge');
    if (unused.length === 0) continue;
    if (!usedCurves.has(c.index)) {
      diagnostics.push({
        code: 'dangling-edge',
        severity: 'warning',
        message: `'${c.id}' bounds no region`,
        entityIds: [c.id],
      });
    } else {
      diagnostics.push({
        code: 'overhang',
        severity: 'info',
        message: `Part of '${c.id}' runs past where it meets other geometry and bounds no region`,
        entityIds: [c.id],
      });
    }
  }

  // Faces and nesting -------------------------------------------------------------------
  const loops = cycles.map((cycle) => cycle.map((i) => halfEdges[i]!));
  const areas = loops.map(loopArea);
  const found = new UnionFind(vertexCount);
  for (const h of halfEdges) found.union(h.from, h.to);
  const componentOf = loops.map((loop) => found.find(loop[0]!.from));
  const outlineOf = new Map<number, number>();
  const bounded: number[] = [];
  loops.forEach((_, i) => {
    if (areas[i]! > 0) bounded.push(i);
    else if (!outlineOf.has(componentOf[i]!)) outlineOf.set(componentOf[i]!, i);
  });
  // The face each component sits in: the smallest bounded face of another
  // component that contains it.
  const parentOf = new Map<number, number | null>();
  for (const [comp, outline] of outlineOf) {
    const h = loops[outline]![0]!;
    const probe = pointAt(h.piece.curve, (h.piece.s0 + h.piece.s1) / 2);
    let best: number | null = null;
    for (const f of bounded) {
      if (componentOf[f] === comp) continue;
      if (best !== null && areas[f]! >= areas[best]!) continue;
      if (winding(loops[f]!, probe) !== 0) best = f;
    }
    parentOf.set(comp, best);
  }
  const depthMemo = new Map<number, number>();
  const depthOf = (comp: number): number => {
    const known = depthMemo.get(comp);
    if (known !== undefined) return known;
    const parent = parentOf.get(comp) ?? null;
    const d = parent === null ? 0 : depthOf(componentOf[parent]!) + 1;
    depthMemo.set(comp, d);
    return d;
  };

  const vertexPoint = (v: number) => welder.points[v]!;
  const toLoop = (hs: readonly HalfEdge[]): RegionLoop => {
    const n = hs.length;
    let first = 0;
    if (!hs.every((h) => h.piece.edgeId === hs[0]!.piece.edgeId)) {
      while (hs[first]!.piece.edgeId === hs[(first - 1 + n) % n]!.piece.edgeId) first++;
    } else {
      // One closed curve: start where it meets other geometry, if it does.
      first = Math.max(
        0,
        hs.findIndex((h) => degree[h.from]! > 2),
      );
    }
    const curves: RegionCurve[] = [];
    let group: HalfEdge[] = [];
    const flush = () => {
      const a = group[0]!;
      const b = group[group.length - 1]!;
      const c = a.piece.curve;
      const info: RegionEdgeInfo = {
        edgeId: a.piece.edgeId,
        entityId: c.id,
        fragile: a.piece.fragile,
        reversed: !a.forward,
      };
      const start = vertexPoint(a.from);
      const end = vertexPoint(b.to);
      if (c.kind === 'line') curves.push({ ...info, kind: 'line', start, end });
      else if (a.from === b.to) {
        curves.push({ ...info, kind: 'circle', center: c.center, radius: c.r, start });
      } else curves.push({ ...info, kind: 'arc', center: c.center, radius: c.r, start, end });
      group = [];
    };
    for (let k = 0; k < n; k++) {
      const h = hs[(first + k) % n]!;
      if (group.length > 0 && group[0]!.piece.edgeId !== h.piece.edgeId) flush();
      group.push(h);
    }
    flush();
    return { curves, area: loopArea(hs) };
  };

  interface Draft {
    key: string;
    region: Omit<Region, 'id' | 'fragile'>;
    probe: Vec2;
  }
  const drafts: Draft[] = [];
  const touching = (loopsOf: HalfEdge[][], why: string) => {
    const ids = [...new Set(loopsOf.flat().map((h) => h.piece.curve.id))].sort();
    const seen = new Map<number, number>();
    for (const h of loopsOf.flat()) seen.set(h.from, (seen.get(h.from) ?? 0) + 1);
    diagnostics.push({
      code: 'touching',
      severity: 'warning',
      message: `${why}; the kernel may not accept this profile`,
      entityIds: ids,
      points: [...seen].filter(([, n]) => n > 1).map(([v]) => vertexPoint(v)),
    });
  };
  for (const f of bounded) {
    const subs = splitPinches(loops[f]!);
    const outerIndex = subs.reduce(
      (best, s, i) => (loopArea(s) > loopArea(subs[best]!) ? i : best),
      0,
    );
    const outer = subs[outerIndex]!;
    const holeLoops = subs.filter((_, i) => i !== outerIndex);
    if (holeLoops.length > 0) touching(subs, 'A loop touches itself or a hole at a single point');
    for (const [comp, parent] of parentOf) {
      if (parent !== f) continue;
      const parts = splitPinches(loops[outlineOf.get(comp)!]!);
      if (parts.length > 1) touching(parts, 'Loops inside a region touch at a single point');
      holeLoops.push(...parts);
    }
    const sides = new Map<string, Set<'L' | 'R'>>();
    for (const h of outer) {
      const set = sides.get(h.piece.curve.id) ?? new Set();
      set.add(h.forward ? 'L' : 'R');
      sides.set(h.piece.curve.id, set);
    }
    const key = [...sides.keys()]
      .sort()
      .map(
        (id) => `${id}/${sides.get(id)!.has('L') ? 'L' : ''}${sides.get(id)!.has('R') ? 'R' : ''}`,
      )
      .join('+');
    const outerLoop = toLoop(outer);
    const holes = holeLoops.map(toLoop);
    const all = [outer, ...holeLoops].flat();
    let sx = 0;
    let sy = 0;
    for (const h of outer) {
      sx += vertexPoint(h.from)[0];
      sy += vertexPoint(h.from)[1];
    }
    drafts.push({
      key,
      probe: [sx / outer.length, sy / outer.length],
      region: {
        outer: outerLoop,
        holes,
        area: outerLoop.area - holes.reduce((a, l) => a + Math.abs(l.area), 0),
        depth: depthOf(componentOf[f]!),
        entityIds: [...new Set(all.map((h) => h.piece.curve.id))].sort(),
      },
    });
  }

  // Ids, with positional numbering where two faces still collide.
  const byKey = new Map<string, Draft[]>();
  for (const d of drafts) byKey.set(d.key, [...(byKey.get(d.key) ?? []), d]);
  const regions: Region[] = [];
  const voids: Region[] = [];
  for (const [key, same] of byKey) {
    if (same.length > 1) {
      // By position: x, then y (T0.5's order for positional pieces).
      same.sort((a, b) =>
        Math.abs(a.probe[0] - b.probe[0]) > tol ? a.probe[0] - b.probe[0] : a.probe[1] - b.probe[1],
      );
      diagnostics.push({
        code: 'ambiguous-id',
        severity: 'info',
        message: `${same.length} faces are bounded by the same entities on the same sides; they are numbered by position (${key}#1, ...)`,
        entityIds: [...new Set(same.flatMap((d) => d.region.entityIds))].sort(),
      });
    }
    same.forEach((d, k) => {
      const region: Region = {
        id: same.length > 1 ? `${key}#${k + 1}` : key,
        fragile: same.length > 1,
        ...d.region,
      };
      (region.depth % 2 === 0 ? regions : voids).push(region);
    });
  }
  if (options.outlines && options.outlines.length > 0) {
    addOutlines(
      options.outlines,
      regions,
      voids,
      diagnostics,
      Math.max(tol, extent * 1e-5),
      options.outlineWork ?? MAX_OUTLINE_PLACEMENT_WORK,
      options.outlinePoints ?? MAX_OUTLINE_POLYGON_POINTS,
    );
  }
  const byId = (a: Region, b: Region) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  regions.sort(byId);
  voids.sort(byId);
  return { regions, voids, diagnostics, tolerance: tol };
}

// Outlines ----------------------------------------------------------------------------

/** Chords per Bezier so that none is further than `deflection` from the curve (at most 256). */
function bezierChords(points: readonly Vec2[], deflection: number): number {
  const degree = points.length - 1;
  if (degree < 2) return 1;
  let d = 0;
  for (let i = 0; i + 2 < points.length; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    const c = points[i + 2]!;
    d = Math.max(d, Math.hypot(a[0] - 2 * b[0] + c[0], a[1] - 2 * b[1] + c[1]));
  }
  const n = Math.ceil(Math.sqrt((degree * (degree - 1) * d) / (8 * deflection)));
  return Math.min(256, Math.max(1, n));
}

/** How an arc or circle is flattened: its start angle, signed sweep and chord count. */
function arcChords(
  c: Extract<RegionCurve, { kind: 'arc' | 'circle' }>,
  deflection: number,
): { a0: number; sweep: number; n: number } {
  const sense = c.reversed ? -1 : 1;
  const a0 = Math.atan2(c.start[1] - c.center[1], c.start[0] - c.center[0]);
  let sweep = TAU;
  if (c.kind === 'arc') {
    const a1 = Math.atan2(c.end[1] - c.center[1], c.end[0] - c.center[0]);
    sweep = mod((a1 - a0) * sense, TAU) || TAU;
  }
  const step = deflection < c.radius ? 2 * Math.acos(1 - deflection / c.radius) : Math.PI / 2;
  const n = Math.min(1024, Math.max(2, Math.ceil(sweep / Math.max(step, 1e-3))));
  return { a0, sweep: sense * sweep, n };
}

/** How many points `loopPolygon` makes of a loop, counted without making them. */
export function loopPolygonSize(loop: RegionLoop, deflection: number): number {
  let size = 0;
  for (const c of loop.curves) {
    if (c.kind === 'line') size += 1;
    else if (c.kind === 'bezier') size += bezierChords(c.points, deflection);
    else size += arcChords(c, deflection).n;
  }
  return size;
}

/**
 * A region loop as a closed polygon (the last point joins the first), every curve flattened to
 * chords no further than `deflection` from it. For containment and crossing tests, and drawing.
 * `loopPolygonSize` says how many points it makes.
 */
export function loopPolygon(loop: RegionLoop, deflection: number): Vec2[] {
  const out: Vec2[] = [];
  for (const c of loop.curves) {
    if (c.kind === 'line') {
      out.push(c.start);
    } else if (c.kind === 'bezier') {
      const n = bezierChords(c.points, deflection);
      for (let k = 0; k < n; k++) out.push(bezierPoint(c.points, k / n));
    } else {
      const { a0, sweep, n } = arcChords(c, deflection);
      for (let k = 0; k < n; k++) {
        const a = a0 + (sweep * k) / n;
        out.push([c.center[0] + c.radius * Math.cos(a), c.center[1] + c.radius * Math.sin(a)]);
      }
    }
  }
  return out;
}

type Box = readonly [number, number, number, number];

function polygonBox(polygon: readonly Vec2[]): Box {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of polygon) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  return [x0, y0, x1, y1];
}

/** Whether `p` is inside a closed polygon (nonzero winding; points on it count as either). */
function insidePolygon(polygon: readonly Vec2[], p: Vec2): boolean {
  let w = 0;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i]!;
    const b = polygon[(i + 1) % polygon.length]!;
    const side = cross(sub(b, a), sub(p, a));
    if (a[1] <= p[1]) {
      if (b[1] > p[1] && side > 0) w++;
    } else if (b[1] <= p[1] && side < 0) {
      w--;
    }
  }
  return w !== 0;
}

/** Whether two segments come within `tol` of each other. */
function segmentsMeet(a0: Vec2, a1: Vec2, b0: Vec2, b1: Vec2, tol: number): boolean {
  const near = (p: Vec2, s0: Vec2, s1: Vec2) => {
    const d = sub(s1, s0);
    const len2 = dot(d, d);
    const t = len2 === 0 ? 0 : Math.min(1, Math.max(0, dot(sub(p, s0), d) / len2));
    return dist(p, [s0[0] + t * d[0], s0[1] + t * d[1]]) <= tol;
  };
  const o1 = cross(sub(a1, a0), sub(b0, a0));
  const o2 = cross(sub(a1, a0), sub(b1, a0));
  const o3 = cross(sub(b1, b0), sub(a0, b0));
  const o4 = cross(sub(b1, b0), sub(a1, b0));
  if (((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0))) {
    return true;
  }
  return near(a0, b0, b1) || near(a1, b0, b1) || near(b0, a0, a1) || near(b1, a0, a1);
}

/**
 * Elementary steps `detectRegions` may spend joining outlines to the sketch's faces: a polygon
 * vertex flattened or visited by a winding count, a segment pair tested, a grid cell filled, a
 * pair of shapes or boxes compared. Past it, every outline is kept as it is with an
 * `outline-overlap` warning (see `addOutlines`). Ten thousand characters of Inter Bold in a plate
 * (12k loops) spend under two million; running the whole budget out takes about 0.6 s.
 */
export const MAX_OUTLINE_PLACEMENT_WORK = 100_000_000;

/**
 * Most polygon points `addOutlines` may make flattening the faces' loops and the outlines (about
 * 64 bytes each, so a few hundred megabytes at most). Past it, as past the work budget, every
 * outline is kept as it is with an `outline-overlap` warning. Ten thousand characters of Inter
 * Bold make well under a million.
 */
export const MAX_OUTLINE_POLYGON_POINTS = 4_000_000;

/** Thrown when `addOutlines` runs out of its work budget. */
class OutOfWork extends Error {}

/** What `addOutlines` may still spend. */
class Work {
  left: number;
  constructor(budget: number) {
    this.left = budget;
  }
  spend(steps: number): void {
    this.left -= steps;
    if (this.left < 0) throw new OutOfWork('out of work');
  }
}

/** Pairs below this many segment tests are tested directly; above it, through a grid. */
const DIRECT_PAIRS = 4096;
/** Most cells of one grid (a grid keeps only the cells something lies in). */
const MAX_GRID_CELLS = 1 << 20;

/** Whether the outlines of two closed polygons cross or touch (within `tol`). */
function polygonsMeet(
  a: readonly Vec2[],
  b: readonly Vec2[],
  tol: number,
  work: Work,
  aBox: Box = polygonBox(a),
  bBox: Box = polygonBox(b),
): boolean {
  const n = a.length;
  const m = b.length;
  if (n * m <= DIRECT_PAIRS) {
    work.spend(n * m);
    for (let i = 0; i < n; i++) {
      const a0 = a[i]!;
      const a1 = a[(i + 1) % n]!;
      for (let j = 0; j < m; j++) {
        if (segmentsNear(a0, a1, b[j]!, b[(j + 1) % m]!, tol)) return true;
      }
    }
    return false;
  }
  // Only segments in the overlap of the two boxes can meet: index b's there on a grid and look
  // a's up in it, so two large outlines whose boxes overlap cost what lies near each other.
  const x0 = Math.max(aBox[0], bBox[0]) - tol;
  const y0 = Math.max(aBox[1], bBox[1]) - tol;
  const x1 = Math.min(aBox[2], bBox[2]) + tol;
  const y1 = Math.min(aBox[3], bBox[3]) + tol;
  if (x0 > x1 || y0 > y1) return false;
  const segBox = (p: readonly Vec2[], i: number): Box => {
    const s0 = p[i]!;
    const s1 = p[(i + 1) % p.length]!;
    return [
      Math.min(s0[0], s1[0]),
      Math.min(s0[1], s1[1]),
      Math.max(s0[0], s1[0]),
      Math.max(s0[1], s1[1]),
    ];
  };
  const inOverlap = (box: Box) => box[0] <= x1 && box[2] >= x0 && box[1] <= y1 && box[3] >= y0;
  work.spend(n + m);
  const bs: number[] = [];
  for (let j = 0; j < m; j++) if (inOverlap(segBox(b, j))) bs.push(j);
  if (bs.length === 0) return false;
  const as: number[] = [];
  for (let i = 0; i < n; i++) if (inOverlap(segBox(a, i))) as.push(i);
  if (as.length === 0) return false;
  const w = Math.max(x1 - x0, Number.MIN_VALUE);
  const h = Math.max(y1 - y0, Number.MIN_VALUE);
  const [cols, rows] = gridSize(Math.max(as.length, bs.length), w, h);
  const col = (x: number) => Math.min(cols - 1, Math.max(0, Math.floor(((x - x0) / w) * cols)));
  const row = (y: number) => Math.min(rows - 1, Math.max(0, Math.floor(((y - y0) / h) * rows)));
  const cells = new Map<number, number[]>();
  for (const j of bs) {
    const box = segBox(b, j);
    const c0 = col(box[0] - tol);
    const c1 = col(box[2] + tol);
    const r0 = row(box[1] - tol);
    const r1 = row(box[3] + tol);
    work.spend((c1 - c0 + 1) * (r1 - r0 + 1));
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const k = r * cols + c;
        const list = cells.get(k);
        if (list) list.push(j);
        else cells.set(k, [j]);
      }
    }
  }
  // Each pair is tested once, however many cells the two share.
  const seen = new Int32Array(m).fill(-1);
  for (const i of as) {
    const box = segBox(a, i);
    const a0 = a[i]!;
    const a1 = a[(i + 1) % n]!;
    const c0 = col(box[0]);
    const c1 = col(box[2]);
    const r0 = row(box[1]);
    const r1 = row(box[3]);
    work.spend((c1 - c0 + 1) * (r1 - r0 + 1));
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const list = cells.get(r * cols + c);
        if (!list) continue;
        work.spend(list.length);
        for (const j of list) {
          if (seen[j] === i) continue;
          seen[j] = i;
          if (segmentsNear(a0, a1, b[j]!, b[(j + 1) % m]!, tol)) return true;
        }
      }
    }
  }
  return false;
}

/** `segmentsMeet` after a box test of the two segments. */
function segmentsNear(a0: Vec2, a1: Vec2, b0: Vec2, b1: Vec2, tol: number): boolean {
  if (Math.max(b0[0], b1[0]) < Math.min(a0[0], a1[0]) - tol) return false;
  if (Math.min(b0[0], b1[0]) > Math.max(a0[0], a1[0]) + tol) return false;
  if (Math.max(b0[1], b1[1]) < Math.min(a0[1], a1[1]) - tol) return false;
  if (Math.min(b0[1], b1[1]) > Math.max(a0[1], a1[1]) + tol) return false;
  return segmentsMeet(a0, a1, b0, b1, tol);
}

const insidePoint = (box: Box, p: Vec2) =>
  p[0] >= box[0] && p[0] <= box[2] && p[1] >= box[1] && p[1] <= box[3];

const boxMeets = (a: Box, b: Box, tol: number) =>
  a[0] <= b[2] + tol && b[0] <= a[2] + tol && a[1] <= b[3] + tol && b[1] <= a[3] + tol;

/** A loop run the other way round: curves in reverse order, each reversed. */
function reverseLoop(loop: RegionLoop): RegionLoop {
  const curves = [...loop.curves].reverse().map((c): RegionCurve => {
    const reversed = !c.reversed;
    switch (c.kind) {
      case 'line':
        return { ...c, reversed, start: c.end, end: c.start };
      case 'bezier':
        return { ...c, reversed, points: [...c.points].reverse(), start: c.end, end: c.start };
      case 'arc':
        return { ...c, reversed, start: c.end, end: c.start };
      case 'circle':
        return { ...c, reversed };
    }
  });
  return { curves, area: -loop.area };
}

/**
 * Grid columns and rows for about `count` items over a `w` by `h` area: about `count` cells in
 * all, shaped like the area, so a long line of text gets a long row of cells.
 */
function gridSize(count: number, w: number, h: number): [number, number] {
  const n = Math.max(1, Math.min(count, MAX_GRID_CELLS));
  const aspect = w > 0 && h > 0 ? w / h : 1;
  const clamp = (v: number) => Math.min(n, Math.max(1, Math.ceil(v)));
  return [clamp(Math.sqrt(n * aspect)), clamp(Math.sqrt(n / aspect))];
}

/** A bounding box of a loop from its curves' ends, control points and arc circles (no flattening). */
function loopBox(loop: RegionLoop): Box {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const add = (p: Vec2, r = 0) => {
    x0 = Math.min(x0, p[0] - r);
    y0 = Math.min(y0, p[1] - r);
    x1 = Math.max(x1, p[0] + r);
    y1 = Math.max(y1, p[1] + r);
  };
  for (const c of loop.curves) {
    if (c.kind === 'line') {
      add(c.start);
      add(c.end);
    } else if (c.kind === 'bezier') {
      for (const p of c.points) add(p);
    } else {
      add(c.center, c.radius);
    }
  }
  return [x0, y0, x1, y1];
}

const unionBox = (a: Box, b: Box): Box => [
  Math.min(a[0], b[0]),
  Math.min(a[1], b[1]),
  Math.max(a[2], b[2]),
  Math.max(a[3], b[3]),
];

/**
 * Boxes on a grid, for "which boxes hold this point". A box over more than `WIDE_CELLS` cells
 * goes on a list every query reads instead.
 */
class BoxGrid {
  readonly #cells = new Map<number, number[]>();
  readonly #wide: number[] = [];
  readonly #bounds: Box;
  readonly #cols: number;
  readonly #rows: number;

  constructor(boxes: readonly Box[], work: Work) {
    let bounds: Box = [Infinity, Infinity, -Infinity, -Infinity];
    for (const b of boxes) bounds = unionBox(bounds, b);
    this.#bounds = bounds;
    [this.#cols, this.#rows] = gridSize(boxes.length, bounds[2] - bounds[0], bounds[3] - bounds[1]);
    work.spend(boxes.length);
    boxes.forEach((b, i) => {
      const c0 = this.#col(b[0]);
      const c1 = this.#col(b[2]);
      const r0 = this.#row(b[1]);
      const r1 = this.#row(b[3]);
      const count = (c1 - c0 + 1) * (r1 - r0 + 1);
      if (count > WIDE_CELLS) {
        this.#wide.push(i);
        return;
      }
      work.spend(count);
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          const k = r * this.#cols + c;
          const list = this.#cells.get(k);
          if (list) list.push(i);
          else this.#cells.set(k, [i]);
        }
      }
    });
  }

  #col(x: number): number {
    const w = this.#bounds[2] - this.#bounds[0];
    if (!(w > 0)) return 0;
    return Math.min(
      this.#cols - 1,
      Math.max(0, Math.floor(((x - this.#bounds[0]) / w) * this.#cols)),
    );
  }

  #row(y: number): number {
    const h = this.#bounds[3] - this.#bounds[1];
    if (!(h > 0)) return 0;
    return Math.min(
      this.#rows - 1,
      Math.max(0, Math.floor(((y - this.#bounds[1]) / h) * this.#rows)),
    );
  }

  /** Indices of the boxes that may hold `p` (a superset), each once. */
  near(p: Vec2, work: Work): readonly number[] {
    const list = this.#cells.get(this.#row(p[1]) * this.#cols + this.#col(p[0])) ?? [];
    work.spend(list.length + this.#wide.length);
    return this.#wide.length === 0 ? list : [...list, ...this.#wide];
  }
}

/** Cells a box may cover in a `BoxGrid` before it goes on the list every query reads. */
const WIDE_CELLS = 64;

/**
 * Adds the regions of outline entities to the faces of the planar graph. An outline that lies
 * cleanly inside a face (crossing none of its loops, enclosing no other geometry, overlapping no
 * other outline) cuts a hole of its shape in that face, and each of its counters becomes a face
 * of the same kind (region or void), selected with that face's entities. An outline that
 * crosses or encloses other geometry is kept as it is, with an `outline-overlap` warning. Every
 * outline region is a region.
 *
 * The tests are bounded: outlines are compared with other entities' outlines only where their
 * boxes meet (a sweep by x), segments of two outlines only where they lie near each other (a
 * grid), and the work as a whole by `budget` (`MAX_OUTLINE_PLACEMENT_WORK`). When the budget runs
 * out, no outline cuts a hole and every outline entity gets an `outline-overlap` warning naming
 * what its box meets: the result is the one an overlapping text gets, never a wrong hole.
 */
function addOutlines(
  shapes: readonly OutlineShape[],
  regions: Region[],
  voids: Region[],
  diagnostics: RegionDiagnostic[],
  deflection: number,
  budget: number,
  maxPoints: number = MAX_OUTLINE_POLYGON_POINTS,
): void {
  const tol = deflection;
  const work = new Work(budget);
  /** Where an outline may cut its hole: a face of the graph, or a counter of another outline. */
  type Host = { region: Region; filled: boolean };
  type Face = Host & {
    outer: Vec2[];
    box: Box;
    holes: Vec2[][];
    holeBoxes: Box[];
  };
  const shapeArea = (i: number) => Math.abs(shapes[i]!.outer.area);
  const inside = (polygon: readonly Vec2[], p: Vec2) => {
    work.spend(polygon.length);
    return insidePolygon(polygon, p);
  };

  // Every outline entity, in order of first appearance, with the box of its shapes.
  const entityOrder: string[] = [];
  const entityBox = new Map<string, Box>();
  for (const shape of shapes) {
    const box = loopBox(shape.outer);
    const known = entityBox.get(shape.entityId);
    if (!known) entityOrder.push(shape.entityId);
    entityBox.set(shape.entityId, known ? unionBox(known, box) : box);
  }

  const meets = new Map<number, Set<string>>();
  const mark = (i: number, ids: Iterable<string>) => {
    const set = meets.get(i) ?? new Set<string>();
    for (const id of ids) set.add(id);
    meets.set(i, set);
  };
  let faces: Face[] = [];
  // Per shape, the faces it may cut a hole in, and the innermost other shape whose outer loop
  // holds its first point with the counter (hole index) of that shape it lies in, or -1 when it
  // lies in no counter. An outline in another's counter cuts no hole in the face that one went
  // into, but cuts one in that counter.
  const candidates: Face[][] = shapes.map(() => []);
  const container: ({ shape: number; counter: number } | null)[] = shapes.map(() => null);
  let exhausted = false;
  try {
    // Counted (and paid for) before it is made: a text of many finely flattened Beziers must run
    // out of work or points, not out of memory.
    let points = 0;
    const flatten = (loop: RegionLoop) => {
      const size = loopPolygonSize(loop, deflection);
      work.spend(size);
      points += size;
      if (points > maxPoints) throw new OutOfWork('too many points');
      return loopPolygon(loop, deflection);
    };
    faces = [
      ...regions.map((r) => ({ r, filled: true })),
      ...voids.map((r) => ({ r, filled: false })),
    ].map(({ r, filled }) => {
      const outer = flatten(r.outer);
      const holes = r.holes.map(flatten);
      return {
        region: r,
        filled,
        outer,
        box: polygonBox(outer),
        holes,
        holeBoxes: holes.map(polygonBox),
      };
    });
    const graphLoops = faces.flatMap((f) => [
      { polygon: f.outer, box: f.box, loop: f.region.outer },
      ...f.holes.map((polygon, k) => ({
        polygon,
        box: f.holeBoxes[k]!,
        loop: f.region.holes[k]!,
      })),
    ]);
    const placed = shapes.map((shape) => {
      const outer = flatten(shape.outer);
      return { shape, outer, box: polygonBox(outer) };
    });
    const counterPolygons = new Map<string, Vec2[]>();
    const counterPolygon = (j: number, k: number) => {
      const key = `${j}/${k}`;
      let polygon = counterPolygons.get(key);
      if (!polygon) {
        polygon = flatten(shapes[j]!.holes[k]!);
        counterPolygons.set(key, polygon);
      }
      return polygon;
    };

    // Outlines in the way of the sketch's own geometry.
    placed.forEach((s, i) => {
      for (const g of graphLoops) {
        work.spend(1);
        if (!boxMeets(s.box, g.box, tol)) continue;
        if (
          polygonsMeet(s.outer, g.polygon, tol, work, s.box, g.box) ||
          inside(s.outer, g.polygon[0]!)
        ) {
          mark(
            i,
            g.loop.curves.map((c) => c.entityId),
          );
        }
      }
    });

    // Outlines of different entities in each other's way: a sweep by x over each pair of
    // entities whose boxes meet, comparing a shape with the other entity's shapes it overlaps.
    const byEntity = new Map<string, number[]>();
    placed.forEach((s, i) => {
      const list = byEntity.get(s.shape.entityId);
      if (list) list.push(i);
      else byEntity.set(s.shape.entityId, [i]);
    });
    const left = (i: number) => placed[i]!.box[0];
    for (const list of byEntity.values()) {
      work.spend(list.length);
      list.sort((a, b) => left(a) - left(b) || a - b);
    }
    const pair = (i: number, j: number) => {
      const a = placed[i]!;
      const b = placed[j]!;
      if (
        polygonsMeet(a.outer, b.outer, tol, work, a.box, b.box) ||
        inside(a.outer, b.outer[0]!) ||
        inside(b.outer, a.outer[0]!)
      ) {
        mark(i, [b.shape.entityId]);
        mark(j, [a.shape.entityId]);
      }
    };
    for (let p = 0; p < entityOrder.length; p++) {
      for (let q = p + 1; q < entityOrder.length; q++) {
        work.spend(1);
        const ea = entityOrder[p]!;
        const eb = entityOrder[q]!;
        if (!boxMeets(entityBox.get(ea)!, entityBox.get(eb)!, tol)) continue;
        const lists = [byEntity.get(ea)!, byEntity.get(eb)!];
        const at = [0, 0];
        const active: number[][] = [[], []];
        while (at[0]! < lists[0]!.length || at[1]! < lists[1]!.length) {
          const side =
            at[1]! >= lists[1]!.length ||
            (at[0]! < lists[0]!.length && left(lists[0]![at[0]!]!) <= left(lists[1]![at[1]!]!))
              ? 0
              : 1;
          const i = lists[side]![at[side]!++]!;
          const box = placed[i]!.box;
          const other = 1 - side;
          work.spend(active[other]!.length + 1);
          active[other] = active[other]!.filter((j) => placed[j]!.box[2] + tol >= box[0]);
          for (const j of active[other]!) {
            const jb = placed[j]!.box;
            if (jb[3] < box[1] - tol || jb[1] > box[3] + tol) continue;
            pair(i, j);
          }
          active[side]!.push(i);
        }
      }
    }

    // Where each outline that is in nobody's way would cut its hole.
    const grid = new BoxGrid(
      placed.map((s) => s.box),
      work,
    );
    placed.forEach((s, i) => {
      if (meets.has(i)) return;
      const probe = s.outer[0]!;
      for (const f of faces) {
        work.spend(1);
        if (!insidePoint(f.box, probe) || !inside(f.outer, probe)) continue;
        let inHole = false;
        for (let k = 0; k < f.holes.length && !inHole; k++) {
          work.spend(1);
          inHole = insidePoint(f.holeBoxes[k]!, probe) && inside(f.holes[k]!, probe);
        }
        if (!inHole) candidates[i]!.push(f);
      }
      if (candidates[i]!.length === 0) return;
      // Every other shape, earlier or later: the outer loops of one text nest (its glyphs do not
      // cross), so the innermost one holding the probe is the one with the smallest area.
      let innermost = -1;
      for (const j of grid.near(probe, work)) {
        if (j === i || meets.has(j) || !insidePoint(placed[j]!.box, probe)) continue;
        if (innermost >= 0 && shapeArea(j) >= shapeArea(innermost)) continue;
        if (inside(placed[j]!.outer, probe)) innermost = j;
      }
      if (innermost < 0) return;
      let counter = -1;
      const holes = shapes[innermost]!.holes;
      for (let k = 0; k < holes.length && counter < 0; k++) {
        if (inside(counterPolygon(innermost, k), probe)) counter = k;
      }
      container[i] = { shape: innermost, counter };
    });
  } catch (error) {
    if (!(error instanceof OutOfWork)) throw error;
    exhausted = true;
  }

  if (exhausted) {
    // Every outline is kept as it is; each entity is reported with what its box meets.
    const graphBoxes = [...regions, ...voids].flatMap((r) =>
      [r.outer, ...r.holes].map((loop) => ({ box: loopBox(loop), loop })),
    );
    for (const id of [...entityOrder].sort()) {
      const box = entityBox.get(id)!;
      const others = new Set<string>();
      for (const other of entityOrder) {
        if (other !== id && boxMeets(box, entityBox.get(other)!, tol)) others.add(other);
      }
      for (const g of graphBoxes) {
        if (!boxMeets(box, g.box, tol)) continue;
        for (const c of g.loop.curves) if (c.entityId !== id) others.add(c.entityId);
      }
      const named = [...others].sort();
      diagnostics.push({
        code: 'outline-overlap',
        severity: 'warning',
        message:
          named.length > 0
            ? `'${id}' is too complex to check against ${named.map((o) => `'${o}'`).join(', ')}; its regions overlap them and cut no hole in the face around them`
            : `'${id}' is too complex to place in the sketch's faces; its regions cut no hole in the face around them`,
        entityIds: [id, ...named].sort(),
      });
    }
  } else {
    const byEntity = new Map<string, Set<string>>();
    for (const [i, ids] of meets) {
      const id = shapes[i]!.entityId;
      const set = byEntity.get(id) ?? new Set<string>();
      for (const other of ids) if (other !== id) set.add(other);
      byEntity.set(id, set);
    }
    for (const id of [...byEntity.keys()].sort()) {
      const others = [...byEntity.get(id)!].sort();
      diagnostics.push({
        code: 'outline-overlap',
        severity: 'warning',
        message: `'${id}' crosses or encloses ${others.map((o) => `'${o}'`).join(', ')}; its regions that do overlap them and cut no hole in the face around them`,
        entityIds: [id, ...others].sort(),
      });
    }
  }

  // Hosts are chosen outermost first, so a shape's container has its host (and counters) when
  // the shape comes to choose: by outer area, largest first (a container is larger than what it
  // holds), then by order.
  const hosts: (Host | null)[] = shapes.map(() => null);
  const counters: Host[][] = shapes.map(() => []);
  const order = shapes.map((_, i) => i);
  order.sort((a, b) => shapeArea(b) - shapeArea(a) || a - b);
  for (const i of order) {
    const shape = shapes[i]!;
    const holes = shape.holes.map(({ curves, area }) => ({ curves, area }));
    let face: Host | null = null;
    if (!exhausted && !meets.has(i)) {
      const within = container[i];
      if (within && hosts[within.shape]) {
        // In a counter of an outline that cut its hole: a hole in that counter, if it lies in one.
        face = within.counter >= 0 ? (counters[within.shape]![within.counter] ?? null) : null;
      } else {
        // Not in the faces any outline around it went into (whose hole it lies in).
        const taken = new Set<Host>();
        let w = within;
        for (let n = 0; w && n < shapes.length; n++, w = container[w.shape]) {
          const h = hosts[w.shape];
          if (h) taken.add(h);
        }
        for (const f of candidates[i]!) {
          if (taken.has(f)) continue;
          if (face !== null && Math.abs(f.region.area) >= Math.abs(face.region.area)) continue;
          face = f;
        }
      }
    }
    hosts[i] = face;
    const holeArea = holes.reduce((a, h) => a + Math.abs(h.area), 0);
    regions.push({
      id: shape.key,
      fragile: shape.fragile,
      outer: shape.outer,
      holes,
      area: shape.outer.area - holeArea,
      depth: face ? face.region.depth + 1 : 0,
      entityIds: [shape.entityId],
    });
    if (!face) continue;
    const host = face.region;
    host.holes.push(reverseLoop(shape.outer));
    host.area -= Math.abs(shape.outer.area);
    if (!host.entityIds.includes(shape.entityId))
      host.entityIds = [...host.entityIds, shape.entityId].sort();
    const selectedWith =
      host.selectedWith ?? [...new Set(host.outer.curves.map((c) => c.entityId))].sort();
    for (const hole of shape.holes) {
      const counter: Region = {
        id: `${hole.key}/counter`,
        fragile: shape.fragile,
        outer: reverseLoop(hole),
        holes: [],
        area: Math.abs(hole.area),
        depth: host.depth + 2,
        entityIds: [shape.entityId],
        selectedWith,
      };
      (face.filled ? regions : voids).push(counter);
      counters[i]!.push({ region: counter, filled: face.filled });
    }
  }
}
