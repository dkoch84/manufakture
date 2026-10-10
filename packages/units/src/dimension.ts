/**
 * Physical dimension of a value as exponents of the base quantities the app cares about.
 * A length is `{ length: 1, angle: 0 }`, an area `{ length: 2, angle: 0 }`, a plain number
 * `{ length: 0, angle: 0 }`, a feed `{ length: 1, angle: 0, time: -1 }`, a force
 * `{ length: 1, angle: 0, time: -2, mass: 1 }`. Exponents may be fractional in intermediate
 * results (`sqrt(length)`).
 *
 * `time`, `mass`, `current` and `temperature` are optional and absent means 0, so dimensions
 * written before they existed stay valid. The package sets them only when they are not zero.
 */
export interface Dimension {
  readonly length: number;
  readonly angle: number;
  readonly time?: number;
  readonly mass?: number;
  readonly current?: number;
  readonly temperature?: number;
}

/**
 * A value in internal units together with its dimension. Internal units are the base units
 * millimetre, radian, minute, kilogram, ampere and kelvin, combined as the dimension says (a
 * force is kg·mm/min²); `quantityToSI` gives the SI value.
 */
export interface Quantity {
  readonly value: number;
  readonly dimension: Dimension;
  /**
   * For a temperature: `true` an absolute temperature, `false` a temperature difference. Absent,
   * a kelvin value that can be either.
   */
  readonly absolute?: boolean;
}

/** The kinds that existed before the physical ones: geometry, CAM and plain numbers. */
export type GeometricKind = 'length' | 'angle' | 'feed' | 'spindleSpeed' | 'number';

/**
 * The physical kinds (ADR 0017 decision 3). Their values evaluate to coherent SI, bare numbers
 * are an error in their fields, and their comparison ignores the angle exponent (rad = 1).
 */
export type PhysicalKind =
  | 'mass'
  | 'force'
  | 'torque'
  | 'speed'
  | 'angularSpeed'
  | 'acceleration'
  | 'power'
  | 'energy'
  | 'voltage'
  | 'current'
  | 'resistance'
  | 'inductance'
  | 'charge'
  | 'temperature'
  | 'temperatureDelta'
  | 'pressure'
  | 'stiffness'
  | 'rotationalStiffness'
  | 'inertia'
  | 'frequency'
  | 'time'
  | 'torqueConstant'
  | 'velocityConstant'
  | 'thermalResistance'
  | 'heatCapacity'
  | 'linearDensity';

/** What the caller expects an input to evaluate to. */
export type QuantityKind = GeometricKind | PhysicalKind;

const EPSILON = 1e-9;

function sameExponent(a: number, b: number): boolean {
  return Math.abs(a - b) < EPSILON;
}

/** The optional exponents, in the order they are written. */
const OPTIONAL = ['time', 'mass', 'current', 'temperature'] as const;
type OptionalBase = (typeof OPTIONAL)[number];
type Exponents = Record<'length' | 'angle' | OptionalBase, number>;

function exponents(d: Dimension): Exponents {
  return {
    length: d.length,
    angle: d.angle,
    time: d.time ?? 0,
    mass: d.mass ?? 0,
    current: d.current ?? 0,
    temperature: d.temperature ?? 0,
  };
}

/**
 * Builds a dimension, leaving out the optional exponents that are zero, so lengths and angles
 * look as before.
 */
function build(e: Exponents): Dimension {
  const d: { -readonly [K in keyof Dimension]: Dimension[K] } = {
    length: e.length,
    angle: e.angle,
  };
  for (const k of OPTIONAL) if (!sameExponent(e[k], 0)) d[k] = e[k];
  return d;
}

function combine(a: Dimension, b: Dimension, f: (x: number, y: number) => number): Dimension {
  const x = exponents(a);
  const y = exponents(b);
  return build({
    length: f(x.length, y.length),
    angle: f(x.angle, y.angle),
    time: f(x.time, y.time),
    mass: f(x.mass, y.mass),
    current: f(x.current, y.current),
    temperature: f(x.temperature, y.temperature),
  });
}

/** A dimension from its exponents; omitted ones are 0. */
export function makeDimension(e: Partial<Exponents>): Dimension {
  return Object.freeze(
    build({
      length: e.length ?? 0,
      angle: e.angle ?? 0,
      time: e.time ?? 0,
      mass: e.mass ?? 0,
      current: e.current ?? 0,
      temperature: e.temperature ?? 0,
    }),
  );
}

export const DIMENSIONLESS: Dimension = Object.freeze({ length: 0, angle: 0 });
export const LENGTH: Dimension = Object.freeze({ length: 1, angle: 0 });
export const ANGLE: Dimension = Object.freeze({ length: 0, angle: 1 });
/** Time, in minutes internally. */
export const TIME: Dimension = Object.freeze({ length: 0, angle: 0, time: 1 });
/** Length per time: a feed rate, in mm/min internally. */
export const FEED: Dimension = Object.freeze({ length: 1, angle: 0, time: -1 });
/** Per time: a spindle speed, in rpm internally (revolutions are not a dimension). */
export const SPINDLE_SPEED: Dimension = Object.freeze({ length: 0, angle: 0, time: -1 });
export const MASS: Dimension = makeDimension({ mass: 1 });
export const CURRENT: Dimension = makeDimension({ current: 1 });
export const TEMPERATURE: Dimension = makeDimension({ temperature: 1 });
export const FORCE: Dimension = makeDimension({ mass: 1, length: 1, time: -2 });
/** Torque and energy: mass·length²/time². */
export const ENERGY: Dimension = makeDimension({ mass: 1, length: 2, time: -2 });
export const POWER: Dimension = makeDimension({ mass: 1, length: 2, time: -3 });
export const VOLTAGE: Dimension = makeDimension({ mass: 1, length: 2, time: -3, current: -1 });

/** Dimension of each physical kind, as SI writes it (an angular speed is rad/s). */
const PHYSICAL_DIMENSIONS: Readonly<Record<PhysicalKind, Dimension>> = {
  mass: MASS,
  force: FORCE,
  torque: ENERGY,
  speed: FEED,
  angularSpeed: makeDimension({ angle: 1, time: -1 }),
  acceleration: makeDimension({ length: 1, time: -2 }),
  power: POWER,
  energy: ENERGY,
  voltage: VOLTAGE,
  current: CURRENT,
  resistance: makeDimension({ mass: 1, length: 2, time: -3, current: -2 }),
  inductance: makeDimension({ mass: 1, length: 2, time: -2, current: -2 }),
  charge: makeDimension({ current: 1, time: 1 }),
  temperature: TEMPERATURE,
  temperatureDelta: TEMPERATURE,
  pressure: makeDimension({ mass: 1, length: -1, time: -2 }),
  stiffness: makeDimension({ mass: 1, time: -2 }),
  rotationalStiffness: makeDimension({ mass: 1, length: 2, time: -2, angle: -1 }),
  inertia: makeDimension({ mass: 1, length: 2 }),
  frequency: SPINDLE_SPEED,
  time: TIME,
  torqueConstant: makeDimension({ mass: 1, length: 2, time: -2, current: -1 }),
  velocityConstant: makeDimension({ angle: 1, mass: -1, length: -2, time: 2, current: 1 }),
  thermalResistance: makeDimension({ temperature: 1, mass: -1, length: -2, time: 3 }),
  heatCapacity: makeDimension({ mass: 1, length: 2, time: -2, temperature: -1 }),
  linearDensity: makeDimension({ mass: 1, length: -1 }),
};

/** Every physical kind, in the order the README lists them. */
export const PHYSICAL_KINDS: readonly PhysicalKind[] = [
  'mass',
  'force',
  'torque',
  'energy',
  'speed',
  'angularSpeed',
  'acceleration',
  'power',
  'voltage',
  'current',
  'resistance',
  'inductance',
  'charge',
  'temperature',
  'temperatureDelta',
  'pressure',
  'stiffness',
  'rotationalStiffness',
  'inertia',
  'frequency',
  'time',
  'torqueConstant',
  'velocityConstant',
  'thermalResistance',
  'heatCapacity',
  'linearDensity',
];

export function isPhysicalKind(kind: string): kind is PhysicalKind {
  return Object.prototype.hasOwnProperty.call(PHYSICAL_DIMENSIONS, kind);
}

export function dimensionsEqual(a: Dimension, b: Dimension): boolean {
  const x = exponents(a);
  const y = exponents(b);
  return (
    sameExponent(x.length, y.length) &&
    sameExponent(x.angle, y.angle) &&
    sameExponent(x.time, y.time) &&
    sameExponent(x.mass, y.mass) &&
    sameExponent(x.current, y.current) &&
    sameExponent(x.temperature, y.temperature)
  );
}

/** Equal apart from the angle exponent: SI's rad = 1, as physical kinds compare. */
export function dimensionsEqualIgnoringAngle(a: Dimension, b: Dimension): boolean {
  return dimensionsEqual({ ...a, angle: 0 }, { ...b, angle: 0 });
}

export function isDimensionless(d: Dimension): boolean {
  return dimensionsEqual(d, DIMENSIONLESS);
}

/** Whether a dimension has a mass, current or temperature exponent (one only physical kinds have). */
export function hasPhysicalBase(d: Dimension): boolean {
  return (
    !sameExponent(d.mass ?? 0, 0) ||
    !sameExponent(d.current ?? 0, 0) ||
    !sameExponent(d.temperature ?? 0, 0)
  );
}

/** Exactly a temperature (kelvin to the first power and nothing else). */
export function isTemperature(d: Dimension): boolean {
  return dimensionsEqual(d, TEMPERATURE);
}

export function multiplyDimensions(a: Dimension, b: Dimension): Dimension {
  return combine(a, b, (x, y) => x + y);
}

export function divideDimensions(a: Dimension, b: Dimension): Dimension {
  return combine(a, b, (x, y) => x - y);
}

export function powerDimension(d: Dimension, exponent: number): Dimension {
  return combine(d, DIMENSIONLESS, (x) => x * exponent);
}

export function dimensionOfKind(kind: QuantityKind): Dimension {
  switch (kind) {
    case 'length':
      return LENGTH;
    case 'angle':
      return ANGLE;
    case 'feed':
      return FEED;
    case 'spindleSpeed':
      return SPINDLE_SPEED;
    case 'number':
      return DIMENSIONLESS;
    default:
      return PHYSICAL_DIMENSIONS[kind];
  }
}

/** A millimetre length as a `Quantity`, for variable lookups. */
export function lengthQuantity(mm: number): Quantity {
  return { value: mm, dimension: LENGTH };
}

/** A radian angle as a `Quantity`, for variable lookups. */
export function angleQuantity(rad: number): Quantity {
  return { value: rad, dimension: ANGLE };
}

/** A time in minutes as a `Quantity`, for variable lookups. */
export function timeQuantity(minutes: number): Quantity {
  return { value: minutes, dimension: TIME };
}

/** A feed rate in mm/min as a `Quantity`, for variable lookups. */
export function feedQuantity(mmPerMinute: number): Quantity {
  return { value: mmPerMinute, dimension: FEED };
}

/** A spindle speed in rpm as a `Quantity`, for variable lookups. */
export function spindleSpeedQuantity(rpm: number): Quantity {
  return { value: rpm, dimension: SPINDLE_SPEED };
}

/** A dimensionless number as a `Quantity`, for variable lookups. */
export function numberQuantity(value: number): Quantity {
  return { value, dimension: DIMENSIONLESS };
}

function formatExponent(e: number): string {
  const rounded = Math.round(e * 1e6) / 1e6;
  return String(rounded);
}

function power(name: string, exponent: number): string {
  return sameExponent(exponent, 1) ? name : `${name}^${formatExponent(exponent)}`;
}

const KIND_NAMES: Readonly<Record<PhysicalKind, string>> = {
  mass: 'a mass',
  force: 'a force',
  torque: 'a torque',
  speed: 'a speed',
  angularSpeed: 'an angular speed',
  acceleration: 'an acceleration',
  power: 'a power',
  energy: 'an energy',
  voltage: 'a voltage',
  current: 'a current',
  resistance: 'a resistance',
  inductance: 'an inductance',
  charge: 'a charge',
  temperature: 'a temperature',
  temperatureDelta: 'a temperature difference',
  pressure: 'a pressure',
  stiffness: 'a stiffness',
  rotationalStiffness: 'a rotational stiffness',
  inertia: 'a moment of inertia',
  frequency: 'a frequency',
  time: 'a time',
  torqueConstant: 'a torque constant',
  velocityConstant: 'a velocity constant',
  thermalResistance: 'a thermal resistance',
  heatCapacity: 'a heat capacity',
  linearDensity: 'a linear density',
};

/** Human-readable name of what a kind expects, with an article: "a force", "a length". */
export function describeKind(kind: QuantityKind): string {
  return isPhysicalKind(kind) ? KIND_NAMES[kind] : describeDimension(dimensionOfKind(kind));
}

/** Names of the physical kinds of exactly this dimension: "a torque or an energy". */
function physicalName(d: Dimension): string | undefined {
  const names = PHYSICAL_KINDS.filter(
    (k) => k !== 'temperatureDelta' && dimensionsEqual(PHYSICAL_DIMENSIONS[k], d),
  ).map((k) => KIND_NAMES[k]);
  return names.length === 0 ? undefined : names.join(' or ');
}

/** Human-readable name of a dimension with an article, e.g. "a length", "an area", "length^4". */
export function describeDimension(d: Dimension): string {
  const l = d.length;
  const t = d.time ?? 0;
  if (hasPhysicalBase(d)) {
    const name = physicalName(d);
    if (name !== undefined) return name;
    const e = exponents(d);
    const parts: string[] = [];
    for (const k of ['length', 'angle', 'time', 'mass', 'current', 'temperature'] as const) {
      if (!sameExponent(e[k], 0)) parts.push(power(k, e[k]));
    }
    return `a value of dimension ${parts.join('*')}`;
  }
  if (!sameExponent(t, 0)) {
    if (dimensionsEqual(d, TIME)) return 'a time';
    if (dimensionsEqual(d, FEED)) return 'a feed rate (length/time)';
    if (dimensionsEqual(d, SPINDLE_SPEED)) return 'a spindle speed (1/time)';
    const parts: string[] = [];
    if (!sameExponent(l, 0)) parts.push(power('length', l));
    if (!sameExponent(d.angle, 0)) parts.push(power('angle', d.angle));
    parts.push(power('time', t));
    return `a value of dimension ${parts.join('*')}`;
  }
  if (sameExponent(d.angle, 0)) {
    if (sameExponent(l, 0)) return 'a number';
    if (sameExponent(l, 1)) return 'a length';
    if (sameExponent(l, 2)) return 'an area (length^2)';
    if (sameExponent(l, 3)) return 'a volume (length^3)';
  }
  if (sameExponent(l, 0) && sameExponent(d.angle, 1)) return 'an angle';
  const parts: string[] = [];
  if (!sameExponent(l, 0))
    parts.push(sameExponent(l, 1) ? 'length' : `length^${formatExponent(l)}`);
  if (!sameExponent(d.angle, 0)) {
    parts.push(sameExponent(d.angle, 1) ? 'angle' : `angle^${formatExponent(d.angle)}`);
  }
  return `a value of dimension ${parts.join('*')}`;
}
