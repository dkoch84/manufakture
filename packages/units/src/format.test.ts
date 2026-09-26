import { describe, expect, it } from 'vitest';
import { parseLength } from './evaluate';
import {
  formatAngle,
  formatLength,
  formatNumber,
  type FractionDenominator,
  type LengthFormat,
} from './format';
import { unwrap } from './test-helpers';
import type { LengthUnit } from './units';

const IN = 25.4;
const FT = 304.8;

describe('formatLength decimal', () => {
  it.each<[number, LengthFormat, string]>([
    [12, { unit: 'mm' }, '12.00 mm'],
    [12.345, { unit: 'mm', decimals: 1 }, '12.3 mm'],
    [12.5, { unit: 'mm', decimals: 0 }, '13 mm'],
    [0, { unit: 'mm' }, '0.00 mm'],
    [-0.001, { unit: 'mm' }, '0.00 mm'],
    [-12.5, { unit: 'mm' }, '-12.50 mm'],
    [25, { unit: 'cm' }, '2.500 cm'],
    [1234.5, { unit: 'm' }, '1.2345 m'],
    [1.5 * IN, { unit: 'in' }, '1.500"'],
    [1.5 * IN, { unit: 'in', decimals: 1 }, '1.5"'],
    [3.25 * FT, { unit: 'ft' }, "3.2500'"],
  ])('%f mm as %j = %j', (mm, format, expected) => {
    expect(formatLength(mm, format)).toBe(expected);
  });

  it('defaults to millimetres', () => {
    expect(formatLength(3)).toBe('3.00 mm');
  });
});

describe('formatLength ft-in', () => {
  it.each<[number, FractionDenominator, string]>([
    [0, 16, '0"'],
    [4.5 * IN, 16, '4-1/2"'],
    [0.5 * IN, 16, '1/2"'],
    [12 * IN, 16, `1' 0"`],
    [3 * FT, 16, `3' 0"`],
    [3 * FT + 4.5 * IN, 16, `3' 4-1/2"`],
    [3 * FT + 0.5 * IN, 16, `3' 1/2"`],
    // fractions reduce: 8/16 -> 1/2, 4/16 -> 1/4, 2/64 -> 1/32
    [(8 / 16) * IN, 16, '1/2"'],
    [(4 / 16) * IN, 16, '1/4"'],
    [(2 / 64) * IN, 64, '1/32"'],
    // fractions that do not reduce
    [(3 / 16) * IN, 16, '3/16"'],
    [(5 / 32) * IN, 32, '5/32"'],
    [(63 / 64) * IN, 64, '63/64"'],
    // rounding to the denominator
    [(1 / 64) * IN, 16, '0"'],
    [(1 / 64) * IN, 64, '1/64"'],
    [(1 / 128) * IN * 1.01, 64, '1/64"'],
    [(1 / 128) * IN * 0.99, 64, '0"'],
    [0.07 * IN, 16, '1/16"'],
    [0.1 * IN, 16, '1/8"'],
    [0.1 * IN, 64, '3/32"'],
    // carry: inches rounding up to 12 become the next foot
    [11.99 * IN, 16, `1' 0"`],
    [FT - 0.1, 16, `1' 0"`],
    [2 * FT + (11 + 63 / 64) * IN, 16, `3' 0"`],
    [2 * FT + (11 + 63 / 64) * IN, 64, `2' 11-63/64"`],
    [(3 / 4 - 1 / 128) * IN * 1.0001, 64, '3/4"'],
    // negatives
    [-(3 * FT + 4.5 * IN), 16, `-3' 4-1/2"`],
    [-0.5 * IN, 16, '-1/2"'],
    [-0.001, 16, '0"'],
    [-(1 / 256) * IN, 64, '0"'],
    // whole inches
    [4.4 * IN, 1, '4"'],
    [4.6 * IN, 1, '5"'],
  ])('%f mm at 1/%i = %j', (mm, denominator, expected) => {
    expect(formatLength(mm, { unit: 'ft-in', denominator })).toBe(expected);
  });

  it('defaults to sixteenths', () => {
    expect(formatLength(0.07 * IN, { unit: 'ft-in' })).toBe('1/16"');
  });
});

describe('formatLength in-fraction', () => {
  it.each<[number, FractionDenominator, string]>([
    [40.5 * IN, 16, '40-1/2"'],
    [12 * IN, 16, '12"'],
    [(11 + 63 / 64) * IN, 32, '12"'],
    [-(1 / 64) * IN, 64, '-1/64"'],
    [0, 8, '0"'],
  ])('%f mm at 1/%i = %j', (mm, denominator, expected) => {
    expect(formatLength(mm, { unit: 'in-fraction', denominator })).toBe(expected);
  });
});

describe('non-finite values', () => {
  const formats: LengthFormat[] = [
    { unit: 'mm' },
    { unit: 'cm' },
    { unit: 'm' },
    { unit: 'in' },
    { unit: 'ft' },
    { unit: 'ft-in' },
    { unit: 'ft-in', denominator: 64 },
    { unit: 'in-fraction' },
    { unit: 'in-fraction', denominator: 1 },
  ];
  const cases: [number, string][] = [
    [NaN, 'NaN'],
    [Infinity, 'Infinity'],
    [-Infinity, '-Infinity'],
  ];

  it.each(formats.flatMap((format) => cases.map(([v, text]) => [v, format, text] as const)))(
    'formatLength(%f, %j) = %j',
    (value, format, expected) => {
      expect(formatLength(value, format)).toBe(expected);
    },
  );

  it.each(cases)('formatAngle and formatNumber(%f) = %j', (value, expected) => {
    expect(formatAngle(value)).toBe(expected);
    expect(formatAngle(value, { unit: 'rad' })).toBe(expected);
    expect(formatNumber(value)).toBe(expected);
  });

  it('does not produce text that parses back as a length', () => {
    for (const [value] of cases) {
      expect(parseLength(formatLength(value, { unit: 'ft-in' })).ok).toBe(false);
    }
  });
});

describe('invalid options at runtime', () => {
  it.each([0, 3, -16, 1.5, NaN, Infinity])('denominator %f falls back to 16', (denominator) => {
    const format = { unit: 'ft-in', denominator } as unknown as LengthFormat;
    expect(formatLength(0.07 * IN, format)).toBe('1/16"');
    expect(formatLength(40.5 * IN, { ...format, unit: 'in-fraction' } as LengthFormat)).toBe(
      '40-1/2"',
    );
  });

  it.each([NaN, -3, Infinity])('decimals %f is clamped', (decimals) => {
    expect(formatLength(12.5, { unit: 'mm', decimals })).toMatch(/^1[23](\.0{12})? mm$/);
  });

  it('formats huge finite values without hanging', () => {
    expect(formatLength(1e300, { unit: 'ft-in', denominator: 64 })).toMatch(/"$/);
    expect(formatLength(-Number.MAX_VALUE, { unit: 'in-fraction' })).toMatch(/^-.*"$/);
  });
});

describe('format -> parse round trip', () => {
  const values = [
    0, 1, -1, 12.7, 25.4, 100, 304.8, 1028.7, -1028.7, 3.175, 0.396875, 2438.4, 1234.5678, -0.2,
  ];
  const formats: LengthFormat[] = [
    { unit: 'mm' },
    { unit: 'mm', decimals: 4 },
    { unit: 'cm' },
    { unit: 'm' },
    { unit: 'in' },
    { unit: 'ft' },
    { unit: 'ft-in', denominator: 16 },
    { unit: 'ft-in', denominator: 64 },
    { unit: 'in-fraction', denominator: 32 },
  ];
  const displayUnits: LengthUnit[] = ['mm', 'in'];

  // Formatting rounds; reparsing the text must give exactly the rounded value, and formatting
  // that again must be stable, whatever the document's display unit.
  it.each(formats.flatMap((format) => values.map((mm) => [mm, format] as const)))(
    '%f mm as %j',
    (mm, format) => {
      const text = formatLength(mm, format);
      for (const unit of displayUnits) {
        const reparsed = unwrap(parseLength(text, unit));
        expect(formatLength(reparsed, format)).toBe(text);
      }
    },
  );

  it.each<[number, FractionDenominator]>([
    [1028.7, 16],
    [3 * FT + (7 / 64) * IN, 64],
    [-(5 * FT + (11 + 31 / 32) * IN), 32],
  ])('ft-in %f mm at 1/%i reparses exactly', (mm, denominator) => {
    const text = formatLength(mm, { unit: 'ft-in', denominator });
    expect(unwrap(parseLength(text))).toBeCloseTo(mm, 9);
  });
});

describe('formatAngle', () => {
  it.each<[number, Parameters<typeof formatAngle>[1], string]>([
    [Math.PI / 4, {}, '45.00°'],
    [Math.PI / 4, { decimals: 0 }, '45°'],
    [-Math.PI / 2, { unit: 'deg', decimals: 1 }, '-90.0°'],
    [Math.PI / 4, { unit: 'rad' }, '0.7854 rad'],
    [-1e-12, {}, '0.00°'],
  ])('%f rad as %j = %j', (rad, format, expected) => {
    expect(formatAngle(rad, format)).toBe(expected);
  });
});

describe('formatNumber', () => {
  it.each<[number, number | undefined, string]>([
    [1.23456, undefined, '1.235'],
    [2, 0, '2'],
    [-0.0001, 2, '0.00'],
  ])('%f with %s decimals = %j', (value, decimals, expected) => {
    expect(formatNumber(value, decimals)).toBe(expected);
  });
});
