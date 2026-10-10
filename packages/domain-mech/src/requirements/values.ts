// Reading the expressions of requirements and load cases (ADR 0017 decision 10) as numbers: every
// value in coherent SI (metres, seconds, newtons, kelvin), whatever kind core gives the site. A
// length or an angle site keeps the old parse mode (bare numbers in the stored display unit) and
// is turned into metres or radians here; a physical site is read in the physical mode, where a
// bare number is an error.

import type { MechExpressionKind, StoredExpression } from '@manufakture/core';
import {
  dimensionsEqualIgnoringAngle,
  describeDimension,
  evaluate,
  evaluateQuantity,
  quantityToSI,
  type Dimension,
  type VariableLookup,
} from '@manufakture/units';

/** A value in SI, or why there is none. */
export type SiResult = { ok: true; value: number } | { ok: false; message: string };

/** What went wrong with one field, by its path from the item (`['dynamic', 'force']`). */
export interface ItemProblem {
  path: readonly (string | number)[];
  message: string;
}

/** No variables: every variable reference is an error. */
export const NO_VARIABLES: VariableLookup = () => undefined;

/**
 * One expression in SI: lengths in metres, angles in radians, plain numbers as they are, a
 * physical kind in its SI unit. A site of kind `any` takes `dimension` (any dimension when absent).
 */
export function siValue(
  expr: StoredExpression,
  kind: MechExpressionKind,
  variables: VariableLookup,
  dimension?: { dimension: Dimension; unit: string },
): SiResult {
  if (kind === 'any') {
    const q = evaluateQuantity(expr.source, {
      physical: true,
      lengthUnit: expr.lengthUnit,
      angleUnit: expr.angleUnit,
      variables,
    });
    if (!q.ok) return { ok: false, message: q.error.message };
    if (
      dimension !== undefined &&
      !dimensionsEqualIgnoringAngle(q.value.dimension, dimension.dimension)
    ) {
      return {
        ok: false,
        message: `Expected ${dimension.unit} (${describeDimension(dimension.dimension)}) but got ${describeDimension(q.value.dimension)}`,
      };
    }
    const si = quantityToSI(q.value);
    return Number.isFinite(si)
      ? { ok: true, value: si }
      : { ok: false, message: 'Result is not a finite number' };
  }
  const r = evaluate(expr.source, {
    expected: kind,
    lengthUnit: expr.lengthUnit,
    angleUnit: expr.angleUnit,
    variables,
  });
  if (!r.ok) return { ok: false, message: r.error.message };
  // Lengths come back in millimetres; every other kind already in its working unit.
  const value = kind === 'length' ? r.value / 1000 : r.value;
  return Number.isFinite(value)
    ? { ok: true, value }
    : { ok: false, message: 'Result is not a finite number' };
}

/** Collects problems while reading a item's fields. */
export class FieldReader {
  readonly problems: ItemProblem[] = [];
  constructor(private readonly variables: VariableLookup) {}

  /**
   * A field's SI value, with a range check: `min`/`max` inclusive, `above` exclusive. A problem is
   * recorded (and NaN returned) when it does not evaluate or is out of range.
   */
  read(
    path: readonly (string | number)[],
    expr: StoredExpression,
    kind: MechExpressionKind,
    range: { min?: number; above?: number; max?: number; integer?: boolean; what?: string } = {},
    dimension?: { dimension: Dimension; unit: string },
  ): number {
    const r = siValue(expr, kind, this.variables, dimension);
    if (!r.ok) {
      this.problems.push({ path, message: r.message });
      return Number.NaN;
    }
    const v = r.value;
    const what = range.what ?? 'it';
    const refuse = (message: string) => {
      this.problems.push({ path, message });
      return Number.NaN;
    };
    if (range.integer === true && !Number.isInteger(v))
      return refuse(`${what} must be a whole number`);
    if (range.above !== undefined && !(v > range.above))
      return refuse(`${what} must be above ${range.above}`);
    if (range.min !== undefined && v < range.min)
      return refuse(`${what} must be at least ${range.min}`);
    if (range.max !== undefined && v > range.max)
      return refuse(`${what} must be at most ${range.max}`);
    return v;
  }

  problem(path: readonly (string | number)[], message: string): void {
    this.problems.push({ path, message });
  }
}
