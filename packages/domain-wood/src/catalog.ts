// The stock catalog: what boards are cut from, with nominal and actual sizes (M4 plan Part 1,
// "Nominal and actual lumber sizes"; T4.1c).
//
// Every size is an exact number of millimetres, computed from the inch fraction or millimetre
// figure of its source, never a rounded decimal (`23/32"` is (23 / 32) x 25.4 mm). Every entry says
// where its sizes come from and whether they were checked against that source (`verified`), like
// the kernel's `HOLE_SIZES` and core's `MATERIALS`. Actual stock varies (plywood by maker, lumber
// by moisture), so a document can override a stock's actual sizes in `domains.stock`
// (`stock-data.ts`).
//
// Ids are permanent: they are stored in board features and stock overrides. An entry may gain
// fields or a corrected size (with its source), but an id must never be removed or change
// meaning.
//
// Entries are grouped by region so the stock picker can default by the document's display units
// (`defaultRegion`): US customary sizes for inch and foot documents, metric for the rest.

import type { MaterialId } from '@manufakture/core';
import { MM_PER_INCH, type LengthFormat } from '@manufakture/units';

/** Where a stock is sold, by its sizing system. */
export type StockRegion = 'us' | 'metric';

/** `lumber`: sticks of a fixed section (or hardwood of random width); `sheet`: panels. */
export type StockKind = 'lumber' | 'sheet';

export type StockCategory = 'softwood' | 'hardwood' | 'plywood' | 'osb' | 'mdf';

/**
 * How a stock's board feet are counted (the cut list, T4.3a): `nominal` on nominal thickness and
 * width (surfaced softwood, the PS 20 convention), `rough` on the nominal (rough) thickness in
 * quarters with actual width and length (hardwood), `none` for sheet goods.
 */
export type BoardFeetBasis = 'nominal' | 'rough' | 'none';

/** Sizes in millimetres. A lumber entry without a `width` is sold in random widths (hardwood). */
export interface StockSize {
  readonly thickness: number;
  readonly width?: number;
}

export interface StockEntry {
  /** Permanent id, stored in documents (`us-2x4`, `us-ply-23-32`). */
  readonly id: string;
  /** Short display name as sold (`2x4`, `3/4" plywood`). */
  readonly name: string;
  /** The actual size as text in the entry's own units, for pickers (`1-1/2" x 3-1/2"`). */
  readonly actualLabel: string;
  readonly region: StockRegion;
  readonly kind: StockKind;
  readonly category: StockCategory;
  /** The size it is sold as (for lumber, what board feet are counted on). */
  readonly nominal: StockSize;
  /** The size it really is (dry, dressed or sanded): what a board is built with. */
  readonly actual: StockSize;
  /** Lengths it is commonly sold in, mm (lumber). */
  readonly lengths?: readonly number[];
  /** Sheet size, mm, length (along the grain, when it has one) by width (sheets). */
  readonly sheet?: { readonly length: number; readonly width: number };
  readonly boardFeetBasis: BoardFeetBasis;
  /** The core material a board of this stock gets unless the user sets another. */
  readonly material: MaterialId;
  /** Whether it has a grain direction that cut lists and sheet layouts respect. */
  readonly grain: boolean;
  /** Where the sizes come from: the actual size, and the lengths or sheet size it is sold in. */
  readonly source: { readonly actual: string; readonly sold: string };
  /** Whether each was checked against its source. Unverified values are shown as such. */
  readonly verified: { readonly actual: boolean; readonly sold: boolean };
}

/** Millimetres from inches given as a whole number and an optional fraction. */
export function inches(whole: number, num = 0, den = 1): number {
  return (whole + num / den) * MM_PER_INCH;
}

/** `1-1/2`, `3/4`, `11` for a number of inches with a power-of-two fraction (up to 1/64). */
export function inchLabel(value: number): string {
  const sixtyFourths = Math.round(value * 64);
  const whole = Math.floor(sixtyFourths / 64);
  let num = sixtyFourths % 64;
  let den = 64;
  while (num !== 0 && num % 2 === 0) {
    num /= 2;
    den /= 2;
  }
  if (num === 0) return String(whole);
  return whole === 0 ? `${num}/${den}` : `${whole}-${num}/${den}`;
}

// US softwood: PS 20-25 Table 3 ----------------------------------------------------------------

const PS20 =
  'Voluntary Product Standard PS 20-25, American Softwood Lumber Standard (NIST, effective January 2025), Table 3, minimum dressed dry sizes';
const US_LENGTHS_SOURCE =
  'Common US retail lengths, 8 to 16 ft in 2 ft steps (not from a standard; varies by yard)';
const US_LENGTHS = [8, 10, 12, 14, 16].map((ft) => inches(ft * 12));

/** One row pair of Table 3: nominal inches to minimum dressed dry inches. */
type SizeRow = readonly [nominal: number, dry: number];

/** Boards (less than 2" nominal thick): thickness rows. */
export const PS20_BOARD_THICKNESS: readonly SizeRow[] = [
  [3 / 4, 5 / 8],
  [1, 3 / 4],
  [1 + 1 / 4, 1],
  [1 + 1 / 2, 1 + 1 / 4],
];
/** Boards: width rows. */
export const PS20_BOARD_WIDTH: readonly SizeRow[] = [
  [2, 1 + 1 / 2],
  [3, 2 + 1 / 2],
  [4, 3 + 1 / 2],
  [5, 4 + 1 / 2],
  [6, 5 + 1 / 2],
  [7, 6 + 1 / 2],
  [8, 7 + 1 / 4],
  [9, 8 + 1 / 4],
  [10, 9 + 1 / 4],
  [11, 10 + 1 / 4],
  [12, 11 + 1 / 4],
  [14, 13 + 1 / 4],
  [16, 15 + 1 / 4],
];
/** Dimension lumber (2" to under 5" nominal thick): thickness rows. */
export const PS20_DIMENSION_THICKNESS: readonly SizeRow[] = [
  [2, 1 + 1 / 2],
  [2 + 1 / 2, 2],
  [3, 2 + 1 / 2],
  [3 + 1 / 2, 3],
  [4, 3 + 1 / 2],
  [4 + 1 / 2, 4],
];
/** Dimension lumber: width rows. */
export const PS20_DIMENSION_WIDTH: readonly SizeRow[] = [
  [2, 1 + 1 / 2],
  [3, 2 + 1 / 2],
  [4, 3 + 1 / 2],
  [5, 4 + 1 / 2],
  [6, 5 + 1 / 2],
  [8, 7 + 1 / 4],
  [10, 9 + 1 / 4],
  [12, 11 + 1 / 4],
  [14, 13 + 1 / 4],
  [16, 15 + 1 / 4],
];

/** `5/4` style id token for a nominal inch size: `1`, `5-4` (5/4), `2-1-2` (2-1/2). */
function idToken(value: number): string {
  return inchLabel(value).replace(/[-/]/g, '-');
}

function softwood(thickness: SizeRow, width: SizeRow): StockEntry {
  const [nt, at] = thickness;
  const [nw, aw] = width;
  const name = `${inchLabel(nt)}x${inchLabel(nw)}`;
  return {
    id: `us-${idToken(nt)}x${idToken(nw)}`,
    name,
    actualLabel: `${inchLabel(at)}" x ${inchLabel(aw)}"`,
    region: 'us',
    kind: 'lumber',
    category: 'softwood',
    nominal: { thickness: inches(nt), width: inches(nw) },
    actual: { thickness: inches(at), width: inches(aw) },
    lengths: US_LENGTHS,
    boardFeetBasis: 'nominal',
    material: 'pine',
    grain: true,
    source: { actual: PS20, sold: US_LENGTHS_SOURCE },
    verified: { actual: true, sold: false },
  };
}

/** Every board and dimension size of Table 3 with a width at least its thickness. */
function softwoodEntries(): StockEntry[] {
  const out: StockEntry[] = [];
  for (const [rows, widths] of [
    [PS20_BOARD_THICKNESS, PS20_BOARD_WIDTH],
    [PS20_DIMENSION_THICKNESS, PS20_DIMENSION_WIDTH],
  ] as const) {
    for (const t of rows) {
      for (const w of widths) if (w[0] >= t[0]) out.push(softwood(t, w));
    }
  }
  return out;
}

// US hardwood: quarters, rough and surfaced ----------------------------------------------------

const HARDWOOD_SOURCE =
  'NHLA rules: rough thickness in quarters of an inch; surfaced two sides (S2S) thickness from an NHLA rules card (midwesthardwood.com rules_card9.pdf) and a retailer summary, not the rule book (unverified)';

/** Quarters, rough thickness in inches, and the usual S2S thickness in inches. */
const HARDWOOD: readonly (readonly [quarters: number, s2s: number])[] = [
  [4, 13 / 16],
  [5, 1 + 1 / 16],
  [6, 1 + 5 / 16],
  [8, 1 + 3 / 4],
];

function hardwoodEntries(): StockEntry[] {
  return HARDWOOD.map(([quarters, s2s]) => ({
    id: `us-hw-${quarters}-4`,
    name: `${quarters}/4 hardwood`,
    actualLabel: `${inchLabel(s2s)}" S2S`,
    region: 'us',
    kind: 'lumber',
    category: 'hardwood',
    nominal: { thickness: inches(quarters / 4) },
    actual: { thickness: inches(s2s) },
    boardFeetBasis: 'rough',
    material: 'oak',
    grain: true,
    source: {
      actual: HARDWOOD_SOURCE,
      sold: 'Sold rough in random widths and lengths by the board foot',
    },
    verified: { actual: false, sold: false },
  }));
}

// US sheet goods ------------------------------------------------------------------------------

const US_SHEET = { length: inches(96), width: inches(48) };
const US_SHEET_SOURCE = '4 ft x 8 ft, the common US panel size (secondary sources; unverified)';
const PS1 =
  'PS 1 Performance Category on the grade stamp, per APA and a PFS TECO summary of PS 1 and PS 2 grade stamps (secondary; the standard text was not read: unverified)';
const PS2 =
  'PS 2 Performance Category on the grade stamp, per a PFS TECO summary of PS 1 and PS 2 grade stamps (secondary; the standard text was not read: unverified)';
const MDF_US =
  'Sold at its nominal thickness (maker data, not a standard; unverified: thicknesses vary by maker)';

/** Nominal inches as sold, actual (Performance Category) inches. */
const PLYWOOD_US: readonly (readonly [nominal: number, category: number])[] = [
  [1 / 4, 7 / 32],
  [3 / 8, 11 / 32],
  [1 / 2, 15 / 32],
  [5 / 8, 19 / 32],
  [3 / 4, 23 / 32],
];
const OSB_US: readonly (readonly [nominal: number, category: number])[] = [
  [7 / 16, 7 / 16],
  [1 / 2, 15 / 32],
  [3 / 4, 23 / 32],
];
const MDF_US_SIZES: readonly number[] = [1 / 4, 1 / 2, 3 / 4];

function usSheet(
  category: 'plywood' | 'osb' | 'mdf',
  nominal: number,
  actual: number,
  source: string,
): StockEntry {
  const label = { plywood: 'plywood', osb: 'OSB', mdf: 'MDF' }[category];
  const prefix = { plywood: 'ply', osb: 'osb', mdf: 'mdf' }[category];
  return {
    id: `us-${prefix}-${idToken(actual)}`,
    name: `${inchLabel(nominal)}" ${label}`,
    actualLabel: `${inchLabel(actual)}"`,
    region: 'us',
    kind: 'sheet',
    category,
    nominal: { thickness: inches(nominal) },
    actual: { thickness: inches(actual) },
    sheet: US_SHEET,
    boardFeetBasis: 'none',
    // Core has no OSB material yet; plywood is the nearest density (OSB is about 600 to 650).
    material: category === 'mdf' ? 'mdf' : 'plywood',
    // OSB has a strength axis but no visible grain; MDF has neither.
    grain: category === 'plywood',
    source: { actual: source, sold: US_SHEET_SOURCE },
    verified: { actual: false, sold: false },
  };
}

function usSheetEntries(): StockEntry[] {
  return [
    // 1/4" sanded plywood's 7/32" is common practice, not a PS 1 category.
    ...PLYWOOD_US.map(([n, a]) =>
      usSheet(
        'plywood',
        n,
        a,
        n === 1 / 4 ? 'Common sanded 1/4" panel thickness (maker data; unverified)' : PS1,
      ),
    ),
    ...OSB_US.map(([n, a]) => usSheet('osb', n, a, PS2)),
    ...MDF_US_SIZES.map((n) => usSheet('mdf', n, n, MDF_US)),
  ];
}

// Metric -----------------------------------------------------------------------------------------

const METRIC_SHEET = { length: 2440, width: 1220 };
const METRIC_SHEET_SOURCE =
  '2440 x 1220 mm, the common European panel size (maker data; unverified)';
const METRIC_LUMBER_SOURCE =
  'Canadian CLS and UK 38 mm regularised sizes, close to PS 20 dry sizes but not equal to them: 38 x 63 and 38 x 140 mm against 38.1 x 63.5 and 38.1 x 139.7 mm (unverified against a Canadian or British source)';
const METRIC_LENGTHS = [2400, 3000, 3600, 4200, 4800];

function metricSheet(category: 'plywood' | 'mdf', thickness: number): StockEntry {
  const label = category === 'plywood' ? 'plywood' : 'MDF';
  return {
    id: `mm-${category === 'plywood' ? 'ply' : 'mdf'}-${thickness}`,
    name: `${thickness} mm ${label}`,
    actualLabel: `${thickness} mm`,
    region: 'metric',
    kind: 'sheet',
    category,
    nominal: { thickness },
    actual: { thickness },
    sheet: METRIC_SHEET,
    boardFeetBasis: 'none',
    material: category,
    grain: category === 'plywood',
    source: {
      actual: 'Sold at its nominal thickness (maker data; unverified: sanded panels run thinner)',
      sold: METRIC_SHEET_SOURCE,
    },
    verified: { actual: false, sold: false },
  };
}

function metricLumber(thickness: number, width: number): StockEntry {
  return {
    id: `mm-${thickness}x${width}`,
    name: `${thickness} x ${width} mm`,
    actualLabel: `${thickness} x ${width} mm`,
    region: 'metric',
    kind: 'lumber',
    category: 'softwood',
    nominal: { thickness, width },
    actual: { thickness, width },
    lengths: METRIC_LENGTHS,
    boardFeetBasis: 'nominal',
    material: 'pine',
    grain: true,
    source: {
      actual: METRIC_LUMBER_SOURCE,
      sold: 'Common UK and European lengths, 2.4 to 4.8 m in 0.6 m steps (unverified)',
    },
    verified: { actual: false, sold: false },
  };
}

function metricEntries(): StockEntry[] {
  return [
    metricLumber(38, 63),
    metricLumber(38, 89),
    metricLumber(38, 140),
    ...[12, 15, 18].map((t) => metricSheet('plywood', t)),
    ...[12, 15, 18].map((t) => metricSheet('mdf', t)),
  ];
}

// The catalog ----------------------------------------------------------------------------------

function freeze(entries: StockEntry[]): readonly StockEntry[] {
  for (const e of entries) Object.freeze(e);
  return Object.freeze(entries);
}

/** Every catalog stock, in picker order: US softwood, hardwood, sheets, then metric. */
export const STOCK: readonly StockEntry[] = freeze([
  ...softwoodEntries(),
  ...hardwoodEntries(),
  ...usSheetEntries(),
  ...metricEntries(),
]);

const BY_ID: ReadonlyMap<string, StockEntry> = new Map(STOCK.map((e) => [e.id, e]));

/** The catalog stock with this id, or undefined for an unknown one. */
export function findStock(id: string): StockEntry | undefined {
  return BY_ID.get(id);
}

/** The catalog of one region, by kind, in picker order. */
export function stockByRegion(region: StockRegion): {
  lumber: StockEntry[];
  sheet: StockEntry[];
} {
  const inRegion = STOCK.filter((e) => e.region === region);
  return {
    lumber: inRegion.filter((e) => e.kind === 'lumber'),
    sheet: inRegion.filter((e) => e.kind === 'sheet'),
  };
}

/**
 * The region a stock picker opens on for a document's display length format: US sizes for inch
 * and foot documents (`in`, `ft`, `ft-in`, `in-fraction`), metric for millimetre, centimetre and
 * metre ones. The user can always switch.
 */
export function defaultRegion(format: LengthFormat): StockRegion {
  return format.unit === 'in' ||
    format.unit === 'ft' ||
    format.unit === 'ft-in' ||
    format.unit === 'in-fraction'
    ? 'us'
    : 'metric';
}
