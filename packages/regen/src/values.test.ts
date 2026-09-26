import { describe, expect, it } from 'vitest';
import { build, extrude, mm, setVariable } from './test-helpers';
import { evaluateFeature, evaluateField, evaluateVariables } from './values';

describe('variables', () => {
  it('evaluates in dependency order, in the units each was stored with', () => {
    const doc = build([
      {
        type: 'setVariable',
        name: 'w',
        expression: { source: '2', lengthUnit: 'in', angleUnit: 'deg' },
      },
      setVariable('wide', '1in'),
      setVariable('t', '2 * wide'),
    ]);
    const vars = evaluateVariables(doc.variables);
    expect(vars.values.get('wide')!.value).toBeCloseTo(25.4);
    expect(vars.values.get('t')!.value).toBeCloseTo(50.8);
    // No kind is declared: a bare number stays a number until a field reads it.
    expect(vars.values.get('w')).toEqual({ value: 2, dimension: { length: 0, angle: 0 } });
    expect(Object.keys(vars.record).sort()).toEqual(['t', 'w', 'wide']);
  });

  it('keeps a failing variable out and says so where it is read', () => {
    const doc = build([setVariable('bad', '1 / (2 - 2)'), setVariable('ok', '3')]);
    const vars = evaluateVariables(doc.variables);
    expect(vars.errors.get('bad')!.code).toBe('domain');
    const r = evaluateField(mm('bad + 1'), 'length', ['extent', 'distance'], vars);
    expect(r).toMatchObject({
      ok: false,
      error: { code: 'expression', variable: 'bad', field: ['extent', 'distance'] },
    });
    if (!r.ok) expect(r.error.message).toContain('Variable "bad" does not evaluate');
  });
});

describe('feature expressions', () => {
  it('evaluates every field to millimetres and radians', () => {
    const f = extrude('extrude#1', 'sketch#1', '1in');
    f.draft = { source: '3', lengthUnit: 'mm', angleUnit: 'deg' };
    const r = evaluateFeature(f, evaluateVariables([]));
    expect(r.errors).toEqual([]);
    expect(r.values.get('extent.distance')).toBeCloseTo(25.4);
    expect(r.values.get('draft')).toBeCloseTo((3 * Math.PI) / 180);
  });

  it('checks each field against the kind it expects', () => {
    const f = extrude('extrude#1', 'sketch#1', '10mm * 2mm');
    f.draft = mm('5mm');
    const r = evaluateFeature(f, evaluateVariables([]));
    expect(
      r.errors.map((e) => e.code === 'expression' && [e.field.join('.'), e.error.code]),
    ).toEqual([
      ['extent.distance', 'dimension'],
      ['draft', 'dimension'],
    ]);
  });
});
