// The JS rank analysis on small hand-made systems, independent of planegcs.

import { describe, expect, it } from 'vitest';
import { analyzeRank } from './analysis';
import type { Equation } from './equations';
import { equationsOf } from './equations';

// Parameters: 0, 1 fixed; 2..5 unknown (two points: p = (2, 3), q = (4, 5)).
const params = () => Float64Array.from([0, 0, 1, 2, 4, 6]);
const eq = (params: number[], f: (p: Float64Array) => number): Equation => ({ params, f });

describe('analyzeRank', () => {
  it('with no equations everything unknown is free', () => {
    const r = analyzeRank(params(), 2, []);
    expect(r).toMatchObject({ unknowns: 4, rank: 0, dof: 4 });
    expect(Array.from(r.determined)).toEqual([1, 1, 0, 0, 0, 0]);
  });

  it('fixing a point determines exactly its coordinates', () => {
    const r = analyzeRank(params(), 2, [eq([2], (p) => p[2]! - 1), eq([3], (p) => p[3]! - 2)]);
    expect(r).toMatchObject({ rank: 2, dof: 2 });
    expect(Array.from(r.determined)).toEqual([1, 1, 1, 1, 0, 0]);
  });

  it('a distance between two free points determines neither', () => {
    const r = analyzeRank(params(), 2, [
      eq([2, 3, 4, 5], (p) => Math.hypot(p[4]! - p[2]!, p[5]! - p[3]!) - 5),
    ]);
    expect(r).toMatchObject({ rank: 1, dof: 3 });
    expect(Array.from(r.determined.slice(2))).toEqual([0, 0, 0, 0]);
  });

  it('a fixed point plus a coincidence determines both points', () => {
    const r = analyzeRank(params(), 2, [
      ...equationsOf({ op: 'coordinate_x', p: [2, 3], value: 1 }),
      ...equationsOf({ op: 'coordinate_y', p: [2, 3], value: 2 }),
      ...equationsOf({ op: 'p2p_coincident', p1: [2, 3], p2: [4, 5] }),
    ]);
    expect(r).toMatchObject({ rank: 4, dof: 0 });
    expect(Array.from(r.determined)).toEqual([1, 1, 1, 1, 1, 1]);
  });

  it('dependent equations count once (rank, not row count)', () => {
    const r = analyzeRank(params(), 2, [
      eq([2, 4], (p) => p[2]! - p[4]!),
      eq([2, 4], (p) => 2 * (p[2]! - p[4]!)),
      eq([2, 4], (p) => p[4]! - p[2]!),
    ]);
    expect(r).toMatchObject({ rank: 1, dof: 3 });
  });

  it('a determined combination does not determine its parts', () => {
    // x_p + x_q fixed: neither x is determined on its own.
    const r = analyzeRank(params(), 2, [eq([2, 4], (p) => p[2]! + p[4]! - 5)]);
    expect(Array.from(r.determined.slice(2))).toEqual([0, 0, 0, 0]);
  });

  it('skips equations that do not depend on any unknown, and independent components', () => {
    const r = analyzeRank(params(), 2, [
      eq([0, 1], (p) => p[0]! - p[1]!),
      eq([3], (p) => p[3]! - 2),
      eq([5], (p) => p[5]! - 6),
    ]);
    expect(r).toMatchObject({ rank: 2, dof: 2 });
    expect(Array.from(r.determined.slice(2))).toEqual([0, 1, 0, 1]);
  });

  it('a point-to-line distance or a line tangency still counts at a distance of 0', () => {
    // Line (2, 3)-(4, 5) along the x axis; point (6, 7) on it.
    const p = Float64Array.from([0, 0, 0, 0, 10, 0, 5, 0, 2]);
    const l = { kind: 'line', p1: [2, 3], p2: [4, 5] } as const;
    const distance = analyzeRank(
      p,
      2,
      equationsOf({ op: 'p2l_distance', p: [6, 7], l, value: 1 }, p),
    );
    expect(distance.rank).toBe(1);
    const c = { kind: 'circle', c: [6, 7], r: 8 } as const;
    const tangent = analyzeRank(p, 2, equationsOf({ op: 'tangent_lc', l, c }, p));
    expect(tangent.rank).toBe(1);
  });

  it('signed branches: the residual is zero on whichever side the geometry is', () => {
    const p = Float64Array.from([0, 0, 0, 0, 10, 0, 5, -2]);
    const l = { kind: 'line', p1: [2, 3], p2: [4, 5] } as const;
    const [eq] = equationsOf({ op: 'p2l_distance', p: [6, 7], l, value: 2 }, p);
    expect(eq!.f(p)).toBeCloseTo(0, 12);
  });

  it('is scale-independent: a sketch in metres or micrometres analyses the same', () => {
    for (const s of [1e-3, 1, 1e4]) {
      const p = Float64Array.from([0, 0, 1 * s, 2 * s, 4 * s, 6 * s]);
      const r = analyzeRank(p, 2, [
        ...equationsOf({ op: 'horizontal_pp', p1: [2, 3], p2: [4, 5] }),
        ...equationsOf({
          op: 'p2p_distance',
          p1: [2, 3],
          p2: [4, 5],
          value: Math.hypot(3 * s, 4 * s),
        }),
      ]);
      expect(r.dof, `scale ${s}`).toBe(2);
    }
  });
});
