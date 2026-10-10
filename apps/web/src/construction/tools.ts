// What the Floor and Roof tools share, free of React: the walls on a level they follow or bear on,
// optional lengths and angles typed in their fields, stock choices checked by kind, and what an
// edit keeps of a feature that the tools do not show (member overrides and their nudges). Every
// loop here is linear in the part's features or in the fields given.

import type { DisplayUnits, ExtensionFeature, Part, StoredExpression } from '@manufakture/core';
import { bareUnits } from '@manufakture/core';
import { findStock } from '@manufakture/stock';
import { evaluate } from '@manufakture/units';
import type { Variables } from '../sketcher/values';
import { isWall, type WallFeature } from './kinds';
import { checkLength, MAX_LENGTH_TEXT, type LengthOptions } from './lengths';

/** The walls of a part drawn on `level`, in feature order. */
export function wallsOnLevel(part: Part | undefined, level: string): WallFeature[] {
  return (part?.features ?? []).filter(
    (f): f is WallFeature => isWall(f) && f.params.level === level,
  );
}

/**
 * The walls a new floor follows or a new roof bears on, by default: the first closed wall on the
 * level (a building outline), else every wall on it.
 */
export function defaultWalls(part: Part | undefined, level: string): string[] {
  const walls = wallsOnLevel(part, level);
  const closed = walls.find((w) => w.params.closed === true);
  return closed ? [closed.id] : walls.map((w) => w.id);
}

/**
 * An optional length field: empty keeps the default (no expression), else checked. Puts the
 * expression in `out` under `key`, or the message in `errors`.
 */
export function optionalLength(
  text: string,
  key: string,
  ctx: {
    units: DisplayUnits;
    variables: Variables;
    out: Record<string, StoredExpression>;
    errors: Record<string, string>;
  },
  options: LengthOptions & { max?: { value: number; text: string } } = {},
): number | undefined {
  if (text.trim() === '') return undefined;
  const r = checkLength(text, ctx.units, ctx.variables, options);
  if (!r.ok) {
    ctx.errors[key] = r.message;
    return undefined;
  }
  if (options.max && Math.abs(r.value) > options.max.value) {
    ctx.errors[key] = `Must be at most ${options.max.text}.`;
    return undefined;
  }
  ctx.out[key] = r.expression;
  return r.value;
}

/** An optional angle field (a joist direction, a roof's rotation in plan). */
export function optionalAngle(
  text: string,
  key: string,
  ctx: {
    units: DisplayUnits;
    variables: Variables;
    out: Record<string, StoredExpression>;
    errors: Record<string, string>;
  },
): number | undefined {
  if (text.trim() === '') return undefined;
  if (text.length > MAX_LENGTH_TEXT) {
    ctx.errors[key] = `Type at most ${MAX_LENGTH_TEXT} characters.`;
    return undefined;
  }
  const expression: StoredExpression = { source: text.trim(), ...bareUnits(ctx.units) };
  const r = evaluate(expression.source, {
    expected: 'angle',
    lengthUnit: expression.lengthUnit,
    angleUnit: expression.angleUnit,
    variables: (n) => ctx.variables[n],
  });
  if (!r.ok) {
    ctx.errors[key] = r.error.message;
    return undefined;
  }
  if (!Number.isFinite(r.value) || Math.abs(r.value) > 4 * Math.PI) {
    ctx.errors[key] = 'Enter an angle of at most two turns.';
    return undefined;
  }
  ctx.out[key] = expression;
  return r.value;
}

/** Whether `id` is a catalog stock of `kind`. */
export function isStock(id: string | null | undefined, kind: 'lumber' | 'sheet'): boolean {
  return typeof id === 'string' && id !== '' && findStock(id)?.kind === kind;
}

/** The stock's nominal name (`2x6`), else its id. */
export function stockName(id: string | undefined): string {
  return id === undefined ? '' : (findStock(id)?.name ?? id);
}

/**
 * What an edit keeps of a feature the tools do not show: its member overrides and its phase
 * (params, #1213) and the overrides' nudges (`move_<n>` expressions).
 */
export function keptOverrides(existing: ExtensionFeature | undefined): {
  params: Record<string, unknown>;
  expressions: Record<string, StoredExpression>;
} {
  const params: Record<string, unknown> = {};
  const expressions: Record<string, StoredExpression> = {};
  if (!existing) return { params, expressions };
  if (existing.params.overrides !== undefined) params.overrides = existing.params.overrides;
  if (existing.params.phase !== undefined) params.phase = existing.params.phase;
  for (const [k, v] of Object.entries(existing.expressions)) {
    if (/^move_[1-9][0-9]*$/.test(k)) expressions[k] = v;
  }
  return { params, expressions };
}

/** A whole number from a select or field in `[lo, hi]`, else undefined. */
export function countOf(text: string, lo: number, hi: number): number | undefined {
  if (!/^[0-9]{1,3}$/.test(text.trim())) return undefined;
  const n = Number(text.trim());
  return n >= lo && n <= hi ? n : undefined;
}
