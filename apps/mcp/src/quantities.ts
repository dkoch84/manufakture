// The `get_quantities` tool's options (follow-up 5 of docs/m8-acceptance/remodel-frame.md): the
// whole answer for a shed is about 80,000 characters, over what an agent's client takes in one
// tool result. The options narrow it in three independent ways, and `compare` turns it into the
// review bundle's quantity delta (`quantityDeltas`), base against head:
//
// - what is counted (`owner`, `phase`): a scope the session applies before the takeoff is made,
//   so a feature's (or a phase's: the new material, the demolition list, #1213) purchase rows and
//   layouts are its own, not cut out of the whole frame's.
// - which lists and rows are shown (`lists`, `categories`): a cut of what was counted.
// - how much of each row is shown (`detail: false`): no source lists and no layouts.
//
// No option: the session's quantities as they are.

import type { Quantities, QuantityScope } from '@manufakture/session';
import { CONSTRUCTION_CATEGORIES, type Phase } from '@manufakture/domain-construction';

/** The lists of the answer, by their field names. */
export const QUANTITY_LISTS = ['cutList', 'hardware', 'takeoffs'] as const;
export type QuantityList = (typeof QUANTITY_LISTS)[number];

/**
 * Every row category: the cut list's (`packages/domain-wood/src/cutlist/cutlist.ts`: sheet,
 * lumber, part, hardware) and the construction takeoff's (`CONSTRUCTION_CATEGORIES`). Sheet and
 * lumber are in both.
 */
export const QUANTITY_CATEGORIES = [
  ...new Set(['sheet', 'lumber', 'part', 'hardware', ...CONSTRUCTION_CATEGORIES]),
] as [string, ...string[]];

export interface QuantityOptions {
  lists?: readonly QuantityList[] | undefined;
  categories?: readonly string[] | undefined;
  owner?: string | readonly string[] | undefined;
  phase?: Phase | undefined;
  detail?: boolean | undefined;
  compare?: boolean | undefined;
}

/** The session scope the options ask for. */
export function scopeOf(o: QuantityOptions): QuantityScope {
  return {
    ...(o.owner === undefined
      ? {}
      : { owners: [...new Set(typeof o.owner === 'string' ? [o.owner] : o.owner)] }),
    ...(o.phase === undefined ? {} : { phase: o.phase }),
  };
}

/** Whether the options count only construction takeoffs (an owner or a phase). */
const takeoffsOnly = (o: QuantityOptions): boolean =>
  o.owner !== undefined || o.phase !== undefined;

/** The owners named, once each. */
export const ownersOf = (o: QuantityOptions): readonly string[] => scopeOf(o).owners ?? [];

/** Whether any option that changes the answer's shape was given. */
export const narrows = (o: QuantityOptions): boolean =>
  o.lists !== undefined || o.categories !== undefined || o.detail === false;

/** Why these options do not go together, or null when they do. */
export function optionProblem(o: QuantityOptions): string | null {
  if (takeoffsOnly(o) && o.lists !== undefined && o.lists.some((l) => l !== 'takeoffs')) {
    const what = o.owner !== undefined ? 'owner' : 'phase';
    return `With ${what} only the construction takeoffs are counted: lists may name only takeoffs.`;
  }
  return null;
}

interface Row {
  key: string;
  category: string;
  stock?: string;
  sources: unknown[];
}

const lists = (o: QuantityOptions): Set<QuantityList> =>
  new Set(o.lists ?? (takeoffsOnly(o) ? ['takeoffs'] : QUANTITY_LISTS));

/**
 * `q` with only the lists and categories asked for, in the session's shape (what
 * `quantityDeltas` compares). A list not asked for is empty; a total is kept when its group is a
 * category asked for. With categories, a takeoff's cost is the sum of the rows kept, its
 * subtotals (per level and feature, over several categories) are left out, and so are the
 * layouts no category kept is bought from.
 */
export function narrowed(q: Quantities, o: QuantityOptions): Quantities {
  const shown = lists(o);
  const cats = o.categories === undefined ? null : new Set(o.categories);
  const keep = (category: string) => cats === null || cats.has(category);
  const rows = <R extends { category: string }>(list: readonly R[]) =>
    list.filter((r) => keep(r.category));

  let cutList: Quantities['cutList'] = null;
  if (q.cutList !== null) {
    const c = q.cutList;
    const board = shown.has('cutList');
    const hardware = shown.has('hardware') ? rows(c.hardware) : [];
    const kept = board ? rows(c.rows) : [];
    const stocks = new Set(kept.map((r) => r.stock));
    cutList = {
      ...c,
      rows: kept,
      hardware,
      totals: c.totals.filter(
        (t) => keep(t.group) && (t.group === 'hardware' ? shown.has('hardware') : board),
      ),
      stockTotals: board ? c.stockTotals.filter((t) => stocks.has(t.group)) : [],
      sheets: board && keep('sheet') ? c.sheets : [],
      lumber: board && keep('lumber') ? c.lumber : [],
      excluded: board ? c.excluded : [],
      missing: board ? c.missing : [],
    };
  }

  const takeoffs = shown.has('takeoffs')
    ? q.takeoffs.map((t) => {
        if (cats === null) return t;
        const x = t.takeoff;
        const kept = rows(x.rows);
        const keys = new Set(kept.map((r) => r.key));
        return {
          ...t,
          takeoff: {
            ...x,
            rows: kept,
            totals: x.totals.filter((v) => keep(v.group)),
            cost: {
              ...x.cost,
              total: kept.reduce((sum, r) => sum + (r.cost ?? 0), 0),
              unpriced: x.cost.unpriced.filter((k) => keys.has(k)),
            },
            subtotals: [],
            faces: keep('faces') || keep('sheet') ? x.faces : [],
            sheets: keep('sheet') ? x.sheets : [],
            lumber: keep('lumber') ? x.lumber : [],
          },
        };
      })
    : [];

  return { ...q, cutList, hardware: cutList?.hardware ?? [], takeoffs };
}

/** `o` without the fields `keys`. */
function omit<T extends object, K extends keyof T>(o: T, keys: readonly K[]): Omit<T, K> {
  const out = { ...o };
  for (const k of keys) delete out[k];
  return out;
}

const bare = <R extends Row>(r: R): Omit<R, 'sources'> => omit(r, ['sources']);

/**
 * The answer for the options: only the lists asked for (fields left out, not emptied), and with
 * `detail: false` no row's `sources` and no layouts (a cut list's `sheets` and `lumber` part
 * lists, a takeoff's `faces`, `sheets` and `lumber`). No option: `q` itself.
 */
export function quantityView(q: Quantities, o: QuantityOptions): Record<string, unknown> {
  if (!narrows(o) && !takeoffsOnly(o)) return { ...q };
  const n = narrowed(q, o);
  const shown = lists(o);
  const detail = o.detail !== false;
  const out: Record<string, unknown> = { reviewed: q.reviewed };
  if (shown.has('cutList')) {
    if (n.cutList === null || detail) {
      out.cutList = n.cutList;
    } else {
      const c = omit(n.cutList, ['sheets', 'lumber']);
      out.cutList = { ...c, rows: c.rows.map(bare), hardware: c.hardware.map(bare) };
    }
  }
  if (shown.has('hardware')) out.hardware = detail ? n.hardware : n.hardware.map(bare);
  if (shown.has('takeoffs')) {
    out.takeoffs = detail
      ? n.takeoffs
      : n.takeoffs.map((t) => {
          const x = omit(t.takeoff, ['faces', 'sheets', 'lumber']);
          return { ...t, takeoff: { ...x, rows: x.rows.map(bare) } };
        });
  }
  out.notes = n.notes;
  if (q.phased === true) out.phased = true;
  return out;
}
