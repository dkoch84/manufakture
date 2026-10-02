/**
 * Physical dimension of a value as exponents of the base quantities the app cares about.
 * A length is `{ length: 1, angle: 0 }`, an area `{ length: 2, angle: 0 }`, a plain number
 * `{ length: 0, angle: 0 }`, a feed `{ length: 1, angle: 0, time: -1 }`. Exponents may be
 * fractional in intermediate results (`sqrt(length)`).
 *
 * `time` is optional and absent means 0, so dimensions written before it existed stay valid. The
 * package sets it only when it is not zero.
 */
export interface Dimension {
  readonly length: number;
  readonly angle: number;
  readonly time?: number;
}

/** A value in internal units (millimetres, radians, minutes) together with its dimension. */
export interface Quantity {
  readonly value: number;
  readonly dimension: Dimension;
}

/** What the caller expects an input to evaluate to. */
export type QuantityKind = 'length' | 'angle' | 'feed' | 'spindleSpeed' | 'number';

export const DIMENSIONLESS: Dimension = Object.freeze({ length: 0, angle: 0 });
export const LENGTH: Dimension = Object.freeze({ length: 1, angle: 0 });
export const ANGLE: Dimension = Object.freeze({ length: 0, angle: 1 });
/** Time, in minutes internally. */
export const TIME: Dimension = Object.freeze({ length: 0, angle: 0, time: 1 });
/** Length per time: a feed rate, in mm/min internally. */
export const FEED: Dimension = Object.freeze({ length: 1, angle: 0, time: -1 });
/** Per time: a spindle speed, in rpm internally (revolutions are not a dimension). */
export const SPINDLE_SPEED: Dimension = Object.freeze({ length: 0, angle: 0, time: -1 });

const EPSILON = 1e-9;

function sameExponent(a: number, b: number): boolean {
  return Math.abs(a - b) < EPSILON;
}

function timeOf(d: Dimension): number {
  return d.time ?? 0;
}

/** Builds a dimension, leaving `time` out when it is zero so lengths and angles look as before. */
function dimension(length: number, angle: number, time: number): Dimension {
  return sameExponent(time, 0) ? { length, angle } : { length, angle, time };
}

export function dimensionsEqual(a: Dimension, b: Dimension): boolean {
  return (
    sameExponent(a.length, b.length) &&
    sameExponent(a.angle, b.angle) &&
    sameExponent(timeOf(a), timeOf(b))
  );
}

export function isDimensionless(d: Dimension): boolean {
  return dimensionsEqual(d, DIMENSIONLESS);
}

export function multiplyDimensions(a: Dimension, b: Dimension): Dimension {
  return dimension(a.length + b.length, a.angle + b.angle, timeOf(a) + timeOf(b));
}

export function divideDimensions(a: Dimension, b: Dimension): Dimension {
  return dimension(a.length - b.length, a.angle - b.angle, timeOf(a) - timeOf(b));
}

export function powerDimension(d: Dimension, exponent: number): Dimension {
  return dimension(d.length * exponent, d.angle * exponent, timeOf(d) * exponent);
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

/** Human-readable name of a dimension with an article, e.g. "a length", "an area", "length^4". */
export function describeDimension(d: Dimension): string {
  const l = d.length;
  const t = timeOf(d);
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
