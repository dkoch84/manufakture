// The analytic drawing of members (ADR 0015 decision 9): what a framing elevation draws of a
// member (its outline seen from the viewer, with its cut lines) and what a plan draws of it (its
// section by the cut plane), computed from member data alone, never through the kernel.
//
// Both are the outline of a region of a plane: the face of the member's blank that faces the
// viewer, or the cut plane inside the blank. In the plane's own 2D coordinates the blank's sides
// and every plane cut are half-planes the region keeps, and a notch (a birdsmouth) removes the
// intersection of two half-planes. The region is convex before the notches, so its edges are each
// keeping half-plane's line clipped to all the others; a notch then takes away the part of every
// edge inside it and adds its own two sides where they lie in the region. Constant work per
// member: six blank sides and at most `MAX_MEMBER_CUTS` cuts.

import type { MemberData } from '@manufakture/regen';
import { add, cross, dot, scale, toWorld, type Placement, type Vec3 } from '../geom';

type V2 = readonly [number, number];

/** `a u + b v + c`: kept where it is at most 0 (a keeping half-plane), or the removed side's test. */
interface Half {
  readonly a: number;
  readonly b: number;
  readonly c: number;
}

/** A segment in world coordinates. */
export type Segment3 = readonly [Vec3, Vec3];

/** Lengths below this, mm, are nothing. */
const EPS = 1e-6;

/** A plane's 2D coordinates: `point(u, v) = o + u e1 + v e2`, in the member's local frame. */
interface PlaneFrame {
  readonly o: Vec3;
  readonly e1: Vec3;
  readonly e2: Vec3;
}

const at = (f: PlaneFrame, p: V2): Vec3 => add(f.o, add(scale(f.e1, p[0]), scale(f.e2, p[1])));

/** The local half-space `dot(n, p) - k` (positive outside) as a half-plane of the frame. */
function half(f: PlaneFrame, n: Vec3, k: number): Half {
  return { a: dot(n, f.e1), b: dot(n, f.e2), c: dot(n, f.o) - k };
}

const degenerate = (h: Half) => Math.hypot(h.a, h.b) <= 1e-12;

/**
 * The part of the line `p + t d` where every half-plane in `keep` is at most 0 (`hi`: `t` in
 * `[lo, hi]`), within `[lo, hi]`; null when empty or shorter than `EPS` (with `d` a unit vector).
 */
function clip(
  p: V2,
  d: V2,
  keep: readonly Half[],
  lo: number,
  hi: number,
): readonly [number, number] | null {
  for (const h of keep) {
    const s = h.a * d[0] + h.b * d[1];
    const v = h.a * p[0] + h.b * p[1] + h.c;
    if (Math.abs(s) <= 1e-12) {
      if (v > EPS) return null;
      continue;
    }
    const t = -v / s;
    if (s > 0) hi = Math.min(hi, t);
    else lo = Math.max(lo, t);
    if (hi - lo <= EPS) return null;
  }
  return [lo, hi];
}

/** The line of a half-plane: a point on it and its unit direction. */
function lineOf(h: Half): { p: V2; d: V2 } {
  const n2 = h.a * h.a + h.b * h.b;
  const len = Math.sqrt(n2);
  return { p: [(-h.c * h.a) / n2, (-h.c * h.b) / n2], d: [-h.b / len, h.a / len] };
}

const flip = (h: Half): Half => ({ a: -h.a, b: -h.b, c: -h.c });

/**
 * The outline of `{ every keep <= 0 } minus every notch { a >= 0 and b >= 0 }` as 2D segments.
 * `keep` must bound the region (the blank's sides do). Linear in keep times (keep + notches).
 */
function regionOutline(
  keep: readonly Half[],
  notches: readonly (readonly [Half, Half])[],
): [V2, V2][] {
  const BIG = 1e9;
  const out: [V2, V2][] = [];
  const emit = (p: V2, d: V2, t0: number, t1: number) => {
    // Less the part of it inside each notch.
    let pieces: (readonly [number, number])[] = [[t0, t1]];
    for (const [na, nb] of notches) {
      const next: (readonly [number, number])[] = [];
      for (const [s0, s1] of pieces) {
        const inside = clip(p, d, [flip(na), flip(nb)], s0, s1);
        if (inside === null) {
          next.push([s0, s1]);
          continue;
        }
        if (inside[0] - s0 > EPS) next.push([s0, inside[0]]);
        if (s1 - inside[1] > EPS) next.push([inside[1], s1]);
      }
      pieces = next;
    }
    for (const [s0, s1] of pieces)
      out.push([
        [p[0] + d[0] * s0, p[1] + d[1] * s0],
        [p[0] + d[0] * s1, p[1] + d[1] * s1],
      ]);
  };
  keep.forEach((h, i) => {
    if (degenerate(h)) return;
    const { p, d } = lineOf(h);
    const others = keep.filter((_, j) => j !== i);
    const span = clip(p, d, others, -BIG, BIG);
    if (span !== null) emit(p, d, span[0], span[1]);
  });
  // Each notch's two sides, where they bound the region: inside it, and inside the notch's other side.
  for (const [na, nb] of notches) {
    for (const [side, other] of [
      [na, nb],
      [nb, na],
    ] as const) {
      if (degenerate(side)) continue;
      const { p, d } = lineOf(side);
      const span = clip(p, d, [...keep, flip(other)], -BIG, BIG);
      if (span !== null)
        out.push([
          [p[0] + d[0] * span[0], p[1] + d[1] * span[0]],
          [p[0] + d[0] * span[1], p[1] + d[1] * span[1]],
        ]);
    }
  }
  return out;
}

/** The member's blank sides as keeping half-planes of a frame, and its cuts. */
function regionOf(
  m: MemberData,
  f: PlaneFrame,
  ignoreFlat: boolean,
): { keep: Half[]; notches: [Half, Half][] } | null {
  const size: Vec3 = [m.length, m.stock.width, m.stock.depth];
  const keep: Half[] = [];
  const notches: [Half, Half][] = [];
  for (let i = 0; i < 3; i++) {
    const e: Vec3 = [i === 0 ? 1 : 0, i === 1 ? 1 : 0, i === 2 ? 1 : 0];
    keep.push(half(f, scale(e, -1), 0)); // -p_i <= 0
    keep.push(half(f, e, size[i]!)); // p_i - size <= 0
  }
  for (const c of m.cuts) {
    if (c.kind === 'plane') keep.push(half(f, c.n, c.k));
    else {
      const a = half(f, c.a.n, c.a.k);
      const b = half(f, c.b.n, c.b.k);
      // A notch whose sides are both parallel to the plane removes all of it or none of it.
      if (degenerate(a) && degenerate(b)) {
        if (a.c >= 0 && b.c >= 0 && !ignoreFlat) return null;
        continue;
      }
      // One side parallel: it decides whether the notch reaches the plane at all.
      if (degenerate(a)) {
        if (a.c >= 0) keep.push(b);
        continue;
      }
      if (degenerate(b)) {
        if (b.c >= 0) keep.push(a);
        continue;
      }
      // Removed where a >= 0 and b >= 0: kept as the notch's own test.
      notches.push([a, b]);
    }
  }
  // A side parallel to the plane: a section misses the member when it is outside; a face seen
  // straight on is outlined as if the cut were not there (its silhouette is the same).
  const kept: Half[] = [];
  for (const h of keep) {
    if (!degenerate(h)) kept.push(h);
    else if (h.c > EPS && !ignoreFlat) return null;
  }
  return { keep: kept, notches };
}

/** Local frame vectors of the member as plain axes. */
function axes(p: Placement): readonly [Vec3, Vec3, Vec3] {
  return [p.x, p.y, cross(p.x, p.y)];
}

/** A direction in the member's local frame. */
function toLocalDir(p: Placement, v: Vec3): Vec3 {
  const [x, y, z] = axes(p);
  return [dot(v, x), dot(v, y), dot(v, z)];
}

/**
 * A member as an elevation or a plan from above draws it: the outline of the side of its blank
 * that faces the viewer (`view` the direction the viewer looks), less its cuts, with a notch's
 * two sides drawn where they cut the side. World segments; their projection is the drawing.
 */
export function memberOutline(m: MemberData, view: Vec3): Segment3[] {
  const v = toLocalDir(m.placement, view);
  const size: Vec3 = [m.length, m.stock.width, m.stock.depth];
  // The side most facing the viewer: the axis the view runs most along, on the near side.
  let axis = 0;
  for (let i = 1; i < 3; i++) if (Math.abs(v[i]!) > Math.abs(v[axis]!)) axis = i;
  const near = v[axis]! > 0 ? 0 : size[axis]!;
  const others = [0, 1, 2].filter((i) => i !== axis) as [number, number];
  const unit = (i: number): Vec3 => [i === 0 ? 1 : 0, i === 1 ? 1 : 0, i === 2 ? 1 : 0];
  const o: Vec3 = scale(unit(axis), near);
  const f: PlaneFrame = { o, e1: unit(others[0]), e2: unit(others[1]) };
  const region = regionOf(m, f, true);
  if (region === null) return [];
  return regionOutline(region.keep, region.notches).map(([a, b]): Segment3 => [
    toWorld(m.placement, at(f, a)),
    toWorld(m.placement, at(f, b)),
  ]);
}

/**
 * A member's section by the plane `dot(normal, p) = k` (world, `normal` a unit vector): the
 * outline of the plane inside its blank less its cuts, as world segments; empty when the plane
 * misses it.
 */
export function memberSection(m: MemberData, normal: Vec3, k: number): Segment3[] {
  const n = toLocalDir(m.placement, normal);
  const kl = k - dot(normal, m.placement.origin);
  // An orthonormal basis of the plane, in the member's frame.
  const helper: Vec3 = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const e1u = cross(n, helper);
  const l1 = Math.hypot(...e1u);
  const e1: Vec3 = scale(e1u, 1 / l1);
  const e2 = cross(n, e1);
  const f: PlaneFrame = { o: scale(n, kl), e1, e2 };
  const region = regionOf(m, f, false);
  if (region === null) return [];
  return regionOutline(region.keep, region.notches).map(([a, b]): Segment3 => [
    toWorld(m.placement, at(f, a)),
    toWorld(m.placement, at(f, b)),
  ]);
}

/** Whether every corner of the member's blank satisfies `test` (world points). */
export function everyCorner(m: MemberData, test: (p: Vec3) => boolean): boolean {
  for (const a of [0, m.length])
    for (const b of [0, m.stock.width])
      for (const c of [0, m.stock.depth]) if (!test(toWorld(m.placement, [a, b, c]))) return false;
  return true;
}

/** The range of `dot(axis, p)` over the member's blank corners. */
export function cornerRange(m: MemberData, axis: Vec3): readonly [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const a of [0, m.length])
    for (const b of [0, m.stock.width])
      for (const c of [0, m.stock.depth]) {
        const v = dot(axis, toWorld(m.placement, [a, b, c]));
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
  return [lo, hi];
}
