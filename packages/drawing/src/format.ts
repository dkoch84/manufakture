// Dimension values as text, through `packages/units` in the document's display units.

import { formatAngle, formatLength, type AngleFormat, type LengthFormat } from '@manufakture/units';

export interface ValueFormat {
  /** The document's display units (ADR 0005). Default `{ unit: 'mm' }`. */
  readonly length?: LengthFormat;
  /** Default degrees with 2 decimals, trimmed. */
  readonly angle?: AngleFormat;
  /**
   * Drop trailing zeros of decimal values (`4.50` to `4.5`, `40.00` to `40`). Default true; ISO
   * 129-1 is usually quoted as writing no trailing zeros, ASME Y14.5 as writing them for inch
   * tolerancing (neither read; our choice of default).
   */
  readonly trimZeros?: boolean;
  /**
   * Write the unit after decimal values. Default: not for millimetres, centimetres and metres
   * (the title block states the unit), always for inches and feet (`"` and `'`), our choice.
   * Fractional formats (`ft-in`, `in-fraction`) always carry their marks.
   */
  readonly showUnit?: boolean;
}

/**
 * The diameter sign: `Ø` (U+00D8) rather than `⌀` (U+2300), because the PDF writer uses the
 * standard 14 fonts, whose WinAnsi encoding has the first and not the second.
 */
export const DIAMETER_SIGN = 'Ø';

function trim(number: string): string {
  return number.includes('.') ? number.replace(/0+$/, '').replace(/\.$/, '') : number;
}

/** Splits `12.50 mm` or `1.500"` into its number and its unit suffix. */
function split(text: string): [string, string] {
  const m = /^(-?\d+(?:\.\d+)?)(.*)$/.exec(text);
  return m ? [m[1]!, m[2]!] : [text, ''];
}

/** A length in model millimetres as dimension text, for example `40`, `4.5`, `23/32"`, `3' 4-1/2"`. */
export function formatDimensionLength(mm: number, format: ValueFormat = {}): string {
  const length = format.length ?? { unit: 'mm' };
  const text = formatLength(mm, length);
  if (length.unit === 'ft-in' || length.unit === 'in-fraction') return text;
  const [raw, suffix] = split(text);
  const number = (format.trimZeros ?? true) ? trim(raw) : raw;
  const metric = length.unit === 'mm' || length.unit === 'cm' || length.unit === 'm';
  return number + ((format.showUnit ?? !metric) ? suffix : '');
}

/** An angle in radians as dimension text, for example `90°` or `22.5°`. */
export function formatDimensionAngle(rad: number, format: ValueFormat = {}): string {
  const text = formatAngle(rad, format.angle ?? { unit: 'deg', decimals: 2 });
  if (!(format.trimZeros ?? true)) return text;
  const [number, suffix] = split(text);
  return trim(number) + suffix;
}

/**
 * The text a dimension shows: the formatted value with its prefix (`R`, the diameter sign), or a
 * user override in which `<>` stands for that (`2x <>` gives `2x Ø4.5`).
 */
export function dimensionText(value: string, override: string | undefined): string {
  return override === undefined ? value : override.replaceAll('<>', value);
}
