import { describe, expect, it } from 'vitest';
import { parseAngle, parseLength } from './evaluate';
import { unwrap, unwrapError } from './test-helpers';
import type { LengthUnit } from './units';

const IN = 25.4;
const FT = 304.8;

describe('parseLength', () => {
  it.each<[string, LengthUnit, number]>([
    // bare numbers take the display unit
    ['12', 'mm', 12],
    ['12', 'in', 12 * IN],
    ['12', 'cm', 120],
    ['1.5', 'ft', 1.5 * FT],
    ['.5', 'mm', 0.5],
    ['1e3', 'mm', 1000],
    ['0', 'in', 0],
    // metric
    ['12mm', 'in', 12],
    ['12 mm', 'in', 12],
    ['12MM', 'in', 12],
    ['2cm', 'mm', 20],
    ['0.5m', 'mm', 500],
    // inches and feet
    ['1.5in', 'mm', 1.5 * IN],
    ['1.5"', 'mm', 1.5 * IN],
    ['1.5″', 'mm', 1.5 * IN],
    ['2 inches', 'mm', 2 * IN],
    ["3'", 'mm', 3 * FT],
    ['3ft', 'mm', 3 * FT],
    ['3 feet', 'mm', 3 * FT],
    ['1yd', 'mm', 3 * FT],
    // fractions and mixed numbers
    ['1/8"', 'mm', IN / 8],
    ['1/8 in', 'mm', IN / 8],
    ['1/64"', 'mm', IN / 64],
    ['4 1/2"', 'mm', 4.5 * IN],
    ['4-1/2"', 'mm', 4.5 * IN],
    ['4 1/2', 'in', 4.5 * IN],
    ['3/2"', 'mm', 1.5 * IN],
    ['4 3/3"', 'mm', 5 * IN],
    // feet-inches
    [`3' 4-1/2"`, 'mm', 3 * FT + 4.5 * IN],
    [`3'4-1/2"`, 'mm', 3 * FT + 4.5 * IN],
    [`3' 4 1/2"`, 'mm', 3 * FT + 4.5 * IN],
    [`3'-4-1/2"`, 'mm', 3 * FT + 4.5 * IN],
    [`3'-4"`, 'mm', 3 * FT + 4 * IN],
    [`3'-4`, 'mm', 3 * FT + 4 * IN],
    [`3' 4`, 'mm', 3 * FT + 4 * IN],
    [`3' 1/2"`, 'mm', 3 * FT + 0.5 * IN],
    [`3' 1/2`, 'mm', 3 * FT + 0.5 * IN],
    [`3' 0"`, 'mm', 3 * FT],
    ['3ft 4.5in', 'mm', 3 * FT + 4.5 * IN],
    ['3ft4in', 'mm', 3 * FT + 4 * IN],
    [`1.5' 2"`, 'mm', 1.5 * FT + 2 * IN],
    [`3' 14"`, 'mm', 3 * FT + 14 * IN],
    // negatives: the sign applies to the whole compound value
    ['-12', 'mm', -12],
    [`-3' 4"`, 'mm', -(3 * FT + 4 * IN)],
    ['-4-1/2"', 'mm', -4.5 * IN],
    ['-1/64"', 'mm', -IN / 64],
    // whitespace is insignificant around the whole value
    ['  12mm  ', 'in', 12],
  ])('%j (display %s) = %f mm', (input, unit, expected) => {
    expect(unwrap(parseLength(input, unit))).toBeCloseTo(expected, 9);
  });

  it.each<[string, LengthUnit, number, string]>([
    // hyphen and slash surrounded by spaces are arithmetic, not notation
    [`3' - 2"`, 'mm', 3 * FT - 2 * IN, 'spaced minus subtracts'],
    [`3' -2"`, 'mm', 3 * FT - 2 * IN, 'minus not attached to the foot mark subtracts'],
    [`3'-2mm`, 'mm', 3 * FT - 2, 'hyphen before a non-inch unit subtracts'],
    ['4 - 1/2', 'mm', 3.5, 'spaced minus before a fraction subtracts'],
    ['4-1/2mm', 'in', 4.5, 'hyphenated mixed number with a metric unit'],
    ['10-1/2mm', 'in', 10.5, 'hyphenated mixed number with a metric unit'],
    [`3' 2 * 2`, 'mm', 2 * (3 * FT + 2 * IN), 'feet-inches literal binds before *'],
    ['1/2', 'in', 0.5 * IN, 'unitless fraction is division, then display unit'],
  ])('%j (display %s) = %f mm: %s', (input, unit, expected) => {
    expect(unwrap(parseLength(input, unit))).toBeCloseTo(expected, 9);
  });

  it.each<[string, string, string]>([
    ['4-1/2', `Ambiguous: write '4 1/2', '4-1/2"' or '4 - 1/2'`, '4-1/2'],
    ['10-3/4 + 1', `Ambiguous: write '10 3/4', '10-3/4"' or '10 - 3/4'`, '10-3/4'],
    ['2 * (1-1/8)', `Ambiguous: write '1 1/8', '1-1/8"' or '1 - 1/8'`, '1-1/8'],
  ])('rejects the unitless hyphenated mixed number %j', (input, message, highlighted) => {
    for (const unit of ['mm', 'in'] as const) {
      const error = unwrapError(parseLength(input, unit));
      expect(error.code).toBe('syntax');
      expect(error.message).toBe(message);
      expect(input.slice(error.start, error.end)).toBe(highlighted);
    }
  });

  it('treats a spaced slash as division, so `1 / 8"` is 1/length', () => {
    expect(unwrapError(parseLength('1 / 8"', 'in')).code).toBe('dimension');
  });

  it('defaults bare numbers to millimetres', () => {
    expect(unwrap(parseLength('12'))).toBe(12);
  });
});

describe('parseAngle', () => {
  it.each<[string, 'deg' | 'rad', number]>([
    ['45deg', 'rad', Math.PI / 4],
    ['45°', 'rad', Math.PI / 4],
    ['45', 'deg', Math.PI / 4],
    ['1', 'rad', 1],
    ['0.5rad', 'deg', 0.5],
    ['-90deg', 'deg', -Math.PI / 2],
    ['atan2(6, 12)', 'deg', Math.atan2(6, 12)],
  ])('%j (display %s) = %f rad', (input, unit, expected) => {
    expect(unwrap(parseAngle(input, unit))).toBeCloseTo(expected, 12);
  });

  it('rejects a length', () => {
    expect(unwrapError(parseAngle('3mm')).code).toBe('dimension');
  });
});
