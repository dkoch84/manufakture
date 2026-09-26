/**
 * Physical dimension of a value as exponents of the two base quantities the app cares about.
 * A length is `{ length: 1, angle: 0 }`, an area `{ length: 2, angle: 0 }`, a plain number
 * `{ length: 0, angle: 0 }`. Exponents may be fractional in intermediate results (`sqrt(length)`).
 */
export interface Dimension {
  readonly length: number;
  readonly angle: number;
}

/** A value in internal units (millimetres, radians) together with its dimension. */
export interface Quantity {
  readonly value: number;
  readonly dimension: Dimension;
}

/** What the caller expects an input to evaluate to. */
export type QuantityKind = 'length' | 'angle' | 'number';

export const DIMENSIONLESS: Dimension = Object.freeze({ length: 0, angle: 0 });
export const LENGTH: Dimension = Object.freeze({ length: 1, angle: 0 });
export const ANGLE: Dimension = Object.freeze({ length: 0, angle: 1 });

const EPSILON = 1e-9;

function sameExponent(a: number, b: number): boolean {
  return Math.abs(a - b) < EPSILON;
}

export function dimensionsEqual(a: Dimension, b: Dimension): boolean {
  return sameExponent(a.length, b.length) && sameExponent(a.angle, b.angle);
}

export function isDimensionless(d: Dimension): boolean {
  return dimensionsEqual(d, DIMENSIONLESS);
}

export function multiplyDimensions(a: Dimension, b: Dimension): Dimension {
  return { length: a.length + b.length, angle: a.angle + b.angle };
}

export function divideDimensions(a: Dimension, b: Dimension): Dimension {
  return { length: a.length - b.length, angle: a.angle - b.angle };
}

export function powerDimension(d: Dimension, exponent: number): Dimension {
  return { length: d.length * exponent, angle: d.angle * exponent };
}

export function dimensionOfKind(kind: QuantityKind): Dimension {
  switch (kind) {
    case 'length':
      return LENGTH;
    case 'angle':
      return ANGLE;
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

/** A dimensionless number as a `Quantity`, for variable lookups. */
export function numberQuantity(value: number): Quantity {
  return { value, dimension: DIMENSIONLESS };
}

function formatExponent(e: number): string {
  const rounded = Math.round(e * 1e6) / 1e6;
  return String(rounded);
}

/** Human-readable name of a dimension with an article, e.g. "a length", "an area", "length^4". */
export function describeDimension(d: Dimension): string {
  const l = d.length;
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
