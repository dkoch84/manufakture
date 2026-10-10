import { describe, expect, it } from 'vitest';
import { grooveKt, holeInPlateKt, keyseatKt, shoulderFilletKt } from './concentration';
import { derivedValue } from './record';
import { MM, MPA, within } from './test-units';

describe('stress concentration', () => {
  it('Pilkey 2nd ed. Example 6.1: U-groove, D 70 mm, h 10.5 mm, r 7 mm: Kt 1.78 bending, 1.41 torsion', () => {
    const geometry = { D: 70 * MM, d: 49 * MM, r: 7 * MM };
    const bending = grooveKt(geometry, 'bending');
    const torsion = grooveKt(geometry, 'torsion');
    expect(bending.result).toBeCloseTo(1.78, 2);
    expect(torsion.result).toBeCloseTo(1.41, 2);
    // σ = Kt 32 M / π d³ with M = 1.0 kN·m: 154.1 MPa; τ = Kt 16 T / π d³ with T = 2.5 kN·m: 152.6 MPa.
    const d3 = (49 * MM) ** 3;
    expect(
      within(((bending.result as number) * 32 * 1000) / (Math.PI * d3), 154.1 * MPA, 0.003),
    ).toBe(true);
    expect(
      within(((torsion.result as number) * 16 * 2500) / (Math.PI * d3), 152.6 * MPA, 0.003),
    ).toBe(true);
  });

  it('Pilkey 2nd ed. Example 6.2: hole 20 mm in a 100 mm plate, Kt 2.51, 64 kN on 8 mm gives 251 MPa', () => {
    const r = holeInPlateKt({ W: 100 * MM, d: 20 * MM });
    expect(r.result).toBeCloseTo(2.51, 2);
    const nominal = 64e3 / ((100 - 20) * MM * 8 * MM);
    expect(nominal).toBeCloseTo(100 * MPA, 0);
    expect(within((r.result as number) * nominal, 251 * MPA, 0.002)).toBe(true);
  });

  it('closed-form check, not a textbook example: the two shoulder-fillet ranges meet at h/r = 2', () => {
    for (const loading of ['axial', 'bending'] as const) {
      const below = shoulderFilletKt({ D: 30 * MM, d: 26.002 * MM, r: 1 * MM }, loading);
      const above = shoulderFilletKt({ D: 30 * MM, d: 25.998 * MM, r: 1 * MM }, loading);
      expect(derivedValue(below, 'h/r')!).toBeLessThan(2);
      expect(derivedValue(above, 'h/r')!).toBeGreaterThan(2);
      expect(within(above.result, below.result as number, 0.01)).toBe(true);
    }
  });

  it('closed-form check, not a textbook example: shoulder torsion fit and its range', () => {
    // h/r = 1, 2h/D = 0.2: C = (1.613, -1.853, 2.052, -0.804).
    const r = shoulderFilletKt({ D: 25 * MM, d: 20 * MM, r: 2.5 * MM }, 'torsion');
    expect(r.result).toBeCloseTo(1.613 - 1.853 * 0.2 + 2.052 * 0.04 - 0.804 * 0.008, 6);
    const out = shoulderFilletKt({ D: 40 * MM, d: 20 * MM, r: 1 * MM }, 'torsion');
    expect(out.status).toBe('unknown');
    expect(out.note).toMatch(/outside/);
  });

  it('closed-form check, not a textbook example: end-milled keyseat at r/D = 0.02', () => {
    const b = keyseatKt({ D: 50 * MM, r: 1 * MM }, 'bending');
    expect(b.result).toBeCloseTo(1.426 + 0.1643 * 5 - 0.0019 * 25, 9);
    const t = keyseatKt({ D: 50 * MM, r: 1 * MM }, 'torsion');
    expect(t.result).toBe(3.4);
    expect(derivedValue(t, 'K_tB')).toBeCloseTo(1.953 + 0.1434 * 5 - 0.0021 * 25, 9);
  });
});
