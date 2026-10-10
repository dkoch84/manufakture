// The takeoff model (ADR 0013 decision 8): rows of `{ item, stock, size, quantity, unit, extended,
// sources }` that a domain's producers fill (the woodworking cut list in M4; studs, sheathing and
// drywall in M6), with the grouping and the totals every producer shares.
//
// Values are internal units: lengths in millimetres, areas in square millimetres, volumes in cubic
// millimetres, masses in kilograms (SI, as `@manufakture/units` gives a mass); board feet, sheets
// and pieces are plain counts. Formatting for display is in
// `format.ts`, through `@manufakture/units`, in the document's display units.

import { MM_PER_INCH } from '@manufakture/units';

/**
 * What a row adds up to. `each`: pieces; `board-foot`: board feet (a count); `length`: mm;
 * `area`: mm²; `volume`: mm³; `mass`: kg; `sheet`: whole or estimated sheets (a count).
 */
export type TakeoffUnit = 'each' | 'board-foot' | 'length' | 'area' | 'volume' | 'mass' | 'sheet';

/** Every unit, in the order totals list them. */
export const TAKEOFF_UNITS: readonly TakeoffUnit[] = [
  'board-foot',
  'area',
  'sheet',
  'length',
  'volume',
  'mass',
  'each',
];

/**
 * The size of one piece, mm. For a board: the blank (length along the grain, width, thickness,
 * before joinery). For hardware: a diameter and a length. Absent fields do not apply.
 */
export interface TakeoffSize {
  length?: number;
  width?: number;
  thickness?: number;
  diameter?: number;
}

/**
 * What a row counts, and how many pieces each source gives: a body (1), a joint's dowels (4), a
 * wall's studs (M6). `part` names the part the id belongs to; `instance` the assembly instance it
 * was counted through, when it was.
 */
export interface TakeoffSource {
  id: string;
  part?: string;
  instance?: string;
  quantity: number;
}

/** An amount in one unit. */
export interface TakeoffMeasure {
  unit: TakeoffUnit;
  value: number;
}

export interface TakeoffRow {
  /** Rows with the same key are the same thing and merge into one (`mergeRows`). */
  key: string;
  /** What the row is, for people: "Shelf", "Side, Divider", "Dowel". */
  item: string;
  /** The producer's section: `sheet`, `lumber`, `part`, `hardware`; M6 adds its own. */
  category: string;
  /** The catalog stock id, when the row is cut from one. */
  stock?: string;
  /** A core material id, when known. */
  material?: string;
  /** One piece's size, mm. */
  size?: TakeoffSize;
  /** How many pieces: the sum of the sources' quantities. */
  quantity: number;
  /** What `extended` is in. */
  unit: TakeoffUnit;
  /** The row's total in `unit` (all pieces together). */
  extended: number;
  /** The row's totals in other units (lumber's total length next to its board feet). */
  measures: TakeoffMeasure[];
  sources: TakeoffSource[];
  /** Short machine-readable notes (`estimated`, `size-unknown`); the producer documents them. */
  flags: string[];
}

/** A total of rows in one unit. `quantity` is the pieces of the rows that have this unit. */
export interface TakeoffTotal {
  /** The group the total is for (`''` when not grouped). */
  group: string;
  unit: TakeoffUnit;
  value: number;
  quantity: number;
}

/** Rows merged and totalled: what a takeoff panel shows. */
export interface Takeoff {
  rows: TakeoffRow[];
  /** Totals per category and unit. */
  totals: TakeoffTotal[];
}

/** Cubic millimetres in a board foot: 144 cubic inches. */
export const MM3_PER_BOARD_FOOT = 144 * MM_PER_INCH ** 3;

/** Board feet of a piece given in mm: thickness x width x length in inches, over 144. */
export function boardFeet(thickness: number, width: number, length: number): number {
  return (thickness * width * length) / MM3_PER_BOARD_FOOT;
}

/**
 * A length as a key: whole nanometres, so sizes computed along different paths (600 and
 * 600.0000000001) group together, while any difference a saw could make stays apart.
 */
export function lengthKey(mm: number): string {
  const n = Math.round(mm * 1e6);
  return String(n === 0 ? 0 : n);
}

/** A size as a key (see `lengthKey`). */
export function sizeKey(size: TakeoffSize | undefined): string {
  if (size === undefined) return '-';
  return (['length', 'width', 'thickness', 'diameter'] as const)
    .map((k) => (size[k] === undefined ? '-' : lengthKey(size[k])))
    .join('x');
}

const collator = new Intl.Collator('en', { numeric: true });

/** Natural order for ids (`extension#2` before `extension#10`). */
export function compareIds(a: string, b: string): number {
  return collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);
}

function sourceKey(s: TakeoffSource): string {
  return JSON.stringify([s.part ?? null, s.instance ?? null, s.id]);
}

function compareSources(a: TakeoffSource, b: TakeoffSource): number {
  return (
    compareIds(a.part ?? '', b.part ?? '') ||
    compareIds(a.instance ?? '', b.instance ?? '') ||
    compareIds(a.id, b.id)
  );
}

/** Sources with the same part, instance and id added together, in natural id order. */
export function mergeSources(sources: readonly TakeoffSource[]): TakeoffSource[] {
  const byKey = new Map<string, TakeoffSource>();
  for (const s of sources) {
    const k = sourceKey(s);
    const seen = byKey.get(k);
    if (seen === undefined) byKey.set(k, { ...s });
    else seen.quantity += s.quantity;
  }
  return [...byKey.values()].sort(compareSources);
}

function addMeasures(into: TakeoffMeasure[], from: readonly TakeoffMeasure[]): void {
  for (const m of from) {
    const seen = into.find((x) => x.unit === m.unit);
    if (seen === undefined) into.push({ ...m });
    else seen.value += m.value;
  }
}

function joinUnique(a: string, b: string): string {
  const names = a.split(', ');
  for (const n of b.split(', ')) if (!names.includes(n)) names.push(n);
  return names.join(', ');
}

/**
 * Rows with the same key merged into one, in the order their keys first appear: quantities,
 * extended values and measures added, sources merged (`mergeSources`), flags and item names
 * joined without repeats. Rows that share a key must share a unit; a mismatch throws, since it
 * is a producer's bug, not a user's.
 */
export function mergeRows(rows: readonly TakeoffRow[]): TakeoffRow[] {
  const byKey = new Map<string, TakeoffRow>();
  for (const row of rows) {
    const seen = byKey.get(row.key);
    if (seen === undefined) {
      byKey.set(row.key, {
        ...row,
        ...(row.size === undefined ? {} : { size: { ...row.size } }),
        measures: row.measures.map((m) => ({ ...m })),
        sources: row.sources.map((s) => ({ ...s })),
        flags: [...row.flags],
      });
      continue;
    }
    if (seen.unit !== row.unit) {
      throw new Error(`rows "${row.key}" mix the units ${seen.unit} and ${row.unit}`);
    }
    seen.item = joinUnique(seen.item, row.item);
    seen.quantity += row.quantity;
    seen.extended += row.extended;
    addMeasures(seen.measures, row.measures);
    seen.sources.push(...row.sources.map((s) => ({ ...s })));
    for (const f of row.flags) if (!seen.flags.includes(f)) seen.flags.push(f);
  }
  const out = [...byKey.values()];
  for (const row of out) {
    row.sources = mergeSources(row.sources);
    row.flags.sort();
  }
  return out;
}

/** A row with every quantity, extended value, measure and source multiplied by `factor`. */
export function scaleRow(row: TakeoffRow, factor: number): TakeoffRow {
  return {
    ...row,
    ...(row.size === undefined ? {} : { size: { ...row.size } }),
    quantity: row.quantity * factor,
    extended: row.extended * factor,
    measures: row.measures.map((m) => ({ unit: m.unit, value: m.value * factor })),
    sources: row.sources.map((s) => ({ ...s, quantity: s.quantity * factor })),
    flags: [...row.flags],
  };
}

/**
 * Totals of rows per group (`groupOf`, default one group `''`) and unit: each row's `extended`
 * in its unit and each of its `measures`. Groups in the order they first appear, units in
 * `TAKEOFF_UNITS` order.
 */
export function totals(
  rows: readonly TakeoffRow[],
  groupOf: (row: TakeoffRow) => string = () => '',
): TakeoffTotal[] {
  const groups = new Map<string, Map<TakeoffUnit, TakeoffTotal>>();
  const add = (group: string, unit: TakeoffUnit, value: number, quantity: number) => {
    let byUnit = groups.get(group);
    if (byUnit === undefined) groups.set(group, (byUnit = new Map()));
    const t = byUnit.get(unit);
    if (t === undefined) byUnit.set(unit, { group, unit, value, quantity });
    else {
      t.value += value;
      t.quantity += quantity;
    }
  };
  for (const row of rows) {
    const g = groupOf(row);
    add(g, row.unit, row.extended, row.quantity);
    for (const m of row.measures) add(g, m.unit, m.value, row.quantity);
  }
  const out: TakeoffTotal[] = [];
  for (const byUnit of groups.values()) {
    for (const unit of TAKEOFF_UNITS) {
      const t = byUnit.get(unit);
      if (t !== undefined) out.push(t);
    }
  }
  return out;
}

/** Rows merged (`mergeRows`) and totalled per category. */
export function buildTakeoff(rows: readonly TakeoffRow[]): Takeoff {
  const merged = mergeRows(rows);
  return { rows: merged, totals: totals(merged, (r) => r.category) };
}
