// Lengths typed in the construction tools, in the document's display units (`16'`,
// `11' 6-1/2"`, `2.4m`, a bare number in the document's unit). Every check here is bounded before
// the expression parser sees the text: at most `MAX_LENGTH_TEXT` characters, and a result of at
// most `MAX_TYPED_LENGTH` in size, so a pasted megabyte or `1e300` never reaches the regen worker.
// Coordinates the tools compute (a clicked point, the sum of typed segments) are written back as
// plain numbers in the document's bare unit (`coordinateSource`).

import { bareUnits, type DisplayUnits, type StoredExpression } from '@manufakture/core';
import { evaluate, fromMillimetres } from '@manufakture/units';
import type { Variables } from '../sketcher/values';

/** The longest text a length field takes. */
export const MAX_LENGTH_TEXT = 100;
/** The largest length a field takes, mm (100 m: the construction domain's own limit). */
export const MAX_TYPED_LENGTH = 100_000;

export type LengthCheck =
  { ok: true; value: number; expression: StoredExpression } | { ok: false; message: string };

export interface LengthOptions {
  /** Above zero (the default), at least zero, or any sign. */
  sign?: 'positive' | 'non-negative' | 'any';
  /** The smallest value allowed, mm, with what to call it in the message. */
  min?: { value: number; text: string };
  /** Settings take constants only: no variables are offered or evaluated. */
  constant?: boolean;
}

const NO_VARIABLES: Variables = {};

/** Check a typed length; empty text is refused (callers treat empty as "the default" first). */
export function checkLength(
  text: string,
  units: DisplayUnits,
  variables: Variables = NO_VARIABLES,
  options: LengthOptions = {},
): LengthCheck {
  if (text.length > MAX_LENGTH_TEXT) {
    return { ok: false, message: `Type at most ${MAX_LENGTH_TEXT} characters.` };
  }
  const source = text.trim();
  if (source === '') return { ok: false, message: 'Enter a length.' };
  const expression: StoredExpression = { source, ...bareUnits(units) };
  const vars = options.constant ? NO_VARIABLES : variables;
  const r = evaluate(source, {
    expected: 'length',
    lengthUnit: expression.lengthUnit,
    angleUnit: expression.angleUnit,
    variables: (n) => vars[n],
  });
  if (!r.ok) {
    return {
      ok: false,
      message:
        options.constant && source.includes('#')
          ? 'Settings take a length, not a variable.'
          : r.error.message,
    };
  }
  const value = r.value;
  if (!Number.isFinite(value) || Math.abs(value) > MAX_TYPED_LENGTH) {
    return { ok: false, message: `Enter a length of at most ${MAX_TYPED_LENGTH / 1000} m.` };
  }
  const sign = options.sign ?? 'positive';
  if (sign === 'positive' && !(value > 0)) return { ok: false, message: 'Must be more than zero.' };
  if (sign === 'non-negative' && !(value >= 0))
    return { ok: false, message: 'Must not be negative.' };
  if (options.min && value < options.min.value) {
    return { ok: false, message: `Must be at least ${options.min.text}.` };
  }
  return { ok: true, value, expression };
}

/**
 * A computed coordinate (mm) as the source of a stored expression: a plain number in the
 * document's bare unit (inches for a feet-and-inches document), to a millionth of it, so typed
 * fractions down to 1/64" come back exact.
 */
export function coordinateSource(mm: number, units: DisplayUnits): string {
  const v = fromMillimetres(mm, bareUnits(units).lengthUnit);
  const rounded = Math.round(v * 1e6) / 1e6;
  return String(Object.is(rounded, -0) ? 0 : rounded);
}

/** A computed coordinate as a stored expression in the document's bare unit. */
export function coordinateExpression(mm: number, units: DisplayUnits): StoredExpression {
  return { source: coordinateSource(mm, units), ...bareUnits(units) };
}
