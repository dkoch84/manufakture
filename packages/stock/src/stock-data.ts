// `domains.stock`: the document's stock overrides (ADR 0013 decision 3). This package owns the
// namespace, its schema and its migrations, next to the catalog (ADR 0015 decision 1). In M4
// `domain-wood` owned them; T6.1a moved both here, keeping the name `stock`, with no data
// migration.
//
// Stored shape, version 1 (every field optional; an absent override uses the catalog):
//
//   {
//     overrides: {
//       '<stock id>': {
//         thickness?: StoredExpression,  // measured actual thickness: '18.2mm', '23/32"'
//         width?: StoredExpression,      // measured actual width (lumber)
//         sheet?: { length: StoredExpression, width: StoredExpression }, // sheet size in stock
//         price?: { amount: number, per: 'piece' | 'sheet' | 'board-foot' | 'metre' | 'foot',
//                   currency?: string }  // an ISO 4217 code: 'USD', 'EUR'
//       }
//     }
//   }
//
// Lengths are constants (`constantLength`): settings, not model, so no variables. An override for
// an id this build's catalog does not have is kept and ignored (it may come from a newer build).

import type { StoredExpression } from '@manufakture/core';
import { findStock, type StockEntry } from './catalog';
import { currentVersion, migrate, type Json, type Versioned } from './migrations';
import {
  fail,
  isObject,
  ok,
  onlyKeys,
  own,
  readConstantLength,
  readEnum,
  type Path,
  type Read,
} from './read';

export const STOCK_NAMESPACE = 'stock';

/** What a price is per. */
export type PriceUnit = 'piece' | 'sheet' | 'board-foot' | 'metre' | 'foot';
export const PRICE_UNITS: readonly PriceUnit[] = ['piece', 'sheet', 'board-foot', 'metre', 'foot'];

export interface Price {
  amount: number;
  per: PriceUnit;
  /** An ISO 4217 code (`USD`, `EUR`); absent: the document's currency is not stated. */
  currency?: string;
}

/** One stock's override as stored (expressions as typed). */
export interface StoredStockOverride {
  thickness?: StoredExpression;
  width?: StoredExpression;
  sheet?: { length: StoredExpression; width: StoredExpression };
  price?: Price;
}

/** One stock's override, evaluated: lengths in millimetres. */
export interface StockOverride {
  thickness?: number;
  width?: number;
  sheet?: { length: number; width: number };
  price?: Price;
}

/** `domains.stock` as read: every override as stored and evaluated, by stock id. */
export interface StockData {
  stored: ReadonlyMap<string, StoredStockOverride>;
  overrides: ReadonlyMap<string, StockOverride>;
}

export const EMPTY_STOCK_DATA: StockData = { stored: new Map(), overrides: new Map() };

/** The migrations of `domains.stock` data (none yet: version 1 is current). */
export const STOCK_DATA: Versioned = { what: 'stock data', migrations: [] };
export const STOCK_DATA_VERSION = currentVersion(STOCK_DATA);

/** The most overrides one document may hold; bounds what a crafted file costs to read. */
export const MAX_STOCK_OVERRIDES = 10_000;

function readPrice(v: unknown, at: Path): Read<Price> {
  if (!isObject(v)) return fail('expected a price { amount, per }', at);
  const keys = onlyKeys(v, ['amount', 'per', 'currency'], at);
  if (!keys.ok) return keys;
  const amount = own(v, 'amount');
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) {
    return fail('expected an amount of zero or more', [...at, 'amount']);
  }
  const per = readEnum(own(v, 'per'), PRICE_UNITS, [...at, 'per']);
  if (!per.ok) return per;
  const price: Price = { amount, per: per.value };
  const currency = own(v, 'currency');
  if (currency !== undefined) {
    if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) {
      return fail('expected a three-letter currency code like "USD"', [...at, 'currency']);
    }
    price.currency = currency;
  }
  return ok(price);
}

function readOverride(
  v: unknown,
  at: Path,
): Read<{ stored: StoredStockOverride; value: StockOverride }> {
  if (!isObject(v)) return fail('expected a stock override object', at);
  const keys = onlyKeys(v, ['thickness', 'width', 'sheet', 'price'], at);
  if (!keys.ok) return keys;
  const stored: StoredStockOverride = {};
  const value: StockOverride = {};
  for (const key of ['thickness', 'width'] as const) {
    const raw = own(v, key);
    if (raw === undefined) continue;
    const r = readConstantLength(raw, [...at, key], { positive: true });
    if (!r.ok) return r;
    stored[key] = r.value.expression;
    value[key] = r.value.value;
  }
  const sheet = own(v, 'sheet');
  if (sheet !== undefined) {
    const sat = [...at, 'sheet'];
    if (!isObject(sheet)) return fail('expected a sheet size { length, width }', sat);
    const sk = onlyKeys(sheet, ['length', 'width'], sat);
    if (!sk.ok) return sk;
    const length = readConstantLength(own(sheet, 'length'), [...sat, 'length'], { positive: true });
    if (!length.ok) return length;
    const width = readConstantLength(own(sheet, 'width'), [...sat, 'width'], { positive: true });
    if (!width.ok) return width;
    stored.sheet = { length: length.value.expression, width: width.value.expression };
    value.sheet = { length: length.value.value, width: width.value.value };
  }
  const price = own(v, 'price');
  if (price !== undefined) {
    const p = readPrice(price, [...at, 'price']);
    if (!p.ok) return p;
    stored.price = p.value;
    value.price = { ...p.value };
  }
  return ok({ stored, value });
}

/** Validate `domains.stock` data at the current version. */
function readCurrent(data: Json): Read<StockData> {
  if (!isObject(data)) return fail('expected an object { overrides }');
  const keys = onlyKeys(data, ['overrides'], []);
  if (!keys.ok) return keys;
  const raw = own(data, 'overrides');
  if (raw === undefined) return ok(EMPTY_STOCK_DATA);
  if (!isObject(raw)) return fail('expected overrides by stock id', ['overrides']);
  const ids = Object.keys(raw);
  if (ids.length > MAX_STOCK_OVERRIDES) {
    return fail(`at most ${MAX_STOCK_OVERRIDES} stock overrides are allowed`, ['overrides']);
  }
  const stored = new Map<string, StoredStockOverride>();
  const overrides = new Map<string, StockOverride>();
  for (const id of ids.sort()) {
    if (id.length === 0 || id.length > 256) return fail('expected a stock id', ['overrides', id]);
    const r = readOverride(own(raw, id), ['overrides', id]);
    if (!r.ok) return r;
    stored.set(id, r.value.stored);
    overrides.set(id, r.value.value);
  }
  return ok({ stored, overrides });
}

/**
 * Read `domains.stock` stored at `schemaVersion`: migrate it in memory and validate it. Regen's
 * reader for the namespace, and what the app's stock panel reads.
 */
export function readStockData(data: Json, schemaVersion: number): Read<StockData> {
  const migrated = migrate(STOCK_DATA, data, schemaVersion);
  if (!migrated.ok) return migrated;
  return readCurrent(migrated.value);
}

/**
 * The `domains.stock` entry to store for these overrides, at the current version, or undefined
 * when there are none (the app then removes the namespace). Keys are sorted; empty overrides
 * are dropped.
 */
export function writeStockData(
  overrides: ReadonlyMap<string, StoredStockOverride>,
): { schemaVersion: number; data: Json } | undefined {
  const out: Record<string, Json> = {};
  for (const id of [...overrides.keys()].sort()) {
    const o = overrides.get(id)!;
    const entry: Record<string, Json> = {};
    if (o.thickness !== undefined) entry.thickness = { ...o.thickness };
    if (o.width !== undefined) entry.width = { ...o.width };
    if (o.sheet !== undefined)
      entry.sheet = { length: { ...o.sheet.length }, width: { ...o.sheet.width } };
    if (o.price !== undefined) entry.price = { ...o.price };
    if (Object.keys(entry).length > 0) out[id] = entry;
  }
  if (Object.keys(out).length === 0) return undefined;
  return { schemaVersion: STOCK_DATA_VERSION, data: { overrides: out } };
}

/** A catalog stock with the document's override applied: what a board is built with. */
export interface ResolvedStock {
  entry: StockEntry;
  /** Actual thickness, mm. */
  thickness: number;
  /** Actual width, mm; undefined for stock sold in random widths. */
  width?: number;
  /** Sheet size, mm (sheets). */
  sheet?: { length: number; width: number };
  price?: Price;
  /** Which values come from the document's override rather than the catalog. */
  overridden: { thickness: boolean; width: boolean; sheet: boolean; price: boolean };
}

/** The stock `id` with the document's override, or undefined when the catalog has no such id. */
export function resolveStock(
  id: string,
  data: StockData = EMPTY_STOCK_DATA,
): ResolvedStock | undefined {
  const entry = findStock(id);
  if (entry === undefined) return undefined;
  const o = data.overrides.get(id) ?? {};
  const resolved: ResolvedStock = {
    entry,
    thickness: o.thickness ?? entry.actual.thickness,
    overridden: {
      thickness: o.thickness !== undefined,
      width: o.width !== undefined,
      sheet: o.sheet !== undefined,
      price: o.price !== undefined,
    },
  };
  const width = o.width ?? entry.actual.width;
  if (width !== undefined) resolved.width = width;
  const sheet = o.sheet ?? entry.sheet;
  if (sheet !== undefined) resolved.sheet = { length: sheet.length, width: sheet.width };
  if (o.price !== undefined) resolved.price = o.price;
  return resolved;
}
