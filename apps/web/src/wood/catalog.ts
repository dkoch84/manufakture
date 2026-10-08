// The stock catalog as the app shows it (M4 plan T4.1d): labels with nominal and actual sizes in
// the document's display units, the picker's groups and default stocks, the region a document's
// units suggest, and the document's stock overrides read. Apart from the board tool's logic
// (boards.ts), so the Stock panel and the picker load without the feature forms.

import type { DisplayUnits } from '@manufakture/core';
import {
  defaultRegion,
  stockByRegion,
  type BoardParams,
  type StockEntry,
  type StockRegion,
} from '@manufakture/domain-wood';
import { exactLengthFormat } from '@manufakture/takeoff';
import { formatLength } from '@manufakture/units';
import { lengthFormat } from '../sketcher/values';

// Stock labels ---------------------------------------------------------------------------------

/** A length in the document's display units, exact enough for a stock size (to 1/64"). */
export function sizeText(mm: number, units: DisplayUnits): string {
  return formatLength(mm, exactLengthFormat(lengthFormat(units)));
}

/** The actual size of a stock (thickness, or thickness by width) in the document's units. */
export function actualText(
  entry: StockEntry,
  units: DisplayUnits,
  size: { thickness: number; width?: number | undefined } = entry.actual,
): string {
  // In the region the units belong to, the source's own label is exact (`23/32"`, `13/16" S2S`).
  if (size === entry.actual && entry.region === defaultRegion(lengthFormat(units))) {
    return entry.actualLabel;
  }
  const t = sizeText(size.thickness, units);
  return size.width === undefined ? t : `${t} x ${sizeText(size.width, units)}`;
}

/**
 * `3/4" plywood (23/32")`, `2x4 (1-1/2" x 3-1/2")`; just the name when it already says it all
 * (`18 mm plywood`).
 */
export function stockLabel(entry: StockEntry, units: DisplayUnits): string {
  const actual = actualText(entry, units);
  return entry.name.includes(actual) ? entry.name : `${entry.name} (${actual})`;
}

/**
 * The picker's groups for a region, for a board form: sticks are cut from lumber only. `only`
 * keeps one kind whatever the form (construction's stud and sheathing pickers).
 */
export function stockGroups(
  region: StockRegion,
  form: BoardParams['form'],
  only?: 'lumber' | 'sheet',
): { label: string; entries: StockEntry[] }[] {
  const { lumber, sheet } = stockByRegion(region);
  if (only === 'lumber') return [{ label: 'Lumber', entries: lumber }];
  if (only === 'sheet') return [{ label: 'Sheet goods', entries: sheet }];
  const groups = [
    { label: 'Sheet goods', entries: sheet },
    { label: 'Lumber', entries: lumber },
  ];
  return form === 'stick' ? groups.slice(1) : groups;
}

export const REGION_LABELS: Record<StockRegion, string> = { us: 'US sizes', metric: 'Metric' };

/** The stock a new board of `form` starts with in `region`: 3/4" plywood or 18 mm, a 2x4 or 38 x 89. */
export function defaultStock(region: StockRegion, form: BoardParams['form']): string {
  if (form === 'panel') return region === 'us' ? 'us-ply-23-32' : 'mm-ply-18';
  return region === 'us' ? 'us-2x4' : 'mm-38x89';
}

// The document's stock data -----------------------------------------------------------------------

/** The document's `domains.stock`, read; an unreadable entry gives its message instead. */
export { documentStock } from '@manufakture/domain-wood';

/** The stock region a document's display units suggest (the picker opens on it). */
export function documentRegion(units: DisplayUnits): StockRegion {
  return defaultRegion(lengthFormat(units));
}
