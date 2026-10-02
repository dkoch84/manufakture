// The logic of the shared numeric input, free of React: evaluating what is typed (with units and
// the document's variables) into a preview or an error with its source range, and the `#name`
// autocompletion (which token is being typed, which variables match, and inserting one).

import { bareUnits, type DisplayUnits, type StoredExpression } from '@manufakture/core';
import {
  evaluate,
  evaluateQuantity,
  formatFeed,
  formatNumber,
  formatSpindleSpeed,
  type Quantity,
  type UnitsError,
  type UnitsErrorCode,
} from '@manufakture/units';
import { formatValue, lengthFormat, type Variables } from '../sketcher/values';

export type ValueKind = 'length' | 'angle' | 'number';
/** The CAM kinds (M5): a feed rate (mm/min inside) and a spindle speed (rpm). */
export type RateKind = 'feed' | 'spindleSpeed';
/** A field's kind; `any` takes whatever dimension the expression has (a variable's value). */
export type FieldKind = ValueKind | RateKind | 'any';

/** A feed rate or spindle speed for display: in the document's length unit per minute, or rpm. */
export function formatRate(value: number, kind: RateKind, units: DisplayUnits): string {
  if (kind === 'spindleSpeed') return formatSpindleSpeed(value);
  return formatFeed(value, { unit: lengthFormat(units).unit });
}

export type Analysis =
  | { state: 'empty' }
  | { state: 'ok'; value: number; expression: StoredExpression; formatted: string }
  | {
      state: 'error';
      message: string;
      /** The units error code, or `value` for a failed extra check (`validate`). */
      code: UnitsErrorCode | 'value';
      /** The range of the source to highlight; empty when there is nothing to point at. */
      start: number;
      end: number;
    };

/** A value in the document's display units: lengths and angles formatted, numbers as they are. */
export function formatKind(value: number, kind: ValueKind, units: DisplayUnits): string {
  if (kind === 'number') {
    return Number.isInteger(value) ? String(value) : formatNumber(value).replace(/\.?0+$/, '');
  }
  return formatValue(value, kind, units);
}

/** The kind a quantity is, or null when it is none of them (an area, 1/length). */
export function kindOfQuantity(q: Quantity): ValueKind | null {
  const { length, angle } = q.dimension;
  if (length === 0 && angle === 0) return 'number';
  if (length === 1 && angle === 0) return 'length';
  if (length === 0 && angle === 1) return 'angle';
  return null;
}

/** Any quantity for display: a length, angle or number as such, anything else in mm and rad (`100 mm^2`). */
export function formatQuantity(q: Quantity, units: DisplayUnits): string {
  const kind = kindOfQuantity(q);
  if (kind) return formatKind(q.value, kind, units);
  const power = (unit: string, e: number) =>
    e === 0 ? '' : e === 1 ? ` ${unit}` : ` ${unit}^${Math.round(e * 1e6) / 1e6}`;
  const { length, angle } = q.dimension;
  return `${formatKind(q.value, 'number', units)}${power('mm', length)}${power('rad', angle)}`;
}

/**
 * Evaluate typed text as `kind` under the document's units and variables. `validate` adds a
 * check of the value (a positive depth, a whole count) and returns the message when it fails.
 */
export function analyzeExpression(
  source: string,
  kind: FieldKind,
  units: DisplayUnits,
  variables: Variables,
  validate?: (value: number) => string | null,
): Analysis {
  const text = source.trim();
  if (text === '') return { state: 'empty' };
  const expression: StoredExpression = { source: text, ...bareUnits(units) };
  const offset = source.length - source.trimStart().length;
  if (kind === 'any') {
    const q = evaluateQuantity(text, {
      lengthUnit: expression.lengthUnit,
      angleUnit: expression.angleUnit,
      variables: (n) => variables[n],
    });
    if (!q.ok) return errorOf(q.error, offset);
    const problem = validate?.(q.value.value) ?? null;
    if (problem !== null) {
      return { state: 'error', message: problem, code: 'value', start: 0, end: 0 };
    }
    return {
      state: 'ok',
      value: q.value.value,
      expression,
      formatted: formatQuantity(q.value, units),
    };
  }
  const r = evaluate(text, {
    expected: kind,
    lengthUnit: expression.lengthUnit,
    angleUnit: expression.angleUnit,
    variables: (n) => variables[n],
  });
  if (!r.ok) return errorOf(r.error, offset);
  const problem = validate?.(r.value) ?? null;
  if (problem !== null) {
    return { state: 'error', message: problem, code: 'value', start: 0, end: 0 };
  }
  const formatted =
    kind === 'feed' || kind === 'spindleSpeed'
      ? formatRate(r.value, kind, units)
      : formatKind(r.value, kind, units);
  return { state: 'ok', value: r.value, expression, formatted };
}

/** A units error as an analysis, with its range moved from the trimmed text to the source. */
function errorOf(e: UnitsError, offset: number): Analysis {
  return {
    state: 'error',
    message: e.message,
    code: e.code,
    start: e.start + offset,
    end: e.end + offset,
  };
}

/** The source split around an error's range, for highlighting it; null when there is no range. */
export function highlightParts(
  source: string,
  analysis: Analysis,
): { before: string; error: string; after: string } | null {
  if (analysis.state !== 'error' || analysis.end <= analysis.start) return null;
  return {
    before: source.slice(0, analysis.start),
    error: source.slice(analysis.start, analysis.end),
    after: source.slice(analysis.end),
  };
}

// Autocompletion -------------------------------------------------------------------------------

/** The `#name` being typed at the caret: where it starts (at the `#`) and what follows the `#`. */
export interface CompletionToken {
  start: number;
  end: number;
  prefix: string;
}

const NAME_CHAR = /[A-Za-z0-9_]/;

/**
 * The `#name` token around `caret`, or null when the caret is not in one. Only hashed names are
 * completed: a bare name after a number is usually a unit (`12 mm`).
 */
export function completionToken(text: string, caret: number): CompletionToken | null {
  let start = caret;
  while (start > 0 && NAME_CHAR.test(text[start - 1]!)) start--;
  if (start === 0 || text[start - 1] !== '#') return null;
  const prefix = text.slice(start, caret);
  if (/^[0-9]/.test(prefix)) return null;
  let end = caret;
  while (end < text.length && NAME_CHAR.test(text[end]!)) end++;
  return { start: start - 1, end, prefix };
}

/**
 * The variable names matching a prefix: the name typed in full first, then names starting with
 * it (case-insensitively), then names containing it, each group in table order.
 */
export function matchingNames(names: readonly string[], prefix: string): string[] {
  const p = prefix.toLowerCase();
  const exact = names.filter((n) => n === prefix);
  const starts = names.filter((n) => !exact.includes(n) && n.toLowerCase().startsWith(p));
  const contains = names.filter(
    (n) => !exact.includes(n) && !starts.includes(n) && n.toLowerCase().includes(p),
  );
  return [...exact, ...starts, ...contains];
}

/** Whether the list has something to offer: not when the only match is typed in full already. */
export function worthOffering(options: readonly string[], token: CompletionToken): boolean {
  return options.length > 1 || (options.length === 1 && options[0] !== token.prefix);
}

/** The text with a chosen name in place of the token, and where the caret goes. */
export function applyCompletion(
  text: string,
  token: CompletionToken,
  name: string,
): { text: string; caret: number } {
  const inserted = `#${name}`;
  return {
    text: text.slice(0, token.start) + inserted + text.slice(token.end),
    caret: token.start + inserted.length,
  };
}

/** The option a key moves to in a list of `count`, wrapping round; -1 is none. */
export function moveActive(active: number, count: number, key: 'ArrowDown' | 'ArrowUp'): number {
  if (count === 0) return -1;
  if (key === 'ArrowDown') return active < 0 || active >= count - 1 ? 0 : active + 1;
  return active <= 0 ? count - 1 : active - 1;
}
