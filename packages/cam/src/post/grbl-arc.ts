// Grbl 1.1's two arc checks, emulated on the text the post writes (ADR 0014 decision 10; T5.0a
// "Tiny arcs"). Grbl reads every number in single precision (`read_float`), converts inches to
// millimetres, adds the work offset, and then:
//
// - `gcode.c` (error 33, "invalid target"): the end point's distance from the centre may differ
//   from the start point's by more than 0.005 mm only if it also differs by at most 0.1% of the
//   radius, and never by more than 0.5 mm;
// - `motion_control.c` `mc_arc`: the angular travel is atan2 of the radius vectors to the start
//   and the end; within 5e-7 rad of zero it gains a full turn, so a tiny arc becomes a circle.
//
// The work offset (G54 and G92 on the machine) is not known when the file is written, and single
// precision rounding depends on the size of the machine coordinates, so the check runs at several
// offsets that span a large router's travel on both signs.

import type { Vec2 } from '../types';
import { MM_PER_INCH } from '@manufakture/units';
import { grblReadFloat } from './format';

/** Grbl's radius rule: the absolute allowance, mm. */
export const GRBL_RADIUS_ABSOLUTE = 0.005;
/** Grbl's radius rule: the relative allowance, as a fraction of the radius. */
export const GRBL_RADIUS_RELATIVE = 0.001;
/** Grbl's radius rule: the most the radii may ever differ, mm. */
export const GRBL_RADIUS_MAX = 0.5;
/** `ARC_ANGULAR_TRAVEL_EPSILON` in Grbl's `config.h`, radians. */
export const GRBL_TRAVEL_EPSILON = 5e-7;
/**
 * Margin on the radius rule in exact arithmetic: the radii of the written numbers must differ by
 * at most this fraction of Grbl's allowance (0.004 mm of 0.005), so that controllers with other
 * arithmetic (grblHAL's mixed float and double) accept the arc too. Rounding to 4 decimals of an
 * inch alone can make the radii differ by about 0.0036 mm, which this still lets through.
 */
export const RADIUS_MARGIN = 0.8;
/** Grbl's angular travel may differ from the intended sweep by at most this much, radians. */
export const TRAVEL_TOLERANCE = 0.5;

/**
 * Work offsets (machine XY of the work zero, mm) the single precision check runs at: zero, and
 * points near the corners of a 1.5 m travel in negative space (Grbl's default after homing) and
 * positive space, with untidy fractions as real offsets have.
 */
export const GRBL_CHECK_OFFSETS: readonly Vec2[] = [
  [0, 0],
  [-1499.873, -1499.611],
  [-731.219, -402.557],
  [-0.731, -1210.093],
  [1499.873, 1499.611],
  [402.557, -731.219],
];

export interface GrblArcInput {
  /** The X and Y words of the position before the arc, as written (file units). */
  readonly start: readonly [string, string];
  /** The arc's X and Y words, as written. */
  readonly end: readonly [string, string];
  /** The arc's I and J words, as written. */
  readonly ij: readonly [string, string];
  /** True under G20: every word is in inches. */
  readonly inches: boolean;
  readonly direction: 'cw' | 'ccw';
  /** The sweep the arc is meant to have, radians, in (0, 2 pi]. */
  readonly sweep: number;
}

export interface GrblArcCheck {
  /** The largest radius difference Grbl computes at any offset, mm. */
  readonly deltaR: number;
  /** The radius difference of the written numbers in exact arithmetic, mm. */
  readonly exactDeltaR: number;
  readonly radiusOk: boolean;
  /** Grbl's angular travel furthest from the intended sweep, radians (negative clockwise). */
  readonly travel: number;
  readonly travelOk: boolean;
  readonly ok: boolean;
}

const f = Math.fround;
const F_MM_PER_INCH = f(MM_PER_INCH);
const TAU = 2 * Math.PI;

/** Grbl's allowance for a radius difference at radius `r`, mm. */
export function grblRadiusAllowance(r: number): number {
  return Math.min(GRBL_RADIUS_MAX, Math.max(GRBL_RADIUS_ABSOLUTE, GRBL_RADIUS_RELATIVE * r));
}

/** Run Grbl's radius rule and its angular travel on the written words, at every offset. */
export function grblArcCheck(
  input: GrblArcInput,
  offsets: readonly Vec2[] = GRBL_CHECK_OFFSETS,
): GrblArcCheck {
  // Exact arithmetic on the written decimals, in mm.
  const k = input.inches ? MM_PER_INCH : 1;
  const sx = Number(input.start[0]) * k;
  const sy = Number(input.start[1]) * k;
  const ex = Number(input.end[0]) * k;
  const ey = Number(input.end[1]) * k;
  const i = Number(input.ij[0]) * k;
  const j = Number(input.ij[1]) * k;
  const r0 = Math.hypot(i, j);
  const exactDeltaR = Math.abs(Math.hypot(ex - sx - i, ey - sy - j) - r0);
  let radiusOk = exactDeltaR <= RADIUS_MARGIN * grblRadiusAllowance(r0);

  let deltaR = 0;
  let travelOk = true;
  const want = input.direction === 'ccw' ? input.sweep : -input.sweep;
  let worstTravel = want;
  for (const offset of offsets) {
    const c = singlePrecision(input, offset);
    deltaR = Math.max(deltaR, c.deltaR);
    if (!c.radiusOk) radiusOk = false;
    if (Math.abs(c.travel - want) > Math.abs(worstTravel - want)) worstTravel = c.travel;
    if (Math.abs(c.travel - want) > TRAVEL_TOLERANCE) travelOk = false;
  }
  return {
    deltaR,
    exactDeltaR,
    radiusOk,
    travel: worstTravel,
    travelOk,
    ok: radiusOk && travelOk,
  };
}

/** One offset, step by step as `gcode.c` and `mc_arc` compute it in single precision. */
function singlePrecision(
  input: GrblArcInput,
  offset: Vec2,
): { deltaR: number; radiusOk: boolean; travel: number } {
  const toMm = (text: string): number => {
    const v = grblReadFloat(text);
    return input.inches ? f(v * F_MM_PER_INCH) : v;
  };
  // Absolute targets: value plus work offset (G92's offset taken as zero).
  const px = f(toMm(input.start[0]) + f(offset[0]));
  const py = f(toMm(input.start[1]) + f(offset[1]));
  const tx = f(toMm(input.end[0]) + f(offset[0]));
  const ty = f(toMm(input.end[1]) + f(offset[1]));
  const i = toMm(input.ij[0]);
  const j = toMm(input.ij[1]);

  // gcode.c, arc centre format.
  const x = f(f(tx - px) - i);
  const y = f(f(ty - py) - j);
  const targetR = f(Math.sqrt(f(f(x * x) + f(y * y))));
  const r = f(Math.sqrt(f(f(i * i) + f(j * j))));
  const deltaR = Math.abs(f(targetR - r));
  let radiusOk = true;
  if (deltaR > f(GRBL_RADIUS_ABSOLUTE)) {
    if (deltaR > f(GRBL_RADIUS_MAX) || deltaR > f(f(GRBL_RADIUS_RELATIVE) * r)) radiusOk = false;
  }

  // motion_control.c, mc_arc.
  const cx = f(px + i);
  const cy = f(py + j);
  const r0 = -i;
  const r1 = -j;
  const rt0 = f(tx - cx);
  const rt1 = f(ty - cy);
  let travel = f(Math.atan2(f(f(r0 * rt1) - f(r1 * rt0)), f(f(r0 * rt0) + f(r1 * rt1))));
  if (input.direction === 'cw') {
    if (travel >= -f(GRBL_TRAVEL_EPSILON)) travel = f(travel - f(TAU));
  } else if (travel <= f(GRBL_TRAVEL_EPSILON)) {
    travel = f(travel + f(TAU));
  }
  return { deltaR, radiusOk, travel };
}
