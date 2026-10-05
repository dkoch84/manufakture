// Measured values as text in the document's display units. Lengths and
// angles go through @manufakture/units, so a woodworking document shows
// `3' 4-1/2"` and a metric one `1016.00 mm`. Areas, volumes and masses have
// no formatter there yet; they follow the length unit here: square and cubic
// millimetres, centimetres, metres, inches or feet (inches for the
// fractional formats), and grams or ounces and pounds.

import type { DisplayUnits } from '@manufakture/core';
import { angleFormat, lengthFormat } from '@manufakture/core/display';
import {
  MM_PER_FOOT,
  MM_PER_INCH,
  formatAngle,
  formatLength,
  formatNumber,
} from '@manufakture/units';

// The display units to units-package format mapping lives in core, next to `DisplayUnits`;
// re-exported here for the measure code that reads it alongside the formatters.
export { angleFormat, lengthFormat };

export type Vec3 = readonly [number, number, number];

export function formatLengthIn(mm: number, units: DisplayUnits): string {
  return formatLength(mm, lengthFormat(units));
}

export function formatAngleIn(rad: number, units: DisplayUnits): string {
  return formatAngle(rad, angleFormat(units));
}

export function formatPointIn(p: Vec3, units: DisplayUnits): string {
  return `(${p.map((c) => formatLengthIn(c, units)).join(', ')})`;
}

interface PowerUnit {
  label: string;
  mm: number;
  decimals: number;
}

/** The unit areas and volumes are shown in: the length unit, inches for the fractional formats. */
function powerUnit(units: DisplayUnits, power: 2 | 3): PowerUnit {
  const l = units.length;
  const decimalsOf = (fallback: number) =>
    'decimals' in l && l.decimals !== undefined ? l.decimals : fallback;
  const sup = power === 2 ? '²' : '³';
  switch (l.unit) {
    case 'mm':
      return { label: ` mm${sup}`, mm: 1, decimals: decimalsOf(2) };
    case 'cm':
      return { label: ` cm${sup}`, mm: 10, decimals: decimalsOf(3) };
    case 'm':
      return { label: ` m${sup}`, mm: 1000, decimals: power === 2 ? 6 : 9 };
    case 'ft':
      return { label: ` ft${sup}`, mm: MM_PER_FOOT, decimals: power === 2 ? 4 : 5 };
    case 'in':
      return { label: ` in${sup}`, mm: MM_PER_INCH, decimals: decimalsOf(3) };
    default:
      return { label: ` in${sup}`, mm: MM_PER_INCH, decimals: 3 };
  }
}

function formatPower(value: number, units: DisplayUnits, power: 2 | 3): string {
  if (!Number.isFinite(value)) return String(value);
  const u = powerUnit(units, power);
  return `${formatNumber(value / u.mm ** power, u.decimals)}${u.label}`;
}

/** An area given in mm2. */
export function formatAreaIn(mm2: number, units: DisplayUnits): string {
  return formatPower(mm2, units, 2);
}

/** A volume given in mm3. */
export function formatVolumeIn(mm3: number, units: DisplayUnits): string {
  return formatPower(mm3, units, 3);
}

export const GRAMS_PER_OUNCE = 28.349523125;
export const GRAMS_PER_POUND = 453.59237;

/** Whether a document works in imperial units. */
export function isImperial(units: DisplayUnits): boolean {
  return units.length.unit !== 'mm' && units.length.unit !== 'cm' && units.length.unit !== 'm';
}

/** A mass given in grams: g or kg for metric documents, oz or lb for imperial ones. */
export function formatMassIn(grams: number, units: DisplayUnits): string {
  if (!Number.isFinite(grams)) return String(grams);
  if (isImperial(units)) {
    const oz = grams / GRAMS_PER_OUNCE;
    return Math.abs(oz) < 16
      ? `${formatNumber(oz, 2)} oz`
      : `${formatNumber(grams / GRAMS_PER_POUND, 3)} lb`;
  }
  return Math.abs(grams) < 1000
    ? `${formatNumber(grams, 2)} g`
    : `${formatNumber(grams / 1000, 3)} kg`;
}

/** A density given in kg/m3, as the material table shows it. */
export function formatDensityIn(kgPerM3: number, units: DisplayUnits): string {
  if (isImperial(units)) {
    // 1 lb/ft3 = 16.0184634 kg/m3.
    return `${formatNumber(kgPerM3 / (GRAMS_PER_POUND / 1000 / (MM_PER_FOOT / 1000) ** 3), 1)} lb/ft³`;
  }
  return `${formatNumber(kgPerM3, 0)} kg/m³`;
}
