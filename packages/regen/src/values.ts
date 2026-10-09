// Numbers: every StoredExpression is evaluated here, with `@manufakture/units`, in the units it
// was stored with (ADR 0005). Core only checks that expressions parse and name variables that
// exist; the dimension check against the kind each field expects (`featureExpressions`) is
// regen's, and a mismatch is an `expression` error on the feature, with the units error's range.

import {
  featureExpressions,
  measurementLookup,
  variableOrder,
  type Feature,
  type Measurement,
  type StoredExpression,
  type Variable,
} from '@manufakture/core';
import { evaluate, evaluateQuantity, type Quantity, type UnitsError } from '@manufakture/units';
import type { FieldPath, RegenError } from './types';

export interface VariableValues {
  /** Values of the variables that evaluated, in internal units. */
  readonly values: ReadonlyMap<string, Quantity>;
  /** Variables that did not evaluate, with why (a variable reading a failed one fails too). */
  readonly errors: ReadonlyMap<string, UnitsError>;
  /** The values as a plain record, for the sketch solver. */
  readonly record: Readonly<Record<string, Quantity>>;
  /**
   * The measurements `distance(...)` and `angle(...)` read (#1202), as given; empty when none
   * were.
   */
  readonly measurements: readonly Measurement[];
}

/**
 * Evaluate the variables table in dependency order. Variables have no declared kind. A variable
 * that measures the model reads `measurements` (regen makes them, `RegenResult.measurements`
 * carries them to clients); without one for its call it is a `measure` error.
 */
export function evaluateVariables(
  variables: readonly Variable[],
  measurements: readonly Measurement[] = [],
): VariableValues {
  const measure = measurementLookup(measurements);
  const values = new Map<string, Quantity>();
  const errors = new Map<string, UnitsError>();
  const order = variableOrder(variables);
  const byName = new Map(variables.map((v) => [v.name, v]));
  if (!order.ok) {
    // Core refuses cycles, so a stored document never has one; fail them all rather than guess.
    for (const v of variables) {
      errors.set(v.name, {
        code: 'syntax',
        message: order.error.message,
        start: 0,
        end: v.expression.source.length,
      });
    }
  } else {
    for (const name of order.value) {
      const v = byName.get(name);
      if (!v) continue;
      const r = evaluateQuantity(v.expression.source, {
        lengthUnit: v.expression.lengthUnit,
        angleUnit: v.expression.angleUnit,
        variables: (n) => values.get(n),
        measure,
      });
      if (r.ok) values.set(name, r.value);
      else errors.set(name, r.error);
    }
  }
  const record: Record<string, Quantity> = {};
  for (const [k, v] of values) record[k] = v;
  return { values, errors, record, measurements };
}

/** A field path as a map key: `extent.distance`, `constraints.3.value`. */
export function pathKey(path: FieldPath): string {
  return path.join('.');
}

export interface FeatureValues {
  /** Evaluated values by `pathKey`: millimetres, radians or plain numbers. */
  readonly values: ReadonlyMap<string, number>;
  readonly errors: RegenError[];
}

/** Evaluate one expression as `expected`, turning failures into a feature error. */
export function evaluateField(
  expression: StoredExpression,
  expected: 'length' | 'angle' | 'number' | 'feed' | 'spindleSpeed',
  field: FieldPath,
  variables: VariableValues,
  options: { readonly slope?: boolean } = {},
): { ok: true; value: number } | { ok: false; error: RegenError } {
  const r = evaluate(expression.source, {
    expected,
    ...(options.slope === true ? { slope: true } : {}),
    lengthUnit: expression.lengthUnit,
    angleUnit: expression.angleUnit,
    variables: (n) => variables.values.get(n),
  });
  if (r.ok) return r;
  const error = r.error;
  if (error.code === 'unknown-variable') {
    // The variable exists but did not evaluate: say so, rather than "unknown".
    const name = expression.source.slice(error.start, error.end).replace(/^#/, '');
    const cause = variables.errors.get(name);
    if (cause) {
      return {
        ok: false,
        error: {
          code: 'expression',
          message: `Variable "${name}" does not evaluate: ${cause.message}`,
          field,
          error,
          variable: name,
        },
      };
    }
  }
  return {
    ok: false,
    error: {
      code: 'expression',
      message: `${field.join('.')}: ${error.message}`,
      field,
      error,
    },
  };
}

/**
 * Evaluate every expression of a feature against the kind its field expects. Extension
 * expressions (`any`) are evaluated without a kind and kept as plain numbers in internal units.
 */
export function evaluateFeature(feature: Feature, variables: VariableValues): FeatureValues {
  const values = new Map<string, number>();
  const errors: RegenError[] = [];
  for (const site of featureExpressions(feature)) {
    if (site.expected === 'any') {
      const r = evaluateQuantity(site.expression.source, {
        lengthUnit: site.expression.lengthUnit,
        angleUnit: site.expression.angleUnit,
        variables: (n) => variables.values.get(n),
      });
      if (r.ok) values.set(pathKey(site.path), r.value.value);
      else {
        errors.push({
          code: 'expression',
          message: `${site.path.join('.')}: ${r.error.message}`,
          field: site.path,
          error: r.error,
        });
      }
      continue;
    }
    const r = evaluateField(site.expression, site.expected, site.path, variables);
    if (r.ok) values.set(pathKey(site.path), r.value);
    else errors.push(r.error);
  }
  return { values, errors };
}
