// The roof pitch as typed in the Roof tool's slope field (ADR 0005 as amended by T6.0b): `6/12`
// and `6:12` are a pitch of 6 in 12, `30deg` or `30°` an angle, `25%` a percent slope
// (atan(0.25)); a bare `30` is ambiguous and refused with the parser's own message ("Ambiguous:
// write 30° or 30/12"). The text is checked before the parser sees it (at most `MAX_PITCH_TEXT`
// characters) and the angle is bounded as the roof feature bounds it (above 0, below 80 degrees).
// What a pitch is shown back as: `p/12` and its angle in degrees.

import { bareUnits, type DisplayUnits, type StoredExpression } from '@manufakture/core';
import { MAX_PITCH } from '@manufakture/domain-construction';
import { evaluate, formatAngle } from '@manufakture/units';
import type { Variables } from '../../sketcher/values';

/** The longest text the pitch field takes. */
export const MAX_PITCH_TEXT = 100;

export type PitchCheck =
  { ok: true; value: number; expression: StoredExpression } | { ok: false; message: string };

const NO_VARIABLES: Variables = {};

/** Check a typed pitch (a slope field); empty text is refused. */
export function checkPitch(
  text: string,
  units: DisplayUnits,
  variables: Variables = NO_VARIABLES,
): PitchCheck {
  if (text.length > MAX_PITCH_TEXT) {
    return { ok: false, message: `Type at most ${MAX_PITCH_TEXT} characters.` };
  }
  const source = text.trim();
  if (source === '') return { ok: false, message: 'Enter a pitch: 6/12, 30deg or 25%.' };
  const expression: StoredExpression = { source, ...bareUnits(units) };
  const r = evaluate(source, {
    expected: 'angle',
    slope: true,
    lengthUnit: expression.lengthUnit,
    angleUnit: expression.angleUnit,
    variables: (n) => variables[n],
  });
  if (!r.ok) return { ok: false, message: r.error.message };
  const value = r.value;
  if (!(Number.isFinite(value) && value > 0 && value < MAX_PITCH)) {
    return { ok: false, message: 'A roof pitch is above 0 and below 80 degrees (about 68/12).' };
  }
  return { ok: true, value, expression };
}

/** A pitch as `p/12`: `6/12`, `7.5/12`; `25%` shows as `3/12`. */
export function pitchText(rad: number): string {
  return formatAngle(rad, { unit: 'pitch', slope: true });
}

/** A pitch's angle: `26.57°`. */
export function pitchDegrees(rad: number): string {
  return formatAngle(rad, { unit: 'deg', decimals: 2 });
}

/** What the field shows under a pitch: `6/12, 26.57°`. */
export function pitchSummary(rad: number): string {
  return `${pitchText(rad)}, ${pitchDegrees(rad)}`;
}
