// `domains.construction` (ADR 0015 decision 2, T6.1a): the document-level construction settings.
// Settings, not model (ADR 0013 decision 3): lengths are `StoredExpression`s that must be
// constants, stock is named by catalog id (data, not model ids), and nothing names a feature, a
// face or a variable. Read in memory through the migrations (`migrations[i]` takes version i + 1
// to i + 2), written at the current version only when the user edits it.
//
// Stored shape, version 1 (every top-level field optional; absent lists are empty):
//
//   {
//     levels: [{ id, name, elevation: SE, height: SE }],          // levels.ts
//     wallTypes: [{ id, name, layers: [                           // exterior to interior
//       { id, kind: 'siding' | 'sheathing', stock?: id, thickness?: SE },
//       { id, kind: 'framing', stock: id, spacing?: SE, bottomPlates?: n, topPlates?: n,
//         header: { stock: id, plies: n, jacks: n, spacer?: id } },  // the wall type's default
//       { id, kind: 'drywall', stock?: id, thickness?: SE },
//     ] }],
//     floorTypes: [{ id, name, joistStock: id, rimStock?: id, spacing?: SE, subfloor?: id }],
//     roofTypes: [{ id, name, rafterStock: id, ridgeStock: id, hipStock?: id, spacing?: SE,
//                   overhang?: SE, rakeOverhang?: SE, tail?: 'plumb' | 'square',
//                   subFascia?: id, fascia?: id, sheathing?: id }],
//     framing: { spacing?: SE, layoutOrigin?: SE, layoutFrom?: 'start' | 'end',
//                bottomPlates?: n, topPlates?: n, kings?: n,
//                cornerStyle?: 'two-stud' | 'three-stud' | 'ladder',
//                blocking?: { kind: 'none' } | { kind: 'mid-height' }
//                         | { kind: 'heights', heights: SE[] },
//                spliceOffset?: SE, plateStockLengths?: SE[], precutLengths?: SE[],
//                ladderSpacing?: SE },                              // document defaults
//     headerRules: [{ maxWidth: SE, header: { stock: id, plies: n, jacks: n, spacer?: id } }],
//   }
//
// Header rules (ADR 0015 decision 7): a user-edited table, `opening width up to maxWidth: header,
// jack studs`. A new document has none, and nothing here offers template rows or sizes: every
// structural size is the user's choice. A new wall type asks for its default header
// (`newWallType` takes it as a required argument).
//
// A stock id this build's catalog lacks is kept (it may come from a newer build) and only fails
// where it is resolved; a known one must be of the right kind (studs from lumber, layers from
// sheets).

import type { StoredExpression } from '@manufakture/core';
import {
  EMPTY_STOCK_DATA,
  constantLength,
  currentVersion,
  fail,
  isObject,
  migrate,
  ok,
  onlyKeys,
  own,
  readConstantLength,
  readEnum,
  type Json,
  type LengthOptions,
  type Path,
  type Read,
  type StockData,
  type Versioned,
} from '@manufakture/stock';
import type { CornerStyle } from './framing/wall';
import type { TailCut } from './framing/roof';
import { readDataId, readLevels, readName, type Level } from './levels';
import { stockKind, stockThickness, stockWidth } from './stock';

export const CONSTRUCTION_NAMESPACE = 'construction';

// Types ---------------------------------------------------------------------------------------
// Each with its lengths as `L`: `StoredExpression` as stored, `number` (mm) as evaluated.

/** A header: `plies` of `stock` (with an optional `spacer` between the first two) on `jacks` jack studs each end. */
export interface HeaderData {
  readonly stock: string;
  readonly plies: number;
  readonly jacks: number;
  readonly spacer?: string;
}

/** Layer kinds, exterior to interior. */
export type LayerKind = 'siding' | 'sheathing' | 'framing' | 'drywall';
export const LAYER_KINDS: readonly LayerKind[] = ['siding', 'sheathing', 'framing', 'drywall'];

/** A sheet layer: its thickness from `stock` (with the document's override), or as typed. */
export interface SheetLayer<L = number> {
  readonly id: string;
  readonly kind: 'siding' | 'sheathing' | 'drywall';
  readonly stock?: string;
  /** Overrides the stock's thickness; required when there is no stock (lap siding). */
  readonly thickness?: L;
}

/** The stud layer: its thickness is the stud stock's width. Absent fields use `framing`. */
export interface FramingLayer<L = number> {
  readonly id: string;
  readonly kind: 'framing';
  /** Stud stock (lumber). */
  readonly stock: string;
  readonly spacing?: L;
  readonly bottomPlates?: number;
  readonly topPlates?: number;
  /** The wall type's default header, used when no header rule covers an opening. */
  readonly header: HeaderData;
}

export type WallLayer<L = number> = SheetLayer<L> | FramingLayer<L>;

export interface WallType<L = number> {
  readonly id: string;
  readonly name: string;
  /** Exterior to interior: siding, sheathing, the one framing layer, drywall. */
  readonly layers: readonly WallLayer<L>[];
}

export interface FloorType<L = number> {
  readonly id: string;
  readonly name: string;
  readonly joistStock: string;
  /** Rim joists; the joist stock when absent. */
  readonly rimStock?: string;
  readonly spacing?: L;
  /** Subfloor sheets. */
  readonly subfloor?: string;
}

export interface RoofType<L = number> {
  readonly id: string;
  readonly name: string;
  readonly rafterStock: string;
  readonly ridgeStock: string;
  /** Hip rafters; a hip roof of this type needs it. */
  readonly hipStock?: string;
  readonly spacing?: L;
  readonly overhang?: L;
  readonly rakeOverhang?: L;
  readonly tail?: TailCut;
  readonly subFascia?: string;
  readonly fascia?: string;
  /** Roof sheathing sheets. */
  readonly sheathing?: string;
}

/**
 * Blocking rows between studs (`BlockingRows` with stored lengths): none, one at mid-height, or
 * centred at the given heights above the wall's base.
 */
export type BlockingRowsData<L = number> =
  | { readonly kind: 'none' }
  | { readonly kind: 'mid-height' }
  | { readonly kind: 'heights'; readonly heights: readonly L[] };

/**
 * Document-wide framing defaults a wall type or a wall may override (T6.2a's `WallSettings`).
 * Every `WallSettings` field is here except `studStock` and `defaultHeader` (the wall type's
 * framing layer carries those) and `headerRules` (the document's own table).
 */
export interface FramingSettings<L = number> {
  readonly spacing?: L;
  /** Where slot 0's centre line is, from the end layout starts at; may be negative. */
  readonly layoutOrigin?: L;
  readonly layoutFrom?: 'start' | 'end';
  readonly bottomPlates?: number;
  readonly topPlates?: number;
  readonly kings?: number;
  readonly cornerStyle?: CornerStyle;
  readonly blocking?: BlockingRowsData<L>;
  readonly spliceOffset?: L;
  readonly plateStockLengths?: readonly L[];
  readonly precutLengths?: readonly L[];
  readonly ladderSpacing?: L;
}

/** A row of the user's header rules: openings up to `maxWidth` get `header`. */
export interface HeaderRuleData<L = number> {
  readonly maxWidth: L;
  readonly header: HeaderData;
}

export interface ConstructionSettings<L = number> {
  readonly levels: readonly Level<L>[];
  readonly wallTypes: readonly WallType<L>[];
  readonly floorTypes: readonly FloorType<L>[];
  readonly roofTypes: readonly RoofType<L>[];
  readonly framing: FramingSettings<L>;
  readonly headerRules: readonly HeaderRuleData<L>[];
}

export type StoredConstructionSettings = ConstructionSettings<StoredExpression>;

/** `domains.construction` as read: as stored (for editors) and evaluated (mm). */
export interface ConstructionData {
  readonly stored: StoredConstructionSettings;
  readonly settings: ConstructionSettings;
}

export const EMPTY_CONSTRUCTION_SETTINGS: StoredConstructionSettings = Object.freeze({
  levels: [],
  wallTypes: [],
  floorTypes: [],
  roofTypes: [],
  framing: {},
  headerRules: [],
});

export const EMPTY_CONSTRUCTION_DATA: ConstructionData = Object.freeze({
  stored: EMPTY_CONSTRUCTION_SETTINGS,
  settings: EMPTY_CONSTRUCTION_SETTINGS as unknown as ConstructionSettings,
});

/** The migrations of `domains.construction` data (none yet: version 1 is current). */
export const CONSTRUCTION_DATA: Versioned = { what: 'construction data', migrations: [] };
export const CONSTRUCTION_DATA_VERSION = currentVersion(CONSTRUCTION_DATA);

/** Bounds on what a crafted file costs to read. */
export const MAX_TYPES = 100;
export const MAX_HEADER_RULES = 100;
export const MAX_LAYERS = 8;
export const MAX_LENGTHS = 20;

// Reading -------------------------------------------------------------------------------------

type Obj = Readonly<Record<string, unknown>>;

/** A stored constant length (validated, kept as typed). */
function length(v: unknown, at: Path, options: LengthOptions): Read<StoredExpression> {
  const r = readConstantLength(v, at, options);
  return r.ok ? ok(r.value.expression) : r;
}

function optionalLength(
  o: Obj,
  key: string,
  at: Path,
  options: LengthOptions,
): Read<StoredExpression | undefined> {
  const v = own(o, key);
  return v === undefined ? ok(undefined) : length(v, [...at, key], options);
}

function count(v: unknown, at: Path, lo: number, hi: number): Read<number> {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < lo || v > hi) {
    return fail(`expected a whole number from ${lo} to ${hi}`, at);
  }
  return ok(v);
}

function optionalCount(
  o: Obj,
  key: string,
  at: Path,
  lo: number,
  hi: number,
): Read<number | undefined> {
  const v = own(o, key);
  return v === undefined ? ok(undefined) : count(v, [...at, key], lo, hi);
}

const KIND_WORD = { lumber: 'lumber', sheet: 'sheet stock' } as const;

/** A catalog stock id; a known one must be of `kind` (an unknown one is kept, see above). */
function stockId(v: unknown, at: Path, kind?: 'lumber' | 'sheet'): Read<string> {
  if (typeof v !== 'string' || v.length === 0 || v.length > 256) {
    return fail('expected a stock id', at);
  }
  const found = stockKind(v);
  if (kind !== undefined && found !== undefined && found !== kind) {
    return fail(`"${v}" is not ${KIND_WORD[kind]}`, at);
  }
  return ok(v);
}

function optionalStock(
  o: Obj,
  key: string,
  at: Path,
  kind?: 'lumber' | 'sheet',
): Read<string | undefined> {
  const v = own(o, key);
  return v === undefined ? ok(undefined) : stockId(v, [...at, key], kind);
}

/** `T` with every key that may hold `undefined` made optional instead (exact optional types). */
type Defined<T> = {
  [K in keyof T as undefined extends T[K] ? never : K]: T[K];
} & {
  [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined>;
};

/** Copy the defined values only, so absent optional fields stay absent. */
function defined<T extends object>(o: T): Defined<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out as Defined<T>;
}

/** Run readers in order; the first failure wins. */
function all<T extends Record<string, Read<unknown>>>(
  reads: T,
): Read<{ [K in keyof T]: T[K] extends Read<infer V> ? V : never }> {
  const out: Record<string, unknown> = {};
  for (const [k, r] of Object.entries(reads)) {
    if (!r.ok) return r;
    out[k] = r.value;
  }
  return ok(out as { [K in keyof T]: T[K] extends Read<infer V> ? V : never });
}

function readHeader(v: unknown, at: Path): Read<HeaderData> {
  if (!isObject(v)) return fail('expected a header { stock, plies, jacks }', at);
  const keys = onlyKeys(v, ['stock', 'plies', 'jacks', 'spacer'], at);
  if (!keys.ok) return keys;
  const stock = stockId(own(v, 'stock'), [...at, 'stock'], 'lumber');
  if (!stock.ok) return stock;
  const plies = count(own(v, 'plies'), [...at, 'plies'], 1, 4);
  if (!plies.ok) return plies;
  const jacks = count(own(v, 'jacks'), [...at, 'jacks'], 1, 4);
  if (!jacks.ok) return jacks;
  const spacer = optionalStock(v, 'spacer', at);
  if (!spacer.ok) return spacer;
  return ok(
    defined({ stock: stock.value, plies: plies.value, jacks: jacks.value, spacer: spacer.value }),
  );
}

function readLayer(v: unknown, at: Path): Read<WallLayer<StoredExpression>> {
  if (!isObject(v)) return fail('expected a layer { id, kind, ... }', at);
  const kind = readEnum(own(v, 'kind'), LAYER_KINDS, [...at, 'kind']);
  if (!kind.ok) return kind;
  const id = readDataId(own(v, 'id'), [...at, 'id']);
  if (!id.ok) return id;
  if (kind.value === 'framing') {
    const keys = onlyKeys(
      v,
      ['id', 'kind', 'stock', 'spacing', 'bottomPlates', 'topPlates', 'header'],
      at,
    );
    if (!keys.ok) return keys;
    const r = all({
      stock: stockId(own(v, 'stock'), [...at, 'stock'], 'lumber'),
      spacing: optionalLength(v, 'spacing', at, { positive: true }),
      bottomPlates: optionalCount(v, 'bottomPlates', at, 1, 3),
      topPlates: optionalCount(v, 'topPlates', at, 1, 3),
      header: readHeader(own(v, 'header'), [...at, 'header']),
    });
    if (!r.ok) return r;
    return ok(defined({ id: id.value, kind: 'framing' as const, ...r.value }));
  }
  const keys = onlyKeys(v, ['id', 'kind', 'stock', 'thickness'], at);
  if (!keys.ok) return keys;
  const r = all({
    stock: optionalStock(v, 'stock', at, 'sheet'),
    thickness: optionalLength(v, 'thickness', at, { positive: true }),
  });
  if (!r.ok) return r;
  if (r.value.stock === undefined && r.value.thickness === undefined) {
    return fail('a layer needs a stock or a thickness', at);
  }
  return ok(defined({ id: id.value, kind: kind.value, ...r.value }));
}

function readWallType(v: unknown, at: Path): Read<WallType<StoredExpression>> {
  if (!isObject(v)) return fail('expected a wall type { id, name, layers }', at);
  const keys = onlyKeys(v, ['id', 'name', 'layers'], at);
  if (!keys.ok) return keys;
  const id = readDataId(own(v, 'id'), [...at, 'id']);
  if (!id.ok) return id;
  const name = readName(own(v, 'name'), [...at, 'name']);
  if (!name.ok) return name;
  const raw = own(v, 'layers');
  const lat = [...at, 'layers'];
  if (!Array.isArray(raw)) return fail('expected a list of layers', lat);
  if (raw.length > MAX_LAYERS) return fail(`at most ${MAX_LAYERS} layers are allowed`, lat);
  const layers: WallLayer<StoredExpression>[] = [];
  const ids = new Set<string>();
  let rank = 0;
  for (let i = 0; i < raw.length; i++) {
    const r = readLayer(raw[i], [...lat, i]);
    if (!r.ok) return r;
    if (ids.has(r.value.id))
      return fail(`two layers have the id "${r.value.id}"`, [...lat, i, 'id']);
    ids.add(r.value.id);
    const k = LAYER_KINDS.indexOf(r.value.kind);
    if (k < rank) {
      return fail(
        'layers run from the exterior to the interior: siding, sheathing, framing, drywall',
        [...lat, i, 'kind'],
      );
    }
    if (r.value.kind === 'framing' && k === rank && layers.some((l) => l.kind === 'framing')) {
      return fail('a wall type has one framing layer', [...lat, i, 'kind']);
    }
    rank = k;
    layers.push(r.value);
  }
  if (!layers.some((l) => l.kind === 'framing')) {
    return fail('a wall type needs a framing layer', lat);
  }
  return ok({ id: id.value, name: name.value, layers });
}

function readFloorType(v: unknown, at: Path): Read<FloorType<StoredExpression>> {
  if (!isObject(v)) return fail('expected a floor type { id, name, joistStock }', at);
  const keys = onlyKeys(v, ['id', 'name', 'joistStock', 'rimStock', 'spacing', 'subfloor'], at);
  if (!keys.ok) return keys;
  const r = all({
    id: readDataId(own(v, 'id'), [...at, 'id']),
    name: readName(own(v, 'name'), [...at, 'name']),
    joistStock: stockId(own(v, 'joistStock'), [...at, 'joistStock'], 'lumber'),
    rimStock: optionalStock(v, 'rimStock', at, 'lumber'),
    spacing: optionalLength(v, 'spacing', at, { positive: true }),
    subfloor: optionalStock(v, 'subfloor', at, 'sheet'),
  });
  return r.ok ? ok(defined(r.value)) : r;
}

const TAILS: readonly TailCut[] = ['plumb', 'square'];

function readRoofType(v: unknown, at: Path): Read<RoofType<StoredExpression>> {
  if (!isObject(v)) return fail('expected a roof type { id, name, rafterStock, ridgeStock }', at);
  const keys = onlyKeys(
    v,
    [
      'id',
      'name',
      'rafterStock',
      'ridgeStock',
      'hipStock',
      'spacing',
      'overhang',
      'rakeOverhang',
      'tail',
      'subFascia',
      'fascia',
      'sheathing',
    ],
    at,
  );
  if (!keys.ok) return keys;
  const tail = own(v, 'tail');
  const r = all({
    id: readDataId(own(v, 'id'), [...at, 'id']),
    name: readName(own(v, 'name'), [...at, 'name']),
    rafterStock: stockId(own(v, 'rafterStock'), [...at, 'rafterStock'], 'lumber'),
    ridgeStock: stockId(own(v, 'ridgeStock'), [...at, 'ridgeStock'], 'lumber'),
    hipStock: optionalStock(v, 'hipStock', at, 'lumber'),
    spacing: optionalLength(v, 'spacing', at, { positive: true }),
    overhang: optionalLength(v, 'overhang', at, {}),
    rakeOverhang: optionalLength(v, 'rakeOverhang', at, {}),
    tail: tail === undefined ? ok(undefined) : readEnum(tail, TAILS, [...at, 'tail']),
    subFascia: optionalStock(v, 'subFascia', at, 'lumber'),
    fascia: optionalStock(v, 'fascia', at, 'lumber'),
    sheathing: optionalStock(v, 'sheathing', at, 'sheet'),
  });
  return r.ok ? ok(defined(r.value)) : r;
}

const CORNER_STYLES: readonly CornerStyle[] = ['two-stud', 'three-stud', 'ladder'];
const LAYOUT_FROM: readonly ('start' | 'end')[] = ['start', 'end'];
const BLOCKING_KINDS: readonly BlockingRowsData['kind'][] = ['none', 'mid-height', 'heights'];

function lengthList(
  o: Obj,
  key: string,
  at: Path,
  nonEmpty: boolean,
): Read<StoredExpression[] | undefined> {
  const v = own(o, key);
  if (v === undefined) return ok(undefined);
  const kat = [...at, key];
  if (!Array.isArray(v) || v.length > MAX_LENGTHS) {
    return fail(`expected a list of at most ${MAX_LENGTHS} lengths`, kat);
  }
  if (nonEmpty && v.length === 0) return fail('expected at least one length', kat);
  const out: StoredExpression[] = [];
  for (let i = 0; i < v.length; i++) {
    const r = length(v[i], [...kat, i], { positive: true });
    if (!r.ok) return r;
    out.push(r.value);
  }
  return ok(out);
}

function readBlocking(v: unknown, at: Path): Read<BlockingRowsData<StoredExpression>> {
  if (!isObject(v))
    return fail("expected blocking rows { kind: 'none' | 'mid-height' | 'heights' }", at);
  const kind = readEnum(own(v, 'kind'), BLOCKING_KINDS, [...at, 'kind']);
  if (!kind.ok) return kind;
  if (kind.value !== 'heights') {
    const keys = onlyKeys(v, ['kind'], at);
    return keys.ok ? ok({ kind: kind.value }) : keys;
  }
  const keys = onlyKeys(v, ['kind', 'heights'], at);
  if (!keys.ok) return keys;
  if (own(v, 'heights') === undefined)
    return fail('expected a list of heights', [...at, 'heights']);
  const heights = lengthList(v, 'heights', at, true);
  return heights.ok ? ok({ kind: 'heights', heights: heights.value! }) : heights;
}

function readFraming(v: unknown, at: Path): Read<FramingSettings<StoredExpression>> {
  if (!isObject(v)) return fail('expected framing settings', at);
  const keys = onlyKeys(
    v,
    [
      'spacing',
      'layoutOrigin',
      'layoutFrom',
      'bottomPlates',
      'topPlates',
      'kings',
      'cornerStyle',
      'blocking',
      'spliceOffset',
      'plateStockLengths',
      'precutLengths',
      'ladderSpacing',
    ],
    at,
  );
  if (!keys.ok) return keys;
  const layoutFrom = own(v, 'layoutFrom');
  const corner = own(v, 'cornerStyle');
  const blocking = own(v, 'blocking');
  const r = all({
    spacing: optionalLength(v, 'spacing', at, { positive: true }),
    layoutOrigin: optionalLength(v, 'layoutOrigin', at, { signed: true }),
    layoutFrom:
      layoutFrom === undefined
        ? ok(undefined)
        : readEnum(layoutFrom, LAYOUT_FROM, [...at, 'layoutFrom']),
    bottomPlates: optionalCount(v, 'bottomPlates', at, 1, 3),
    topPlates: optionalCount(v, 'topPlates', at, 1, 3),
    kings: optionalCount(v, 'kings', at, 1, 4),
    cornerStyle:
      corner === undefined
        ? ok(undefined)
        : readEnum(corner, CORNER_STYLES, [...at, 'cornerStyle']),
    blocking: blocking === undefined ? ok(undefined) : readBlocking(blocking, [...at, 'blocking']),
    spliceOffset: optionalLength(v, 'spliceOffset', at, {}),
    plateStockLengths: lengthList(v, 'plateStockLengths', at, true),
    precutLengths: lengthList(v, 'precutLengths', at, false),
    ladderSpacing: optionalLength(v, 'ladderSpacing', at, { positive: true }),
  });
  return r.ok ? ok(defined(r.value)) : r;
}

function readHeaderRule(v: unknown, at: Path): Read<HeaderRuleData<StoredExpression>> {
  if (!isObject(v)) return fail('expected a header rule { maxWidth, header }', at);
  const keys = onlyKeys(v, ['maxWidth', 'header'], at);
  if (!keys.ok) return keys;
  const r = all({
    maxWidth: length(own(v, 'maxWidth'), [...at, 'maxWidth'], { positive: true }),
    header: readHeader(own(v, 'header'), [...at, 'header']),
  });
  return r.ok ? ok(r.value) : r;
}

/** A list of `max` items at most, each read by `read`, with unique `id`s when they have one. */
function readList<T>(
  o: Obj,
  key: string,
  max: number,
  what: string,
  read: (v: unknown, at: Path) => Read<T>,
): Read<T[]> {
  const v = own(o, key);
  if (v === undefined) return ok([]);
  const at = [key];
  if (!Array.isArray(v)) return fail(`expected a list of ${what}`, at);
  if (v.length > max) return fail(`at most ${max} ${what} are allowed`, at);
  const out: T[] = [];
  const ids = new Set<string>();
  for (let i = 0; i < v.length; i++) {
    const r = read(v[i], [...at, i]);
    if (!r.ok) return r;
    const id = (r.value as { id?: unknown }).id;
    if (typeof id === 'string') {
      if (ids.has(id)) return fail(`two ${what} have the id "${id}"`, [...at, i, 'id']);
      ids.add(id);
    }
    out.push(r.value);
  }
  return ok(out);
}

/** Validate `domains.construction` data at the current version, as stored. */
function readCurrent(data: Json): Read<StoredConstructionSettings> {
  if (!isObject(data)) return fail('expected construction settings');
  const keys = onlyKeys(
    data,
    ['levels', 'wallTypes', 'floorTypes', 'roofTypes', 'framing', 'headerRules'],
    [],
  );
  if (!keys.ok) return keys;
  const rawLevels = own(data, 'levels');
  const levels = rawLevels === undefined ? ok([]) : readLevels(rawLevels, ['levels']);
  if (!levels.ok) return levels;
  const rawFraming = own(data, 'framing');
  const r = all({
    wallTypes: readList(data, 'wallTypes', MAX_TYPES, 'wall types', readWallType),
    floorTypes: readList(data, 'floorTypes', MAX_TYPES, 'floor types', readFloorType),
    roofTypes: readList(data, 'roofTypes', MAX_TYPES, 'roof types', readRoofType),
    framing: rawFraming === undefined ? ok({}) : readFraming(rawFraming, ['framing']),
    headerRules: readList(data, 'headerRules', MAX_HEADER_RULES, 'header rules', readHeaderRule),
  });
  if (!r.ok) return r;
  // Two rules for the same width would make "the narrowest rule covering it" ambiguous. Widths
  // typed in different units (`48"`, `4'`, `1219.2mm`) are compared to a micrometre.
  const rules = r.value.headerRules;
  const widths = rules.map((rule) => evaluateLength(rule.maxWidth));
  for (let i = 0; i < widths.length; i++) {
    const j = widths.findIndex((w, k) => k < i && Math.abs(w - widths[i]!) < 1e-3);
    if (j >= 0) {
      return fail(`header rules ${j + 1} and ${i + 1} cover the same width`, [
        'headerRules',
        i,
        'maxWidth',
      ]);
    }
  }
  return ok({ levels: levels.value, ...r.value });
}

/** A stored length already validated by the reader, in mm. */
function evaluateLength(e: StoredExpression): number {
  const r = constantLength(e, [], { signed: true });
  if (!r.ok) throw new Error(r.message);
  return r.value;
}

/** Every length of the settings, through `f`. */
export function mapLengths<A, B>(
  s: ConstructionSettings<A>,
  f: (l: A) => B,
): ConstructionSettings<B> {
  const opt = (l: A | undefined) => (l === undefined ? undefined : f(l));
  const list = (l: readonly A[] | undefined) => l?.map(f);
  const blocking = s.framing.blocking;
  return {
    levels: s.levels.map((l) => ({ ...l, elevation: f(l.elevation), height: f(l.height) })),
    wallTypes: s.wallTypes.map((t) => ({
      ...t,
      layers: t.layers.map((l) =>
        l.kind === 'framing'
          ? defined({ ...l, spacing: opt(l.spacing) })
          : defined({ ...l, thickness: opt(l.thickness) }),
      ),
    })),
    floorTypes: s.floorTypes.map((t) => defined({ ...t, spacing: opt(t.spacing) })),
    roofTypes: s.roofTypes.map((t) =>
      defined({
        ...t,
        spacing: opt(t.spacing),
        overhang: opt(t.overhang),
        rakeOverhang: opt(t.rakeOverhang),
      }),
    ),
    framing: defined({
      ...s.framing,
      spacing: opt(s.framing.spacing),
      layoutOrigin: opt(s.framing.layoutOrigin),
      blocking:
        blocking?.kind === 'heights'
          ? { kind: 'heights' as const, heights: blocking.heights.map(f) }
          : blocking,
      spliceOffset: opt(s.framing.spliceOffset),
      plateStockLengths: list(s.framing.plateStockLengths),
      precutLengths: list(s.framing.precutLengths),
      ladderSpacing: opt(s.framing.ladderSpacing),
    }),
    headerRules: s.headerRules.map((r) => ({ ...r, maxWidth: f(r.maxWidth) })),
  };
}

/**
 * Read `domains.construction` stored at `schemaVersion`: migrate it in memory, validate it, and
 * evaluate its lengths. Regen's reader for the namespace, and what the app's construction panels
 * read.
 */
export function readConstructionData(data: Json, schemaVersion: number): Read<ConstructionData> {
  const migrated = migrate(CONSTRUCTION_DATA, data, schemaVersion);
  if (!migrated.ok) return migrated;
  const stored = readCurrent(migrated.value);
  if (!stored.ok) return stored;
  return ok({ stored: stored.value, settings: mapLengths(stored.value, evaluateLength) });
}

// Writing -------------------------------------------------------------------------------------

function toJson(v: unknown): Json {
  return JSON.parse(JSON.stringify(v)) as Json;
}

/**
 * The `domains.construction` entry to store for these settings, at the current version, or
 * undefined when there is nothing to store (the app then removes the namespace). Empty lists and
 * empty framing settings are left out. The settings are validated first, so the app cannot write
 * what the reader would refuse.
 */
export function writeConstructionData(
  settings: StoredConstructionSettings,
): Read<{ schemaVersion: number; data: Json } | undefined> {
  const out: Record<string, Json> = {};
  for (const key of ['levels', 'wallTypes', 'floorTypes', 'roofTypes', 'headerRules'] as const) {
    if (settings[key].length > 0) out[key] = toJson(settings[key]);
  }
  if (Object.keys(settings.framing).length > 0) out.framing = toJson(settings.framing);
  const checked = readCurrent(out);
  if (!checked.ok) return checked;
  if (Object.keys(out).length === 0) return ok(undefined);
  return ok({ schemaVersion: CONSTRUCTION_DATA_VERSION, data: out });
}

// Defaults and derived values -----------------------------------------------------------------

const expr = (source: string, unit: 'in' | 'mm'): StoredExpression => ({
  source,
  lengthUnit: unit,
  angleUnit: 'deg',
});

/**
 * The construction settings a new document starts with: one level at the datum, and nothing
 * else. Its height is a layout default from common practice, not a sizing: 97-1/8" (92-5/8"
 * precut studs on one bottom and two top plates, M6 plan Part 1) for inch and foot documents,
 * 2400 mm otherwise. No wall, floor or roof types (a new wall type asks for its header), and no
 * header rules (ADR 0015 decision 7).
 */
export function defaultConstructionSettings(region: 'us' | 'metric'): StoredConstructionSettings {
  const unit = region === 'us' ? 'in' : 'mm';
  return {
    ...EMPTY_CONSTRUCTION_SETTINGS,
    levels: [
      {
        id: 'level-1',
        name: 'Level 1',
        elevation: expr('0', unit),
        height: expr(region === 'us' ? '97-1/8"' : '2400mm', unit),
      },
    ],
  };
}

/** What a new wall type needs: the user picks the stud stock and the default header. */
export interface NewWallTypeInput {
  readonly id: string;
  readonly name: string;
  readonly studStock: string;
  /** The wall type's default header: required, so creating a wall type asks for one. */
  readonly header: HeaderData;
  /** Sheathing outside the studs; none when absent. */
  readonly sheathing?: string;
  /** Drywall inside the studs; none when absent. */
  readonly drywall?: string;
}

/**
 * A new wall type: sheathing (if any), the framing layer, drywall (if any). Spacing and plate
 * counts are left to the document's framing settings.
 */
export function newWallType(input: NewWallTypeInput): WallType<StoredExpression> {
  const layers: WallLayer<StoredExpression>[] = [];
  if (input.sheathing !== undefined) {
    layers.push({ id: 'sheathing', kind: 'sheathing', stock: input.sheathing });
  }
  layers.push({ id: 'framing', kind: 'framing', stock: input.studStock, header: input.header });
  if (input.drywall !== undefined) {
    layers.push({ id: 'drywall', kind: 'drywall', stock: input.drywall });
  }
  return { id: input.id, name: input.name, layers };
}

/** A layer's thickness, mm, or why it has none (an unknown stock). */
export function layerThickness(
  layer: WallLayer,
  stock: StockData = EMPTY_STOCK_DATA,
): Read<number> {
  if (layer.kind !== 'framing' && layer.thickness !== undefined) return ok(layer.thickness);
  const id = layer.stock!;
  // A stud layer is as thick as the stud is wide; a sheet layer as its sheet is thick.
  const value = layer.kind === 'framing' ? stockWidth(id, stock) : stockThickness(id, stock);
  if (value === undefined) {
    return fail(`the stock "${id}" is not in this build's catalog`, ['layers', layer.id, 'stock']);
  }
  return ok(value);
}

/** A wall type's total thickness from its layers, mm (2x4 + 7/16" OSB + 1/2" drywall: 4-7/16"). */
export function wallTypeThickness(
  type: WallType,
  stock: StockData = EMPTY_STOCK_DATA,
): Read<number> {
  let total = 0;
  for (const layer of type.layers) {
    const t = layerThickness(layer, stock);
    if (!t.ok) return t;
    total += t.value;
  }
  return ok(total);
}
