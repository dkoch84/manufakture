import type { DisplayUnits } from '@manufakture/core';
import * as display from '@manufakture/core/display';
import { describe, expect, it } from 'vitest';
import {
  GMM2_PER_LB_IN2,
  GRAMS_PER_OUNCE,
  GRAMS_PER_POUND,
  angleFormat,
  formatAngleIn,
  formatAreaIn,
  formatDensityIn,
  formatInertiaIn,
  formatLengthIn,
  formatMassIn,
  formatPointIn,
  formatVolumeIn,
  isImperial,
  lengthFormat,
} from './format';
import * as values from '../sketcher/values';

const deg = { unit: 'deg' } as const;
const MM: DisplayUnits = { length: { unit: 'mm' }, angle: deg };
const CM: DisplayUnits = { length: { unit: 'cm' }, angle: deg };
const M: DisplayUnits = { length: { unit: 'm' }, angle: deg };
const IN: DisplayUnits = { length: { unit: 'in', decimals: 2 }, angle: { unit: 'rad' } };
const FT: DisplayUnits = { length: { unit: 'ft' }, angle: deg };
const FT_IN: DisplayUnits = { length: { unit: 'ft-in', denominator: 16 }, angle: deg };
const IN_FRACTION: DisplayUnits = {
  length: { unit: 'in-fraction', denominator: 32 },
  angle: { unit: 'deg', decimals: 1 },
};

describe('display formats from the document units', () => {
  it('uses the one mapping core keeps next to DisplayUnits, as the dimension values do', () => {
    expect(lengthFormat).toBe(display.lengthFormat);
    expect(angleFormat).toBe(display.angleFormat);
    expect(values.lengthFormat).toBe(display.lengthFormat);
  });

  it('maps the stored display units onto the units package formats', () => {
    expect(lengthFormat(MM)).toEqual({ unit: 'mm' });
    expect(lengthFormat(IN)).toEqual({ unit: 'in', decimals: 2 });
    expect(lengthFormat(FT_IN)).toEqual({ unit: 'ft-in', denominator: 16 });
    expect(lengthFormat({ length: { unit: 'in-fraction' }, angle: deg })).toEqual({
      unit: 'in-fraction',
    });
    expect(angleFormat(IN_FRACTION)).toEqual({ unit: 'deg', decimals: 1 });
    expect(angleFormat(IN)).toEqual({ unit: 'rad' });
  });

  it('formats lengths in the display unit, fractions for woodworking documents', () => {
    expect(formatLengthIn(20, MM)).toBe('20.00 mm');
    expect(formatLengthIn(20, CM)).toBe('2.000 cm');
    expect(formatLengthIn(25.4, IN)).toBe('1.00"');
    // 40 inches: 3 ft 4 in, and 40-1/2" without feet.
    expect(formatLengthIn(1016, FT_IN)).toBe(`3' 4"`);
    expect(formatLengthIn(1028.7, IN_FRACTION)).toBe('40-1/2"');
    expect(formatLengthIn(3.175, FT_IN)).toBe('1/8"');
  });

  it('formats angles in degrees or radians', () => {
    expect(formatAngleIn(Math.PI / 2, MM)).toBe('90.00°');
    expect(formatAngleIn(Math.atan(0.5), IN_FRACTION)).toBe('26.6°');
    expect(formatAngleIn(Math.PI / 2, IN)).toBe('1.5708 rad');
  });

  it('formats points as three lengths', () => {
    expect(formatPointIn([0, -20, 10], MM)).toBe('(0.00 mm, -20.00 mm, 10.00 mm)');
    expect(formatPointIn([25.4, 0, 304.8], FT_IN)).toBe(`(1", 0", 1' 0")`);
  });
});

describe('areas and volumes', () => {
  it('uses the square and cubic length unit', () => {
    expect(formatAreaIn(1634.94, MM)).toBe('1634.94 mm²');
    expect(formatAreaIn(100, CM)).toBe('1.000 cm²');
    expect(formatAreaIn(1e6, M)).toBe('1.000000 m²');
    expect(formatAreaIn(25.4 * 25.4, IN)).toBe('1.00 in²');
    expect(formatVolumeIn(48000, MM)).toBe('48000.00 mm³');
    expect(formatVolumeIn(1000, CM)).toBe('1.000 cm³');
    expect(formatVolumeIn(1e9, M)).toBe('1.000000000 m³');
    expect(formatVolumeIn(304.8 ** 3, FT)).toBe('1.00000 ft³');
  });

  it('uses inches for the fractional formats', () => {
    expect(formatAreaIn(2 * 25.4 * 25.4, FT_IN)).toBe('2.000 in²');
    expect(formatVolumeIn(25.4 ** 3, IN_FRACTION)).toBe('1.000 in³');
  });

  it('passes non-finite values through without a unit', () => {
    expect(formatAreaIn(Number.NaN, MM)).toBe('NaN');
    expect(formatVolumeIn(Infinity, FT_IN)).toBe('Infinity');
  });
});

describe('masses and densities', () => {
  it('gives grams, then kilograms, in metric documents', () => {
    expect(isImperial(MM)).toBe(false);
    expect(formatMassIn(376.8, MM)).toBe('376.80 g');
    expect(formatMassIn(1500, CM)).toBe('1.500 kg');
  });

  it('gives ounces, then pounds, in imperial documents', () => {
    expect(isImperial(FT_IN)).toBe(true);
    expect(formatMassIn(GRAMS_PER_OUNCE, FT_IN)).toBe('1.00 oz');
    expect(formatMassIn(GRAMS_PER_POUND * 2.5, IN)).toBe('2.500 lb');
  });

  it('shows densities as kg/m3 or lb/ft3', () => {
    expect(formatDensityIn(680, MM)).toBe('680 kg/m³');
    // 1 lb/ft3 is 16.0185 kg/m3.
    expect(formatDensityIn(16.0184634, FT_IN)).toBe('1.0 lb/ft³');
    expect(formatDensityIn(7850, IN_FRACTION)).toBe('490.1 lb/ft³');
  });
});

describe('moments of inertia', () => {
  it('gives g·mm², then kg·m², in metric documents', () => {
    expect(formatInertiaIn(92.5, MM)).toBe('92.5 g·mm²');
    expect(formatInertiaIn(1.5e9, CM)).toBe('1.500000 kg·m²');
    expect(formatInertiaIn(4.9866e6, M)).toBe('0.004987 kg·m²');
  });

  it('gives lb·in² in imperial documents', () => {
    // 1 lb·in² is 453.59237 g times 645.16 mm².
    expect(GMM2_PER_LB_IN2).toBeCloseTo(292_639.7, 1);
    expect(formatInertiaIn(GMM2_PER_LB_IN2 * 2, FT_IN)).toBe('2.0000 lb·in²');
    expect(formatInertiaIn(Number.NaN, MM)).toBe('NaN');
  });
});
