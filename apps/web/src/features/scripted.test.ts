import { applyCommand, type ScriptedFeature } from '@manufakture/core';
import { describe, expect, it } from 'vitest';
import { PART, applyAll, scriptedDocument, scriptedFeature } from '../scripts/scripts.test-fixture';
import {
  addParamRef,
  buildScripted,
  defaultField,
  fieldsFor,
  newScriptedForm,
  paramRefField,
  scriptedFormOf,
  type ParamSpec,
} from './scripted';

const specs: ParamSpec[] = [
  { name: 'width', kind: 'length', default: 40, min: 1, label: 'Width' },
  { name: 'tilt', kind: 'angle', default: Math.PI / 4 },
  { name: 'count', kind: 'number', default: 3, min: 1, max: 10, integer: true },
  { name: 'flip', kind: 'boolean', default: true },
  { name: 'style', kind: 'choice', options: ['round', 'square'], default: 'square' },
  { name: 'face', kind: 'reference', select: 'face', optional: true },
  { name: 'edges', kind: 'reference', select: 'edge', multiple: true },
];

const face = (name: string) => ({ id: null, ref: { face: name }, label: name });
const edge = (a: string, b: string) => ({ id: null, ref: { faces: [a, b] }, label: `${a} | ${b}` });

describe('the scripted feature form', () => {
  it('starts every parameter at its default, in the document units', () => {
    const doc = scriptedDocument();
    const values = fieldsFor(specs, doc.units);
    expect(values).toEqual({
      width: { kind: 'expression', text: '40' },
      tilt: { kind: 'expression', text: '45' },
      count: { kind: 'expression', text: '3' },
      flip: { kind: 'boolean', value: true },
      style: { kind: 'choice', value: 'square' },
      face: { kind: 'reference', refs: [] },
      edges: { kind: 'reference', refs: [] },
    });
    const inches = { ...doc.units, length: { unit: 'in' as const } };
    expect(defaultField(specs[0]!, inches)).toEqual({ kind: 'expression', text: '1.574803' });
    expect(newScriptedForm(doc)).toEqual({ script: 'script#1', values: {}, seed: '0' });
  });

  it('fills stored values that fit the declared kind, and defaults for the rest', () => {
    const doc = scriptedDocument();
    const stored: ScriptedFeature['params'] = {
      width: {
        kind: 'expression',
        expression: { source: '#w + 2', lengthUnit: 'mm', angleUnit: 'deg' },
      },
      flip: { kind: 'choice', value: 'x' },
      style: { kind: 'choice', value: 'gone' },
      edges: { kind: 'reference', references: [{ id: 'r4', ref: { faces: ['a', 'b'] } }] },
    };
    const values = fieldsFor(specs, doc.units, { stored, lost: new Set(['r4']) });
    expect(values.width).toEqual({ kind: 'expression', text: '#w + 2' });
    expect(values.flip).toEqual({ kind: 'boolean', value: true });
    expect(values.style).toEqual({ kind: 'choice', value: 'square' });
    expect(values.edges).toEqual({
      kind: 'reference',
      refs: [{ id: 'r4', ref: { faces: ['a', 'b'] }, label: 'a | b', lost: true }],
    });
    // What the dialog held wins over the stored value when the declarations are read again.
    const kept = fieldsFor(specs, doc.units, {
      stored,
      keep: { width: { kind: 'expression', text: '12' } },
    });
    expect(kept.width).toEqual({ kind: 'expression', text: '12' });
  });

  it('reads and writes only own properties: a parameter may be called constructor or __proto__', () => {
    const doc = scriptedDocument();
    const odd: ParamSpec[] = [
      { name: 'constructor', kind: 'number', default: 2 },
      { name: '__proto__', kind: 'boolean', default: true },
    ];
    const values = fieldsFor(odd, doc.units, { stored: {}, keep: {} });
    expect(Object.keys(values)).toEqual(['constructor', '__proto__']);
    expect(values.constructor).toEqual({ kind: 'expression', text: '2' });
    expect(Object.getPrototypeOf(values)).toBe(Object.prototype);
    const r = buildScripted({ script: 'script#1', values: {}, seed: '0' }, odd, {
      doc,
      partId: PART,
    });
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    expect(Object.keys(r.feature.params)).toEqual(['constructor', '__proto__']);
    expect(Object.getPrototypeOf(r.feature.params)).toBe(Object.prototype);
  });

  it('reference parameters take faces or edges; a body takes a face of it', () => {
    expect(paramRefField(specs[5]!)).toEqual({
      key: 'param:face',
      label: 'face',
      accepts: ['face'],
      max: 1,
      required: false,
    });
    expect(paramRefField(specs[6]!)).toMatchObject({
      accepts: ['edge'],
      max: Infinity,
      required: true,
    });
    expect(paramRefField({ name: 'b', kind: 'reference', select: 'body' })).toMatchObject({
      accepts: ['face'],
      label: 'b (pick a face of the body)',
    });
    expect(paramRefField(specs[0]!)).toBeNull();
    const one = paramRefField(specs[5]!)!;
    expect(addParamRef([face('a')], one, face('b')).map((r) => r.label)).toEqual(['b']);
    const many = paramRefField(specs[6]!)!;
    const twice = addParamRef([edge('a', 'b')], many, edge('a', 'b'));
    expect(twice).toHaveLength(1);
    const lost = [{ ...edge('a', 'b'), id: 'r2', lost: true }];
    expect(addParamRef(lost, many, edge('c', 'd'))).toEqual([{ ...edge('c', 'd'), id: 'r2' }]);
  });

  it('builds the feature with every value, fresh reference ids and the seed, as one command', () => {
    const doc = scriptedDocument();
    const form = {
      script: 'script#1',
      seed: '7',
      values: {
        ...fieldsFor(specs, doc.units),
        width: { kind: 'expression' as const, text: '25' },
        edges: { kind: 'reference' as const, refs: [edge('a', 'b'), edge('c', 'd')] },
      },
    };
    const r = buildScripted(form, specs, { doc, partId: PART });
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    expect(r.label).toBe('Add Scripted 3');
    expect(r.feature).toMatchObject({ id: 'scripted#3', script: 'script#1', seed: 7 });
    expect(r.feature.params).toEqual({
      width: {
        kind: 'expression',
        expression: { source: '25', lengthUnit: 'mm', angleUnit: 'deg' },
      },
      tilt: {
        kind: 'expression',
        expression: { source: '45', lengthUnit: 'mm', angleUnit: 'deg' },
      },
      count: {
        kind: 'expression',
        expression: { source: '3', lengthUnit: 'mm', angleUnit: 'deg' },
      },
      flip: { kind: 'boolean', value: true },
      style: { kind: 'choice', value: 'square' },
      face: { kind: 'reference', references: [] },
      edges: {
        kind: 'reference',
        references: [
          { id: 'r1', ref: { faces: ['a', 'b'] } },
          { id: 'r2', ref: { faces: ['c', 'd'] } },
        ],
      },
    });
    // Core takes it.
    expect(applyCommand(doc, r.command).ok).toBe(true);
  });

  it('refuses values outside the declared bounds, a missing pick and a bad seed', () => {
    const doc = scriptedDocument();
    const form = {
      script: 'script#1',
      seed: '-1',
      values: {
        ...fieldsFor(specs, doc.units),
        width: { kind: 'expression' as const, text: '0.5' },
        count: { kind: 'expression' as const, text: '2.5' },
        tilt: { kind: 'expression' as const, text: '10 mm' },
      },
    };
    const r = buildScripted(form, specs, { doc, partId: PART });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors['param:width']).toBe('Must be at least 1 mm.');
    expect(r.errors['param:count']).toBe('Must be a whole number.');
    expect(r.errors['param:tilt']).toBeDefined();
    expect(r.errors['param:edges']).toBe('Pick one in the viewport.');
    expect(r.errors.seed).toBe('A whole number from 0 to 4294967295.');
    expect(r.errors['param:face']).toBeUndefined();
  });

  it('without declarations an edit keeps the stored values and changes only the seed', () => {
    const stored: ScriptedFeature['params'] = { flip: { kind: 'boolean', value: false } };
    const doc = applyAll(scriptedDocument(), [
      {
        type: 'editFeature',
        partId: PART,
        feature: scriptedFeature('scripted#1', 'script#1', { params: stored, seed: 3 }),
      },
    ]);
    const existing = doc.parts[0]!.features[0] as ScriptedFeature;
    const form = { ...scriptedFormOf(existing), seed: '9' };
    expect(form.seed).toBe('9');
    const r = buildScripted(form, null, { doc, partId: PART, existing });
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    expect(r.command.type).toBe('editFeature');
    expect(r.feature).toMatchObject({ id: 'scripted#1', params: stored, seed: 9 });
    expect(r.label).toBe('Edit Scripted 1');
  });

  it('needs a script of the document', () => {
    const doc = scriptedDocument();
    const r = buildScripted({ script: 'script#9', values: {}, seed: '0' }, [], {
      doc,
      partId: PART,
    });
    expect(r).toEqual({ ok: false, errors: { script: 'Choose a script.' } });
  });
});
