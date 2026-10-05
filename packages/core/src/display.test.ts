import { formatAngle, formatLength } from '@manufakture/units';
import { describe, expect, it } from 'vitest';
import { angleFormat, lengthFormat } from './display';
import type { DisplayUnits } from './schema';

const deg = { unit: 'deg' } as const;
const units = (length: DisplayUnits['length'], angle: DisplayUnits['angle'] = deg) => ({
  length,
  angle,
});

describe('lengthFormat', () => {
  it.each<[DisplayUnits['length'], object]>([
    [{ unit: 'mm' }, { unit: 'mm' }],
    [
      { unit: 'mm', decimals: 0 },
      { unit: 'mm', decimals: 0 },
    ],
    [
      { unit: 'cm', decimals: 3 },
      { unit: 'cm', decimals: 3 },
    ],
    [{ unit: 'm' }, { unit: 'm' }],
    [
      { unit: 'in', decimals: 2 },
      { unit: 'in', decimals: 2 },
    ],
    [{ unit: 'ft' }, { unit: 'ft' }],
    [{ unit: 'ft-in' }, { unit: 'ft-in' }],
    [
      { unit: 'ft-in', denominator: 16 },
      { unit: 'ft-in', denominator: 16 },
    ],
    [{ unit: 'in-fraction' }, { unit: 'in-fraction' }],
    [
      { unit: 'in-fraction', denominator: 64 },
      { unit: 'in-fraction', denominator: 64 },
    ],
  ])('%j -> %j', (length, format) => {
    // toStrictEqual: an unset precision is left out, never present as undefined.
    expect(lengthFormat(units(length))).toStrictEqual(format);
  });

  it('formats as the display units say', () => {
    expect(formatLength(1028.7, lengthFormat(units({ unit: 'in-fraction' })))).toBe('40-1/2"');
    expect(formatLength(1016, lengthFormat(units({ unit: 'ft-in', denominator: 16 })))).toBe(
      `3' 4"`,
    );
    expect(formatLength(20, lengthFormat(units({ unit: 'mm', decimals: 1 })))).toBe('20.0 mm');
  });
});

describe('angleFormat', () => {
  it.each<[DisplayUnits['angle'], object]>([
    [{ unit: 'deg' }, { unit: 'deg' }],
    [
      { unit: 'deg', decimals: 1 },
      { unit: 'deg', decimals: 1 },
    ],
    [{ unit: 'rad' }, { unit: 'rad' }],
    [
      { unit: 'rad', decimals: 0 },
      { unit: 'rad', decimals: 0 },
    ],
  ])('%j -> %j', (angle, format) => {
    expect(angleFormat(units({ unit: 'mm' }, angle))).toStrictEqual(format);
  });

  it('formats as the display units say', () => {
    expect(
      formatAngle(Math.PI / 2, angleFormat(units({ unit: 'mm' }, { unit: 'deg', decimals: 1 }))),
    ).toBe('90.0°');
  });
});
