import { describe, expect, it } from 'vitest';
import { derivedValue } from './record';
import { threadStrippingFactor } from './threads';
import { MM, MPA } from './test-units';

describe('thread stripping', () => {
  it('closed-form check, not a textbook example: M10 x 1.5, 10 mm engaged, basic profile', () => {
    // Kn = d - 1.082532 P, Es = En = d - 0.649519 P, Ds = d. With P = 1.5 mm:
    // 0.57735 (Es - Kn) = 0.375 mm, 0.57735 (Ds - En) = 0.5625 mm.
    const Kn = 10 - 1.082532 * 1.5;
    const As = Math.PI * (10 / 1.5) * Kn * (0.75 + 0.375) * MM * MM;
    const An = Math.PI * (10 / 1.5) * 10 * (0.75 + 0.5625) * MM * MM;
    const r = threadStrippingFactor({
      d: 10 * MM,
      P: 1.5 * MM,
      Le: 10 * MM,
      F: 10e3,
      tauExternal: 400 * MPA,
      tauInternal: 100 * MPA,
      requiredFactor: 3,
    });
    expect(derivedValue(r, 'A_s')).toBeCloseTo(As, 9);
    expect(derivedValue(r, 'A_n')).toBeCloseTo(An, 9);
    expect(r.result).toBeCloseTo((100e6 * An) / 10e3, 4);
    expect(r.status).toBe('warning');
    expect(r.assumptions.some((a) => a.includes('basic profile'))).toBe(true);
  });

  it('uses tolerance dimensions when given', () => {
    const r = threadStrippingFactor({
      d: 10 * MM,
      P: 1.5 * MM,
      Le: 10 * MM,
      F: 10e3,
      tauExternal: 400 * MPA,
      tauInternal: 400 * MPA,
      KnMax: 8.676 * MM,
      EsMin: 8.862 * MM,
      DsMin: 9.732 * MM,
      EnMax: 9.206 * MM,
    });
    const As = Math.PI * (10 / 1.5) * 8.676 * (0.75 + 0.57735 * (8.862 - 8.676)) * MM * MM;
    expect(derivedValue(r, 'A_s')).toBeCloseTo(As, 9);
    expect(r.assumptions.some((a) => a.includes('basic profile'))).toBe(false);
  });
});
