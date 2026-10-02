// Small, dependency-free readers for the JSON a domain stores (extension params, domain data).
// Every reader returns a `Read` instead of throwing, with the path of the field at fault, so regen
// can report it on the feature (`params...`) or the namespace (`domains.<ns>.data...`).

import type { StoredExpression } from '@manufakture/core';
import { evaluate, findReferences, type LengthUnit, type AngleUnit } from '@manufakture/units';

/** A path into the value being read (`['overrides', 'us-2x4', 'thickness']`). */
export type Path = readonly (string | number)[];

/**
 * The outcome of reading stored JSON: the typed value, or why not. The same shape as regen's
 * `ReadResult`, so a reader can be registered as it is.
 */
export type Read<T> = { ok: true; value: T } | { ok: false; message: string; field?: Path };

export const ok = <T>(value: T): Read<T> => ({ ok: true, value });

export function fail(
  message: string,
  field: Path = [],
): { ok: false; message: string; field: Path } {
  return { ok: false, message, field };
}

/** A plain JSON object (not an array, not null). */
export function isObject(v: unknown): v is Readonly<Record<string, unknown>> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * The value of an own key, or undefined. Never reads an inherited one, so stored keys such as
 * `__proto__` or `constructor` are only ever data.
 */
export function own(o: Readonly<Record<string, unknown>>, key: string): unknown {
  return Object.hasOwn(o, key) ? o[key] : undefined;
}

/** Refuse keys outside `allowed`: a misspelt field must not be silently ignored. */
export function onlyKeys(
  o: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  at: Path,
): Read<true> {
  for (const key of Object.keys(o)) {
    if (!allowed.includes(key)) return fail(`unknown field "${key}"`, [...at, key]);
  }
  return ok(true);
}

const LENGTH_UNITS: readonly LengthUnit[] = ['mm', 'cm', 'm', 'in', 'ft'];
const ANGLE_UNITS: readonly AngleUnit[] = ['deg', 'rad'];

/** A stored expression's envelope (`{ source, lengthUnit, angleUnit }`), checked. */
export function readStoredExpression(v: unknown, at: Path): Read<StoredExpression> {
  if (!isObject(v)) return fail('expected an expression { source, lengthUnit, angleUnit }', at);
  const keys = onlyKeys(v, ['source', 'lengthUnit', 'angleUnit'], at);
  if (!keys.ok) return keys;
  const source = own(v, 'source');
  const lengthUnit = own(v, 'lengthUnit');
  const angleUnit = own(v, 'angleUnit');
  if (typeof source !== 'string')
    return fail('expected the expression source text', [...at, 'source']);
  if (!LENGTH_UNITS.includes(lengthUnit as LengthUnit)) {
    return fail('expected a length unit (mm, cm, m, in, ft)', [...at, 'lengthUnit']);
  }
  if (!ANGLE_UNITS.includes(angleUnit as AngleUnit)) {
    return fail('expected an angle unit (deg, rad)', [...at, 'angleUnit']);
  }
  return ok({
    source,
    lengthUnit: lengthUnit as LengthUnit,
    angleUnit: angleUnit as AngleUnit,
  });
}

/**
 * A constant length in millimetres from a stored expression (ADR 0013 decision 3: domain data
 * holds settings, not model, so it names no variable). `18.2mm` and `23/32"` are allowed,
 * `#ply - 0.3mm` is not. With `positive`, zero and negative lengths are refused too.
 */
export function constantLength(
  e: StoredExpression,
  at: Path,
  options: { positive?: boolean } = {},
): Read<number> {
  const refs = findReferences(e.source);
  if (!refs.ok) return fail(refs.error.message, at);
  if (refs.value.length > 0) {
    const names = [...new Set(refs.value.map((r) => `#${r.name}`))].join(', ');
    return fail(
      `domain settings hold constants only: ${names} is a variable; type the measured value instead`,
      at,
    );
  }
  const r = evaluate(e.source, {
    expected: 'length',
    lengthUnit: e.lengthUnit,
    angleUnit: e.angleUnit,
  });
  if (!r.ok) return fail(r.error.message, at);
  if (!Number.isFinite(r.value)) return fail('the length is not a finite number', at);
  if (options.positive === true ? !(r.value > 0) : r.value < 0) {
    return fail(
      options.positive === true
        ? 'expected a length above zero'
        : 'expected a length of zero or more',
      at,
    );
  }
  return ok(r.value);
}

/** A stored expression that must be a constant length: envelope and value. */
export function readConstantLength(
  v: unknown,
  at: Path,
  options: { positive?: boolean } = {},
): Read<{ expression: StoredExpression; value: number }> {
  const e = readStoredExpression(v, at);
  if (!e.ok) return e;
  const value = constantLength(e.value, at, options);
  if (!value.ok) return value;
  return ok({ expression: e.value, value: value.value });
}

/** One of `values`, or the error naming them. */
export function readEnum<T extends string>(v: unknown, values: readonly T[], at: Path): Read<T> {
  if (typeof v === 'string' && (values as readonly string[]).includes(v)) return ok(v as T);
  return fail(`expected one of ${values.map((x) => `"${x}"`).join(', ')}`, at);
}

/** A non-empty string of at most `max` characters. */
export function readId(v: unknown, at: Path, what: string, max = 256): Read<string> {
  if (typeof v !== 'string' || v.length === 0 || v.length > max) {
    return fail(`expected ${what}`, at);
  }
  return ok(v);
}
