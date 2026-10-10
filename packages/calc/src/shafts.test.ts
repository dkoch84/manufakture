import { describe, expect, it } from 'vitest';
import { derivedValue } from './record';
import {
  dunkerleyCriticalSpeed,
  rayleighCriticalSpeed,
  shaftFatigueFactor,
  shaftStress,
  shaftTwist,
  uniformShaftCriticalSpeed,
  type FatigueCriterion,
} from './shafts';
import { GPA, MM, MPA, within } from './test-units';

describe('shaft fatigue', () => {
  // Ma = 70, Ta = 45, Mm = 55, Tm = 35 N·m; Kf = 2.2, Kfs = 1.8; Se = 210, Sut = 700, Sy = 560 MPa;
  // design factor 2. The manual solves for the diameter; at that diameter the factor is 2.
  const loads = {
    Ma: 70,
    Ta: 45,
    Mm: 55,
    Tm: 35,
    Kf: 2.2,
    Kfs: 1.8,
    Se: 210 * MPA,
    Sut: 700 * MPA,
    Sy: 560 * MPA,
  };
  const cases: [FatigueCriterion, number][] = [
    ['gerber', 25.85],
    ['asme-elliptic', 25.77],
    ['soderberg', 27.7],
    ['goodman', 27.27],
  ];
  for (const [criterion, dmm] of cases) {
    it(`Shigley 10th ed. Problem 7-1 (solutions manual): ${criterion}, d = ${dmm} mm gives n = 2`, () => {
      const r = shaftFatigueFactor({ ...loads, d: dmm * MM, requiredFactor: 2 }, criterion);
      expect(within(r.result, 2, 0.005)).toBe(true);
      expect(Math.abs(r.margin as number)).toBeLessThan(0.005);
    });
  }

  it('is a warning below the required factor and unknown without the strength it needs', () => {
    const r = shaftFatigueFactor({ ...loads, d: 25 * MM, requiredFactor: 2.5 }, 'goodman');
    expect(r.status).toBe('warning');
    const noSy: Partial<typeof loads> = { ...loads };
    delete noSy.Sy;
    const s = shaftFatigueFactor(
      { ...noSy, Ma: 70, Tm: 35, Se: 210 * MPA, d: 25 * MM },
      'soderberg',
    );
    expect(s.status).toBe('unknown');
    expect(s.missing).toEqual(['Yield strength']);
  });
});

describe('shaft stress and twist', () => {
  it('closed-form check, not a textbook example: von Mises of bending and torsion', () => {
    const r = shaftStress({ M: 100, T: 50, d: 0.02 });
    const sigma = (32 * 100) / (Math.PI * 0.02 ** 3);
    const tau = (16 * 50) / (Math.PI * 0.02 ** 3);
    expect(derivedValue(r, 'σ')).toBeCloseTo(sigma, 3);
    expect(derivedValue(r, 'τ')).toBeCloseTo(tau, 3);
    expect(r.result).toBeCloseTo(Math.sqrt(sigma ** 2 + 3 * tau ** 2), 3);
  });

  it('closed-form check, not a textbook example: twist T L / G J of a hollow shaft', () => {
    const r = shaftTwist({ T: 20, L: 0.5, d: 0.02, di: 0.01, G: 79 * GPA });
    const J = (Math.PI * (0.02 ** 4 - 0.01 ** 4)) / 32;
    expect(r.result).toBeCloseTo((20 * 0.5) / (79e9 * J), 12);
  });
});

describe('critical speed', () => {
  it('Shigley 10th ed. Problem 7-28 (solutions manual): uniform 25 mm steel shaft, 0.6 m span, 883 rad/s', () => {
    const r = uniformShaftCriticalSpeed({
      L: 0.6,
      d: 25 * MM,
      E: 207 * GPA,
      density: 76.5e3 / 9.81,
    });
    expect(within(r.result, 883, 0.003)).toBe(true);
  });

  it('Shigley 10th ed. Problem 7-29 (solutions manual): Rayleigh with two and three lumped elements', () => {
    const g = 9.81;
    const two = rayleighCriticalSpeed([
      { mass: 11.265 / g, deflection: 1.277e-5 },
      { mass: 11.265 / g, deflection: 1.277e-5 },
    ]);
    expect(within(two.result, 876, 0.003)).toBe(true);
    const three = rayleighCriticalSpeed([
      { mass: 7.51 / g, deflection: 8.516e-6 },
      { mass: 7.51 / g, deflection: 1.672e-5 },
      { mass: 7.51 / g, deflection: 8.516e-6 },
    ]);
    expect(within(three.result, 883, 0.003)).toBe(true);
  });

  it('closed-form check, not a textbook example: Dunkerley on the Problem 7-29 two-element data is below Rayleigh', () => {
    const m = 11.265 / 9.81;
    const a = 6.379e-7;
    const r = dunkerleyCriticalSpeed([
      { mass: m, influence: a },
      { mass: m, influence: a },
    ]);
    expect(r.result).toBeCloseTo(1 / Math.sqrt(2 * m * a), 6);
    expect(r.result as number).toBeLessThan(876);
    const missing = rayleighCriticalSpeed([{ mass: 1 }]);
    expect(missing.missing).toEqual(['Static deflection at station 1']);
  });
});
