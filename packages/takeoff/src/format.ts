// Takeoff values for display, in the document's display units (ADR 0005), through
// `@manufakture/units`: lengths as the document formats them (`3' 4-1/2"`, `40-1/2"`, `1028.70 mm`),
// areas in square feet or square metres, volumes in cubic inches or cubic centimetres.

import { MM_PER_INCH, formatLength, formatNumber, type LengthFormat } from '@manufakture/units';
import type { TakeoffMeasure, TakeoffRow, TakeoffSize, TakeoffUnit } from './takeoff';

/** Whether a display format is an inch or foot one (areas in sq ft, volumes in in³). */
export function isImperial(format: LengthFormat): boolean {
  return (
    format.unit === 'in' ||
    format.unit === 'ft' ||
    format.unit === 'ft-in' ||
    format.unit === 'in-fraction'
  );
}

const MM2_PER_SQ_FT = (12 * MM_PER_INCH) ** 2;
const MM3_PER_CU_IN = MM_PER_INCH ** 3;

/**
 * One piece's size: `72" x 11-1/4" x 23/32"` for a board (length, width, thickness), `Ø8 mm x
 * 32 mm` for a dowel. Empty when the size has no field.
 */
export function formatSize(size: TakeoffSize | undefined, format: LengthFormat): string {
  if (size === undefined) return '';
  const parts: string[] = [];
  if (size.diameter !== undefined) parts.push(`Ø${formatLength(size.diameter, format)}`);
  for (const k of ['length', 'width', 'thickness'] as const) {
    const v = size[k];
    if (v !== undefined) parts.push(formatLength(v, format));
  }
  return parts.join(' x ');
}

/** A count without trailing zeros: `4`, `2.5`, `0.33`. */
function count(value: number, decimals: number): string {
  const text = formatNumber(value, decimals);
  return text.includes('.') ? text.replace(/\.?0+$/, '') : text;
}

/**
 * An amount in its unit: `5.33 bd ft`, `11.25 sq ft` or `1.045 m²`, a length as the document
 * formats it, `4 pcs`, `2.5 sheets`.
 */
export function formatMeasure(measure: TakeoffMeasure, format: LengthFormat): string {
  const { unit, value } = measure;
  switch (unit) {
    case 'board-foot':
      return `${formatNumber(value, 2)} bd ft`;
    case 'area':
      return isImperial(format)
        ? `${formatNumber(value / MM2_PER_SQ_FT, 2)} sq ft`
        : `${formatNumber(value / 1e6, 3)} m²`;
    case 'volume':
      return isImperial(format)
        ? `${formatNumber(value / MM3_PER_CU_IN, 1)} in³`
        : `${formatNumber(value / 1e3, 0)} cm³`;
    case 'length':
      return formatLength(value, format);
    case 'sheet':
      return `${count(value, 2)} ${value === 1 ? 'sheet' : 'sheets'}`;
    case 'each':
      return `${count(value, 2)} pcs`;
  }
}

/** The label of a unit as a column heading. */
export const UNIT_LABELS: Readonly<Record<TakeoffUnit, string>> = {
  'board-foot': 'Board feet',
  area: 'Area',
  sheet: 'Sheets',
  length: 'Length',
  volume: 'Volume',
  each: 'Pieces',
};

/** A row's cells as text, for a table or a CSV file. */
export interface FormattedRow {
  item: string;
  stock: string;
  size: string;
  quantity: string;
  extended: string;
  measures: string[];
}

/** A row as text in the document's display units. `stockName` names a stock id (default: the id). */
export function formatRow(
  row: TakeoffRow,
  format: LengthFormat,
  stockName: (id: string) => string = (id) => id,
): FormattedRow {
  return {
    item: row.item,
    stock: row.stock === undefined ? '' : stockName(row.stock),
    size: formatSize(row.size, format),
    quantity: count(row.quantity, 2),
    extended: formatMeasure({ unit: row.unit, value: row.extended }, format),
    measures: row.measures.map((m) => formatMeasure(m, format)),
  };
}
