import { describe, expect, it } from 'vitest';
import type { Loop2 } from '../types';
import { reverseLoop } from '../wcs';
import { loopArea, loopLength } from './geometry';
import { kerfLoops } from './kerf';
import { circle, rect, roundedRect } from './test-shapes';

function value<T>(r: { ok: true; value: T } | { ok: false; error: { message: string } }): T {
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

/** Area of a set of loops, holes (clockwise) counted negative. */
const area = (loops: readonly Loop2[]) => loops.reduce((a, l) => a + loopArea(l), 0);

// An outline offset by d (with round joins) changes in area by exactly P d + pi d^2 when it stays
// simple (Steiner's formula: the joins add up to one full turn); a hole loses P d - pi d^2. The
// refit keeps every loop within 0.002 mm, so the area within that times the perimeter.
const TOL = 0.002;

describe('kerfLoops', () => {
  it('leaves loops alone for a zero kerf', () => {
    const loops = [rect(0, 0, 50, 30), reverseLoop(circle([25, 15], 5))];
    const r = value(kerfLoops(loops, 0));
    expect(r.loops).toEqual(loops);
    expect(r.lost).toBe(0);
  });

  it('refuses a negative or non-finite kerf', () => {
    for (const k of [-0.1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const r = kerfLoops([rect(0, 0, 10, 10)], k);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('invalid-input');
    }
  });

  it('grows an outer loop by about its perimeter times half the kerf', () => {
    const outer = rect(0, 0, 50, 30);
    const kerf = 0.2;
    const d = kerf / 2;
    const r = value(kerfLoops([outer], kerf));
    expect(r.loops).toHaveLength(1);
    const p = loopLength(outer);
    expect(area(r.loops) - loopArea(outer)).toBeCloseTo(p * d + Math.PI * d * d, 2);
    expect(Math.abs(area(r.loops) - loopArea(outer) - p * d - Math.PI * d * d)).toBeLessThan(
      TOL * (p + 1),
    );
  });

  it('keeps arcs as arcs: a rounded rectangle grows by P d + pi d^2', () => {
    const outer = roundedRect(80, 40, 6);
    const d = 0.75; // a plasma kerf of 1.5 mm
    const r = value(kerfLoops([outer], 2 * d));
    const p = loopLength(outer);
    expect(Math.abs(area(r.loops) - loopArea(outer) - p * d - Math.PI * d * d)).toBeLessThan(
      TOL * (p + 1),
    );
    expect(r.loops[0]!.segments.filter((s) => s.kind === 'arc')).toHaveLength(4);
  });

  it('shrinks a hole and grows the outline of a plate', () => {
    const outer = rect(0, 0, 60, 40);
    const hole = reverseLoop(circle([30, 20], 8));
    const kerf = 0.3;
    const d = kerf / 2;
    const r = value(kerfLoops([outer, hole], kerf));
    expect(r.loops).toHaveLength(2);
    expect(r.lost).toBe(0);
    const [o, h] = r.loops as [Loop2, Loop2];
    expect(loopArea(o)).toBeGreaterThan(loopArea(outer));
    // The hole is clockwise (negative area) and smaller.
    expect(loopArea(h)).toBeLessThan(0);
    expect(-loopArea(h)).toBeLessThan(-loopArea(hole));
    // A circle of radius 8 becomes one of radius 8 - d.
    expect(-loopArea(h)).toBeCloseTo(Math.PI * (8 - d) ** 2, 2);
    const p = loopLength(outer) + loopLength(hole);
    const expected = loopArea(outer) + loopArea(hole) + loopLength(outer) * d + Math.PI * d * d;
    // The hole's change: its perimeter times d, less pi d^2 (it shrinks).
    const holeChange = loopLength(hole) * d - Math.PI * d * d;
    expect(Math.abs(area(r.loops) - (expected + holeChange))).toBeLessThan(TOL * p);
  });

  it('shrinks a hole on its own, and keeps loops of other sources apart', () => {
    const h = reverseLoop(circle([0, 0], 3));
    const r = value(kerfLoops([h], 1));
    expect(r.loops).toHaveLength(1);
    expect(loopArea(r.loops[0]!)).toBeCloseTo(-Math.PI * 2.5 * 2.5, 2);
    // Two outlines 0.1 mm apart stay two loops with a 0.4 mm kerf.
    const two = value(kerfLoops([rect(0, 0, 10, 10), rect(10.1, 0, 10, 10)], 0.4));
    expect(two.loops).toHaveLength(2);
    expect(two.lost).toBe(0);
  });

  it('reports a hole that closes up', () => {
    const outer = rect(0, 0, 20, 20);
    const pin = reverseLoop(circle([10, 10], 0.1));
    const r = value(kerfLoops([outer, pin], 0.4));
    expect(r.loops).toHaveLength(1);
    expect(r.lost).toBe(1);
  });
});
