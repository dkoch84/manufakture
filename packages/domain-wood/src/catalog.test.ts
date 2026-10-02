import { findMaterial } from '@manufakture/core';
import { describe, expect, it } from 'vitest';
import { STOCK, defaultRegion, findStock, inchLabel, inches, stockByRegion } from './catalog';

// PS 20-25 Table 3, minimum dressed dry sizes in inches, typed here again from the plan's copy of
// the table (docs/plans/m4.md Part 1), independently of the catalog's own rows.
const BOARD_THICKNESS: [number, number][] = [
  [0.75, 0.625],
  [1, 0.75],
  [1.25, 1],
  [1.5, 1.25],
];
const BOARD_WIDTH: [number, number][] = [
  [2, 1.5],
  [3, 2.5],
  [4, 3.5],
  [5, 4.5],
  [6, 5.5],
  [7, 6.5],
  [8, 7.25],
  [9, 8.25],
  [10, 9.25],
  [11, 10.25],
  [12, 11.25],
  [14, 13.25],
  [16, 15.25],
];
const DIMENSION_THICKNESS: [number, number][] = [
  [2, 1.5],
  [2.5, 2],
  [3, 2.5],
  [3.5, 3],
  [4, 3.5],
  [4.5, 4],
];
const DIMENSION_WIDTH: [number, number][] = [
  [2, 1.5],
  [3, 2.5],
  [4, 3.5],
  [5, 4.5],
  [6, 5.5],
  [8, 7.25],
  [10, 9.25],
  [12, 11.25],
  [14, 13.25],
  [16, 15.25],
];

const IN = 25.4;

describe('the stock catalog', () => {
  it('has unique ids, valid materials and complete entries', () => {
    const ids = STOCK.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const e of STOCK) {
      expect(e.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*(x[a-z0-9]+(-[a-z0-9]+)*)?$/);
      expect(e.name.length).toBeGreaterThan(0);
      expect(e.actualLabel.length).toBeGreaterThan(0);
      expect(findMaterial(e.material), `${e.id} material`).toBeDefined();
      expect(e.actual.thickness).toBeGreaterThan(0);
      expect(e.nominal.thickness).toBeGreaterThan(0);
      expect(e.actual.thickness).toBeLessThanOrEqual(e.nominal.thickness);
      expect(e.source.actual.length).toBeGreaterThan(0);
      expect(e.source.sold.length).toBeGreaterThan(0);
      if (e.kind === 'sheet') {
        expect(e.sheet, e.id).toBeDefined();
        expect(e.boardFeetBasis).toBe('none');
        expect(e.actual.width).toBeUndefined();
      } else {
        expect(e.sheet).toBeUndefined();
        expect(e.boardFeetBasis).not.toBe('none');
        if (e.actual.width !== undefined) {
          expect(e.actual.width).toBeGreaterThanOrEqual(e.actual.thickness);
          expect(e.actual.width).toBeLessThanOrEqual(e.nominal.width!);
        }
      }
      expect(Object.isFrozen(e)).toBe(true);
    }
    expect(Object.isFrozen(STOCK)).toBe(true);
  });

  it('matches PS 20-25 Table 3 for every board and dimension size, in exact millimetres', () => {
    let count = 0;
    for (const [thick, wide] of [
      [BOARD_THICKNESS, BOARD_WIDTH],
      [DIMENSION_THICKNESS, DIMENSION_WIDTH],
    ] as const) {
      for (const [nt, at] of thick) {
        for (const [nw, aw] of wide) {
          if (nw < nt) continue;
          const e = STOCK.find(
            (s) =>
              s.category === 'softwood' &&
              s.region === 'us' &&
              s.nominal.thickness === nt * IN &&
              s.nominal.width === nw * IN,
          );
          expect(e, `${nt}x${nw}`).toBeDefined();
          expect(e!.actual.thickness, `${e!.name} thickness`).toBe(at * IN);
          expect(e!.actual.width, `${e!.name} width`).toBe(aw * IN);
          expect(e!.verified.actual).toBe(true);
          expect(e!.source.actual).toContain('PS 20-25');
          expect(e!.source.actual).toContain('Table 3');
          expect(e!.boardFeetBasis).toBe('nominal');
          count++;
        }
      }
    }
    expect(STOCK.filter((s) => s.region === 'us' && s.category === 'softwood')).toHaveLength(count);
  });

  it('knows the sizes the plan names', () => {
    const twoByFour = findStock('us-2x4')!;
    expect(twoByFour.name).toBe('2x4');
    expect(twoByFour.actualLabel).toBe('1-1/2" x 3-1/2"');
    expect(twoByFour.actual.thickness).toBeCloseTo(38.1, 12);
    expect(twoByFour.actual.width).toBeCloseTo(88.9, 12);
    expect(findStock('us-1x6')!.actual).toEqual({ thickness: 0.75 * IN, width: 5.5 * IN });
    expect(findStock('us-2x10')!.actual).toEqual({ thickness: 1.5 * IN, width: 9.25 * IN });

    const ply = findStock('us-ply-23-32')!;
    expect(ply.name).toBe('3/4" plywood');
    expect(ply.actualLabel).toBe('23/32"');
    expect(ply.actual.thickness).toBeCloseTo(18.25625, 12);
    expect(ply.nominal.thickness).toBeCloseTo(19.05, 12);
    expect(ply.sheet).toEqual({ length: 96 * IN, width: 48 * IN });
    expect(ply.grain).toBe(true);
    expect(ply.verified).toEqual({ actual: false, sold: false });

    expect(findStock('us-mdf-3-4')!.grain).toBe(false);
    expect(findStock('mm-ply-18')!.sheet).toEqual({ length: 2440, width: 1220 });
    expect(findStock('mm-mdf-18')!.material).toBe('mdf');
    expect(findStock('mm-38x89')!.verified.actual).toBe(false);

    const hw = findStock('us-hw-4-4')!;
    expect(hw.nominal.thickness).toBe(IN);
    expect(hw.actual.thickness).toBeCloseTo((13 / 16) * IN, 12);
    expect(hw.actual.width).toBeUndefined();
    expect(hw.boardFeetBasis).toBe('rough');
    expect(hw.verified.actual).toBe(false);
    expect(findStock('nope')).toBeUndefined();
  });

  it('flags every entry whose sizes were not checked against their source', () => {
    for (const e of STOCK) {
      if (!e.verified.actual) expect(e.source.actual, e.id).toMatch(/unverified/);
      if (!e.verified.sold)
        expect(e.source.sold, e.id).toMatch(/unverified|not from a standard|random/);
    }
  });

  it('groups stock by region and kind, and picks the region from the display units', () => {
    const us = stockByRegion('us');
    const metric = stockByRegion('metric');
    expect(us.lumber.every((e) => e.region === 'us' && e.kind === 'lumber')).toBe(true);
    expect(us.sheet.map((e) => e.id)).toContain('us-ply-23-32');
    expect(metric.sheet.map((e) => e.id)).toEqual([
      'mm-ply-12',
      'mm-ply-15',
      'mm-ply-18',
      'mm-mdf-12',
      'mm-mdf-15',
      'mm-mdf-18',
    ]);
    expect(us.lumber.length + us.sheet.length + metric.lumber.length + metric.sheet.length).toBe(
      STOCK.length,
    );
    expect(defaultRegion({ unit: 'in-fraction' })).toBe('us');
    expect(defaultRegion({ unit: 'ft-in', denominator: 16 })).toBe('us');
    expect(defaultRegion({ unit: 'in', decimals: 3 })).toBe('us');
    expect(defaultRegion({ unit: 'ft' })).toBe('us');
    expect(defaultRegion({ unit: 'mm' })).toBe('metric');
    expect(defaultRegion({ unit: 'm' })).toBe('metric');
  });

  it('writes inch fractions', () => {
    expect(inchLabel(1.5)).toBe('1-1/2');
    expect(inchLabel(23 / 32)).toBe('23/32');
    expect(inchLabel(11)).toBe('11');
    expect(inches(1, 1, 2)).toBe(1.5 * IN);
  });
});
