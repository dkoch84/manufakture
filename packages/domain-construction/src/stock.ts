// Construction stock through the shared catalog (ADR 0015 decision 1). Construction data names
// catalog ids; the generators take a `StockRef` (id, name, dressed sizes). `stockRef` turns an id
// into one, with the document's stock overrides (`domains.stock`) applied, so a measured 2x4 of
// 3-9/16" frames as 3-9/16". Prices also come from the overrides (`resolveStock`), not from here.
//
// The construction entries themselves (precut studs, 7/16" OSB, gypsum board) live in the
// catalog, with their sources and `verified` flags.

import {
  EMPTY_STOCK_DATA,
  findStock,
  resolveStock,
  type StockData,
  type StockKind,
} from '@manufakture/stock';
import type { StockRef } from './members';

/** The catalog's precut studs (ADR 0015 decision 7: the takeoff matches studs to them by length). */
export const PRECUT_STUD_IDS = [
  'us-2x4-precut-92-5-8',
  'us-2x4-precut-104-5-8',
  'us-2x6-precut-92-5-8',
  'us-2x6-precut-104-5-8',
] as const;

/** Catalog ids the construction defaults and tests name. Ids are permanent. */
export const CONSTRUCTION_STOCK = {
  osbSheathing: 'us-osb-7-16',
  drywallHalf: 'us-gyp-1-2-8ft',
  drywallHalf12: 'us-gyp-1-2-12ft',
  drywallFiveEighths: 'us-gyp-5-8-8ft',
  drywallFiveEighths12: 'us-gyp-5-8-12ft',
} as const;

/**
 * The generator's view of a catalog stock: `width` is the thickness (the thin face) and `depth`
 * the width of lumber, or of a sheet its sheet width. Undefined for an id the catalog lacks.
 */
export function stockRef(id: string, data: StockData = EMPTY_STOCK_DATA): StockRef | undefined {
  const r = resolveStock(id, data);
  if (r === undefined) return undefined;
  return {
    id,
    name: r.entry.name,
    width: r.thickness,
    depth: r.width ?? r.sheet?.width ?? 0,
  };
}

/** A stock's actual thickness with the document's override, mm; undefined for an unknown id. */
export function stockThickness(id: string, data: StockData = EMPTY_STOCK_DATA): number | undefined {
  return resolveStock(id, data)?.thickness;
}

/**
 * A lumber stock's actual width with the document's override, mm (3-1/2" for a 2x4); undefined
 * for an unknown id or stock without a fixed width.
 */
export function stockWidth(id: string, data: StockData = EMPTY_STOCK_DATA): number | undefined {
  return resolveStock(id, data)?.width;
}

/** The catalog kind of a stock id, or undefined when this build's catalog does not have it. */
export function stockKind(id: string): StockKind | undefined {
  return findStock(id)?.kind;
}
