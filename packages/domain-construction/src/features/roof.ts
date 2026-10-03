// The roof feature, `construction.roof` (M6 plan T6.1c, ADR 0015 decisions 2, 3 and 5): a gable or
// hip roof at a pitch, bearing on walls or on a level, with its sheathing as layer bodies.
//
// - **Bearing**: the walls in `dependsOn` (a graph edge, so the roof re-runs when they change and
//   never because of feature order alone). The outside line of their framing must close a
//   rectangle (`exteriorRing`); the plates' top (every wall's base plus height, all equal) is
//   where the rafters sit and the walls' framed thickness is the birdsmouth seat. With no walls in
//   `dependsOn` the roof bears on its `level`: the rectangle is the expressions `x`, `y` (a
//   corner), `length`, `width` and `rotation` (an angle in plan, default 0), the plates' top is
//   the level's elevation plus `plate` (default the level's height), and `wallThickness` is the
//   seat.
// - **Params** (schemaVersion 1): `level` (required on a level, otherwise checked against the
//   walls'), `roofType` (an id in `domains.construction`), `kind` (`gable` or `hip`), `ridge`
//   (`long`, the default, runs the ridge along the rectangle's longer side; `short` along the
//   shorter, gable only), `ties` (`{ kind: 'ceiling-joists' | 'rafter-ties', stock, every }`; a
//   rafter tie's height above the plates is the expression `tieHeight`), `gableStuds` (default
//   true: gable studs on the gable walls' layout, from the roof generator) and `overrides`
//   (per-member, keyed by local id: `e1:c4`, `ridge:1`). Expressions: `pitch`, a **slope field**
//   (`6/12`, `6:12`, `25%` or degrees; ADR 0005 as amended by T6.0b), and lengths `overhang`,
//   `rakeOverhang` and `spacing` (over the roof type's), `tieHeight` and `move_<n>`.
// - **Layer bodies** (decision 3), with operation `new`:
//   - the sheathing, one body per roof plane, `<id>:layer/sheathing-e<n>` (n the eave or end edge
//     of the roof generator: e1 and e3 the eaves, e2 and e4 the ends). Each is the plane's outline
//     on the rafters' top plane, extruded square to it by the roof type's sheathing thickness. The
//     outline runs from the eave overhang's outer line to the ridge's centre line, along the
//     length plus the rake overhangs on a gable; on a hip roof it is cut at the hips' centre lines
//     (45 degrees in plan). So each plane's underside is exactly its hand-computed area:
//     `(overhang + width / 2) / cos(pitch)` up the slope. Faces `<id>:side:sheathing-e<n>.eave`,
//     `.ridge`, `.rake-a`/`.rake-b` (gable) or `.hip-a`/`.hip-b` (hip), and
//     `<id>:cap.sheathing-e<n>:start` (underside) and `:end` (top).
//   - a gable roof's gable fills, `<id>:layer/gable-e<n>-<layer id>`: each exterior sheet layer
//     (siding, sheathing) of the wall under gable end n carried up from the wall's top to a point
//     `width / 2 x tan(pitch)` above it at mid-span, in the layer's own plane. So the gable end
//     walls extend to the roof line, and a change of pitch re-runs only the roof.
// - **Members**: the member stage frames the roof alone (`frameRoof`, T6.2c), gable studs included:
//   they are the roof's, cut to the roof line on the gable walls' stud layout.
//
// Bounds: at most `MAX_FLOOR_WALLS` walls and `MAX_OUTLINE_POINTS` ring segments (`floor.ts`), overhangs up to
// `MAX_OVERHANG`, a pitch below `MAX_PITCH`, and the generator's own member budget.
//
// Not an engineering tool (decision 8): rafter, ridge and hip sizes are the user's; the warnings
// are layout warnings and labelled rules of thumb.

import type { ExtrudeInput, ProfileLoop } from '@manufakture/kernel';
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
  type Read,
  type Versioned,
} from '@manufakture/stock';
import type { RoofType } from '../data';
import type { Vec3 } from '../geom';
import {
  frameRoof,
  resolveRoofSettings,
  type FrameRoofInput,
  type GableStuds,
  type RoofKind,
  type RoofSettingsInput,
  type RoofTies,
} from '../framing/roof';
import { FramingInputError, resolveWallSettings } from '../framing/wall';
import { MAX_LEVEL_LENGTH, findLevel, type Level } from '../levels';
import { stockThickness } from '../stock';
import {
  MAX_COORDINATE,
  MAX_LAYER_THICKNESS,
  MAX_OVERRIDES,
  MAX_SEGMENT_LENGTH,
  MAX_WALL_HEIGHT,
  MIN_FEATURE_SPACING,
  Refusal,
  constructionData,
  cross2,
  dot2,
  failure,
  moveExpression,
  planSegments,
  readOptionalCount,
  readOverrides,
  resolveOverrides,
  stockData,
  stockFor,
  sub2,
  toJson,
  type P2,
  type StoredOverride,
} from './common';
import {
  checkExpressionNames,
  defined,
  dependedWalls,
  exteriorRing,
  readDataRef,
  warningMessage,
  type DependedWall,
  type RingEdge,
} from './floor';
import { framedWall, wallGraph } from './graph';

export const ROOF_TYPE = 'construction.roof';

// Bounds -----------------------------------------------------------------------------------------

/** The longest eave or rake overhang, mm (5 m). */
export const MAX_OVERHANG = 5_000;
/** The steepest pitch, radians (80 degrees). */
export const MAX_PITCH = (80 * Math.PI) / 180;
/** The most pairs `every` may skip between ties. */
export const MAX_TIE_EVERY = 10;
/** Walls under a roof agree on their top and thickness within this, mm. */
const AGREE = 0.5;
/** Within this sine of square, rectangle corners are square. */
const SQUARE = 1e-6;

// Params -----------------------------------------------------------------------------------------

export interface RoofTiesParams {
  readonly kind: 'none' | 'ceiling-joists' | 'rafter-ties';
  readonly stock?: string;
  readonly every?: number;
}

export interface RoofParams {
  readonly level?: string;
  readonly roofType: string;
  readonly kind: RoofKind;
  readonly ridge: 'long' | 'short';
  readonly ties: RoofTiesParams;
  readonly gableStuds: boolean;
  readonly overrides: readonly StoredOverride[];
}

/** The params migrations of `construction.roof` (none yet: version 1 is current). */
export const ROOF_PARAMS: Versioned = { what: '"construction.roof" params', migrations: [] };
export const ROOF_SCHEMA_VERSION = currentVersion(ROOF_PARAMS);

const LEVEL_EXPRESSIONS = ['x', 'y', 'length', 'width', 'rotation', 'plate', 'wallThickness'];

/** Every expression a roof may have, with its kind: the pitch is a slope field. */
export const ROOF_EXPRESSIONS: Readonly<Record<string, ExpressionKind>> = Object.freeze(
  Object.fromEntries([
    ['pitch', 'slope'],
    ['overhang', 'length'],
    ['rakeOverhang', 'length'],
    ['spacing', 'length'],
    ['tieHeight', 'length'],
    ['x', 'length'],
    ['y', 'length'],
    ['length', 'length'],
    ['width', 'length'],
    ['rotation', 'angle'],
    ['plate', 'length'],
    ['wallThickness', 'length'],
    ...Array.from({ length: MAX_OVERRIDES }, (_, i) => [moveExpression(i + 1), 'length']),
  ]) as Record<string, ExpressionKind>,
);

function readTies(v: unknown): Read<RoofTiesParams> {
  if (v === undefined) return ok({ kind: 'none' });
  const at = ['ties'];
  if (!isObject(v)) return fail('expected ties { kind, stock, every }', at);
  const keys = onlyKeys(v, ['kind', 'stock', 'every'], at);
  if (!keys.ok) return keys;
  const kind = readEnum(own(v, 'kind'), ['none', 'ceiling-joists', 'rafter-ties'], [...at, 'kind']);
  if (!kind.ok) return kind;
  if (kind.value === 'none') {
    if (own(v, 'stock') !== undefined || own(v, 'every') !== undefined) {
      return fail('no ties take no stock', at);
    }
    return ok({ kind: 'none' });
  }
  const stock = readId(own(v, 'stock'), [...at, 'stock'], 'a stock id');
  if (!stock.ok) return stock;
  const every = readOptionalCount(v, 'every', at, 1, MAX_TIE_EVERY);
  if (!every.ok) return every;
  return ok({ kind: kind.value, stock: stock.value, every: every.value ?? 1 });
}

function readCurrent(params: Json): Read<RoofParams> {
  if (!isObject(params)) return fail('expected the roof params object');
  const keys = onlyKeys(
    params,
    ['level', 'roofType', 'kind', 'ridge', 'ties', 'gableStuds', 'overrides'],
    [],
  );
  if (!keys.ok) return keys;
  const rawLevel = own(params, 'level');
  const level = rawLevel === undefined ? ok(undefined) : readDataRef(rawLevel, 'level', 'level');
  if (!level.ok) return level;
  const roofType = readDataRef(own(params, 'roofType'), 'roofType', 'roof type');
  if (!roofType.ok) return roofType;
  const kind = readEnum(own(params, 'kind'), ['gable', 'hip'] as const, ['kind']);
  if (!kind.ok) return kind;
  const r = own(params, 'ridge');
  const ridge = r === undefined ? ok('long' as const) : readEnum(r, ['long', 'short'], ['ridge']);
  if (!ridge.ok) return ridge;
  if (kind.value === 'hip' && ridge.value === 'short') {
    return fail("a hip roof's ridge runs along its longer side", ['ridge']);
  }
  const ties = readTies(own(params, 'ties'));
  if (!ties.ok) return ties;
  const g = own(params, 'gableStuds');
  if (g !== undefined && typeof g !== 'boolean')
    return fail('expected true or false', ['gableStuds']);
  if (g === true && kind.value === 'hip') return fail('a hip roof has no gables', ['gableStuds']);
  const overrides = readOverrides(own(params, 'overrides'), ['overrides']);
  if (!overrides.ok) return overrides;
  return ok({
    ...(level.value === undefined ? {} : { level: level.value }),
    roofType: roofType.value,
    kind: kind.value,
    ridge: ridge.value,
    ties: ties.value,
    gableStuds: kind.value === 'gable' && g !== false,
    overrides: overrides.value,
  });
}

/** A roof's params stored at `schemaVersion`, migrated in memory and validated. */
export function readRoofParams(params: Json, schemaVersion: number): Read<RoofParams> {
  const migrated = migrate(ROOF_PARAMS, params, schemaVersion);
  if (!migrated.ok) return migrated;
  return readCurrent(migrated.value);
}

// Metadata ---------------------------------------------------------------------------------------

/** What a roof's translator reports: the generator's input and its layer bodies. */
export interface RoofMetadata {
  readonly kind: 'roof';
  /** The level it bears on (the walls' when it bears on walls). */
  readonly level: string;
  /** The walls it bears on (empty on a level). */
  readonly walls: readonly string[];
  readonly input: FrameRoofInput;
  /** Its sheathing: stock, thickness and one body per plane; null when it makes none. */
  readonly sheathing: {
    readonly stock: string;
    readonly thickness: number;
    readonly bodies: readonly string[];
  } | null;
  /** Gable fill bodies, by gable end. */
  readonly gables: readonly {
    readonly edge: 2 | 4;
    readonly wall: string;
    readonly body: string;
  }[];
}

export function readRoofMetadata(v: unknown): RoofMetadata | undefined {
  if (!isObject(v) || own(v, 'kind') !== 'roof' || !isObject(own(v, 'input'))) return undefined;
  return v as unknown as RoofMetadata;
}

// Footprint --------------------------------------------------------------------------------------

/** A rectangle, counter-clockwise from c1, with where each edge comes from (walls only). */
interface Rectangle {
  readonly corners: readonly [P2, P2, P2, P2];
  /** Per edge, the ring edges it is made of. */
  readonly sources: readonly (readonly RingEdge[])[];
}

/** A ring with collinear points merged, which must be a rectangle. */
function rectangleOf(points: readonly P2[], edges: readonly RingEdge[]): Rectangle {
  const n = points.length;
  const dir = (i: number): P2 => {
    const v = sub2(points[(i + 1) % n]!, points[i]!);
    const l = Math.hypot(v[0], v[1]);
    return l > 0 ? [v[0] / l, v[1] / l] : [0, 0];
  };
  // Corners: points where the direction turns.
  const corners: number[] = [];
  for (let i = 0; i < n; i++) {
    if (Math.abs(cross2(dir((i + n - 1) % n), dir(i))) > SQUARE) corners.push(i);
  }
  const notRect = () =>
    new Refusal('the walls under a roof must close a rectangle (gable and hip roofs only)', [
      'dependsOn',
    ]);
  if (corners.length !== 4) throw notRect();
  const c = corners.map((i) => points[i]!) as [P2, P2, P2, P2];
  const sources = corners.map((start, k) => {
    const end = corners[(k + 1) % 4]!;
    const out: RingEdge[] = [];
    for (let i = start; i !== end; i = (i + 1) % n) out.push(edges[i]!);
    return out;
  });
  const at = (k: number): P2 => c[k % 4]!;
  for (let k = 0; k < 4; k++) {
    const a = sub2(at(k + 1), at(k));
    const b = sub2(at(k + 2), at(k + 1));
    if (Math.abs(dot2(a, b)) > SQUARE * Math.hypot(...a) * Math.hypot(...b)) throw notRect();
  }
  return { corners: c, sources };
}

/** The roof's footprint on a rectangle: e1 along the ridge's direction, from corner `i`. */
function footprintOn(rect: Rectangle, ridge: 'long' | 'short') {
  const at = (k: number): P2 => rect.corners[k % 4]!;
  const len = (k: number) => Math.hypot(...sub2(at(k + 1), at(k)));
  const i =
    ridge === 'long' ? (len(0) >= len(1) - AGREE ? 0 : 1) : len(0) <= len(1) + AGREE ? 0 : 1;
  const origin = at(i);
  const e = sub2(at(i + 1), origin);
  // A rectangle square within `AGREE` is square: a hip roof's ends then meet at a point, never
  // at a ridge a fraction of a millimetre long (or a width just over the length).
  const square = Math.abs(len(i) - len(i + 1)) <= AGREE;
  return {
    origin,
    direction: Math.atan2(e[1], e[0]),
    length: len(i),
    width: square ? len(i) : len(i + 1),
    /** Ring edges under roof edge n (1 to 4). */
    under: (n: 1 | 2 | 3 | 4) => rect.sources[(i + n - 1) % 4]!,
  };
}

// Bodies -----------------------------------------------------------------------------------------

const v3 = (p: P2, z: number): Vec3 => [p[0], p[1], z];

function loop(points: readonly P2[], ids: readonly string[]): ProfileLoop {
  return {
    entities: points.map((p, i) => ({
      kind: 'line' as const,
      id: ids[i]!,
      start: [p[0], p[1]],
      end: [points[(i + 1) % points.length]![0], points[(i + 1) % points.length]![1]],
    })),
  };
}

/**
 * The sheathing planes' outlines in their edges' frames: `t` along the edge from its start
 * (counter-clockwise round the footprint), `r` inward in plan.
 */
export function sheathingOutlines(
  kind: RoofKind,
  L: number,
  W: number,
  overhang: number,
  rake: number,
): { edge: 1 | 2 | 3 | 4; points: P2[]; ids: string[] }[] {
  const o = overhang;
  if (kind === 'gable') {
    return ([1, 3] as const).map((edge) => ({
      edge,
      points: [
        [-rake, -o],
        [L + rake, -o],
        [L + rake, W / 2],
        [-rake, W / 2],
      ],
      ids: ['eave', 'rake-b', 'ridge', 'rake-a'],
    }));
  }
  return ([1, 2, 3, 4] as const).map((edge) => {
    const E = edge % 2 === 1 ? L : W;
    const ridge = E - W;
    return ridge > AGREE
      ? {
          edge,
          points: [
            [-o, -o],
            [E + o, -o],
            [E - W / 2, W / 2],
            [W / 2, W / 2],
          ],
          ids: ['eave', 'hip-b', 'ridge', 'hip-a'],
        }
      : {
          edge,
          points: [
            [-o, -o],
            [E + o, -o],
            [E / 2, W / 2],
          ],
          ids: ['eave', 'hip-b', 'hip-a'],
        };
  });
}

/** The hand value of a plane's sheathing area: its outline in plan over cos(pitch). */
export function sheathingArea(points: readonly P2[], pitch: number): number {
  let a = 0;
  for (let i = 0; i < points.length; i++) a += cross2(points[i]!, points[(i + 1) % points.length]!);
  return Math.abs(a / 2) / Math.cos(pitch);
}

// The translator ---------------------------------------------------------------------------------

function need(ctx: ExtensionContext<RoofParams>, key: string, what: string): number {
  const v = ctx.values[key];
  if (v === undefined) throw new Refusal(`a roof on a level needs ${what}`, ['expressions', key]);
  return v;
}

interface Bearing {
  readonly level: string;
  readonly walls: readonly DependedWall[];
  readonly footprint: ReturnType<typeof footprintOn> | undefined;
  readonly origin: P2;
  readonly direction: number;
  readonly length: number;
  readonly width: number;
  readonly plate: number;
  readonly wallThickness: number;
}

function bearing(ctx: ExtensionContext<RoofParams>, levels: readonly Level[]): Bearing {
  const p = ctx.params;
  const walls = dependedWalls(ctx, 'a roof');
  if (walls.length > 0) {
    for (const k of LEVEL_EXPRESSIONS) {
      if (ctx.feature.expressions[k] !== undefined) {
        throw new Refusal(`a roof on walls takes its ${k} from them`, ['expressions', k]);
      }
    }
    const level = walls[0]!.meta.level;
    const top = walls[0]!.meta.base + walls[0]!.meta.height;
    const thickness = walls[0]!.meta.thickness;
    for (const w of walls) {
      if (p.level !== undefined && w.meta.level !== p.level) {
        throw new Refusal(`${w.id} is not on level "${p.level}"`, ['dependsOn']);
      }
      if (w.meta.level !== level) {
        throw new Refusal(`${w.id} is on another level than ${walls[0]!.id}`, ['dependsOn']);
      }
      if (Math.abs(w.meta.base + w.meta.height - top) > AGREE) {
        throw new Refusal(`${w.id}'s top is not level with the other walls under the roof`, [
          'dependsOn',
        ]);
      }
      if (Math.abs(w.meta.thickness - thickness) > AGREE) {
        throw new Refusal(
          `${w.id} is framed thicker or thinner than the other walls under the roof`,
          ['dependsOn'],
        );
      }
    }
    const ring = exteriorRing(walls, 'a roof');
    const fp = footprintOn(rectangleOf(ring.points, ring.edges), p.ridge);
    return { level, walls, footprint: fp, ...fp, plate: top, wallThickness: thickness };
  }
  if (p.level === undefined) {
    throw new Refusal('a roof bears on the walls in its dependsOn, or on a level', [
      'params',
      'level',
    ]);
  }
  const level = findLevel(levels, p.level);
  if (level === undefined) throw new Refusal(`there is no level "${p.level}"`, ['params', 'level']);
  const x = need(ctx, 'x', 'x');
  const y = need(ctx, 'y', 'y');
  const length = need(ctx, 'length', 'a length');
  const width = need(ctx, 'width', 'a width');
  const rotation = ctx.values.rotation ?? 0;
  const plate = level.elevation + (ctx.values.plate ?? level.height);
  const wallThickness = need(ctx, 'wallThickness', 'the wall thickness (the birdsmouth seat)');
  for (const [key, value, lo, hi] of [
    ['x', x, -MAX_COORDINATE, MAX_COORDINATE],
    ['y', y, -MAX_COORDINATE, MAX_COORDINATE],
    ['length', length, 1, MAX_SEGMENT_LENGTH],
    ['width', width, 1, MAX_SEGMENT_LENGTH],
    ['rotation', rotation, -4 * Math.PI, 4 * Math.PI],
    ['plate', plate, -2 * MAX_LEVEL_LENGTH, 2 * MAX_LEVEL_LENGTH],
    ['wallThickness', wallThickness, 1, MAX_LAYER_THICKNESS],
  ] as const) {
    if (!(value >= lo && value <= hi)) {
      throw new Refusal(`the roof's ${key} is out of range`, ['expressions', key]);
    }
  }
  const u: P2 = [Math.cos(rotation), Math.sin(rotation)];
  const v: P2 = [-u[1], u[0]];
  const c1: P2 = [x, y];
  const c2: P2 = [x + u[0] * length, y + u[1] * length];
  const c3: P2 = [c2[0] + v[0] * width, c2[1] + v[1] * width];
  const c4: P2 = [x + v[0] * width, y + v[1] * width];
  const fp = footprintOn({ corners: [c1, c2, c3, c4], sources: [[], [], [], []] }, p.ridge);
  return { level: level.id, walls: [], footprint: undefined, ...fp, plate, wallThickness };
}

/**
 * The gable studs' layout: the stud stock and spacing of the gable walls and, per end, where one
 * of their layout positions lies along the end from the footprint's v = 0.
 */
function gableStudsFor(b: Bearing): GableStuds | undefined {
  if (b.footprint === undefined) return undefined;
  const graph = wallGraph(b.walls);
  const V: P2 = [-Math.sin(b.direction), Math.cos(b.direction)];
  let stock: GableStuds['stock'] | undefined;
  let spacing = 0;
  const origin: { e2?: number; e4?: number } = {};
  for (const n of [4, 2] as const) {
    const src = b.footprint.under(n)[0];
    const wall = src === undefined ? undefined : b.walls.find((w) => w.id === src.wall);
    if (src === undefined || wall === undefined) continue;
    let settings;
    try {
      settings = resolveWallSettings(wall.meta.settings);
    } catch (error) {
      if (error instanceof FramingInputError)
        throw new Refusal(`${wall.id}: ${error.message}`, ['dependsOn']);
      throw error;
    }
    const seg = framedWall(graph, wall).segments[src.segment]!;
    const e = sub2(seg.end, seg.start);
    const l = Math.hypot(e[0], e[1]);
    const d: P2 = l > 0 ? [e[0] / l, e[1] / l] : [0, 0];
    const at: P2 =
      settings.layoutFrom === 'start'
        ? [seg.start[0] + d[0] * settings.layoutOrigin, seg.start[1] + d[1] * settings.layoutOrigin]
        : [seg.end[0] - d[0] * settings.layoutOrigin, seg.end[1] - d[1] * settings.layoutOrigin];
    origin[n === 2 ? 'e2' : 'e4'] = dot2(sub2(at, b.origin), V);
    // One stock and spacing for both ends: the first gable wall's (e4's when it has one).
    if (stock === undefined) {
      stock = settings.studStock;
      spacing = settings.spacing;
    }
  }
  return stock === undefined ? undefined : { stock, spacing, origin };
}

function build(ctx: ExtensionContext<RoofParams>): {
  inputs: ExtrudeInput[];
  metadata: RoofMetadata;
} {
  const f = ctx.feature;
  const p = ctx.params;
  if (f.operation !== undefined && f.operation !== 'new') {
    throw new Refusal('a roof makes its sheathing: its operation is "new" or none', ['operation']);
  }
  checkExpressionNames(ctx, 'a roof', (name) => {
    const move = /^move_([1-9][0-9]*)$/.exec(name);
    return move !== null
      ? Number(move[1]) <= p.overrides.length
      : Object.hasOwn(ROOF_EXPRESSIONS, name);
  });
  const data = constructionData(ctx);
  if (data === undefined) {
    throw new Refusal('the document has no construction settings (levels and roof types)', [
      'params',
      'roofType',
    ]);
  }
  const doc = data.settings;
  const type: RoofType | undefined = doc.roofTypes.find((t) => t.id === p.roofType);
  if (type === undefined) {
    throw new Refusal(`there is no roof type "${p.roofType}"`, ['params', 'roofType']);
  }
  const pitch = ctx.values.pitch;
  if (pitch === undefined) throw new Refusal('a roof needs a pitch', ['expressions', 'pitch']);
  if (!(pitch > 0 && pitch < MAX_PITCH)) {
    throw new Refusal('the pitch must be above 0 and below 80 degrees', ['expressions', 'pitch']);
  }
  const b = bearing(ctx, doc.levels);
  if (!(b.length <= MAX_SEGMENT_LENGTH && b.width <= MAX_SEGMENT_LENGTH)) {
    throw new Refusal(`a roof's sides are at most ${MAX_SEGMENT_LENGTH / 1000} m`, ['dependsOn']);
  }

  // Settings: the roof's expressions over its roof type over the generator's defaults.
  const v = ctx.values;
  const stock = stockData(ctx);
  const at = ['params', 'roofType'];
  for (const [key, hi] of [
    ['overhang', MAX_OVERHANG],
    ['rakeOverhang', MAX_OVERHANG],
    ['spacing', MAX_SEGMENT_LENGTH],
    ['tieHeight', MAX_WALL_HEIGHT],
  ] as const) {
    const value = v[key] ?? (key === 'tieHeight' ? undefined : type[key]);
    if (value !== undefined && !(value >= 0 && value <= hi)) {
      throw new Refusal(`the ${key} must be from 0 to ${hi / 1000} m`, ['expressions', key]);
    }
  }
  const spacing = v.spacing ?? type.spacing;
  if (spacing !== undefined && !(spacing >= MIN_FEATURE_SPACING)) {
    throw new Refusal(`the spacing must be at least ${MIN_FEATURE_SPACING} mm`, [
      'expressions',
      'spacing',
    ]);
  }
  if (p.kind === 'hip' && v.rakeOverhang !== undefined) {
    throw new Refusal('a hip roof has no rakes: its overhang runs all round', [
      'expressions',
      'rakeOverhang',
    ]);
  }
  let ties: RoofTies = { kind: 'none' };
  if (p.ties.kind !== 'none') {
    const tieStock = stockFor(p.ties.stock!, stock, 'lumber', 'The tie stock', ['params', 'ties']);
    if (p.ties.kind === 'rafter-ties') {
      const height = v.tieHeight;
      if (height === undefined) {
        throw new Refusal('rafter ties need a height above the plates', [
          'expressions',
          'tieHeight',
        ]);
      }
      ties = { kind: 'rafter-ties', stock: tieStock, every: p.ties.every!, height };
    } else {
      ties = { kind: 'ceiling-joists', stock: tieStock, every: p.ties.every! };
    }
  }
  if (p.ties.kind !== 'rafter-ties' && v.tieHeight !== undefined) {
    throw new Refusal('only rafter ties have a height', ['expressions', 'tieHeight']);
  }
  const gableStuds = p.kind === 'gable' && p.gableStuds ? gableStudsFor(b) : undefined;
  const settings = defined({
    rafterStock: stockFor(type.rafterStock, stock, 'lumber', 'The rafter stock', at),
    ridgeStock: stockFor(type.ridgeStock, stock, 'lumber', 'The ridge stock', at),
    hipStock:
      type.hipStock === undefined
        ? undefined
        : stockFor(type.hipStock, stock, 'lumber', 'The hip stock', at),
    spacing,
    overhang: v.overhang ?? type.overhang,
    rakeOverhang: p.kind === 'gable' ? (v.rakeOverhang ?? type.rakeOverhang) : undefined,
    tail: type.tail,
    ties,
    gableStuds,
    subFascia:
      type.subFascia === undefined
        ? undefined
        : stockFor(type.subFascia, stock, 'lumber', 'The sub-fascia stock', at),
    fascia:
      type.fascia === undefined
        ? undefined
        : stockFor(type.fascia, stock, 'lumber', 'The fascia stock', at),
  }) as RoofSettingsInput;
  let st;
  try {
    st = resolveRoofSettings(settings);
  } catch (error) {
    if (error instanceof FramingInputError) throw new Refusal(error.message, at);
    throw error;
  }
  const input = defined({
    roof: f.id,
    kind: p.kind,
    pitch,
    footprint: {
      origin: b.origin,
      direction: b.direction,
      length: b.length,
      width: b.width,
      plate: b.plate,
      wallThickness: b.wallThickness,
    },
    settings,
    overrides: p.overrides.length === 0 ? undefined : resolveOverrides(p.overrides, v, stock),
  }) as FrameRoofInput;
  if (p.kind === 'hip' && b.width > b.length + AGREE) {
    throw new Refusal('a hip roof needs its ridge along the longer side', ['params', 'ridge']);
  }

  // Bodies.
  const makes = f.operation === 'new';
  const L = b.length;
  const W = b.width;
  const cos = Math.cos(pitch);
  const sin = Math.sin(pitch);
  const tan = Math.tan(pitch);
  const U: P2 = [Math.cos(b.direction), Math.sin(b.direction)];
  const V: P2 = [-U[1], U[0]];
  const world = (u: number, w: number): P2 => [
    b.origin[0] + U[0] * u + V[0] * w,
    b.origin[1] + U[1] * u + V[1] * w,
  ];
  // Each edge counter-clockwise: its start in the roof's plan, along it, inward.
  const edgeFrames: Record<1 | 2 | 3 | 4, { c: P2; t: P2 }> = {
    1: { c: world(0, 0), t: U },
    2: { c: world(L, 0), t: V },
    3: { c: world(L, W), t: [-U[0], -U[1]] },
    4: { c: world(0, W), t: [-V[0], -V[1]] },
  };
  const inputs: ExtrudeInput[] = [];
  let sheathing: RoofMetadata['sheathing'] = null;
  if (makes && type.sheathing !== undefined) {
    stockFor(type.sheathing, stock, 'sheet', 'The roof sheathing', at);
    const thickness = stockThickness(type.sheathing, stock) ?? 0;
    if (!(thickness > 0 && thickness <= MAX_LAYER_THICKNESS)) {
      throw new Refusal(
        `the roof sheathing's thickness is outside 0 to ${MAX_LAYER_THICKNESS} mm`,
        at,
      );
    }
    // The rafters' top edge at the wall line, plumb above the plates (as `frameRoof` has it).
    const hap = st.rafterStock.depth / cos - b.wallThickness * tan;
    const bodies: string[] = [];
    for (const plane of sheathingOutlines(p.kind, L, W, st.overhang, st.rakeOverhang)) {
      const { c, t } = edgeFrames[plane.edge];
      const r: P2 = [-t[1], t[0]];
      const key = `sheathing-e${plane.edge}`;
      const body = `${f.id}:layer/${key}`;
      bodies.push(body);
      inputs.push({
        kind: 'extrude',
        id: f.id,
        body,
        capRole: `cap.${key}`,
        profile: {
          // y = normal x xDir = r cos + z sin: up the slope.
          frame: {
            origin: v3(c, b.plate + hap),
            xDir: [t[0], t[1], 0],
            normal: [-r[0] * sin, -r[1] * sin, cos],
          },
          loops: [
            loop(
              plane.points.map(([tt, rr]): P2 => [tt, rr / cos]),
              plane.ids.map((id) => `${key}.${id}`),
            ),
          ],
        },
        extent: { type: 'blind', distance: thickness },
        mode: 'new',
      });
    }
    sheathing = { stock: type.sheathing, thickness, bodies };
  }
  const gables: { edge: 2 | 4; wall: string; body: string }[] = [];
  if (makes && p.kind === 'gable' && b.footprint !== undefined) {
    const rise = (W / 2) * tan;
    for (const n of [2, 4] as const) {
      const src = b.footprint.under(n)[0];
      const wall = src === undefined ? undefined : b.walls.find((w) => w.id === src.wall);
      if (src === undefined || wall === undefined) continue;
      const seg = planSegments(wall.meta.points, wall.meta.closed)[src.segment]!;
      const { c, t } = edgeFrames[n];
      const end: P2 = [c[0] + t[0] * W, c[1] + t[1] * W];
      const s0 = dot2(sub2(c, seg.a), seg.d);
      const s1 = dot2(sub2(end, seg.a), seg.d);
      const [lo, hi] = s0 <= s1 ? [s0, s1] : [s1, s0];
      // The exterior sheet layers: those outside the framing, with bodies.
      for (const layer of wall.meta.layers) {
        if (layer.body === null || (layer.kind !== 'siding' && layer.kind !== 'sheathing'))
          continue;
        if (!ctx.bodies.includes(layer.body)) continue;
        const key = `gable-e${n}-${layer.id}`;
        const body = `${f.id}:layer/${key}`;
        const o: P2 = [seg.a[0] + seg.n[0] * layer.t[1], seg.a[1] + seg.n[1] * layer.t[1]];
        inputs.push({
          kind: 'extrude',
          id: f.id,
          body,
          capRole: `cap.${key}`,
          profile: {
            // Normal to the exterior (right of the path): y = normal x xDir is up.
            frame: {
              origin: v3(o, b.plate),
              xDir: [seg.d[0], seg.d[1], 0],
              normal: [-seg.n[0], -seg.n[1], 0],
            },
            loops: [
              loop(
                [
                  [lo, 0],
                  [hi, 0],
                  [(lo + hi) / 2, rise],
                ],
                [`${key}.bottom`, `${key}.rake-b`, `${key}.rake-a`],
              ),
            ],
          },
          extent: { type: 'blind', distance: layer.t[1] - layer.t[0] },
          mode: 'new',
        });
        gables.push({ edge: n, wall: wall.id, body });
      }
    }
  }
  if (makes && inputs.length === 0) {
    throw new Refusal(
      `roof type "${type.id}" has no sheathing and the roof no gable walls to make bodies of: a roof of framing only has no operation`,
      ['operation'],
    );
  }
  return {
    inputs,
    metadata: {
      kind: 'roof',
      level: b.level,
      walls: b.walls.map((w) => w.id),
      input,
      sheathing,
      gables,
    },
  };
}

/** The sheathing and gable bodies and framing input of a roof, or why it cannot be built. */
export function translateRoof(ctx: ExtensionContext<RoofParams>): ExtensionOutput {
  try {
    const { inputs, metadata } = build(ctx);
    return { inputs, metadata: toJson(metadata) };
  } catch (error) {
    if (error instanceof Refusal) return failure(error);
    throw error;
  }
}

/** The `construction.roof` extension type, as regen's registry takes it. */
export const roofType: ExtensionType<RoofParams> = {
  schemaVersion: ROOF_SCHEMA_VERSION,
  expressions: ROOF_EXPRESSIONS,
  params(params, schemaVersion) {
    return readRoofParams(params as Json, schemaVersion);
  },
  translate(ctx) {
    return translateRoof(ctx);
  },
};

// Members ----------------------------------------------------------------------------------------

/** One group per roof that reports its framing input: the roof alone (its input holds the walls'). */
export function roofGroups(ctx: MemberStageContext): MemberGroup[] {
  return ctx.features.flatMap((f: MemberFeature) =>
    f.type === ROOF_TYPE && readRoofMetadata(f.metadata) !== undefined
      ? [{ id: f.id, features: [f.id] }]
      : [],
  );
}

/** A roof's members through `frameRoof` (T6.2c), gable studs included. */
export function frameRoofGroup(ctx: MemberGroupContext): MemberOutput | { error: string } {
  const roof = ctx.features.find((f) => f.id === ctx.group.id);
  const meta = readRoofMetadata(roof?.metadata);
  if (meta === undefined) return { error: `${ctx.group.id} reports no roof footprint` };
  let result;
  try {
    result = frameRoof(meta.input);
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
  const metadata = { geometry: result.geometry, overrides: result.overrides };
  return { members: result.members, warnings, metadata: toJson(metadata) as JsonValue };
}
