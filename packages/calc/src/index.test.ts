import { describe, expect, it } from 'vitest';
import * as calc from './index';
import type { CalcRecord } from './record';

/** One record from every formula, some with a limit that is missed, some with a missing input. */
function sample(): CalcRecord[] {
  return [
    calc.strengthFactor({ stress: 2e8, strength: 4e8, requiredFactor: 3 }),
    calc.loadFactor({ load: 1000, rating: 4500, requiredFactor: 5 }),
    calc.cantileverPointLoad({ F: 10, L: 1, E: 2e11, I: 1e-8 }),
    calc.cantileverUniformLoad({ w: 10, L: 1, E: 2e11, I: 1e-8 }),
    calc.simplySupportedCentreLoad({ F: 10, L: 1, E: 2e11, I: undefined }),
    calc.simplySupportedUniformLoad({ w: 10, L: 1, E: 2e11, I: 1e-8, maxDeflection: 1e-9 }),
    calc.shaftStress({ M: 10, T: 10, d: 0.01 }),
    calc.shaftFatigueFactor(
      { Ma: 10, Tm: 10, d: 0.02, Se: 2e8, Sut: 6e8, requiredFactor: 9 },
      'gerber',
    ),
    calc.shaftTwist({ T: 1, L: 1, d: 0.01, G: 8e10 }),
    calc.uniformShaftCriticalSpeed({ L: 1, d: 0.02, E: 2e11, density: 7850 }),
    calc.rayleighCriticalSpeed([{ mass: 1, deflection: 1e-5 }]),
    calc.dunkerleyCriticalSpeed([{ mass: 1, influence: 1e-6 }]),
    calc.marinEnduranceLimit({ Sut: 6e8, d: 0.02 }, { surface: 'machined', loading: 'bending' }),
    calc.fatigueNotchFactor({ Kt: 2, r: 0.001, Sut: 6e8 }, 'bending'),
    calc.shoulderFilletKt({ D: 0.03, d: 0.025, r: 0.002 }, 'bending'),
    calc.grooveKt({ D: 0.03, d: 0.026, r: 0.001 }, 'axial'),
    calc.holeInPlateKt({ W: 0.05, d: 0.01 }),
    calc.keyseatKt({ D: 0.03, r: 0.0005 }, 'torsion'),
    calc.equivalentDynamicLoad({ Fr: 1, Fa: 1, X: 1, Y: 1 }),
    calc.deepGrooveEquivalentLoad({ Fr: 1000, Fa: 300, C0: 5000 }),
    calc.reliabilityLifeFactor({ reliability: 0.99 }),
    calc.isoLifeModificationFactor({ kappa: 1, eCCuOverP: 0.2 }, 'ball'),
    calc.bearingRatingLife({ C: 1e4, P: 1e3, requiredRevolutions: 1e10 }, 'ball'),
    calc.bearingStaticFactor({ C0: 1e4, Fr: 1e3 }),
    calc.tensileStressArea({ d: 0.01, P: 0.0015 }),
    calc.preloadFromTorque({ T: 50, d: 0.01, P: 0.0015, muG: 0.12, muK: 0.12, DKm: 0.013 }),
    calc.preloadFromTorqueNutFactor({ T: 50, d: 0.01 }),
    calc.boltStiffness({ Ad: 1e-4, At: 6e-5, ld: 0.01, lt: 0.01, E: 2e11 }),
    calc.frustumStiffness({ E: 2e11, d: 0.01, D: 0.015, t: 0.01 }),
    calc.memberStiffness({ E: 2e11, d: 0.01, l: 0.02 }),
    calc.seriesStiffness([1e9, 2e9]),
    calc.separationFactor({ Fi: 1e4, P: 1e4, kb: 1, km: 3, requiredFactor: 2 }),
    calc.slipFactor({ Fi: 1e4, Fq: 1e3, mu: 0.1 }),
    calc.boltProofFactor({ Sp: 6e8, At: 6e-5, Fi: 2e4, P: 5e3, kb: 1, km: 3 }),
    calc.boltOverloadFactor({ Sp: 6e8, At: 6e-5, Fi: 2e4, P: 5e3, kb: 1, km: 3 }),
    calc.threadStrippingFactor({
      d: 0.01,
      P: 0.0015,
      Le: 0.01,
      F: 1e4,
      tauExternal: 4e8,
      tauInternal: 1e8,
    }),
    calc.lewisFormFactor({ teeth: 20 }),
    calc.velocityFactor({ V: 2 }, 'hobbed'),
    calc.lewisBendingStress({ Wt: 100, F: 0.01, m: 0.001, Y: 0.3, Kv: 1.2 }),
    calc.elasticCoefficient({ E1: 2e11, nu1: 0.3, E2: 2e11, nu2: 0.3 }),
    calc.hertzContactStress({ Cp: 1.9e5, Kv: 1.2, Wt: 100, F: 0.01, d1: 0.02, d2: 0.04 }),
    calc.beltWrapAngle({ D: 0.1, d: 0.05, C: 0.3 }),
    calc.beltCentrifugalTension({ massPerLength: 0.1, V: 10 }),
    calc.flatBeltTensions({ dF: 100, theta: 3, f: 0.3 }),
    calc.synchronousBeltTensionFactor({ T: 1, dp: 0.03, allowable: 100 }),
    calc.synchronousBeltToothFactor({ T: 1, dp: 0.03, teeth: 20, theta: 3, toothRating: 20 }),
    calc.lameStresses({ ri: 0.01, ro: 0.02, pi: 1e7 }),
    calc.conductorResistance({ area: 1e-6 }),
    calc.wireAmpacityTable({ current: 50 }, { gauge: 12, rating: 90 }),
    calc.wireAmpacityHeatBalance({ d: 0.001, h: 10, Tmax: 360, Tambient: 300 }),
    calc.voltageDrop({ I: 10, resistancePerLength: 0.01, length: 2 }),
    calc.jouleHeating({ I: 10, R20: 0.1 }),
    calc.firstOrderTemperature({ P: 10, Rth: 1, Cth: 10, t: 5, Tambient: 300 }),
    calc.shaftPointLoadDeflection({
      F: 100,
      a: 0.05,
      L: 0.1,
      E: 2e11,
      d: 0.02,
      maxDeflection: 1e-9,
    }),
    calc.shaftBearingSlope({ F: 100, a: 0.15, L: 0.1, E: 2e11, d: 0.02 }, 'B'),
    calc.keyFactor({ T: 10, d: 0.02, w: 0.005, h: 0.005, l: 0.02, Sy: 3e8, requiredFactor: 2 }),
    calc.pressFitPressure({
      delta: 2e-5,
      d: 0.02,
      do: 0.04,
      Eo: 2e11,
      nuo: 0.3,
      Ei: 2e11,
      nui: 0.3,
    }),
    calc.pressFitSlipFactor({ T: 10, p: undefined, f: 0.15, l: 0.02, d: 0.02 }),
  ];
}

describe('@manufakture/calc', () => {
  it('exports its name', () => {
    expect(calc.packageName).toBe('@manufakture/calc');
  });

  it('gives every record a method, a formula, sources and one of the three statuses', () => {
    for (const r of sample()) {
      expect(r.id, r.id).toMatch(/^[a-z0-9.-]+$/);
      expect(r.method.length, r.id).toBeGreaterThan(0);
      expect(r.formula.length, r.id).toBeGreaterThan(0);
      expect(r.sources.length, r.id).toBeGreaterThan(0);
      expect(['ok', 'warning', 'unknown'], r.id).toContain(r.status);
      if (r.status === 'unknown') expect(r.result, r.id).toBeNull();
      else expect(Number.isFinite(r.result), r.id).toBe(true);
    }
  });

  it('never calls anything safe, passing, failing, certified or compliant', () => {
    const words = /\b(safe|safety|pass(es|ed|ing)?|fail(s|ed|ing|ure)?|certif\w*|complian\w*)\b/i;
    for (const r of sample()) {
      for (const text of [r.title, r.method, r.status, r.note ?? '', ...r.assumptions]) {
        expect(text, r.id).not.toMatch(words);
      }
    }
  });

  it('covers warnings and missing inputs in the sample', () => {
    const statuses = new Set(sample().map((r) => r.status));
    expect(statuses).toEqual(new Set(['ok', 'warning', 'unknown']));
  });
});
