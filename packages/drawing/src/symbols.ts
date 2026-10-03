// Drawing symbols that are not dimensions (M6 plan T6.4a): the roof pitch symbol, a small right
// triangle with `12` on its run and the rise `p` on its rise, its slope the roof's. The value is
// formatted by `packages/units` (ADR 0005 amendment, T6.0b): `formatAngle` with `unit: 'pitch'`
// in a slope field gives `6/12`, whose rise and run label the two legs.
//
// Door swings and window symbols in plans are plain geometry the construction domain draws in
// model space; only symbols sized on paper live here.

import { formatAngle } from '@manufakture/units';
import type { DisplayItem } from './display';
import { applyPoint, type Transform2, type Vec2 } from './geometry';

export interface PitchSymbolInput {
  /** The owner of its items. */
  readonly id: string;
  /** The view `at` is in. */
  readonly view: string;
  /** View coordinates (model mm) of the triangle's lower corner on the roof line. */
  readonly at: Vec2;
  /** The slope above horizontal, radians, above 0 and below pi / 2. */
  readonly pitch: number;
  /** Which way the roof rises on the paper from `at`. */
  readonly rises: 'left' | 'right';
  /** The run leg's length, paper mm. Default 8. */
  readonly size?: number;
  /** How far above `at` the triangle sits, paper mm. Default 3. */
  readonly lift?: number;
  /** Decimals of the rise (`7.5/12`). Default 2, trailing zeros dropped by the formatter. */
  readonly decimals?: number;
}

/** The pitch symbol's text height, paper mm. */
export const PITCH_TEXT_HEIGHT = 2.5;
/** The steepest rise leg drawn, in run legs (a steeper roof draws a 36/12 triangle, labelled true). */
const MAX_RISE = 3;

/**
 * A pitch as its two labels and its full text: `{ rise: '6', run: '12', text: '6/12' }`. Null
 * when the angle is not a roof pitch (not above 0 and below pi / 2, or not finite).
 */
export function pitchLabels(
  pitch: number,
  decimals = 2,
): { rise: string; run: string; text: string } | null {
  if (!(Number.isFinite(pitch) && pitch > 0 && pitch < Math.PI / 2)) return null;
  const text = formatAngle(pitch, { unit: 'pitch', slope: true, decimals });
  const slash = text.indexOf('/');
  if (slash < 0) return null;
  return { rise: text.slice(0, slash), run: text.slice(slash + 1), text };
}

/**
 * Lays out a pitch symbol in paper mm: the run leg level, the rise leg plumb at its high end, the
 * hypotenuse parallel to the roof (up to a rise of three runs), `12` under the run and `p` beside
 * the rise. Nothing for a pitch that is not one.
 */
export function layoutPitchSymbol(symbol: PitchSymbolInput, transform: Transform2): DisplayItem[] {
  const labels = pitchLabels(symbol.pitch, symbol.decimals ?? 2);
  if (labels === null) return [];
  const size = symbol.size ?? 8;
  const lift = symbol.lift ?? 3;
  const sign = symbol.rises === 'right' ? 1 : -1;
  const base = applyPoint(transform, symbol.at);
  const a: Vec2 = [base[0], base[1] + lift];
  const b: Vec2 = [a[0] + sign * size, a[1]];
  const rise = Math.min(Math.tan(symbol.pitch), MAX_RISE) * size;
  const c: Vec2 = [b[0], b[1] + rise];
  const owner = symbol.id;
  const gap = 1;
  return [
    { kind: 'polyline', layer: 'dimension', points: [a, b, c], closed: true, owner },
    {
      kind: 'text',
      layer: 'text',
      at: [(a[0] + b[0]) / 2, a[1] - gap],
      text: labels.run,
      height: PITCH_TEXT_HEIGHT,
      rotation: 0,
      anchor: 'middle',
      baseline: 'top',
      owner,
    },
    {
      kind: 'text',
      layer: 'text',
      at: [b[0] + sign * gap, b[1] + rise / 2],
      text: labels.rise,
      height: PITCH_TEXT_HEIGHT,
      rotation: 0,
      anchor: sign > 0 ? 'start' : 'end',
      baseline: 'middle',
      owner,
    },
  ];
}
