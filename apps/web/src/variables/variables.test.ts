import {
  DocumentStore,
  applyCommand,
  type Command,
  type ManufaktureDocument,
} from '@manufakture/core';
import { dirtyFeaturesOf } from '@manufakture/regen';
import { angleQuantity, evaluate, lengthQuantity, numberQuantity } from '@manufakture/units';
import { describe, expect, it } from 'vitest';
import { boxDocument, mm } from './box.test-fixture';
import {
  checkDraft,
  deleteCommand,
  draftOf,
  evaluateTable,
  quantityLiteral,
  replaceWithValueCommand,
  tableValues,
  variableRows,
  withUnit,
  type DraftCheck,
} from './variables';

const FT_IN = {
  length: { unit: 'ft-in' as const, denominator: 16 as const },
  angle: { unit: 'deg' as const },
};

function apply(doc: ManufaktureDocument, check: DraftCheck): ManufaktureDocument {
  if (!check.ok) throw new Error(JSON.stringify(check.errors));
  if (!check.command) return doc;
  const r = applyCommand(doc, check.command);
  if (!r.ok) throw new Error(r.error.message);
  return r.value.document;
}

const sources = (doc: ManufaktureDocument) =>
  Object.fromEntries(doc.variables.map((v) => [v.name, v.expression.source]));

describe('the table', () => {
  it('evaluates every variable in dependency order, with its type, value and uses', () => {
    const doc = boxDocument();
    expect(variableRows(doc)).toEqual([
      {
        name: 'w',
        source: '40 mm',
        type: 'length',
        value: '40.00 mm',
        error: null,
        uses: [
          {
            key: 'f:sketch#1:constraints.2.value',
            label: 'Sketch 1: dimension k3',
            featureId: 'sketch#1',
          },
        ],
      },
      {
        name: 'd',
        source: '25 mm',
        type: 'length',
        value: '25.00 mm',
        error: null,
        uses: [
          { key: 'v:h', label: '#h', featureId: null },
          {
            key: 'f:sketch#1:constraints.3.value',
            label: 'Sketch 1: dimension k4',
            featureId: 'sketch#1',
          },
        ],
      },
      {
        name: 'h',
        source: '#d - 10mm',
        type: 'length',
        value: '15.00 mm',
        error: null,
        uses: [
          { key: 'f:extrude#1:extent.distance', label: 'Extrude 1: Depth', featureId: 'extrude#1' },
        ],
      },
      {
        name: 'r',
        source: '2 mm',
        type: 'length',
        value: '2.00 mm',
        error: null,
        uses: [{ key: 'f:fillet#1:radius', label: 'Fillet 1: Radius', featureId: 'fillet#1' }],
      },
    ]);
  });

  it('says why a variable has no value, and which one it reads when that one fails', () => {
    let doc = boxDocument();
    doc = apply(doc, {
      ok: true,
      command: { type: 'setVariable', name: 'd', expression: mm('1/0') },
      label: '',
      value: numberQuantity(0),
    });
    const table = evaluateTable(doc.variables);
    expect(table.get('d')).toEqual({ ok: false, message: 'Division by zero' });
    expect(table.get('h')).toEqual({
      ok: false,
      message: '#d does not evaluate, so neither does this.',
    });
    expect(Object.keys(tableValues(table))).toEqual(['w', 'r']);
    expect(Object.keys(tableValues(table, 'w'))).toEqual(['r']);
    expect(variableRows(doc)[1]).toMatchObject({
      type: null,
      value: null,
      error: 'Division by zero',
    });
  });
});

describe('mates as uses', () => {
  it('lists a connector offset and a limit that read a variable, labelled by assembly and mate', () => {
    let doc = boxDocument();
    const commands: Command[] = [
      { type: 'addAssembly', assemblyId: 'assembly#1', name: 'Box' },
      ...['inst#1', 'inst#2'].map((id): Command => ({
        type: 'addInstance',
        assemblyId: 'assembly#1',
        instance: {
          id,
          name: id,
          source: { part: 'part#1' },
          fixed: id === 'inst#1',
          suppressed: false,
          pose: { translation: [0, 0, 0], rotation: [0, 0, 0, 1] },
        },
      })),
      {
        type: 'addMate',
        assemblyId: 'assembly#1',
        mate: {
          id: 'mate#1',
          name: 'Drawer',
          kind: 'slider',
          a: {
            id: 'mc#1',
            instance: 'inst#1',
            inference: 'centroid',
            origin: { id: 'r1', ref: { face: 'extrude#1:cap:end' } },
          },
          b: {
            id: 'mc#2',
            instance: 'inst#2',
            inference: 'centroid',
            origin: { id: 'r2', ref: { face: 'extrude#1:cap:start' } },
            offset: {
              translation: [mm('0'), mm('0'), mm('#h')],
              rotation: [mm('0'), mm('0'), mm('0')],
            },
          },
          suppressed: false,
          limits: { max: mm('#w') },
        },
      },
    ];
    for (const c of commands) {
      const r = applyCommand(doc, c);
      if (!r.ok) throw new Error(r.error.message);
      doc = r.value.document;
    }
    const rows = variableRows(doc);
    expect(rows.find((r) => r.name === 'h')!.uses).toContainEqual({
      key: 'm:assembly#1/mate#1:b.offset.translation.2',
      label: 'Box: Drawer: Offset Z of the second connector',
      featureId: null,
    });
    expect(rows.find((r) => r.name === 'w')!.uses).toContainEqual({
      key: 'm:assembly#1/mate#1:limits.max',
      label: 'Box: Drawer: Maximum',
      featureId: null,
    });
  });
});

describe('adding and editing', () => {
  it('adds a variable, writing the unit into a bare length', () => {
    const doc = boxDocument();
    const check = checkDraft(doc, { name: '#thickness', source: '19.05', type: 'length' }, null);
    expect(check).toMatchObject({
      ok: true,
      label: 'Add variable #thickness',
      command: { type: 'setVariable', name: 'thickness', expression: mm('19.05 mm') },
      value: lengthQuantity(19.05),
    });
    // An expression gets parentheses; an inch document writes inches.
    expect(withUnit('2 * #n', 'length', FT_IN)).toBe('(2 * #n) in');
    expect(withUnit('45', 'angle', doc.units)).toBe('45 deg');
  });

  it('keeps a number a number, and an expression with units as typed', () => {
    const doc = boxDocument();
    expect(checkDraft(doc, { name: 'n', source: '4', type: 'number' }, null)).toMatchObject({
      ok: true,
      command: { expression: mm('4') },
    });
    expect(checkDraft(doc, { name: 'x', source: '#w / 2', type: 'length' }, null)).toMatchObject({
      ok: true,
      command: { expression: mm('#w / 2') },
      value: lengthQuantity(20),
    });
    expect(checkDraft(doc, { name: 'a', source: '#w * #d', type: 'any' }, null)).toMatchObject({
      ok: true,
      command: { expression: mm('#w * #d') },
    });
  });

  it('refuses the wrong type, bad names, unknown variables and syntax errors', () => {
    const doc = boxDocument();
    const errors = (draft: Parameters<typeof checkDraft>[1], original: string | null = null) => {
      const c = checkDraft(doc, draft, original);
      return c.ok ? null : c.errors;
    };
    expect(errors({ name: 'x', source: '#w', type: 'angle' })).toEqual({
      expression: 'This is a length, not an angle: change the type or the value.',
    });
    expect(errors({ name: 'x', source: '30deg', type: 'number' })).toEqual({
      expression: 'This is an angle, not a number: change the type or the value.',
    });
    expect(errors({ name: 'w', source: '1', type: 'number' })).toEqual({
      name: 'There is already a variable #w.',
    });
    expect(errors({ name: 'sin', source: '1', type: 'number' })?.name).toMatch(/not a function/);
    expect(errors({ name: '', source: '', type: 'number' })).toEqual({
      name: 'Enter a name.',
      expression: 'Enter a value.',
    });
    expect(errors({ name: 'x', source: '#nope + 1', type: 'length' })).toEqual({
      expression: 'Unknown variable "nope"',
    });
    expect(errors({ name: 'x', source: '2 +', type: 'length' })?.expression).toMatch(
      /after|Expected|missing/i,
    );
  });

  it('rejects variables that read each other, with a clear message', () => {
    const doc = boxDocument();
    // d reads h, which reads d.
    const loop = checkDraft(doc, { name: 'd', source: '#h + 1mm', type: 'length' }, 'd');
    expect(loop).toEqual({
      ok: false,
      cycle: true,
      errors: { expression: 'Variables cannot read each other in a loop: #d -> #h -> #d.' },
    });
    // Reading itself, new or existing.
    expect(checkDraft(doc, { name: 'q', source: '#q * 2', type: 'number' }, null)).toMatchObject({
      ok: false,
      cycle: true,
    });
    expect(checkDraft(doc, { name: 'w', source: '#w', type: 'length' }, 'w')).toMatchObject({
      ok: false,
      cycle: true,
    });
    // Core refuses it too, whatever the UI does.
    const r = applyCommand(doc, { type: 'setVariable', name: 'd', expression: mm('#h') });
    expect(r).toMatchObject({ ok: false, error: { code: 'variable-cycle' } });
  });

  it('edits an expression, and does nothing when nothing changed', () => {
    const doc = boxDocument();
    const check = checkDraft(doc, { name: 'w', source: '50 mm', type: 'length' }, 'w');
    expect(check).toMatchObject({
      ok: true,
      label: 'Edit variable #w',
      command: { type: 'setVariable', name: 'w', expression: mm('50 mm') },
    });
    expect(checkDraft(doc, draftOf(doc, 'h'), 'h')).toMatchObject({ ok: true, command: null });
    expect(draftOf(doc, 'h')).toEqual({ name: 'h', source: '#d - 10mm', type: 'length' });
    expect(draftOf(doc, null)).toEqual({ name: '', source: '', type: 'length' });
  });

  it('renames a variable and every reference to it, as one undo step', () => {
    const doc = boxDocument();
    const store = DocumentStore.create(doc);
    if (!store.ok) throw new Error();
    const check = checkDraft(doc, { name: 'depth', source: '30 mm', type: 'length' }, 'd');
    expect(check).toMatchObject({ ok: true, label: 'Rename variable #d to #depth' });
    if (!check.ok) return;
    expect(store.value.execute(check.command!, check.label).ok).toBe(true);
    const next = store.value.document;
    expect(sources(next)).toEqual({ w: '40 mm', depth: '30 mm', h: '#depth - 10mm', r: '2 mm' });
    expect(next.variables.map((v) => v.name)).toEqual(['w', 'depth', 'h', 'r']);
    const sketch = next.parts[0]!.features[0]!;
    expect(sketch.kind === 'sketch' && sketch.constraints[3]).toMatchObject({
      value: { source: '#depth' },
    });
    expect(store.value.undoStack).toHaveLength(1);
    store.value.undo();
    expect(store.value.document).toEqual(doc);
  });

  it('treats a rename that makes a loop as a loop', () => {
    const doc = boxDocument();
    expect(checkDraft(doc, { name: 'depth', source: '#h', type: 'length' }, 'd')).toMatchObject({
      ok: false,
      cycle: true,
    });
  });
});

describe('deleting', () => {
  it('deletes an unused variable, and refuses one in use, listing its uses', () => {
    let doc = boxDocument();
    doc = apply(doc, checkDraft(doc, { name: 'spare', source: '1', type: 'number' }, null));
    expect(deleteCommand(doc, 'spare')).toEqual({
      ok: true,
      command: { type: 'deleteVariable', name: 'spare' },
      label: 'Delete variable #spare',
    });
    expect(deleteCommand(doc, 'd')).toMatchObject({
      ok: false,
      message: '#d is used in 2 places, so it cannot be deleted as it is.',
      uses: [{ label: '#h' }, { label: 'Sketch 1: dimension k4' }],
    });
  });

  it('replaces every use with the current value and deletes, as one undo step', () => {
    const doc = boxDocument();
    const store = DocumentStore.create(doc);
    if (!store.ok) throw new Error();
    const r = replaceWithValueCommand(doc, 'd');
    expect(r).toMatchObject({ ok: true, literal: '25mm', label: 'Replace #d with 25mm' });
    if (!r.ok) return;
    expect(store.value.execute(r.command, r.label).ok).toBe(true);
    const next = store.value.document;
    expect(sources(next)).toEqual({ w: '40 mm', h: '(25mm) - 10mm', r: '2 mm' });
    const sketch = next.parts[0]!.features[0]!;
    expect(sketch.kind === 'sketch' && sketch.constraints[3]).toMatchObject({
      value: { source: '25mm' },
    });
    // Every value is the same as before.
    const before = evaluateTable(doc.variables);
    const after = evaluateTable(next.variables);
    expect(after.get('h')).toEqual(before.get('h'));
    expect(store.value.undoStack).toHaveLength(1);
    store.value.undo();
    expect(store.value.document).toEqual(doc);
  });

  it('writes literals that evaluate to the value, in the document units', () => {
    const MM = boxDocument().units;
    const cases = [
      [lengthQuantity(19.05), MM, '19.05mm'],
      [lengthQuantity(19.05), FT_IN, '0.75in'],
      [angleQuantity(Math.PI / 6), MM, '30deg'],
      [numberQuantity(-3), MM, '-3'],
      [{ value: 1000, dimension: { length: 2, angle: 0 } }, MM, '1000*(1mm)^2'],
    ] as const;
    for (const [q, units, text] of cases) {
      expect(quantityLiteral(q, units)).toBe(text);
    }
    const back = evaluate('0.75in', { expected: 'length' });
    expect(back.ok && back.value).toBeCloseTo(19.05, 12);
  });

  it('cannot inline a variable without a value', () => {
    let doc = boxDocument();
    const r = applyCommand(doc, { type: 'setVariable', name: 'r', expression: mm('sqrt(-1mm)') });
    if (r.ok) doc = r.value.document;
    expect(checkDraft(doc, draftOf(doc, 'r'), 'r')).toMatchObject({ ok: false });
    expect(replaceWithValueCommand(doc, 'r')).toMatchObject({ ok: false });
  });
});

describe('regeneration after a variable edit', () => {
  it('rebuilds only the features that read the variable, and what depends on them', () => {
    const doc = boxDocument();
    const edit = (name: string, source: string) =>
      apply(doc, checkDraft(doc, { name, source, type: 'length' }, name));
    // The fillet radius: only the fillet.
    expect(dirtyFeaturesOf(doc, edit('r', '3 mm'), 'part#1')).toEqual(['fillet#1']);
    // The depth: the extrusion and the fillet on it, not the sketch.
    expect(dirtyFeaturesOf(doc, edit('d', '30 mm'), 'part#1')).toEqual([
      'sketch#1',
      'extrude#1',
      'fillet#1',
    ]);
    const hOnly = apply(doc, {
      ok: true,
      command: { type: 'setVariable', name: 'h', expression: mm('20 mm') },
      label: '',
      value: lengthQuantity(20),
    });
    expect(dirtyFeaturesOf(doc, hOnly, 'part#1')).toEqual(['extrude#1', 'fillet#1']);
  });
});
