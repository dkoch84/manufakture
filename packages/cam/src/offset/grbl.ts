// Grbl 1.1's arc checks as the refit's last step applies them (ADR 0014 decisions 10 and 12;
// T5.0a spike, "Tiny arcs must become lines"): a pre-check in the setup's frame at the default
// output precision, so arcs the post would demote are mostly lines already. The post's own
// check (`post/grbl-arc.ts`, T5.4a) is the authoritative one: it runs on the words as written,
// in the file's units and at several work offsets.

import type { ArcSegment2 } from '../types';
import { signedSweep } from './geometry';
import {
  GRBL_CHECK_DECIMALS,
  GRBL_RADIUS_ABS,
  GRBL_RADIUS_MAX,
  GRBL_RADIUS_REL,
  GRBL_TRAVEL_EPSILON,
  GRBL_TRAVEL_SLACK,
} from './tolerances';

export interface GrblArcPrecheck {
  /** Start radius minus end radius as written, absolute, mm. */
  readonly radiusDiff: number;
  /** Passes the radius rule (error 33, "invalid target"). */
  readonly radiusOk: boolean;
  /** The angular travel Grbl's `mc_arc` computes from the written words, radians, signed. */
  readonly travel: number;
  /** The sweep meant, radians, signed (positive counter-clockwise). */
  readonly sweep: number;
  /** Grbl cuts the arc meant: not a full circle, not the long way round. */
  readonly travelOk: boolean;
  readonly ok: boolean;
}

const round = (v: number, decimals: number): number => {
  const f = 10 ** decimals;
  return Math.round(v * f) / f;
};

/**
 * Checks an arc as a post writes it, X, Y, I and J rounded to `decimals`, against Grbl 1.1:
 *
 * - the radius rule (`gcode.c`, error 33): the end radius may differ from the start radius by at
 *   most 0.005 mm or 0.1% of the radius, and never by more than 0.5 mm;
 * - the angular travel (`motion_control.c`, `mc_arc`): atan2 of the two radius vectors in single
 *   precision; a G2 whose travel is at or above -5e-7 rad loses a full turn, a G3 at or below
 *   5e-7 gains one. So an arc whose written ends coincide runs as a full circle. The travel must
 *   be within 0.5 rad of the sweep meant.
 *
 * The coordinates are taken as written: callers pass the arc in the output frame and units.
 */
export function grblArcPrecheck(arc: ArcSegment2, decimals = GRBL_CHECK_DECIMALS): GrblArcPrecheck {
  const f = Math.fround;
  const sx = round(arc.start[0], decimals);
  const sy = round(arc.start[1], decimals);
  const ex = round(arc.end[0], decimals);
  const ey = round(arc.end[1], decimals);
  const i = round(arc.center[0] - arc.start[0], decimals);
  const j = round(arc.center[1] - arc.start[1], decimals);
  const cx = sx + i;
  const cy = sy + j;
  const rs = Math.hypot(sx - cx, sy - cy);
  const re = Math.hypot(ex - cx, ey - cy);
  const radiusDiff = Math.abs(rs - re);
  const radiusOk = !(
    (radiusDiff > GRBL_RADIUS_ABS && radiusDiff > GRBL_RADIUS_REL * rs) ||
    radiusDiff > GRBL_RADIUS_MAX
  );
  const r0 = f(-i);
  const r1 = f(-j);
  const t0 = f(f(ex) - f(f(sx) + f(i)));
  const t1 = f(f(ey) - f(f(sy) + f(j)));
  let travel = Math.atan2(f(f(r0 * t1) - f(r1 * t0)), f(f(r0 * t0) + f(r1 * t1)));
  if (!arc.ccw) {
    if (travel >= -GRBL_TRAVEL_EPSILON) travel -= 2 * Math.PI;
  } else if (travel <= GRBL_TRAVEL_EPSILON) travel += 2 * Math.PI;
  const sweep = signedSweep(arc);
  const travelOk = Math.abs(travel - sweep) <= GRBL_TRAVEL_SLACK;
  return { radiusDiff, radiusOk, travel, sweep, travelOk, ok: radiusOk && travelOk };
}
