// The resistance laws (T9.4a): each mode's force against position and speed evaluated from its
// law, the modes read from a load case's expressions in SI with their problems by field, and the
// curves the editor plots.

import type { LoadCase, StoredExpression } from '@manufakture/core';
import { describe, expect, it } from 'vitest';
import {
  forceAt,
  forceCurves,
  interpolate,
  limitSpeed,
  resolveForceLaw,
  RESISTANCE_MODES,
  type ForceLaw,
} from './laws';
import { NO_VARIABLES } from './values';

const x = (source: string): StoredExpression => ({ source, lengthUnit: 'mm', angleUnit: 'deg' });
const LBF = 4.4482216152605;

type Dynamic = NonNullable<LoadCase['dynamic']>;
const dynamic = (mode: Dynamic['mode'], force = '200 lbf'): Dynamic => ({
  mode,
  force: x(force),
  motion: {
    kind: 'half-cosine',
    stroke: x('0.6 m'),
    pullSpeed: x('1.5 m/s'),
    returnSpeed: x('1 m/s'),
    pause: x('0.2 s'),
  },
  reps: x('9'),
});

const law = (mode: Dynamic['mode'], force?: string): ForceLaw => {
  const r = resolveForceLaw(dynamic(mode, force), NO_VARIABLES);
  if (!r.ok) throw new Error(JSON.stringify(r.problems));
  return r.law;
};

describe('each resistance law', () => {
  it('constant: the same force at every position and speed', () => {
    const l = law({ kind: 'constant' });
    expect(l.force).toBeCloseTo(200 * LBF, 6);
    for (const [px, v] of [
      [0, 1.5],
      [0.3, 0],
      [0.6, -1],
    ] as const) {
      expect(forceAt(l, px, v)).toBeCloseTo(889.64, 2);
    }
  });

  it('eccentric: more force on the way back', () => {
    const l = law({ kind: 'eccentric', factor: x('1.3') }, '100 N');
    expect(forceAt(l, 0.3, 1)).toBe(100);
    expect(forceAt(l, 0.3, 0)).toBe(100);
    expect(forceAt(l, 0.3, -1)).toBeCloseTo(130, 9);
  });

  it('band: force rising linearly with extension', () => {
    const l = law({ kind: 'band', rate: x('200 N/m') }, '100 N');
    expect(forceAt(l, 0, 1)).toBe(100);
    expect(forceAt(l, 0.5, 1)).toBeCloseTo(200, 9);
    expect(forceAt(l, 0.5, -1)).toBeCloseTo(200, 9);
  });

  it('chains: force rising with extension once the chains leave the floor', () => {
    const l = law({ kind: 'chains', rate: x('100 N/m'), from: x('0.2 m') }, '100 N');
    expect(l).toMatchObject({ rate: 100, from: 0.2 });
    expect(forceAt(l, 0.1, 1)).toBe(100);
    expect(forceAt(l, 0.2, 1)).toBe(100);
    expect(forceAt(l, 0.6, 1)).toBeCloseTo(140, 9);
  });

  it('isokinetic: the force at the speed limit, none below it, speed capped', () => {
    const l = law({ kind: 'isokinetic', speed: x('0.5 m/s') }, '300 N');
    expect(forceAt(l, 0.3, 0.2)).toBe(0);
    expect(forceAt(l, 0.3, 0.5)).toBe(300);
    expect(forceAt(l, 0.3, -0.5)).toBe(300);
    expect(limitSpeed(l, 1.5)).toBe(0.5);
    expect(limitSpeed(l, -1)).toBe(-0.5);
    expect(limitSpeed(l, 0.2)).toBe(0.2);
  });

  it('damper: force from speed on the pull, up to the setting', () => {
    const l = law({ kind: 'damper', coefficient: x('100 N*s/m') }, '200 N');
    expect(l).toMatchObject({ coefficient: 100 });
    expect(forceAt(l, 0.3, 1)).toBeCloseTo(100, 9);
    expect(forceAt(l, 0, 1.5)).toBeCloseTo(150, 9);
    expect(forceAt(l, 0.3, 3)).toBe(200);
    expect(forceAt(l, 0.3, -1)).toBe(0);
  });

  it('rowing: force from speed squared on the pull, up to the setting', () => {
    const l = law({ kind: 'rowing', coefficient: x('50 lbf / (3 m/s)^2') }, '50 lbf');
    if (l.kind !== 'rowing') throw new Error('kind');
    expect(l.coefficient).toBeCloseTo((50 * LBF) / 9, 9);
    expect(forceAt(l, 0.3, 1.5)).toBeCloseTo((50 * LBF) / 4, 6);
    expect(forceAt(l, 0.3, 3)).toBeCloseTo(50 * LBF, 6);
    expect(forceAt(l, 0.3, 4)).toBeCloseTo(50 * LBF, 6);
    expect(forceAt(l, 0.3, -2)).toBe(0);
  });

  it('isometric: the force, held', () => {
    const l = law({ kind: 'isometric', duration: x('30 s') });
    expect(l).toMatchObject({ duration: 30 });
    expect(forceAt(l, 0.3, 0)).toBeCloseTo(889.64, 2);
  });

  it('table: the user curve by position or by speed, flat beyond its ends, clipped to the setting', () => {
    const byPos = law(
      {
        kind: 'table',
        by: 'position',
        points: [
          [0, 50],
          [0.5, 150],
          [1, 400],
        ],
      },
      '300 N',
    );
    expect(forceAt(byPos, -1, 1)).toBe(50);
    expect(forceAt(byPos, 0.25, 1)).toBeCloseTo(100, 9);
    expect(forceAt(byPos, 0.75, -1)).toBeCloseTo(275, 9);
    expect(forceAt(byPos, 1, 1)).toBe(300);
    const bySpeed = law(
      {
        kind: 'table',
        by: 'speed',
        points: [
          [-1, 20],
          [0, 0],
          [2, 200],
        ],
      },
      '1 kN',
    );
    expect(forceAt(bySpeed, 0.3, -0.5)).toBeCloseTo(10, 9);
    expect(forceAt(bySpeed, 0.3, 1)).toBeCloseTo(100, 9);
    expect(forceAt(bySpeed, 0.3, 5)).toBe(200);
  });

  it('interpolates in sorted points by bisection', () => {
    const pts = Array.from({ length: 101 }, (_, i) => [i, i * i] as const);
    expect(interpolate(pts, 10.5)).toBeCloseTo((100 + 121) / 2, 9);
    expect(interpolate(pts, 100)).toBe(10000);
  });
});

describe('reading a mode from the load case', () => {
  it('names every field that does not evaluate or is out of range', () => {
    const bad = resolveForceLaw(
      dynamic({ kind: 'eccentric', factor: x('0.8') }, '0 N'),
      NO_VARIABLES,
    );
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.problems.map((p) => p.path.join('.'))).toEqual([
      'dynamic.force',
      'dynamic.mode.factor',
    ]);
    expect(bad.problems[1]!.message).toMatch(/at least 1/);
  });

  it('wants units in physical fields and the right dimension for a coefficient', () => {
    const bare = resolveForceLaw(dynamic({ kind: 'constant' }, '200'), NO_VARIABLES);
    expect(bare.ok).toBe(false);
    const wrong = resolveForceLaw(
      dynamic({ kind: 'damper', coefficient: x('100 N/m') }),
      NO_VARIABLES,
    );
    expect(wrong.ok).toBe(false);
    if (wrong.ok) return;
    expect(wrong.problems[0]!.path).toEqual(['dynamic', 'mode', 'coefficient']);
    expect(wrong.problems[0]!.message).toMatch(/force per speed/);
  });

  it('refuses a table whose keys do not increase or whose forces are negative', () => {
    const r = resolveForceLaw(
      dynamic({
        kind: 'table',
        by: 'position',
        points: [
          [0, 10],
          [0, -1],
        ],
      }),
      NO_VARIABLES,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.problems.map((p) => p.message)).toEqual([
      expect.stringMatching(/must increase/),
      expect.stringMatching(/below zero/),
    ]);
  });

  it('reads variables', () => {
    const r = resolveForceLaw(dynamic({ kind: 'constant' }, '#pull'), (n) =>
      n === 'pull'
        ? { value: 100 * 1000 * 3600, dimension: { length: 1, angle: 0, mass: 1, time: -2 } }
        : undefined,
    );
    expect(r.ok && r.law.force).toBeCloseTo(100, 6);
  });
});

describe('the curves the editor plots', () => {
  const modes: Record<string, Dynamic['mode']> = {
    constant: { kind: 'constant' },
    eccentric: { kind: 'eccentric', factor: x('1.3') },
    band: { kind: 'band', rate: x('200 N/m') },
    chains: { kind: 'chains', rate: x('300 N/m'), from: x('0.2 m') },
    isokinetic: { kind: 'isokinetic', speed: x('1 m/s') },
    damper: { kind: 'damper', coefficient: x('400 N*s/m') },
    rowing: { kind: 'rowing', coefficient: x('300 N*s^2/m^2') },
    isometric: { kind: 'isometric', duration: x('30 s') },
    table: {
      kind: 'table',
      by: 'position',
      points: [
        [0, 100],
        [0.6, 500],
      ],
    },
  };

  it('every mode has a law and curves whose points come from it', () => {
    expect(Object.keys(modes).sort()).toEqual([...RESISTANCE_MODES].sort());
    for (const mode of Object.values(modes)) {
      const l = law(mode, '500 N');
      const c = forceCurves(l, { stroke: 0.6, pullSpeed: 1.5, returnSpeed: 1 });
      expect(c.byPosition.pull.length).toBeGreaterThan(100);
      for (const [px, f] of c.byPosition.pull) expect(f).toBe(forceAt(l, px, c.pullSpeed));
      for (const [px, f] of c.byPosition.return) expect(f).toBe(forceAt(l, px, -c.returnSpeed));
      for (const [v, f] of c.bySpeed.points) expect(f).toBe(forceAt(l, c.bySpeed.at, v));
      expect(c.bySpeed.from).toBeLessThan(0);
      expect(c.bySpeed.to).toBeGreaterThan(0);
    }
  });

  it('samples both sides of a step and a kink', () => {
    const iso = forceCurves(law(modes.isokinetic!, '500 N'), { stroke: 0.6, pullSpeed: 1.5 });
    const near = iso.bySpeed.points.filter(([v]) => v > 0.99 && v <= 1);
    expect(near.map(([, f]) => f)).toEqual([0, 500]);
    // Felt at the limit while pulling faster than it.
    expect(iso.pullSpeed).toBe(1);
    expect(iso.byPosition.pull.every(([, f]) => f === 500)).toBe(true);
    const chains = forceCurves(law(modes.chains!, '500 N'), { stroke: 0.6 });
    expect(chains.byPosition.pull.some(([px]) => px === 0.2)).toBe(true);
  });
});
