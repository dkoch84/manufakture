import { describe, expect, it } from 'vitest';
import {
  awgArea,
  awgDiameter,
  awgName,
  conductorResistance,
  jouleHeating,
  voltageDrop,
  wireAmpacityHeatBalance,
  wireAmpacityTable,
} from './electrical';
import { FOOT, INCH, within } from './test-units';

const OHM_PER_KFT = 1 / (1000 * FOOT);

describe('conductors', () => {
  it('NBS Handbook 100 copper wire table at 20 C: 14, 12 and 10 AWG are 2.525, 1.588 and 0.9989 ohm per 1000 ft', () => {
    const table: [number, number][] = [
      [14, 2.525],
      [12, 1.588],
      [10, 0.9989],
    ];
    for (const [gauge, ohms] of table) {
      const r = conductorResistance({ area: awgArea(gauge) });
      expect(within(r.result, ohms * OHM_PER_KFT, 0.002)).toBe(true);
    }
  });

  it('ASTM B258: 10 AWG is 0.1019 in and 4/0 AWG is 0.4600 in', () => {
    expect(within(awgDiameter(10), 0.1019 * INCH, 0.001)).toBe(true);
    expect(within(awgDiameter(-3), 0.46 * INCH, 0.001)).toBe(true);
    expect(awgName(-3)).toBe('4/0 AWG');
    expect(awgName(10)).toBe('10 AWG');
  });

  it('closed-form check, not a textbook example: resistance at 75 C', () => {
    const r20 = conductorResistance({ area: 1e-6 }).result as number;
    const r75 = conductorResistance({ area: 1e-6, temperature: 348.15 }).result as number;
    expect(r75 / r20).toBeCloseTo(1 + 0.00393 * 55, 12);
  });
});

describe('ampacity', () => {
  it('NFPA 70 (NEC) Table 310.16, copper: 10 AWG at 75 C is 35 A, 4/0 at 90 C is 260 A', () => {
    expect(wireAmpacityTable({}, { gauge: 10, rating: 75 }).result).toBe(35);
    expect(wireAmpacityTable({}, { gauge: -3, rating: 90 }).result).toBe(260);
    expect(wireAmpacityTable({}, { gauge: 12, rating: 60 }).result).toBe(20);
  });

  it('compares the ampacity with the design current, and is unknown off the table', () => {
    const r = wireAmpacityTable({ current: 40 }, { gauge: 10, rating: 75 });
    expect(r.status).toBe('warning');
    expect(r.margin).toBeCloseTo(-5 / 40, 12);
    expect(wireAmpacityTable({ current: 30 }, { gauge: 10, rating: 75 }).status).toBe('ok');
    expect(wireAmpacityTable({}, { gauge: 18, rating: 60 }).status).toBe('unknown');
    expect(wireAmpacityTable({}, { gauge: 20, rating: 90 }).status).toBe('unknown');
  });

  it('closed-form check, not a textbook example: heat-balance ampacity of a bare conductor', () => {
    const d = awgDiameter(14);
    const r = wireAmpacityHeatBalance({ d, h: 10, Tmax: 363.15, Tambient: 303.15 });
    const R = (1.7241e-8 * (1 + 0.00393 * 70)) / ((Math.PI * d * d) / 4);
    expect(r.result).toBeCloseTo(Math.sqrt((10 * Math.PI * d * 60) / R), 9);
  });
});

describe('voltage drop and heating', () => {
  it('closed-form check, not a textbook example: 10 A over 5 m of 10 AWG, out and back', () => {
    const R = conductorResistance({ area: awgArea(10) }).result as number;
    const r = voltageDrop({ I: 10, resistancePerLength: R, length: 5, supply: 24, allowed: 0.24 });
    expect(r.result).toBeCloseTo(10 * R * 10, 12);
    expect(r.status).toBe('warning');
  });

  it('closed-form check, not a textbook example: the M9 plan holding case, 45 A in 0.08 ohm is 162 W', () => {
    expect(jouleHeating({ I: 45, R20: 0.08 }).result).toBeCloseTo(162, 9);
    const hot = jouleHeating({ I: 45, R20: 0.08, temperature: 373.15 });
    expect(hot.result).toBeCloseTo(162 * (1 + 0.00393 * 80), 9);
  });
});
