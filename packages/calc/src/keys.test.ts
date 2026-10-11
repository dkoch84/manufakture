import { describe, expect, it } from 'vitest';
import { keyFactor } from './keys';
import { derivedValue } from './record';
import { INCH, KPSI, LBF, MM, MPA, within } from './test-units';

describe('parallel keys', () => {
  it('Shigley 10th ed. Problem 7-34 (solutions manual): 1/4 in square key, 2819 lbf·in on a 1 in shaft, n = 1.1 at 0.754 in in shear and 0.870 in in crushing', () => {
    const base = { T: 2819 * LBF * INCH, d: INCH, w: 0.25 * INCH, h: 0.25 * INCH, Sy: 57 * KPSI };
    const shear = keyFactor({ ...base, l: 0.754 * INCH });
    expect(within(derivedValue(shear, 'F'), 5638 * LBF, 0.001)).toBe(true);
    expect(within(derivedValue(shear, 'n_s'), 1.1, 0.003)).toBe(true);
    const crush = keyFactor({ ...base, l: 0.87 * INCH });
    expect(within(derivedValue(crush, 'n_c'), 1.1, 0.003)).toBe(true);
    // The record's factor is the smaller of the two.
    expect(crush.result).toBe(derivedValue(crush, 'n_c'));
  });

  it('Shigley 10th ed. Problem 7-35 (solutions manual): 14 mm square key, 3101 N·m on a 50 mm shaft, n = 1.1 at 43.3 mm in shear and 50.0 mm in crushing', () => {
    const base = { T: 3101, d: 50 * MM, w: 14 * MM, h: 14 * MM, Sy: 390 * MPA };
    expect(within(derivedValue(keyFactor({ ...base, l: 43.3 * MM }), 'n_s'), 1.1, 0.003)).toBe(
      true,
    );
    const r = keyFactor({ ...base, l: 50 * MM, requiredFactor: 1.2 });
    expect(within(r.result, 1.1, 0.003)).toBe(true);
    expect(r.status).toBe('warning');
  });

  it('closed-form check, not a textbook example: crushing at the softest of key, shaft and hub', () => {
    const base = { T: 3101, d: 50 * MM, w: 14 * MM, h: 14 * MM, l: 50 * MM, Sy: 390 * MPA };
    const r = keyFactor({ ...base, SyShaft: 600 * MPA, SyHub: 250 * MPA });
    expect(derivedValue(r, 'S_c')).toBe(250 * MPA);
    expect(derivedValue(r, 'n_c')).toBeCloseTo((250 * MPA * 0.007 * 0.05) / ((2 * 3101) / 0.05), 9);
    // Shear stays at the key's yield.
    expect(derivedValue(r, 'n_s')).toBe(derivedValue(keyFactor(base), 'n_s'));
  });

  it('is unknown without the key length', () => {
    const r = keyFactor({ T: 10, d: 0.02, w: 0.005, h: 0.005, l: undefined, Sy: 3e8 });
    expect(r.missing).toEqual(['Key length']);
  });
});
