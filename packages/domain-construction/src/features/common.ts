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
  readId,
  type Path,
  type Read,
  type StockData,
} from '@manufakture/stock';
import { CONSTRUCTION_NAMESPACE, type ConstructionData } from '../data';
import type { HeaderSpec, Justification, MemberOverride, WallSettingsInput } from '../framing/wall';
import type { StockRef } from '../members';
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

/** Per-member override params as stored: `{ id, delete?, stock? }`; a nudge is `move_<n>`. */
export interface StoredOverride {
  readonly id: string;
  readonly delete?: boolean;
  readonly stock?: string;
}

/** Local member ids: letters, digits, `-`, `:` and `/` (`s12`, `top1:2`, `seg2/s0`, `king-l`). */
const LOCAL_ID = /^[a-z0-9][a-z0-9:/-]{0,127}$/;

/** The expression that nudges the n-th override (1-based): `move_<n>`. */
export const moveExpression = (n: number): string => `move_${n}`;

export function readOverrides(v: unknown, at: Path): Read<StoredOverride[]> {
  if (v === undefined) return ok([]);
  if (!Array.isArray(v)) return fail('expected a list of member overrides', at);
  if (v.length > MAX_OVERRIDES) return fail(`at most ${MAX_OVERRIDES} overrides are allowed`, at);
  const out: StoredOverride[] = [];
  const ids = new Set<string>();
  for (let i = 0; i < v.length; i++) {
    const o: unknown = v[i];
    const oat = [...at, i];
    if (!isObject(o)) return fail('expected an override { id, delete?, stock? }', oat);
    const keys = onlyKeys(o, ['id', 'delete', 'stock'], oat);
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
    out.push({
      id,
      ...(del === undefined ? {} : { delete: del }),
      ...(stock === undefined ? {} : { stock: stock as string }),
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
  /** The layer bodies the opening cuts. */
  readonly cuts: readonly string[];
  readonly swing?: 'in' | 'out';
  readonly hand?: 'left' | 'right';
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
