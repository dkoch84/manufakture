import { describe, expect, it } from 'vitest';
import {
  boltOverloadFactor,
  boltProofFactor,
  boltStiffness,
  frustumStiffness,
  memberStiffness,
  preloadFromTorque,
  preloadFromTorqueNutFactor,
  separationFactor,
  seriesStiffness,
  slipFactor,
  tensileStressArea,
} from './bolts';
import { derivedValue, fromRecord } from './record';
import { FOOT, GPA, INCH, KPSI, LBF, MM, MPSI, within } from './test-units';

const MLBF_PER_IN = (1e6 * LBF) / INCH;
const MN_PER_M = 1e6;

describe('bolt geometry and stiffness', () => {
  it('Shigley 10th ed. Problems 8-11 and 8-22 (solutions manual): tensile stress areas from Table 8-1', () => {
    const rows: [number, number, number][] = [
      [10, 1.5, 58],
      [12, 1.75, 84.3],
      [14, 2, 115],
      [16, 2, 157],
      [20, 2.5, 245],
      [24, 3, 353],
      [30, 3.5, 561],
    ];
    for (const [d, P, At] of rows) {
      expect(within(tensileStressArea({ d: d * MM, P: P * MM }).result, At * MM * MM, 0.005)).toBe(
        true,
      );
    }
  });

  it('Shigley 10th ed. Problem 8-11 (solutions manual): M14 x 2, grip 30 mm: kb 874.6 MN/m, km 3116.5 MN/m', () => {
    const kb = boltStiffness({
      Ad: 153.9 * MM * MM,
      At: 115 * MM * MM,
      ld: 11 * MM,
      lt: 19 * MM,
      E: 207 * GPA,
    });
    expect(within(kb.result, 874.6 * MN_PER_M, 0.001)).toBe(true);
    const km = memberStiffness({ E: 207 * GPA, d: 14 * MM, l: 30 * MM });
    expect(within(km.result, 3116.5 * MN_PER_M, 0.001)).toBe(true);
  });

  it('Shigley 10th ed. Problem 8-22 (solutions manual): M10, grip 40 mm: kb 356.0, km 1751.6 MN/m, C 0.169', () => {
    const kb = boltStiffness({
      Ad: (Math.PI / 4) * 100 * MM * MM,
      At: 58 * MM * MM,
      ld: 24 * MM,
      lt: 16 * MM,
      E: 207 * GPA,
    });
    const km = memberStiffness({ E: 207 * GPA, d: 10 * MM, l: 40 * MM });
    expect(within(kb.result, 356.0129 * MN_PER_M, 0.0005)).toBe(true);
    expect(within(km.result, 1751.566 * MN_PER_M, 0.0005)).toBe(true);
    const C = (kb.result as number) / ((kb.result as number) + (km.result as number));
    expect(C).toBeCloseTo(0.16892, 4);
  });

  it('Shigley 10th ed. Problem 8-14 (solutions manual): three frusta, 22.65, 210.7 and 12.27 Mlbf/in, km 7.67', () => {
    const k1 = frustumStiffness({ E: 30 * MPSI, d: 0.5 * INCH, D: 0.75 * INCH, t: 1.5 * INCH });
    const k2 = frustumStiffness({ E: 30 * MPSI, d: 0.5 * INCH, D: 1.905 * INCH, t: 0.5 * INCH });
    const k3 = frustumStiffness({ E: 14.5 * MPSI, d: 0.5 * INCH, D: 0.75 * INCH, t: 1 * INCH });
    expect(within(k1.result, 22.65 * MLBF_PER_IN, 0.002)).toBe(true);
    expect(within(k2.result, 210.7 * MLBF_PER_IN, 0.002)).toBe(true);
    expect(within(k3.result, 12.27 * MLBF_PER_IN, 0.002)).toBe(true);
    const km = seriesStiffness([fromRecord(k1), fromRecord(k2), fromRecord(k3)]);
    expect(within(km.result, 7.67 * MLBF_PER_IN, 0.002)).toBe(true);
  });

  it('closed-form check, not a textbook example: Eq. (8-22) is two equal Eq. (8-20) frusta in series', () => {
    const d = 12 * MM;
    const l = 36 * MM;
    const half = frustumStiffness({ E: 207 * GPA, d, D: 1.5 * d, t: l / 2 }).result as number;
    expect(within(memberStiffness({ E: 207 * GPA, d, l }).result, half / 2, 1e-4)).toBe(true);
  });
});

describe('preload and joint factors', () => {
  it('Shigley 10th ed. Problem 8-30 (solutions manual): K 0.2, 1/2 in bolt, 115 lbf·ft gives 13.8 kip', () => {
    const r = preloadFromTorqueNutFactor({ T: 115 * LBF * FOOT, d: 0.5 * INCH, K: 0.2 });
    expect(within(r.result, 13.8e3 * LBF, 0.001)).toBe(true);
  });

  it('closed-form check, not a textbook example: VDI 2230 torque relation for M10 x 1.5', () => {
    const r = preloadFromTorque({
      T: 50,
      d: 10 * MM,
      P: 1.5 * MM,
      muG: 0.12,
      muK: 0.12,
      DKm: 13 * MM,
    });
    const d2 = 10 - 0.649519 * 1.5;
    const lever = (0.16 * 1.5 + 0.58 * d2 * 0.12 + 6.5 * 0.12) * MM;
    expect(r.result).toBeCloseTo(50 / lever, 6);
    expect(derivedValue(r, 'd₂')).toBeCloseTo(d2 * MM, 12);
  });

  // Problem 8-29: C = 3/(3 + 12) = 0.2, P = 13.33 kip per bolt, Fi = 12.77 kip, Sp = 120 kpsi,
  // At = 0.1419 in².
  const joint = { kb: 3, km: 12, P: 13.33e3 * LBF, Fi: 12.77e3 * LBF };
  it('Shigley 10th ed. Problem 8-29 (solutions manual): separation 1.20, proof 1.10, overload 1.60', () => {
    expect(separationFactor(joint).result).toBeCloseTo(1.2, 2);
    const strength = { Sp: 120 * KPSI, At: 0.1419 * INCH * INCH };
    expect(boltProofFactor({ ...joint, ...strength }).result).toBeCloseTo(1.1, 2);
    expect(boltOverloadFactor({ ...joint, ...strength }).result).toBeCloseTo(1.6, 2);
    const r = separationFactor({ ...joint, requiredFactor: 1.5 });
    expect(r.status).toBe('warning');
    expect(derivedValue(r, 'C')).toBeCloseTo(0.2, 12);
  });

  it('closed-form check, not a textbook example: slip with and without an axial load', () => {
    expect(slipFactor({ Fi: 20e3, Fq: 2e3, mu: 0.15, interfaces: 2 }).result).toBeCloseTo(3, 12);
    const r = slipFactor({ Fi: 20e3, Fq: 2e3, mu: 0.15, P: 5e3, kb: 1, km: 4, requiredFactor: 3 });
    expect(derivedValue(r, 'F_KR')).toBeCloseTo(16e3, 9);
    expect(r.result).toBeCloseTo(1.2, 12);
    expect(r.status).toBe('warning');
    expect(slipFactor({ Fi: 20e3, Fq: 2e3, mu: 0.15, P: 5e3 }).status).toBe('unknown');
  });
});
