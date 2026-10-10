// Typing a catalog value in, from a datasheet or a CSV cell, through `@manufakture/units` (ADR
// 0005; ADR 0017 decision 3). A rating is stored as a plain SI number (`Rated.value`), not an
// expression, so what was typed is read once:
//
// - With a unit, the unit decides (`5.4 kN`, `1200 lbf`, `17000 rpm`, `120 Hz`). A frequency field
//   refuses an angular speed such as `rpm` (units' rule): write `Hz`.
// - A bare number means the document's display unit for that kind (`5400` in a force field shown
//   in N is 5400 N; shown in lbf it is 5400 lbf), which the editor shows next to the field. The
//   stored number is SI either way, so a stored value never depends on a display preference.
// - `unknown` (or `?`) is a value the datasheet does not give; an empty cell is no value at all.
//
// Dimensions are lengths in the document's length unit when bare; masses are a `mass`.

import type { DisplayUnits, Rated } from '@manufakture/core';
import {
  evaluate,
  fromDisplayUnit,
  resolveDisplayUnit,
  type LengthUnit,
  type PhysicalKind,
} from '@manufakture/units';
import type { RatingField } from './families';

/** The longest text value a rating holds, in code points (core's short text). */
export const MAX_RATING_TEXT = 200;

export type ReadValue = { ok: true; value: Rated | undefined } | { ok: false; message: string };

const BARE = /^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/;
const UNKNOWN = /^(?:unknown|\?)$/i;

/** The length unit bare numbers are in under a document's length format. */
export function bareLengthUnit(units: DisplayUnits): LengthUnit {
  const u = units.length.unit;
  return u === 'ft-in' || u === 'in-fraction' ? 'in' : u;
}

/** The display unit a bare number of `kind` is read in, for the editor to show. */
export function bareUnit(kind: PhysicalKind, units: DisplayUnits): string {
  return resolveDisplayUnit(kind, units.quantities, units.length.unit);
}

/** A physical value typed in: SI, with a bare number in the display unit. */
export function readPhysical(
  text: string,
  kind: PhysicalKind,
  units: DisplayUnits,
): { ok: true; value: number } | { ok: false; message: string } {
  const s = text.trim();
  if (BARE.test(s)) {
    const v = fromDisplayUnit(Number(s), kind, bareUnit(kind, units));
    return Number.isFinite(v) ? { ok: true, value: v } : { ok: false, message: 'too large' };
  }
  const r = evaluate(s, { expected: kind });
  return r.ok ? r : { ok: false, message: r.error.message };
}

function codePoints(s: string): number {
  return [...s].length;
}

/** A rating field's value typed in. */
export function readRating(field: RatingField, text: string, units: DisplayUnits): ReadValue {
  const s = text.trim();
  if (s === '') return { ok: true, value: undefined };
  if (UNKNOWN.test(s)) return { ok: true, value: { unknown: true } };
  if (field.kind === 'text') {
    if (codePoints(s) > MAX_RATING_TEXT) {
      return { ok: false, message: `at most ${MAX_RATING_TEXT} characters` };
    }
    if (field.options !== undefined) {
      const match = field.options.find((o) => o.toLowerCase() === s.toLowerCase());
      if (match === undefined) return { ok: false, message: `one of ${field.options.join(', ')}` };
      return { ok: true, value: { text: match } };
    }
    return { ok: true, value: { text: s } };
  }
  if (field.kind === 'number' || field.kind === 'count') {
    const r = evaluate(s, { expected: 'number' });
    if (!r.ok) return { ok: false, message: r.error.message };
    if (field.kind === 'count' && (!Number.isInteger(r.value) || r.value < 0)) {
      return { ok: false, message: 'a whole number' };
    }
    return { ok: true, value: { value: r.value } };
  }
  const r = readPhysical(s, field.kind, units);
  return r.ok ? { ok: true, value: { value: r.value } } : r;
}

/** A dimension typed in: millimetres, above zero; a bare number in the document's length unit. */
export function readDimension(text: string, units: DisplayUnits): ReadValue {
  const s = text.trim();
  if (s === '') return { ok: true, value: undefined };
  if (UNKNOWN.test(s)) return { ok: true, value: { unknown: true } };
  const r = evaluate(s, { expected: 'length', lengthUnit: bareLengthUnit(units) });
  if (!r.ok) return { ok: false, message: r.error.message };
  if (!(r.value > 0)) return { ok: false, message: 'a length above zero' };
  return { ok: true, value: { value: r.value } };
}

/** A mass typed in: kilograms, above zero; a bare number in the display unit of mass. */
export function readMass(text: string, units: DisplayUnits): ReadValue {
  const s = text.trim();
  if (s === '') return { ok: true, value: undefined };
  if (UNKNOWN.test(s)) return { ok: true, value: { unknown: true } };
  const r = readPhysical(s, 'mass', units);
  if (!r.ok) return r;
  if (!(r.value > 0)) return { ok: false, message: 'a mass above zero' };
  return { ok: true, value: { value: r.value } };
}
