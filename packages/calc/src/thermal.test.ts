import { describe, expect, it } from 'vitest';
import { derivedValue } from './record';
import { firstOrderTemperature } from './thermal';

describe('first-order thermal model', () => {
  it('closed-form check, not a textbook example: 162 W into 0.5 K/W and 1000 J/K for 30 s', () => {
    const r = firstOrderTemperature({ P: 162, Rth: 0.5, Cth: 1000, t: 30, Tambient: 298.15 });
    expect(derivedValue(r, 'τ')).toBe(500);
    expect(r.result).toBeCloseTo(298.15 + 81 * (1 - Math.exp(-30 / 500)), 9);
    expect(derivedValue(r, 'T_∞')).toBeCloseTo(379.15, 9);
  });

  it('closed-form check, not a textbook example: cooling from a starting temperature, and the limit', () => {
    const r = firstOrderTemperature({
      P: 0,
      Rth: 2,
      Cth: 50,
      t: 100,
      Tambient: 300,
      T0: 400,
      Tmax: 330,
    });
    expect(r.result).toBeCloseTo(300 + 100 * Math.exp(-1), 9);
    expect(r.status).toBe('warning');
    const long = firstOrderTemperature({
      P: 10,
      Rth: 2,
      Cth: 50,
      t: 1e6,
      Tambient: 300,
      Tmax: 330,
    });
    expect(long.result).toBeCloseTo(320, 9);
    expect(long.status).toBe('ok');
  });
});
