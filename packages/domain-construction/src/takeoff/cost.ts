// Cost: a bought row's quantity times its stock's price from the document's stock overrides
// (`domains.stock`). A price is per piece, sheet, board foot, metre or foot:
//
// - lumber (sticks and precut studs): per piece is per stick of any length; per foot and per
//   metre on the row's total length; per board foot on its board feet (the stock's basis);
// - sheets: per sheet or per piece is per sheet.
//
// A price per a unit that does not fit the stock (per sheet on lumber, per foot on sheets) is
// flagged `price-unit` and left out; so is a row with no price (`no-price`) and one whose price
// states a currency other than the takeoff's (`other-currency`). A price that states no currency
// is taken to be in the takeoff's.

import {
  findStock,
  resolveStock,
  type Price,
  type StockData,
  type StockEntry,
} from '@manufakture/stock';
import { MM_PER_INCH } from '@manufakture/units';
import { boardFeet } from '@manufakture/takeoff';
import type { ConstructionRow, CostSummary } from './types';

const MM_PER_FOOT = 12 * MM_PER_INCH;

/** Board feet of `length` of a stock, on its basis; undefined for sheet goods. */
export function stockBoardFeet(
  entry: StockEntry,
  data: StockData,
  length: number,
): number | undefined {
  if (entry.boardFeetBasis === 'none') return undefined;
  if (entry.boardFeetBasis === 'nominal') {
    return boardFeet(entry.nominal.thickness, entry.nominal.width ?? 0, length);
  }
  const width = resolveStock(entry.id, data)?.width ?? entry.actual.width ?? 0;
  return boardFeet(entry.nominal.thickness, width, length);
}

/** One unit of `entry` (a stick of `length`, or a sheet) at `price`; undefined when the unit does not fit. */
export function unitCost(
  entry: StockEntry,
  data: StockData,
  price: Price,
  length: number,
): number | undefined {
  if (entry.kind === 'sheet') {
    return price.per === 'sheet' || price.per === 'piece' ? price.amount : undefined;
  }
  switch (price.per) {
    case 'piece':
      return price.amount;
    case 'foot':
      return (length / MM_PER_FOOT) * price.amount;
    case 'metre':
      return (length / 1000) * price.amount;
    case 'board-foot': {
      const bf = stockBoardFeet(entry, data, length);
      return bf === undefined ? undefined : bf * price.amount;
    }
    case 'sheet':
      return undefined;
  }
}

/** The price of one stick of `length`, for ranking 1D layouts; undefined when not priced. */
export function stickPrice(entry: StockEntry, data: StockData, length: number): number | undefined {
  const price = resolveStock(entry.id, data)?.price;
  return price === undefined ? undefined : unitCost(entry, data, price, length);
}

/**
 * Prices the bought rows (`lumber`, `sheet`) in place and sums them. The currency is
 * `currency`, or else the first stated currency among the priced rows.
 */
export function priceRows(
  rows: ConstructionRow[],
  data: StockData,
  currency: string | undefined,
): CostSummary {
  const bought = rows.filter((r) => r.category === 'lumber' || r.category === 'sheet');
  let cur = currency;
  if (cur === undefined) {
    for (const r of bought) {
      const c = r.stock === undefined ? undefined : resolveStock(r.stock, data)?.price?.currency;
      if (c !== undefined) {
        cur = c;
        break;
      }
    }
  }
  let total = 0;
  const unpriced: string[] = [];
  const flag = (r: ConstructionRow, f: string) => {
    if (!r.flags.includes(f)) r.flags = [...r.flags, f].sort();
    unpriced.push(r.key);
  };
  for (const r of bought) {
    const entry = r.stock === undefined ? undefined : findStock(r.stock);
    const price = r.stock === undefined ? undefined : resolveStock(r.stock, data)?.price;
    if (entry === undefined || price === undefined) {
      flag(r, 'no-price');
      continue;
    }
    r.price = { ...price };
    if (price.currency !== undefined && cur !== undefined && price.currency !== cur) {
      flag(r, 'other-currency');
      continue;
    }
    const each = unitCost(entry, data, price, r.size?.length ?? 0);
    if (each === undefined) {
      flag(r, 'price-unit');
      continue;
    }
    r.cost = each * r.quantity;
    total += r.cost;
  }
  return { ...(cur === undefined ? {} : { currency: cur }), total, unpriced };
}
