import { createDocument, type DisplayUnits } from '@manufakture/core';
import { lengthQuantity } from '@manufakture/units';
import { describe, expect, it } from 'vitest';
import {
  checkValue,
  evaluateVariables,
  formatValue,
  isPlainNumber,
  lengthFormat,
  measuredSource,
} from './values';

const MM: DisplayUnits = { length: { unit: 'mm' }, angle: { unit: 'deg' } };
const FT_IN: DisplayUnits = { length: { unit: 'ft-in', denominator: 16 }, angle: { unit: 'deg' } };

describe('dimension values', () => {
  it('accepts expressions with units and variables and stores the typing units', () => {
    const vars = { t: lengthQuantity(5) };
    const inch = checkValue('3/4"', 'distance', MM, vars);
    expect(inch).toMatchObject({
      ok: true,
      expression: { source: '3/4"', lengthUnit: 'mm', angleUnit: 'deg' },
    });
    expect(inch.ok && inch.value).toBeCloseTo(19.05, 12);
    const r = checkValue(' 2*#t ', 'radius', MM, vars);
    expect(r).toMatchObject({ ok: true, value: 10, expression: { source: '2*#t' } });
    // Under feet and inches a bare number is inches.
    const bare = checkValue('2', 'distance', FT_IN, {});
    expect(bare).toMatchObject({ ok: true, expression: { lengthUnit: 'in' } });
    expect(bare.ok && bare.value).toBeCloseTo(50.8, 12);
    const angle = checkValue('30', 'angle', MM, {});
    expect(angle.ok && angle.value).toBeCloseTo(Math.PI / 6, 12);
  });

  it('refuses the wrong kind, unknown variables, and non-positive lengths', () => {
    const wrongKind = checkValue('3/4" + 5deg', 'distance', MM, {});
    expect(wrongKind.ok).toBe(false);
    if (!wrongKind.ok) expect(wrongKind.error?.code).toBe('dimension');
    const unknown = checkValue('2*#t', 'distance', MM, {});
    expect(unknown).toMatchObject({ ok: false, error: { code: 'unknown-variable' } });
    expect(checkValue('0', 'diameter', MM, {})).toEqual({
      ok: false,
      message: 'The value must be positive.',
    });
    expect(checkValue('', 'distance', MM, {})).toEqual({ ok: false, message: 'Enter a value.' });
    // Signed dimensions may be negative.
    expect(checkValue('-4', 'horizontalDistance', MM, {})).toMatchObject({ ok: true, value: -4 });
  });

  it('starts a new dimension at the measured value in the bare-number unit', () => {
    expect(measuredSource(12.34567, 'length', MM)).toBe('12.346');
    expect(measuredSource(25.4, 'length', FT_IN)).toBe('1');
    expect(measuredSource(Math.PI / 4, 'angle', MM)).toBe('45');
  });

  it('formats values in the display units', () => {
    expect(formatValue(19.05, 'length', MM)).toBe('19.05 mm');
    expect(formatValue(19.05, 'length', FT_IN)).toBe('3/4"');
    expect(formatValue(Math.PI / 2, 'angle', MM)).toBe('90.00°');
    expect(lengthFormat({ length: { unit: 'in', decimals: 1 }, angle: { unit: 'deg' } })).toEqual({
      unit: 'in',
      decimals: 1,
    });
    expect(isPlainNumber(' 12.5 ')).toBe(true);
    expect(isPlainNumber('3/4"')).toBe(false);
  });

  it('evaluates the document variables in dependency order', () => {
    const doc = {
      ...createDocument({ id: 'd', name: 'D' }),
      variables: [
        {
          name: 'b',
          expression: { source: '2*#a', lengthUnit: 'mm' as const, angleUnit: 'deg' as const },
        },
        {
          name: 'a',
          expression: { source: '1 in', lengthUnit: 'mm' as const, angleUnit: 'deg' as const },
        },
        {
          name: 'bad',
          expression: { source: '#nope', lengthUnit: 'mm' as const, angleUnit: 'deg' as const },
        },
      ],
    };
    const vars = evaluateVariables(doc);
    expect(vars.a?.value).toBeCloseTo(25.4, 12);
    expect(vars.b?.value).toBeCloseTo(50.8, 12);
    expect(vars.bad).toBeUndefined();
  });
});
