// The construction domain's views (M6 plan T6.4a; ADR 0015 decision 9, the analytic drawing path):
// floor plans, framing elevations and roof framing plans, drawn from wall, opening, floor and roof
// metadata and the member sets. Pure; regen calls `constructionDrawings.view` for a drawing view
// whose source is `{ domain: 'construction', part, schemaVersion, params }` (`params.ts`).
//
// - A **floor plan** cuts the level at `cut` (default 4') above its datum: the kernel projects
//   the level's wall layer bodies and subfloors with that section (layers hatched where cut);
//   this draws the framing members' sections by the cut plane, door swings and window symbols,
//   and one chained string per wall segment outside it (corner, opening edges or centres, corner,
//   with the overall).
// - A **framing elevation** of a wall segment from outside or inside draws every member in the
//   wall's framing slab (the wall's and its openings', a neighbour's corner studs, a gable's studs
//   and end rafters), each as its outline with its cut lines; a string along the bottom (corner,
//   opening edges, corner, overall) with stud layout marks, one up the side (base, opening sills
//   and heads, top), and a pitch symbol for each roof that slopes across the view.
// - A **roof framing plan** draws the roof's members from above, with strings along the eave
//   (rafter layout marks) and the gable end.
//
// The short disclaimer is the domain's title note: regen puts it in the title block of every sheet
// showing a construction view (drawn or not) or a part with construction features. Every loop is over the part's
// features or members, linear, and the output is capped (`MAX_VIEW_LINES`, string points).

import type {
  DomainChain,
  DomainDrawings,
  DomainLine,
  DomainPitch,
  DomainViewContext,
  DomainViewOutput,
  DomainViewSet,
  MemberData,
} from '@manufakture/regen';
import { CONSTRUCTION_NAMESPACE, type ConstructionData } from '../data';
import { DISCLAIMER_SHORT } from '../disclaimer';
import {
  OPENING_TYPE,
  WALL_TYPE,
  framingBand,
  planSegments,
  readOpeningMetadata,
  readWallMetadata,
  type OpeningMetadata,
  type PlanSegment,
  type WallMetadata,
} from '../features/common';
import { FLOOR_TYPE, readFloorMetadata } from '../features/floor';
import { ROOF_TYPE, readRoofMetadata } from '../features/roof';
import type { RoofGeometry } from '../framing/roof';
import { dot, type Vec3 } from '../geom';
import { cornerRange, memberOutline, memberSection, type Segment3 } from './outline';
import { VIEW_PARAMS_VERSION, readViewParams, type OpeningStops, type PlanStrings } from './params';

/** regen's `MAX_DOMAIN_VIEW_LINES` (this package may not load regen at run time; a test pins it). */
export const MAX_VIEW_LINES = 400_000;
/** regen's `MAX_DOMAIN_CHAIN_POINTS` and `MAX_DOMAIN_CHAIN_MARKS`. */
export const MAX_CHAIN_POINTS = 1_000;
export const MAX_CHAIN_MARKS = 5_000;
/** regen's `MAX_DOMAIN_VIEW_ARCS`. */
export const MAX_VIEW_ARCS = 20_000;
/** regen's `MAX_DOMAIN_VIEW_SYMBOLS`. */
export const MAX_VIEW_SYMBOLS = 1_000;
/** regen's `MAX_DOMAIN_VIEW_WARNINGS`. */
const MAX_WARNINGS = 100;

/** The default plan cut above the level's datum, mm (4'). */
export const DEFAULT_PLAN_CUT = 1219.2;
/** Paper mm from the wall to a plan's or elevation's first string row. */
export const CHAIN_OFFSET = 10;
/**
 * Paper mm between an architectural plan's three strings: clear of a string's values staggered
 * the most `packages/drawing` staggers them (its `MAX_NUDGE` rows of 3.5 mm text).
 */
export const STRING_GAP = 14;
/** Model mm a member may stand outside a wall's framing slab and still be drawn in its elevation. */
const SLAB_TOLERANCE = 1;
/** Points closer than this along a string are one, mm. */
const SAME = 0.01;

const Z: Vec3 = [0, 0, 1];

type Out = { -readonly [K in keyof DomainViewOutput]: DomainViewOutput[K] } & {
  bodies: string[];
  lines: DomainLine[];
  arcs: NonNullable<DomainViewOutput['arcs']>[number][];
  chains: DomainChain[];
  pitches: DomainPitch[];
  warnings: { message: string; code?: string }[];
  /** Points and marks of the strings so far. */
  chainItems: number;
};

interface Wall {
  readonly id: string;
  readonly meta: WallMetadata;
}
interface Opening {
  readonly id: string;
  readonly meta: OpeningMetadata;
}

function emptyOut(direction: Vec3, up: Vec3): Out {
  return {
    direction,
    up,
    bodies: [],
    lines: [],
    arcs: [],
    chains: [],
    pitches: [],
    warnings: [],
    chainItems: 0,
  };
}

/** The view as regen takes it: without the bookkeeping. */
function finish(out: Out): DomainViewOutput {
  const view: Partial<Out> = { ...out };
  delete view.chainItems;
  return view as DomainViewOutput;
}

function warn(out: Out, message: string, code?: string): void {
  if (out.warnings.length < MAX_WARNINGS)
    out.warnings.push({ message, ...(code === undefined ? {} : { code }) });
}

/** Adds segments until the cap, warning once when it is reached. False once full. */
function addLines(out: Out, segments: readonly Segment3[], layer?: DomainLine['layer']): boolean {
  for (const [a, b] of segments) {
    if (out.lines.length >= MAX_VIEW_LINES) {
      if (!out.warnings.some((w) => w.code === 'too-many-lines'))
        warn(out, `The view draws only its first ${MAX_VIEW_LINES} lines`, 'too-many-lines');
      return false;
    }
    out.lines.push(layer === undefined ? { a, b } : { a, b, layer });
  }
  return true;
}

const v3 = (p: readonly [number, number], z: number): Vec3 => [p[0], p[1], z];
const along = (s: PlanSegment, t: number): readonly [number, number] => [
  s.a[0] + s.d[0] * t,
  s.a[1] + s.d[1] * t,
];
const across = (p: readonly [number, number], s: PlanSegment, t: number) =>
  [p[0] + s.n[0] * t, p[1] + s.n[1] * t] as const;

function walls(ctx: DomainViewContext): Wall[] {
  return ctx.features.flatMap((f) => {
    if (f.type !== WALL_TYPE) return [];
    const meta = readWallMetadata(f.metadata);
    return meta === undefined ? [] : [{ id: f.id, meta }];
  });
}

function openings(ctx: DomainViewContext): Opening[] {
  return ctx.features.flatMap((f) => {
    if (f.type !== OPENING_TYPE) return [];
    const meta = readOpeningMetadata(f.metadata);
    return meta === undefined || !f.dependsOn.includes(meta.wall) ? [] : [{ id: f.id, meta }];
  });
}

/** Positions along a segment a string stops at for its openings, sorted, in (0, length). */
function openingStops(list: readonly Opening[], stops: OpeningStops, length: number): number[] {
  const out: number[] = [];
  for (const o of list) {
    const p = o.meta.position;
    const w = o.meta.width;
    for (const t of stops === 'centre' ? [p] : [p - w / 2, p + w / 2])
      if (t > SAME && t < length - SAME) out.push(t);
  }
  return out.sort((a, b) => a - b);
}

/** regen's `MAX_DOMAIN_VIEW_CHAINS` and `MAX_DOMAIN_VIEW_CHAIN_ITEMS`. */
export const MAX_VIEW_CHAINS = 2_000;
export const MAX_VIEW_CHAIN_ITEMS = 200_000;

/** Adds a string unless the view has as many as regen takes (then a warning, once). */
function pushChain(out: Out, chain: DomainChain): void {
  const used = out.chainItems + chain.points.length + (chain.marks?.length ?? 0);
  if (out.chains.length >= MAX_VIEW_CHAINS || used > MAX_VIEW_CHAIN_ITEMS) {
    if (!out.warnings.some((w) => w.code === 'too-many-strings'))
      warn(
        out,
        `The view draws only its first ${out.chains.length} dimension strings`,
        'too-many-strings',
      );
    return;
  }
  out.chainItems = used;
  out.chains.push(chain);
}

/** A string's points, its repeats dropped, capped (with a warning). */
function capPoints(out: Out, points: Vec3[], what: string): Vec3[] {
  if (points.length <= MAX_CHAIN_POINTS) return points;
  warn(
    out,
    `The string ${what} stops at only its first ${MAX_CHAIN_POINTS} points`,
    'chain-points',
  );
  return points.slice(0, MAX_CHAIN_POINTS);
}

// Floor plan ---------------------------------------------------------------------------------------

/**
 * A door's swing: the leaf open square to the wall on the swing side (`in`, the default, is the
 * interior: left of the path) and the arc its edge sweeps to the other jamb. `hand` is as seen
 * from the side it swings into: `left` (the default) hinges on that viewer's left.
 */
function doorSwing(out: Out, wall: WallMetadata, seg: PlanSegment, o: OpeningMetadata, z: number) {
  const tIn = Math.max(
    ...wall.layers.map((l) => l.t[1]),
    framingBand(wall.justification, wall.thickness)[1],
  );
  const tOut = Math.min(
    ...wall.layers.map((l) => l.t[0]),
    framingBand(wall.justification, wall.thickness)[0],
  );
  const inward = o.swing !== 'out';
  const face = inward ? tIn : tOut;
  const side = inward ? 1 : -1;
  // Seen from inside facing the wall, the viewer's left is the segment's end.
  const hingeAtEnd = inward ? (o.hand ?? 'left') === 'left' : o.hand === 'right';
  const j0 = o.position - o.width / 2;
  const j1 = o.position + o.width / 2;
  const hinge = across(along(seg, hingeAtEnd ? j1 : j0), seg, face);
  const latch = across(along(seg, hingeAtEnd ? j0 : j1), seg, face);
  const tip = across(hinge, seg, side * o.width);
  addLines(out, [[v3(hinge, z), v3(tip, z)]]);
  // Counter-clockwise about +z from the open leaf to the closed position, or the other way.
  const u = [tip[0] - hinge[0], tip[1] - hinge[1]];
  const w = [latch[0] - hinge[0], latch[1] - hinge[1]];
  const ccw = u[0]! * w[1]! - u[1]! * w[0]! > 0;
  if (out.arcs.length < MAX_VIEW_ARCS)
    out.arcs.push({
      center: v3(hinge, z),
      normal: Z,
      from: v3(ccw ? tip : latch, z),
      to: v3(ccw ? latch : tip, z),
      layer: 'visible',
    });
}

/** A window in plan: a line across the rough opening at each face of the framing and one between. */
function windowSymbol(
  out: Out,
  wall: WallMetadata,
  seg: PlanSegment,
  o: OpeningMetadata,
  z: number,
) {
  const [t0, t1] = framingBand(wall.justification, wall.thickness);
  const a = along(seg, o.position - o.width / 2);
  const b = along(seg, o.position + o.width / 2);
  const lines: Segment3[] = [t0, (t0 + t1) / 2, t1].map((t) => [
    v3(across(a, seg, t), z),
    v3(across(b, seg, t), z),
  ]);
  addLines(out, lines);
}

function floorPlan(
  ctx: DomainViewContext,
  data: ConstructionData,
  level: string,
  cutExpression: unknown,
  stops: OpeningStops,
  strings: PlanStrings,
): DomainViewOutput | { error: string } {
  const lv = data.settings.levels.find((l) => l.id === level);
  if (lv === undefined)
    return { error: `the plan's level "${level}" is not one of the document's levels` };
  let cut = DEFAULT_PLAN_CUT;
  if (cutExpression !== undefined) {
    const r = ctx.evaluate(cutExpression, 'length');
    if (!r.ok) return { error: `the plan's cut height does not evaluate: ${r.message}` };
    cut = r.value;
  }
  if (!(Number.isFinite(cut) && Math.abs(cut) <= 100_000)) {
    return { error: 'the plan cut height must be a length within 100 m' };
  }
  const z = lv.elevation + cut;
  const out = emptyOut([0, 0, -1], [0, 1, 0]);
  out.section = { origin: [0, 0, z], normal: Z };
  const onLevel = walls(ctx).filter((w) => w.meta.level === level);
  const ids = new Set(onLevel.map((w) => w.id));
  const bodies = new Set(ctx.bodies);
  for (const w of onLevel)
    for (const l of w.meta.layers)
      if (l.body !== null && bodies.has(l.body)) out.bodies.push(l.body);
  for (const f of ctx.features) {
    if (f.type !== FLOOR_TYPE) continue;
    const meta = readFloorMetadata(f.metadata);
    if (meta?.level === level && meta.subfloor !== null && bodies.has(meta.subfloor))
      out.bodies.push(meta.subfloor);
  }
  // Members' sections by the cut plane: the framing layer has no body.
  for (const set of ctx.sets) {
    if (!ids.has(set.group)) continue;
    for (const m of set.members) if (!addLines(out, memberSection(m, Z, z))) break;
  }
  const byWall = new Map<string, Opening[]>();
  for (const o of openings(ctx)) {
    if (!ids.has(o.meta.wall)) continue;
    const list = byWall.get(o.meta.wall) ?? [];
    list.push(o);
    byWall.set(o.meta.wall, list);
  }
  for (const w of onLevel) {
    const segs = planSegments(w.meta.points, w.meta.closed);
    const list = byWall.get(w.id) ?? [];
    for (const o of list) {
      const seg = segs[o.meta.segment - 1];
      if (seg === undefined) continue;
      if (o.meta.type === 'door') doorSwing(out, w.meta, seg, o.meta, z);
      else if (o.meta.type === 'window') windowSymbol(out, w.meta, seg, o.meta, z);
    }
    if (stops === 'none') continue;
    segs.forEach((seg, i) => {
      const on = list.filter((o) => o.meta.segment === i + 1);
      // Outside: right of the path (the exterior).
      const side: Vec3 = [-seg.n[0], -seg.n[1], 0];
      if (strings === 'architectural') {
        // Opening centres nearest the wall, rough openings, then the overall; a segment with no
        // openings only its overall.
        const rows: { id: string; ts: number[] }[] = [];
        if (on.length > 0) {
          rows.push({
            id: 'centres',
            ts: [0, ...openingStops(on, 'centre', seg.length), seg.length],
          });
          rows.push({
            id: 'openings',
            ts: [0, ...openingStops(on, 'rough', seg.length), seg.length],
          });
        }
        rows.push({ id: 'overall', ts: [0, seg.length] });
        rows.forEach((row, k) =>
          pushChain(out, {
            id: `${w.id}:s${i + 1}:${row.id}`,
            kind: 'aligned',
            points: capPoints(
              out,
              row.ts.map((t) => v3(along(seg, t), z)),
              `of ${w.id}`,
            ),
            side,
            offset: CHAIN_OFFSET + k * STRING_GAP,
            overall: false,
          }),
        );
        return;
      }
      const ts = [0, ...openingStops(on, stops, seg.length), seg.length];
      pushChain(out, {
        id: `${w.id}:s${i + 1}`,
        kind: 'aligned',
        points: capPoints(
          out,
          ts.map((t) => v3(along(seg, t), z)),
          `of ${w.id}`,
        ),
        side,
        offset: CHAIN_OFFSET,
        overall: ts.length > 2,
      });
    });
  }
  return finish(out);
}

// Framing elevation ----------------------------------------------------------------------------------

/**
 * A pitch symbol for a roof that slopes across this view: on a gable roof's end walls, and on
 * every wall of a hip roof, a quarter of the way up the slope from the eave it rises from.
 */
function pitchFor(
  roofId: string,
  meta: NonNullable<ReturnType<typeof readRoofMetadata>>,
  geometry: RoofGeometry,
  seg: PlanSegment,
  base: readonly [number, number],
): DomainPitch | null {
  const fp = meta.input.footprint;
  const th = fp.direction ?? 0;
  const e1: readonly [number, number] = [Math.cos(th), Math.sin(th)];
  const V: readonly [number, number] = [-e1[1], e1[0]];
  const rel = [base[0] - fp.origin[0], base[1] - fp.origin[1]] as const;
  const alongV = Math.abs(seg.d[0] * V[0] + seg.d[1] * V[1]) > 1 - 1e-6;
  const alongE1 = Math.abs(seg.d[0] * e1[0] + seg.d[1] * e1[1]) > 1 - 1e-6;
  const run = fp.width / 4;
  const z = fp.plate + geometry.heightAbovePlate + Math.tan(meta.input.pitch) * run;
  if (alongV) {
    // Seen across a gable end (or a hip's end): rising from the eave at v = 0.
    const u = rel[0] * e1[0] + rel[1] * e1[1];
    const p = [
      fp.origin[0] + e1[0] * u + V[0] * run,
      fp.origin[1] + e1[1] * u + V[1] * run,
    ] as const;
    return {
      id: `${roofId}:pitch`,
      at: [p[0], p[1], z],
      pitch: meta.input.pitch,
      rises: [V[0], V[1], 0],
    };
  }
  if (alongE1 && meta.input.kind === 'hip') {
    const v = rel[0] * V[0] + rel[1] * V[1];
    const p = [
      fp.origin[0] + V[0] * v + e1[0] * run,
      fp.origin[1] + V[1] * v + e1[1] * run,
    ] as const;
    return {
      id: `${roofId}:pitch`,
      at: [p[0], p[1], z],
      pitch: meta.input.pitch,
      rises: [e1[0], e1[1], 0],
    };
  }
  return null;
}

function framingElevation(
  ctx: DomainViewContext,
  wallId: string,
  segment: number,
  from: 'outside' | 'inside',
  stops: OpeningStops,
  marks: boolean,
): DomainViewOutput | { error: string } {
  const wall = walls(ctx).find((w) => w.id === wallId);
  if (wall === undefined) return { error: `${wallId} is not a wall that built in this part` };
  const segs = planSegments(wall.meta.points, wall.meta.closed);
  const seg = segs[segment - 1];
  if (seg === undefined) return { error: `${wallId} has no segment ${segment}` };
  const n: Vec3 = [seg.n[0], seg.n[1], 0];
  const d: Vec3 = [seg.d[0], seg.d[1], 0];
  // From outside the viewer looks inwards (along the interior normal).
  const direction: Vec3 = from === 'outside' ? n : [-n[0], -n[1], 0];
  const out = emptyOut(direction, Z);
  const base = wall.meta.base;
  const top = base + wall.meta.height;

  // The framing slab across the segment, and its length along it.
  const [t0, t1] = framingBand(wall.meta.justification, wall.meta.thickness);
  const a0 = dot(n, [seg.a[0], seg.a[1], 0]);
  const s0 = dot(d, [seg.a[0], seg.a[1], 0]);
  const inSlab = (m: MemberData): boolean => {
    const [lo, hi] = cornerRange(m, n);
    if (lo < a0 + t0 - SLAB_TOLERANCE || hi > a0 + t1 + SLAB_TOLERANCE) return false;
    const [l, h] = cornerRange(m, d);
    return h > s0 + SLAB_TOLERANCE && l < s0 + seg.length - SLAB_TOLERANCE;
  };
  const studs: number[] = [];
  outer: for (const set of ctx.sets) {
    for (const m of set.members) {
      if (!inSlab(m)) continue;
      if (!addLines(out, memberOutline(m, direction))) break outer;
      if (set.group === wallId && m.role === 'stud' && studs.length < MAX_CHAIN_MARKS) {
        const [l, h] = cornerRange(m, d);
        studs.push((l + h) / 2 - s0);
      }
    }
  }

  const list = openings(ctx).filter((o) => o.meta.wall === wallId && o.meta.segment === segment);
  if (stops !== 'none') {
    const ts = [0, ...openingStops(list, stops, seg.length), seg.length];
    pushChain(out, {
      id: `${wallId}:s${segment}:along`,
      kind: 'horizontal',
      points: capPoints(
        out,
        ts.map((t) => v3(along(seg, t), base)),
        `along ${wallId}`,
      ),
      side: [0, 0, -1],
      offset: CHAIN_OFFSET,
      overall: ts.length > 2,
      ...(marks && studs.length > 0
        ? { marks: studs.sort((x, y) => x - y).map((t) => v3(along(seg, t), base)) }
        : {}),
    });
    // Up the side: base, each opening's sill and head (at its first jamb), top.
    const heights: { t: number; z: number }[] = [{ t: 0, z: base }];
    for (const o of [...list].sort((x, y) => x.meta.position - y.meta.position)) {
      const jamb = Math.max(0, o.meta.position - o.meta.width / 2);
      for (const h of [o.meta.sill, o.meta.sill + o.meta.height])
        if (h > SAME && h < wall.meta.height - SAME) heights.push({ t: jamb, z: base + h });
    }
    heights.push({ t: 0, z: top });
    const sorted = heights
      .sort((x, y) => x.z - y.z)
      .filter((h, i, all) => i === 0 || h.z - all[i - 1]!.z > SAME);
    pushChain(out, {
      id: `${wallId}:s${segment}:up`,
      kind: 'vertical',
      points: capPoints(
        out,
        sorted.map((h) => v3(along(seg, h.t), h.z)),
        `up ${wallId}`,
      ),
      side: [-d[0], -d[1], 0],
      offset: CHAIN_OFFSET,
      overall: sorted.length > 2,
    });
  }

  // Pitch symbols of the roofs this wall carries (one lookup per roof: the sets by group).
  const setsByGroup = new Map(ctx.sets.map((x) => [x.group, x]));
  for (const f of ctx.features) {
    if (f.type !== ROOF_TYPE || out.pitches.length >= MAX_VIEW_SYMBOLS) continue;
    const meta = readRoofMetadata(f.metadata);
    if (meta === undefined || !meta.walls.includes(wallId)) continue;
    const geometry = roofGeometry(setsByGroup.get(f.id));
    if (geometry === undefined) continue;
    const symbol = pitchFor(f.id, meta, geometry, seg, seg.a);
    if (symbol !== null) out.pitches.push(symbol);
  }
  return finish(out);
}

function roofGeometry(set: DomainViewSet | undefined): RoofGeometry | undefined {
  const m = set?.metadata;
  if (typeof m !== 'object' || m === null || Array.isArray(m)) return undefined;
  const g = (m as Record<string, unknown>).geometry;
  if (typeof g !== 'object' || g === null) return undefined;
  const geometry = g as unknown as RoofGeometry;
  return Number.isFinite(geometry.heightAbovePlate) ? geometry : undefined;
}

// Roof framing plan --------------------------------------------------------------------------------

function roofPlan(ctx: DomainViewContext, roofId: string): DomainViewOutput | { error: string } {
  const f = ctx.features.find((x) => x.id === roofId && x.type === ROOF_TYPE);
  const meta = readRoofMetadata(f?.metadata);
  if (meta === undefined) return { error: `${roofId} is not a roof that built in this part` };
  const out = emptyOut([0, 0, -1], [0, 1, 0]);
  const set = ctx.sets.find((s) => s.group === roofId);
  const view: Vec3 = [0, 0, -1];
  const fp = meta.input.footprint;
  const th = fp.direction ?? 0;
  const e1: Vec3 = [Math.cos(th), Math.sin(th), 0];
  const V: Vec3 = [-e1[1], e1[0], 0];
  const o: Vec3 = [fp.origin[0], fp.origin[1], fp.plate];
  const at = (u: number, v: number): Vec3 => [
    o[0] + e1[0] * u + V[0] * v,
    o[1] + e1[1] * u + V[1] * v,
    o[2],
  ];
  const rafters: number[] = [];
  for (const m of set?.members ?? []) {
    if (!addLines(out, memberOutline(m, view))) break;
    if (m.role === 'common-rafter' && rafters.length < MAX_CHAIN_MARKS) {
      const [l, h] = cornerRange(m, e1);
      rafters.push((l + h) / 2 - dot(e1, o));
    }
  }
  pushChain(out, {
    id: `${roofId}:eave`,
    kind: 'aligned',
    points: [at(0, 0), at(fp.length, 0)],
    side: [-V[0], -V[1], 0],
    offset: CHAIN_OFFSET,
    overall: false,
    ...(rafters.length > 0 ? { marks: rafters.sort((x, y) => x - y).map((u) => at(u, 0)) } : {}),
  });
  pushChain(out, {
    id: `${roofId}:end`,
    kind: 'aligned',
    points: [at(0, 0), at(0, fp.width)],
    side: [-e1[0], -e1[1], 0],
    offset: CHAIN_OFFSET,
    overall: false,
  });
  return finish(out);
}

// The domain's views ---------------------------------------------------------------------------------

/** One construction view from its params; an `error` when the params or the part cannot give it. */
export function constructionView(ctx: DomainViewContext): DomainViewOutput | { error: string } {
  const params = readViewParams(ctx.params, ctx.schemaVersion);
  if (!params.ok) {
    const at = params.field && params.field.length > 0 ? ` (params.${params.field.join('.')})` : '';
    return { error: `${params.message}${at}` };
  }
  const p = params.value;
  let view: DomainViewOutput | { error: string };
  if (p.kind === 'elevation')
    view = framingElevation(ctx, p.wall, p.segment, p.from, p.openings, p.marks);
  else if (p.kind === 'roof-plan') view = roofPlan(ctx, p.roof);
  else {
    const data = Object.hasOwn(ctx.data, CONSTRUCTION_NAMESPACE)
      ? (ctx.data[CONSTRUCTION_NAMESPACE] as ConstructionData)
      : undefined;
    if (data === undefined) return { error: 'the document has no construction settings (levels)' };
    view = floorPlan(ctx, data, p.level, p.cut, p.openings, p.strings);
  }
  // Strings the view hides (put away, or converted to dimensions): linear in the strings.
  if ('error' in view || p.hide.length === 0 || view.chains === undefined) return view;
  const hide = new Set(p.hide);
  return { ...view, chains: view.chains.filter((c) => !hide.has(c.id)) };
}

/** The construction domain's views, as `ExtensionDomain.drawings` takes them. */
export const constructionDrawings: DomainDrawings = {
  schemaVersion: VIEW_PARAMS_VERSION,
  // On every sheet that shows a construction view or a part with construction features.
  titleNote: DISCLAIMER_SHORT,
  view(ctx) {
    return constructionView(ctx);
  },
};
