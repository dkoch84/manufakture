// The construction takeoff as the panel and its files show it (M6 plan T6.3b; moved from the app in
// M8 plan T8.1b): rows numbered and grouped by section in T6.3a's order (as framed, linear length,
// sheet layers as laid, lumber to buy, sheets to buy), sizes and totals in the document's display
// units, cost per row and in all, subtotals per level and feature, and the CSV. Every export
// carries the short "not an engineering tool" text (ADR 0015 decision 8).
//
// As framed only (ADR 0015 decision 10): every count is what the generators framed and the faces
// laid, then what to buy for exactly that; there is no estimating row. A row to buy counts what
// is bought (sticks, precut studs, sheets) while its sources are the members or faces cut from it,
// so the panel and the files say both: "13 sticks, cut into 38 members".

import { lengthFormat, type DisplayUnits, type ManufaktureDocument } from '@manufakture/core';
import { findStock } from '@manufakture/stock';
import {
  csvField,
  csvTextField,
  exactLengthFormat,
  formatMeasure,
  type TakeoffTotal,
} from '@manufakture/takeoff';
import { formatLength, type LengthFormat } from '@manufakture/units';
import type { ConstructionSettings } from '../data';
import { DISCLAIMER_SHORT } from '../disclaimer';
import {
  CONSTRUCTION_CATEGORIES,
  type ConstructionCategory,
  type ConstructionRow,
  type ConstructionTakeoff,
} from './types';

/** A fractional display shows sizes to 1/64", as the cut list does. */
export function exactFormat(units: DisplayUnits): LengthFormat {
  return exactLengthFormat(lengthFormat(units));
}

/** Section titles and what each counts, in T6.3a's order. */
export const SECTIONS: Readonly<Record<ConstructionCategory, { title: string; note: string }>> = {
  framing: { title: 'As framed', note: 'Every member, by stock and blank length.' },
  linear: { title: 'Linear length', note: 'Plates, blocking and fascia in all.' },
  faces: { title: 'Sheet layers as laid', note: 'Area covered, less openings.' },
  lumber: {
    title: 'Lumber to buy',
    note: 'Quantities count sticks and precut studs to buy; the members a row names are the ones cut from them.',
  },
  sheet: {
    title: 'Sheets to buy',
    note: 'Quantities count whole sheets to buy; the faces and parts a row names are the ones cut from them.',
  },
};

const FLAG_TEXT: Readonly<Record<string, string>> = {
  precut: 'precut stud',
  spliced: 'bought in pieces; the framing shows no splice',
  'longer-than-stock': 'longer than any length sold',
  'no-stock-lengths': 'bought at its own length',
  'stock-unknown': 'stock not in this catalog; not bought',
  'no-price': 'no price',
  'price-unit': 'the price unit does not fit this stock',
  'other-currency': 'priced in another currency',
  'waste-added': 'includes the waste allowance',
};

export function flagText(flag: string): string {
  return FLAG_TEXT[flag] ?? flag;
}

/** A row as text. */
export interface TakeoffDisplayRow {
  /** From 1, in the takeoff's order. */
  number: number;
  key: string;
  category: ConstructionCategory;
  item: string;
  stock: string;
  size: string;
  quantity: number;
  /** `51 pcs`, `161' 6"`, `25 sheets`, `612.5 sq ft`. */
  extended: string;
  /** Other totals (length, board feet), joined. */
  measures: string;
  /** What one unit costs, and the row's cost, as text; empty when not priced. */
  price: string;
  cost: string;
  /** For bought rows: what the quantity is cut into (`cut into 38 members`). */
  counted: string;
  flags: string[];
  sources: string[];
}

export function stockName(id: string | undefined): string {
  if (id === undefined) return '';
  return findStock(id)?.name ?? id;
}

/** An amount of money: `$1,708.90` with a currency, `1,708.90` without. */
export function money(amount: number, currency: string | undefined): string {
  if (currency !== undefined) {
    try {
      return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount);
    } catch {
      // An unknown code still reads as an amount.
    }
  }
  const text = new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
  return currency === undefined ? text : `${currency} ${text}`;
}

const PER: Readonly<Record<string, string>> = {
  piece: 'each',
  sheet: 'per sheet',
  'board-foot': 'per bd ft',
  foot: 'per ft',
  metre: 'per m',
};

function sizeText(row: ConstructionRow, format: LengthFormat): string {
  const s = row.size;
  if (s === undefined) return '';
  if (row.category === 'sheet' && s.length !== undefined && s.width !== undefined) {
    return `${formatLength(s.length, format)} x ${formatLength(s.width, format)}`;
  }
  return s.length === undefined ? '' : formatLength(s.length, format);
}

function counted(row: ConstructionRow): string {
  if (row.category !== 'lumber' && row.category !== 'sheet') return '';
  const n = row.sources.length;
  if (row.category === 'lumber') return `cut into ${n} ${n === 1 ? 'member' : 'members'}`;
  return `for ${n} ${n === 1 ? 'face or part' : 'faces and parts'}`;
}

/** The rows as text, numbered in the takeoff's order. */
export function displayRows(
  takeoff: ConstructionTakeoff,
  units: DisplayUnits,
): TakeoffDisplayRow[] {
  const format = exactFormat(units);
  const currency = takeoff.cost.currency;
  return takeoff.rows.map((r, i) => ({
    number: i + 1,
    key: r.key,
    category: r.category,
    item: r.item,
    stock: stockName(r.stock),
    size: sizeText(r, format),
    quantity: r.quantity,
    extended: formatMeasure({ unit: r.unit, value: r.extended }, format),
    measures: r.measures.map((m) => formatMeasure(m, format)).join('; '),
    price:
      r.price === undefined
        ? ''
        : `${money(r.price.amount, r.price.currency ?? currency)} ${PER[r.price.per] ?? r.price.per}`,
    cost: r.cost === undefined ? '' : money(r.cost, currency),
    counted: counted(r),
    flags: r.flags,
    sources: r.sources.map((s) => s.id),
  }));
}

/** The rows grouped by section, sections in order, empty ones left out. */
export function sections(
  rows: readonly TakeoffDisplayRow[],
): { category: ConstructionCategory; rows: TakeoffDisplayRow[] }[] {
  return CONSTRUCTION_CATEGORIES.map((category) => ({
    category,
    rows: rows.filter((r) => r.category === category),
  })).filter((s) => s.rows.length > 0);
}

/** `51 pcs, 161' 6"` for a list of totals. */
export function totalsText(totals: readonly TakeoffTotal[], units: DisplayUnits): string {
  const format = exactFormat(units);
  return totals.map((t) => formatMeasure(t, format)).join(', ');
}

/** The cost in all, with what it leaves out. */
export function costLines(
  takeoff: ConstructionTakeoff,
  rows: readonly TakeoffDisplayRow[],
): string[] {
  const { cost } = takeoff;
  const out = [`Cost of what to buy: ${money(cost.total, cost.currency)}`];
  if (cost.unpriced.length > 0) {
    const numbers = new Map(rows.map((r) => [r.key, r.number]));
    const listed = cost.unpriced.map((k) => numbers.get(k)).filter((n) => n !== undefined);
    out.push(
      `Not in the cost (no price, or a stock the catalog lacks): row${listed.length === 1 ? '' : 's'} ${listed.join(', ')}`,
    );
  }
  return out;
}

/** Names of levels and features for the subtotals. */
export function subtotalLines(
  takeoff: ConstructionTakeoff,
  doc: ManufaktureDocument,
  partId: string,
  settings: ConstructionSettings | undefined,
): { kind: 'level' | 'feature'; id: string; name: string; text: string }[] {
  const part = doc.parts.find((p) => p.id === partId);
  const features = new Map((part?.features ?? []).map((f) => [f.id, f.name]));
  const levels = new Map((settings?.levels ?? []).map((l) => [l.id, l.name]));
  return takeoff.subtotals.map((s) => ({
    kind: s.kind,
    id: s.id,
    name:
      s.kind === 'level'
        ? (levels.get(s.id) ?? (s.id || 'No level'))
        : (features.get(s.id) ?? (s.id || 'Other')),
    text: totalsText(s.totals, doc.units),
  }));
}

export interface TakeoffCsvOptions {
  title: string;
  units: DisplayUnits;
  subtotals?: readonly { kind: string; name: string; text: string }[];
}

/**
 * The takeoff as CSV: a title line and the short disclaimer, then one line per row (section,
 * number, item, stock, size, quantity, total, other totals, unit price, cost, what a bought row
 * is cut into, notes), the subtotals and the cost.
 */
export function takeoffCsv(
  takeoff: ConstructionTakeoff,
  rows: readonly TakeoffDisplayRow[],
  options: TakeoffCsvOptions,
): string {
  const t = csvTextField;
  const lines: string[][] = [
    [t(`Takeoff: ${options.title}`)],
    [t(DISCLAIMER_SHORT)],
    [],
    [
      'Section',
      '#',
      'Item',
      'Stock',
      'Size',
      'Quantity',
      'Total',
      'Also',
      'Price',
      'Cost',
      'Counted from',
      'Notes',
    ].map(csvField),
  ];
  for (const r of rows) {
    lines.push([
      csvField(SECTIONS[r.category].title),
      csvField(r.number),
      t(r.item),
      t(r.stock),
      csvField(r.size),
      csvField(r.quantity),
      csvField(r.extended),
      csvField(r.measures),
      csvField(r.price),
      csvField(r.cost),
      csvField(r.counted),
      csvField(r.flags.map(flagText).join('; ')),
    ]);
  }
  if (options.subtotals && options.subtotals.length > 0) {
    lines.push([]);
    for (const s of options.subtotals) {
      lines.push([csvField(s.kind === 'level' ? 'Level' : 'Feature'), t(s.name), csvField(s.text)]);
    }
  }
  lines.push([]);
  for (const c of costLines(takeoff, rows)) lines.push([csvField(c)]);
  return lines.map((l) => l.join(',')).join('\r\n') + '\r\n';
}
