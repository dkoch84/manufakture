import { describe, expect, it } from 'vitest';
import { applyCommand } from './commands';
import type { ExtrudeFeature, SketchFeature } from './schema';
import { DocumentStore } from './store';
import { bracket, deepFreeze, mm, unwrap } from './test-helpers';
import { inlineVariable, renameVariable, rewriteReferences, variableUses } from './variables';

const sketchOf = (doc: ReturnType<typeof bracket>) =>
  doc.parts[0]!.features.find((f) => f.id === 'sketch#1') as SketchFeature;
const extrudeOf = (doc: ReturnType<typeof bracket>) =>
  doc.parts[0]!.features.find((f) => f.id === 'extrude#1') as ExtrudeFeature;

describe('variableUses', () => {
  it('lists the variables and feature fields that read a variable, sketch dimensions by id', () => {
    const doc = bracket();
    expect(variableUses(doc, 'width')).toEqual([
      { kind: 'variable', name: 'height' },
      {
        kind: 'feature',
        partId: 'part#1',
        featureId: 'sketch#1',
        path: ['constraints', 2, 'value'],
        expected: 'length',
        constraintId: 'k3',
      },
    ]);
    expect(variableUses(doc, 'thickness')).toEqual([
      {
        kind: 'feature',
        partId: 'part#1',
        featureId: 'extrude#1',
        path: ['extent', 'distance'],
        expected: 'length',
      },
    ]);
    expect(variableUses(doc, 'nothing')).toEqual([]);
  });
});

describe('rewriteReferences', () => {
  it('replaces only whole references, hashed or bare', () => {
    expect(rewriteReferences('2*#w + w - #width', 'w', () => '#x')).toBe('2*#x + #x - #width');
    expect(rewriteReferences('  #w ', 'w', ({ whole }) => (whole ? 'W' : '(W)'))).toBe('  W ');
    expect(rewriteReferences('#w^2', 'w', ({ whole }) => (whole ? 'W' : '(W)'))).toBe('(W)^2');
    expect(rewriteReferences('2 +', 'w', () => 'x')).toBeNull();
  });
});

describe('renameVariable', () => {
  it('renames and updates every reference as one undo step', () => {
    const doc = deepFreeze(bracket());
    const store = unwrap(DocumentStore.create(doc));
    const command = unwrap(renameVariable(doc, 'width', 'span'));
    unwrap(store.execute(command, 'Rename width'));
    const next = store.document;
    expect(next.variables.map((v) => [v.name, v.expression.source])).toEqual([
      ['thickness', '6mm'],
      ['span', '40'],
      ['height', '#span / 2'],
    ]);
    expect(sketchOf(next).constraints[2]).toMatchObject({ value: { source: '#span' } });
    expect(store.undoStack).toHaveLength(1);
    unwrap(store.undo());
    expect(store.document).toEqual(doc);
  });

  it('can change the expression at the same time', () => {
    const doc = bracket();
    const command = unwrap(renameVariable(doc, 'thickness', 't', mm('8mm')));
    const next = unwrap(applyCommand(doc, command)).document;
    expect(next.variables[0]).toEqual({ name: 't', expression: mm('8mm') });
    expect(extrudeOf(next).extent).toMatchObject({ distance: { source: '#t' } });
  });

  it('refuses invalid and taken names', () => {
    const doc = bracket();
    expect(renameVariable(doc, 'width', 'height')).toMatchObject({
      ok: false,
      error: { code: 'duplicate' },
    });
    expect(renameVariable(doc, 'width', '2x')).toMatchObject({
      ok: false,
      error: { code: 'invalid-name' },
    });
    expect(renameVariable(doc, 'nope', 'x')).toMatchObject({
      ok: false,
      error: { code: 'not-found' },
    });
  });

  it('is a plain update when the name stays', () => {
    const doc = bracket();
    expect(unwrap(renameVariable(doc, 'width', 'width', mm('50')))).toEqual({
      type: 'setVariable',
      name: 'width',
      expression: mm('50'),
    });
  });
});

describe('inlineVariable', () => {
  it('writes the value into every use and deletes the variable, as one undo step', () => {
    const doc = deepFreeze(bracket());
    const store = unwrap(DocumentStore.create(doc));
    unwrap(store.execute(unwrap(inlineVariable(doc, 'width', '40mm')), 'Inline width'));
    const next = store.document;
    expect(next.variables.map((v) => [v.name, v.expression.source])).toEqual([
      ['thickness', '6mm'],
      ['height', '(40mm) / 2'],
    ]);
    // A whole expression gets no parentheses.
    expect(sketchOf(next).constraints[2]).toMatchObject({ value: { source: '40mm' } });
    expect(store.undoStack).toHaveLength(1);
    unwrap(store.undo());
    expect(store.document).toEqual(doc);
  });

  it('deletes an unused variable', () => {
    let doc = bracket();
    doc = unwrap(
      applyCommand(doc, { type: 'setVariable', name: 'spare', expression: mm('1') }),
    ).document;
    expect(unwrap(inlineVariable(doc, 'spare', '1'))).toEqual({
      type: 'batch',
      commands: [{ type: 'deleteVariable', name: 'spare' }],
    });
  });

  it('refuses a literal that does not parse', () => {
    expect(inlineVariable(bracket(), 'width', '2 +')).toMatchObject({
      ok: false,
      error: { code: 'expression' },
    });
  });
});
