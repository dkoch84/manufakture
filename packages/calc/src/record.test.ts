import { describe, expect, it } from 'vitest';
import { strengthFactor } from './factor';
import { derivedValue, fromDerived, fromRecord, given, marginOf } from './record';
import { shaftStress } from './shafts';
import { MPA } from './test-units';

describe('calc records', () => {
  it('M9 plan decision 1 example (closed-form): von Mises 182 MPa, yield 415 MPa, factor 2.28 against 2.0', () => {
    const r = strengthFactor({
      stress: given(182 * MPA, 'calc record shaft.stress at the bearing seat'),
      strength: given(415 * MPA, 'material steel, yield'),
      requiredFactor: given(2, 'your setting'),
    });
    expect(r.status).toBe('ok');
    expect(r.result).toBeCloseTo(2.2802, 4);
    expect(r.limit).toBe(2);
    expect(r.limitKind).toBe('at-least');
    expect(r.margin).toBeCloseTo(0.1401, 4);
    expect(r.inputs.map((i) => i.source)).toEqual([
      'calc record shaft.stress at the bearing seat',
      'material steel, yield',
      'your setting',
    ]);
  });

  it('is a warning below the factor the user chose, and never says pass or fail', () => {
    const r = strengthFactor({ stress: 250 * MPA, strength: 415 * MPA, requiredFactor: 2 });
    expect(r.status).toBe('warning');
    expect(r.margin).toBeLessThan(0);
    expect(JSON.stringify(r)).not.toMatch(/\b(safe|pass(es|ed)?|fail(s|ed)?|certif|complian)/i);
  });

  it('is ok with no limit when the user gave none', () => {
    const r = strengthFactor({ stress: 100 * MPA, strength: 415 * MPA });
    expect(r.status).toBe('ok');
    expect(r.limit).toBeUndefined();
    expect(r.margin).toBeUndefined();
  });

  it('names the missing inputs and gives no result', () => {
    const r = strengthFactor({ stress: 100 * MPA, strength: given(undefined, 'material pla') });
    expect(r.status).toBe('unknown');
    expect(r.result).toBeNull();
    expect(r.missing).toEqual(['Strength']);
    expect(r.inputs[1]).toMatchObject({ value: null, source: 'material pla' });
  });

  it('treats a non-finite input as missing', () => {
    const r = strengthFactor({ stress: Number.NaN, strength: 415 * MPA });
    expect(r.status).toBe('unknown');
    expect(r.missing).toEqual(['Stress']);
  });

  it('reports out-of-range inputs as unknown with a note', () => {
    const r = strengthFactor({ stress: -1, strength: 415 * MPA });
    expect(r.status).toBe('unknown');
    expect(r.note).toMatch(/positive/);
  });

  it('chains records, citing the record an input came from', () => {
    const s = shaftStress({ M: 100, T: 50, d: 0.02 }, { id: 'shaft.stress@A' });
    const f = strengthFactor({ stress: fromRecord(s), strength: 415 * MPA });
    expect(f.inputs[0]!.source).toBe('calc record shaft.stress@A');
    expect(fromDerived(s, 'τ').value).toBe(derivedValue(s, 'τ'));
    expect(f.result).toBeCloseTo(415e6 / (s.result as number), 9);
  });

  it('uses defaults and says so in the source', () => {
    const s = shaftStress({ M: 100, T: 0, d: 0.02 });
    expect(s.inputs.find((i) => i.symbol === 'K_f')).toMatchObject({
      value: 1,
      source: 'default: no stress concentration',
    });
  });

  it('computes margins for both limit kinds', () => {
    expect(marginOf(3, 2, 'at-least')).toBeCloseTo(0.5);
    expect(marginOf(1, 2, 'at-most')).toBeCloseTo(0.5);
    expect(marginOf(3, 2, 'at-most')).toBeCloseTo(-0.5);
  });
});
