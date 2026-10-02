import { describe, expect, it } from 'vitest';
import {
  DIAMETER_SIGN,
  dimensionText,
  formatDimensionAngle,
  formatDimensionLength,
} from './format';

describe('formatDimensionLength', () => {
  it('writes millimetres without trailing zeros or unit by default', () => {
    expect(formatDimensionLength(40)).toBe('40');
    expect(formatDimensionLength(4.5)).toBe('4.5');
    expect(formatDimensionLength(422.6336)).toBe('422.63');
    expect(formatDimensionLength(4.5, { trimZeros: false })).toBe('4.50');
    expect(formatDimensionLength(4.5, { showUnit: true })).toBe('4.5 mm');
    expect(formatDimensionLength(4.5, { length: { unit: 'mm', decimals: 0 } })).toBe('5');
  });

  it('writes woodworking fractions through packages/units', () => {
    expect(formatDimensionLength(1028.7, { length: { unit: 'ft-in', denominator: 16 } })).toBe(
      '3\' 4-1/2"',
    );
    expect(formatDimensionLength(900, { length: { unit: 'ft-in', denominator: 16 } })).toBe(
      '2\' 11-7/16"',
    );
    expect(
      formatDimensionLength(1028.7, { length: { unit: 'in-fraction', denominator: 16 } }),
    ).toBe('40-1/2"');
    expect(formatDimensionLength(18, { length: { unit: 'in-fraction', denominator: 32 } })).toBe(
      '23/32"',
    );
  });

  it('keeps the inch mark on decimal inches', () => {
    expect(formatDimensionLength(38.1, { length: { unit: 'in' } })).toBe('1.5"');
    expect(formatDimensionLength(38.1, { length: { unit: 'in' }, trimZeros: false })).toBe(
      '1.500"',
    );
  });
});

describe('formatDimensionAngle and overrides', () => {
  it('writes degrees without trailing zeros', () => {
    expect(formatDimensionAngle(Math.PI / 2)).toBe('90°');
    expect(formatDimensionAngle(Math.PI / 8)).toBe('22.5°');
    expect(formatDimensionAngle(Math.PI / 8, { trimZeros: false })).toBe('22.50°');
  });

  it('puts the value into override text', () => {
    expect(dimensionText(`${DIAMETER_SIGN}4.5`, '2x <> THRU')).toBe('2x Ø4.5 THRU');
    expect(dimensionText('40', undefined)).toBe('40');
    expect(dimensionText('40', 'REF')).toBe('REF');
  });
});
