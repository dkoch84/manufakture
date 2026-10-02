// Packing the copies onto the plate: rows from the front left, clear of the X1 Carbon's excluded
// corner (and the gap clear of it), the gap between copies, overflow past one plate, and the
// block moved to the middle.

import { describe, expect, it } from 'vitest';
import { checkBedFit, findPrinter, type Printer } from '@manufakture/print';
import { packPlate, type PlateCopy } from './plate';
import { COPY_GAP } from './resolve';

const x1c = findPrinter('bambu-x1c')!;
const a1mini = findPrinter('bambu-a1-mini')!;

const squares = (n: number, size: number): PlateCopy[] =>
  Array.from({ length: n }, () => ({ width: size, depth: size }));

/** Every placed copy fits the bed alone, the gap clear of the excluded areas, and no two come
 * closer than the gap. */
function expectSane(
  printer: Printer,
  copies: readonly PlateCopy[],
  spots: ([number, number] | null)[],
) {
  const boxes = spots.flatMap((s, i) =>
    s ? [{ min: [s[0], s[1]], max: [s[0] + copies[i]!.width, s[1] + copies[i]!.depth] }] : [],
  );
  for (const b of boxes) {
    const fit = checkBedFit(printer, {
      box: { min: [b.min[0]!, b.min[1]!, 0], max: [b.max[0]!, b.max[1]!, 1] },
    });
    expect(fit.fits).toBe(true);
    const grown = checkBedFit(printer, {
      box: {
        min: [b.min[0]! - COPY_GAP, b.min[1]! - COPY_GAP, 0],
        max: [b.max[0]! + COPY_GAP, b.max[1]! + COPY_GAP, 1],
      },
    });
    expect(grown.exclusions).toEqual([]);
  }
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]!;
      const b = boxes[j]!;
      const apartX = Math.max(b.min[0]! - a.max[0]!, a.min[0]! - b.max[0]!);
      const apartY = Math.max(b.min[1]! - a.max[1]!, a.min[1]! - b.max[1]!);
      expect(Math.max(apartX, apartY)).toBeGreaterThanOrEqual(COPY_GAP - 1e-9);
    }
  }
}

describe('packPlate', () => {
  it('puts one copy in the middle of the bed', () => {
    const r = packPlate(x1c, [{ width: 10, depth: 20 }]);
    expect(r.overflow).toBe(0);
    expect(r.spots).toEqual([[123, 118]]);
  });

  it('packs rows clear of the excluded corner, then centres the block', () => {
    const copies = squares(25, 40);
    const r = packPlate(x1c, copies);
    expect(r.overflow).toBe(0);
    expectSane(x1c, copies, r.spots);
    // Five rows of five. The first row starts the gap past the corner's right edge (x 23), the
    // others at x 0; the block (0 to 243 by 0 to 220) is then moved to the middle: 6.5 right,
    // 18 back.
    expect(r.spots[0]).toEqual([29.5, 18]);
    expect(r.spots[5]).toEqual([6.5, 63]);
    expect(r.spots[24]).toEqual([6.5 + 4 * 45, 18 + 4 * 45]);
  });

  it('reports the copies that need a second plate', () => {
    const r = packPlate(x1c, squares(30, 40));
    expect(r.overflow).toBe(5);
    expect(r.spots.slice(25)).toEqual([null, null, null, null, null]);
    expect(r.spots.slice(0, 25).every((s) => s !== null)).toBe(true);
  });

  it('finds the spot behind the corner for a part as wide as the bed', () => {
    // 250 wide: in front it would overlap the corner (0 to 18 by 0 to 28), so it goes behind it.
    const copies = [{ width: 250, depth: 200 }];
    const r = packPlate(x1c, copies);
    expect(r.overflow).toBe(0);
    expectSane(x1c, copies, r.spots);
    expect(r.spots[0]![1]).toBeGreaterThanOrEqual(28 + COPY_GAP);
  });

  it('keeps the gap clear of the excluded corner, not just off it', () => {
    // 238 wide: right of the corner's edge (x 18) it would fit, but not 5 mm clear of it, so it
    // goes behind the corner instead, 5 mm clear of its back edge (y 28).
    const copies = [{ width: 238, depth: 220 }];
    const r = packPlate(x1c, copies);
    expect(r.overflow).toBe(0);
    expectSane(x1c, copies, r.spots);
    expect(r.spots[0]![1]).toBeGreaterThanOrEqual(28 + COPY_GAP);
    expect(r.nearExcluded).toEqual([]);
  });

  it('packs with no clearance from the excluded corner when the clearance leaves a copy off', () => {
    // Each fits the bed alone (itemBedFit) but not 5 mm clear of the corner (0 to 18 by 0 to
    // 28): too deep to go behind it with the gap and too wide to keep the gap beside it.
    for (const [width, depth] of [
      [236, 226],
      [236, 240],
      [240, 226],
      [256, 228],
      [234, 256],
      [238, 240],
    ] as const) {
      const copies = [{ width, depth }];
      const r = packPlate(x1c, copies);
      expect(r.overflow, `${width} x ${depth}`).toBe(0);
      expect(r.nearExcluded, `${width} x ${depth}`).toEqual([0]);
      const [x, y] = r.spots[0]!;
      const fit = checkBedFit(x1c, { box: { min: [x, y, 0], max: [x + width, y + depth, 1] } });
      expect(fit.fits, `${width} x ${depth}`).toBe(true);
    }
    // Still 5 mm apart from each other: two 115 x 226 copies beside the corner.
    const two = [
      { width: 115, depth: 226 },
      { width: 115, depth: 226 },
    ];
    const r = packPlate(x1c, two);
    expect(r.overflow).toBe(0);
    expect(r.spots[1]![0] - (r.spots[0]![0] + 115)).toBeGreaterThanOrEqual(COPY_GAP - 1e-9);
  });

  it('keeps the clearance when it costs nothing, even with copies left over', () => {
    // 30 squares of 40: 25 fit either way, so the plate stays 5 mm clear of the corner.
    const copies = squares(30, 40);
    const r = packPlate(x1c, copies);
    expect(r.overflow).toBe(5);
    expect(r.nearExcluded).toEqual([]);
    expectSane(x1c, copies, r.spots);
  });

  it('finds the spot beside the corner for a part as deep as the bed', () => {
    const copies = [{ width: 230, depth: 256 }];
    const r = packPlate(x1c, copies);
    expect(r.overflow).toBe(0);
    expect(r.spots[0]![0]).toBeGreaterThanOrEqual(18 + COPY_GAP);
    expectSane(x1c, copies, r.spots);
  });

  it('places nothing that does not fit at all', () => {
    const r = packPlate(a1mini, [
      { width: 200, depth: 20 },
      { width: 20, depth: 20 },
    ]);
    expect(r.spots[0]).toBeNull();
    expect(r.spots[1]).not.toBeNull();
    expect(r.overflow).toBe(1);
  });

  it('mixes sizes in rows as deep as their deepest copy', () => {
    const copies: PlateCopy[] = [
      { width: 100, depth: 50 },
      { width: 100, depth: 20 },
      { width: 100, depth: 30 },
      { width: 100, depth: 30 },
    ];
    const r = packPlate(a1mini, copies);
    expect(r.overflow).toBe(0);
    expectSane(a1mini, copies, r.spots);
    // A1 mini, 180 wide: one copy per row; rows at 0, 55, 80, 115 before centring (145 deep).
    const ys = r.spots.map((s) => s![1]);
    expect(ys.map((y) => y - ys[0]!)).toEqual([0, 55, 80, 115]);
  });
});
