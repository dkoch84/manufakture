import { describe, expect, it } from 'vitest';
import {
  elasticCoefficient,
  hertzContactStress,
  lewisBendingStress,
  lewisFormFactor,
  velocityFactor,
} from './gears';
import { fromRecord } from './record';
import { FOOT, INCH, KPSI, LBF, MM, MPA, MPSI, PSI, within } from './test-units';

/** Lewis stress for a metric spur gear from power and speed, as the solutions manual works it. */
function lewis(m: number, N: number, rpm: number, kW: number, F: number) {
  const d = m * N;
  const V = (Math.PI * d * rpm) / 60;
  const Wt = (kW * 1000) / V;
  const Y = lewisFormFactor({ teeth: N });
  const Kv = velocityFactor({ V }, 'cut');
  return {
    V,
    Wt,
    Kv,
    sigma: lewisBendingStress({ Wt, F, m, Y: fromRecord(Y), Kv: fromRecord(Kv) }),
  };
}

describe('Lewis bending', () => {
  it('Shigley 10th ed. Problem 14-3 (solutions manual): m 1.25 mm, 18 teeth, 1800 rpm, 0.5 kW, F 12 mm: 68.6 MPa', () => {
    const r = lewis(1.25 * MM, 18, 1800, 0.5, 12 * MM);
    expect(r.V).toBeCloseTo(2.121, 3);
    expect(r.Kv.result).toBeCloseTo(1.348, 3);
    expect(r.Wt).toBeCloseTo(235.8, 1);
    expect(within(r.sigma.result, 68.6 * MPA, 0.002)).toBe(true);
  });

  it('Shigley 10th ed. Problem 14-4 (solutions manual): m 8 mm, 16 teeth, 150 rpm, 6 kW, F 90 mm: 32.6 MPa', () => {
    const r = lewis(8 * MM, 16, 150, 6, 90 * MM);
    expect(r.Kv.result).toBeCloseTo(1.165, 3);
    expect(within(r.sigma.result, 32.6 * MPA, 0.002)).toBe(true);
  });

  it('Shigley 10th ed. Problem 14-1 (solutions manual): Pd 6, 22 teeth, 1200 rpm, 15 hp, F 2 in: 7.63 kpsi', () => {
    const d = (22 / 6) * INCH;
    const V = (Math.PI * d * 1200) / 60;
    expect(V / (FOOT / 60)).toBeCloseTo(1152, 0);
    const Wt = 429.7 * LBF;
    const Y = lewisFormFactor({ teeth: 22 });
    expect(Y.result).toBe(0.331);
    const Kv = velocityFactor({ V }, 'cut');
    expect(Kv.result).toBeCloseTo(1.96, 2);
    const s = lewisBendingStress({
      Wt,
      F: 2 * INCH,
      m: INCH / 6,
      Y: fromRecord(Y),
      Kv: fromRecord(Kv),
    });
    expect(within(s.result, 7.63 * KPSI, 0.003)).toBe(true);
  });

  it('closed-form check, not a textbook example: Y between table rows and below the table', () => {
    expect(lewisFormFactor({ teeth: 23 }).result).toBeCloseTo(0.334, 9);
    expect(lewisFormFactor({ teeth: 1000 }).result).toBe(0.485);
    expect(lewisFormFactor({ teeth: 10 }).status).toBe('unknown');
  });
});

describe('Hertz contact', () => {
  it('Shigley 10th ed. Problem 14-11 (solutions manual): Cp 2100 √psi, 20 and 50 teeth at Pd 8: 92.5 kpsi', () => {
    const r = hertzContactStress({
      Cp: 2100 * Math.sqrt(PSI),
      Kv: 1.655,
      Wt: 504.2 * LBF,
      F: 1.5 * INCH,
      d1: 2.5 * INCH,
      d2: 6.25 * INCH,
    });
    expect(within(r.result, 92.5 * KPSI, 0.002)).toBe(true);
  });

  it('closed-form check, not a textbook example: elastic coefficient of two steels (E 30 Mpsi, ν 0.3)', () => {
    const r = elasticCoefficient({ E1: 30 * MPSI, nu1: 0.3, E2: 30 * MPSI, nu2: 0.3 });
    expect((r.result as number) / Math.sqrt(PSI)).toBeCloseTo(
      Math.sqrt(30e6 / (2 * Math.PI * 0.91)),
      6,
    );
  });
});
