// Hand-computed fixtures, shared by this package's tests and by the cut list and bookshelf
// acceptance tests (T4.3d, T4.6). All sizes are in inches; the packers are unit-agnostic.
// Each fixture states the hand calculation its expected numbers come from.

import type { SheetInput, SheetPart, SheetStock } from './sheet';
import type { StickInput } from './stick';

/** A 4' x 8' sheet of 3/4" (23/32" actual) plywood, face grain along the 96" length. */
export const PLYWOOD_4X8: SheetStock = { id: 'ply-4x8', length: 96, width: 48, grain: 'length' };

/** A 4' x 8' sheet of MDF: no grain. */
export const MDF_4X8: SheetStock = { id: 'mdf-4x8', length: 96, width: 48, grain: 'none' };

export const KERF_1_8 = 1 / 8;

/**
 * The plan's fixture: four 24" x 48" parts on a 48" x 96" sheet.
 *
 * - No kerf: two 48" lengths fill 96 exactly and two 24" widths fill 48 exactly, so all four
 *   fit one sheet: 1 sheet, utilisation 4 x 24 x 48 / (48 x 96) = 4608 / 4608 = 100%.
 * - 1/8" kerf: across the width 24 + 1/8 + 24 = 48 1/8 > 48, so only one 24" width fits
 *   across; along the length 48 + 1/8 + 48 = 96 1/8 > 96, so only one 48" length fits along.
 *   Turned (48" across the width, 24" along the length): 24 + 1/8 + 24 + 1/8 + 24 = 72 1/4
 *   <= 96, a fourth would need 96 3/8 > 96. So three fit a sheet and the fourth needs a second:
 *   2 sheets, utilisation 4608 / 9216 = 50%.
 */
export function fourPanels(kerf: number): SheetInput {
  return {
    parts: [{ id: 'panel', length: 48, width: 24, quantity: 4, grainLocked: false }],
    stock: [MDF_4X8],
    settings: { kerf },
  };
}

/**
 * Bookshelf A: a 30" wide, 72" tall, 11 1/4" deep carcass in 3/4" plywood. Grain runs along
 * every part's length (vertical on the sides, horizontal on the shelves), so all parts are
 * grain-locked. Top, bottom and three shelves are 29" long (between the sides, in 1/4" dados).
 *
 * Hand calculation, 48" x 96" sheet, 1/8" kerf, no trims:
 * - Every part is 11 1/4" wide, so the sheet is ripped into 11 1/4" strips: four strips take
 *   4 x 11.25 + 3 x 0.125 = 45.375 <= 48 (a fifth would need 56.75).
 * - A side (72") per strip: 72 + 0.125 + 29 = 101.125 > 96, so nothing else fits beside it.
 *   Two strips hold the two sides.
 * - Shelves (29") per strip: 3 x 29 + 2 x 0.125 = 87.25 <= 96 (four need 116.375). The
 *   third strip holds three, the fourth the remaining two.
 * - So all 7 parts fit one sheet, in a two-stage layout (rip strips, crosscut them).
 * - Parts area: 2 x 11.25 x 72 + 5 x 11.25 x 29 = 1620 + 1631.25 = 3251.25 square inches;
 *   utilisation 3251.25 / 4608 = 70.556%.
 */
export function bookshelfA(kerf = KERF_1_8): SheetInput {
  const parts: SheetPart[] = [
    { id: 'side', length: 72, width: 11.25, quantity: 2, grainLocked: true },
    { id: 'top-bottom', length: 29, width: 11.25, quantity: 2, grainLocked: true },
    { id: 'shelf', length: 29, width: 11.25, quantity: 3, grainLocked: true },
  ];
  return { parts, stock: [PLYWOOD_4X8], settings: { kerf, maxStages: 2 } };
}

export const BOOKSHELF_A_PARTS_AREA = 2 * 11.25 * 72 + 5 * 11.25 * 29;

/**
 * Bookshelf B: 36" wide, 72" tall, 12" deep, grain-locked plywood; two sides 12" x 72" and
 * four horizontal panels (top, bottom, two shelves) 12" x 34 1/2". The kerf decides the sheet
 * count.
 *
 * - No kerf: four 12" strips fill the 48" width exactly. Two strips hold one side each (72 +
 *   34.5 = 106.5 > 96, nothing else fits beside a side); each of the other two holds two
 *   panels (34.5 + 34.5 = 69 <= 96). 1 sheet. Parts area 2 x 12 x 72 + 4 x 12 x 34.5 =
 *   1728 + 1656 = 3384; utilisation 3384 / 4608 = 73.4375%.
 * - 1/8" kerf: four strips need 4 x 12 + 3 x 0.125 = 48.375 > 48, so a sheet holds three
 *   strips (36.25), and the 11.625" left is too narrow for a 12" part. The parts still need
 *   four strips (two sides, two strips of two panels: 34.5 + 0.125 + 34.5 = 69.125 <= 96), so
 *   2 sheets; utilisation 3384 / 9216 = 36.719%.
 */
export function bookshelfB(kerf: number): SheetInput {
  return {
    parts: [
      { id: 'side', length: 72, width: 12, quantity: 2, grainLocked: true },
      { id: 'panel', length: 34.5, width: 12, quantity: 4, grainLocked: true },
    ],
    stock: [PLYWOOD_4X8],
    settings: { kerf },
  };
}

export const BOOKSHELF_B_PARTS_AREA = 2 * 12 * 72 + 4 * 12 * 34.5;

/**
 * A 1x2 face frame for bookshelf A: two 72" stiles and three 27" rails (30" minus two 1 1/2"
 * stiles), from 8' (96") sticks with a 1/8" kerf.
 *
 * - A stile and a rail: 72 + 0.125 + 27 = 99.125 > 96, so each stile takes a stick of its
 *   own, leaving 96 - 72 - 0.125 = 23.875 (too short for a rail).
 * - Three rails: 3 x 27 + 2 x 0.125 = 81.25 <= 96: one stick, leaving 96 - 81.25 - 0.125 =
 *   14.625.
 * - 3 sticks, 288"; parts 2 x 72 + 3 x 27 = 225"; utilisation 225 / 288 = 78.125%.
 */
export const FACE_FRAME: StickInput = {
  parts: [
    { id: 'stile', length: 72, quantity: 2 },
    { id: 'rail', length: 27, quantity: 3 },
  ],
  stock: [{ id: '1x2x8', length: 96 }],
  settings: { kerf: KERF_1_8 },
};

/**
 * Three 32" pieces from a 96" stick: with no kerf 3 x 32 = 96 fits one stick; with a 1/8" kerf
 * 3 x 32 + 2 x 0.125 = 96.25 > 96, so two sticks (two pieces, then one).
 */
export function threeThirds(kerf: number): StickInput {
  return {
    parts: [{ id: 'piece', length: 32, quantity: 3 }],
    stock: [{ id: '8ft', length: 96 }],
    settings: { kerf },
  };
}
