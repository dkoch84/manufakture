// The two safety factors the mechanical domain asks for when it starts (ADR 0017 decision 6, the
// maintainer's decision of 2026-10-10): a strength factor on yield and a fatigue factor, both
// optional. Nothing is prefilled: an empty field means no factor, and a check without one shows
// its factor with nothing to compare against.

import { MAX_SAFETY_FACTOR, type StartFactors } from '@manufakture/domain-mech';

/** A factor field's text as a number, `undefined` when empty, or a message when it does not read. */
export function parseFactor(
  text: string,
): { ok: true; value: number | undefined } | { ok: false; message: string } {
  const t = text.trim();
  if (t === '') return { ok: true, value: undefined };
  if (!/^[0-9]*\.?[0-9]+$/.test(t)) return { ok: false, message: `"${t}" is not a number` };
  const n = Number(t);
  if (!(n > 0 && n <= MAX_SAFETY_FACTOR)) {
    return { ok: false, message: `A factor is above 0 and at most ${MAX_SAFETY_FACTOR}` };
  }
  return { ok: true, value: n };
}

/** Both fields as `StartFactors`, or the first message. */
export function parseFactors(
  strength: string,
  fatigue: string,
):
  | { ok: true; value: StartFactors }
  | { ok: false; message: string; field: 'strength' | 'fatigue' } {
  const s = parseFactor(strength);
  if (!s.ok) return { ...s, field: 'strength' };
  const f = parseFactor(fatigue);
  if (!f.ok) return { ...f, field: 'fatigue' };
  const value: { strength?: number; fatigue?: number } = {};
  if (s.value !== undefined) value.strength = s.value;
  if (f.value !== undefined) value.fatigue = f.value;
  return { ok: true, value };
}

/** A stored factor as its field's text. */
export function factorField(value: number | undefined): string {
  return value === undefined ? '' : String(value);
}
