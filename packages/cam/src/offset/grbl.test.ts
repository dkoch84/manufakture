import { describe, expect, it } from 'vitest';
import type { ArcSegment2, Vec2 } from '../types';
import { grblArcPrecheck } from './grbl';
import { demoteSegments } from './refit';

const arc = (start: Vec2, end: Vec2, center: Vec2, ccw: boolean, fullCircle = false) =>
  ({ kind: 'arc', start, end, center, ccw, ...(fullCircle ? { fullCircle } : {}) }) as ArcSegment2;

describe("Grbl's arc checks", () => {
  it('passes a well-formed arc in both directions', () => {
    const a = arc([10, 0], [0, 10], [0, 0], true);
    const c = grblArcPrecheck(a);
    expect(c.ok).toBe(true);
    expect(c.radiusDiff).toBeLessThan(1e-9);
    expect(c.travel).toBeCloseTo(Math.PI / 2, 6);
    const b = grblArcPrecheck(arc([0, 10], [10, 0], [0, 0], false));
    expect(b.ok).toBe(true);
    expect(b.travel).toBeCloseTo(-Math.PI / 2, 6);
  });

  it('applies the radius rule of error 33: 0.005 mm or 0.1%, never over 0.5 mm', () => {
    // r = 1: 0.006 mm is over both 0.005 mm and 0.1% (0.001 mm).
    expect(grblArcPrecheck(arc([1, 0], [0, 1.006], [0, 0], true)).radiusOk).toBe(false);
    expect(grblArcPrecheck(arc([1, 0], [0, 1.004], [0, 0], true)).radiusOk).toBe(true);
    // r = 10: 0.006 mm is under 0.1% (0.01 mm), so Grbl accepts it.
    expect(grblArcPrecheck(arc([10, 0], [0, 10.006], [0, 0], true)).radiusOk).toBe(true);
    // r = 1000: 0.6 mm is under 0.1% (1 mm) but over the 0.5 mm hard limit.
    expect(grblArcPrecheck(arc([1000, 0], [0, 1000.6], [0, 0], true)).radiusOk).toBe(false);
  });

  it('checks the arc as written, rounded to the decimals', () => {
    // 0.0004 mm apart in radius: fine at 4 decimals and at 3.
    const a = arc([10.0004, 0], [0, 10], [0, 0], true);
    expect(grblArcPrecheck(a, 3).ok).toBe(true);
    expect(grblArcPrecheck(a, 4).radiusDiff).toBeCloseTo(0.0004, 6);
  });

  it('catches a tiny arc that Grbl would cut as a full circle', () => {
    // The spike's arc: `G2 X36.494 Y-6.533 I-2.832 J-0.991`, start equal to end once written.
    const start: Vec2 = [36.49431, -6.53311];
    const center: Vec2 = [start[0] - 2.832, start[1] - 0.991];
    const r = Math.hypot(2.832, 0.991);
    const a0 = Math.atan2(start[1] - center[1], start[0] - center[0]);
    const end: Vec2 = [
      center[0] + r * Math.cos(a0 - 1.1e-5),
      center[1] + r * Math.sin(a0 - 1.1e-5),
    ];
    const c = grblArcPrecheck(arc(start, end, center, false));
    expect(c.radiusOk).toBe(true);
    expect(c.travelOk).toBe(false);
    expect(c.travel).toBeCloseTo(-2 * Math.PI, 3);
  });

  it('passes an intended full circle', () => {
    const c = grblArcPrecheck(arc([5, 0], [5, 0], [0, 0], true, true));
    expect(c.ok).toBe(true);
    expect(c.travel).toBeCloseTo(2 * Math.PI, 6);
  });
});

describe("the refit's last step", () => {
  it('splits an arc swept past half a turn on its circle instead of drawing its chord', () => {
    // Three quarters of a turn, counter-clockwise, r = 10.
    const wide = arc([10, 0], [0, -10], [0, 0], true);
    const out = demoteSegments([wide]);
    expect(out).toHaveLength(2);
    expect(out[0]!.start).toEqual(wide.start);
    expect(out[1]!.end).toEqual(wide.end);
    expect(out[1]!.start).toEqual(out[0]!.end);
    for (const s of out) {
      expect(s.kind).toBe('arc');
      if (s.kind !== 'arc') continue;
      expect(s.center).toEqual([0, 0]);
      expect(Math.hypot(...s.end)).toBeCloseTo(10, 12);
      expect(grblArcPrecheck(s).sweep).toBeCloseTo((3 * Math.PI) / 4, 9);
    }
  });

  it('turns tiny and flat arcs into lines and keeps good ones', () => {
    const good = arc([10, 0], [0, 10], [0, 0], true);
    // A sweep of 1e-4 rad at r = 10: sagitta 1.25e-8 mm.
    const flat = arc([10, 0], [10 * Math.cos(1e-4), 10 * Math.sin(1e-4)], [0, 0], true);
    const out = demoteSegments([good, flat]);
    expect(out[0]).toEqual(good);
    expect(out[1]).toEqual({ kind: 'line', start: flat.start, end: flat.end });
  });
});
