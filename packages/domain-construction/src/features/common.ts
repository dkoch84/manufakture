// What the wall and opening features share: their metadata (the framing input each translator
// reports, ADR 0015 decision 5), the bounds that keep a hostile document from hanging the regen
// worker, stock lookups through the shared catalog, and the per-member override params.
//
// Metadata is derived and never stored (ADR 0013 decision 7): recomputed on every regen, plain
// JSON, read back by the member stage (`stage.ts`) and by openings from their host wall.

import type { ExtensionContext, ExtensionFailure, JsonValue } from '@manufakture/regen';
import {
  EMPTY_STOCK_DATA,
  STOCK_NAMESPACE,
  fail,
  isObject,
  ok,
  onlyKeys,
  own,
  readEnum,
  readId,
  type Path,
  type Read,
  type StockData,
} from '@manufakture/stock';
import { CONSTRUCTION_NAMESPACE, type ConstructionData } from '../data';
import type {
  AddedMember,
  HeaderSpec,
  Justification,
  MemberOverride,
  WallSettingsInput,
} from '../framing/wall';
import { MAX_ADDED, parseAddedMemberId } from '../member-ids';
import { PHASES, type Phase, type StockRef } from '../members';
import { stockKind, stockRef } from '../stock';

export const WALL_TYPE = 'construction.wall';
export const OPENING_TYPE = 'construction.opening';

// Bounds -----------------------------------------------------------------------------------------

/** The most points a wall's path may have. */
export const MAX_WALL_POINTS = 64;
/** The longest wall segment, mm (100 m). */
export const MAX_SEGMENT_LENGTH = 100_000;
/**
 * The largest path coordinate, mm (500 m from the origin). Half of regen's `MAX_MEMBER_SIZE`
 * (1 km), which bounds every member coordinate: layer offsets, mitres, cap plate laps, a level's
 * elevation and a nudge of up to `MAX_SEGMENT_LENGTH` all stay well inside the rest, so a wall
 * near the limit is refused here with a clear message, never as a malformed member.
 */
export const MAX_COORDINATE = 500_000;
/** The tallest wall, mm (30 m). */
export const MAX_WALL_HEIGHT = 30_000;
/** The most per-member overrides one feature may hold. */
export const MAX_OVERRIDES = 500;
/** Stock sizes a feature accepts, mm: lumber and sheets between these (with overrides). */
export const MIN_STOCK_SIZE = 1;
export const MAX_STOCK_SIZE = 2_000;
/** The thickest layer, mm. */
export const MAX_LAYER_THICKNESS = 1_000;
/** Layout spacings at least this, mm (as `domains.construction` requires). */
export const MIN_FEATURE_SPACING = 50;

// Failures ---------------------------------------------------------------------------------------

/** A translator's refusal, with the field at fault. */
export class Refusal extends Error {
  constructor(
    message: string,
    readonly field: Path,
  ) {
    super(message);
  }
}

export function failure(e: Refusal): ExtensionFailure {
  return { error: e.message, field: [...e.field] };
}

// Domain data ------------------------------------------------------------------------------------

export function constructionData(ctx: ExtensionContext<unknown>): ConstructionData | undefined {
  return Object.hasOwn(ctx.data, CONSTRUCTION_NAMESPACE)
    ? (ctx.data[CONSTRUCTION_NAMESPACE] as ConstructionData)
    : undefined;
}

export function stockData(ctx: ExtensionContext<unknown>): StockData {
  return Object.hasOwn(ctx.data, STOCK_NAMESPACE)
    ? (ctx.data[STOCK_NAMESPACE] as StockData)
    : EMPTY_STOCK_DATA;
}

/**
 * A catalog stock as the generators take it, with the document's overrides, checked to be of
 * `kind` (`any`: either) and within the size bounds; a `Refusal` naming `what` otherwise. A
 * sheet's depth is its sheet width, which is not bounded here.
 */
export function stockFor(
  id: string,
  data: StockData,
  kind: 'lumber' | 'sheet' | 'any',
  what: string,
  field: Path,
): StockRef {
  const ref = stockRef(id, data);
  if (ref === undefined)
    throw new Refusal(`${what}: "${id}" is not a stock this build knows`, field);
  if (kind !== 'any' && stockKind(id) !== kind) {
    throw new Refusal(
      `${what}: "${id}" is not ${kind === 'lumber' ? 'lumber' : 'sheet stock'}`,
      field,
    );
  }
  const sizes = kind === 'lumber' ? [ref.width, ref.depth] : [ref.width];
  if (!sizes.every((v) => v >= MIN_STOCK_SIZE && v <= MAX_STOCK_SIZE)) {
    throw new Refusal(
      `${what}: "${id}" has a size outside ${MIN_STOCK_SIZE} mm to ${MAX_STOCK_SIZE} mm (check the stock override)`,
      field,
    );
  }
  return ref;
}

// Stored params ----------------------------------------------------------------------------------

/**
 * Per-member override params as stored: `{ id, delete?, stock?, at? }`; a nudge is `move_<n>`.
 * `at` (#1215, a wall's overrides only) is where the member was when the override was made: its
 * centre line along its segment, mm from the segment's first point (as an opening's `position`),
 * before the override's own nudge. A wall's layout studs (`s<k>`) and blocks (`block<r>:<n>`)
 * are then found by position, not id, so a spacing, origin or direction change cannot re-target
 * the override (`OverrideReport`). It is a plain number, not an expression: it records a fact, is
 * written by whoever makes the override, and stays with its entry when others are removed.
 */
export interface StoredOverride {
  readonly id: string;
  readonly delete?: boolean;
  readonly stock?: string;
  readonly at?: number;
  /** The member's phase (#1213): `existing`, `new` or `demolish` (see `MemberOverride.phase`). */
  readonly phase?: Phase;
}

/** Local member ids: letters, digits, `-`, `:` and `/` (`s12`, `top1:2`, `seg2/s0`, `king-l`). */
const LOCAL_ID = /^[a-z0-9][a-z0-9:/-]{0,127}$/;

/** The expression that nudges the n-th override (1-based): `move_<n>`. */
export const moveExpression = (n: number): string => `move_${n}`;

/**
 * A feature's `overrides` params. `positions`: whether entries may carry `at` (walls only: an
 * opening's, a floor's and a roof's member ids do not renumber with a wall's layout).
 */
export function readOverrides(v: unknown, at: Path, positions = false): Read<StoredOverride[]> {
  if (v === undefined) return ok([]);
  if (!Array.isArray(v)) return fail('expected a list of member overrides', at);
  if (v.length > MAX_OVERRIDES) return fail(`at most ${MAX_OVERRIDES} overrides are allowed`, at);
  const out: StoredOverride[] = [];
  const ids = new Set<string>();
  for (let i = 0; i < v.length; i++) {
    const o: unknown = v[i];
    const oat = [...at, i];
    if (!isObject(o)) {
      return fail(
        `expected an override { id, delete?, stock?${positions ? ', at?' : ''}, phase? }`,
        oat,
      );
    }
    const keys = onlyKeys(o, ['id', 'delete', 'stock', 'phase', ...(positions ? ['at'] : [])], oat);
    if (!keys.ok) return keys;
    const id = own(o, 'id');
    if (typeof id !== 'string' || !LOCAL_ID.test(id)) {
      return fail('expected a member id local to the feature, like "s12" or "king-l"', [
        ...oat,
        'id',
      ]);
    }
    if (ids.has(id)) return fail(`two overrides name "${id}"`, [...oat, 'id']);
    ids.add(id);
    const del = own(o, 'delete');
    if (del !== undefined && typeof del !== 'boolean') {
      return fail('expected true or false', [...oat, 'delete']);
    }
    const stock = own(o, 'stock');
    if (stock !== undefined) {
      const r = readId(stock, [...oat, 'stock'], 'a stock id');
      if (!r.ok) return r;
    }
    const pos = own(o, 'at');
    if (pos !== undefined && !(typeof pos === 'number' && Math.abs(pos) <= MAX_SEGMENT_LENGTH)) {
      return fail(
        `expected the member's position along its segment, mm, within ${MAX_SEGMENT_LENGTH}`,
        [...oat, 'at'],
      );
    }
    const phase = own(o, 'phase');
    let readPhase: Phase | undefined;
    if (phase !== undefined) {
      const r = readEnum(phase, PHASES, [...oat, 'phase']);
      if (!r.ok) return r;
      readPhase = r.value;
    }
    out.push({
      id,
      ...(del === undefined ? {} : { delete: del }),
      ...(stock === undefined ? {} : { stock: stock as string }),
      ...(pos === undefined ? {} : { at: pos }),
      ...(readPhase === undefined ? {} : { phase: readPhase }),
    });
  }
  return ok(out);
}

/** A whole number from `lo` to `hi`, or absent. */
export function readOptionalCount(
  o: Readonly<Record<string, unknown>>,
  key: string,
  at: Path,
  lo: number,
  hi: number,
): Read<number | undefined> {
  const v = own(o, key);
  if (v === undefined) return ok(undefined);
  if (typeof v !== 'number' || !Number.isInteger(v) || v < lo || v > hi) {
    return fail(`expected a whole number from ${lo} to ${hi}`, [...at, key]);
  }
  return ok(v);
}

/**
 * The overrides resolved: stocks looked up (lumber, bounded), nudges from `move_<n>`. Expressions
 * named `move_<n>` with no n-th override are refused by the caller's expression check.
 */
export function resolveOverrides(
  stored: readonly StoredOverride[],
  values: Readonly<Record<string, number>>,
  data: StockData,
): MemberOverride[] {
  return stored.map((o, i) => {
    const move = values[moveExpression(i + 1)];
    if (move !== undefined && !(Math.abs(move) <= MAX_SEGMENT_LENGTH)) {
      throw new Refusal(`the nudge of ${o.id} is too far`, ['expressions', moveExpression(i + 1)]);
    }
    return {
      id: o.id,
      ...(o.delete === undefined ? {} : { delete: o.delete }),
      ...(o.stock === undefined
        ? {}
        : {
            stock: stockFor(o.stock, data, 'lumber', `The override of ${o.id}`, [
              'params',
              'overrides',
              i,
              'stock',
            ]),
          }),
      ...(move === undefined ? {} : { move }),
      ...(o.at === undefined ? {} : { at: o.at }),
      ...(o.phase === undefined ? {} : { phase: o.phase }),
    };
  });
}

// Phases -----------------------------------------------------------------------------------------

/** A feature's `phase` param (#1213): absent, or `existing`, `new` or `demolish`. */
export function readPhaseParam(params: Readonly<Record<string, unknown>>): Read<Phase | undefined> {
  const v = own(params, 'phase');
  return v === undefined ? ok(undefined) : readEnum(v, PHASES, ['phase']);
}

/**
 * A feature's phase as built into its metadata: its `phase` param, else `existing` in a document
 * marked as built (`domains.construction.asBuilt`) and `new` otherwise. Metadata records only
 * `existing` and `demolish` (`phaseField`), so a document that uses no phases reports what it did
 * before them.
 */
export function featurePhase(ctx: ExtensionContext<unknown>, stored: Phase | undefined): Phase {
  if (stored !== undefined) return stored;
  return constructionData(ctx)?.settings.asBuilt === true ? 'existing' : 'new';
}

/** The metadata field of a phase: none for `new`, the default. */
export const phaseField = (phase: Phase): { phase?: 'existing' | 'demolish' } =>
  phase === 'new' ? {} : { phase };

/** The phase a feature's metadata records: `new` when it records none. */
export function metadataPhase(metadata: unknown): Phase {
  if (!isObject(metadata)) return 'new';
  const p = own(metadata, 'phase');
  return p === 'existing' || p === 'demolish' ? p : 'new';
}

/**
 * A member the layout does not make, as stored in a wall's or opening's `add` params (#1214):
 * `{ id: "add<k>", role: "stud" | "blocking", stock?, plies?, segment? }`. Its position is the
 * expression `add<k>_at` (along the wall: a wall's from its segment's first point, an opening's
 * from its centre line) and a block's height the expression `add<k>_z` (its centre above the
 * wall's base). `segment` is a wall's only; `plies` a stud's only.
 */
export interface StoredAdd {
  readonly id: string;
  readonly role: 'stud' | 'blocking';
  readonly stock?: string;
  readonly plies?: number;
  readonly segment?: number;
}

/** The expression that places the added member `id` along the wall: `<id>_at`. */
export const addAtExpression = (id: string): string => `${id}_at`;
/** The expression that sets an added block's height: `<id>_z`. */
export const addZExpression = (id: string): string => `${id}_z`;

/** Every expression an added member may have, by kind (for a feature type's `expressions`). */
export const ADD_EXPRESSIONS: readonly (readonly [string, 'length'])[] = Array.from(
  { length: MAX_ADDED },
  (_, i) => [
    [addAtExpression(`add${i + 1}`), 'length'] as const,
    [addZExpression(`add${i + 1}`), 'length'] as const,
  ],
).flat();

/**
 * Whether `name` is an expression of one of `adds`: `<id>_at` for any, `<id>_z` for a block.
 */
export function isAddExpression(name: string, adds: readonly StoredAdd[]): boolean {
  const m = /^(add[1-9][0-9]*)_(at|z)$/.exec(name);
  if (m === null) return false;
  const a = adds.find((x) => x.id === m[1]);
  return a !== undefined && (m[2] === 'at' || a.role === 'blocking');
}

/** A wall's or opening's `add` params; `segments` is whether entries may name a segment (walls). */
export function readAdds(v: unknown, at: Path, segments: boolean): Read<StoredAdd[]> {
  if (v === undefined) return ok([]);
  if (!Array.isArray(v)) return fail('expected a list of added members', at);
  if (v.length > MAX_ADDED) return fail(`at most ${MAX_ADDED} added members are allowed`, at);
  const out: StoredAdd[] = [];
  const ids = new Set<string>();
  for (let i = 0; i < v.length; i++) {
    const o: unknown = v[i];
    const oat = [...at, i];
    const shape = `{ id, role, stock?, plies?${segments ? ', segment?' : ''} }`;
    if (!isObject(o)) return fail(`expected an added member ${shape}`, oat);
    const keys = onlyKeys(
      o,
      ['id', 'role', 'stock', 'plies', ...(segments ? ['segment'] : [])],
      oat,
    );
    if (!keys.ok) return keys;
    const id = own(o, 'id');
    const parsed = typeof id === 'string' ? parseAddedMemberId(id) : undefined;
    if (parsed === undefined || parsed.ply !== 1) {
      return fail(`expected an added member id, add1 to add${MAX_ADDED}`, [...oat, 'id']);
    }
    if (ids.has(id as string)) return fail(`two added members are "${id}"`, [...oat, 'id']);
    ids.add(id as string);
    const role = readEnum(own(o, 'role'), ['stud', 'blocking'] as const, [...oat, 'role']);
    if (!role.ok) return role;
    const stock = own(o, 'stock');
    if (stock !== undefined) {
      const r = readId(stock, [...oat, 'stock'], 'a stock id');
      if (!r.ok) return r;
    }
    const plies = readOptionalCount(o, 'plies', oat, 1, role.value === 'stud' ? 4 : 1);
    if (!plies.ok) return plies;
    const segment = segments ? readOptionalCount(o, 'segment', oat, 1, 1_000) : ok(undefined);
    if (!segment.ok) return segment;
    out.push({
      id: id as string,
      role: role.value,
      ...(stock === undefined ? {} : { stock: stock as string }),
      ...(plies.value === undefined ? {} : { plies: plies.value }),
      ...(segment.value === undefined ? {} : { segment: segment.value }),
    });
  }
  return ok(out);
}

/**
 * The added members resolved: stocks looked up (lumber, bounded), positions from `<id>_at` (which
 * each needs) and block heights from `<id>_z`.
 */
export function resolveAdds(
  stored: readonly StoredAdd[],
  values: Readonly<Record<string, number>>,
  data: StockData,
): AddedMember[] {
  return stored.map((a, i) => {
    const atName = addAtExpression(a.id);
    const at = values[atName];
    if (at === undefined) {
      throw new Refusal(`the added member ${a.id} needs its position along the wall, ${atName}`, [
        'expressions',
        atName,
      ]);
    }
    if (!(Math.abs(at) <= MAX_SEGMENT_LENGTH)) {
      throw new Refusal(`the position of ${a.id} is too far`, ['expressions', atName]);
    }
    const zName = addZExpression(a.id);
    const z = values[zName];
    if (z !== undefined && !(Math.abs(z) <= MAX_WALL_HEIGHT)) {
      throw new Refusal(`the height of ${a.id} is too far`, ['expressions', zName]);
    }
    return {
      id: a.id,
      role: a.role,
      at,
      ...(a.segment === undefined ? {} : { segment: a.segment }),
      ...(a.stock === undefined
        ? {}
        : {
            stock: stockFor(a.stock, data, 'lumber', `The added member ${a.id}`, [
              'params',
              'add',
              i,
              'stock',
            ]),
          }),
      ...(a.plies === undefined ? {} : { plies: a.plies }),
      ...(z === undefined ? {} : { z }),
    };
  });
}

// Metadata ---------------------------------------------------------------------------------------

/** One layer of a wall as built: where it lies across the path, and its body (none for framing). */
export interface LayerMetadata {
  readonly id: string;
  readonly kind: 'siding' | 'sheathing' | 'framing' | 'drywall';
  /** Its body id (`<wall>:layer/<layer id>`); null for the framing layer, which is members. */
  readonly body: string | null;
  /** Its extent across the path, mm, positive to the left of the path (the interior side). */
  readonly t: readonly [number, number];
}

/** What a wall's translator reports: its geometry and resolved framing settings. */
export interface WallMetadata {
  readonly kind: 'wall';
  readonly level: string;
  /** Elevation of the wall's base (the bottom of its bottom plate), mm. */
  readonly base: number;
  readonly height: number;
  /** The path in plan, mm; a closed path joins its last point to its first. */
  readonly points: readonly (readonly [number, number])[];
  readonly closed: boolean;
  readonly justification: Justification;
  /** The framing's thickness: the stud stock's depth. */
  readonly thickness: number;
  /** Ends that never join another wall (`joins` set to `free`). */
  readonly free: { readonly start: boolean; readonly end: boolean };
  /** Exterior to interior. */
  readonly layers: readonly LayerMetadata[];
  readonly settings: WallSettingsInput;
  readonly overrides: readonly MemberOverride[];
  /** Members the wall adds; absent when none (so older metadata reads the same). */
  readonly add?: readonly AddedMember[];
  /** Its phase (#1213); absent: `new`. A demolished wall makes no layer bodies. */
  readonly phase?: 'existing' | 'demolish';
}

/** Which header an opening asks for (ADR 0015 decision 7). */
export type OpeningHeader =
  | { readonly kind: 'auto' }
  | { readonly kind: 'default' }
  | { readonly kind: 'explicit'; readonly header: HeaderSpec };

/** What an opening's translator reports: its rough opening on its host wall. */
export interface OpeningMetadata {
  readonly kind: 'opening';
  /** The host wall's feature id (derived from `dependsOn`, never stored in params). */
  readonly wall: string;
  readonly type: 'door' | 'window' | 'opening';
  /** 1-based segment of the host wall. */
  readonly segment: number;
  /** Centre of the rough opening along the segment's path, from the segment's first point, mm. */
  readonly position: number;
  /** Rough opening width and height, and its bottom above the wall's base, mm. */
  readonly width: number;
  readonly height: number;
  readonly sill: number;
  readonly header: OpeningHeader;
  readonly kings?: number;
  readonly jacks?: number;
  readonly overrides: readonly MemberOverride[];
  /** Members the opening adds (`at` from its centre line); absent when none. */
  readonly add?: readonly AddedMember[];
  /** The layer bodies the opening cuts. */
  readonly cuts: readonly string[];
  readonly swing?: 'in' | 'out';
  readonly hand?: 'left' | 'right';
  /** Its phase (#1213); absent: `new`. A demolished opening cuts nothing. */
  readonly phase?: 'existing' | 'demolish';
}

export const toJson = (v: unknown): JsonValue => v as JsonValue;

/** A wall's metadata, or undefined when it is not one (a wall from older code, or no metadata). */
export function readWallMetadata(v: unknown): WallMetadata | undefined {
  if (!isObject(v) || own(v, 'kind') !== 'wall') return undefined;
  const points = own(v, 'points');
  if (!Array.isArray(points) || !Array.isArray(own(v, 'layers'))) return undefined;
  return v as unknown as WallMetadata;
}

export function readOpeningMetadata(v: unknown): OpeningMetadata | undefined {
  if (!isObject(v) || own(v, 'kind') !== 'opening' || typeof own(v, 'wall') !== 'string') {
    return undefined;
  }
  return v as unknown as OpeningMetadata;
}

// Plan geometry ----------------------------------------------------------------------------------

export type P2 = readonly [number, number];

export const sub2 = (a: P2, b: P2): P2 => [a[0] - b[0], a[1] - b[1]];
export const add2 = (a: P2, b: P2): P2 => [a[0] + b[0], a[1] + b[1]];
export const scale2 = (a: P2, s: number): P2 => [a[0] * s, a[1] * s];
export const dot2 = (a: P2, b: P2): number => a[0] * b[0] + a[1] * b[1];
export const cross2 = (a: P2, b: P2): number => a[0] * b[1] - a[1] * b[0];
export const len2 = (a: P2): number => Math.hypot(a[0], a[1]);

/** A wall segment in plan: its path ends, unit direction and left normal, length. */
export interface PlanSegment {
  readonly a: P2;
  readonly b: P2;
  readonly d: P2;
  /** Left of the direction: the interior side. */
  readonly n: P2;
  readonly length: number;
}

/** The segments of a path (the closing one last for a closed path). */
export function planSegments(points: readonly P2[], closed: boolean): PlanSegment[] {
  const count = closed ? points.length : points.length - 1;
  const out: PlanSegment[] = [];
  for (let i = 0; i < count; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    const v = sub2(b, a);
    const length = len2(v);
    const d: P2 = [v[0] / length, v[1] / length];
    out.push({ a, b, d, n: [-d[1], d[0]], length });
  }
  return out;
}

/** The framing's extent across the path for a justification and thickness, as `frameWall` has it. */
export function framingBand(justification: Justification, thickness: number): [number, number] {
  const t0 = justification === 'left' ? 0 : justification === 'right' ? -thickness : -thickness / 2;
  return [t0, t0 + thickness];
}
