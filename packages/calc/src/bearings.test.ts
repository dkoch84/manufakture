import { describe, expect, it } from 'vitest';
import {
  bearingRatingLife,
  bearingStaticFactor,
  deepGrooveEquivalentLoad,
  equivalentDynamicLoad,
  isoLifeModificationFactor,
  reliabilityLifeFactor,
} from './bearings';
import { derivedValue } from './record';
import { KN, RPM, within } from './test-units';

describe('bearing loads', () => {
  it('Shigley 10th ed. Problem 11-21 (solutions manual): Fr 5 kN, Fa 2 kN, C0 10 kN gives Fe 5.34 kN', () => {
    const r = deepGrooveEquivalentLoad({ Fr: 5 * KN, Fa: 2 * KN, C0: 10 * KN });
    expect(derivedValue(r, 'X')).toBe(0.56);
    expect(derivedValue(r, 'Y')).toBeCloseTo(1.27, 2);
    expect(within(r.result, 5.34 * KN, 0.002)).toBe(true);
  });

  it('Shigley 10th ed. Problem 11-20 (solutions manual): Fr 7 kN, Fa 3 kN, C0 34 kN, V 1.2 gives Fe 9.29 kN', () => {
    const r = deepGrooveEquivalentLoad({ Fr: 7 * KN, Fa: 3 * KN, C0: 34 * KN, V: 1.2 });
    expect(derivedValue(r, 'Y')).toBeCloseTo(1.53, 2);
    expect(within(r.result, 9.29 * KN, 0.002)).toBe(true);
  });

  it('closed-form check, not a textbook example: light axial load and the generic X, Y form', () => {
    const r = deepGrooveEquivalentLoad({ Fr: 5 * KN, Fa: 0.1 * KN, C0: 10 * KN });
    expect(derivedValue(r, 'X')).toBe(1);
    expect(r.result).toBe(5 * KN);
    expect(equivalentDynamicLoad({ Fr: 1000, Fa: 500, X: 0.56, Y: 1.5 }).result).toBeCloseTo(
      1310,
      9,
    );
  });
});

describe('bearing life', () => {
  it('Shigley 10th ed. Problem 11-3 (solutions manual): roller, C10 118 kN at 13.92 kN gives 1248 million revolutions', () => {
    const r = bearingRatingLife({ C: 118 * KN, P: 13.92 * KN }, 'roller');
    expect(within(r.result, 1248e6, 0.01)).toBe(true);
  });

  it('closed-form check, not a textbook example: ball life in time and against a required life', () => {
    const r = bearingRatingLife(
      { C: 16 * KN, P: 2 * KN, speed: 1725 * RPM, requiredRevolutions: 600e6 },
      'ball',
    );
    expect(r.result).toBeCloseTo(512e6, 0);
    expect(derivedValue(r, 't')! / 3600).toBeCloseTo(512e6 / 1725 / 60, 6);
    expect(r.status).toBe('warning');
    const modified = bearingRatingLife({ C: 16 * KN, P: 2 * KN, a1: 0.25, aISO: 2 }, 'ball');
    expect(modified.result).toBeCloseTo(256e6, 0);
  });

  it('ISO 281:2007 life modification factor for reliability: the a1 table from 90 % to 99.95 %', () => {
    const table: [number, number][] = [
      [0.9, 1],
      [0.95, 0.64],
      [0.96, 0.55],
      [0.97, 0.47],
      [0.98, 0.37],
      [0.99, 0.25],
      [0.999, 0.093],
      [0.9995, 0.077],
    ];
    for (const [R, a1] of table) {
      expect(
        Math.abs((reliabilityLifeFactor({ reliability: R }).result as number) - a1),
      ).toBeLessThan(0.006);
    }
    expect(reliabilityLifeFactor({ reliability: 0.8 }).status).toBe('unknown');
  });

  it('closed-form check, not a textbook example: aISO is continuous across its kappa ranges and capped', () => {
    for (const kind of ['ball', 'roller'] as const) {
      for (const k of [0.4, 1]) {
        const lo = isoLifeModificationFactor({ kappa: k - 1e-9, eCCuOverP: 0.1 }, kind)
          .result as number;
        const hi = isoLifeModificationFactor({ kappa: k, eCCuOverP: 0.1 }, kind).result as number;
        expect(within(hi, lo, 0.002)).toBe(true);
      }
      expect(isoLifeModificationFactor({ kappa: 1, eCCuOverP: 0 }, kind).result).toBeCloseTo(
        0.1,
        12,
      );
      expect(isoLifeModificationFactor({ kappa: 4, eCCuOverP: 5 }, kind).result).toBe(50);
    }
  });

  it('closed-form check, not a textbook example: static factor with the deep-groove X0, Y0', () => {
    const r = bearingStaticFactor({ C0: 10 * KN, Fr: 2 * KN, Fa: 3 * KN, requiredFactor: 2 });
    expect(derivedValue(r, 'P₀')).toBeCloseTo(2700, 9);
    expect(r.result).toBeCloseTo(10 / 2.7, 9);
    expect(r.status).toBe('ok');
  });
});
