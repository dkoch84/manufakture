// What the simulation steps through: a load case's motion as segments (`requirements/motion.ts`)
// with the force its law sets, scaled per segment so a set can ramp its force in and out at the
// docked position, as firmware would. A rest carries no force.

import type { ForceLaw } from '../requirements/laws';
import {
  repSegments,
  sessionSegments,
  type ResolvedDynamic,
  type Segment,
} from '../requirements/motion';

/**
 * A segment of the motion with its force: the law's force times a factor that moves linearly
 * from `scale[0]` to `scale[1]` over the segment (default 1 throughout; a rest is 0 throughout).
 */
export type SimSegment = Segment & { scale?: readonly [number, number] };

/** The force factor of a segment `u` of the way through it (0 to 1). */
export function segmentScale(seg: SimSegment, u: number): number {
  if (seg.scale !== undefined) return seg.scale[0] + (seg.scale[1] - seg.scale[0]) * u;
  return seg.phase === 'rest' ? 0 : 1;
}

export interface ProfileOptions {
  /**
   * Seconds over which each set's force rises from none at its start and falls back at its end,
   * at the docked position; 0 (the default) steps it, which the quasi-static currents follow at
   * once.
   */
  ramp?: number;
  /** One rep only, not the whole session. */
  oneRep?: boolean;
}

/** The segments of a load case's session (or one rep), or why there are none. */
export function simProfile(
  d: ResolvedDynamic,
  options: ProfileOptions = {},
): { ok: true; segments: SimSegment[] } | { ok: false; message: string } {
  const ramp = options.ramp ?? 0;
  const rep = repSegments(d.law, d.motion);
  let body: Segment[];
  if (options.oneRep === true) body = rep;
  else {
    const s = sessionSegments(d);
    if (!s.ok) return s;
    body = s.segments;
  }
  if (!(ramp > 0)) return { ok: true, segments: body };
  const out: SimSegment[] = [];
  const at = rep[0]?.from ?? 0;
  const end = rep[rep.length - 1]?.to ?? at;
  let inSet = false;
  for (const seg of body) {
    if (seg.phase === 'rest') {
      if (inSet) out.push(rampSeg(ramp, end, [1, 0]));
      inSet = false;
      out.push(seg);
      continue;
    }
    if (!inSet) out.push(rampSeg(ramp, at, [0, 1]));
    inSet = true;
    out.push(seg);
  }
  if (inSet) out.push(rampSeg(ramp, end, [1, 0]));
  return { ok: true, segments: out };
}

function rampSeg(duration: number, at: number, scale: [number, number]): SimSegment {
  return { phase: 'pause', duration, from: at, to: at, shape: 'still', scale };
}

/** The profile's total duration, s. */
export function profileDuration(segments: readonly SimSegment[]): number {
  let t = 0;
  for (const s of segments) t += s.duration;
  return t;
}

/** A law that sets no force at all (a free spin of the drivetrain, for tests and checks). */
export const NO_FORCE: ForceLaw = { kind: 'constant', force: 0 };
