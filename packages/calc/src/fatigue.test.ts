import { describe, expect, it } from 'vitest';
import {
  fatigueNotchFactor,
  marinEnduranceLimit,
  reliabilityFactor,
  temperatureFactor,
} from './fatigue';
import { derivedValue } from './record';
import { INCH, KPSI, MM, MPA, within } from './test-units';

describe('Marin endurance limit', () => {
  it('Shigley 11th ed. Problem 6-1 (solutions manual): ground, Sut 1020 MPa, d 10 mm, Se 429 MPa', () => {
    const r = marinEnduranceLimit(
      { Sut: 1020 * MPA, d: 10 * MM },
      { surface: 'ground', loading: 'bending' },
    );
    expect(derivedValue(r, 'k_a')).toBeCloseTo(0.868, 3);
    expect(derivedValue(r, 'k_b')).toBeCloseTo(0.969, 3);
    expect(within(r.result, 429 * MPA, 0.002)).toBe(true);
  });

  it('Shigley 11th ed. Problem 6-10 (solutions manual): machined, Sut 570 MPa, d 25 mm, Se 192 MPa', () => {
    const r = marinEnduranceLimit(
      { Sut: 570 * MPA, d: 25 * MM },
      { surface: 'machined', loading: 'bending' },
    );
    expect(derivedValue(r, 'k_a')).toBeCloseTo(0.767, 3);
    expect(derivedValue(r, 'k_b')).toBeCloseTo(0.879, 3);
    expect(within(r.result, 192 * MPA, 0.003)).toBe(true);
  });

  it('Shigley 11th ed. Problem 6-12 (solutions manual): torsion, machined, Sut 68 kpsi, d 0.8 in, Sse 14.4 kpsi', () => {
    const r = marinEnduranceLimit(
      { Sut: 68 * KPSI, d: 0.8 * INCH },
      { surface: 'machined', loading: 'torsion' },
    );
    expect(derivedValue(r, 'k_a')).toBeCloseTo(0.8, 2);
    expect(derivedValue(r, 'k_b')).toBeCloseTo(0.9, 2);
    expect(derivedValue(r, 'k_c')).toBe(0.59);
    expect(within(r.result, 14.4 * KPSI, 0.005)).toBe(true);
  });

  it('closed-form check, not a textbook example: axial loading, the 700 MPa cap, reliability 99 %', () => {
    const r = marinEnduranceLimit(
      { Sut: 1600 * MPA, reliability: 0.99 },
      { surface: 'ground', loading: 'axial' },
    );
    expect(derivedValue(r, "S_e'")).toBe(700 * MPA);
    expect(derivedValue(r, 'k_b')).toBe(1);
    expect(derivedValue(r, 'k_c')).toBe(0.85);
    // ke = 1 - 0.08 za with za = 2.326 at 99 %.
    expect(derivedValue(r, 'k_e')).toBeCloseTo(0.814, 3);
    expect(reliabilityFactor(0.5)).toBeCloseTo(1, 9);
    expect(reliabilityFactor(0.999)).toBeCloseTo(1 - 0.08 * 3.091, 3);
  });

  it('closed-form check, not a textbook example: the temperature polynomial at 450 F', () => {
    const T = ((450 - 32) * 5) / 9 + 273.15;
    expect(temperatureFactor(T)).toBeCloseTo(1.0069, 4);
  });
});

describe('fatigue notch factor', () => {
  it('Shigley 11th ed. Problem 6-12 (solutions manual): torsion, r 0.1 in, Sut 68 kpsi, Kts 1.40 gives Kfs 1.32', () => {
    const r = fatigueNotchFactor({ Kt: 1.4, r: 0.1 * INCH, Sut: 68 * KPSI }, 'torsion');
    expect(derivedValue(r, '√a')! / Math.sqrt(INCH)).toBeCloseTo(0.07335, 4);
    expect(derivedValue(r, 'q_s')).toBeCloseTo(0.812, 3);
    expect(r.result).toBeCloseTo(1.32, 2);
  });

  it('Shigley 11th ed. Problem 6-14 (solutions manual): bending, r 0.25 in, Sut 68 kpsi, Kt 2.5 gives Kf 2.25', () => {
    const r = fatigueNotchFactor({ Kt: 2.5, r: 0.25 * INCH, Sut: 68 * KPSI }, 'axial');
    expect(derivedValue(r, '√a')! / Math.sqrt(INCH)).toBeCloseTo(0.09799, 4);
    expect(derivedValue(r, 'q')).toBeCloseTo(0.836, 3);
    expect(r.result).toBeCloseTo(2.25, 2);
  });

  it('is unknown outside the fit', () => {
    expect(fatigueNotchFactor({ Kt: 2, r: 0.001, Sut: 200 * MPA }, 'bending').status).toBe(
      'unknown',
    );
  });
});
