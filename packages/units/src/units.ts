import { ANGLE, LENGTH, type Dimension } from './dimension';

/** Length units a document can display in and that bare numbers can be interpreted as. */
export type LengthUnit = 'mm' | 'cm' | 'm' | 'in' | 'ft';

/** Angle units a document can display in and that bare numbers can be interpreted as. */
export type AngleUnit = 'deg' | 'rad';

export const MM_PER_INCH = 25.4;
export const MM_PER_FOOT = 304.8;
export const RAD_PER_DEG = Math.PI / 180;

const LENGTH_FACTORS: Readonly<Record<LengthUnit, number>> = {
  mm: 1,
  cm: 10,
  m: 1000,
  in: MM_PER_INCH,
  ft: MM_PER_FOOT,
};

const ANGLE_FACTORS: Readonly<Record<AngleUnit, number>> = {
  deg: RAD_PER_DEG,
  rad: 1,
};

/** Millimetres per one `unit`. */
export function lengthUnitFactor(unit: LengthUnit): number {
  return LENGTH_FACTORS[unit];
}

/** Radians per one `unit`. */
export function angleUnitFactor(unit: AngleUnit): number {
  return ANGLE_FACTORS[unit];
}

/** Converts `value` expressed in `unit` to millimetres. */
export function toMillimetres(value: number, unit: LengthUnit): number {
  return value * LENGTH_FACTORS[unit];
}

/** Converts millimetres to `unit`. */
export function fromMillimetres(mm: number, unit: LengthUnit): number {
  return mm / LENGTH_FACTORS[unit];
}

/** Converts `value` expressed in `unit` to radians. */
export function toRadians(value: number, unit: AngleUnit): number {
  return value * ANGLE_FACTORS[unit];
}

/** Converts radians to `unit`. */
export function fromRadians(rad: number, unit: AngleUnit): number {
  return rad / ANGLE_FACTORS[unit];
}

/** A unit as it can appear in input text. */
export interface UnitDefinition {
  /** Canonical spelling, for messages. */
  readonly symbol: string;
  /** Internal units (mm or rad) per one of this unit. */
  readonly factor: number;
  readonly dimension: Dimension;
  /** Feet may be followed by an inches part (`3' 4"`); inches terminate one. */
  readonly role: 'foot' | 'inch' | 'other';
}

function lengthUnit(symbol: string, factor: number, role: UnitDefinition['role'] = 'other') {
  return { symbol, factor, dimension: LENGTH, role } as const;
}

const MM = lengthUnit('mm', 1);
const CM = lengthUnit('cm', 10);
const M = lengthUnit('m', 1000);
const INCH = lengthUnit('in', MM_PER_INCH, 'inch');
const FOOT = lengthUnit('ft', MM_PER_FOOT, 'foot');
const YARD = lengthUnit('yd', 3 * MM_PER_FOOT);
const DEG = { symbol: 'deg', factor: RAD_PER_DEG, dimension: ANGLE, role: 'other' } as const;
const RAD = { symbol: 'rad', factor: 1, dimension: ANGLE, role: 'other' } as const;

/** Word units, matched case-insensitively. */
const WORD_UNITS: ReadonlyMap<string, UnitDefinition> = new Map<string, UnitDefinition>([
  ['mm', MM],
  ['cm', CM],
  ['m', M],
  ['in', INCH],
  ['inch', INCH],
  ['inches', INCH],
  ['ft', FOOT],
  ['foot', FOOT],
  ['feet', FOOT],
  ['yd', YARD],
  ['deg', DEG],
  ['rad', RAD],
]);

export function lookupWordUnit(name: string): UnitDefinition | undefined {
  return WORD_UNITS.get(name.toLowerCase());
}

export const FOOT_UNIT: UnitDefinition = FOOT;
export const INCH_UNIT: UnitDefinition = INCH;
export const DEGREE_UNIT: UnitDefinition = DEG;
