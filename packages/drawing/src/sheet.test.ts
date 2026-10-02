import { describe, expect, it } from 'vitest';
import {
  SHEET_SIZES,
  SHEET_SIZE_NAMES,
  isSheetSizeName,
  resolveSheetSizeName,
  sheetGeometry,
} from './sheet';

describe('sheet sizes', () => {
  it('has the ISO A series in millimetres', () => {
    expect(SHEET_SIZES.A4).toEqual({ series: 'iso', width: 210, height: 297 });
    expect(SHEET_SIZES.A0).toEqual({ series: 'iso', width: 841, height: 1189 });
  });

  it('has ANSI and Arch sizes converted from inches', () => {
    expect(SHEET_SIZES['ANSI B'].width).toBeCloseTo(279.4, 9);
    expect(SHEET_SIZES['ANSI B'].height).toBeCloseTo(431.8, 9);
    expect(SHEET_SIZES['Arch D'].width).toBeCloseTo(609.6, 9);
    expect(SHEET_SIZES['Arch D'].height).toBeCloseTo(914.4, 9);
    expect(SHEET_SIZES['Arch E1'].width).toBeCloseTo(762, 9);
  });

  it('stores every size portrait', () => {
    for (const name of SHEET_SIZE_NAMES)
      expect(SHEET_SIZES[name].width).toBeLessThan(SHEET_SIZES[name].height);
    expect(isSheetSizeName('A3')).toBe(true);
    expect(isSheetSizeName('A7')).toBe(false);
    expect(isSheetSizeName('toString')).toBe(false);
  });
});

describe('sheetGeometry', () => {
  it('turns the sheet and places the ISO frame', () => {
    expect(sheetGeometry({ size: 'A3' })).toEqual({
      width: 420,
      height: 297,
      frame: { min: [20, 10], max: [410, 287] },
    });
    expect(sheetGeometry({ size: 'A3', orientation: 'portrait' })).toEqual({
      width: 297,
      height: 420,
      frame: { min: [20, 10], max: [287, 410] },
    });
  });

  it('uses half-inch margins on ANSI and Arch, and takes overrides', () => {
    const g = sheetGeometry({ size: 'ANSI A', margins: { left: 25 } });
    expect(g.width).toBeCloseTo(279.4, 9);
    expect(g.frame.min).toEqual([25, 12.7]);
    expect(g.frame.max[0]).toBeCloseTo(279.4 - 12.7, 9);
  });

  it('rejects a custom size without a positive width and height', () => {
    expect(sheetGeometry({ size: { width: 300, height: 200 } }).width).toBe(300);
    for (const size of [
      { width: 0, height: 200 },
      { width: 300, height: -1 },
      { width: Number.NaN, height: 200 },
      { width: 300, height: Number.POSITIVE_INFINITY },
    ])
      expect(() => sheetGeometry({ size })).toThrow(RangeError);
  });

  it('takes Letter and Tabloid for ANSI A and B', () => {
    expect(resolveSheetSizeName('letter')).toBe('ANSI A');
    expect(resolveSheetSizeName('Tabloid')).toBe('ANSI B');
    expect(resolveSheetSizeName('A4')).toBe('A4');
    expect(resolveSheetSizeName('legal')).toBeUndefined();
    expect(resolveSheetSizeName('toString')).toBeUndefined();
    expect(sheetGeometry({ size: 'letter' })).toEqual(sheetGeometry({ size: 'ANSI A' }));
    expect(sheetGeometry({ size: 'Tabloid', orientation: 'portrait' })).toEqual(
      sheetGeometry({ size: 'ANSI B', orientation: 'portrait' }),
    );
  });

  it('accepts a custom size', () => {
    expect(sheetGeometry({ size: { width: 500, height: 300 }, orientation: 'portrait' })).toEqual({
      width: 300,
      height: 500,
      frame: { min: [10, 10], max: [290, 490] },
    });
  });
});
