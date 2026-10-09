// Sweeps over one mate's coordinate, and mates read at hand-made poses.

import { describe, expect, it } from 'vitest';
import { posedMate, solveAtCoordinate, sweepValues } from './sweep';
import { I, at, deg, fourBar, inst, input, mate, rz } from './test-helpers';

describe('solveAtCoordinate', () => {
  const drawer = input(
    [inst('cabinet', I, true), inst('drawer'), inst('handle')],
    [
      mate('slide', 'slider', ['cabinet', I], ['drawer', I], { limits: { min: 0, max: 400 } }),
      mate('fix', 'fastened', ['drawer', at([0, 0, 10])], ['handle', I]),
    ],
  );

  it("holds a slider's distance, the instances on it following", () => {
    const r = solveAtCoordinate(drawer, 'slide', 250);
    expect(r.reached).toBe(true);
    expect(r.coordinate).toBeCloseTo(250, 9);
    expect(r.report.poses.drawer!.translation[2]).toBeCloseTo(250, 9);
    // The handle fastened to the drawer goes with it.
    expect(r.report.poses.handle!.translation[2]).toBeCloseTo(260, 9);
    expect(r.report.poses.cabinet).toEqual(I);
  });

  it('holds a value past the limits too (the caller warns)', () => {
    const r = solveAtCoordinate(drawer, 'slide', -50);
    expect(r.reached).toBe(true);
    expect(r.report.poses.drawer!.translation[2]).toBeCloseTo(-50, 9);
  });

  it("holds a revolute's angle on any turn", () => {
    const door = input(
      [inst('frame', I, true), inst('door')],
      [mate('hinge', 'revolute', ['frame', I], ['door', I], { limits: { min: 0, max: deg(270) } })],
    );
    const r = solveAtCoordinate(door, 'hinge', deg(200));
    expect(r.reached).toBe(true);
    expect(r.coordinate).toBeCloseTo(deg(200), 9);
    const q = r.report.poses.door!.rotation;
    const want = rz(deg(200));
    expect(Math.abs(q.reduce((s, v, i) => s + v * want[i]!, 0))).toBeCloseTo(1, 9);
  });

  it('does not reach a value inside a loop, where limits do not hold', () => {
    const fb = fourBar(deg(60));
    const r = solveAtCoordinate(input(fb.instances, fb.mates), 'm1', deg(80));
    expect(r.reached).toBe(false);
    expect(r.coordinate).toBeCloseTo(deg(60), 6);
  });

  it('refuses a mate that is missing or not a slider or revolute', () => {
    expect(() => solveAtCoordinate(drawer, 'nope', 0)).toThrow(/no mate nope/);
    expect(() => solveAtCoordinate(drawer, 'fix', 0)).toThrow(/fastened/);
  });
});

describe('posedMate', () => {
  const slide = mate('slide', 'slider', ['cabinet', I], ['drawer', I], {
    limits: { min: 0, max: 400 },
  });

  it("reads a slider's distance from poses that keep it", () => {
    const p = posedMate(slide, I, at([0, 0, 120]));
    expect(p.coordinates[0]).toBeCloseTo(120, 9);
    expect(p.residual.position).toBeCloseTo(0, 9);
    expect(p.residual.angle).toBeCloseTo(0, 9);
    expect(p.outsideLimits).toBeNull();
  });

  it('names the limit a pose passes', () => {
    expect(posedMate(slide, I, at([0, 0, -100])).outsideLimits).toEqual({
      bound: 'min',
      limit: 0,
      value: -100,
    });
    expect(posedMate(slide, I, at([0, 0, 500])).outsideLimits).toMatchObject({ bound: 'max' });
  });

  it('measures how far poses are off the mate', () => {
    const p = posedMate(slide, I, at([3, 4, 50], rz(deg(10))));
    expect(p.coordinates[0]).toBeCloseTo(50, 9);
    expect(p.residual.position).toBeCloseTo(5, 9);
    expect(p.residual.angle).toBeCloseTo(deg(10), 9);
  });

  it('applies the offset and frames', () => {
    const m = mate('slide', 'slider', ['a', at([10, 0, 0])], ['b', at([0, 0, 5])], {
      offset: at([0, 0, 2]),
    });
    // b's connector at world (10, 0, 27): 27 - 2 along a's z.
    const p = posedMate(m, I, at([10, 0, 22]));
    expect(p.coordinates[0]).toBeCloseTo(25, 9);
    expect(p.residual.position).toBeCloseTo(0, 9);
  });

  it("takes a revolute's angle at the turn nearest its limits", () => {
    const hinge = mate('hinge', 'revolute', ['a', I], ['b', I], {
      limits: { min: 0, max: deg(270) },
    });
    const p = posedMate(hinge, I, at([0, 0, 0], rz(deg(200))));
    expect(p.coordinates[0]).toBeCloseTo(deg(200), 9);
    expect(p.outsideLimits).toBeNull();
    // -30 degrees is 30 short of the minimum, and 330 is 60 past the maximum.
    const past = posedMate(hinge, I, at([0, 0, 0], rz(deg(-30)))).outsideLimits;
    expect(past).toMatchObject({ bound: 'min', limit: 0 });
    expect(past!.value).toBeCloseTo(deg(-30), 9);
  });
});

describe('sweepValues', () => {
  it('runs from one end to the other, both included, either way round', () => {
    expect(sweepValues(0, 10, 2.5)).toEqual([0, 2.5, 5, 7.5, 10]);
    expect(sweepValues(10, 0, 4)).toEqual([10, 6, 2, 0]);
    expect(sweepValues(3, 3, 1)).toEqual([3]);
  });

  it('adds no sliver of a step from rounding', () => {
    expect(sweepValues(0, 18, 0.9)).toHaveLength(21);
  });

  it('refuses too many values and a step that is not positive', () => {
    expect(sweepValues(0, 100, 1)).toHaveLength(101);
    expect(sweepValues(0, 100, 0.99)).toBeNull();
    expect(sweepValues(0, 1, 0)).toBeNull();
    expect(sweepValues(0, 1, -1)).toBeNull();
    expect(sweepValues(0, 1, Number.NaN)).toBeNull();
  });
});
