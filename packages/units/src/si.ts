import { dimensionOfKind, type Dimension, type PhysicalKind, type Quantity } from './dimension';

// A `Quantity` keeps every dimension in the internal base units (mm, rad, min, kg, A, K), so
// lengths and feeds evaluate exactly as they always did; the physical kinds are converted to
// coherent SI at the boundary, here. Only length (mm against m) and time (min against s) differ,
// and the factors are applied as divisions or multiplications by exact powers of 1000 and 60,
// so a value that is exact in SI comes back exact (`22 N*m` is 22, not 21.999999999999996).

const MM_PER_M = 1000;
const S_PER_MIN = 60;

/** `v * base^e`, by exact integer powers where `e` is a whole number. */
function scale(v: number, base: number, e: number): number {
  if (e === 0) return v;
  if (Number.isInteger(e)) return e > 0 ? v * base ** e : v / base ** -e;
  return v * Math.pow(base, e);
}

/**
 * `magnitude` units of SI size `si`, in SI, rounded once: a unit smaller than 1 whose reciprocal
 * is a whole number (`mH`, `g`, `ms`) divides by it, so `10 µH` is exactly 1e-5 rather than
 * 10 * 1e-6 (9.999999999999999e-6).
 */
export function siMagnitude(magnitude: number, si: number): number {
  if (si < 1 && si > 0) {
    const reciprocal = Math.round(1 / si);
    if (Math.abs(reciprocal * si - 1) < 1e-12) return magnitude / reciprocal;
  }
  return magnitude * si;
}

/** A value of dimension `d` in internal units, in SI. */
export function toSI(value: number, d: Dimension): number {
  return scale(scale(value, MM_PER_M, -d.length), S_PER_MIN, d.time ?? 0);
}

/** An SI value of dimension `d`, in internal units. */
export function fromSI(si: number, d: Dimension): number {
  return scale(scale(si, MM_PER_M, d.length), S_PER_MIN, -(d.time ?? 0));
}

/** A `Quantity`'s value in coherent SI (m, s, kg, A, K; radians count as 1). */
export function quantityToSI(q: Quantity): number {
  return toSI(q.value, q.dimension);
}

/** The internal value of an SI value of dimension `d`. */
export function quantityFromSI(si: number, dimension: Dimension): Quantity {
  return { value: fromSI(si, dimension), dimension };
}

/**
 * A physical kind's SI value as a `Quantity`, for variable lookups: `physicalQuantity('force',
 * 890)`. A `temperature` (kelvin) is marked `absolute: true`, a `temperatureDelta`
 * `absolute: false` (a known difference).
 */
export function physicalQuantity(kind: PhysicalKind, si: number): Quantity {
  const dimension = dimensionOfKind(kind);
  const q = { value: fromSI(si, dimension), dimension };
  if (kind === 'temperature') return { ...q, absolute: true };
  if (kind === 'temperatureDelta') return { ...q, absolute: false };
  return q;
}
