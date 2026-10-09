// Measured variables (#1202) in core: where `distance(...)` and `angle(...)` may stand, the face
// names they quote, and the measurements regen hands back.

import { describe, expect, it } from 'vitest';
import { applyCommand, type Command } from './commands';
import type { ConfigParameter, ConfigRow, ExtrudeFeature, ManufaktureDocument } from './schema';
import { bracket, mm, unwrap } from './test-helpers';
import { expressionMeasures, measuresModel, validateDocument } from './validate';
import {
  measuredVariables,
  measurementKey,
  measurementLookup,
  splitMeasuredFace,
  type Measurement,
} from './variables';

const GAP = 'distance("extrude#1:cap:start", "extrude#1:cap:end")';

function applied(doc: ManufaktureDocument, ...commands: Command[]): ManufaktureDocument {
  for (const c of commands) doc = unwrap(applyCommand(doc, c)).document;
  return doc;
}

const setVariable = (name: string, source: string): Command => ({
  type: 'setVariable',
  name,
  expression: mm(source),
});

describe('where an expression may measure the model', () => {
  it('a variable may, and its value composes with arithmetic', () => {
    const doc = applied(bracket(), setVariable('gap', `${GAP} - 1in`));
    expect(validateDocument(doc)).toEqual([]);
    expect(measuresModel(doc.variables.at(-1)!.expression)).toBe(true);
  });

  it('a feature field may not: it reads a variable instead', () => {
    const doc = bracket();
    const extrude = doc.parts[0]!.features.find((f) => f.id === 'extrude#1') as ExtrudeFeature;
    const r = applyCommand(doc, {
      type: 'editFeature',
      partId: 'part#1',
      feature: { ...extrude, extent: { type: 'blind', distance: mm(GAP) } },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('expression');
    expect(r.error.message).toBe(
      `distance() measures the model, so it may only be used in a variable: define a variable with it and use the variable in "${GAP}"`,
    );
  });

  it('a configuration row may give a variable a measured value, not a feature', () => {
    const width: ConfigParameter = {
      id: 'cp#1',
      name: 'Width',
      kind: 'variable',
      variable: 'width',
    };
    const row: ConfigRow = { id: 'cfg#1', name: 'Measured', values: { 'cp#1': mm(GAP) } };
    const doc = applied(
      bracket(),
      { type: 'setConfigParameter', parameter: width },
      { type: 'setConfigRow', row },
    );
    expect(validateDocument(doc)).toEqual([]);
  });

  it('a call without quoted names is no measurement, so documents that held one still load', () => {
    // Before #1202 `distance(#a, #b)` parsed (and failed at regen as an unknown function).
    const doc = bracket();
    const extrude = doc.parts[0]!.features.find((f) => f.id === 'extrude#1') as ExtrudeFeature;
    const r = applyCommand(doc, {
      type: 'editFeature',
      partId: 'part#1',
      feature: { ...extrude, extent: { type: 'blind', distance: mm('distance(#width, 2)') } },
    });
    expect(r.ok).toBe(true);
    expect(measuresModel(mm('distance(#width, 2)'))).toBe(false);
  });

  it('a variable named distance or angle stays valid, read bare', () => {
    const doc = applied(
      bracket(),
      setVariable('distance', '10'),
      setVariable('angle', '#distance * 2'),
    );
    expect(validateDocument(doc)).toEqual([]);
  });
});

describe('the faces a variable measures', () => {
  it('lists the calls of each measuring variable, in table order', () => {
    const doc = applied(
      bracket(),
      setVariable('gap', GAP),
      setVariable('half', '#gap / 2'),
      setVariable('tilt', 'angle("part#1/extrude#1:side:e1", "extrude#1:cap:end")'),
    );
    expect(measuredVariables(doc.variables).map((m) => [m.name, m.calls.map((c) => c.fn)])).toEqual(
      [
        ['gap', ['distance']],
        ['tilt', ['angle']],
      ],
    );
    const r = expressionMeasures(GAP);
    expect(r.ok && r.value[0]!.faces.map((f) => f.name)).toEqual([
      'extrude#1:cap:start',
      'extrude#1:cap:end',
    ]);
  });

  it('splits a part qualifier off a face name', () => {
    expect(splitMeasuredFace('part#2/extrude#1:cap:end')).toEqual({
      partId: 'part#2',
      face: 'extrude#1:cap:end',
    });
    expect(splitMeasuredFace('extrude#1:cap:end')).toEqual({ face: 'extrude#1:cap:end' });
    // A pattern copy's name has a `/` too, but no part before it.
    expect(splitMeasuredFace('pattern#2:i3/extrude#1:cap:end')).toEqual({
      face: 'pattern#2:i3/extrude#1:cap:end',
    });
  });

  it('answers a units lookup from regen measurements', () => {
    const list: Measurement[] = [
      { fn: 'distance', faces: ['a', 'b'], partId: 'part#1', value: 12 },
      { fn: 'angle', faces: ['a', 'b'], partId: 'part#1', value: null, error: 'Face "a" is lost' },
    ];
    const lookup = measurementLookup(list);
    expect(lookup({ fn: 'distance', faces: ['a', 'b'] })).toEqual({ ok: true, value: 12 });
    expect(lookup({ fn: 'angle', faces: ['a', 'b'] })).toEqual({
      ok: false,
      message: 'Face "a" is lost',
    });
    expect(lookup({ fn: 'distance', faces: ['b', 'a'] })).toBeUndefined();
    expect(measurementLookup(undefined)({ fn: 'distance', faces: ['a', 'b'] })).toBeUndefined();
    expect(measurementKey('distance', ['a', 'b'])).not.toBe(measurementKey('angle', ['a', 'b']));
  });
});
