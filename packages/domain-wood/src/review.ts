// What changed in the woodworking domain's document data, in lines a reviewer reads (ADR 0016
// decision 11, M8 plan T8.3a): the summarisers the review bundle (`@manufakture/review`) calls
// for a `setDomainData` of `domains.wood` and of `domains.stock` (which this package's users
// edit, `@manufakture/stock` owning its schema). Each takes the namespace's entry in the two
// documents (undefined when absent) and returns plain text lines; it never throws. Data that does
// not read is reported as such. The review package bounds the lines' number and length.

import type { DomainData, StoredExpression } from '@manufakture/core';
import { findStock } from './catalog';
import type { Json } from './migrations';
import { readStockData, STOCK_NAMESPACE, type StoredStockOverride } from './stock-data';
import { readWoodData, WOOD_NAMESPACE, type StoredWoodSettings } from './wood-data';

/** The hook's shape: the namespace, and the lines describing a change of its data. */
export interface DomainDataSummariser {
  readonly namespace: string;
  summarise(before: DomainData | undefined, after: DomainData | undefined): string[];
}

/** An expression as the user typed it, with the unit a bare number is in. */
export function expressionText(e: StoredExpression | undefined): string {
  if (e === undefined) return 'not set';
  const s = e.source.trim();
  return /^[-+]?(\d+(\.\d*)?|\.\d+)$/.test(s) ? `${s} ${e.lengthUnit}` : s;
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// Wood ------------------------------------------------------------------------------------------

const TRIM_LABELS: Record<string, string> = {
  lengthStart: 'length start',
  lengthEnd: 'length end',
  widthStart: 'width start',
  widthEnd: 'width end',
  start: 'start',
  end: 'end',
};

function readWood(entry: DomainData | undefined): StoredWoodSettings | string {
  if (entry === undefined) return {};
  const r = readWoodData(entry.data as Json, entry.schemaVersion);
  return r.ok ? r.value.stored : r.message;
}

function woodLines(before: StoredWoodSettings, after: StoredWoodSettings): string[] {
  const lines: string[] = [];
  if (!same(before.kerf, after.kerf)) {
    lines.push(`Saw kerf: ${expressionText(before.kerf)} to ${expressionText(after.kerf)}`);
  }
  for (const [key, label] of [
    ['sheetTrims', 'Sheet trim'],
    ['lumberTrims', 'Lumber trim'],
  ] as const) {
    const a = (before[key] ?? {}) as Record<string, StoredExpression | undefined>;
    const b = (after[key] ?? {}) as Record<string, StoredExpression | undefined>;
    for (const k of Object.keys(TRIM_LABELS)) {
      if (!same(a[k], b[k])) {
        lines.push(
          `${label}, ${TRIM_LABELS[k]}: ${expressionText(a[k])} to ${expressionText(b[k])}`,
        );
      }
    }
  }
  if (before.maxStages !== after.maxStages) {
    lines.push(
      `Sheet layout stages: ${before.maxStages ?? 'not set'} to ${after.maxStages ?? 'not set'}`,
    );
  }
  if (before.grain !== after.grain) {
    lines.push(`Grain: ${before.grain ?? 'not set'} to ${after.grain ?? 'not set'}`);
  }
  return lines;
}

/** `domains.wood`: kerf, trims, stage limit, grain rule. */
export const woodDataSummariser: DomainDataSummariser = {
  namespace: WOOD_NAMESPACE,
  summarise(before, after) {
    const a = readWood(before);
    const b = readWood(after);
    if (typeof b === 'string') return [`The woodworking settings do not read: ${b}`];
    if (typeof a === 'string')
      return [`The woodworking settings were replaced (they did not read: ${a})`];
    if (after === undefined)
      return ['The woodworking settings were removed: every setting is the default'];
    const lines = woodLines(a, b);
    return lines.length > 0 ? lines : ['The woodworking settings were rewritten without a change'];
  },
};

// Stock -----------------------------------------------------------------------------------------

function readOverrides(
  entry: DomainData | undefined,
): ReadonlyMap<string, StoredStockOverride> | string {
  if (entry === undefined) return new Map();
  const r = readStockData(entry.data as Json, entry.schemaVersion);
  return r.ok ? r.value.stored : r.message;
}

function overrideText(o: StoredStockOverride): string {
  const parts: string[] = [];
  if (o.thickness) parts.push(`thickness ${expressionText(o.thickness)}`);
  if (o.width) parts.push(`width ${expressionText(o.width)}`);
  if (o.sheet) {
    parts.push(`sheet ${expressionText(o.sheet.length)} by ${expressionText(o.sheet.width)}`);
  }
  if (o.price) {
    parts.push(
      `price ${o.price.amount}${o.price.currency ? ` ${o.price.currency}` : ''} per ${o.price.per}`,
    );
  }
  return parts.length > 0 ? parts.join(', ') : 'nothing';
}

const stockLabel = (id: string): string => {
  const name = findStock(id)?.name;
  return name === undefined ? id : `${name} (${id})`;
};

/** `domains.stock`: the document's stock overrides, by stock id. */
export const stockDataSummariser: DomainDataSummariser = {
  namespace: STOCK_NAMESPACE,
  summarise(before, after) {
    const a = readOverrides(before);
    const b = readOverrides(after);
    if (typeof b === 'string') return [`The stock overrides do not read: ${b}`];
    if (typeof a === 'string')
      return [`The stock overrides were replaced (they did not read: ${a})`];
    const lines: string[] = [];
    const ids = [...new Set([...a.keys(), ...b.keys()])].sort();
    for (const id of ids) {
      const x = a.get(id);
      const y = b.get(id);
      if (x === undefined && y !== undefined) {
        lines.push(`Stock override added for ${stockLabel(id)}: ${overrideText(y)}`);
      } else if (x !== undefined && y === undefined) {
        lines.push(`Stock override removed for ${stockLabel(id)}: was ${overrideText(x)}`);
      } else if (!same(x, y)) {
        lines.push(
          `Stock override for ${stockLabel(id)}: ${overrideText(x!)} to ${overrideText(y!)}`,
        );
      }
    }
    return lines.length > 0 ? lines : ['The stock overrides were rewritten without a change'];
  },
};
