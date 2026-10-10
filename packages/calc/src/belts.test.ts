import { describe, expect, it } from 'vitest';
import {
  beltCentrifugalTension,
  beltWrapAngle,
  flatBeltTensions,
  synchronousBeltTensionFactor,
  synchronousBeltToothFactor,
} from './belts';
import { derivedValue } from './record';
import { LBF, within } from './test-units';

describe('flat belts', () => {
  it('Shigley 10th ed. Problem 17-2 (solutions manual), with the Example 17-2 drive: F1 802, F2 138, Fi 396.6 lbf', () => {
    const r = flatBeltTensions({ dF: 664 * LBF, theta: 3.037, f: 0.8, Fc: 73.4 * LBF });
    expect(derivedValue(r, 'e^(fθ)')).toBeCloseTo(11.35, 2);
    expect(within(r.result, 802 * LBF, 0.002)).toBe(true);
    expect(within(derivedValue(r, 'F₂'), 138 * LBF, 0.005)).toBe(true);
    expect(within(derivedValue(r, 'F_i'), 396.6 * LBF, 0.002)).toBe(true);
  });

  it('Shigley 10th ed. Problem 17-2 (solutions manual), second drive: F1 114.8, F2 24.8, Fi 68.9 lbf', () => {
    const r = flatBeltTensions({
      dF: 90 * LBF,
      theta: 3.123,
      f: 0.5,
      Fc: 0.913 * LBF,
      allowable: 100 * LBF,
    });
    expect(within(r.result, 114.8 * LBF, 0.002)).toBe(true);
    expect(within(derivedValue(r, 'F₂'), 24.8 * LBF, 0.005)).toBe(true);
    expect(within(derivedValue(r, 'F_i'), 68.9 * LBF, 0.002)).toBe(true);
    expect(r.status).toBe('warning');
  });

  it('closed-form check, not a textbook example: wrap angle and centrifugal tension', () => {
    const r = beltWrapAngle({ D: 0.3, d: 0.1, C: 0.5 });
    expect(r.result).toBeCloseTo(Math.PI - 2 * Math.asin(0.2), 12);
    expect(derivedValue(r, 'θ_D')).toBeCloseTo(Math.PI + 2 * Math.asin(0.2), 12);
    expect(beltCentrifugalTension({ massPerLength: 0.1, V: 20 }).result).toBeCloseTo(40, 12);
  });
});

describe('synchronous belts', () => {
  it('closed-form check, not a textbook example: tension and tooth load against ratings', () => {
    const t = synchronousBeltTensionFactor({ T: 5, dp: 0.05, allowable: 500, requiredFactor: 2 });
    expect(derivedValue(t, 'T_e')).toBeCloseTo(200, 12);
    expect(t.result).toBeCloseTo(2.5, 12);
    expect(t.status).toBe('ok');
    // 20 teeth over 180°: 10 whole teeth in mesh share 200 N.
    const z = synchronousBeltToothFactor({
      T: 5,
      dp: 0.05,
      teeth: 20,
      theta: Math.PI,
      toothRating: 30,
    });
    expect(derivedValue(z, 'TIM')).toBe(10);
    expect(z.result).toBeCloseTo(1.5, 12);
  });
});
