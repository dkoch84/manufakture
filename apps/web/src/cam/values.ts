// Numbers in the Manufacture workspace (M5 plan, T5.3a). Core checks only that a CAM expression is
// well formed, never its kind or range (ADR 0014 decision 3), and the geometry stage reports a bad
// value only when toolpaths are next asked for. So every field here is checked as it is typed: the
// kind its field expects (core's `camExpressions`), then a range rule, with a message the field
// shows. A zero stepover, a negative diameter or a fractional tab count never reaches a command.

import {
  bareUnits,
  configured,
  type DisplayUnits,
  type ManufaktureDocument,
  type StoredExpression,
} from '@manufakture/core';
import { analyzeExpression, type FieldKind } from '../components/expression';
import { evaluateVariables, type Variables } from '../sketcher/values';

/** The variables CAM expressions read: the document's, with its active configuration row. */
export function camVariables(doc: ManufaktureDocument): Variables {
  const c = configured(doc);
  return evaluateVariables(c.ok ? c.value : doc);
}

/**
 * The range a field's value must be in: `positive` above zero (a depth, a diameter, a feed),
 * `nonNegative` zero or more (an allowance, a margin, a dwell), `fraction` above zero and at most
 * one (a stepover, a fraction of the tool diameter), `whole` a whole number of at least one (a tab
 * count), `entryAngle` above zero and below 90 degrees (a ramp or helix angle), `any` anything.
 */
export type Rule = 'positive' | 'nonNegative' | 'fraction' | 'whole' | 'entryAngle' | 'any';

const QUARTER_TURN = Math.PI / 2;

/** What is wrong with `value` under `rule`, or null. */
export function ruleProblem(rule: Rule, value: number): string | null {
  if (!Number.isFinite(value)) return 'The value must be a finite number.';
  switch (rule) {
    case 'positive':
      return value > 0 ? null : 'The value must be greater than zero.';
    case 'nonNegative':
      return value >= 0 ? null : 'The value must be zero or more.';
    case 'fraction':
      return value > 0 && value <= 1
        ? null
        : 'A stepover is a fraction of the tool diameter: greater than 0 and at most 1 (0.4 is 40 %).';
    case 'whole':
      return Number.isInteger(value) && value >= 1
        ? null
        : 'The value must be a whole number, 1 or more.';
    case 'entryAngle':
      return value > 0 && value < QUARTER_TURN
        ? null
        : 'The angle must be greater than 0 and less than 90 degrees.';
    case 'any':
      return null;
  }
}

/** A field's check, for `ExpressionField`'s `validate`. */
export function validator(rule: Rule): (value: number) => string | null {
  return (value) => ruleProblem(rule, value);
}

export type FieldCheck =
  | { readonly ok: true; readonly value: number; readonly empty: false }
  | { readonly ok: true; readonly value: null; readonly empty: true }
  | { readonly ok: false; readonly message: string };

/**
 * Check typed text as `kind` under `rule`. Empty text is fine when `optional` (the field is left
 * out: a default from the tool's preset), and an error otherwise.
 */
export function checkField(
  text: string,
  kind: FieldKind,
  rule: Rule,
  units: DisplayUnits,
  variables: Variables,
  optional = false,
): FieldCheck {
  const a = analyzeExpression(text, kind, units, variables, validator(rule));
  if (a.state === 'empty') {
    return optional
      ? { ok: true, value: null, empty: true }
      : { ok: false, message: 'Enter a value.' };
  }
  if (a.state === 'error') return { ok: false, message: a.message };
  return { ok: true, value: a.value, empty: false };
}

/**
 * The stored form of typed text: unchanged text keeps the units it was stored with (so opening and
 * applying a dialog changes nothing), new text takes the document's bare-number units.
 */
export function storedOf(
  text: string,
  units: DisplayUnits,
  before?: StoredExpression,
): StoredExpression {
  const source = text.trim();
  if (before && before.source === source) return before;
  return { source, ...bareUnits(units) };
}

/** An expression with its unit written in, so it means the same under any display units. */
export function explicit(source: string, units: DisplayUnits): StoredExpression {
  return { source, ...bareUnits(units) };
}
