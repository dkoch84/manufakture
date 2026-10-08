// The cut list as people read it (M4 plan T4.3d; moved from the app's Cut list panel in M8 plan
// T8.1b so a headless session can write the files): the cut list input from the document and its
// regenerated model (`cutList`, T4.3a), which bodies need an oriented box from regen, the rows as
// the panel and the files show them (numbered, with short item names and flags in words),
// sorting, and the CSV files.

import {
  findMaterial,
  lengthFormat,
  type DisplayUnits,
  type ManufaktureDocument,
  type Part,
} from '@manufakture/core';
import type { AssemblyResult } from '@manufakture/regen';
import { documentStock } from '@manufakture/stock';
import {
  csvField,
  csvTextField,
  exactLengthFormat,
  formatMeasure,
  formatSize,
} from '@manufakture/takeoff';
import { formatLength, type LengthFormat } from '@manufakture/units';
import { BOARD_TYPE } from '../board';
import type { Json } from '../migrations';
import { WOOD_NAMESPACE, woodSettings, type WoodSettings } from '../wood-data';
import { cutList, stockName, type CutList, type CutListFlag, type CutListRow } from './cutlist';
import { cutListPart, type PartResultLike } from './from-regen';
import type { CutListInput, CutListInstance, OrientedSize } from './input';
import type { Purchase } from './layout';

// The input --------------------------------------------------------------------------------------

/** The document's woodworking settings; the defaults when `domains.wood` cannot be read. */
export function documentSettings(doc: ManufaktureDocument): {
  settings: WoodSettings;
  error: string | null;
} {
  const entry = doc.domains?.[WOOD_NAMESPACE];
  const r = woodSettings(
    entry === undefined
      ? undefined
      : { schemaVersion: entry.schemaVersion, data: entry.data as Json },
  );
  if (r.ok) return { settings: r.value, error: null };
  const fallback = woodSettings(undefined);
  return {
    settings: fallback.ok ? fallback.value : (undefined as never),
    error: `The woodworking settings cannot be read, so the defaults are used: ${r.message}`,
  };
}

/** The active configuration row, when there is one. */
export function activeRow(doc: ManufaktureDocument): { id: string; name: string } | undefined {
  const c = doc.configurations;
  if (!c || c.active === null) return undefined;
  const row = c.rows.find((r) => r.id === c.active);
  return row === undefined ? undefined : { id: row.id, name: row.name };
}

function isBoardCreator(part: Pick<Part, 'features'>, creator: string): boolean {
  const f = part.features.find((x) => x.id === creator);
  return f?.kind === 'extension' && f.extension === BOARD_TYPE;
}

/**
 * The bodies of a part that need an oriented box for the cut list: not made by a board, and of a
 * wood material (their own, else the part's). Boards are sized by their blank, never by a box.
 */
export function bodiesToSize(part: Part, model: CutListPartModel): string[] {
  return model.bodies
    .filter((b) => {
      if (isBoardCreator(part, b.creator)) return false;
      const material = part.bodies.find((p) => p.id === b.bodyId)?.material ?? part.material;
      return material !== undefined && findMaterial(material)?.category === 'wood';
    })
    .map((b) => b.bodyId);
}

/**
 * A part of the regenerated model, as the cut list reads it: regen's `PartResult` fits, and so
 * does the app's model of a part.
 */
export interface CutListPartModel {
  partId: string;
  features: PartResultLike['features'];
  bodies: readonly { bodyId: string; creator: string }[];
}

export interface CutListSources {
  /** The document as stored. */
  document: ManufaktureDocument;
  /** The model's parts (built in the active configuration row). */
  parts: readonly CutListPartModel[];
  /** The model's assemblies; with `assemblyId`, the list counts through that one. */
  assemblies?: readonly AssemblyResult[];
  assemblyId?: string | null;
  /** Oriented sizes by part id (from the regen worker), for bodies that are not boards. */
  sizes?: ReadonlyMap<string, readonly OrientedSize[]>;
}

/** What `cutList` is computed from, for the shown model. */
export function cutListInput(src: CutListSources): CutListInput {
  const doc = src.document;
  const parts = src.parts.flatMap((model) => {
    const part = doc.parts.find((p) => p.id === model.partId);
    if (part === undefined) return [];
    const sizes = src.sizes?.get(part.id);
    return [
      cutListPart(
        part,
        // Bodies by id and creator only, as the app's model holds them: names and materials come
        // from the document part, so a regen result's `inherited` fields are not read here.
        {
          features: model.features,
          bodies: model.bodies.map((b) => ({ bodyId: b.bodyId, creator: b.creator })),
        },
        sizes === undefined ? {} : { orientedSizes: sizes },
      ),
    ];
  });
  const input: CutListInput = { parts, settings: documentSettings(doc).settings };
  const stock = documentStock(doc);
  if (stock.ok && stock.data !== undefined) input.stock = stock.data;
  const row = activeRow(doc);
  if (row !== undefined) input.configuration = row;
  const assembly =
    src.assemblyId == null
      ? undefined
      : src.assemblies?.find((a) => a.assemblyId === src.assemblyId);
  if (assembly !== undefined) {
    input.assembly = {
      instances: assembly.instances.map((x): CutListInstance => {
        // An instance of a pinned part, or of a part in another row, has no build here: the
        // list reports it as missing rather than counting a part it was not built from.
        const part = 'part' in x.source ? x.source.part : x.source.source;
        return {
          id: x.instanceId,
          part,
          bodies: x.bodies,
          ...(x.status === 'suppressed' ? { suppressed: true } : {}),
        };
      }),
    };
  }
  return input;
}

/** The cut list of the shown model. */
export function documentCutList(src: CutListSources): CutList {
  return cutList(cutListInput(src));
}

// Display ----------------------------------------------------------------------------------------

/** A fractional display shows sizes to 1/64", so `23/32"` never rounds to `3/4"`. */
export function exactFormat(units: DisplayUnits): LengthFormat {
  return exactLengthFormat(lengthFormat(units));
}

const NUMBERED = /^(.*?)\s*(\d+)$/;

/**
 * A joined item name made short: `Shelf 1, Shelf 2, Shelf 3, Side 1` becomes `Shelf 1-3, Side 1`;
 * numbers that do not run on stay listed (`Shelf 1, 3`). More than `max` names are cut to the
 * first ones and a count (`A, B, C and 4 more`).
 */
export function shortItem(item: string, max = 3): string {
  const names = item.split(', ');
  if (names.length < 2) return item;
  const groups = new Map<string, number[]>();
  const plain: string[] = [];
  const order: string[] = [];
  for (const name of names) {
    const m = NUMBERED.exec(name);
    if (m === null || m[1] === '') {
      plain.push(name);
      order.push(`\u0000${name}`);
      continue;
    }
    const [, base, n] = m as unknown as [string, string, string];
    let list = groups.get(base);
    if (list === undefined) {
      groups.set(base, (list = []));
      order.push(base);
    }
    list.push(Number(n));
  }
  const parts: string[] = [];
  for (const key of order) {
    if (key.startsWith('\u0000')) {
      parts.push(key.slice(1));
      continue;
    }
    const nums = [...new Set(groups.get(key)!)].sort((a, b) => a - b);
    const runs: string[] = [];
    for (let i = 0; i < nums.length;) {
      let j = i;
      while (j + 1 < nums.length && nums[j + 1] === nums[j]! + 1) j++;
      runs.push(j - i >= 2 ? `${nums[i]}-${nums[j]}` : nums.slice(i, j + 1).join(', '));
      i = j + 1;
    }
    parts.push(`${key} ${runs.join(', ')}`);
  }
  if (parts.length <= max) return parts.join(', ');
  return `${parts.slice(0, max).join(', ')} and ${parts.length - max} more`;
}

/** What a flag means, for people. */
export const FLAG_TEXT: Readonly<Record<CutListFlag, string>> = {
  estimated: 'sized from its shape',
  'size-unknown': 'size unknown',
  'actual-width': 'ripped: board feet on the actual width',
  'stock-unknown': 'stock unknown',
};

export function flagText(flag: string): string {
  return FLAG_TEXT[flag as CutListFlag] ?? flag;
}

/** A row as the panel and the files show it. */
export interface DisplayRow {
  /** From 1, in the list's order: the label the sheet layouts put on the part. */
  number: number;
  key: string;
  kind: CutListRow['kind'];
  category: string;
  /** The short item name; `fullItem` has every name. */
  item: string;
  fullItem: string;
  stockId: string | undefined;
  stock: string;
  material: string;
  size: string;
  length: number;
  width: number;
  thickness: number;
  quantity: number;
  /** The row's total in its unit (`5.33 bd ft`, `11.25 sq ft`, `4 pcs`). */
  extended: string;
  /** Board feet, when the row counts them. */
  boardFeet: number | undefined;
  flags: string[];
  /** The bodies of the row, as `{ part, id }` (for highlighting). */
  sources: { part: string | undefined; id: string; instance: string | undefined }[];
}

export function displayRows(rows: readonly CutListRow[], units: DisplayUnits): DisplayRow[] {
  const format = exactFormat(units);
  return rows.map((row, i) => ({
    number: i + 1,
    key: row.key,
    kind: row.kind,
    category: row.category,
    item: shortItem(row.item),
    fullItem: row.item,
    stockId: row.stock,
    stock: row.stock === undefined ? '' : stockName(row.stock),
    material: row.material === undefined ? '' : (findMaterial(row.material)?.name ?? row.material),
    size: formatSize(row.size, format),
    length: row.size?.length ?? 0,
    width: row.size?.width ?? 0,
    thickness: row.size?.thickness ?? 0,
    quantity: row.quantity,
    extended: formatMeasure({ unit: row.unit, value: row.extended }, format),
    boardFeet: row.unit === 'board-foot' ? row.extended : undefined,
    flags: row.flags,
    sources: row.sources.map((s) => ({ part: s.part, id: s.id, instance: s.instance })),
  }));
}

export type SortKey = 'number' | 'item' | 'length' | 'width' | 'thickness' | 'quantity';

/**
 * Rows grouped by stock (in the list's order of stocks), sorted within each group by `key`.
 * Shapes and rows of no stock form their own group at the end.
 */
export function groupRows(
  rows: readonly DisplayRow[],
  key: SortKey = 'number',
  descending = false,
): { stock: string; title: string; rows: DisplayRow[] }[] {
  const groups = new Map<string, { stock: string; title: string; rows: DisplayRow[] }>();
  for (const r of rows) {
    const id = r.stockId ?? '';
    let g = groups.get(id);
    if (g === undefined) {
      groups.set(id, (g = { stock: id, title: r.stock || 'Other wood parts', rows: [] }));
    }
    g.rows.push(r);
  }
  const collator = new Intl.Collator('en', { numeric: true });
  const compare = (a: DisplayRow, b: DisplayRow): number => {
    const d =
      key === 'item'
        ? collator.compare(a.item, b.item)
        : key === 'number'
          ? a.number - b.number
          : a[key] - b[key];
    return (descending ? -d : d) || a.number - b.number;
  };
  return [...groups.values()].map((g) => ({ ...g, rows: [...g.rows].sort(compare) }));
}

/** The totals as lines: `Sheet goods: 22.6 sq ft (7 pcs)`. */
export function totalLines(list: CutList, units: DisplayUnits): string[] {
  const format = exactFormat(units);
  const names: Record<string, string> = {
    sheet: 'Sheet goods',
    lumber: 'Lumber',
    part: 'Other wood parts',
    hardware: 'Hardware',
  };
  const out: string[] = [];
  for (const group of new Set(list.totals.map((t) => t.group))) {
    const ts = list.totals.filter((t) => t.group === group && t.unit !== 'volume');
    if (ts.length === 0) continue;
    const pieces = ts.find((t) => t.unit === 'each')?.quantity ?? ts[0]!.quantity;
    const measures = ts.filter((t) => t.unit !== 'each').map((t) => formatMeasure(t, format));
    out.push(
      `${names[group] ?? group}: ${[...measures, `${pieces} ${pieces === 1 ? 'pc' : 'pcs'}`].join(', ')}`,
    );
  }
  return out;
}

/** Board feet of the whole list (lumber rows). */
export function totalBoardFeet(list: CutList): number {
  return list.totals.filter((t) => t.unit === 'board-foot').reduce((a, t) => a + t.value, 0);
}

/** Why each excluded body is not listed, in words, with the part's and body's names. */
export function excludedLines(list: CutList, doc: ManufaktureDocument): string[] {
  return list.excluded.map((e) => {
    const part = doc.parts.find((p) => p.id === e.part);
    const own = part?.bodies.find((b) => b.id === e.bodyId)?.name;
    const featureName = (id: string) => part?.features.find((f) => f.id === id)?.name ?? id;
    // A copy's id names its feature and the body it copies: `pattern#1:2/extension#7`.
    const slash = e.bodyId.lastIndexOf('/');
    const creator = featureName(e.bodyId.split(':')[0]!);
    const name =
      own ??
      (slash < 0 ? creator : `${creator}, copy of ${featureName(e.bodyId.slice(slash + 1))}`);
    const why =
      e.reason === 'no-material'
        ? 'it has no material (a copy of a board is not a board: give it a wood material to list it by its shape)'
        : 'its material is not a wood';
    return `${name} (${part?.name ?? e.part}): not in the cut list, ${why}`;
  });
}

/** Instances or bodies the list could not count, in words. */
export function missingLines(list: CutList): string[] {
  return list.missing.map((m) =>
    m.bodyId === undefined
      ? `Instance ${m.instance} is not counted: its part is pinned or in another configuration row`
      : `Instance ${m.instance} shows ${m.bodyId}, which ${m.part} does not have`,
  );
}

// CSV --------------------------------------------------------------------------------------------

/** A cell of user-supplied text (names, notes), as opposed to a number or a formatted measure. */
interface TextCell {
  text: string;
}

type Cell = string | number | TextCell;

/** Marks `value` as user-supplied text, so `csvField` guards it against formula injection. */
function text(value: string): TextCell {
  return { text: value };
}

function csv(lines: readonly (readonly Cell[])[]): string {
  const field = (c: Cell) => (typeof c === 'object' ? csvTextField(c.text) : csvField(c));
  return lines.map((l) => l.map(field).join(',')).join('\r\n') + '\r\n';
}

/**
 * The cut list as CSV: one line per row, sizes in the document's display units, every item name
 * in full (a spreadsheet can filter), the row's bodies last.
 */
export function cutListCsv(list: CutList, units: DisplayUnits): string {
  const format = exactFormat(units);
  const fmt = (mm: number | undefined) =>
    mm === undefined ? '' : formatSize({ length: mm }, format);
  const rows = displayRows(list.rows, units);
  return csv([
    [
      '#',
      'Item',
      'Stock',
      'Material',
      'Length',
      'Width',
      'Thickness',
      'Quantity',
      'Total',
      'Flags',
      'Bodies',
    ],
    ...list.rows.map((row, i) => [
      rows[i]!.number,
      text(row.item),
      text(rows[i]!.stock),
      text(rows[i]!.material),
      fmt(row.size?.length),
      fmt(row.size?.width),
      fmt(row.size?.thickness),
      row.quantity,
      rows[i]!.extended,
      text(row.flags.map(flagText).join('; ')),
      text(row.sources.map((s) => `${s.instance ? `${s.instance}/` : ''}${s.id}`).join(' ')),
    ]),
  ]);
}

/**
 * The bill of materials as CSV: per stock the pieces cut from it and their total, then the stock
 * to buy when the layouts are known (sheets, and sticks per length), then hardware.
 */
export function bomCsv(list: CutList, units: DisplayUnits, buy?: readonly Purchase[]): string {
  const format = exactFormat(units);
  const lines: Cell[][] = [['Item', 'Size', 'Quantity', 'Total']];
  for (const stock of new Set(list.stockTotals.map((t) => t.group))) {
    const ts = list.stockTotals.filter((t) => t.group === stock);
    const pieces = ts[0]!.quantity;
    lines.push([
      text(`${stockName(stock)} (parts)`),
      '',
      pieces,
      ts.map((t) => formatMeasure(t, format)).join('; '),
    ]);
  }
  for (const p of buy ?? []) {
    lines.push([
      text(`${stockName(p.stock)} (${p.kind === 'sheet' ? 'sheets' : 'sticks'} to buy)`),
      p.length === undefined ? '' : formatLength(p.length, format),
      p.count,
      '',
    ]);
  }
  for (const h of list.hardware) {
    lines.push([text(h.item), formatSize(h.size, format), h.quantity, '']);
  }
  return csv(lines);
}
