// The wall feature, `construction.wall` (M6 plan T6.1b, ADR 0015 decisions 2, 3 and 5): a path in
// plan on a level, framed by its wall type's stud layer and covered by its sheet layers.
//
// - **Params** (schemaVersion 1): `level` and `wallType` (ids in `domains.construction`, which
//   are data, not model ids), `points` (how many path points; their coordinates are the
//   expressions `x1`, `y1` .. `xn`, `yn`), `closed`, `justification` (where the framing lies
//   across the path: `left`, the default, puts it on the left, so the path is the framing's
//   exterior face; the exterior is always on the path's right), `joins` (`free` keeps an end from
//   joining another wall), `framing` (overrides of the document's framing settings that are not
//   lengths) and `overrides` (per-member, keyed by local id: `s12`, `top1:2`). Lengths are
//   expressions: `height` (default the level's), `spacing`, `layoutOrigin`, and `move_<n>`, the
//   nudge of the n-th override.
// - **Layer bodies** (decision 3): each sheet layer of the wall type (siding, sheathing, drywall)
//   is one body, `<id>:layer/<layer id>`, an extrusion of the layer's outline in plan up the
//   wall's height. The outline follows the whole path, so the layers are mitred at the wall's own
//   corners (and around a closed path). Faces: `<id>:side:<layer>.ext<i>` and `.int<i>` (the
//   exterior and interior faces along segment i), `.start` and `.end` (an open wall's ends),
//   `<id>:cap.<layer>:start` (bottom) and `:end` (top).
// - **Layer joins** (a T6.1b follow-up): a wall joins its layers with the walls it names in `dependsOn` where
//   the wall graph joins their framing (`layerJoins` in `graph.ts`). At an L both walls' layers
//   end on the corner's bisector, as at a corner of one path; at a tee the branch's layers end on
//   the host's layer face and the host's layers on that side are notched where the branch's
//   framing passes. This wall's own outline takes its share; the other wall's bodies (and, as a
//   tee's host, its own) change through one `tools` input after the extrusions, so the layer face
//   names stay as they were. Walls that do not name each other are not joined: their layers stop
//   square at their path ends. Only their framing joins then (in the member stage).
// - **Operation**: `new` makes the layer bodies; a wall with no operation makes none (a wall type
//   with no sheet layers, or framing only). Openings cut the layers through `tools` (`opening.ts`).
// - **Metadata** (decision 5): the wall's geometry, layers and resolved framing settings, which
//   the member stage (`stage.ts`) frames with the wall's openings and the walls it meets.
//
// Not an engineering tool (decision 8): every size is the user's choice; nothing here checks
// loads, spans or a code.

import type {
  ExtrudeInput,
  FeatureInput,
  ProfileEntity,
  ProfileLoop,
  ToolItem,
} from '@manufakture/kernel';
import type {
  ExpressionKind,
  ExtensionContext,
  ExtensionOutput,
  ExtensionType,
} from '@manufakture/regen';
import {
  currentVersion,
  fail,
  isObject,
  migrate,
  ok,
  onlyKeys,
  own,
  readEnum,
  type Json,
  type Read,
  type Versioned,
} from '@manufakture/stock';
import {
  layerThickness,
  type ConstructionSettings,
  type FramingLayer,
  type HeaderData,
  type WallType,
} from '../data';
import {
  FramingInputError,
  resolveWallSettings,
  type BlockingRows,
  type CornerStyle,
  type HeaderSpec,
  type Justification,
  type WallSettingsInput,
} from '../framing/wall';
import { DATA_ID_PATTERN, findLevel } from '../levels';
import {
  MAX_COORDINATE,
  MAX_LAYER_THICKNESS,
  MAX_OVERRIDES,
  MAX_SEGMENT_LENGTH,
  MAX_WALL_HEIGHT,
  MAX_WALL_POINTS,
  MIN_FEATURE_SPACING,
  Refusal,
  WALL_TYPE,
  add2,
  constructionData,
  cross2,
  dot2,
  failure,
  framingBand,
  moveExpression,
  planSegments,
  readOptionalCount,
  readOverrides,
  readWallMetadata,
  resolveOverrides,
  scale2,
  stockData,
  sub2,
  stockFor,
  toJson,
  type LayerMetadata,
  type P2,
  type PlanSegment,
  type StoredOverride,
  type WallMetadata,
} from './common';
import { intoWall, layerJoins, type GraphWall, type LayerJoin, type WallEnd } from './graph';

/** The framing settings a wall may override in its params (lengths are expressions). */
export interface WallFramingParams {
  readonly layoutFrom?: 'start' | 'end';
  readonly bottomPlates?: number;
  readonly topPlates?: number;
  readonly kings?: number;
  readonly cornerStyle?: CornerStyle;
  readonly blocking?: 'none' | 'mid-height';
}

/** How an end of a wall joins others: found from the walls it meets (`auto`), or never (`free`). */
export type WallEndJoin = 'auto' | 'free';

export interface WallParams {
  readonly level: string;
  readonly wallType: string;
  /** How many path points; their coordinates are the expressions `x<i>`, `y<i>` (from 1). */
  readonly points: number;
  readonly closed: boolean;
  readonly justification: Justification;
  readonly joins: { readonly start: WallEndJoin; readonly end: WallEndJoin };
  readonly framing: WallFramingParams;
  readonly overrides: readonly StoredOverride[];
}

/** The params migrations of `construction.wall` (none yet: version 1 is current). */
export const WALL_PARAMS: Versioned = { what: '"construction.wall" params', migrations: [] };
export const WALL_SCHEMA_VERSION = currentVersion(WALL_PARAMS);

/** Every expression a wall may have, with its kind. */
export const WALL_EXPRESSIONS: Readonly<Record<string, ExpressionKind>> = Object.freeze(
  Object.fromEntries([
    ['height', 'length'],
    ['spacing', 'length'],
    ['layoutOrigin', 'length'],
    ...Array.from({ length: MAX_WALL_POINTS }, (_, i) => [
      [`x${i + 1}`, 'length'],
      [`y${i + 1}`, 'length'],
    ]).flat(),
    ...Array.from({ length: MAX_OVERRIDES }, (_, i) => [moveExpression(i + 1), 'length']),
  ]) as Record<string, ExpressionKind>,
);

const JUSTIFICATIONS: readonly Justification[] = ['left', 'center', 'right'];
const CORNER_STYLES: readonly CornerStyle[] = ['two-stud', 'three-stud', 'ladder'];
const END_JOINS: readonly WallEndJoin[] = ['auto', 'free'];

function readDataRef(v: unknown, key: string, what: string): Read<string> {
  return typeof v === 'string' && DATA_ID_PATTERN.test(v)
    ? ok(v)
    : fail(`expected the id of a ${what} in the construction settings`, [key]);
}

function readFramingParams(v: unknown): Read<WallFramingParams> {
  if (v === undefined) return ok({});
  const at = ['framing'];
  if (!isObject(v)) return fail('expected framing overrides', at);
  const keys = onlyKeys(
    v,
    ['layoutFrom', 'bottomPlates', 'topPlates', 'kings', 'cornerStyle', 'blocking'],
    at,
  );
  if (!keys.ok) return keys;
  const out: Record<string, unknown> = {};
  const enums: [string, readonly string[]][] = [
    ['layoutFrom', ['start', 'end']],
    ['cornerStyle', CORNER_STYLES],
    ['blocking', ['none', 'mid-height']],
  ];
  for (const [key, values] of enums) {
    const raw = own(v, key);
    if (raw === undefined) continue;
    const r = readEnum(raw, values, [...at, key]);
    if (!r.ok) return r;
    out[key] = r.value;
  }
  for (const [key, hi] of [
    ['bottomPlates', 3],
    ['topPlates', 3],
    ['kings', 4],
  ] as const) {
    const r = readOptionalCount(v, key, at, 1, hi);
    if (!r.ok) return r;
    if (r.value !== undefined) out[key] = r.value;
  }
  return ok(out as WallFramingParams);
}

function readJoins(v: unknown): Read<WallParams['joins']> {
  const out = { start: 'auto' as WallEndJoin, end: 'auto' as WallEndJoin };
  if (v === undefined) return ok(out);
  if (!isObject(v)) return fail('expected { start?, end? }', ['joins']);
  const keys = onlyKeys(v, ['start', 'end'], ['joins']);
  if (!keys.ok) return keys;
  for (const end of ['start', 'end'] as const) {
    const raw = own(v, end);
    if (raw === undefined) continue;
    const r = readEnum(raw, END_JOINS, ['joins', end]);
    if (!r.ok) return r;
    out[end] = r.value;
  }
  return ok(out);
}

function readCurrent(params: Json): Read<WallParams> {
  if (!isObject(params)) return fail('expected the wall params object');
  const keys = onlyKeys(
    params,
    ['level', 'wallType', 'points', 'closed', 'justification', 'joins', 'framing', 'overrides'],
    [],
  );
  if (!keys.ok) return keys;
  const level = readDataRef(own(params, 'level'), 'level', 'level');
  if (!level.ok) return level;
  const wallType = readDataRef(own(params, 'wallType'), 'wallType', 'wall type');
  if (!wallType.ok) return wallType;
  const closedRaw = own(params, 'closed');
  if (closedRaw !== undefined && typeof closedRaw !== 'boolean') {
    return fail('expected true or false', ['closed']);
  }
  const closed = closedRaw === true;
  const points = own(params, 'points');
  const least = closed ? 3 : 2;
  if (
    typeof points !== 'number' ||
    !Number.isInteger(points) ||
    points < least ||
    points > MAX_WALL_POINTS
  ) {
    return fail(
      `expected the number of path points, ${least} to ${MAX_WALL_POINTS}${closed ? ' for a closed wall' : ''}`,
      ['points'],
    );
  }
  const j = own(params, 'justification');
  const justification =
    j === undefined ? ok('left' as const) : readEnum(j, JUSTIFICATIONS, ['justification']);
  if (!justification.ok) return justification;
  const joins = readJoins(own(params, 'joins'));
  if (!joins.ok) return joins;
  if (closed && (joins.value.start !== 'auto' || joins.value.end !== 'auto')) {
    return fail('a closed wall has no ends to join', ['joins']);
  }
  const framing = readFramingParams(own(params, 'framing'));
  if (!framing.ok) return framing;
  const overrides = readOverrides(own(params, 'overrides'), ['overrides']);
  if (!overrides.ok) return overrides;
  return ok({
    level: level.value,
    wallType: wallType.value,
    points,
    closed,
    justification: justification.value,
    joins: joins.value,
    framing: framing.value,
    overrides: overrides.value,
  });
}

/** A wall's params stored at `schemaVersion`, migrated in memory and validated. */
export function readWallParams(params: Json, schemaVersion: number): Read<WallParams> {
  const migrated = migrate(WALL_PARAMS, params, schemaVersion);
  if (!migrated.ok) return migrated;
  return readCurrent(migrated.value);
}

/** The id of a wall's layer body: `<wall id>:layer/<layer id>` (decision 3). */
export function layerBodyId(wallId: string, layerId: string): string {
  return `${wallId}:layer/${layerId}`;
}

/**
 * The layer bodies a wall makes, by its feature and its wall type as stored: one per sheet layer
 * when its operation is `new`, none otherwise (as `translateWall` names them).
 */
export function wallLayerBodies(
  wall: { readonly id: string; readonly operation?: string | undefined },
  type: { readonly layers: readonly { readonly id: string; readonly kind: string }[] } | undefined,
): string[] {
  if (wall.operation !== 'new' || type === undefined) return [];
  return type.layers.filter((l) => l.kind !== 'framing').map((l) => layerBodyId(wall.id, l.id));
}

// Settings ---------------------------------------------------------------------------------------

/** A stored header with its stocks looked up (lumber, and a sheet spacer). */
export function headerSpec(
  h: HeaderData,
  ctx: ExtensionContext<unknown>,
  what: string,
  field: (string | number)[],
): HeaderSpec {
  const data = stockData(ctx);
  return {
    stock: stockFor(h.stock, data, 'lumber', `${what}'s stock`, field),
    plies: h.plies,
    jacks: h.jacks,
    ...(h.spacer === undefined
      ? {}
      : { spacer: stockFor(h.spacer, data, 'any', `${what}'s spacer`, field) }),
  };
}

/** Undefined values left out, for exact optional fields. */
function defined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

/**
 * The wall's framing settings: its own params and expressions over its wall type's framing layer
 * over the document's framing settings over the generator's defaults (`DEFAULT_WALL_SETTINGS`).
 * The header rules are the document's.
 */
export function wallSettings(
  ctx: ExtensionContext<WallParams>,
  doc: ConstructionSettings,
  framing: FramingLayer,
): WallSettingsInput {
  const p = ctx.params.framing;
  const f = doc.framing;
  const v = ctx.values;
  const data = stockData(ctx);
  const spacing = v.spacing ?? framing.spacing ?? f.spacing;
  for (const [key, value] of [
    ['spacing', v.spacing],
    ['layoutOrigin', v.layoutOrigin],
  ] as const) {
    if (value === undefined) continue;
    if (!(Math.abs(value) <= MAX_SEGMENT_LENGTH)) {
      throw new Refusal(`the ${key} must be at most ${MAX_SEGMENT_LENGTH / 1000} m`, [
        'expressions',
        key,
      ]);
    }
  }
  if (v.spacing !== undefined && !(v.spacing >= MIN_FEATURE_SPACING)) {
    throw new Refusal(`the spacing must be at least ${MIN_FEATURE_SPACING} mm`, [
      'expressions',
      'spacing',
    ]);
  }
  const blocking: BlockingRows | undefined =
    p.blocking !== undefined ? { kind: p.blocking } : f.blocking;
  const settings = defined({
    studStock: stockFor(framing.stock, data, 'lumber', 'The stud stock', ['params', 'wallType']),
    defaultHeader: headerSpec(framing.header, ctx, "The wall type's default header", [
      'params',
      'wallType',
    ]),
    headerRules: doc.headerRules.map((r, i) => ({
      maxWidth: r.maxWidth,
      header: headerSpec(r.header, ctx, `Header rule ${i + 1}`, ['params', 'wallType']),
    })),
    spacing,
    layoutOrigin: v.layoutOrigin ?? f.layoutOrigin,
    layoutFrom: p.layoutFrom ?? f.layoutFrom,
    bottomPlates: p.bottomPlates ?? framing.bottomPlates ?? f.bottomPlates,
    topPlates: p.topPlates ?? framing.topPlates ?? f.topPlates,
    kings: p.kings ?? f.kings,
    cornerStyle: p.cornerStyle ?? f.cornerStyle,
    blocking,
    spliceOffset: f.spliceOffset,
    plateStockLengths: f.plateStockLengths,
    precutLengths: f.precutLengths,
    ladderSpacing: f.ladderSpacing,
  }) as WallSettingsInput;
  try {
    resolveWallSettings(settings);
  } catch (error) {
    if (error instanceof FramingInputError) throw new Refusal(error.message, ['params', 'framing']);
    throw error;
  }
  return settings;
}

// Layer outlines ---------------------------------------------------------------------------------

/** Turns sharper than this (the cosine between directions) make the mitres too long. */
const SHARPEST_TURN = -0.9;
/** The same bound for a wall meeting another's side: the sine of the angle between them. */
const SHALLOWEST_TEE = Math.sqrt(1 - SHARPEST_TURN * SHARPEST_TURN);

/**
 * A line in plan that a layer's end lies on instead of the square end at the path point: the
 * points X with (X - c) . nu = 0, `nu` a unit normal pointing past the end (away from the wall).
 */
export interface EndLine {
  readonly c: P2;
  readonly nu: P2;
}

/** The lines a wall's layers end on at its start and end, when they join another wall's. */
export interface EndLines {
  readonly start?: EndLine;
  readonly end?: EndLine;
}

/** Where the line `t` across `seg` (through `p`, along the segment) meets `line`. */
function meetLine(p: P2, seg: PlanSegment, t: number, line: EndLine): P2 {
  const q = add2(p, scale2(seg.n, t));
  const u = dot2(sub2(line.c, q), line.nu) / dot2(seg.d, line.nu);
  return add2(q, scale2(seg.d, u));
}

/**
 * The path offset by `t` (positive to the left), mitred at every corner: one point per path
 * point, and for a closed path one per corner only.
 */
function offsetPath(
  points: readonly P2[],
  segs: readonly PlanSegment[],
  closed: boolean,
  t: number,
  ends: EndLines = {},
): P2[] {
  const at = (p: P2, n: P2, s: number): P2 => [p[0] + n[0] * s, p[1] + n[1] * s];
  const out: P2[] = [];
  for (let k = 0; k < points.length; k++) {
    const before = closed ? segs[(k - 1 + segs.length) % segs.length] : segs[k - 1];
    const after = k < segs.length ? segs[k] : undefined;
    if (before === undefined) {
      out.push(
        ends.start === undefined
          ? at(points[k]!, after!.n, t)
          : meetLine(points[k]!, after!, t, ends.start),
      );
    } else if (after === undefined) {
      out.push(
        ends.end === undefined
          ? at(points[k]!, before.n, t)
          : meetLine(points[k]!, before, t, ends.end),
      );
    } else {
      // The mitre: the corner's offset lines meet at p + t (n1 + n2) / (1 + n1 . n2).
      const m = 1 + dot2(before.n, after.n);
      const n: P2 = [(before.n[0] + after.n[0]) / m, (before.n[1] + after.n[1]) / m];
      out.push(at(points[k]!, n, t));
    }
  }
  return out;
}

const signedArea = (ring: readonly P2[]): number => {
  let a = 0;
  for (let i = 0; i < ring.length; i++) a += cross2(ring[i]!, ring[(i + 1) % ring.length]!);
  return a / 2;
};

function loopOf(ring: readonly P2[], ids: readonly string[]): ProfileLoop {
  const entities: ProfileEntity[] = ring.map((p, i) => ({
    kind: 'line',
    id: ids[i]!,
    start: [p[0], p[1]],
    end: [ring[(i + 1) % ring.length]![0], ring[(i + 1) % ring.length]![1]],
  }));
  return { entities };
}

/**
 * A layer's outline in plan: the band between `lo` and `hi` across the path, mitred at the
 * corners. Open: one loop (exterior side forward, end, interior side back, start). Closed: the
 * outer ring with the inner one as its hole. Edge ids name the faces they sweep.
 */
export function layerLoops(
  layer: string,
  points: readonly P2[],
  closed: boolean,
  lo: number,
  hi: number,
  ends: EndLines = {},
): ProfileLoop[] {
  const segs = planSegments(points, closed);
  const ext = offsetPath(points, segs, closed, lo, ends);
  const int = offsetPath(points, segs, closed, hi, ends);
  const name = (side: string, i: number) => `${layer}.${side}${i + 1}`;
  if (!closed) {
    const ring = [...ext, ...[...int].reverse()];
    const ids = [
      ...segs.map((_, i) => name('ext', i)),
      `${layer}.end`,
      ...segs.map((_, i) => name('int', segs.length - 1 - i)),
      `${layer}.start`,
    ];
    return [loopOf(ring, ids)];
  }
  const extLoop = loopOf(
    ext,
    segs.map((_, i) => name('ext', i)),
  );
  const intLoop = loopOf(
    int,
    segs.map((_, i) => name('int', i)),
  );
  return Math.abs(signedArea(ext)) >= Math.abs(signedArea(int))
    ? [extLoop, intLoop]
    : [intLoop, extLoop];
}

/**
 * Whether every edge of a layer's outline runs forward along its segment, so the outline does
 * not cross itself (a segment too short for the mitres or joins at its ends).
 */
function outlineRunsForward(
  points: readonly P2[],
  closed: boolean,
  lo: number,
  hi: number,
  ends: EndLines,
): boolean {
  const segs = planSegments(points, closed);
  for (const t of [lo, hi]) {
    const path = offsetPath(points, segs, closed, t, ends);
    for (let i = 0; i < segs.length; i++) {
      const a = path[i]!;
      const b = path[(i + 1) % path.length]!;
      if (!(dot2(sub2(b, a), segs[i]!.d) > 1e-6)) return false;
    }
  }
  return true;
}

/** The plan area of a layer's outline, mm2 (for tests and the takeoff). */
export function layerArea(
  points: readonly P2[],
  closed: boolean,
  lo: number,
  hi: number,
  ends: EndLines = {},
): number {
  const segs = planSegments(points, closed);
  const ext = offsetPath(points, segs, closed, lo, ends);
  const int = offsetPath(points, segs, closed, hi, ends);
  if (!closed) return Math.abs(signedArea([...ext, ...[...int].reverse()]));
  return Math.abs(Math.abs(signedArea(ext)) - Math.abs(signedArea(int)));
}

// Layer joins between walls ----------------------------------------------------------------------

/** How far a cutting tool reaches past what it must cut, mm (so no tool face is flush). */
const TOOL_MARGIN = 1;
/** Lengths shorter than this are nothing, mm. */
const JOIN_EPS = 1e-6;

const leftOf = (d: P2): P2 => [-d[1], d[0]];
const unit = (v: P2): P2 => scale2(v, 1 / Math.hypot(v[0], v[1]));

/** A box tool on one body: `x` along `xDir` from `origin` (plan), `y` to its left, `z` up. */
function box(
  id: string,
  body: string,
  mode: 'add' | 'subtract',
  origin: P2,
  xDir: P2,
  size: [number, number],
  z: readonly [number, number],
): ToolItem {
  return {
    id,
    body,
    mode,
    primitive: {
      type: 'box',
      frame: {
        origin: [origin[0], origin[1], z[0]],
        xDir: [xDir[0], xDir[1], 0],
        normal: [0, 0, 1],
      },
      size: [size[0], size[1], z[1] - z[0]],
    },
  };
}

/** The extent of a wall's whole layer stack across its path: [lowest t, highest t]. */
const stackOf = (meta: WallMetadata): [number, number] => [
  Math.min(...meta.layers.map((l) => l.t[0])),
  Math.max(...meta.layers.map((l) => l.t[1])),
];

/** The framing layer's extent across the path. */
const framingOf = (meta: WallMetadata): readonly [number, number] =>
  meta.layers.find((l) => l.kind === 'framing')?.t ??
  framingBand(meta.justification, meta.thickness);

/** The wall's sheet layers with bodies that exist before this feature. */
const bodiesOf = (meta: WallMetadata, present: readonly string[]) =>
  meta.layers.filter(
    (l): l is LayerMetadata & { body: string } => l.body !== null && present.includes(l.body),
  );

/**
 * Tools that make an earlier wall's layer bodies end on `line` at its `end` instead of square at
 * its path point: an added box where a layer falls short of the line, then a cut past the line.
 */
function trimItems(
  prefix: string,
  otherId: string,
  meta: WallMetadata,
  end: WallEnd,
  line: EndLine,
  present: readonly string[],
): ToolItem[] {
  const segs = planSegments(meta.points, meta.closed);
  const p = end === 'start' ? segs[0]!.a : segs.at(-1)!.b;
  const seg = end === 'start' ? segs[0]! : segs.at(-1)!;
  const d = scale2(intoWall(segs, end), -1); // toward the end
  const n = leftOf(d);
  const flip = dot2(n, seg.n) > 0 ? 1 : -1;
  const den = dot2(d, line.nu);
  const x = leftOf(scale2(line.nu, -1)); // along the line, with nu to its left
  const top = meta.base + meta.height;
  const items: ToolItem[] = [];
  for (const l of bodiesOf(meta, present)) {
    const w0 = Math.min(l.t[0] * flip, l.t[1] * flip);
    const w1 = Math.max(l.t[0] * flip, l.t[1] * flip);
    const reach = (w: number) => (dot2(sub2(line.c, p), line.nu) - w * dot2(n, line.nu)) / den;
    const a0 = reach(w0);
    const a1 = reach(w1);
    const far = Math.max(0, a0, a1);
    const near = Math.min(0, a0, a1);
    // The cut must stay on the end segment, or it would take a whole short wall's layer away.
    if (-near >= seg.length - JOIN_EPS) {
      throw new Refusal(
        `${otherId}'s ${end === 'start' ? 'first' : 'last'} segment is too short for its layer "${l.id}" to join this wall: lengthen it, or take ${otherId} out of dependsOn`,
        ['dependsOn'],
      );
    }
    if (far > JOIN_EPS) {
      items.push(
        box(
          `${prefix}-ext-${l.id}`,
          l.body,
          'add',
          add2(p, scale2(n, w0)),
          d,
          [far, w1 - w0],
          [meta.base, top],
        ),
      );
    }
    // What lies past the line: inside the band, between `near` and `far` along the wall.
    const corners = [near, far].flatMap((a) =>
      [w0, w1].map((w) => sub2(add2(p, add2(scale2(d, a), scale2(n, w))), line.c)),
    );
    const xs = corners.map((c) => dot2(c, x));
    const ys = corners.map((c) => dot2(c, line.nu));
    const depth = Math.max(...ys);
    if (depth <= JOIN_EPS) continue;
    const x0 = Math.min(...xs) - TOOL_MARGIN;
    const x1 = Math.max(...xs) + TOOL_MARGIN;
    items.push(
      box(
        `${prefix}-trim-${l.id}`,
        l.body,
        'subtract',
        add2(line.c, scale2(x, x0)),
        x,
        [x1 - x0, depth + TOOL_MARGIN],
        [meta.base - TOOL_MARGIN, top + TOOL_MARGIN],
      ),
    );
  }
  return items;
}

/**
 * Tools that notch a tee's host layers on the branch's side where the branch's framing passes
 * through them to the host's framing: a box across the branch's framing band per layer body.
 */
function notchItems(
  prefix: string,
  host: WallMetadata,
  segment: number,
  branch: WallMetadata,
  end: WallEnd,
  bodies: readonly (LayerMetadata & { body: string })[],
): ToolItem[] {
  const hseg = planSegments(host.points, host.closed)[segment]!;
  const bsegs = planSegments(branch.points, branch.closed);
  const p = end === 'start' ? bsegs[0]!.a : bsegs.at(-1)!.b;
  const into = intoWall(bsegs, end);
  const side = dot2(into, hseg.n) > 0 ? 1 : -1;
  const [h0, h1] = framingOf(host);
  const [s0, s1] = stackOf(host);
  const face = side > 0 ? h1 : h0;
  const outer = side > 0 ? s1 : s0;
  const notched = bodies.filter((l) =>
    side > 0 ? l.t[0] >= h1 - JOIN_EPS : l.t[1] <= h0 + JOIN_EPS,
  );
  if (notched.length === 0 || Math.abs(outer - face) <= JOIN_EPS) return [];
  const left = leftOf(into);
  const bseg = end === 'start' ? bsegs[0]! : bsegs.at(-1)!;
  const [b0, b1] = framingOf(branch);
  const [y0, y1] = dot2(left, bseg.n) > 0 ? [b0, b1] : [-b1, -b0];
  const sp = dot2(sub2(p, hseg.a), hseg.n);
  const ci = dot2(into, hseg.n);
  const cl = dot2(left, hseg.n);
  const xs = [face, outer].flatMap((sv) => [y0, y1].map((y) => (sv - sp - y * cl) / ci));
  const x0 = Math.min(...xs) - TOOL_MARGIN;
  const x1 = Math.max(...xs) + TOOL_MARGIN;
  const hostTop = host.base + host.height;
  const branchTop = branch.base + branch.height;
  const z: [number, number] = [
    branch.base <= host.base + JOIN_EPS ? host.base - TOOL_MARGIN : branch.base,
    branchTop >= hostTop - JOIN_EPS ? hostTop + TOOL_MARGIN : branchTop,
  ];
  if (!(z[1] > z[0])) return [];
  const origin = add2(add2(p, scale2(left, y0)), scale2(into, x0));
  return notched.map((l) =>
    box(`${prefix}-notch-${l.id}`, l.body, 'subtract', origin, into, [x1 - x0, y1 - y0], z),
  );
}

/** The line along another wall's layer stack face on the side `into` comes from. */
function stackFaceLine(meta: WallMetadata, segment: number, into: P2): EndLine {
  const seg = planSegments(meta.points, meta.closed)[segment]!;
  const side = dot2(into, seg.n) > 0 ? 1 : -1;
  const [s0, s1] = stackOf(meta);
  return { c: add2(seg.a, scale2(seg.n, side > 0 ? s1 : s0)), nu: scale2(seg.n, -side) };
}

/**
 * Join this wall's layers with the walls it names in `dependsOn` (`graph.ts`'s `layerJoins`):
 *
 * - at an L, both walls' layers end on the corner's bisector, as at a corner of one path (a
 *   mitre): this wall's outline ends there, and the other wall's bodies get an added box where
 *   they fall short of it and a cut past it;
 * - as a tee's branch, this wall's layers end on the other wall's layer face, and the other
 *   wall's layers on this side are notched where this wall's framing passes to its framing.
 *
 * - as a tee's host (the earlier wall ends on this one), the other wall's layers are cut back (or
 *   extended) to this wall's layer face, and this wall's layers on that side are notched for the
 *   other wall's framing.
 *
 * The bodies change through one `tools` input after the layer extrusions; regen hands a `new`
 * extension's tools the bodies it made and those of the features in its dependsOn.
 * Returns the end lines of this wall's own outline and the tools for the bodies.
 */
function joinLayers(
  ctx: ExtensionContext<WallParams>,
  self: WallMetadata,
): { ends: EndLines; items: ToolItem[] } {
  const f = ctx.feature;
  const upstream: GraphWall[] = [];
  for (const [id, u] of ctx.upstream) {
    if (u.type !== WALL_TYPE) continue;
    const meta = readWallMetadata(u.metadata);
    if (meta !== undefined) upstream.push({ id, meta });
  }
  if (upstream.length === 0) return { ends: {}, items: [] };
  let joins: LayerJoin[];
  try {
    joins = layerJoins({ id: f.id, meta: self }, upstream);
  } catch (error) {
    throw new Refusal(error instanceof Error ? error.message : String(error), ['dependsOn']);
  }
  const segs = planSegments(self.points, self.closed);
  const own = self.layers.filter((l): l is LayerMetadata & { body: string } => l.body !== null);
  const ends: { start?: EndLine; end?: EndLine } = {};
  const items: ToolItem[] = [];
  const tees = joins
    .filter((j): j is Extract<LayerJoin, { kind: 'host' }> => j.kind === 'host')
    .map((j) => {
      const osegs = planSegments(j.other.meta.points, j.other.meta.closed);
      const at = j.otherEnd === 'start' ? osegs[0]!.a : osegs.at(-1)!.b;
      return { j, along: dot2(sub2(at, segs[j.segment]!.a), segs[j.segment]!.d) };
    })
    .sort((a, b) => a.j.segment - b.j.segment || a.along - b.along);
  const shallow = (other: string): Refusal =>
    new Refusal(
      `${f.id} meets ${other} at too sharp an angle to join their layers: take ${other} out of dependsOn, or widen the angle`,
      ['dependsOn'],
    );
  for (const j of joins) {
    if (j.kind === 'host') continue;
    const into = intoWall(segs, j.end);
    const p = j.end === 'start' ? segs[0]!.a : segs.at(-1)!.b;
    if (j.kind === 'corner') {
      const osegs = planSegments(j.other.meta.points, j.other.meta.closed);
      const oInto = intoWall(osegs, j.otherEnd);
      if (dot2(into, oInto) > -SHARPEST_TURN) throw shallow(j.other.id);
      const b = unit(add2(into, oInto));
      let nu = leftOf(b);
      if (dot2(nu, into) > 0) nu = scale2(nu, -1);
      ends[j.end] = { c: p, nu };
      items.push(
        ...trimItems(
          j.end,
          j.other.id,
          j.other.meta,
          j.otherEnd,
          { c: p, nu: scale2(nu, -1) },
          ctx.bodies,
        ),
      );
    } else {
      const oseg = planSegments(j.other.meta.points, j.other.meta.closed)[j.segment]!;
      if (Math.abs(dot2(into, oseg.n)) < SHALLOWEST_TEE) throw shallow(j.other.id);
      ends[j.end] = stackFaceLine(j.other.meta, j.segment, into);
      items.push(
        ...notchItems(
          j.end,
          j.other.meta,
          j.segment,
          self,
          j.end,
          bodiesOf(j.other.meta, ctx.bodies),
        ),
      );
    }
  }
  tees.forEach(({ j }, k) => {
    const osegs = planSegments(j.other.meta.points, j.other.meta.closed);
    const oInto = intoWall(osegs, j.otherEnd);
    if (Math.abs(dot2(oInto, segs[j.segment]!.n)) < SHALLOWEST_TEE) throw shallow(j.other.id);
    const prefix = `tee${k + 1}`;
    items.push(
      ...trimItems(
        prefix,
        j.other.id,
        j.other.meta,
        j.otherEnd,
        stackFaceLine(self, j.segment, oInto),
        ctx.bodies,
      ),
      ...notchItems(prefix, self, j.segment, j.other.meta, j.otherEnd, own),
    );
  });
  return { ends, items };
}

// The translator ---------------------------------------------------------------------------------

function readPath(ctx: ExtensionContext<WallParams>): P2[] {
  const points: P2[] = [];
  for (let i = 1; i <= ctx.params.points; i++) {
    const x = ctx.values[`x${i}`];
    const y = ctx.values[`y${i}`];
    for (const [key, value] of [
      [`x${i}`, x],
      [`y${i}`, y],
    ] as const) {
      if (value === undefined) throw new Refusal(`point ${i} needs ${key}`, ['expressions', key]);
      if (!(Math.abs(value) <= MAX_COORDINATE)) {
        throw new Refusal(`point ${i} is more than ${MAX_COORDINATE / 1000} m from the origin`, [
          'expressions',
          key,
        ]);
      }
    }
    points.push([x!, y!]);
  }
  const count = ctx.params.closed ? points.length : points.length - 1;
  for (let i = 0; i < count; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (!(length >= 1)) {
      throw new Refusal(`segment ${i + 1} of the path has no length`, ['expressions', `x${i + 1}`]);
    }
    if (length > MAX_SEGMENT_LENGTH) {
      throw new Refusal(`segment ${i + 1} is longer than ${MAX_SEGMENT_LENGTH / 1000} m`, [
        'expressions',
        `x${i + 1}`,
      ]);
    }
  }
  const segs = planSegments(points, ctx.params.closed);
  for (let i = 0; i < segs.length; i++) {
    const next = segs[i + 1] ?? (ctx.params.closed ? segs[0] : undefined);
    if (next !== undefined && dot2(segs[i]!.d, next.d) < SHARPEST_TURN) {
      throw new Refusal(`the path turns back on itself at point ${((i + 1) % points.length) + 1}`, [
        'expressions',
        `x${((i + 1) % points.length) + 1}`,
      ]);
    }
  }
  return points;
}

function build(ctx: ExtensionContext<WallParams>): {
  inputs: FeatureInput[];
  metadata: WallMetadata;
} {
  const f = ctx.feature;
  const p = ctx.params;
  if (f.operation !== undefined && f.operation !== 'new') {
    throw new Refusal('a wall makes its layer bodies: its operation is "new" or none', [
      'operation',
    ]);
  }
  for (const name of Object.keys(f.expressions)) {
    const point = /^[xy]([1-9][0-9]*)$/.exec(name);
    const move = /^move_([1-9][0-9]*)$/.exec(name);
    const known =
      ['height', 'spacing', 'layoutOrigin'].includes(name) ||
      (point !== null && Number(point[1]) <= p.points) ||
      (move !== null && Number(move[1]) <= p.overrides.length);
    if (!known) throw new Refusal(`a wall has no "${name}" value`, ['expressions', name]);
  }
  const data = constructionData(ctx);
  if (data === undefined) {
    throw new Refusal('the document has no construction settings (levels and wall types)', [
      'params',
      'level',
    ]);
  }
  const doc = data.settings;
  const level = findLevel(doc.levels, p.level);
  if (level === undefined) throw new Refusal(`there is no level "${p.level}"`, ['params', 'level']);
  const type: WallType | undefined = doc.wallTypes.find((t) => t.id === p.wallType);
  if (type === undefined) {
    throw new Refusal(`there is no wall type "${p.wallType}"`, ['params', 'wallType']);
  }
  const height = ctx.values.height ?? level.height;
  if (!(height > 0 && height <= MAX_WALL_HEIGHT)) {
    throw new Refusal(`the height must be above 0 and at most ${MAX_WALL_HEIGHT / 1000} m`, [
      'expressions',
      'height',
    ]);
  }
  const points = readPath(ctx);
  const framing = type.layers.find((l): l is FramingLayer => l.kind === 'framing')!;
  const settings = wallSettings(ctx, doc, framing);
  const thickness = settings.studStock.depth;

  // Layers across the path: the framing by the justification, the others stacked outward.
  const stock = stockData(ctx);
  const widths = type.layers.map((l) => {
    if (l.kind === 'framing') return thickness;
    const t = layerThickness(l, stock);
    if (!t.ok) throw new Refusal(`layer "${l.id}": ${t.message}`, ['params', 'wallType']);
    if (!(t.value > 0 && t.value <= MAX_LAYER_THICKNESS)) {
      throw new Refusal(`layer "${l.id}" is thicker than ${MAX_LAYER_THICKNESS} mm`, [
        'params',
        'wallType',
      ]);
    }
    return t.value;
  });
  const fi = type.layers.indexOf(framing);
  const band = framingBand(p.justification, thickness);
  const ts: [number, number][] = type.layers.map(() => [0, 0]);
  ts[fi] = band;
  for (let i = fi - 1, at = band[0]; i >= 0; at -= widths[i]!, i--) ts[i] = [at - widths[i]!, at];
  for (let i = fi + 1, at = band[1]; i < type.layers.length; at += widths[i]!, i++) {
    ts[i] = [at, at + widths[i]!];
  }

  const makes = f.operation === 'new';
  const sheets = type.layers.filter((l) => l.kind !== 'framing');
  if (makes && sheets.length === 0) {
    throw new Refusal(
      `wall type "${type.id}" has no siding, sheathing or drywall to make bodies of: a framing-only wall has no operation`,
      ['operation'],
    );
  }
  const layers: LayerMetadata[] = type.layers.map((l, i) => ({
    id: l.id,
    kind: l.kind,
    body: makes && l.kind !== 'framing' ? layerBodyId(f.id, l.id) : null,
    t: ts[i]!,
  }));
  const base = level.elevation;
  const metadata: WallMetadata = {
    kind: 'wall',
    level: level.id,
    base,
    height,
    points,
    closed: p.closed,
    justification: p.justification,
    thickness,
    free: { start: p.joins.start === 'free', end: p.joins.end === 'free' },
    layers,
    settings,
    overrides: resolveOverrides(p.overrides, ctx.values, stock),
  };
  // Only a wall that makes layer bodies joins them with the walls it names in dependsOn.
  const joined = makes ? joinLayers(ctx, metadata) : { ends: {}, items: [] };
  const inputs: FeatureInput[] = layers.flatMap((l): ExtrudeInput[] => {
    if (l.body === null) return [];
    if (!outlineRunsForward(points, p.closed, l.t[0], l.t[1], joined.ends)) {
      throw new Refusal(
        `a segment of the path is too short for the corners and joins of layer "${l.id}"`,
        ['expressions'],
      );
    }
    return [
      {
        kind: 'extrude',
        id: f.id,
        body: l.body,
        capRole: `cap.${l.id}`,
        profile: {
          frame: { origin: [0, 0, base], xDir: [1, 0, 0], normal: [0, 0, 1] },
          loops: layerLoops(l.id, points, p.closed, l.t[0], l.t[1], joined.ends),
        },
        extent: { type: 'blind', distance: height },
        mode: 'new',
      },
    ];
  });
  if (joined.items.length > 0) inputs.push({ kind: 'tools', id: f.id, items: joined.items });
  return { inputs, metadata };
}

/** The layer bodies and framing input of a wall, or why it cannot be built. */
export function translateWall(ctx: ExtensionContext<WallParams>): ExtensionOutput {
  try {
    const { inputs, metadata } = build(ctx);
    return { inputs, metadata: toJson(metadata) };
  } catch (error) {
    if (error instanceof Refusal) return failure(error);
    throw error;
  }
}

/** The `construction.wall` extension type, as regen's registry takes it. */
export const wallType: ExtensionType<WallParams> = {
  schemaVersion: WALL_SCHEMA_VERSION,
  expressions: WALL_EXPRESSIONS,
  params(params, schemaVersion) {
    return readWallParams(params as Json, schemaVersion);
  },
  translate(ctx) {
    return translateWall(ctx);
  },
};

export { WALL_TYPE };
