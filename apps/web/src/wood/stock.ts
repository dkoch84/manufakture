// The Stock panel's logic, free of React (M4 plan T4.1d): the document's stock overrides
// (`domains.stock`, owned by `@manufakture/domain-wood`): a measured thickness or width, the sheet
// size in stock, a price. Overrides are settings, not model (ADR 0013 decision 3): every length is
// a constant (`18.2mm`, `23/32"`), never a variable. Each save or clear is one `setDomainData`,
// so one undo step, and every board of that stock rebuilds.

import {
  bareUnits,
  type Command,
  type DisplayUnits,
  type ManufaktureDocument,
  type StoredExpression,
} from '@manufakture/core';
import {
  constantLength,
  findStock,
  PRICE_UNITS,
  readStockData,
  resolveStock,
  STOCK_NAMESPACE,
  writeStockData,
  type Json,
  type PriceUnit,
  type ResolvedStock,
  type StockData,
  type StockEntry,
  type StoredStockOverride,
} from '@manufakture/domain-wood';
import { isBoard } from './kinds';

export { PRICE_UNITS };

export const PRICE_UNIT_LABELS: Record<PriceUnit, string> = {
  piece: 'per piece',
  sheet: 'per sheet',
  'board-foot': 'per board foot',
  metre: 'per metre',
  foot: 'per foot',
};

/** The stocks the document's boards are cut from, in every part studio, in catalog order. */
export function stocksInUse(doc: ManufaktureDocument): string[] {
  const ids = new Set<string>();
  for (const part of doc.parts) {
    for (const f of part.features) {
      if (isBoard(f) && typeof f.params.stock === 'string') ids.add(f.params.stock);
    }
  }
  return [...ids];
}

/** Whether the document has anything the Stock panel shows: a board, or stock overrides. */
export function hasWoodwork(doc: ManufaktureDocument): boolean {
  return doc.domains?.[STOCK_NAMESPACE] !== undefined || stocksInUse(doc).length > 0;
}

/** One row of the panel: a stock in use or overridden, as the document resolves it. */
export interface StockRow {
  id: string;
  /** Undefined for an id this build does not know (an override from a newer build, kept). */
  resolved: ResolvedStock | undefined;
  stored: StoredStockOverride | undefined;
  used: boolean;
}

export function stockRows(doc: ManufaktureDocument, data: StockData | undefined): StockRow[] {
  const used = new Set(stocksInUse(doc));
  const ids = new Set([...used, ...(data?.stored.keys() ?? [])]);
  const order = (id: string) => {
    const entry = findStock(id);
    return entry ? `0${entry.region === 'us' ? 0 : 1}${entry.kind}${id}` : `1${id}`;
  };
  return [...ids]
    .sort((a, b) => order(a).localeCompare(order(b)))
    .map((id) => ({
      id,
      resolved: resolveStock(id, data),
      stored: data?.stored.get(id),
      used: used.has(id),
    }));
}

/** The override form: lengths as typed (empty: the catalog's), the price as typed. */
export interface OverrideForm {
  thickness: string;
  width: string;
  sheetLength: string;
  sheetWidth: string;
  price: string;
  per: PriceUnit;
  currency: string;
}

export function overrideForm(
  entry: StockEntry,
  stored: StoredStockOverride | undefined,
): OverrideForm {
  return {
    thickness: stored?.thickness?.source ?? '',
    width: stored?.width?.source ?? '',
    sheetLength: stored?.sheet?.length.source ?? '',
    sheetWidth: stored?.sheet?.width.source ?? '',
    price: stored?.price ? String(stored.price.amount) : '',
    per: stored?.price?.per ?? (entry.kind === 'sheet' ? 'sheet' : 'piece'),
    currency: stored?.price?.currency ?? '',
  };
}

export type OverrideBuild =
  { ok: true; override: StoredStockOverride } | { ok: false; errors: Record<string, string> };

/**
 * A filled form as the override to store, each length checked with the domain's own rule (a
 * constant above zero). Empty fields keep the catalog's value; an empty form is no override.
 */
export function buildOverride(
  entry: StockEntry,
  form: OverrideForm,
  units: DisplayUnits,
): OverrideBuild {
  const errors: Record<string, string> = {};
  const length = (field: keyof OverrideForm, source: string): StoredExpression | undefined => {
    const text = source.trim();
    if (text === '') return undefined;
    const e: StoredExpression = { source: text, ...bareUnits(units) };
    const r = constantLength(e, [field], { positive: true });
    if (!r.ok) {
      errors[field] = r.message;
      return undefined;
    }
    return e;
  };
  const out: StoredStockOverride = {};
  const thickness = length('thickness', form.thickness);
  if (thickness) out.thickness = thickness;
  if (entry.kind === 'lumber') {
    const width = length('width', form.width);
    if (width) out.width = width;
  }
  if (entry.kind === 'sheet') {
    const l = length('sheetLength', form.sheetLength);
    const w = length('sheetWidth', form.sheetWidth);
    if ((l === undefined) !== (w === undefined) && !errors.sheetLength && !errors.sheetWidth) {
      errors[l === undefined ? 'sheetLength' : 'sheetWidth'] = 'Give both sides of the sheet.';
    } else if (l && w) out.sheet = { length: l, width: w };
  }
  const price = form.price.trim();
  if (price !== '') {
    const amount = Number(price);
    if (!Number.isFinite(amount) || amount < 0) errors.price = 'Enter an amount of zero or more.';
    else {
      const currency = form.currency.trim().toUpperCase();
      if (currency !== '' && !/^[A-Z]{3}$/.test(currency)) {
        errors.currency = 'A three-letter code like USD or EUR, or nothing.';
      }
      out.price = { amount, per: form.per, ...(currency !== '' ? { currency } : {}) };
    }
  }
  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, override: out };
}

/**
 * The command that sets (or, with undefined or an empty override, clears) one stock's override,
 * keeping every other override as stored: one `setDomainData`, or null when nothing changes.
 * Refused (an error message) when the stored data cannot be read, since it would be rewritten.
 */
export function overrideCommand(
  doc: ManufaktureDocument,
  stockId: string,
  override: StoredStockOverride | undefined,
): { ok: true; command: Command | null; label: string } | { ok: false; message: string } {
  const entry = doc.domains?.[STOCK_NAMESPACE];
  let stored: Map<string, StoredStockOverride> = new Map();
  if (entry !== undefined) {
    const r = readStockData(entry.data as Json, entry.schemaVersion);
    if (!r.ok) {
      return { ok: false, message: `The stock overrides cannot be read: ${r.message}` };
    }
    stored = new Map(r.value.stored);
  }
  const empty = override === undefined || Object.keys(override).length === 0;
  if (empty) stored.delete(stockId);
  else stored.set(stockId, override);
  const next = writeStockData(stored);
  const name = findStock(stockId)?.name ?? stockId;
  const label = empty ? `Clear the ${name} override` : `Override ${name}`;
  const same =
    JSON.stringify(next ?? null) ===
    JSON.stringify(entry ? { schemaVersion: entry.schemaVersion, data: entry.data } : null);
  if (same) return { ok: true, command: null, label };
  const command: Command =
    next === undefined
      ? { type: 'setDomainData', namespace: STOCK_NAMESPACE }
      : {
          type: 'setDomainData',
          namespace: STOCK_NAMESPACE,
          schemaVersion: next.schemaVersion,
          data: next.data,
        };
  return { ok: true, command, label };
}
