// Board feet of a blank by its stock's basis (`StockEntry.boardFeetBasis`, M4 plan T4.3a):
//
// - `nominal` (surfaced softwood, the PS 20 convention): nominal thickness by nominal width by the
//   blank's length. A 2x4 eight feet long is 2 x 4 x 96 / 144 = 5.33 board feet, although it is
//   1-1/2" x 3-1/2". The nominal width applies only to a blank as wide as the stock (its actual
//   width, with the document's override); a blank ripped narrower, or a panel glued up from the
//   stock, is counted on its own width (`width: 'actual'`).
// - `rough` (hardwood, sold rough in quarters): the rough thickness (4/4 is 1") by the blank's
//   actual width and length.
// - `none` (sheet goods): no board feet; sheets are counted by area.

import { boardFeet } from '@manufakture/takeoff';
import type { StockEntry } from '../catalog';

/** How far a blank's width may be from the stock's and still count as full width, mm. */
const FULL_WIDTH_TOLERANCE = 1e-6;

export interface BlankBoardFeet {
  /** Board feet of one blank. */
  value: number;
  /** Which width it was counted on. */
  width: 'nominal' | 'actual';
}

/**
 * Board feet of one blank (`length`, `width`, `thickness` in mm) cut from `entry`, whose actual
 * width with the document's override is `stockWidth`; undefined for sheet goods.
 */
export function blankBoardFeet(
  entry: StockEntry,
  blank: { length: number; width: number },
  stockWidth: number | undefined,
): BlankBoardFeet | undefined {
  switch (entry.boardFeetBasis) {
    case 'none':
      return undefined;
    case 'rough':
      return {
        value: boardFeet(entry.nominal.thickness, blank.width, blank.length),
        width: 'actual',
      };
    case 'nominal': {
      const nominal = entry.nominal.width;
      const full =
        nominal !== undefined &&
        stockWidth !== undefined &&
        Math.abs(blank.width - stockWidth) <= FULL_WIDTH_TOLERANCE;
      return full
        ? { value: boardFeet(entry.nominal.thickness, nominal, blank.length), width: 'nominal' }
        : {
            value: boardFeet(entry.nominal.thickness, blank.width, blank.length),
            width: 'actual',
          };
    }
  }
}
