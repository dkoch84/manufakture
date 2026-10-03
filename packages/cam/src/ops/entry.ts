// Ramp and helix entries: the angle range every operation accepts, and the bounds on how long an
// entry may be. A ramp's length and a helix's turn count both grow as 1 / tan(angle), so a
// vanishing angle (from a mistyped or hostile document) would emit hundreds of millions of moves.

import type { Entry } from '../types';

/**
 * The shallowest ramp or helix angle accepted, radians: half a degree. Real ramp angles for
 * routers are 1 to 5 degrees (2 to 3 is the usual advice for small end mills); half a degree is
 * already a very gentle entry, and keeps a ramp at most about 115 times its drop.
 */
export const ENTRY_MIN_ANGLE = (0.5 * Math.PI) / 180;

/**
 * The most times a helix entry may go round, or a ramp entry go round its ring, to reach one
 * level. Far above any real entry (a 0.5 mm radius helix at half a degree drops about 0.027 mm a
 * turn: some 1,800 turns for a 50 mm drop); above it the operation is refused.
 */
export const ENTRY_MAX_TURNS = 10_000;

/**
 * The most moves one ramp entry may emit (its laps times the segments of its ring). Above it the
 * operation is refused.
 */
export const ENTRY_MAX_RAMP_MOVES = 1_000_000;

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** What is wrong with an entry's kind, angle or radius, as a sentence; undefined when it is fine. */
export function entryProblem(e: Entry): string | undefined {
  if (e.kind === 'ramp' || e.kind === 'helix') {
    if (!(finite(e.angle) && e.angle >= ENTRY_MIN_ANGLE - 1e-12 && e.angle <= Math.PI / 2)) {
      return `The ${e.kind} angle must be at least 0.5 and at most 90 degrees.`;
    }
    if (e.kind === 'helix' && !(finite(e.radius) && e.radius > 0)) {
      return 'The helix radius must be greater than zero.';
    }
    return undefined;
  }
  if (e.kind !== 'plunge') return 'Unknown entry kind.';
  return undefined;
}

const fmt = (v: number, digits = 3): string => String(Number(v.toFixed(digits)));

/** The turns of a helix dropping `drop` at `angle` on `radius`: at least one. */
export function helixTurns(drop: number, radius: number, angle: number): number {
  return Math.max(1, Math.ceil(drop / (2 * Math.PI * radius * Math.tan(angle)) - 1e-9));
}

/** Why a helix of `turns` turns is refused, or undefined when it is within `ENTRY_MAX_TURNS`. */
export function helixTooLong(
  turns: number,
  drop: number,
  radius: number,
  angle: number,
): string | undefined {
  if (turns <= ENTRY_MAX_TURNS) return undefined;
  return `a helix entry dropping ${fmt(drop)} mm at ${fmt((angle * 180) / Math.PI, 2)} degrees on a ${fmt(radius)} mm radius needs ${turns} turns; at most ${ENTRY_MAX_TURNS} are allowed. Use a steeper angle, a larger radius, a smaller stepdown or a plunge entry.`;
}

/**
 * Why a ramp `rampLength` long round a ring `ringLength` long of `segments` segments is refused,
 * or undefined when its laps and moves are within `ENTRY_MAX_TURNS` and `ENTRY_MAX_RAMP_MOVES`.
 * Each of the ring's `tabs` breaks a lap in two more places (up over the tab and down again).
 */
export function rampTooLong(
  rampLength: number,
  ringLength: number,
  segments: number,
  tabs = 0,
): string | undefined {
  const laps = Math.ceil(rampLength / ringLength);
  if (laps <= ENTRY_MAX_TURNS && laps * (segments + 2 * tabs) <= ENTRY_MAX_RAMP_MOVES) {
    return undefined;
  }
  return `a ramp entry ${fmt(rampLength)} mm long goes ${laps} times round a ${fmt(ringLength)} mm ring of ${segments} segments${tabs > 0 ? ` and ${tabs} tabs` : ''}; at most ${ENTRY_MAX_TURNS} laps and ${ENTRY_MAX_RAMP_MOVES / 1e6} million moves are allowed. Use a steeper angle, a smaller stepdown or a plunge entry.`;
}
