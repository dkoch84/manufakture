// The motion and the duty cycle (T9.4a): the half-cosine rep with the T9.0b spike's timing, the
// isokinetic cap, isometric holds, table motions, sets, reps and rests, and the problems.

import type { LoadCase, StoredExpression } from '@manufakture/core';
import { describe, expect, it } from 'vitest';
import {
  MAX_SESSION_SEGMENTS,
  dutyCycle,
  repSegments,
  resolveDynamic,
  segmentKinematics,
  sessionSegments,
  stateAt,
  type ResolvedDynamic,
  type Segment,
} from './motion';
import { NO_VARIABLES } from './values';

const x = (source: string): StoredExpression => ({ source, lengthUnit: 'mm', angleUnit: 'deg' });
type Dynamic = NonNullable<LoadCase['dynamic']>;

function resolved(d: Partial<Dynamic> = {}): ResolvedDynamic {
  const r = resolveDynamic(
    {
      mode: { kind: 'constant' },
      force: x('200 lbf'),
      motion: {
        kind: 'half-cosine',
        stroke: x('0.6 m'),
        pullSpeed: x('1.5 m/s'),
        returnSpeed: x('1 m/s'),
        pause: x('0.2 s'),
      },
      reps: x('10'),
      ...d,
    },
    NO_VARIABLES,
  );
  if (!r.ok) throw new Error(JSON.stringify(r.problems));
  return r.value;
}

/** Steps through a segment and returns the largest speed and the distance by integration. */
function walk(seg: Segment, n = 20000): { peak: number; travelled: number; end: number } {
  let peak = 0;
  let travelled = 0;
  let prev = segmentKinematics(seg, 0);
  for (let i = 1; i <= n; i++) {
    const k = segmentKinematics(seg, (seg.duration * i) / n);
    peak = Math.max(peak, Math.abs(k.v));
    travelled += ((Math.abs(k.v) + Math.abs(prev.v)) / 2) * (seg.duration / n);
    prev = k;
  }
  return { peak, travelled, end: prev.x };
}

describe('a half-cosine rep', () => {
  it('pulls in the spike time, peaks at the pull speed and covers the stroke', () => {
    const d = resolved();
    const segs = repSegments(d.law, d.motion);
    expect(segs.map((s) => s.phase)).toEqual(['pull', 'pause', 'return', 'pause']);
    // T9.0b: 0.6 m at 1.5 m/s peak is 0.628 s.
    expect(segs[0]!.duration).toBeCloseTo((Math.PI * 0.6) / 3, 12);
    expect(segs[0]!.duration).toBeCloseTo(0.628, 3);
    const pull = walk(segs[0]!);
    expect(pull.peak).toBeCloseTo(1.5, 6);
    expect(pull.travelled).toBeCloseTo(0.6, 6);
    expect(pull.end).toBeCloseTo(0.6, 12);
    const back = walk(segs[2]!);
    expect(back.peak).toBeCloseTo(1, 6);
    expect(segmentKinematics(segs[2]!, 0.1).v).toBeLessThan(0);
    expect(back.end).toBeCloseTo(0, 12);
  });

  it('gives the duty cycle: sets, reps and rests', () => {
    const d = resolved({ reps: x('9'), sets: x('13'), rest: x('60 s') });
    const c = dutyCycle(d);
    const rep = (Math.PI * 0.6) / 3 + (Math.PI * 0.6) / 2 + 0.4;
    expect(c.repDuration).toBeCloseTo(rep, 12);
    expect(c.setDuration).toBeCloseTo(9 * rep, 12);
    expect(c.sessionDuration).toBeCloseTo(13 * 9 * rep + 12 * 60, 9);
    expect(c.workDuration).toBeCloseTo(13 * 9 * (rep - 0.4), 9);
    const s = sessionSegments(d);
    expect(s.ok).toBe(true);
    if (!s.ok) return;
    expect(s.segments.filter((x) => x.phase === 'rest')).toHaveLength(12);
    const total = s.segments.reduce((a, x) => a + x.duration, 0);
    expect(total).toBeCloseTo(c.sessionDuration, 9);
  });

  it('defaults to one set with no rest', () => {
    const c = dutyCycle(resolved({ reps: x('3') }));
    expect([c.sets, c.rest]).toEqual([1, 0]);
    expect(c.sessionDuration).toBeCloseTo(c.repDuration * 3, 12);
  });

  it("gives the state at a time with the law's force", () => {
    const d = resolved({ mode: { kind: 'eccentric', factor: x('1.5') }, force: x('100 N') });
    const segs = repSegments(d.law, d.motion);
    const mid = stateAt(segs, d.law, segs[0]!.duration / 2);
    expect(mid.phase).toBe('pull');
    expect(mid.x).toBeCloseTo(0.3, 12);
    expect(mid.v).toBeCloseTo(1.5, 12);
    expect(mid.force).toBe(100);
    const back = stateAt(segs, d.law, segs[0]!.duration + 0.2 + segs[2]!.duration / 2);
    expect(back.phase).toBe('return');
    expect(back.force).toBeCloseTo(150, 12);
  });
});

describe('the isokinetic cap', () => {
  it('follows the cosine to the limit, holds it and still covers the stroke', () => {
    const d = resolved({ mode: { kind: 'isokinetic', speed: x('1 m/s') } });
    const [pull, , back] = repSegments(d.law, d.motion);
    expect(pull!.shape).toBe('capped');
    const w = walk(pull!);
    expect(w.peak).toBeCloseTo(1, 9);
    expect(w.travelled).toBeCloseTo(0.6, 6);
    expect(w.end).toBeCloseTo(0.6, 9);
    // Slower than the uncapped pull; the return at 1 m/s is not above the limit.
    expect(pull!.duration).toBeGreaterThan((Math.PI * 0.6) / 3);
    expect(back!.shape).toBe('cosine');
    // Continuous where the ramp meets the hold.
    if (pull!.shape !== 'capped') return;
    const a = segmentKinematics(pull!, pull!.ramp - 1e-9);
    const b = segmentKinematics(pull!, pull!.ramp + 1e-9);
    expect(a.x).toBeCloseTo(b.x, 6);
    expect(a.v).toBeCloseTo(b.v, 6);
    // Force only while at the limit.
    const held = stateAt([pull!], d.law, pull!.duration / 2);
    expect(held.v).toBe(1);
    expect(held.force).toBeCloseTo(889.64, 2);
    expect(stateAt([pull!], d.law, pull!.ramp / 2).force).toBe(0);
  });

  it('slows a straight move above the limit', () => {
    const d = resolved({
      mode: { kind: 'isokinetic', speed: x('0.5 m/s') },
      motion: {
        kind: 'table',
        points: [
          [0, 0],
          [0.5, 1],
        ],
      },
    });
    const [move] = repSegments(d.law, d.motion);
    expect(move).toMatchObject({ phase: 'pull', shape: 'linear', duration: 2 });
  });
});

describe('other motions', () => {
  it('holds an isometric case at mid-stroke for its duration', () => {
    const d = resolved({ mode: { kind: 'isometric', duration: x('30 s') }, reps: x('1') });
    const segs = repSegments(d.law, d.motion);
    expect(segs[0]).toMatchObject({ phase: 'hold', duration: 30, from: 0.3, to: 0.3 });
    expect(dutyCycle(d).workDuration).toBe(30);
  });

  it('joins a table motion with straight moves, pausing where it stands still', () => {
    const d = resolved({
      motion: {
        kind: 'table',
        points: [
          [0, 0],
          [1, 0.5],
          [2, 0.5],
          [4, 0],
        ],
      },
    });
    const segs = repSegments(d.law, d.motion);
    expect(segs.map((s) => [s.phase, s.duration])).toEqual([
      ['pull', 1],
      ['pause', 1],
      ['return', 2],
    ]);
    expect(segmentKinematics(segs[2]!, 1)).toEqual({ x: 0.25, v: -0.25 });
  });

  it('refuses a session with too many segments', () => {
    const d = resolved({ reps: x('10000'), sets: x('1000') });
    const r = sessionSegments(d);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain(String(MAX_SESSION_SEGMENTS));
  });
});

describe('problems with a dynamic load case', () => {
  it('names each field', () => {
    const r = resolveDynamic(
      {
        mode: { kind: 'constant' },
        force: x('100 N'),
        motion: {
          kind: 'half-cosine',
          stroke: x('0'),
          pullSpeed: x('1 m/s'),
          returnSpeed: x('-1 m/s'),
          pause: x('0.2 s'),
        },
        reps: x('2.5'),
        sets: x('0'),
        rest: x('-1 s'),
        startCharge: x('1.2'),
        ambient: x('20 degC'),
      },
      NO_VARIABLES,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.problems.map((p) => p.path.join('.'))).toEqual([
      'dynamic.motion.stroke',
      'dynamic.motion.returnSpeed',
      'dynamic.reps',
      'dynamic.sets',
      'dynamic.rest',
      'dynamic.startCharge',
    ]);
  });

  it('reads the ambient as kelvin and the start charge as a fraction', () => {
    const d = resolved({ ambient: x('40 degC'), startCharge: x('0.8') });
    expect(d.ambient).toBeCloseTo(313.15, 9);
    expect(d.startCharge).toBe(0.8);
  });

  it('refuses table motions that go back in time or below zero', () => {
    const r = resolveDynamic(
      {
        mode: { kind: 'constant' },
        force: x('100 N'),
        motion: {
          kind: 'table',
          points: [
            [1, 0],
            [0, -0.1],
          ],
        },
        reps: x('1'),
      },
      NO_VARIABLES,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems).toHaveLength(2);
  });
});
