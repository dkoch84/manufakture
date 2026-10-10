// A load case's motion and duty cycle (ADR 0017 decisions 6 and 10): the user as a prescribed
// cable motion, cut into segments the rep simulation (T9.4b) steps through, and the sets, reps
// and rests that make a session.
//
// A half-cosine rep, as the T9.0b spike modelled it: the pull from 0 to the stroke as a
// half-cosine whose peak speed is `pullSpeed` (so it takes pi * stroke / (2 * pullSpeed)), a
// pause, the return as a half-cosine peaking at `returnSpeed`, and a pause. A table motion is
// (time, extension) points joined by straight lines. An isometric load case holds instead: one
// hold of the mode's duration per rep, at half the stroke (or the table's first extension),
// followed by the pause. Under the isokinetic law no move goes faster than the limit: a
// half-cosine whose peak is above it follows the cosine up to the limit, holds the limit and
// follows it down, covering the same stroke in more time; a straight move above it is slowed.
//
// A session is `sets` sets of `reps` reps with `rest` between sets (none after the last). Sets
// default to 1 and rest to 0.

import type { LoadCase } from '@manufakture/core';
import type { VariableLookup } from '@manufakture/units';
import { forceAt, resolveForceLaw, type ForceLaw } from './laws';
import { FieldReader, type ItemProblem } from './values';

type Dynamic = NonNullable<LoadCase['dynamic']>;

/** The motion in SI. */
export type RepMotion =
  | { kind: 'half-cosine'; stroke: number; pullSpeed: number; returnSpeed: number; pause: number }
  | { kind: 'table'; points: readonly (readonly [number, number])[] };

export type SegmentPhase = 'pull' | 'return' | 'pause' | 'hold' | 'rest';

/**
 * One piece of the prescribed motion, from extension `from` to `to` (m) over `duration` (s).
 * `cosine`: a half-cosine, zero speed at both ends. `linear`: constant speed. `capped`: a
 * half-cosine of peak speed `peak` clipped at `cap`, reached after `ramp` seconds and held.
 */
export type Segment = {
  phase: SegmentPhase;
  duration: number;
  from: number;
  to: number;
} & (
  | { shape: 'still' }
  | { shape: 'cosine' }
  | { shape: 'linear' }
  | { shape: 'capped'; peak: number; cap: number; ramp: number }
);

/** A load case's dynamic part in SI: the law, the motion and the duty cycle. */
export interface ResolvedDynamic {
  law: ForceLaw;
  motion: RepMotion;
  reps: number;
  sets: number;
  /** Seconds between sets. */
  rest: number;
  /** State of charge at the start, a fraction from 0 to 1. */
  startCharge?: number;
  /** Ambient temperature, K. */
  ambient?: number;
}

/** The duty cycle's times. */
export interface DutyCycle {
  reps: number;
  sets: number;
  rest: number;
  /** One rep, s. */
  repDuration: number;
  /** One set (its reps), s. */
  setDuration: number;
  /** The session: every set and the rests between them, s. */
  sessionDuration: number;
  /** Time under load (pulls, returns and holds, without pauses and rests), s. */
  workDuration: number;
}

/** Bounds on a duty cycle, so a typed number cannot make a client step without end. */
export const MAX_REPS = 10_000;
export const MAX_SETS = 1_000;
/** The most segments `sessionSegments` gives. */
export const MAX_SESSION_SEGMENTS = 1_000_000;

/**
 * Extension and speed `tau` seconds into a segment. Speed is positive while the cable pays out.
 */
export function segmentKinematics(seg: Segment, tau: number): { x: number; v: number } {
  const d = seg.to - seg.from;
  if (seg.shape === 'still' || d === 0 || seg.duration <= 0) return { x: seg.from, v: 0 };
  const t = Math.min(seg.duration, Math.max(0, tau));
  const sign = Math.sign(d);
  switch (seg.shape) {
    case 'linear':
      return { x: seg.from + (d * t) / seg.duration, v: d / seg.duration };
    case 'cosine': {
      const u = t / seg.duration;
      return {
        x: seg.from + (d * (1 - Math.cos(Math.PI * u))) / 2,
        v: ((d * Math.PI) / (2 * seg.duration)) * Math.sin(Math.PI * u),
      };
    }
    case 'capped': {
      // The uncapped half-cosine lasts T; its ramp up to the cap takes `ramp` and covers dr.
      const { peak, cap, ramp } = seg;
      const T = (Math.PI * Math.abs(d)) / (2 * peak);
      const w = Math.PI / T;
      const dr = (peak / w) * (1 - Math.cos(w * ramp));
      const hold = seg.duration - 2 * ramp;
      let s: number;
      let speed: number;
      if (t <= ramp) {
        s = (peak / w) * (1 - Math.cos(w * t));
        speed = peak * Math.sin(w * t);
      } else if (t <= ramp + hold) {
        s = dr + cap * (t - ramp);
        speed = cap;
      } else {
        const back = seg.duration - t; // time left, mirrored
        s = Math.abs(d) - (peak / w) * (1 - Math.cos(w * back));
        speed = peak * Math.sin(w * back);
      }
      return { x: seg.from + sign * s, v: sign * speed };
    }
  }
}

/** A move from `from` to `to` peaking at `peak`, slowed to the law's speed limit when it has one. */
function move(
  phase: 'pull' | 'return',
  from: number,
  to: number,
  peak: number,
  law: ForceLaw,
): Segment {
  const d = Math.abs(to - from);
  const T = (Math.PI * d) / (2 * peak);
  if (law.kind !== 'isokinetic' || peak <= law.speed || d === 0) {
    return { phase, duration: T, from, to, shape: 'cosine' };
  }
  const cap = law.speed;
  const w = Math.PI / T;
  const ramp = Math.asin(cap / peak) / w;
  const dr = (peak / w) * (1 - Math.cos(w * ramp));
  const hold = (d - 2 * dr) / cap;
  return { phase, duration: 2 * ramp + hold, from, to, shape: 'capped', peak, cap, ramp };
}

function pause(duration: number, at: number): Segment[] {
  return duration > 0 ? [{ phase: 'pause', duration, from: at, to: at, shape: 'still' }] : [];
}

/** The segments of one rep. */
export function repSegments(law: ForceLaw, motion: RepMotion): Segment[] {
  if (law.kind === 'isometric') {
    const at = motion.kind === 'half-cosine' ? motion.stroke / 2 : motion.points[0]![1];
    return [
      { phase: 'hold', duration: law.duration, from: at, to: at, shape: 'still' },
      ...(motion.kind === 'half-cosine' ? pause(motion.pause, at) : []),
    ];
  }
  if (motion.kind === 'half-cosine') {
    const { stroke, pullSpeed, returnSpeed } = motion;
    return [
      move('pull', 0, stroke, pullSpeed, law),
      ...pause(motion.pause, stroke),
      move('return', stroke, 0, returnSpeed, law),
      ...pause(motion.pause, 0),
    ];
  }
  const out: Segment[] = [];
  for (let i = 1; i < motion.points.length; i++) {
    const [t0, x0] = motion.points[i - 1]!;
    const [t1, x1] = motion.points[i]!;
    let duration = t1 - t0;
    if (x1 === x0) {
      out.push(...pause(duration, x0));
      continue;
    }
    if (law.kind === 'isokinetic') duration = Math.max(duration, Math.abs(x1 - x0) / law.speed);
    out.push({ phase: x1 > x0 ? 'pull' : 'return', duration, from: x0, to: x1, shape: 'linear' });
  }
  return out;
}

/** The duty cycle's times from a resolved load case. */
export function dutyCycle(d: ResolvedDynamic): DutyCycle {
  const segs = repSegments(d.law, d.motion);
  const repDuration = segs.reduce((s, x) => s + x.duration, 0);
  const work = segs.filter((x) => x.phase !== 'pause').reduce((s, x) => s + x.duration, 0);
  const setDuration = repDuration * d.reps;
  return {
    reps: d.reps,
    sets: d.sets,
    rest: d.rest,
    repDuration,
    setDuration,
    sessionDuration: setDuration * d.sets + d.rest * Math.max(0, d.sets - 1),
    workDuration: work * d.reps * d.sets,
  };
}

/**
 * Every segment of a session, rests included; or a message when there would be more than
 * `MAX_SESSION_SEGMENTS`.
 */
export function sessionSegments(
  d: ResolvedDynamic,
): { ok: true; segments: Segment[] } | { ok: false; message: string } {
  const rep = repSegments(d.law, d.motion);
  const count = rep.length * d.reps * d.sets + Math.max(0, d.sets - 1);
  if (count > MAX_SESSION_SEGMENTS) {
    return {
      ok: false,
      message: `the session has ${count} segments, more than ${MAX_SESSION_SEGMENTS}`,
    };
  }
  const out: Segment[] = [];
  for (let s = 0; s < d.sets; s++) {
    if (s > 0 && d.rest > 0)
      out.push({ phase: 'rest', duration: d.rest, from: 0, to: 0, shape: 'still' });
    for (let r = 0; r < d.reps; r++) out.push(...rep);
  }
  return { ok: true, segments: out };
}

/** The extension, speed and force `t` seconds into a list of segments (clamped to its ends). */
export function stateAt(
  segments: readonly Segment[],
  law: ForceLaw,
  t: number,
): { x: number; v: number; force: number; phase: SegmentPhase } {
  let start = 0;
  for (const seg of segments) {
    if (t <= start + seg.duration || seg === segments[segments.length - 1]) {
      const { x, v } = segmentKinematics(seg, t - start);
      const force = seg.phase === 'rest' ? 0 : forceAt(law, x, v);
      return { x, v, force, phase: seg.phase };
    }
    start += seg.duration;
  }
  return { x: 0, v: 0, force: 0, phase: 'rest' };
}

/**
 * A load case's dynamic part in SI, or every problem by its path from the load case. Reps and sets
 * are whole numbers from 1 (at most `MAX_REPS` and `MAX_SETS`); the rest and pause not below
 * zero; the stroke and speeds above zero; a table motion's times increasing and its extensions not
 * below zero; the start charge from 0 to 1.
 */
export function resolveDynamic(
  dynamic: Dynamic,
  variables: VariableLookup,
): { ok: true; value: ResolvedDynamic } | { ok: false; problems: ItemProblem[] } {
  const reader = new FieldReader(variables);
  const law = resolveForceLaw(dynamic, variables, reader);
  const m = dynamic.motion;
  const at = (k: string | number) => ['dynamic', 'motion', k];
  let motion: RepMotion;
  if (m.kind === 'half-cosine') {
    motion = {
      kind: 'half-cosine',
      stroke: reader.read(at('stroke'), m.stroke, 'length', { above: 0, what: 'the stroke' }),
      pullSpeed: reader.read(at('pullSpeed'), m.pullSpeed, 'speed', {
        above: 0,
        what: 'the pull speed',
      }),
      returnSpeed: reader.read(at('returnSpeed'), m.returnSpeed, 'speed', {
        above: 0,
        what: 'the return speed',
      }),
      pause: reader.read(at('pause'), m.pause, 'time', { min: 0, what: 'the pause' }),
    };
  } else {
    m.points.forEach(([t, x], i) => {
      if (i > 0 && !(t > m.points[i - 1]![0])) {
        reader.problem(
          ['dynamic', 'motion', 'points', i],
          'the times must increase from one point to the next',
        );
      }
      if (x < 0)
        reader.problem(['dynamic', 'motion', 'points', i], 'an extension must not be below zero');
    });
    motion = { kind: 'table', points: m.points.map(([t, x]) => [t, x] as const) };
  }
  const reps = reader.read(['dynamic', 'reps'], dynamic.reps, 'number', {
    min: 1,
    max: MAX_REPS,
    integer: true,
    what: 'the reps',
  });
  const sets =
    dynamic.sets === undefined
      ? 1
      : reader.read(['dynamic', 'sets'], dynamic.sets, 'number', {
          min: 1,
          max: MAX_SETS,
          integer: true,
          what: 'the sets',
        });
  const rest =
    dynamic.rest === undefined
      ? 0
      : reader.read(['dynamic', 'rest'], dynamic.rest, 'time', { min: 0, what: 'the rest' });
  const value: ResolvedDynamic = {
    law: law.ok ? law.law : (undefined as never),
    motion,
    reps,
    sets,
    rest,
  };
  if (dynamic.startCharge !== undefined) {
    value.startCharge = reader.read(['dynamic', 'startCharge'], dynamic.startCharge, 'number', {
      min: 0,
      max: 1,
      what: 'the start charge',
    });
  }
  if (dynamic.ambient !== undefined) {
    value.ambient = reader.read(['dynamic', 'ambient'], dynamic.ambient, 'temperature', {
      above: 0,
      what: 'the ambient temperature',
    });
  }
  if (reader.problems.length > 0 || !law.ok) return { ok: false, problems: [...reader.problems] };
  return { ok: true, value };
}
