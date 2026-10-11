import { describe, expect, it } from 'vitest';
import { lameStresses } from './cylinders';
import { pressFitPressure, pressFitSlipFactor } from './fits';
import { derivedValue } from './record';
import { GPA, MM, MPA, within } from './test-units';

describe('press fits', () => {
  // 35 mm H7/s6 medium drive fit, steel hub 60 mm outside on a solid steel shaft (207 GPa).
  const steel = { d: 35 * MM, do: 60 * MM, Eo: 207 * GPA, Ei: 207 * GPA, nuo: 0.3, nui: 0.3 };

  it('Shigley 10th ed. Problem 7-42 (solutions manual): interference 0.059 and 0.018 mm give 115 and 35.1 MPa', () => {
    expect(within(pressFitPressure({ ...steel, delta: 0.059 * MM }).result, 115 * MPA, 0.003)).toBe(
      true,
    );
    expect(
      within(pressFitPressure({ ...steel, delta: 0.018 * MM }).result, 35.1 * MPA, 0.003),
    ).toBe(true);
  });

  it('Shigley 10th ed. Problem 7-42 (solutions manual): the hub at 115 MPa, tangential 234 MPa, von Mises 308 MPa', () => {
    const hub = lameStresses({ ri: 17.5 * MM, ro: 30 * MM, pi: 115 * MPA });
    expect(within(hub.result, 234 * MPA, 0.003)).toBe(true);
    expect(within(derivedValue(hub, "σ'"), 308 * MPA, 0.003)).toBe(true);
  });

  it('Shigley 10th ed. Problem 7-42 (solutions manual): f 0.8 at 35.1 MPa over 50 mm carries 2700 N·m', () => {
    const r = pressFitSlipFactor({ T: 1000, p: 35.1 * MPA, f: 0.8, l: 50 * MM, d: 35 * MM });
    expect(within(derivedValue(r, 'T_cap'), 2700, 0.002)).toBe(true);
    expect(within(r.result, 2.7, 0.002)).toBe(true);
  });

  it('closed-form check, not a textbook example: different materials and a hollow shaft', () => {
    const v = {
      delta: 0.03 * MM,
      d: 0.02,
      do: 0.04,
      di: 0.01,
      Eo: 70e9,
      nuo: 0.33,
      Ei: 200e9,
      nui: 0.29,
    };
    const hub = (0.04 ** 2 + 0.02 ** 2) / (0.04 ** 2 - 0.02 ** 2) + 0.33;
    const shaft = (0.02 ** 2 + 0.01 ** 2) / (0.02 ** 2 - 0.01 ** 2) - 0.29;
    const expected = 0.03e-3 / (0.02 * (hub / 70e9 + shaft / 200e9));
    expect(pressFitPressure(v).result).toBeCloseTo(expected, 3);
    expect(pressFitPressure({ ...v, do: 0.02 }).status).toBe('unknown');
  });
});
