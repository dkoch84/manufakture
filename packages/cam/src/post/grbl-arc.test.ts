import { describe, expect, it } from 'vitest';
import { GRBL_CHECK_OFFSETS, grblArcCheck, grblRadiusAllowance } from './grbl-arc';
import type { GrblArcInput } from './grbl-arc';

function arc(over: Partial<GrblArcInput>): GrblArcInput {
  return {
    start: ['30', '40'],
    end: ['30', '20'],
    ij: ['0', '-10'],
    inches: false,
    direction: 'ccw',
    sweep: Math.PI,
    ...over,
  };
}

describe('grblRadiusAllowance', () => {
  it('is 0.005 mm, or 0.1% of the radius, at most 0.5 mm', () => {
    expect(grblRadiusAllowance(1)).toBe(0.005);
    expect(grblRadiusAllowance(10)).toBe(0.01);
    expect(grblRadiusAllowance(2000)).toBe(0.5);
  });
});

describe('grblArcCheck', () => {
  it('accepts a clean half circle at every offset', () => {
    const c = grblArcCheck(arc({}));
    expect(c.ok).toBe(true);
    expect(c.deltaR).toBeLessThan(1e-4);
    expect(Math.abs(c.travel - Math.PI)).toBeLessThan(1e-5);
    expect(GRBL_CHECK_OFFSETS.length).toBeGreaterThan(3);
  });

  it('gives clockwise travel a negative sign', () => {
    const c = grblArcCheck(arc({ direction: 'cw' }));
    expect(c.ok).toBe(true);
    expect(c.travel).toBeCloseTo(-Math.PI, 5);
  });

  it('fails the radius rule (error 33) when the end is off the circle', () => {
    // End radius 10.02 against start radius 10: 0.02 mm, over 0.01 (0.1% of 10).
    const c = grblArcCheck(arc({ end: ['30', '19.98'] }));
    expect(c.radiusOk).toBe(false);
    expect(c.ok).toBe(false);
    expect(c.deltaR).toBeCloseTo(0.02, 4);
  });

  it('keeps a margin under the rule in exact arithmetic', () => {
    // 0.0045 mm off at radius 2: under Grbl's 0.005 but over the 0.004 margin.
    const c = grblArcCheck(arc({ start: ['0', '2'], end: ['0', '-2.0045'], ij: ['0', '-2'] }));
    expect(c.exactDeltaR).toBeCloseTo(0.0045, 6);
    expect(c.deltaR).toBeLessThan(0.005);
    expect(c.radiusOk).toBe(false);
  });

  it("catches T5.0a's tiny arc that Grbl cuts as a full circle", () => {
    // Start equal to end once written: mc_arc adds a full turn to a 1.1e-5 rad sweep.
    const c = grblArcCheck({
      start: ['36.494', '-6.533'],
      end: ['36.494', '-6.533'],
      ij: ['-2.832', '-0.991'],
      inches: false,
      direction: 'cw',
      sweep: 1.1e-5,
    });
    expect(c.radiusOk).toBe(true);
    expect(c.travelOk).toBe(false);
    expect(c.travel).toBeCloseTo(-2 * Math.PI, 3);
  });

  it('accepts an intended full circle written with equal start and end', () => {
    const c = grblArcCheck(
      arc({ start: ['50', '20'], end: ['50', '20'], ij: ['-2', '0'], sweep: 2 * Math.PI }),
    );
    expect(c.ok).toBe(true);
    expect(c.travel).toBeCloseTo(2 * Math.PI, 5);
  });

  it('converts inches to millimetres before the rule', () => {
    // 0.0002 in = 0.00508 mm off at radius 0.1 in (2.54 mm): Grbl refuses it.
    const off = grblArcCheck(
      arc({ start: ['0', '0.1'], end: ['0', '-0.1002'], ij: ['0', '-0.1'], inches: true }),
    );
    expect(off.radiusOk).toBe(false);
    const fine = grblArcCheck(
      arc({ start: ['0', '0.1'], end: ['0', '-0.1'], ij: ['0', '-0.1'], inches: true }),
    );
    expect(fine.ok).toBe(true);
  });

  it('runs at every work offset given', () => {
    const small = arc({ start: ['0', '0.05'], end: ['0', '-0.05'], ij: ['0', '-0.05'] });
    const one = grblArcCheck(small, [[0, 0]]);
    const far = grblArcCheck(small, [[-999999.7, -999999.7]]);
    // A million mm away, single precision steps are 0.06 mm: a 0.05 mm arc fails there.
    expect(one.ok).toBe(true);
    expect(far.ok).toBe(false);
  });
});
