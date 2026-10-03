// The construction takeoff (M6 plan T6.3a, ADR 0015 decision 10): the framing and sheet
// producers' rows on `@manufakture/takeoff`'s model, merged, priced and totalled.
//
// As framed only: every row counts what the generators framed and the faces laid, then what to
// buy for exactly that. There is no estimating row (no "one stud per foot of wall"), by the
// project owner's decision. Hardware is not counted. manufakture is not an engineering tool: the
// takeoff counts what the user's framing rules produced and says nothing about whether they suit
// a building.

import { EMPTY_STOCK_DATA } from '@manufakture/stock';
import { compareIds, mergeRows, totals, type TakeoffRow } from '@manufakture/takeoff';
import { MM_PER_INCH } from '@manufakture/units';
import { DISCLAIMER_SHORT } from '../disclaimer';
import { memberFullId } from '../member-ids';
import { priceRows } from './cost';
import { framingTakeoff } from './framing';
import { sheetTakeoff } from './sheets';
import {
  CONSTRUCTION_CATEGORIES,
  type ConstructionRow,
  type ConstructionTakeoff,
  type ConstructionTakeoffInput,
  type TakeoffSubtotal,
} from './types';

/** Settings with their defaults filled in. */
export const DEFAULT_TAKEOFF_SETTINGS = {
  precuts: true,
  kerf: MM_PER_INCH / 8,
  trims: 0,
  wastePercent: 0,
  minOffcut: { length: 12 * MM_PER_INCH, width: 3 * MM_PER_INCH },
} as const;

function sortRows(rows: ConstructionRow[]): ConstructionRow[] {
  const cat = (r: ConstructionRow) => CONSTRUCTION_CATEGORIES.indexOf(r.category);
  return rows.sort(
    (a, b) =>
      cat(a) - cat(b) ||
      compareIds(a.stock ?? '', b.stock ?? '') ||
      (b.size?.length ?? 0) - (a.size?.length ?? 0) ||
      compareIds(a.key, b.key),
  );
}

/** The takeoff of framed members and sheet faces: rows, totals, cost and subtotals. */
export function constructionTakeoff(input: ConstructionTakeoffInput): ConstructionTakeoff {
  const s = input.settings ?? {};
  const stock = input.stock ?? EMPTY_STOCK_DATA;
  const kerf = s.kerf ?? DEFAULT_TAKEOFF_SETTINGS.kerf;
  const wastePercent = s.wastePercent ?? DEFAULT_TAKEOFF_SETTINGS.wastePercent;
  if (!(kerf >= 0)) throw new RangeError('the kerf cannot be negative');
  if (!(wastePercent >= 0)) throw new RangeError('the waste percentage cannot be negative');

  const framing = framingTakeoff(input.members, {
    stock,
    precuts: s.precuts ?? DEFAULT_TAKEOFF_SETTINGS.precuts,
    kerf,
    trims: s.trims ?? DEFAULT_TAKEOFF_SETTINGS.trims,
    lengths: s.lengths ?? {},
  });
  const sheet = sheetTakeoff(input.faces ?? [], framing.sheetMembers, {
    stock,
    kerf,
    wastePercent,
    minOffcut: s.minOffcut ?? DEFAULT_TAKEOFF_SETTINGS.minOffcut,
  });

  // Subtotals of what was framed and laid, per feature and per level, before merging.
  const owner = new Map<TakeoffRow, string>();
  const ownerOfSource = new Map<string, string>();
  for (const m of input.members) ownerOfSource.set(memberFullId(m), m.owner);
  for (const f of input.faces ?? []) ownerOfSource.set(f.id, f.owner);
  const asBuilt = [...framing.framed, ...framing.linear, ...sheet.laid];
  for (const r of asBuilt) owner.set(r, ownerOfSource.get(r.sources[0]!.id) ?? '');
  const subtotals: TakeoffSubtotal[] = [];
  const features = [...new Set(owner.values())].sort(compareIds);
  for (const id of features) {
    subtotals.push({
      kind: 'feature',
      id,
      totals: totals(asBuilt.filter((r) => owner.get(r) === id)),
    });
  }
  if (input.levels !== undefined) {
    const levelOf = (r: TakeoffRow) => input.levels![owner.get(r) ?? ''] ?? '';
    const levels = [...new Set(asBuilt.map(levelOf))].sort(compareIds);
    for (const id of levels) {
      subtotals.push({
        kind: 'level',
        id,
        totals: totals(asBuilt.filter((r) => levelOf(r) === id)),
      });
    }
  }

  const rows = sortRows(
    mergeRows([...asBuilt, ...framing.bought, ...sheet.bought]) as ConstructionRow[],
  );
  const cost = priceRows(rows, stock, s.currency);
  return {
    rows,
    totals: totals(rows, (r) => r.category),
    cost,
    subtotals,
    faces: sheet.faces,
    sheets: sheet.sheets,
    lumber: framing.lumber,
    disclaimer: DISCLAIMER_SHORT,
  };
}
