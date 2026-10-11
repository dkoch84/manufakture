import { describe, expect, it } from 'vitest';
import { bearingDutyLife, bearingDutyLoad, bearingSpeed, cubicMeanLoad } from './bearing-duty';
import { derivedValue } from './record';
import { KN, LBF, RPM, within } from './test-units';

const WORDS = /\b(safe|safety|pass(es|ed|ing)?|fail(s|ed|ing|ure)?|certif\w*|complian\w*)\b/i;

describe('bearing load over a duty cycle', () => {
  // Shigley 10th ed. Problem 11-39 (solutions manual): a ball bearing with C10 = 20.3 kN runs
  // 4 min at 18 kN and 6 min at 30 kN, both at 2000 rev/min, so 8000 and 12 000 rev a cycle.
  // Palmgren-Miner gives 451 585 rev of life, 22.58 cycles, 3.76 h.
  it('Shigley 10th ed. Problem 11-39 (solutions manual): 18 kN for 8000 rev and 30 kN for 12 000 rev', () => {
    const load = bearingDutyLoad(
      [
        { load: 18 * KN, revolutions: 8000 },
        { load: 30 * KN, revolutions: 12000 },
      ],
      3,
    );
    expect(load.status).toBe('ok');
    expect(derivedValue(load, 'N')).toBe(20000);
    // (0.4 · 18³ + 0.6 · 30³)^(1/3) = 18 532.8^(1/3) = 26.46 kN.
    expect(within(load.result, 26.46 * KN, 0.001)).toBe(true);
    const life = bearingDutyLife({
      C: 20.3 * KN,
      P: load.result!,
      exponent: 3,
      revolutionsPerCycle: 20000,
      cycleDuration: 600,
    });
    expect(within(derivedValue(life, 'L10'), 451585, 0.001)).toBe(true);
    // The book rounds L1 and L2 to four figures first, hence 451 585 against 451 385 exact.
    expect(within(derivedValue(life, 'n_c'), 22.58, 0.001)).toBe(true);
    expect(life.result).toBeCloseTo(3.76, 2);
    expect(life.unit).toBe('h');
  });

  it('Shigley 10th ed. Problem 11-9 (solutions manual): C10 5050 lbf at 800 lbf and 350 rev/min is about 12 000 h', () => {
    const life = bearingDutyLife({
      C: 5050 * LBF,
      P: 800 * LBF,
      exponent: 3,
      // One minute at 350 rev/min as the cycle.
      revolutionsPerCycle: 350,
      cycleDuration: 60,
      requiredLife: 12000,
    });
    // The book rounds C up to 5050 lbf from 5040, so the life comes out just under 12 000 h.
    expect(within(life.result, 12000, 0.005)).toBe(true);
    expect(life.limit).toBe(12000);
    expect(life.limitKind).toBe('at-least');
  });

  it('closed-form check, not a textbook example: a steady load is its own mean, roller exponent', () => {
    expect(cubicMeanLoad([{ load: 1000, revolutions: 5 }], 10 / 3)).toBeCloseTo(1000, 9);
    expect(cubicMeanLoad([{ load: -1000, revolutions: 5 }], 3)).toBeCloseTo(1000, 9);
    expect(cubicMeanLoad([], 3)).toBeNaN();
    const r = bearingDutyLoad(
      [
        { load: 1000, revolutions: 1 },
        { load: 2000, revolutions: 1 },
      ],
      10 / 3,
    );
    expect(r.result).toBeCloseTo(((1000 ** (10 / 3) + 2000 ** (10 / 3)) / 2) ** (3 / 10), 6);
    expect(bearingDutyLoad([{ load: 1000, revolutions: 0 }], 3).status).toBe('unknown');
    expect(bearingDutyLoad([{ load: 1000, revolutions: undefined }], 3).missing).toEqual([
      'Revolutions of step 1',
    ]);
  });

  it('closed-form check, not a textbook example: life below the target is a warning; zero turns give no life', () => {
    const base = { C: 13500, P: 445, exponent: 3, revolutionsPerCycle: 100, cycleDuration: 10 };
    const life = bearingDutyLife(base).result!;
    expect(life).toBeCloseTo(((13500 / 445) ** 3 * 1e6 * 10) / 100 / 3600, 6);
    expect(bearingDutyLife({ ...base, requiredLife: life * 2 }).status).toBe('warning');
    expect(bearingDutyLife({ ...base, requiredLife: life / 2 }).margin).toBeCloseTo(1, 9);
    expect(bearingDutyLife({ ...base, revolutionsPerCycle: 0 }).status).toBe('unknown');
  });
});

describe('bearing speed', () => {
  it('closed-form check, not a textbook example: 521 r/min against 10 000 r/min', () => {
    const r = bearingSpeed({ speed: 521 * RPM, limitingSpeed: 10000 * RPM });
    expect(r.status).toBe('ok');
    expect(r.margin).toBeCloseTo(1 - 0.0521, 9);
    expect(derivedValue(r, 'ω/ω_lim')).toBeCloseTo(0.0521, 9);
    expect(bearingSpeed({ speed: 11000 * RPM, limitingSpeed: 10000 * RPM }).status).toBe('warning');
    expect(bearingSpeed({ speed: 1, limitingSpeed: undefined }).missing).toEqual([
      'Limiting speed',
    ]);
  });

  it('never calls anything safe, passing, failing, certified or compliant', () => {
    for (const r of [
      bearingSpeed({ speed: 1, limitingSpeed: 2 }),
      bearingDutyLoad([{ load: 1, revolutions: 1 }], 3),
      bearingDutyLife({ C: 2, P: 1, exponent: 3, revolutionsPerCycle: 1, cycleDuration: 1 }),
    ]) {
      for (const text of [r.title, r.method, r.note ?? '', ...r.assumptions]) {
        expect(text, r.id).not.toMatch(WORDS);
      }
      expect(r.sources.length).toBeGreaterThan(0);
    }
  });
});
