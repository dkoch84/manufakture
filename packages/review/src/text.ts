// Text and values as a bundle shows them: bounded, with control and format characters replaced
// (names and labels come from the document or the agent and are rendered as text; a bidi
// override or a zero-width mark must not change what a reviewer reads), numbers rounded so a
// bundle is stable data, and the generic field diff the feature and document diffs use.

import type { StoredExpression } from '@manufakture/core';
import { LIMITS, type Bounded, type FieldChange } from './types';

const CONTROLS = /[\p{Cc}\p{Cf}\p{Cs}]/gu;

/** Text for a reviewer: control, format and lone surrogate characters shown as U+FFFD, cut. */
export function shown(text: string, max: number = LIMITS.text): string {
  const clean = text.replace(CONTROLS, '�');
  return clean.length <= max ? clean : `${clean.slice(0, max - 3)}...`;
}

/** Whether `text` holds characters `shown` would replace (tabs and line breaks aside). */
export function hasHiddenCharacters(text: string): boolean {
  for (const m of text.matchAll(CONTROLS)) {
    if (m[0] !== '\t' && m[0] !== '\n' && m[0] !== '\r') return true;
  }
  return false;
}

/** `list` cut to `max` entries. */
export function bounded<T>(list: readonly T[], max: number): Bounded<T> {
  return { items: list.slice(0, max), omitted: Math.max(0, list.length - max) };
}

/** A measurement rounded to 12 significant digits: stable data, far below any tolerance. */
export function round(v: number): number {
  if (!Number.isFinite(v) || v === 0) return v === 0 ? 0 : v;
  return Number(v.toPrecision(12));
}

export const isExpression = (v: unknown): v is StoredExpression =>
  typeof v === 'object' &&
  v !== null &&
  !Array.isArray(v) &&
  typeof (v as StoredExpression).source === 'string' &&
  typeof (v as StoredExpression).lengthUnit === 'string' &&
  typeof (v as StoredExpression).angleUnit === 'string';

const NUMBER = /^[-+]?(\d+(\.\d*)?|\.\d+)$/;

/**
 * An expression as the user typed it. A bare number gets its unit: `length` (the default) the
 * expression's length unit, `angle` its angle unit, `count` none.
 */
export function expressionText(
  e: StoredExpression | undefined,
  dimension: 'length' | 'angle' | 'count' = 'length',
): string {
  if (e === undefined) return 'none';
  const s = e.source.trim();
  if (!NUMBER.test(s) || dimension === 'count') return shown(s, 120);
  return `${s} ${dimension === 'angle' ? e.angleUnit : e.lengthUnit}`;
}

/** Any JSON value as a short text: expressions as typed, scalars as they are, the rest as JSON. */
export function valueText(v: unknown, max = 120): string {
  if (v === undefined) return 'none';
  if (isExpression(v)) return expressionText(v);
  if (typeof v === 'string') return shown(JSON.stringify(v), max);
  if (typeof v === 'number') return String(round(v));
  if (typeof v !== 'object' || v === null) return String(v);
  let text: string;
  try {
    text = JSON.stringify(v);
  } catch {
    text = '(not JSON)';
  }
  return shown(text, max);
}

/** `\uXXXX` for each UTF-16 unit of `ch`. */
const escaped = (ch: string): string => {
  let out = '';
  for (let i = 0; i < ch.length; i++) out += `\\u${ch.charCodeAt(i).toString(16).padStart(4, '0')}`;
  return out;
};

/**
 * The JSON text of a command, cut at `max` characters. Control, format and lone surrogate
 * characters are written as `\uXXXX` escapes (JSON.stringify leaves U+007F to U+009F and every
 * format character, a bidi override or a zero-width space, raw): the text is still the same JSON
 * value, and a reviewer sees exactly which characters are there.
 */
export function jsonText(v: unknown, max: number): { json: string; truncated: boolean } {
  let text: string;
  try {
    text = (JSON.stringify(v) ?? 'null').replace(CONTROLS, escaped);
  } catch {
    text = '"(not JSON)"';
  }
  return text.length <= max
    ? { json: text, truncated: false }
    : { json: text.slice(0, max), truncated: true };
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * The fields of two values that differ, as dotted paths: objects key by key (expressions, and
 * anything at `depth`, as one value), arrays index by index while their lengths match (else the
 * array as one value). At most `max` changes; `skip` leaves top-level keys out.
 */
export function fieldChanges(
  before: unknown,
  after: unknown,
  options: { max?: number; skip?: readonly string[]; depth?: number } = {},
): FieldChange[] {
  const max = options.max ?? LIMITS.fields;
  const skip = new Set(options.skip ?? []);
  const out: FieldChange[] = [];
  const walk = (a: unknown, b: unknown, path: string, depth: number): void => {
    if (out.length >= max || same(a, b)) return;
    const objects =
      typeof a === 'object' &&
      a !== null &&
      typeof b === 'object' &&
      b !== null &&
      Array.isArray(a) === Array.isArray(b) &&
      !isExpression(a) &&
      !isExpression(b) &&
      depth < (options.depth ?? 6);
    if (objects && Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
      for (let i = 0; i < a.length; i++) walk(a[i], b[i], `${path}[${i}]`, depth + 1);
      return;
    }
    if (objects && !Array.isArray(a)) {
      const x = a as Record<string, unknown>;
      const y = b as Record<string, unknown>;
      const keys = [...new Set([...Object.keys(x), ...Object.keys(y)])];
      for (const k of keys) {
        if (depth === 0 && skip.has(k)) continue;
        walk(x[k], y[k], path === '' ? k : `${path}.${k}`, depth + 1);
      }
      return;
    }
    out.push({
      path: shown(path === '' ? '(value)' : path, 200),
      before: arrayAware(a, path),
      after: arrayAware(b, path),
    });
  };
  walk(before, after, '', 0);
  return out;
}

/** What a bare number in an expression at `path` is: an angle, a count, or a length. */
export function dimensionOf(path: string): 'length' | 'angle' | 'count' {
  if (/angle|rotation|draft|taper|tilt|orientation|pitch/i.test(path)) return 'angle';
  if (/count|copies|flutes|plies|jacks|number/i.test(path)) return 'count';
  return 'length';
}

function arrayAware(v: unknown, path: string): string {
  if (Array.isArray(v) && JSON.stringify(v).length > 120) {
    return `${v.length} ${v.length === 1 ? 'item' : 'items'}`;
  }
  return isExpression(v) ? expressionText(v, dimensionOf(path)) : valueText(v);
}

/** `value` without the keys `keys`. */
export function omit(value: object, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([k]) => !keys.includes(k)));
}

/** "a slider", "an aligned". */
export const an = (word: string): string => `${/^[aeiou]/i.test(word) ? 'an' : 'a'} ${word}`;

/** "1 edge", "4 edges". */
export const plural = (n: number, word: string, words = `${word}s`): string =>
  `${n} ${n === 1 ? word : words}`;
