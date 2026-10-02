// Arc refit: turn Clipper's offset polylines back into lines and arcs (T5.0a spike, "Arc refit";
// ADR 0014 decision 12).
//
// Tagged first. Every output point carries the Z tag of the source vertex it was offset from
// (see flatten.ts and the adapter's Z callback). A polyline segment whose two ends come from the
// same source arc lies on that arc's concentric offset (radius r + d or r - d); one whose two ends
// come from the same sharp corner lies on the round join about it (radius |d|). Consecutive
// segments on one circle become one arc on that exact circle, ends projected onto it. What the
// tags do not explain goes through the untagged fit: greedy runs held by one circle (through the
// run's first, middle and last point) or one line, within the refit tolerance.
//
// Then: adjacent arcs meet at their circles' intersection and lines move to meet arcs, sweeps are
// capped at half a turn, and last, an arc becomes a line with the same ends when its sagitta is at
// most tol / 20 or when Grbl would not cut it as meant once written (`grblArcPrecheck`).

import type { ArcSegment2, Segment2, SourceTag, Vec2 } from '../types';
import { dist, distToLine, midpoint, signedSweep } from './geometry';
import type { TagTable } from './flatten';
import { grblArcPrecheck } from './grbl';
import {
  DEMOTE_SAGITTA,
  GRBL_CHECK_DECIMALS,
  MAX_ARC_SWEEP,
  MAX_FIT_RADIUS,
  REFIT_TOLERANCE,
  TAG_TOLERANCE,
} from './tolerances';

const TAU = 2 * Math.PI;

interface Line {
  kind: 'line';
  a: Vec2;
  b: Vec2;
  source?: SourceTag;
}

interface Arc {
  kind: 'arc';
  a: Vec2;
  b: Vec2;
  c: Vec2;
  ccw: boolean;
  source?: SourceTag;
}

type Element = Line | Arc;

/** A fitted element and the range of input points it covers. */
type Fitted = Element & { i0: number; i1: number };

const normAngle = (a: number): number => {
  const r = a % TAU;
  return r < 0 ? r + TAU : r;
};

const angle = (p: Vec2, c: Vec2): number => Math.atan2(p[1] - c[1], p[0] - c[0]);

/** Signed sweep of an element arc in (-2 pi, 2 pi), zero when its ends coincide. */
function sweepOf(e: Arc): number {
  const a0 = angle(e.a, e.c);
  const a1 = angle(e.b, e.c);
  return e.ccw ? normAngle(a1 - a0) : -normAngle(a0 - a1);
}

const project = (p: Vec2, c: Vec2, r: number): Vec2 => {
  const l = dist(p, c);
  if (l === 0) return p;
  return [c[0] + ((p[0] - c[0]) * r) / l, c[1] + ((p[1] - c[1]) * r) / l];
};

function circleThrough(a: Vec2, b: Vec2, c: Vec2): { c: Vec2; r: number } | undefined {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  if (Math.abs(d) < 1e-18) return undefined;
  const a2 = a[0] * a[0] + a[1] * a[1];
  const b2 = b[0] * b[0] + b[1] * b[1];
  const c2 = c[0] * c[0] + c[1] * c[1];
  const center: Vec2 = [
    (a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d,
    (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d,
  ];
  const r = dist(center, a);
  return r > MAX_FIT_RADIUS ? undefined : { c: center, r };
}

/**
 * Do pts[i..j] lie on circle (c, r) within `tol` (vertices and segment midpoints), turning one way
 * by at most `maxSweep`? Returns the direction (true: counter-clockwise) and the signed angle
 * turned, or undefined.
 */
function onCircle(
  pts: readonly Vec2[],
  i: number,
  j: number,
  c: Vec2,
  r: number,
  tol: number,
  maxSweep = MAX_ARC_SWEEP,
): { ccw: boolean; total: number } | undefined {
  let total = 0;
  let sign = 0;
  for (let k = i; k <= j; k++) {
    const p = pts[k]!;
    if (Math.abs(dist(p, c) - r) > tol) return undefined;
    if (k === j) break;
    const q = pts[k + 1]!;
    if (Math.abs(dist(midpoint(p, q), c) - r) > tol) return undefined;
    let step = angle(q, c) - angle(p, c);
    if (step > Math.PI) step -= TAU;
    if (step < -Math.PI) step += TAU;
    if (Math.abs(step) < 1e-15) continue;
    const s = Math.sign(step);
    if (sign !== 0 && s !== sign) {
      // Integer rounding can step back a hair between two near-coincident points.
      if (Math.abs(step) * r > tol) return undefined;
    } else sign = s;
    total += step;
  }
  if (sign === 0 || Math.abs(total) > maxSweep + 1e-9) return undefined;
  return { ccw: sign > 0, total };
}

function onLine(pts: readonly Vec2[], i: number, j: number, tol: number): boolean {
  const a = pts[i]!;
  const b = pts[j]!;
  for (let k = i + 1; k < j; k++) if (distToLine(pts[k]!, a, b) > tol) return false;
  return true;
}

/** Largest j in [lo, hi] with ok(j), assuming ok is (mostly) monotone; `lo` must be ok. */
function extend(lo: number, hi: number, ok: (j: number) => boolean): number {
  let good = lo;
  let step = 1;
  while (good + step <= hi && ok(good + step)) {
    good += step;
    step *= 2;
  }
  let bad = Math.min(hi + 1, good + step);
  while (bad - good > 1) {
    const m = (good + bad) >> 1;
    if (ok(m)) good = m;
    else bad = m;
  }
  return good;
}

/** Fits an open chain of points, first to last, with lines and arcs within `tol`. */
function fitChain(pts: readonly Vec2[], tol: number): Fitted[] {
  const out: Fitted[] = [];
  const last = pts.length - 1;
  let i = 0;
  while (i < last) {
    const jLine = extend(i + 1, last, (j) => onLine(pts, i, j, tol));
    const fit = (j: number): { c: Vec2; r: number; ccw: boolean } | undefined => {
      if (j - i < 2) return undefined;
      const circle = circleThrough(pts[i]!, pts[(i + j) >> 1]!, pts[j]!);
      if (!circle) return undefined;
      const on = onCircle(pts, i, j, circle.c, circle.r, tol);
      return on ? { ...circle, ccw: on.ccw } : undefined;
    };
    let arcEnd = -1;
    let arc: { c: Vec2; r: number; ccw: boolean } | undefined;
    if (i + 2 <= last && fit(i + 2)) {
      arcEnd = extend(i + 2, last, (k) => fit(k) !== undefined);
      arc = fit(arcEnd);
    }
    const a = out.length > 0 ? out[out.length - 1]!.b : pts[i]!;
    if (arc && arcEnd > jLine) {
      const b = project(pts[arcEnd]!, arc.c, arc.r);
      out.push({ kind: 'arc', a, b, c: arc.c, ccw: arc.ccw, i0: i, i1: arcEnd });
      i = arcEnd;
    } else {
      out.push({ kind: 'line', a, b: pts[jLine]!, i0: i, i1: jLine });
      i = jLine;
    }
  }
  return out;
}

/** A circle the tags say a polyline segment may lie on. */
interface TaggedCircle {
  key: string;
  c: Vec2;
  r: number;
  /**
   * For a source arc's offset: the source arc's start angle and signed sweep. A concentric offset
   * spans the same angles, so a run's ends are clamped to them.
   */
  range?: { a0: number; sweep: number };
  source?: SourceTag;
}

/** `a` moved to the nearer end of `range` when it lies outside it. */
function clampAngle(a: number, range: { a0: number; sweep: number }): number {
  const { a0, sweep } = range;
  const off = sweep > 0 ? normAngle(a - a0) : normAngle(a0 - a);
  if (off <= Math.abs(sweep)) return a;
  // Outside: past the end by (off - |sweep|), or before the start by (2 pi - off).
  return off - Math.abs(sweep) < TAU - off ? a0 + sweep : a0;
}

/**
 * One run of polyline points on a tagged circle, as arcs on that exact circle: ends projected
 * onto it (and clamped to the source arc's angles), split into equal pieces when the run turns
 * more than `MAX_ARC_SWEEP`. Undefined when the run does not turn one way.
 */
function runArcs(
  run: readonly Vec2[],
  runTags: readonly number[],
  k: TaggedCircle,
  table: TagTable,
): Arc[] | undefined {
  const on = onCircle(run, 0, run.length - 1, k.c, k.r, TAG_TOLERANCE, Infinity);
  if (!on) return undefined;
  let a0 = angle(run[0]!, k.c);
  let a1 = angle(run[run.length - 1]!, k.c);
  if (k.range) {
    a0 = clampAngle(a0, k.range);
    a1 = clampAngle(a1, k.range);
    // Clipper squares an open path's end to its first chord, not to the arc's tangent: an arc
    // run that reaches a path's end vertex ends exactly at that vertex's angle.
    const first = table.vertex(runTags[0]!);
    const last = table.vertex(runTags[runTags.length - 1]!);
    if (first?.end) a0 = angle(first.point, k.c);
    if (last?.end) a1 = angle(last.point, k.c);
  }
  let sweep = on.ccw ? normAngle(a1 - a0) : normAngle(a0 - a1);
  // The polyline's own turning settles a sweep near zero or near a full turn.
  if (Math.abs(sweep - Math.abs(on.total)) > Math.PI) sweep += sweep < Math.PI ? TAU : -TAU;
  if (!(sweep > 0)) return undefined;
  const pieces = sweep <= MAX_ARC_SWEEP + 1e-9 ? 1 : Math.ceil(sweep / (MAX_ARC_SWEEP - 0.25));
  const at = (t: number): Vec2 => {
    const a = a0 + (on.ccw ? 1 : -1) * sweep * t;
    return [k.c[0] + k.r * Math.cos(a), k.c[1] + k.r * Math.sin(a)];
  };
  const arcs: Arc[] = [];
  let from = at(0);
  for (let p = 1; p <= pieces; p++) {
    const to = at(p / pieces);
    const e: Arc = { kind: 'arc', a: from, b: to, c: k.c, ccw: on.ccw };
    if (k.source) e.source = k.source;
    arcs.push(e);
    from = to;
  }
  return arcs;
}

/**
 * The circles a polyline segment may lie on according to its end tags: the round join about a
 * source corner (both ends offset from that one vertex; not for delta 0), and the offset circles
 * (r + |d| and r - |d|) of a source arc both ends come from.
 */
function segmentCircles(
  za: number,
  zb: number,
  table: TagTable,
  delta: number,
  cache: Map<number, TaggedCircle[]>,
): TaggedCircle[] {
  const va = table.vertex(za);
  const vb = table.vertex(zb);
  if (!va || !vb) return [];
  const d = Math.abs(delta);
  const out: TaggedCircle[] = [];
  if (za === zb && va.corner && d > 0) out.push({ key: `v${za}`, c: va.point, r: d });
  for (const si of va.segments) {
    if (!vb.segments.includes(si)) continue;
    let circles = cache.get(si);
    if (!circles) {
      circles = [];
      const s = table.segments[si]!;
      if (s.kind === 'arc') {
        const r = dist(s.start, s.center);
        const radii = d > 0 ? [r + d, r - d] : [r];
        radii.forEach((rr, k) => {
          if (rr > 0) {
            const circle: TaggedCircle = { key: `a${si}:${k}`, c: s.center, r: rr };
            if (!s.fullCircle)
              circle.range = { a0: angle(s.start, s.center), sweep: signedSweep(s) };
            if (s.source) circle.source = s.source;
            circles!.push(circle);
          }
        });
      }
      cache.set(si, circles);
    }
    out.push(...circles);
  }
  return out;
}

/** The source line both end tags of a fitted line share, if it has a `source`. */
function lineSource(za: number, zb: number, table: TagTable): SourceTag | undefined {
  const va = table.vertex(za);
  const vb = table.vertex(zb);
  if (!va || !vb) return undefined;
  for (const si of va.segments) {
    const s = table.segments[si]!;
    if (s.kind === 'line' && s.source && vb.segments.includes(si)) return s.source;
  }
  return undefined;
}

/** Rotation of a closed point list that starts at its sharpest corner. */
function sharpestCorner(pts: readonly Vec2[]): number {
  const n = pts.length;
  let best = 0;
  let bestTurn = -1;
  for (let i = 0; i < n; i++) {
    const p = pts[(i + n - 1) % n]!;
    const q = pts[i]!;
    const r = pts[(i + 1) % n]!;
    let t = Math.abs(angle(r, q) - angle(q, p));
    if (t > Math.PI) t = TAU - t;
    if (t > bestTurn + 1e-12) {
      bestTurn = t;
      best = i;
    }
  }
  return best;
}

export interface RefitOptions {
  /** Decimals the Grbl check rounds to (default `GRBL_CHECK_DECIMALS`, 3). */
  readonly decimals?: number;
}

/**
 * Refits a closed polyline (millimetres, one Z tag per point, 0 for none) into the segments of a
 * closed loop. `table` names the tags; `delta` is the offset that produced the polyline (0 for a
 * boolean). Returns an empty list for a polyline that collapses.
 */
export function refitClosed(
  pts: readonly Vec2[],
  tags: readonly number[],
  table: TagTable,
  delta: number,
  options: RefitOptions = {},
): Segment2[] {
  const n = pts.length;
  if (n < 3) return [];
  const cache = new Map<number, TaggedCircle[]>();
  // Per polyline segment i (pts[i] to pts[i + 1]): the circle its tags name, if it holds.
  const seg: (TaggedCircle | undefined)[] = [];
  for (let i = 0; i < n; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % n]!;
    const m = midpoint(a, b);
    let best: TaggedCircle | undefined;
    let bestDev = Infinity;
    for (const k of segmentCircles(tags[i]!, tags[(i + 1) % n]!, table, delta, cache)) {
      const dev = Math.max(
        Math.abs(dist(a, k.c) - k.r),
        Math.abs(dist(b, k.c) - k.r),
        Math.abs(dist(m, k.c) - k.r),
      );
      if (dev <= TAG_TOLERANCE && dev < bestDev) {
        best = k;
        bestDev = dev;
      }
    }
    seg.push(best);
  }
  // A corner join of one segment is better left to the untagged fit, which can merge it with its
  // neighbours (on a many-sided polygon every vertex is a corner with a tiny join).
  for (let i = 0; i < n; i++) {
    const k = seg[i];
    if (!k?.key.startsWith('v')) continue;
    if (seg[(i + n - 1) % n]?.key !== k.key && seg[(i + 1) % n]?.key !== k.key) seg[i] = undefined;
  }
  // Start at a change of circle so no run wraps around the seam; with none, at the sharpest corner.
  let start = -1;
  for (let i = 0; i < n; i++) {
    if (seg[i]?.key !== seg[(i + n - 1) % n]?.key) {
      start = i;
      break;
    }
  }
  if (start < 0) start = seg[0] ? 0 : sharpestCorner(pts);
  const at = (i: number): number => (start + i) % n;

  const out: Element[] = [];
  let i = 0;
  while (i < n) {
    const k = seg[at(i)];
    let j = i + 1;
    while (j < n && seg[at(j)]?.key === k?.key) j++;
    // Segments i..j-1 share circle k (or have none): points i..j.
    const run: Vec2[] = [];
    const runTags: number[] = [];
    for (let m = i; m <= j; m++) {
      run.push(pts[at(m)]!);
      runTags.push(tags[at(m)]!);
    }
    const whole = k ? runArcs(run, runTags, k, table) : undefined;
    if (whole) out.push(...whole);
    else if (k) {
      // The run does not turn one way (rounding noise): greedy pieces that do, lines otherwise.
      let a = 0;
      while (a < run.length - 1) {
        const b = extend(
          a + 1,
          run.length - 1,
          (m) => onCircle(run, a, m, k.c, k.r, TAG_TOLERANCE) !== undefined,
        );
        const on = onCircle(run, a, b, k.c, k.r, TAG_TOLERANCE);
        if (!on) out.push({ kind: 'line', a: run[a]!, b: run[b]! });
        else {
          const e: Arc = {
            kind: 'arc',
            a: project(run[a]!, k.c, k.r),
            b: project(run[b]!, k.c, k.r),
            c: k.c,
            ccw: on.ccw,
          };
          if (k.source) e.source = k.source;
          out.push(e);
        }
        a = b;
      }
    } else {
      for (const e of fitChain(run, REFIT_TOLERANCE)) {
        if (e.kind === 'line') {
          const source = lineSource(runTags[e.i0]!, runTags[e.i1]!, table);
          const line: Line = { kind: 'line', a: e.a, b: e.b };
          if (source) line.source = source;
          out.push(line);
        } else {
          out.push({ kind: 'arc', a: e.a, b: e.b, c: e.c, ccw: e.ccw });
        }
      }
    }
    i = j;
  }
  const stitched = stitch(out, TAG_TOLERANCE);
  const segments = demote(stitched, options.decimals ?? GRBL_CHECK_DECIMALS).map(toSegment);
  return segments.length >= 2 ? segments : [];
}

/** Intersection of two circles nearest to `p`, if they meet. */
function circleIntersection(c1: Vec2, r1: number, c2: Vec2, r2: number, p: Vec2): Vec2 | undefined {
  const d = dist(c1, c2);
  if (d < 1e-12 || d > r1 + r2 || d < Math.abs(r1 - r2)) return undefined;
  const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, r1 * r1 - a * a));
  const ux = (c2[0] - c1[0]) / d;
  const uy = (c2[1] - c1[1]) / d;
  const mx = c1[0] + a * ux;
  const my = c1[1] + a * uy;
  const p1: Vec2 = [mx - h * uy, my + h * ux];
  const p2: Vec2 = [mx + h * uy, my - h * ux];
  return dist(p1, p) <= dist(p2, p) ? p1 : p2;
}

/**
 * Makes a closed chain continuous. Arcs keep their ends on their circles and lines move to meet
 * them; two arcs meet at their circles' intersection when it is within 2 tol of both ends, else
 * a short line joins them.
 */
function stitch(els: readonly Element[], tol: number): Element[] {
  const n = els.length;
  const e: Element[] = els.map((x) => ({ ...x }));
  const sweeps = e.map((x) => (x.kind === 'arc' ? sweepOf(x) : 0));
  for (let i = 0; i < n; i++) {
    const a = e[i]!;
    const b = e[(i + 1) % n]!;
    if (a.b[0] === b.a[0] && a.b[1] === b.a[1]) continue;
    if (a.kind === 'line') a.b = b.a;
    else if (b.kind === 'line') b.a = a.b;
    else {
      const x = circleIntersection(a.c, dist(a.a, a.c), b.c, dist(b.a, b.c), a.b);
      if (x && dist(x, a.b) <= 2 * tol && dist(x, b.a) <= 2 * tol) {
        a.b = x;
        b.a = x;
      }
    }
  }
  // Moving a tiny arc's ends can flip it the long way round: put such an arc back where it was
  // and let short lines join it.
  e.forEach((x, i) => {
    if (x.kind === 'arc' && Math.abs(sweepOf(x) - sweeps[i]!) > 1) {
      x.a = els[i]!.a;
      x.b = els[i]!.b;
    }
  });
  const out: Element[] = [];
  for (let i = 0; i < n; i++) {
    const a = e[i]!;
    const b = e[(i + 1) % n]!;
    out.push(a);
    // Ends a float's noise apart (pieces of one circle) are made equal.
    if (dist(a.b, b.a) <= 1e-9) b.a = a.b;
    else if (a.b[0] !== b.a[0] || a.b[1] !== b.a[1]) out.push({ kind: 'line', a: a.b, b: b.a });
  }
  return out.filter((x) => x.kind === 'arc' || dist(x.a, x.b) > 0);
}

/**
 * The refit's last step. An arc swept past `MAX_ARC_SWEEP` (a stitch artefact) is split into equal
 * pieces on its circle. Then an arc becomes a line with the same ends when the line is within
 * `DEMOTE_SAGITTA` of it, or when Grbl would not cut it as meant once written with `decimals`
 * places.
 */
function demote(els: readonly Element[], decimals: number): Element[] {
  return els.flatMap(splitArc).map((e): Element => {
    if (e.kind !== 'arc') return e;
    const sw = Math.abs(sweepOf(e));
    const sagitta = dist(e.a, e.c) * (1 - Math.cos(Math.min(sw, Math.PI) / 2));
    if (sagitta <= DEMOTE_SAGITTA || !grblArcPrecheck(toArc(e), decimals).ok) {
      const line: Line = { kind: 'line', a: e.a, b: e.b };
      if (e.source) line.source = e.source;
      return line;
    }
    return e;
  });
}

/** An arc swept past `MAX_ARC_SWEEP`, as equal pieces on its circle; anything else as is. */
function splitArc(e: Element): Element[] {
  if (e.kind !== 'arc') return [e];
  const sw = sweepOf(e);
  if (Math.abs(sw) <= MAX_ARC_SWEEP + 1e-9) return [e];
  const pieces = Math.ceil(Math.abs(sw) / MAX_ARC_SWEEP);
  const r = dist(e.a, e.c);
  const a0 = angle(e.a, e.c);
  const out: Element[] = [];
  let from = e.a;
  for (let p = 1; p <= pieces; p++) {
    const a = a0 + (sw * p) / pieces;
    const to: Vec2 = p === pieces ? e.b : [e.c[0] + r * Math.cos(a), e.c[1] + r * Math.sin(a)];
    const piece: Arc = { kind: 'arc', a: from, b: to, c: e.c, ccw: e.ccw };
    if (e.source) piece.source = e.source;
    out.push(piece);
    from = to;
  }
  return out;
}

function toArc(e: Arc): ArcSegment2 {
  const arc = { kind: 'arc' as const, start: e.a, end: e.b, center: e.c, ccw: e.ccw };
  return e.source ? { ...arc, source: e.source } : arc;
}

function toSegment(e: Element): Segment2 {
  if (e.kind === 'arc') return toArc(e);
  const line = { kind: 'line' as const, start: e.a, end: e.b };
  return e.source ? { ...line, source: e.source } : line;
}

/**
 * Applies the refit's last step to segments made some other way (the analytic fast path): arcs
 * within `DEMOTE_SAGITTA` of their chord, or failing Grbl's checks, become lines.
 */
export function demoteSegments(
  segments: readonly Segment2[],
  decimals = GRBL_CHECK_DECIMALS,
): Segment2[] {
  const els: Element[] = segments.map((s) => {
    if (s.kind === 'line') {
      const line: Line = { kind: 'line', a: s.start, b: s.end };
      if (s.source) line.source = s.source;
      return line;
    }
    const arc: Arc = { kind: 'arc', a: s.start, b: s.end, c: s.center, ccw: s.ccw };
    if (s.source) arc.source = s.source;
    return arc;
  });
  return demote(els, decimals).map(toSegment);
}
