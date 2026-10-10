import { describe, expect, it } from 'vitest';
import { lameStresses } from './cylinders';
import { derivedValue } from './record';
import { MM, MPA, within } from './test-units';

describe('thick cylinders', () => {
  it('Shigley 10th ed. Problem 3-102 (solutions manual): internal 105 MPa, 19 and 25 mm radii: hoop 392 MPa at the bore', () => {
    const r = lameStresses({ ri: 19 * MM, ro: 25 * MM, pi: 105 * MPA });
    expect(within(r.result, 0.8 * 490 * MPA, 0.002)).toBe(true);
    expect(derivedValue(r, 'σ_r')).toBeCloseTo(-105 * MPA, 0);
  });

  it('Shigley 10th ed. Problem 3-100 (solutions manual): external 82.8 MPa: hoop -392 MPa at the bore', () => {
    const r = lameStresses({ ri: 19 * MM, ro: 25 * MM, po: 82.8 * MPA });
    expect(within(r.result, -0.8 * 490 * MPA, 0.002)).toBe(true);
  });

  it('closed-form check, not a textbook example: closed ends, the outer surface, von Mises', () => {
    const r = lameStresses({ ri: 0.01, ro: 0.02, pi: 10e6, r: 0.02, closedEnds: true });
    // At r_o with p_o = 0: σ_t = 2 p_i r_i² / (r_o² - r_i²), σ_r = 0, σ_l = p_i r_i² / (r_o² - r_i²).
    expect(r.result).toBeCloseTo((2 * 10e6) / 3, 3);
    expect(derivedValue(r, 'σ_r')).toBeCloseTo(0, 3);
    expect(derivedValue(r, 'σ_l')).toBeCloseTo(10e6 / 3, 3);
    expect(derivedValue(r, "σ'")).toBeCloseTo((Math.sqrt(3) / 2) * ((2 * 10e6) / 3), 3);
  });
});
