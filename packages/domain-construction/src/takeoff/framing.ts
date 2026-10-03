// The framing producer: members as framed, plates, blocking and fascia as linear length, and the
// lumber to buy (ADR 0015 decision 10).
//
// As framed: one row per stock and blank length (`length` is the blank, what is cut from stock).
// To buy: studs, kings and corner studs whose length matches a precut stud of their stock (within
// 0.5 mm, as the wall generator snaps them) are precut studs; everything else of a lumber stock is
// laid out on the lengths sold by `@manufakture/nesting`'s 1D layout, with kerf. A plate, rim,
// ridge or fascia longer than every length sold is bought in pieces (flagged `spliced`: the wall
// and roof generators already splice at their own stock lengths, so this only happens when the
// takeoff's lengths stop shorter than the framing's); any other member that long is listed at
// its own length (`longer-than-stock`). Members cut from sheet stock (a header's plywood spacer)
// go to the sheet producer as parts.

import {
  findStock,
  resolveStock,
  STOCK,
  type StockData,
  type StockEntry,
} from '@manufakture/stock';
import { layoutSticks, type StickPart, type StickStock } from '@manufakture/nesting';
import { lengthKey, type TakeoffMeasure } from '@manufakture/takeoff';
import { memberFullId } from '../member-ids';
import type { Role } from '../members';
import { stickPrice, stockBoardFeet } from './cost';
import type { ConstructionFlag, ConstructionRow, LumberStockLayout, TakeoffMember } from './types';

/** A precut length matches within this, mm (the wall generator's tolerance). */
export const PRECUT_TOLERANCE = 0.5;
const EPS = 1e-6;

/** Roles bought as precut studs when their length matches one. */
export const PRECUT_ROLES: ReadonlySet<Role> = new Set<Role>(['stud', 'king', 'corner']);

/** Roles the takeoff may buy in pieces when they are longer than every length sold. */
export const SPLICE_ROLES: ReadonlySet<Role> = new Set<Role>([
  'bottom-plate',
  'top-plate',
  'rim',
  'ridge',
  'sub-fascia',
  'fascia',
]);

/** The linear-length rows, by group, and the roles each one totals. */
export const LINEAR_GROUPS: Readonly<Record<string, readonly Role[]>> = {
  Plates: ['bottom-plate', 'top-plate'],
  Blocking: ['blocking', 'backing'],
  Fascia: ['sub-fascia', 'fascia'],
};

/** How a role is named in a row's `item`. */
export const ROLE_LABELS: Readonly<Record<Role, string>> = {
  'bottom-plate': 'Bottom plate',
  'top-plate': 'Top plate',
  stud: 'Stud',
  king: 'King stud',
  jack: 'Jack stud',
  header: 'Header',
  'header-spacer': 'Header spacer',
  'rough-sill': 'Rough sill',
  cripple: 'Cripple',
  blocking: 'Blocking',
  corner: 'Corner stud',
  backing: 'Backing',
  joist: 'Joist',
  rim: 'Rim joist',
  skid: 'Skid',
  'common-rafter': 'Common rafter',
  'jack-rafter': 'Jack rafter',
  'hip-rafter': 'Hip rafter',
  'fly-rafter': 'Fly rafter',
  ridge: 'Ridge board',
  'ceiling-joist': 'Ceiling joist',
  'rafter-tie': 'Rafter tie',
  'gable-stud': 'Gable stud',
  'sub-fascia': 'Sub-fascia',
  fascia: 'Fascia',
};

export interface FramingContext {
  readonly stock: StockData;
  readonly precuts: boolean;
  readonly kerf: number;
  readonly trims: number;
  readonly lengths: Readonly<Record<string, readonly number[]>>;
}

export interface FramingResult {
  /** One row per member, as framed (merge them for display). */
  framed: ConstructionRow[];
  /** One row per plate, blocking or fascia member. */
  linear: ConstructionRow[];
  /** What to buy, one row per stock and length. */
  bought: ConstructionRow[];
  lumber: LumberStockLayout[];
  /** Members of a sheet stock, for the sheet producer. */
  sheetMembers: TakeoffMember[];
}

/** The precut stud entry of `stockId` sold at `length`, if the catalog has one. */
export function precutFor(stockId: string, length: number): StockEntry | undefined {
  return STOCK.find(
    (e) =>
      e.category === 'stud' &&
      e.id.startsWith(`${stockId}-precut-`) &&
      e.lengths !== undefined &&
      Math.abs(e.lengths[0]! - length) <= PRECUT_TOLERANCE,
  );
}

function lumberMeasures(
  entry: StockEntry,
  data: StockData,
  count: number,
  length: number,
): TakeoffMeasure[] {
  const out: TakeoffMeasure[] = [{ unit: 'length', value: count * length }];
  const bf = stockBoardFeet(entry, data, length);
  if (bf !== undefined) out.push({ unit: 'board-foot', value: count * bf });
  return out;
}

function framedRow(m: TakeoffMember, known: boolean): ConstructionRow {
  return {
    key: `framing|${m.stock.id}|${lengthKey(m.length)}`,
    item: ROLE_LABELS[m.role] ?? m.role,
    category: 'framing',
    stock: m.stock.id,
    size: { length: m.length, width: m.stock.depth, thickness: m.stock.width },
    quantity: 1,
    unit: 'each',
    extended: 1,
    measures: [{ unit: 'length', value: m.length }],
    sources: [{ id: memberFullId(m), quantity: 1 }],
    flags: known ? [] : ['stock-unknown'],
  };
}

function linearRow(m: TakeoffMember): ConstructionRow | undefined {
  const group = Object.keys(LINEAR_GROUPS).find((g) => LINEAR_GROUPS[g]!.includes(m.role));
  if (group === undefined) return undefined;
  return {
    key: `linear|${group}|${m.stock.id}`,
    item: group,
    category: 'linear',
    stock: m.stock.id,
    size: { width: m.stock.depth, thickness: m.stock.width },
    quantity: 1,
    unit: 'length',
    extended: m.length,
    measures: [],
    sources: [{ id: memberFullId(m), quantity: 1 }],
    flags: [],
  };
}

interface Bucket {
  entry: StockEntry;
  length: number;
  members: TakeoffMember[];
  flags: Set<ConstructionFlag>;
}

/** Rows for the framing members: as framed, linear, and bought through precuts and the 1D layout. */
export function framingTakeoff(
  members: readonly TakeoffMember[],
  ctx: FramingContext,
): FramingResult {
  const framed: ConstructionRow[] = [];
  const linear: ConstructionRow[] = [];
  const sheetMembers: TakeoffMember[] = [];
  const precut = new Map<string, Bucket>();
  const byStock = new Map<string, TakeoffMember[]>();
  for (const m of members) {
    const entry = findStock(m.stock.id);
    framed.push(framedRow(m, entry !== undefined));
    const lin = linearRow(m);
    if (lin) linear.push(lin);
    if (entry === undefined) continue;
    if (entry.kind === 'sheet') {
      sheetMembers.push(m);
      continue;
    }
    const pc =
      ctx.precuts && PRECUT_ROLES.has(m.role) ? precutFor(m.stock.id, m.length) : undefined;
    if (pc !== undefined) {
      let b = precut.get(pc.id);
      if (!b)
        precut.set(
          pc.id,
          (b = { entry: pc, length: pc.lengths![0]!, members: [], flags: new Set(['precut']) }),
        );
      b.members.push(m);
      continue;
    }
    const list = byStock.get(m.stock.id) ?? [];
    list.push(m);
    byStock.set(m.stock.id, list);
  }

  const bought: ConstructionRow[] = [];
  const lumber: LumberStockLayout[] = [];
  const toRow = (b: Bucket, keyId: string): ConstructionRow => {
    const r = resolveStock(b.entry.id, ctx.stock);
    const n = b.flags.has('precut') ? b.members.length : 0;
    return {
      key: `lumber|${keyId}`,
      item: b.entry.name,
      category: 'lumber',
      stock: b.entry.id,
      size: {
        length: b.length,
        ...(r?.width === undefined ? {} : { width: r.width }),
        thickness: r?.thickness ?? b.entry.actual.thickness,
      },
      quantity: n,
      unit: 'each',
      extended: n,
      measures: lumberMeasures(b.entry, ctx.stock, n, b.length),
      sources: b.members.map((m) => ({ id: memberFullId(m), quantity: 1 })),
      flags: [...b.flags].sort(),
    };
  };
  for (const [id, b] of precut) bought.push(toRow(b, id));

  for (const [stockId, list] of byStock) {
    const entry = findStock(stockId)!;
    const sold = [...(ctx.lengths[stockId] ?? entry.lengths ?? [])].filter((l) => l > 0);
    const rowsByLength = new Map<string, Bucket & { count: number }>();
    const add = (
      length: number,
      m: TakeoffMember | undefined,
      count: number,
      flags: ConstructionFlag[],
    ) => {
      const k = lengthKey(length);
      let b = rowsByLength.get(k);
      if (!b) rowsByLength.set(k, (b = { entry, length, members: [], flags: new Set(), count: 0 }));
      if (m && !b.members.includes(m)) b.members.push(m);
      b.count += count;
      for (const f of flags) b.flags.add(f);
    };
    if (sold.length === 0) {
      for (const m of list) add(m.length, m, 1, ['no-stock-lengths']);
    } else {
      const longest = Math.max(...sold);
      const usable = longest - 2 * ctx.trims;
      // Pieces for the 1D layout: one per member, or several for a spliced plate.
      const pieces: Array<{ length: number; member: TakeoffMember; spliced: boolean }> = [];
      for (const m of list) {
        if (m.length <= usable + EPS) {
          pieces.push({ length: m.length, member: m, spliced: false });
        } else if (SPLICE_ROLES.has(m.role) && usable > EPS) {
          let rest = m.length;
          while (rest > usable + EPS) {
            pieces.push({ length: usable, member: m, spliced: true });
            rest -= usable;
          }
          pieces.push({ length: rest, member: m, spliced: true });
        } else {
          add(m.length, m, 1, ['longer-than-stock']);
        }
      }
      // Parts grouped by length; copy k of a part is the k-th piece of that length.
      const groups = new Map<string, typeof pieces>();
      for (const p of pieces) {
        const k = lengthKey(p.length);
        const g = groups.get(k) ?? [];
        g.push(p);
        groups.set(k, g);
      }
      const parts: StickPart[] = [...groups].map(([k, g]) => ({
        id: k,
        length: g[0]!.length,
        quantity: g.length,
      }));
      const stock: StickStock[] = sold.map((length) => {
        const cost = stickPrice(entry, ctx.stock, length);
        return { id: lengthKey(length), length, ...(cost === undefined ? {} : { cost }) };
      });
      if (parts.length > 0) {
        const result = layoutSticks({
          parts,
          stock,
          settings: { kerf: ctx.kerf, trims: ctx.trims },
        });
        lumber.push({ stock: stockId, lengths: sold, result });
        for (const stick of result.sticks) {
          const members = stick.cuts.map((c) => groups.get(c.partId)![c.copy - 1]!);
          add(stick.length, undefined, 1, members.some((p) => p.spliced) ? ['spliced'] : []);
          const b = rowsByLength.get(lengthKey(stick.length))!;
          for (const p of members) if (!b.members.includes(p.member)) b.members.push(p.member);
        }
        for (const u of result.unplaced) {
          for (const p of groups.get(u.partId)!.slice(-u.quantity)) {
            add(p.length, p.member, 1, ['longer-than-stock']);
          }
        }
      }
    }
    const buckets = [...rowsByLength.values()].sort((a, b) => b.length - a.length);
    for (const b of buckets) {
      const row = toRow(b, `${stockId}|${lengthKey(b.length)}`);
      row.quantity = b.count;
      row.extended = b.count;
      row.measures = lumberMeasures(entry, ctx.stock, b.count, b.length);
      bought.push(row);
    }
  }
  return { framed, linear, bought, lumber, sheetMembers };
}
