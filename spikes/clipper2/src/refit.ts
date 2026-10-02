// Arc refit: turn Clipper's offset polylines back into lines and arcs (G1, G2/G3).
//
// Two methods:
//
// - `refitUntagged`: geometry only. Greedy from a sharp corner: extend a run of
//   points as long as one circle (through the run's first, middle and last point)
//   holds every vertex and every segment midpoint within `tol`, or as long as one
//   line does; take whichever run is longer.
// - `refitTagged`: Clipper's Z tags name the source vertex of every output point
//   (the offset copies the tag of the vertex it offsets; see engines.ts). A
//   segment whose two ends come from the same source arc lies on that arc's
//   concentric offset circle (radius r +- d); one whose two ends come from the
//   same source corner lies on the round join around it (radius |d|). Consecutive
//   segments on the same circle become one arc on the known circle. What the
//   tags do not explain (lines, untagged intersections) goes through the
//   untagged fitter.
//
// Arc ends are projected onto their circle, so the start and end radius agree to
// float precision (GRBL's error 33 checks them to 0.005 mm); the next element
// starts where the arc ends. Sweeps are capped at `MAX_SWEEP`. Last, arcs whose
// sagitta is at most tol/20, and arcs Grbl would cut differently once written
// (a near-zero arc runs as a full circle), become lines: see `demoteArcs`.

import type { Flattened, P, TaggedPath } from './geometry.ts';
import { dist, distToArc, distToSegment } from './geometry.ts';

export type Element =
  { kind: 'line'; a: P; b: P } | { kind: 'arc'; a: P; b: P; c: P; ccw: boolean };

/** Largest sweep of one refit arc (radians). Half a turn keeps IJK arcs well conditioned. */
export const MAX_SWEEP = Math.PI;
/** Circles larger than this (mm) are treated as lines. */
const MAX_RADIUS = 1e4;

const TAU = 2 * Math.PI;
const normAngle = (a: number): number => ((a % TAU) + TAU) % TAU;

export function arcRadius(e: Element & { kind: 'arc' }): number {
  return dist(e.a, e.c);
}

export function arcSweep(e: Element & { kind: 'arc' }): number {
  const a0 = Math.atan2(e.a[1] - e.c[1], e.a[0] - e.c[0]);
  const a1 = Math.atan2(e.b[1] - e.c[1], e.b[0] - e.c[0]);
  return e.ccw ? normAngle(a1 - a0) || TAU : -(normAngle(a0 - a1) || TAU);
}

export function distToElement(p: P, e: Element): number {
  if (e.kind === 'line') return distToSegment(p, e.a, e.b);
  const a0 = Math.atan2(e.a[1] - e.c[1], e.a[0] - e.c[0]);
  return distToArc(p, e.c, arcRadius(e), a0, arcSweep(e));
}

/** Points along an element, `n + 1` of them, ends included. */
export function sampleElement(e: Element, n: number): P[] {
  const out: P[] = [];
  if (e.kind === 'line') {
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      out.push([e.a[0] + t * (e.b[0] - e.a[0]), e.a[1] + t * (e.b[1] - e.a[1])]);
    }
    return out;
  }
  const r = arcRadius(e);
  const a0 = Math.atan2(e.a[1] - e.c[1], e.a[0] - e.c[0]);
  const sw = arcSweep(e);
  for (let k = 0; k <= n; k++) {
    const a = a0 + (sw * k) / n;
    out.push([e.c[0] + r * Math.cos(a), e.c[1] + r * Math.sin(a)]);
  }
  return out;
}

// Circle helpers ---------------------------------------------------------------------------

function circleThrough(a: P, b: P, c: P): { c: P; r: number } | undefined {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  if (Math.abs(d) < 1e-18) return undefined;
  const a2 = a[0] * a[0] + a[1] * a[1];
  const b2 = b[0] * b[0] + b[1] * b[1];
  const c2 = c[0] * c[0] + c[1] * c[1];
  const ux = (a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d;
  const uy = (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d;
  const center: P = [ux, uy];
  const r = dist(center, a);
  return r > MAX_RADIUS ? undefined : { c: center, r };
}

const mid = (a: P, b: P): P => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];

const project = (p: P, c: P, r: number): P => {
  const l = dist(p, c);
  return [c[0] + ((p[0] - c[0]) * r) / l, c[1] + ((p[1] - c[1]) * r) / l];
};

/**
 * Do points[i..j] lie on circle (c, r) within tol, vertices and segment midpoints,
 * turning one way by less than MAX_SWEEP? Returns the direction or undefined.
 */
function onCircle(
  pts: readonly P[],
  i: number,
  j: number,
  c: P,
  r: number,
  tol: number,
): boolean | undefined {
  let total = 0;
  let sign = 0;
  for (let k = i; k <= j; k++) {
    const p = pts[k]!;
    if (Math.abs(dist(p, c) - r) > tol) return undefined;
    if (k === j) break;
    const q = pts[k + 1]!;
    if (Math.abs(dist(mid(p, q), c) - r) > tol) return undefined;
    const a = Math.atan2(p[1] - c[1], p[0] - c[0]);
    const b = Math.atan2(q[1] - c[1], q[0] - c[0]);
    let step = b - a;
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
  if (sign === 0 || Math.abs(total) > MAX_SWEEP + 1e-9) return undefined;
  return sign > 0;
}

function onLine(pts: readonly P[], i: number, j: number, tol: number): boolean {
  const a = pts[i]!;
  const b = pts[j]!;
  for (let k = i + 1; k < j; k++) if (distToSegment(pts[k]!, a, b) > tol) return false;
  return true;
}

// Untagged -----------------------------------------------------------------------------------

/** Rotate a closed loop so it starts at its sharpest corner (where an arc cannot run on). */
function rotateToCorner(pts: P[]): P[] {
  const n = pts.length;
  let best = 0;
  let bestTurn = -1;
  for (let i = 0; i < n; i++) {
    const p = pts[(i + n - 1) % n]!;
    const q = pts[i]!;
    const r = pts[(i + 1) % n]!;
    const a = Math.atan2(q[1] - p[1], q[0] - p[0]);
    const b = Math.atan2(r[1] - q[1], r[0] - q[0]);
    let t = Math.abs(b - a);
    if (t > Math.PI) t = TAU - t;
    if (t > bestTurn + 1e-12) {
      bestTurn = t;
      best = i;
    }
  }
  return [...pts.slice(best), ...pts.slice(0, best)];
}

/** Largest j in [lo, hi] with ok(j), assuming ok is (mostly) monotone; lo must be ok. */
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

/** Fit an open chain of points (first to last) with lines and arcs. */
export function fitChain(pts: readonly P[], tol: number): Element[] {
  const out: Element[] = [];
  const last = pts.length - 1;
  let i = 0;
  while (i < last) {
    const jLine = extend(i + 1, last, (j) => onLine(pts, i, j, tol));
    let arc: { j: number; c: P; r: number; ccw: boolean } | undefined;
    const fit = (j: number) => {
      if (j - i < 2) return undefined;
      const circle = circleThrough(pts[i]!, pts[(i + j) >> 1]!, pts[j]!);
      if (!circle) return undefined;
      const ccw = onCircle(pts, i, j, circle.c, circle.r, tol);
      return ccw === undefined ? undefined : { j, c: circle.c, r: circle.r, ccw };
    };
    if (i + 2 <= last && fit(i + 2)) {
      const j = extend(i + 2, last, (k) => fit(k) !== undefined);
      arc = fit(j);
    }
    if (arc && arc.j > jLine) {
      const a = out.length > 0 ? out[out.length - 1]!.b : pts[i]!;
      out.push({ kind: 'arc', a, b: project(pts[arc.j]!, arc.c, arc.r), c: arc.c, ccw: arc.ccw });
      // The start moved only by float noise (the circle passes through pts[i]).
      i = arc.j;
    } else {
      const a = out.length > 0 ? out[out.length - 1]!.b : pts[i]!;
      out.push({ kind: 'line', a, b: pts[jLine]! });
      i = jLine;
    }
  }
  return out;
}

const toPoints = (xy: Float64Array): P[] => {
  const pts: P[] = [];
  for (let i = 0; i < xy.length; i += 2) pts.push([xy[i]!, xy[i + 1]!]);
  return pts;
};

/** Refit a closed polyline (no tags). */
export function refitUntagged(path: TaggedPath, tol: number, o: RefitOptions = {}): Element[] {
  const pts = rotateToCorner(toPoints(path.xy));
  return finish(fitChain([...pts, pts[0]!], tol), tol, o);
}

// Tagged -----------------------------------------------------------------------------------

interface CircleKey {
  key: string;
  c: P;
  r: number;
}

/**
 * The circles a segment may lie on according to its end tags, most specific first:
 * the round join around a source corner (both ends offset from that one vertex),
 * then the offset of a source arc both ends come from.
 */
function segmentCircles(
  za: number,
  zb: number,
  src: Flattened,
  delta: number,
  arcCache: Map<number, CircleKey | undefined>,
): CircleKey[] {
  const va = za > 0 ? src.vertices[za - 1] : undefined;
  const vb = zb > 0 ? src.vertices[zb - 1] : undefined;
  if (!va || !vb) return [];
  const out: CircleKey[] = [];
  if (za === zb && va.corner) out.push({ key: `v${za}`, c: va.point, r: Math.abs(delta) });
  for (const ci of va.curves) {
    if (!vb.curves.includes(ci)) continue;
    if (!arcCache.has(ci)) {
      const c = src.curves[ci]!;
      if (c.kind !== 'arc') arcCache.set(ci, undefined);
      else {
        // The region is on the left: inside a counter-clockwise arc, outside a clockwise one.
        const r = c.sweep > 0 ? c.r + delta : c.r - delta;
        arcCache.set(ci, r > 0 ? { key: `a${ci}`, c: c.c, r } : undefined);
      }
    }
    const k = arcCache.get(ci);
    if (k) out.push(k);
  }
  return out;
}

/**
 * Refit a closed polyline using its Z tags. `src` is the flattened input that the
 * tags index; `delta` the offset (mm, positive outward) that produced `path`.
 * `tol` bounds the untagged fit. `tagTol` bounds how far the polyline may be from
 * a circle its tags name (the flattening and join chord errors make it deviate
 * from the exact circle the arc is placed on); it defaults to `tol`.
 */
export function refitTagged(
  path: TaggedPath,
  src: Flattened,
  delta: number,
  tol: number,
  tagTol = tol,
  o: RefitOptions = {},
): Element[] {
  const pts = toPoints(path.xy);
  const n = pts.length;
  const cache = new Map<number, CircleKey | undefined>();
  // Per segment i (pts[i] to pts[i+1]): its circle, if the tags give one and it holds.
  const seg: (CircleKey | undefined)[] = [];
  for (let i = 0; i < n; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % n]!;
    const candidates = segmentCircles(path.z[i]!, path.z[(i + 1) % n]!, src, delta, cache);
    seg.push(
      candidates.find(
        (k) =>
          Math.abs(dist(a, k.c) - k.r) <= tagTol &&
          Math.abs(dist(b, k.c) - k.r) <= tagTol &&
          Math.abs(dist(mid(a, b), k.c) - k.r) <= tagTol,
      ),
    );
  }
  // A corner join of one segment is better left to the fitter, which can merge it with
  // its neighbours (on a many-sided polygon every vertex is a corner with a tiny join).
  for (let i = 0; i < n; i++) {
    const k = seg[i];
    if (!k?.key.startsWith('v')) continue;
    if (seg[(i + n - 1) % n]?.key !== k.key && seg[(i + 1) % n]?.key !== k.key) seg[i] = undefined;
  }
  // Start at a change of circle so no run wraps around the seam.
  let start = 0;
  for (let i = 0; i < n; i++) {
    if (seg[i]?.key !== seg[(i + n - 1) % n]?.key) {
      start = i;
      break;
    }
  }
  const out: Element[] = [];
  let i = 0;
  while (i < n) {
    const k = seg[(start + i) % n];
    let j = i + 1;
    while (j < n && seg[(start + j) % n]?.key === k?.key) j++;
    // Segments i..j-1 share the circle k (or have none): points i..j.
    const run: P[] = [];
    for (let m = i; m <= j; m++) run.push(pts[(start + m) % n]!);
    if (k) {
      // Split the run where the sweep would pass MAX_SWEEP.
      let a = 0;
      while (a < run.length - 1) {
        const b = extend(
          a + 1,
          run.length - 1,
          (m) => onCircle(run, a, m, k.c, k.r, tagTol) !== undefined,
        );
        const ccw = onCircle(run, a, b, k.c, k.r, tagTol);
        const from = project(run[a]!, k.c, k.r);
        const to = project(run[b]!, k.c, k.r);
        out.push(
          ccw === undefined
            ? { kind: 'line', a: run[a]!, b: run[b]! }
            : { kind: 'arc', a: from, b: to, c: k.c, ccw },
        );
        a = b;
      }
    } else {
      for (const e of fitChain(run, tol)) out.push(e);
    }
    i = j;
  }
  return finish(stitch(out, Math.max(tol, tagTol)), tol, o);
}

/** Intersection of two circles nearest to p, if any. */
function circleIntersection(c1: P, r1: number, c2: P, r2: number, p: P): P | undefined {
  const d = dist(c1, c2);
  if (d < 1e-12 || d > r1 + r2 || d < Math.abs(r1 - r2)) return undefined;
  const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, r1 * r1 - a * a));
  const ux = (c2[0] - c1[0]) / d;
  const uy = (c2[1] - c1[1]) / d;
  const mx = c1[0] + a * ux;
  const my = c1[1] + a * uy;
  const p1: P = [mx - h * uy, my + h * ux];
  const p2: P = [mx + h * uy, my - h * ux];
  return dist(p1, p) <= dist(p2, p) ? p1 : p2;
}

/**
 * Make a closed chain of elements continuous. Arcs keep their ends on their circle;
 * lines move to meet them. Two arcs meet at their circles' intersection when it is
 * within 2 tol, else a short line joins them.
 */
function stitch(els: Element[], tol: number): Element[] {
  const out: Element[] = [];
  const n = els.length;
  const e = els.map((x) => ({ ...x }));
  const sweeps = e.map((x) => (x.kind === 'arc' ? arcSweep(x) : 0));
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
  // Moving the ends of a tiny arc can flip it into a nearly full circle: put such an arc
  // back where it was and let short lines join it.
  e.forEach((x, i) => {
    if (x.kind === 'arc' && Math.abs(arcSweep(x) - sweeps[i]!) > 1) {
      const o = els[i]!;
      x.a = o.a;
      x.b = o.b;
    }
  });
  for (let i = 0; i < n; i++) {
    const a = e[i]!;
    const b = e[(i + 1) % n]!;
    out.push(a);
    if (a.b[0] !== b.a[0] || a.b[1] !== b.a[1]) out.push({ kind: 'line', a: a.b, b: b.a });
  }
  // A line moved to meet an arc at both ends can collapse; drop zero-length lines.
  return out.filter((x) => x.kind === 'arc' || dist(x.a, x.b) > 0);
}

export interface RefitOptions {
  /** Turn arcs Grbl would not cut as meant, and arcs within tol/20 of their chord, into lines (default true). */
  demote?: boolean;
  /** Decimals the post writes (default 3). */
  decimals?: number;
  /** Counts the arcs turned into lines, when given. */
  stats?: { demoted: number };
}

function finish(els: Element[], tol: number, o: RefitOptions): Element[] {
  if (o.demote === false) return els;
  const r = demoteArcs(els, tol / 20, o.decimals ?? 3);
  if (o.stats) o.stats.demoted += r.demoted;
  return r.elements;
}

// GRBL's arc check ---------------------------------------------------------------------------

/** Round to the post's number format (`decimals` places in millimetres). */
const round = (v: number, decimals: number): number => {
  const f = 10 ** decimals;
  return Math.round(v * f) / f;
};

/** Grbl 1.1's ARC_ANGULAR_TRAVEL_EPSILON (config.h). */
const ARC_ANGULAR_TRAVEL_EPSILON = 5e-7;

export interface GrblArcCheck {
  /** Start radius minus end radius, as written (mm). */
  diff: number;
  /** Passes the radius rule (error 33). */
  radiusOk: boolean;
  /** The angular travel Grbl's mc_arc computes from the written words (radians, signed). */
  travel: number;
  /** The sweep we meant (radians, signed). */
  sweep: number;
  /** Grbl cuts the arc we meant (not a full circle, not the other way round). */
  travelOk: boolean;
  ok: boolean;
}

/**
 * Check an arc as the post writes it (X, Y, I and J rounded to `decimals`) against
 * Grbl 1.1:
 *
 * - error 33 (gcode.c): the end radius differs from the start radius by more than
 *   0.005 mm and more than 0.1% of the radius, or by more than 0.5 mm;
 * - the angular travel (motion_control.c, mc_arc): atan2 of the start and end
 *   radius vectors, in single precision; for G2, a travel at or above -5e-7 rad
 *   gets 2 pi subtracted, for G3 one at or below 5e-7 gets 2 pi added. So an arc
 *   whose written end equals (or nearly equals) its start runs as a full circle.
 *   `travelOk` fails when the travel differs from the intended sweep by more than
 *   0.5 rad (a full circle, or a flip to the long way round).
 */
export function grblArcCheck(e: Element & { kind: 'arc' }, decimals = 3): GrblArcCheck {
  const f = Math.fround;
  const sx = round(e.a[0], decimals);
  const sy = round(e.a[1], decimals);
  const ex = round(e.b[0], decimals);
  const ey = round(e.b[1], decimals);
  const i = round(e.c[0] - e.a[0], decimals);
  const j = round(e.c[1] - e.a[1], decimals);
  const cx = sx + i;
  const cy = sy + j;
  const rs = Math.hypot(sx - cx, sy - cy);
  const re = Math.hypot(ex - cx, ey - cy);
  const diff = Math.abs(rs - re);
  const radiusOk = !((diff > 0.005 && diff > 0.001 * rs) || diff > 0.5);
  // mc_arc, in float as Grbl computes it.
  const r0 = f(-i);
  const r1 = f(-j);
  const t0 = f(f(ex) - f(f(sx) + f(i)));
  const t1 = f(f(ey) - f(f(sy) + f(j)));
  let travel = Math.atan2(f(f(r0 * t1) - f(r1 * t0)), f(f(r0 * t0) + f(r1 * t1)));
  if (!e.ccw) {
    if (travel >= -ARC_ANGULAR_TRAVEL_EPSILON) travel -= 2 * Math.PI;
  } else if (travel <= ARC_ANGULAR_TRAVEL_EPSILON) travel += 2 * Math.PI;
  const sweep = arcSweep(e);
  const travelOk = Math.abs(travel - sweep) <= 0.5;
  return { diff, radiusOk, travel, sweep, travelOk, ok: radiusOk && travelOk };
}

/** Kept for the radius rule alone. */
export function grblRadiusError(e: Element & { kind: 'arc' }): { diff: number; ok: boolean } {
  const c = grblArcCheck(e);
  return { diff: c.diff, ok: c.radiusOk };
}

/**
 * The last step of both refits: an arc becomes a line (G1, same ends) when the line
 * is within `tol` of it anyway (sagitta at most `tol`), or when Grbl would not cut
 * it as meant once written with `decimals` places (see `grblArcCheck`). Tiny arcs
 * (a few micrometres of chord, a 1e-5 rad sweep) are what turn into full circles.
 * Returns the elements and how many arcs were turned into lines.
 */
export function demoteArcs(
  els: readonly Element[],
  tol: number,
  decimals = 3,
): { elements: Element[]; demoted: number } {
  let demoted = 0;
  const elements = els.map((e): Element => {
    if (e.kind !== 'arc') return e;
    const sw = Math.abs(arcSweep(e));
    const sagitta = arcRadius(e) * (1 - Math.cos(Math.min(sw, Math.PI) / 2));
    if (sagitta <= tol || !grblArcCheck(e, decimals).ok) {
      demoted++;
      return { kind: 'line', a: e.a, b: e.b };
    }
    return e;
  });
  return { elements, demoted };
}
