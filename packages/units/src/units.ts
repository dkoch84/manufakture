import {
  ANGLE,
  CURRENT,
  ENERGY,
  FEED,
  FORCE,
  LENGTH,
  MASS,
  POWER,
  SPINDLE_SPEED,
  TEMPERATURE,
  TIME,
  VOLTAGE,
  makeDimension,
  type Dimension,
} from './dimension';
import { fromSI } from './si';

/** Length units a document can display in and that bare numbers can be interpreted as. */
export type LengthUnit = 'mm' | 'cm' | 'm' | 'in' | 'ft';

/** Angle units a document can display in and that bare numbers can be interpreted as. */
export type AngleUnit = 'deg' | 'rad';

export const MM_PER_INCH = 25.4;
export const MM_PER_FOOT = 304.8;
export const RAD_PER_DEG = Math.PI / 180;
/** Time is in minutes internally, so feeds are mm/min and spindle speeds rpm. */
export const SECONDS_PER_MINUTE = 60;

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
  /** Internal units (mm, rad, min, kg, A, K combined as `dimension` says) per one of this unit. */
  readonly factor: number;
  /** SI units (m, rad, s, kg, A, K) per one of this unit; compound units multiply these. */
  readonly si: number;
  readonly dimension: Dimension;
  /** Feet may be followed by an inches part (`3' 4"`); inches terminate one. */
  readonly role: 'foot' | 'inch' | 'other';
  /**
   * Whether the unit is one of the physical units (ADR 0017 decision 3) rather than a length,
   * angle or time unit that existed before them. A compound unit is read outside physical fields
   * only when it starts with one of these, since nothing could have been written that way before.
   */
  readonly physical: boolean;
  /**
   * For `degC` and `degF`: kelvin to add to the value (in kelvin) to get an absolute
   * temperature. Absent for every other unit, `K` included.
   */
  readonly offset?: number;
}

function lengthUnit(
  symbol: string,
  factor: number,
  si: number,
  role: UnitDefinition['role'] = 'other',
) {
  return { symbol, factor, si, dimension: LENGTH, role, physical: false } as const;
}

const MM = lengthUnit('mm', 1, 0.001);
const CM = lengthUnit('cm', 10, 0.01);
const M = lengthUnit('m', 1000, 1);
const INCH = lengthUnit('in', MM_PER_INCH, 0.0254, 'inch');
const FOOT = lengthUnit('ft', MM_PER_FOOT, 0.3048, 'foot');
const YARD = lengthUnit('yd', 3 * MM_PER_FOOT, 0.9144);
const DEG = {
  symbol: 'deg',
  factor: RAD_PER_DEG,
  si: RAD_PER_DEG,
  dimension: ANGLE,
  role: 'other',
  physical: false,
} as const;
const RAD = {
  symbol: 'rad',
  factor: 1,
  si: 1,
  dimension: ANGLE,
  role: 'other',
  physical: false,
} as const;
const MINUTE = {
  symbol: 'min',
  factor: 1,
  si: SECONDS_PER_MINUTE,
  dimension: TIME,
  role: 'other',
  physical: false,
} as const;
const SECOND = {
  symbol: 's',
  factor: 1 / SECONDS_PER_MINUTE,
  si: 1,
  dimension: TIME,
  role: 'other',
  physical: false,
} as const;
/** Revolutions per minute as a spindle speed: per time, no angle. */
const RPM = {
  symbol: 'rpm',
  factor: 1,
  si: 1 / SECONDS_PER_MINUTE,
  dimension: SPINDLE_SPEED,
  role: 'other',
  physical: false,
} as const;

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
  ['min', MINUTE],
  ['s', SECOND],
  ['rpm', RPM],
]);

// --- physical units (ADR 0017 decision 3) ------------------------------------------------------

/** Pound-force in newtons, by definition (0.45359237 kg times 9.80665 m/s²). */
export const LBF = 4.4482216152605;
/** Pound (avoirdupois) in kilograms. */
export const LB = 0.45359237;
/** Standard gravity in m/s². */
export const GN = 9.80665;
/** Mechanical horsepower in watts: 33000 ft·lbf/min. */
export const HP = (33000 * LBF * 0.3048) / 60;

/** A physical unit from its SI value; its internal factor follows from the dimension. */
function physicalUnit(
  symbol: string,
  si: number,
  dimension: Dimension,
  offset?: number,
): UnitDefinition {
  return {
    symbol,
    factor: fromSI(si, dimension),
    si,
    dimension,
    role: 'other',
    physical: true,
    ...(offset === undefined ? {} : { offset }),
  };
}

const ACCELERATION = makeDimension({ length: 1, time: -2 });
const OHMS = makeDimension({ mass: 1, length: 2, time: -3, current: -2 });
const HENRIES = makeDimension({ mass: 1, length: 2, time: -2, current: -2 });
const CHARGE = makeDimension({ current: 1, time: 1 });
const PRESSURE = makeDimension({ mass: 1, length: -1, time: -2 });

const PHYSICAL_UNIT_LIST: readonly [string, UnitDefinition][] = [
  // mass
  ['kg', physicalUnit('kg', 1, MASS)],
  ['g', physicalUnit('g', 0.001, MASS)],
  ['lb', physicalUnit('lb', LB, MASS)],
  ['oz', physicalUnit('oz', LB / 16, MASS)],
  // force
  ['N', physicalUnit('N', 1, FORCE)],
  ['kN', physicalUnit('kN', 1000, FORCE)],
  ['lbf', physicalUnit('lbf', LBF, FORCE)],
  ['ozf', physicalUnit('ozf', LBF / 16, FORCE)],
  ['kgf', physicalUnit('kgf', GN, FORCE)],
  // torque (`N*m`, `lbf*ft` and the rest are compound units)
  ['Nm', physicalUnit('Nm', 1, ENERGY)],
  // length and speed
  ['km', physicalUnit('km', 1000, LENGTH)],
  ['mph', physicalUnit('mph', 0.44704, FEED)],
  // acceleration
  ['gn', physicalUnit('gn', GN, ACCELERATION)],
  // power and energy
  ['W', physicalUnit('W', 1, POWER)],
  ['kW', physicalUnit('kW', 1000, POWER)],
  ['hp', physicalUnit('hp', HP, POWER)],
  ['J', physicalUnit('J', 1, ENERGY)],
  ['kJ', physicalUnit('kJ', 1000, ENERGY)],
  ['Wh', physicalUnit('Wh', 3600, ENERGY)],
  ['kWh', physicalUnit('kWh', 3.6e6, ENERGY)],
  // electrical
  ['V', physicalUnit('V', 1, VOLTAGE)],
  ['mV', physicalUnit('mV', 0.001, VOLTAGE)],
  ['kV', physicalUnit('kV', 1000, VOLTAGE)],
  ['A', physicalUnit('A', 1, CURRENT)],
  ['mA', physicalUnit('mA', 0.001, CURRENT)],
  ['ohm', physicalUnit('ohm', 1, OHMS)],
  ['Ω', physicalUnit('Ω', 1, OHMS)],
  ['mohm', physicalUnit('mohm', 0.001, OHMS)],
  ['kohm', physicalUnit('kohm', 1000, OHMS)],
  ['mΩ', physicalUnit('mΩ', 0.001, OHMS)],
  ['kΩ', physicalUnit('kΩ', 1000, OHMS)],
  ['H', physicalUnit('H', 1, HENRIES)],
  ['mH', physicalUnit('mH', 0.001, HENRIES)],
  ['uH', physicalUnit('uH', 1e-6, HENRIES)],
  ['µH', physicalUnit('µH', 1e-6, HENRIES)],
  ['C', physicalUnit('C', 1, CHARGE)],
  ['Ah', physicalUnit('Ah', 3600, CHARGE)],
  ['mAh', physicalUnit('mAh', 3.6, CHARGE)],
  // temperature: the value is the difference in kelvin, `offset` makes it absolute
  ['K', physicalUnit('K', 1, TEMPERATURE)],
  ['degC', physicalUnit('degC', 1, TEMPERATURE, 273.15)],
  ['degF', physicalUnit('degF', 5 / 9, TEMPERATURE, (459.67 * 5) / 9)],
  ['℃', physicalUnit('℃', 1, TEMPERATURE, 273.15)],
  ['℉', physicalUnit('℉', 5 / 9, TEMPERATURE, (459.67 * 5) / 9)],
  // pressure and stress
  ['Pa', physicalUnit('Pa', 1, PRESSURE)],
  ['kPa', physicalUnit('kPa', 1e3, PRESSURE)],
  ['MPa', physicalUnit('MPa', 1e6, PRESSURE)],
  ['GPa', physicalUnit('GPa', 1e9, PRESSURE)],
  ['psi', physicalUnit('psi', LBF / 0.0254 ** 2, PRESSURE)],
  ['ksi', physicalUnit('ksi', (1000 * LBF) / 0.0254 ** 2, PRESSURE)],
  ['bar', physicalUnit('bar', 1e5, PRESSURE)],
  // frequency and time
  ['Hz', physicalUnit('Hz', 1, SPINDLE_SPEED)],
  ['kHz', physicalUnit('kHz', 1000, SPINDLE_SPEED)],
  ['ms', physicalUnit('ms', 0.001, TIME)],
  ['h', physicalUnit('h', 3600, TIME)],
];

/** Physical units, matched case-sensitively (`mA` is not `MA`). */
const PHYSICAL_UNITS: ReadonlyMap<string, UnitDefinition> = new Map(PHYSICAL_UNIT_LIST);

/** `°C` and `°F`: a degree mark with the letter right after it. */
export const DEGREE_TEMPERATURE_UNITS: ReadonlyMap<string, UnitDefinition> = new Map([
  ['C', PHYSICAL_UNITS.get('degC') as UnitDefinition],
  ['F', PHYSICAL_UNITS.get('degF') as UnitDefinition],
]);

/** Revolutions per minute in a physical field: an angular speed, 2π rad per minute. */
export const RPM_ANGULAR_UNIT: UnitDefinition = {
  symbol: 'rpm',
  factor: 2 * Math.PI,
  si: (2 * Math.PI) / SECONDS_PER_MINUTE,
  dimension: makeDimension({ angle: 1, time: -1 }),
  role: 'other',
  physical: false,
};

export function lookupWordUnit(name: string): UnitDefinition | undefined {
  return PHYSICAL_UNITS.get(name) ?? WORD_UNITS.get(name.toLowerCase());
}

/** Every physical unit spelling, for documentation and tests. */
export const PHYSICAL_UNIT_NAMES: readonly string[] = PHYSICAL_UNIT_LIST.map(([name]) => name);

export const FOOT_UNIT: UnitDefinition = FOOT;
export const INCH_UNIT: UnitDefinition = INCH;
export const DEGREE_UNIT: UnitDefinition = DEG;
export const MINUTE_UNIT: UnitDefinition = MINUTE;
export const RPM_UNIT: UnitDefinition = RPM;
