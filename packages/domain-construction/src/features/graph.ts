// The wall graph of a part (M6 plan T6.1b): which walls meet, and how each wall's segments are
// framed at their ends. Pure plan geometry on the walls' metadata; the member stage (`stage.ts`)
// feeds the result to `frameWall` as framed segment ends, joins and tees.
//
// - **Corners inside one wall**: segment i runs through at its end and segment i + 1 butts into
//   it (for a closed path, the last segment runs through and the first butts).
// - **L corners between walls**: two open wall ends at one point (within `MEET`), on one level.
//   The wall with the lower feature number (created first) runs through; the other butts. The
//   number, not the order in the feature list, so reordering features changes no framing.
// - **Tees**: an open wall end on the inside of another wall's segment butts into it; the other
//   wall gets a tee there.
// - **Running through** means the framing reaches the corner's outside: along its centre line, as
//   far as the far side of the other wall's framing. **Butting** means it stops at the near side
//   of the other wall's framing. Both are measured on the framing's centre line, so a corner at
//   any angle frames with square ends, which is what `frameWall` lays out.
// - Walls whose segments cross away from their ends, on one level, are refused (`crossings`).
//   Three or more wall ends at one point, or an end on another wall's corner point, are left free
//   with a layout warning. An end set to `free` never joins.
//
// Layer bodies are the wall translator's, which cannot see this graph: a translator reads only
// the walls it names in `dependsOn`. `layerJoins` finds, by the same rules, where a wall joins its
// layers with those walls (task #1172); walls that do not name each other keep square layer ends.

import type { WallJoin, WallSegment, WallTee } from '../framing/wall';
import {
  add2,
  cross2,
  dot2,
  framingBand,
  planSegments,
  scale2,
  sub2,
  type P2,
  type PlanSegment,
  type WallMetadata,
} from './common';

/** Ends closer than this meet, mm. */
export const MEET = 0.5;
/** The most wall segments the graph of one part takes (pairs are checked for crossings). */
export const MAX_GRAPH_SEGMENTS = 5_000;

export interface GraphWall {
  readonly id: string;
  readonly meta: WallMetadata;
}

export interface GraphWarning {
  readonly wall: string;
  readonly code: 'join-unresolved';
  readonly message: string;
}

type End = 'start' | 'end';

/** How one end of one wall's segment is framed. */
interface EndJoin {
  readonly kind: 'through' | 'butt' | 'tee';
  /** The other segment's plan geometry and framing band (with its wall's thickness). */
  readonly other: Band;
  /** The meeting point. */
  readonly at: P2;
}

interface Band {
  readonly wall: string;
  readonly seg: PlanSegment;
  readonly lo: number;
  readonly hi: number;
  readonly thickness: number;
}

/** A tee on a wall's segment: another wall's end butting into it. */
interface TeeOn {
  readonly segment: number;
  readonly other: Band;
  /** The other wall's end, on this segment's path. */
  readonly at: P2;
  /** Direction into the other wall from its end. */
  readonly into: P2;
}

export interface WallGraph {
  /** Per wall: per segment, the join at its start and end (absent: free). */
  readonly ends: ReadonlyMap<string, readonly { start?: EndJoin; end?: EndJoin }[]>;
  readonly tees: ReadonlyMap<string, readonly TeeOn[]>;
  /** Walls each wall meets (corners and tees, either way) or crosses. */
  readonly neighbours: ReadonlyMap<string, ReadonlySet<string>>;
  /** Wall pairs whose segments cross away from their ends: `[a, b]`, each pair once. */
  readonly crossings: readonly (readonly [string, string])[];
  readonly warnings: readonly GraphWarning[];
}

const featureNumber = (id: string): number => Number(id.slice(id.indexOf('#') + 1));

/** Whether `a` was created before `b` (feature numbers, then ids, so the order is total). */
const before = (a: string, b: string): boolean => {
  const na = featureNumber(a);
  const nb = featureNumber(b);
  return na !== nb ? na < nb : a < b;
};

const sameLevel = (a: WallMetadata, b: WallMetadata): boolean =>
  a.level === b.level && Math.abs(a.base - b.base) <= MEET;

const near = (a: P2, b: P2): boolean => Math.hypot(a[0] - b[0], a[1] - b[1]) <= MEET;

function bandOf(wall: string, meta: WallMetadata, seg: PlanSegment): Band {
  const [lo, hi] = framingBand(meta.justification, meta.thickness);
  return { wall, seg, lo, hi, thickness: meta.thickness };
}

/** The wall graph of the walls of one part. Throws when the part has too many wall segments. */
export function wallGraph(walls: readonly GraphWall[]): WallGraph {
  const segsOf = new Map(
    walls.map((w) => [w.id, planSegments(w.meta.points, w.meta.closed)] as const),
  );
  const total = [...segsOf.values()].reduce((n, s) => n + s.length, 0);
  if (total > MAX_GRAPH_SEGMENTS) {
    throw new Error(
      `the part has ${total} wall segments, more than the ${MAX_GRAPH_SEGMENTS} one part may frame`,
    );
  }
  const ends = new Map<string, { start?: EndJoin; end?: EndJoin }[]>();
  const tees = new Map<string, TeeOn[]>();
  const neighbours = new Map<string, Set<string>>();
  const warnings: GraphWarning[] = [];
  const meet = (a: string, b: string) => {
    neighbours.get(a)!.add(b);
    neighbours.get(b)!.add(a);
  };
  for (const w of walls) {
    const segs = segsOf.get(w.id)!;
    ends.set(
      w.id,
      segs.map(() => ({})),
    );
    tees.set(w.id, []);
    neighbours.set(w.id, new Set());
    // Corners inside the wall: segment i through at its end, i + 1 butting at its start.
    const corners = w.meta.closed ? segs.length : segs.length - 1;
    for (let i = 0; i < corners; i++) {
      const a = segs[i]!;
      const b = segs[(i + 1) % segs.length]!;
      const at = a.b;
      ends.get(w.id)![i]!.end = { kind: 'through', other: bandOf(w.id, w.meta, b), at };
      ends.get(w.id)![(i + 1) % segs.length]!.start = {
        kind: 'butt',
        other: bandOf(w.id, w.meta, a),
        at,
      };
    }
  }

  // Open ends.
  interface OpenEnd {
    wall: GraphWall;
    end: End;
    segment: number;
    point: P2;
  }
  const open: OpenEnd[] = [];
  for (const w of walls) {
    if (w.meta.closed) continue;
    const segs = segsOf.get(w.id)!;
    if (!w.meta.free.start) open.push({ wall: w, end: 'start', segment: 0, point: segs[0]!.a });
    if (!w.meta.free.end) {
      open.push({ wall: w, end: 'end', segment: segs.length - 1, point: segs.at(-1)!.b });
    }
  }
  const warn = (wall: string, message: string) =>
    warnings.push({ wall, code: 'join-unresolved', message });
  const segOf = (e: OpenEnd) => segsOf.get(e.wall.id)![e.segment]!;
  for (const e of open) {
    const at = open.filter(
      (o) =>
        o.wall.id !== e.wall.id && sameLevel(o.wall.meta, e.wall.meta) && near(o.point, e.point),
    );
    if (at.length > 1) {
      warn(
        e.wall.id,
        `More than two wall ends meet at the ${e.end} of ${e.wall.id}; that end is framed as a free end.`,
      );
      continue;
    }
    if (at.length === 1) {
      const o = at[0]!;
      const mine = segOf(e);
      const theirs = segOf(o);
      const into = e.end === 'start' ? mine.d : scale2(mine.d, -1);
      // Collinear walls meeting end to end are not a corner: both ends stay free.
      if (Math.abs(dot2(into, theirs.n)) < 1e-6) continue;
      const kind = before(e.wall.id, o.wall.id) ? 'through' : 'butt';
      ends.get(e.wall.id)![e.segment]![e.end] = {
        kind,
        other: bandOf(o.wall.id, o.wall.meta, theirs),
        at: e.point,
      };
      meet(e.wall.id, o.wall.id);
      continue;
    }
    // A tee: the end on the inside of another wall's segment, or on its corner point.
    let found = false;
    for (const x of walls) {
      if (x.id === e.wall.id || !sameLevel(x.meta, e.wall.meta) || found) continue;
      const segs = segsOf.get(x.id)!;
      for (let j = 0; j < segs.length && !found; j++) {
        const s = segs[j]!;
        const along = dot2(sub2(e.point, s.a), s.d);
        const off = dot2(sub2(e.point, s.a), s.n);
        if (Math.abs(off) > MEET || along < -MEET || along > s.length + MEET) continue;
        found = true;
        meet(e.wall.id, x.id);
        if (along <= MEET || along >= s.length - MEET) {
          warn(
            e.wall.id,
            `The ${e.end} of ${e.wall.id} meets a corner of ${x.id}; it is framed as a free end.`,
          );
          continue;
        }
        const mine = segOf(e);
        const into = e.end === 'start' ? mine.d : scale2(mine.d, -1);
        if (Math.abs(dot2(into, s.n)) < 1e-6) continue;
        const band = bandOf(x.id, x.meta, s);
        ends.get(e.wall.id)![e.segment]![e.end] = { kind: 'tee', other: band, at: e.point };
        tees.get(x.id)!.push({
          segment: j,
          other: bandOf(e.wall.id, e.wall.meta, mine),
          at: e.point,
          into,
        });
      }
    }
  }

  // Crossings: segments of two walls on one level that cross away from both walls' ends.
  const crossings: [string, string][] = [];
  for (let i = 0; i < walls.length; i++) {
    for (let k = i + 1; k < walls.length; k++) {
      const a = walls[i]!;
      const b = walls[k]!;
      if (!sameLevel(a.meta, b.meta)) continue;
      if (crosses(segsOf.get(a.id)!, segsOf.get(b.id)!)) {
        crossings.push([a.id, b.id]);
        meet(a.id, b.id);
      }
    }
  }
  return { ends, tees, neighbours, crossings, warnings };
}

/** Whether two walls' segments cross at a point away from every segment end of either. */
function crosses(as: readonly PlanSegment[], bs: readonly PlanSegment[]): boolean {
  for (const a of as) {
    for (const b of bs) {
      if (
        Math.max(a.a[0], a.b[0]) < Math.min(b.a[0], b.b[0]) - MEET ||
        Math.max(b.a[0], b.b[0]) < Math.min(a.a[0], a.b[0]) - MEET ||
        Math.max(a.a[1], a.b[1]) < Math.min(b.a[1], b.b[1]) - MEET ||
        Math.max(b.a[1], b.b[1]) < Math.min(a.a[1], a.b[1]) - MEET
      ) {
        continue;
      }
      const den = cross2(a.d, b.d);
      if (Math.abs(den) < 1e-9) continue;
      const w = sub2(b.a, a.a);
      const s = cross2(w, b.d) / den;
      const t = cross2(w, a.d) / den;
      if (s > MEET && s < a.length - MEET && t > MEET && t < b.length - MEET) return true;
    }
  }
  return false;
}

// Framed segments --------------------------------------------------------------------------------

/**
 * Where the framing of a wall stops along `seg` at the meeting point, for the join's kind: how
 * far past the meeting point it runs (through), or how far short of it it stops (butting, tees),
 * measured on this wall's framing centre line.
 */
function endOffset(meta: WallMetadata, seg: PlanSegment, end: End, join: EndJoin): number {
  const [lo, hi] = framingBand(meta.justification, meta.thickness);
  const centre = (lo + hi) / 2;
  const into = end === 'start' ? seg.d : scale2(seg.d, -1);
  const o = join.other;
  const nn = dot2(seg.n, o.seg.n);
  const den = dot2(into, o.seg.n);
  // This wall's centre line, `point + n centre + into u`, meets the other's band line `t` at u.
  const us = [o.lo, o.hi].map((t) => (t - centre * nn) / den);
  return join.kind === 'through' ? Math.max(...us.map((u) => -u)) : Math.max(...us);
}

/** A wall's segments as `frameWall` takes them (no openings), and each one's start shift. */
export interface FramedWall {
  readonly segments: WallSegment[];
  /** Per segment: where its framing starts along its path, from the path point, mm. */
  readonly shifts: number[];
}

export function framedWall(graph: WallGraph, wall: GraphWall): FramedWall {
  const meta = wall.meta;
  const segs = planSegments(meta.points, meta.closed);
  const joins = graph.ends.get(wall.id)!;
  const shifts: number[] = [];
  const ranges = segs.map((seg, i) => {
    const j = joins[i]!;
    const at = (end: End, e: EndJoin | undefined): number => {
      if (e === undefined) return 0;
      const d = endOffset(meta, seg, end, e);
      return e.kind === 'through' ? -d : d;
    };
    return [at('start', j.start), seg.length - at('end', j.end)] as const;
  });
  const segments = segs.map((seg, i): WallSegment => {
    const [s0, s1] = ranges[i]!;
    shifts.push(s0);
    const j = joins[i]!;
    const joinOf = (e: EndJoin | undefined): WallJoin =>
      e === undefined
        ? { kind: 'free' }
        : e.kind === 'tee'
          ? { kind: 'T', otherThickness: e.other.thickness }
          : { kind: 'L', through: e.kind === 'through', otherThickness: e.other.thickness };
    const tees: WallTee[] = (graph.tees.get(wall.id) ?? [])
      .filter((t) => t.segment === i)
      .map((t) => ({ at: teeCentre(meta, seg, t) - s0, otherThickness: t.other.thickness }))
      .sort((a, b) => a.at - b.at);
    const pt = (s: number): [number, number] => {
      const p = add2(seg.a, scale2(seg.d, s));
      return [p[0], p[1]];
    };
    return {
      start: pt(s0),
      end: pt(s1),
      base: meta.base,
      height: meta.height,
      thickness: meta.thickness,
      justification: meta.justification,
      joins: { start: joinOf(j.start), end: joinOf(j.end) },
      ...(tees.length === 0 ? {} : { tees }),
    };
  });
  return { segments, shifts };
}

/** Where the meeting wall's framing centre line crosses this segment's, along its path. */
function teeCentre(meta: WallMetadata, seg: PlanSegment, tee: TeeOn): number {
  const [lo, hi] = framingBand(meta.justification, meta.thickness);
  const mine = (lo + hi) / 2;
  const o = tee.other;
  const theirs = (o.lo + o.hi) / 2;
  // The other centre line: at + n_o theirs + into u; on this centre line when its t is `mine`.
  const start = add2(tee.at, scale2(o.seg.n, theirs));
  const u = (mine - dot2(sub2(start, seg.a), seg.n)) / dot2(tee.into, seg.n);
  return dot2(sub2(add2(start, scale2(tee.into, u)), seg.a), seg.d);
}

// Layer joins ------------------------------------------------------------------------------------

/**
 * The most walls one wall joins its layers with: the walls in its `dependsOn`. Each is checked
 * against the wall's two ends and its segments, so the work is linear in this bound.
 */
export const MAX_LAYER_JOIN_WALLS = 64;

/**
 * Where a wall's layers join another wall's, found by the wall whose `dependsOn` names the other
 * (the later of the two), with the wall graph's rules so the layers join where the framing does:
 *
 * - `corner`: this wall's `end` meets `other`'s `otherEnd` (an L);
 * - `branch`: this wall's `end` lies inside `other`'s segment `segment` (0-based): a tee in it;
 * - `host`: `other`'s `otherEnd` lies inside this wall's segment `segment`: a tee in this wall.
 *
 * Ends set `free`, ends where three or more walls meet (of those this wall sees), ends on a corner
 * point of the other wall's path and collinear walls do not join, as in `wallGraph`.
 */
export type LayerJoin =
  | {
      readonly kind: 'corner';
      readonly other: GraphWall;
      readonly end: End;
      readonly otherEnd: End;
    }
  | {
      readonly kind: 'branch';
      readonly other: GraphWall;
      readonly end: End;
      readonly segment: number;
    }
  | {
      readonly kind: 'host';
      readonly other: GraphWall;
      readonly otherEnd: End;
      readonly segment: number;
    };

export type WallEnd = End;

/** A wall's joinable ends: open, not `free`, with the end point. */
function openEnds(meta: WallMetadata, segs: readonly PlanSegment[]): { end: End; point: P2 }[] {
  if (meta.closed || segs.length === 0) return [];
  const out: { end: End; point: P2 }[] = [];
  if (!meta.free.start) out.push({ end: 'start', point: segs[0]!.a });
  if (!meta.free.end) out.push({ end: 'end', point: segs.at(-1)!.b });
  return out;
}

/** The direction from a wall's end into the wall, along its end segment. */
export function intoWall(segs: readonly PlanSegment[], end: End): P2 {
  return end === 'start' ? segs[0]!.d : scale2(segs.at(-1)!.d, -1);
}

/** Which segment of `segs` (0-based) has `p` on its path inside it, or undefined. */
function segmentAt(
  segs: readonly PlanSegment[],
  p: P2,
): { segment: number; inside: boolean } | undefined {
  for (let j = 0; j < segs.length; j++) {
    const s = segs[j]!;
    const along = dot2(sub2(p, s.a), s.d);
    const off = dot2(sub2(p, s.a), s.n);
    if (Math.abs(off) > MEET || along < -MEET || along > s.length + MEET) continue;
    return { segment: j, inside: along > MEET && along < s.length - MEET };
  }
  return undefined;
}

/**
 * The layer joins of `self` with the walls it names in `dependsOn` (`upstream`). Throws when
 * `upstream` holds more than `MAX_LAYER_JOIN_WALLS` walls.
 */
export function layerJoins(self: GraphWall, upstream: readonly GraphWall[]): LayerJoin[] {
  if (upstream.length > MAX_LAYER_JOIN_WALLS) {
    throw new Error(
      `the wall names ${upstream.length} walls in dependsOn; it joins its layers with at most ${MAX_LAYER_JOIN_WALLS}`,
    );
  }
  const others = upstream
    .filter((w) => w.id !== self.id && sameLevel(w.meta, self.meta))
    .sort((a, b) => (before(a.id, b.id) ? -1 : 1));
  const segsOf = new Map(
    [self, ...others].map((w) => [w.id, planSegments(w.meta.points, w.meta.closed)] as const),
  );
  const mySegs = segsOf.get(self.id)!;
  const mine = openEnds(self.meta, mySegs);
  const theirs = others.flatMap((w) =>
    openEnds(w.meta, segsOf.get(w.id)!).map((e) => ({ wall: w, ...e })),
  );
  const joins: LayerJoin[] = [];

  for (const e of mine) {
    const into = intoWall(mySegs, e.end);
    const at = theirs.filter((o) => near(o.point, e.point));
    if (at.length > 1) continue;
    if (at.length === 1) {
      const o = at[0]!;
      const oInto = intoWall(segsOf.get(o.wall.id)!, o.end);
      // Collinear walls meeting end to end are not a corner.
      if (Math.abs(cross2(into, oInto)) < 1e-6) continue;
      joins.push({ kind: 'corner', other: o.wall, end: e.end, otherEnd: o.end });
      continue;
    }
    for (const w of others) {
      const hit = segmentAt(segsOf.get(w.id)!, e.point);
      if (hit === undefined) continue;
      const s = segsOf.get(w.id)![hit.segment]!;
      if (hit.inside && Math.abs(dot2(into, s.n)) >= 1e-6) {
        joins.push({ kind: 'branch', other: w, end: e.end, segment: hit.segment });
      }
      break;
    }
  }

  // Their ends on this wall's segments (not at one of its ends, nor where they meet each other).
  for (const o of theirs) {
    if (mine.some((e) => near(e.point, o.point))) continue;
    if (theirs.some((x) => x !== o && near(x.point, o.point))) continue;
    const hit = segmentAt(mySegs, o.point);
    if (hit === undefined || !hit.inside) continue;
    const oInto = intoWall(segsOf.get(o.wall.id)!, o.end);
    if (Math.abs(dot2(oInto, mySegs[hit.segment]!.n)) < 1e-6) continue;
    joins.push({ kind: 'host', other: o.wall, otherEnd: o.end, segment: hit.segment });
  }
  return joins;
}
