// The floor feature, `construction.floor` (M6 plan T6.1c, ADR 0015 decisions 2, 3 and 5): joists,
// rims, blocking and skids under a level, with the subfloor as a layer body on top.
//
// - **Params** (schemaVersion 1): `level` and `floorType` (ids in `domains.construction`),
//   `outline` (where the outline comes from: `walls`, the outside of the framing of the walls in
//   `dependsOn`, which must close a ring; `points`, the expressions `x1`, `y1` .. `xn`, `yn` with
//   `points` their count; or `sketch`, the one sketch in `dependsOn`, whose profile's outer loop
//   of lines is taken in plan), `joists` (`short`, the default, spans the outline's shorter
//   side; `long` the longer; the expression `direction`, an angle in plan, overrides both),
//   `blocking` (`none` or `mid-span`), `skids` (`{ stock, count }`), `doubleUnderWalls` (with an
//   outline from points or a sketch, the walls in `dependsOn` stand on the floor and those
//   running along the joists get doubled joists; default true) and `overrides` (per-member, as a
//   wall's). Lengths are expressions: `spacing` and `layoutOrigin` (over the floor type's),
//   `skidOverhang`, and `move_<n>`.
// - **Elevation**: the level's elevation is the top of the subfloor, where the walls stand. The
//   joists and rims sit below it by the subfloor's thickness, and skids below them.
// - **Layer body** (decision 3): with operation `new`, the subfloor, `<id>:layer/subfloor`, the
//   outline extruded by the floor type's subfloor stock's thickness. Faces `<id>:side:subfloor.e<i>`
//   (outline edge i) and `<id>:cap.subfloor:start` (bottom) and `:end` (top).
// - **Members**: the member stage frames the floor on its own (`frameFloor`, T6.2b), from the
//   input this translator reports as metadata.
//
// Bounds (a document is input): at most `MAX_OUTLINE_POINTS` outline points, `MAX_FLOOR_WALLS`
// walls in `dependsOn` with at most `MAX_OUTLINE_POINTS` segments in a ring, `MAX_FLOOR_SLOTS`
// layout slots and about `MAX_FLOOR_JOISTS` joists in all (the generator's blocking pass is cubic
// in the joists), `MAX_FLOOR_WALL_SEGMENTS` walls doubling joists, one blocking row and 1 to 20
// skids. Floor openings (stairs) are out of scope (ADR 0015 decision 12).
//
// Not an engineering tool (decision 8): joist size, spacing and skids are the user's choices.

import type { ExtrudeInput, ProfileEntity } from '@manufakture/kernel';
import type {
  ExpressionKind,
  ExtensionContext,
  ExtensionOutput,
  ExtensionType,
  JsonValue,
  MemberFeature,
  MemberGroup,
  MemberGroupContext,
  MemberOutput,
  MemberStageContext,
  MemberWarning,
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
  readId,
  type Json,
  type Path,
  type Read,
  type Versioned,
} from '@manufakture/stock';
import type { FloorType } from '../data';
import {
  frameFloor,
  resolveFloorSettings,
  type FloorBlocking,
  type FloorSettingsInput,
  type FloorWall,
  type FrameFloorInput,
} from '../framing/floor';
import { FramingInputError } from '../framing/wall';
import { DATA_ID_PATTERN, findLevel } from '../levels';
import { stockThickness } from '../stock';
import {
  MAX_COORDINATE,
  MAX_LAYER_THICKNESS,
  MAX_OVERRIDES,
  MAX_SEGMENT_LENGTH,
  MIN_FEATURE_SPACING,
  Refusal,
  WALL_TYPE,
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
  stockData,
  stockFor,
  sub2,
  toJson,
  type P2,
  type StoredOverride,
  type WallMetadata,
} from './common';

export const FLOOR_TYPE = 'construction.floor';

// Bounds -----------------------------------------------------------------------------------------

/** The most outline points a floor (or a roof's ring of walls) may have. */
export const MAX_OUTLINE_POINTS = 64;
/** The most walls a floor or roof reads from its `dependsOn`. */
export const MAX_FLOOR_WALLS = 64;
/** The most layout slots across a floor: its extent along the layout over the spacing. */
export const MAX_FLOOR_SLOTS = 256;
/**
 * The most joists a floor may have, estimated from its layout slots, the pieces its outline may
 * cut a band into, and the doubled and flush joists (the generator's blocking pass is cubic in it).
 */
export const MAX_FLOOR_JOISTS = 400;
/** The most wall segments standing on a floor that may get doubled joists. */
export const MAX_FLOOR_WALL_SEGMENTS = 64;
/** The most skids. */
export const MAX_SKIDS = 20;
/** Ends of walls closer than this meet, mm (as the wall graph's `MEET`). */
const MEET = 0.5;

// Params -----------------------------------------------------------------------------------------

export type FloorOutlineSource = 'walls' | 'points' | 'sketch';

export interface FloorParams {
  readonly level: string;
  readonly floorType: string;
  readonly outline: FloorOutlineSource;
  /** How many outline points (`outline: 'points'`); their coordinates are `x<i>`, `y<i>`. */
  readonly points?: number;
  readonly joists: 'short' | 'long';
  readonly blocking: 'none' | 'mid-span';
  readonly skids?: { readonly stock: string; readonly count: number };
  readonly doubleUnderWalls: boolean;
  readonly overrides: readonly StoredOverride[];
}

/** The params migrations of `construction.floor` (none yet: version 1 is current). */
export const FLOOR_PARAMS: Versioned = { what: '"construction.floor" params', migrations: [] };
export const FLOOR_SCHEMA_VERSION = currentVersion(FLOOR_PARAMS);

/** Every expression a floor may have, with its kind. */
export const FLOOR_EXPRESSIONS: Readonly<Record<string, ExpressionKind>> = Object.freeze(
  Object.fromEntries([
    ['direction', 'angle'],
    ['spacing', 'length'],
    ['layoutOrigin', 'length'],
    ['skidOverhang', 'length'],
    ...Array.from({ length: MAX_OUTLINE_POINTS }, (_, i) => [
      [`x${i + 1}`, 'length'],
      [`y${i + 1}`, 'length'],
    ]).flat(),
    ...Array.from({ length: MAX_OVERRIDES }, (_, i) => [moveExpression(i + 1), 'length']),
  ]) as Record<string, ExpressionKind>,
);

const SOURCES: readonly FloorOutlineSource[] = ['walls', 'points', 'sketch'];

/** A data id (a level, a type) from params. */
export function readDataRef(v: unknown, key: string, what: string): Read<string> {
  return typeof v === 'string' && DATA_ID_PATTERN.test(v)
    ? ok(v)
    : fail(`expected the id of a ${what} in the construction settings`, [key]);
}

function readSkids(v: unknown): Read<FloorParams['skids']> {
  if (v === undefined) return ok(undefined);
  const at = ['skids'];
  if (!isObject(v)) return fail('expected skids { stock, count }', at);
  const keys = onlyKeys(v, ['stock', 'count'], at);
  if (!keys.ok) return keys;
  const stock = readId(own(v, 'stock'), [...at, 'stock'], 'a stock id');
  if (!stock.ok) return stock;
  const count = readOptionalCount(v, 'count', at, 1, MAX_SKIDS);
  if (!count.ok) return count;
  if (count.value === undefined) return fail(`expected 1 to ${MAX_SKIDS} skids`, [...at, 'count']);
  return ok({ stock: stock.value, count: count.value });
}

function readCurrent(params: Json): Read<FloorParams> {
  if (!isObject(params)) return fail('expected the floor params object');
  const keys = onlyKeys(
    params,
    [
      'level',
      'floorType',
      'outline',
      'points',
      'joists',
      'blocking',
      'skids',
      'doubleUnderWalls',
      'overrides',
    ],
    [],
  );
  if (!keys.ok) return keys;
  const level = readDataRef(own(params, 'level'), 'level', 'level');
  if (!level.ok) return level;
  const floorType = readDataRef(own(params, 'floorType'), 'floorType', 'floor type');
  if (!floorType.ok) return floorType;
  const outline = readEnum(own(params, 'outline'), SOURCES, ['outline']);
  if (!outline.ok) return outline;
  const points = own(params, 'points');
  if (outline.value === 'points') {
    if (
      typeof points !== 'number' ||
      !Number.isInteger(points) ||
      points < 4 ||
      points > MAX_OUTLINE_POINTS
    ) {
      return fail(`expected the number of outline points, 4 to ${MAX_OUTLINE_POINTS}`, ['points']);
    }
  } else if (points !== undefined) {
    return fail('only an outline from points has a number of points', ['points']);
  }
  const j = own(params, 'joists');
  const joists =
    j === undefined ? ok('short' as const) : readEnum(j, ['short', 'long'], ['joists']);
  if (!joists.ok) return joists;
  const b = own(params, 'blocking');
  const blocking =
    b === undefined ? ok('none' as const) : readEnum(b, ['none', 'mid-span'], ['blocking']);
  if (!blocking.ok) return blocking;
  const skids = readSkids(own(params, 'skids'));
  if (!skids.ok) return skids;
  const d = own(params, 'doubleUnderWalls');
  if (d !== undefined && typeof d !== 'boolean') {
    return fail('expected true or false', ['doubleUnderWalls']);
  }
  const overrides = readOverrides(own(params, 'overrides'), ['overrides']);
  if (!overrides.ok) return overrides;
  return ok({
    level: level.value,
    floorType: floorType.value,
    outline: outline.value,
    ...(outline.value === 'points' ? { points: points as number } : {}),
    joists: joists.value,
    blocking: blocking.value,
    ...(skids.value === undefined ? {} : { skids: skids.value }),
    doubleUnderWalls: d !== false,
    overrides: overrides.value,
  });
}

/** A floor's params stored at `schemaVersion`, migrated in memory and validated. */
export function readFloorParams(params: Json, schemaVersion: number): Read<FloorParams> {
  const migrated = migrate(FLOOR_PARAMS, params, schemaVersion);
  if (!migrated.ok) return migrated;
  return readCurrent(migrated.value);
}

// Walls in dependsOn -----------------------------------------------------------------------------

export interface DependedWall {
  readonly id: string;
  readonly meta: WallMetadata;
}

/** The walls in a feature's `dependsOn`, at most `MAX_FLOOR_WALLS`, each with its geometry. */
export function dependedWalls(ctx: ExtensionContext<unknown>, what: string): DependedWall[] {
  const walls = [...ctx.upstream].filter(([, u]) => u.type === WALL_TYPE);
  if (walls.length > MAX_FLOOR_WALLS) {
    throw new Refusal(`${what} reads at most ${MAX_FLOOR_WALLS} walls`, ['dependsOn']);
  }
  return walls.map(([id, u]) => {
    const meta = readWallMetadata(u.metadata);
    if (meta === undefined) throw new Refusal(`${id} reports no wall geometry`, ['dependsOn']);
    return { id, meta };
  });
}

/** Where a ring edge comes from: a wall and its segment (0-based). */
export interface RingEdge {
  readonly wall: string;
  readonly segment: number;
}

/**
 * The outside line of the framing of walls that close a ring: point i starts edge i. The walls
 * run one way round with their exterior sides out (the exterior is right of a wall's path), so
 * the ring is counter-clockwise.
 */
export interface WallRing {
  readonly points: P2[];
  readonly edges: RingEdge[];
}

interface RingSegment {
  readonly edge: RingEdge;
  readonly a: P2;
  readonly d: P2;
}

/**
 * The ring the walls' framing closes, on its outside: one closed wall, or open walls each starting
 * where another ends. Linear in the segments, quadratic in the walls (at most `MAX_FLOOR_WALLS`).
 */
export function exteriorRing(walls: readonly DependedWall[], what: string): WallRing {
  if (walls.length === 0) {
    throw new Refusal(`${what} needs the walls it follows in dependsOn`, ['dependsOn']);
  }
  const segments = walls.reduce(
    (n, w) => n + (w.meta.closed ? w.meta.points.length : w.meta.points.length - 1),
    0,
  );
  if (segments > MAX_OUTLINE_POINTS) {
    throw new Refusal(`the walls have more than ${MAX_OUTLINE_POINTS} segments`, ['dependsOn']);
  }
  let chain: DependedWall[];
  const closed = walls.filter((w) => w.meta.closed);
  if (closed.length > 0) {
    if (walls.length > 1) {
      throw new Refusal(
        `${what} follows one closed wall, or open walls that close a ring, not both`,
        ['dependsOn'],
      );
    }
    chain = [walls[0]!];
  } else {
    const near = (p: P2, q: P2) => Math.hypot(p[0] - q[0], p[1] - q[1]) <= MEET;
    const first = (w: DependedWall) => w.meta.points[0]!;
    const last = (w: DependedWall) => w.meta.points[w.meta.points.length - 1]!;
    chain = [walls[0]!];
    const rest = walls.slice(1);
    while (rest.length > 0) {
      const end = last(chain[chain.length - 1]!);
      const i = rest.findIndex((w) => near(first(w), end));
      if (i < 0) {
        const back = rest.find((w) => near(last(w), end));
        throw new Refusal(
          back !== undefined
            ? `${back.id} runs the other way round from ${chain[chain.length - 1]!.id}: the walls must run one way round, with their exterior sides out`
            : `the walls do not close a ring: nothing starts where ${chain[chain.length - 1]!.id} ends`,
          ['dependsOn'],
        );
      }
      chain.push(rest.splice(i, 1)[0]!);
    }
    if (!near(last(chain[chain.length - 1]!), first(chain[0]!))) {
      throw new Refusal('the walls do not close a ring', ['dependsOn']);
    }
  }
  const ring: RingSegment[] = [];
  for (const w of chain) {
    const t = framingBand(w.meta.justification, w.meta.thickness)[0];
    planSegments(w.meta.points, w.meta.closed).forEach((s, i) => {
      ring.push({
        edge: { wall: w.id, segment: i },
        a: [s.a[0] + s.n[0] * t, s.a[1] + s.n[1] * t],
        d: s.d,
      });
    });
  }
  if (ring.length < 3) throw new Refusal('the walls do not close a ring', ['dependsOn']);
  const points = ring.map((cur, i): P2 => {
    const prev = ring[(i + ring.length - 1) % ring.length]!;
    const den = cross2(prev.d, cur.d);
    if (Math.abs(den) < 1e-9) return cur.a;
    const s = cross2(sub2(cur.a, prev.a), cur.d) / den;
    return [prev.a[0] + prev.d[0] * s, prev.a[1] + prev.d[1] * s];
  });
  if (!(signedArea(points) > 0)) {
    throw new Refusal(
      "the walls' exterior sides face into the ring: walls of an outline run counter-clockwise, with the exterior (right of the path) out",
      ['dependsOn'],
    );
  }
  return { points, edges: ring.map((r) => r.edge) };
}

export function signedArea(ring: readonly P2[]): number {
  let a = 0;
  for (let i = 0; i < ring.length; i++) a += cross2(ring[i]!, ring[(i + 1) % ring.length]!);
  return a / 2;
}

// Metadata ---------------------------------------------------------------------------------------

/** What a floor's translator reports: the generator's input, and its subfloor body. */
export interface FloorMetadata {
  readonly kind: 'floor';
  readonly level: string;
  readonly input: FrameFloorInput;
  /** Elevation of the top of the subfloor (the level's). */
  readonly top: number;
  /** The subfloor body's id, or null when the floor makes none. */
  readonly subfloor: string | null;
}

export function readFloorMetadata(v: unknown): FloorMetadata | undefined {
  if (!isObject(v) || own(v, 'kind') !== 'floor' || !isObject(own(v, 'input'))) return undefined;
  return v as unknown as FloorMetadata;
}

// The translator ---------------------------------------------------------------------------------

/** Undefined values left out, so metadata is plain JSON. */
export function defined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

/** Refuses expressions a feature does not have; `known` says which names it accepts. */
export function checkExpressionNames(
  ctx: ExtensionContext<unknown>,
  what: string,
  known: (name: string) => boolean,
): void {
  for (const name of Object.keys(ctx.feature.expressions)) {
    if (!known(name)) throw new Refusal(`${what} has no "${name}" value`, ['expressions', name]);
  }
}

/** A plan point within `MAX_COORDINATE`. */
function checkPoint(p: P2, field: Path, what: string): P2 {
  if (!(Math.abs(p[0]) <= MAX_COORDINATE && Math.abs(p[1]) <= MAX_COORDINATE)) {
    throw new Refusal(`${what} is more than ${MAX_COORDINATE / 1000} m from the origin`, field);
  }
  return p;
}

function pointsOutline(ctx: ExtensionContext<FloorParams>): P2[] {
  const out: P2[] = [];
  for (let i = 1; i <= ctx.params.points!; i++) {
    const x = ctx.values[`x${i}`];
    const y = ctx.values[`y${i}`];
    if (x === undefined || y === undefined) {
      const key = x === undefined ? `x${i}` : `y${i}`;
      throw new Refusal(`point ${i} needs ${key}`, ['expressions', key]);
    }
    out.push(checkPoint([x, y], ['expressions', `x${i}`], `point ${i}`));
  }
  return out;
}

function sketchOutline(ctx: ExtensionContext<FloorParams>): P2[] {
  const ids = ctx.feature.dependsOn.filter((id) => ctx.sketches.has(id));
  if (ids.length !== 1) {
    throw new Refusal(
      ids.length === 0
        ? 'a floor outlined by a sketch needs the sketch in dependsOn'
        : 'a floor follows one sketch: dependsOn names several',
      ['dependsOn'],
    );
  }
  const profile = ctx.profile(ids[0]!);
  if (!profile.ok) throw new Refusal(profile.message, ['dependsOn']);
  const frame = profile.value.frame;
  const regions =
    'regions' in profile.value ? profile.value.regions.map((r) => r.loops) : [profile.value.loops];
  if (regions.length > 1) {
    throw new Refusal('the outline sketch has several regions: a floor follows one', ['dependsOn']);
  }
  const loops = regions[0] ?? [];
  const n = frame.normal;
  if (!(Math.abs(n[2]) > 1 - 1e-9 && Math.abs(n[0]) < 1e-6 && Math.abs(n[1]) < 1e-6)) {
    throw new Refusal('the outline sketch must lie on a horizontal plane', ['dependsOn']);
  }
  const loop = loops[0];
  if (loop === undefined)
    throw new Refusal('the outline sketch has no closed region', ['dependsOn']);
  if (loops.length > 1) {
    throw new Refusal('the outline sketch has holes: floor openings are not framed', ['dependsOn']);
  }
  if (loop.entities.length > MAX_OUTLINE_POINTS) {
    throw new Refusal(`the outline has more than ${MAX_OUTLINE_POINTS} edges`, ['dependsOn']);
  }
  const x = frame.xDir;
  const y: [number, number, number] = [
    n[1] * x[2] - n[2] * x[1],
    n[2] * x[0] - n[0] * x[2],
    n[0] * x[1] - n[1] * x[0],
  ];
  return loop.entities.map((e: ProfileEntity, i: number) => {
    if (e.kind !== 'line') {
      throw new Refusal('a floor outline is straight lines only', ['dependsOn']);
    }
    const [u, v] = e.start;
    return checkPoint(
      [frame.origin[0] + u * x[0] + v * y[0], frame.origin[1] + u * x[1] + v * y[1]],
      ['dependsOn'],
      `outline point ${i + 1}`,
    );
  });
}

/** The joists' span direction: the expression, else along the outline's shorter or longer side. */
function spanDirection(ctx: ExtensionContext<FloorParams>, outline: readonly P2[]): P2 {
  const angle = ctx.values.direction;
  if (angle !== undefined) {
    if (!Number.isFinite(angle))
      throw new Refusal('the direction must be an angle', ['expressions', 'direction']);
    return [Math.cos(angle), Math.sin(angle)];
  }
  // The outline's first edge and its left normal as axes; the extents along each.
  const e = sub2(outline[1]!, outline[0]!);
  const len = Math.hypot(e[0], e[1]);
  if (!(len > 0))
    throw new Refusal('the outline starts with an edge of no length', ['params', 'outline']);
  const A: P2 = [e[0] / len, e[1] / len];
  const B: P2 = [-A[1], A[0]];
  const extent = (axis: P2) => {
    const t = outline.map((p) => dot2(p, axis));
    return Math.max(...t) - Math.min(...t);
  };
  const alongA = extent(A) <= extent(B);
  const spanA = ctx.params.joists === 'short' ? alongA : !alongA;
  // Spanning B, the layout (left of the span) runs along A from the outline's first point.
  return spanA ? A : [-B[0], -B[1]];
}

function wallsOnFloor(walls: readonly DependedWall[], level: string): FloorWall[] {
  const out: FloorWall[] = [];
  for (const w of walls) {
    if (w.meta.level !== level) continue;
    const [lo, hi] = framingBand(w.meta.justification, w.meta.thickness);
    const mid = (lo + hi) / 2;
    const segs = planSegments(w.meta.points, w.meta.closed);
    segs.forEach((s, i) => {
      out.push({
        id: segs.length === 1 ? w.id : `${w.id} (segment ${i + 1})`,
        start: [s.a[0] + s.n[0] * mid, s.a[1] + s.n[1] * mid],
        end: [s.b[0] + s.n[0] * mid, s.b[1] + s.n[1] * mid],
      });
    });
  }
  if (out.length > MAX_FLOOR_WALL_SEGMENTS) {
    throw new Refusal(
      `at most ${MAX_FLOOR_WALL_SEGMENTS} wall segments may stand on a floor (each may double a joist)`,
      ['dependsOn'],
    );
  }
  return out;
}

function build(ctx: ExtensionContext<FloorParams>): {
  inputs: ExtrudeInput[];
  metadata: FloorMetadata;
} {
  const f = ctx.feature;
  const p = ctx.params;
  if (f.operation !== undefined && f.operation !== 'new') {
    throw new Refusal('a floor makes its subfloor: its operation is "new" or none', ['operation']);
  }
  checkExpressionNames(ctx, 'a floor', (name) => {
    const point = /^[xy]([1-9][0-9]*)$/.exec(name);
    const move = /^move_([1-9][0-9]*)$/.exec(name);
    return (
      ['direction', 'spacing', 'layoutOrigin', 'skidOverhang'].includes(name) ||
      (point !== null && p.points !== undefined && Number(point[1]) <= p.points) ||
      (move !== null && Number(move[1]) <= p.overrides.length)
    );
  });
  const data = constructionData(ctx);
  if (data === undefined) {
    throw new Refusal('the document has no construction settings (levels and floor types)', [
      'params',
      'level',
    ]);
  }
  const doc = data.settings;
  const level = findLevel(doc.levels, p.level);
  if (level === undefined) throw new Refusal(`there is no level "${p.level}"`, ['params', 'level']);
  const type: FloorType | undefined = doc.floorTypes.find((t) => t.id === p.floorType);
  if (type === undefined) {
    throw new Refusal(`there is no floor type "${p.floorType}"`, ['params', 'floorType']);
  }
  const stock = stockData(ctx);
  const at = ['params', 'floorType'];
  const joistStock = stockFor(type.joistStock, stock, 'lumber', 'The joist stock', at);
  const rimStock =
    type.rimStock === undefined
      ? joistStock
      : stockFor(type.rimStock, stock, 'lumber', 'The rim stock', at);
  const subfloor =
    type.subfloor === undefined
      ? undefined
      : stockFor(type.subfloor, stock, 'sheet', 'The subfloor', at);
  const subT = type.subfloor === undefined ? 0 : (stockThickness(type.subfloor, stock) ?? 0);
  if (subfloor !== undefined && !(subT > 0 && subT <= MAX_LAYER_THICKNESS)) {
    throw new Refusal(`the subfloor's thickness is outside 0 to ${MAX_LAYER_THICKNESS} mm`, at);
  }

  const walls = dependedWalls(ctx, 'a floor');
  let outline: P2[];
  if (p.outline === 'walls') {
    for (const w of walls) {
      if (w.meta.level !== level.id) {
        throw new Refusal(`${w.id} stands on another level`, ['dependsOn']);
      }
    }
    outline = exteriorRing(walls, 'a floor outlined by walls').points;
  } else {
    outline = p.outline === 'points' ? pointsOutline(ctx) : sketchOutline(ctx);
  }
  if (outline.length < 4 || outline.length > MAX_OUTLINE_POINTS) {
    throw new Refusal(`a floor outline has 4 to ${MAX_OUTLINE_POINTS} corners`, [
      'params',
      'outline',
    ]);
  }
  for (let i = 0; i < outline.length; i++) {
    const a = outline[i]!;
    const b = outline[(i + 1) % outline.length]!;
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) > MAX_SEGMENT_LENGTH) {
      throw new Refusal(`outline edge ${i + 1} is longer than ${MAX_SEGMENT_LENGTH / 1000} m`, [
        'params',
        'outline',
      ]);
    }
  }
  const direction = spanDirection(ctx, outline);

  const v = ctx.values;
  for (const key of ['spacing', 'layoutOrigin', 'skidOverhang'] as const) {
    const value = v[key];
    if (value !== undefined && !(Math.abs(value) <= MAX_SEGMENT_LENGTH)) {
      throw new Refusal(`the ${key} must be at most ${MAX_SEGMENT_LENGTH / 1000} m`, [
        'expressions',
        key,
      ]);
    }
  }
  const spacing = v.spacing ?? type.spacing;
  if (spacing !== undefined && !(spacing >= MIN_FEATURE_SPACING)) {
    throw new Refusal(`the spacing must be at least ${MIN_FEATURE_SPACING} mm`, [
      'expressions',
      'spacing',
    ]);
  }
  if (v.skidOverhang !== undefined && p.skids === undefined) {
    throw new Refusal('a skid overhang needs skids', ['expressions', 'skidOverhang']);
  }
  if (v.skidOverhang !== undefined && !(v.skidOverhang >= 0)) {
    throw new Refusal('the skid overhang cannot be negative', ['expressions', 'skidOverhang']);
  }
  const blocking: FloorBlocking = { kind: p.blocking };
  const settings = defined({
    joistStock,
    rimStock,
    spacing,
    layoutOrigin: v.layoutOrigin,
    blocking,
    doubleUnderWalls: p.outline === 'walls' ? false : p.doubleUnderWalls,
    skids:
      p.skids === undefined
        ? undefined
        : defined({
            stock: stockFor(p.skids.stock, stock, 'lumber', 'The skid stock', [
              'params',
              'skids',
              'stock',
            ]),
            count: p.skids.count,
            overhang: v.skidOverhang,
          }),
    subfloor,
  }) as FloorSettingsInput;
  let resolved;
  try {
    resolved = resolveFloorSettings(settings);
  } catch (error) {
    if (error instanceof FramingInputError) throw new Refusal(error.message, ['params']);
    throw error;
  }
  // Bound the layout before the generator lays it out: its blocking pass compares every pair of
  // joists whose spans overlap against every other joist, so its cost grows with the cube of the
  // joists. A band of joists is cut into at most one piece per two edges across it (a quarter of
  // the outline's corners), and that holds for the doubled pairs and flush joists as for the
  // layout's. `frameFloor` refuses past `MAX_BLOCKING_JOISTS` itself too.
  const V: P2 = [-direction[1], direction[0]];
  const vs = outline.map((q) => dot2(q, V));
  const slots = (Math.max(...vs) - Math.min(...vs)) / resolved.spacing;
  if (!(slots <= MAX_FLOOR_SLOTS)) {
    throw new Refusal(
      `the floor is ${Math.ceil(slots)} joist spaces across, more than the ${MAX_FLOOR_SLOTS} a floor may have: split it into several floors`,
      ['params', 'outline'],
    );
  }
  const onFloor = p.outline === 'walls' || !p.doubleUnderWalls ? [] : wallsOnFloor(walls, level.id);
  // Every band (a layout slot, a doubled pair, a flush joist) is cut by the whole outline.
  const joists =
    Math.max(1, Math.floor(outline.length / 4)) *
    (Math.ceil(slots) + 1 + 2 * onFloor.length + outline.length / 2);
  if (joists > MAX_FLOOR_JOISTS) {
    throw new Refusal(
      `the floor could have about ${Math.ceil(joists)} joists, more than the ${MAX_FLOOR_JOISTS} a floor may have: split it into several floors, or give it fewer corners`,
      ['params', 'outline'],
    );
  }

  const top = level.elevation;
  const elevation = top - subT - Math.max(joistStock.depth, rimStock.depth);
  const input = defined({
    floor: f.id,
    outline,
    direction,
    elevation,
    settings,
    walls: onFloor.length === 0 ? undefined : onFloor,
    overrides: p.overrides.length === 0 ? undefined : resolveOverrides(p.overrides, v, stock),
  }) as FrameFloorInput;

  const makes = f.operation === 'new';
  if (makes && subfloor === undefined) {
    throw new Refusal(
      `floor type "${type.id}" has no subfloor to make a body of: a floor of framing only has no operation`,
      ['operation'],
    );
  }
  const body = makes ? `${f.id}:layer/subfloor` : null;
  const inputs: ExtrudeInput[] =
    body === null
      ? []
      : [
          {
            kind: 'extrude',
            id: f.id,
            body,
            capRole: 'cap.subfloor',
            profile: {
              frame: { origin: [0, 0, top - subT], xDir: [1, 0, 0], normal: [0, 0, 1] },
              loops: [
                {
                  entities: outline.map((q, i) => ({
                    kind: 'line' as const,
                    id: `subfloor.e${i + 1}`,
                    start: [q[0], q[1]],
                    end: [
                      outline[(i + 1) % outline.length]![0],
                      outline[(i + 1) % outline.length]![1],
                    ],
                  })),
                },
              ],
            },
            extent: { type: 'blind', distance: subT },
            mode: 'new',
          },
        ];
  return {
    inputs,
    metadata: { kind: 'floor', level: level.id, input, top, subfloor: body },
  };
}

/** The subfloor body and framing input of a floor, or why it cannot be built. */
export function translateFloor(ctx: ExtensionContext<FloorParams>): ExtensionOutput {
  try {
    const { inputs, metadata } = build(ctx);
    return { inputs, metadata: toJson(metadata) };
  } catch (error) {
    if (error instanceof Refusal) return failure(error);
    throw error;
  }
}

/** The `construction.floor` extension type, as regen's registry takes it. */
export const floorType: ExtensionType<FloorParams> = {
  schemaVersion: FLOOR_SCHEMA_VERSION,
  expressions: FLOOR_EXPRESSIONS,
  params(params, schemaVersion) {
    return readFloorParams(params as Json, schemaVersion);
  },
  translate(ctx) {
    return translateFloor(ctx);
  },
};

// Members ----------------------------------------------------------------------------------------

const RULE_OF_THUMB = 'Rule of thumb: ';

/** A layout warning's message, labelled when it is a rule of thumb. */
export function warningMessage(kind: 'rule-of-thumb' | 'layout', message: string): string {
  return kind === 'rule-of-thumb' && !message.startsWith(RULE_OF_THUMB)
    ? `${RULE_OF_THUMB}${message}`
    : message;
}

/** One group per floor that reports its framing input: the floor alone. */
export function floorGroups(ctx: MemberStageContext): MemberGroup[] {
  return ctx.features.flatMap((f: MemberFeature) =>
    f.type === FLOOR_TYPE && readFloorMetadata(f.metadata) !== undefined
      ? [{ id: f.id, features: [f.id] }]
      : [],
  );
}

/** A floor's members through `frameFloor` (T6.2b). */
export function frameFloorGroup(ctx: MemberGroupContext): MemberOutput | { error: string } {
  const floor = ctx.features.find((f) => f.id === ctx.group.id);
  const meta = readFloorMetadata(floor?.metadata);
  if (meta === undefined) return { error: `${ctx.group.id} reports no floor outline` };
  let result;
  try {
    result = frameFloor(meta.input);
  } catch (error) {
    if (error instanceof FramingInputError) return { error: error.message };
    throw error;
  }
  const warnings: MemberWarning[] = result.warnings.map((w) => ({
    feature: ctx.group.id,
    message: warningMessage(w.kind, w.message),
    code: w.code,
    ...(w.member === undefined ? {} : { member: w.member }),
  }));
  const metadata = defined({
    top: result.top,
    overrides: result.overrides,
    subfloor: result.subfloor === undefined ? undefined : { area: result.subfloor.area },
  });
  return { members: result.members, warnings, metadata: toJson(metadata) as JsonValue };
}
