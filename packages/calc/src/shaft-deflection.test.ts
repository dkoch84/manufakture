import { describe, expect, it } from 'vitest';
import { derivedValue } from './record';
import {
  pointLoadDeflectionAt,
  pointLoadMoment,
  shaftBearingSlope,
  shaftPointLoadDeflection,
} from './shaft-deflection';
import { GPA, MM, within } from './test-units';

describe('shaft on two bearings with a point load', () => {
  // 3 kN at 100 mm from the left bearing of a 300 mm span, steel (207 GPa). The manual sizes the
  // shaft for a left-bearing slope of 0.001 rad with a design factor of 1.28: d = 38.1 mm, and at
  // that diameter the largest deflection is 0.0678 mm, at x = 136.7 mm.
  const p = { F: 3000, a: 100 * MM, L: 300 * MM, E: 207 * GPA, d: 38.1 * MM };

  it('Shigley 10th ed. Problem 4-46 (solutions manual): d 38.1 mm gives a left-bearing slope of 0.001 / 1.28 rad', () => {
    const r = shaftBearingSlope(p, 'A');
    expect(within(r.result, 0.001 / 1.28, 0.005)).toBe(true);
    // The right bearing, by beam 6 seen from the back: F a (L² - a²) / (6 E I L).
    const I = (Math.PI * 0.0381 ** 4) / 64;
    const thetaB = (3000 * 0.1 * (0.09 - 0.01)) / (6 * 207e9 * I * 0.3);
    expect(derivedValue(r, 'θ_B')).toBeCloseTo(thetaB, 12);
    expect(shaftBearingSlope(p, 'B').result).toBeCloseTo(thetaB, 12);
  });

  it('Shigley 10th ed. Problem 4-46 (solutions manual): largest deflection 0.0678 mm at x = 136.7 mm', () => {
    const r = shaftPointLoadDeflection(p);
    expect(within(r.result, 0.0678 * MM, 0.003)).toBe(true);
    expect(within(derivedValue(r, 'x_max'), 136.7 * MM, 0.002)).toBe(true);
  });

  it('closed-form check, not a textbook example: the moment along the span and its peak under the load', () => {
    expect(pointLoadMoment(3000, 0.1, 0.3, 0.1)).toBeCloseTo((3000 * 0.1 * 0.2) / 0.3, 9);
    expect(pointLoadMoment(3000, 0.1, 0.3, 0.05)).toBeCloseTo(100, 9);
    expect(pointLoadMoment(3000, 0.1, 0.3, 0.25)).toBeCloseTo(50, 9);
    expect(pointLoadMoment(3000, 0.1, 0.3, 0.31)).toBe(0);
    // Overhung 50 mm beyond bearing B: F c at B, falling to zero at the load.
    expect(pointLoadMoment(1000, 0.35, 0.3, 0.3)).toBeCloseTo(50, 9);
    expect(pointLoadMoment(1000, 0.35, 0.3, 0.15)).toBeCloseTo(25, 9);
    expect(pointLoadMoment(1000, 0.35, 0.3, 0.325)).toBeCloseTo(25, 9);
  });

  it('closed-form check, not a textbook example: a centre load gives F L³ / 48 E I and slopes F L² / 16 E I', () => {
    const I = (Math.PI * 0.02 ** 4) / 64;
    const EI = 200e9 * I;
    const c = { F: 500, a: 0.2, L: 0.4, E: 200e9, d: 0.02 };
    expect(shaftPointLoadDeflection(c).result).toBeCloseTo((500 * 0.4 ** 3) / (48 * EI), 12);
    expect(shaftBearingSlope(c, 'A').result).toBeCloseTo((500 * 0.16) / (16 * EI), 12);
    expect(pointLoadDeflectionAt(500, 0.2, 0.4, EI, 0.2)).toBeCloseTo(
      (500 * 0.064) / (48 * EI),
      12,
    );
  });

  it('closed-form check, not a textbook example: an overhung load (Table A-9 beam 10)', () => {
    const I = (Math.PI * 0.02 ** 4) / 64;
    const EI = 200e9 * I;
    const o = { F: 500, a: 0.5, L: 0.4, E: 200e9, d: 0.02 };
    // Tip: F c² (L + c) / 3EI with c = 0.1 m; slopes F c L / 6EI and F c L / 3EI.
    const tip = (500 * 0.01 * 0.5) / (3 * EI);
    const r = shaftPointLoadDeflection(o);
    expect(r.result).toBeCloseTo(tip, 12);
    expect(derivedValue(r, 'y_F')).toBeCloseTo(tip, 12);
    expect(shaftBearingSlope(o, 'A').result).toBeCloseTo((500 * 0.1 * 0.4) / (6 * EI), 12);
    expect(shaftBearingSlope(o, 'B').result).toBeCloseTo((500 * 0.1 * 0.4) / (3 * EI), 12);
    // A short overhang bows the span more than the tip moves: F c L² / (9√3 E I) at L/√3.
    const short = shaftPointLoadDeflection({ ...o, a: 0.42 });
    expect(short.result).toBeCloseTo((500 * 0.02 * 0.16) / (9 * Math.sqrt(3) * EI), 12);
  });

  it('states the slope against an allowed slope, and is unknown without the span', () => {
    const r = shaftBearingSlope({ ...p, maxSlope: 0.0005 }, 'A');
    expect(r.status).toBe('warning');
    expect(r.limitKind).toBe('at-most');
    const none = shaftPointLoadDeflection({ ...p, L: undefined });
    expect(none.status).toBe('unknown');
    expect(none.missing).toEqual(['Span between the bearings']);
  });
});
