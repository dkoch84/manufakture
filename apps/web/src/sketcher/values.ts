// Dimension values: typed as expressions (`3/4"`, `2*#t`), stored with the
// units they were typed under (ADR 0004 decision 7, ADR 0005), evaluated
// with `@manufakture/units`, and shown in the document's display units.

import {
  angleFormat,
  bareUnits,
  lengthFormat,
  variableOrder,
  type DisplayUnits,
  type ManufaktureDocument,
  type StoredExpression,
} from '@manufakture/core';
import type { DimensionalConstraint } from '@manufakture/sketch/model';
import {
  evaluate,
  evaluateQuantity,
  formatAngle,
  formatLength,
  fromMillimetres,
  fromRadians,
  type Quantity,
  type UnitsError,
} from '@manufakture/units';

// The display units to units-package format mapping lives in core, next to `DisplayUnits`;
// re-exported here because the sketcher, construction and wood tools import it with the
// rest of the value helpers.
export { lengthFormat };

export type Variables = Readonly<Record<string, Quantity>>;

/**
 * The document's variables, evaluated in dependency order. A variable that
 * fails to evaluate is left out, so expressions naming it report it unknown.
 */
export function evaluateVariables(doc: ManufaktureDocument): Variables {
  const out: Record<string, Quantity> = {};
  const order = variableOrder(doc.variables);
  if (!order.ok) return out;
  const byName = new Map(doc.variables.map((v) => [v.name, v]));
  for (const name of order.value) {
    const v = byName.get(name);
    if (!v) continue;
    const r = evaluateQuantity(v.expression.source, {
      lengthUnit: v.expression.lengthUnit,
      angleUnit: v.expression.angleUnit,
      variables: (n) => out[n],
    });
    if (r.ok) out[name] = r.value;
  }
  return out;
}

export type ValueKind = 'length' | 'angle';

export function valueKindOf(c: Pick<DimensionalConstraint, 'kind'>): ValueKind {
  return c.kind === 'angle' ? 'angle' : 'length';
}

/** Whether the value of this kind of dimension may be zero or negative. */
function signed(kind: DimensionalConstraint['kind']): boolean {
  return kind === 'horizontalDistance' || kind === 'verticalDistance';
}

/** What is wrong with a value for this kind of dimension, or null. */
export function dimensionValueProblem(
  kind: DimensionalConstraint['kind'],
  value: number,
): string | null {
  return signed(kind) || value > 0 ? null : 'The value must be positive.';
}

export type ValueCheck =
  | { ok: true; value: number; expression: StoredExpression }
  | { ok: false; message: string; error?: UnitsError };

/**
 * Check text typed for a dimension: it must evaluate to the right kind of
 * quantity, and to a positive value unless the dimension is signed.
 */
export function checkValue(
  source: string,
  kind: DimensionalConstraint['kind'],
  units: DisplayUnits,
  variables: Variables,
): ValueCheck {
  const expression: StoredExpression = { source: source.trim(), ...bareUnits(units) };
  if (expression.source === '') return { ok: false, message: 'Enter a value.' };
  const r = evaluate(expression.source, {
    expected: valueKindOf({ kind }),
    lengthUnit: expression.lengthUnit,
    angleUnit: expression.angleUnit,
    variables: (n) => variables[n],
  });
  if (!r.ok) return { ok: false, message: r.error.message, error: r.error };
  const problem = dimensionValueProblem(kind, r.value);
  if (problem !== null) return { ok: false, message: problem };
  return { ok: true, value: r.value, expression };
}

/** Evaluate a stored dimension value, or null when it does not evaluate. */
export function evaluateStored(
  expression: StoredExpression,
  kind: ValueKind,
  variables: Variables,
): number | null {
  const r = evaluate(expression.source, {
    expected: kind,
    lengthUnit: expression.lengthUnit,
    angleUnit: expression.angleUnit,
    variables: (n) => variables[n],
  });
  return r.ok ? r.value : null;
}

/** A value for display, in the document's units. */
export function formatValue(value: number, kind: ValueKind, units: DisplayUnits): string {
  return kind === 'angle'
    ? formatAngle(value, angleFormat(units))
    : formatLength(value, lengthFormat(units));
}

/**
 * The source text a new dimension starts with: what it measures, as a bare
 * number in the bare-number unit, rounded to a thousandth of it.
 */
export function measuredSource(value: number, kind: ValueKind, units: DisplayUnits): string {
  const bare = bareUnits(units);
  const v =
    kind === 'angle' ? fromRadians(value, bare.angleUnit) : fromMillimetres(value, bare.lengthUnit);
  const rounded = Math.round(v * 1000) / 1000;
  return String(Object.is(rounded, -0) ? 0 : rounded);
}

/** Whether a source is just a number (shown as its value, with no expression). */
export function isPlainNumber(source: string): boolean {
  return /^\s*[-+]?(\d+(\.\d*)?|\.\d+)\s*$/.test(source);
}
