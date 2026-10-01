import { describe, expect, it } from 'vitest';
import { diffDocuments } from './changes';
import { applyCommand, variableUsers, type Command } from './commands';
import { configured } from './configurations';
import { deserialize, serialize } from './format';
import { previewIds } from './ids';
import type { CoreErrorCode } from './result';
import type { ConfigParameter, ConfigRow, ManufaktureDocument } from './schema';
import { DocumentStore } from './store';
import { PART, bracket, deepFreeze, mm, unwrap } from './test-helpers';
import { validateDocument } from './validate';
import { inlineVariable, renameVariable, variableUses } from './variables';

/**
 * The configuration table (format v5): parameters, rows, the active row, `configured`, the
 * commands and their inverses, and what uses of variables and features it adds.
 */

const widthParam: ConfigParameter = {
  id: 'cp#1',
  name: 'Width',
  kind: 'variable',
  variable: 'width',
};
const filletParam: ConfigParameter = {
  id: 'cp#2',
  name: 'Rounded',
  kind: 'suppression',
  partId: PART,
  featureId: 'fillet#1',
};
const narrow: ConfigRow = {
  id: 'cfg#1',
  name: 'Narrow',
  values: { 'cp#1': mm('30'), 'cp#2': true },
};
const wide: ConfigRow = {
  id: 'cfg#2',
  name: 'Wide',
  values: { 'cp#1': mm('2 * #thickness + 50') },
};

function applied(doc: ManufaktureDocument, command: Command): ManufaktureDocument {
  return unwrap(applyCommand(doc, command)).document;
}

function refused(doc: ManufaktureDocument, command: Command, code: CoreErrorCode) {
  const r = applyCommand(doc, command);
  expect(r.ok).toBe(false);
  if (r.ok) throw new Error('expected a refusal');
  expect(r.error.code).toBe(code);
  return r.error;
}

const tableCommands = (): Command[] => [
  { type: 'setConfigParameter', parameter: widthParam },
  { type: 'setConfigParameter', parameter: filletParam },
  { type: 'setConfigRow', row: narrow },
  { type: 'setConfigRow', row: wide },
];

/** The bracket with a width parameter, a fillet suppression parameter and two rows, none active. */
function shelf(): ManufaktureDocument {
  return deepFreeze(applied(bracket(), { type: 'batch', commands: tableCommands() }));
}

function withActive(doc: ManufaktureDocument, rowId: string | null): ManufaktureDocument {
  return applied(doc, { type: 'setActiveConfiguration', rowId });
}

const variable = (doc: ManufaktureDocument, name: string) =>
  doc.variables.find((v) => v.name === name)!.expression.source;
const fillet = (doc: ManufaktureDocument) =>
  doc.parts[0]!.features.find((f) => f.id === 'fillet#1')!.suppressed;

describe('configured', () => {
  it('applies a row: variable expressions and suppression flags, nothing else', () => {
    const doc = shelf();
    const n = unwrap(configured(doc, 'cfg#1'));
    expect(variable(n, 'width')).toBe('30');
    expect(fillet(n)).toBe(true);
    expect(n.configurations?.active).toBe('cfg#1');
    // A parameter the row has no value for keeps the document's own value.
    const w = unwrap(configured(doc, 'cfg#2'));
    expect(variable(w, 'width')).toBe('2 * #thickness + 50');
    expect(fillet(w)).toBe(false);
    // Untouched things are shared, and the input is not modified (it is frozen).
    expect(w.parts[0]).toBe(doc.parts[0]);
    expect(n.variables.find((v) => v.name === 'height')).toBe(
      doc.variables.find((v) => v.name === 'height'),
    );
    expect(validateDocument(n)).toEqual([]);
    expect(variable(doc, 'width')).toBe('40');
  });

  it('applies the active row by default, and nothing with no row', () => {
    const doc = shelf();
    expect(unwrap(configured(doc))).toBe(doc);
    expect(unwrap(configured(bracket()))).toEqual(bracket());
    const active = withActive(doc, 'cfg#1');
    expect(variable(unwrap(configured(active)), 'width')).toBe('30');
    expect(variable(unwrap(configured(active, 'cfg#2')), 'width')).toBe('2 * #thickness + 50');
    expect(unwrap(configured(active, null))).toBe(active);
    // Applying the active row twice changes nothing more.
    const once = unwrap(configured(active));
    expect(unwrap(configured(once))).toEqual(once);
  });

  it('refuses a row that does not exist', () => {
    const r = configured(shelf(), 'cfg#9');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('not-found');
  });

  it('checks the result like any document', () => {
    // Hand-made and never validated: the row makes width read height, which reads width.
    const doc = shelf();
    const bad: ManufaktureDocument = {
      ...doc,
      configurations: {
        ...doc.configurations!,
        rows: [{ id: 'cfg#1', name: 'Loop', values: { 'cp#1': mm('height') } }],
      },
    };
    const r = configured(bad, 'cfg#1');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('variable-cycle');
  });
});

describe('configuration commands', () => {
  it('allocates cp#n and cfg#n from the document counters', () => {
    const doc = shelf();
    expect(doc.nextIds).toEqual({ part: 2, cp: 3, cfg: 3 });
    expect(previewIds(doc.nextIds, 'cp')).toEqual(['cp#3']);
    expect(previewIds(doc.nextIds, 'cfg')).toEqual(['cfg#3']);
    // Deleted ids are never handed out again.
    const gone = applied(doc, { type: 'deleteConfigRow', rowId: 'cfg#2' });
    refused(gone, { type: 'setConfigRow', row: { ...wide, name: 'Again' } }, 'id-reused');
    refused(
      bracket(),
      { type: 'setConfigParameter', parameter: { ...widthParam, id: 'cp#0' } },
      'schema',
    );
  });

  it('undoes and redoes every command, back to a document with no table', () => {
    const base = bracket();
    const store = unwrap(DocumentStore.create(base));
    for (const c of tableCommands()) unwrap(store.execute(c));
    unwrap(store.execute({ type: 'setActiveConfiguration', rowId: 'cfg#1' }));
    unwrap(store.execute({ type: 'setConfigRow', row: { ...narrow, name: 'Slim' } }));
    unwrap(store.execute({ type: 'setConfigParameter', parameter: { ...widthParam, name: 'W' } }));
    unwrap(store.execute({ type: 'deleteConfigParameter', parameterId: 'cp#1' }));
    unwrap(store.execute({ type: 'deleteConfigRow', rowId: 'cfg#1' }));
    const end = store.document;
    expect(end.configurations).toEqual({
      parameters: [filletParam],
      rows: [{ ...wide, values: {} }],
      active: null,
    });
    const states: ManufaktureDocument[] = [];
    while (store.canUndo) {
      states.push(store.document);
      unwrap(store.undo());
    }
    // Undo never moves counters back, so the ids stay spent.
    expect(store.document).toEqual({ ...base, nextIds: { ...base.nextIds, cp: 3, cfg: 3 } });
    expect('configurations' in store.document).toBe(false);
    for (const s of states.reverse()) {
      unwrap(store.redo());
      expect(store.document).toEqual(s);
    }
    expect(store.document).toEqual(end);
  });

  it('deleting a parameter removes its values; undo puts them back', () => {
    const doc = withActive(shelf(), 'cfg#1');
    const r = unwrap(applyCommand(doc, { type: 'deleteConfigParameter', parameterId: 'cp#1' }));
    expect(r.document.configurations!.rows.map((row) => row.values)).toEqual([
      { 'cp#2': true },
      {},
    ]);
    expect(applied(r.document, r.inverse)).toEqual(doc);
  });

  it('deleting the active row leaves none active; undo makes it active again', () => {
    const doc = withActive(shelf(), 'cfg#1');
    const r = unwrap(applyCommand(doc, { type: 'deleteConfigRow', rowId: 'cfg#1' }));
    expect(r.document.configurations!.active).toBeNull();
    expect(applied(r.document, r.inverse)).toEqual(doc);
  });

  it('restores only ids that were allocated and are gone', () => {
    const doc = shelf();
    refused(doc, { type: 'restoreConfigRow', row: narrow, index: 0 }, 'duplicate');
    refused(
      doc,
      { type: 'restoreConfigRow', row: { ...narrow, id: 'cfg#7', name: 'X' }, index: 0 },
      'invalid-id',
    );
    refused(
      doc,
      { type: 'restoreConfigParameter', parameter: { ...widthParam, id: 'cp#7' }, index: 0 },
      'invalid-id',
    );
  });

  it('refuses unknown items and indices past the end', () => {
    const doc = shelf();
    refused(doc, { type: 'setActiveConfiguration', rowId: 'cfg#9' }, 'not-found');
    refused(doc, { type: 'deleteConfigRow', rowId: 'cfg#9' }, 'not-found');
    refused(doc, { type: 'deleteConfigParameter', parameterId: 'cp#9' }, 'not-found');
    refused(
      doc,
      { type: 'setConfigRow', row: { id: 'cfg#3', name: 'Far', values: {} }, index: 5 },
      'invalid-index',
    );
  });
});

describe('invalid tables are refused', () => {
  const cases: [string, Command, CoreErrorCode][] = [
    [
      'a value for a parameter that does not exist',
      { type: 'setConfigRow', row: { id: 'cfg#3', name: 'X', values: { 'cp#9': mm('1') } } },
      'not-found',
    ],
    [
      'a flag for a variable parameter',
      { type: 'setConfigRow', row: { id: 'cfg#3', name: 'X', values: { 'cp#1': true } } },
      'kind-mismatch',
    ],
    [
      'an expression for a suppression parameter',
      { type: 'setConfigRow', row: { id: 'cfg#3', name: 'X', values: { 'cp#2': mm('1') } } },
      'kind-mismatch',
    ],
    [
      'an expression that does not parse',
      { type: 'setConfigRow', row: { id: 'cfg#3', name: 'X', values: { 'cp#1': mm('2 +') } } },
      'expression',
    ],
    [
      'an unknown variable in a value',
      { type: 'setConfigRow', row: { id: 'cfg#3', name: 'X', values: { 'cp#1': mm('#depth') } } },
      'unknown-variable',
    ],
    [
      'a value that makes a variable cycle',
      { type: 'setConfigRow', row: { id: 'cfg#3', name: 'X', values: { 'cp#1': mm('height') } } },
      'variable-cycle',
    ],
    [
      'a row name used twice',
      { type: 'setConfigRow', row: { id: 'cfg#3', name: 'Wide', values: {} } },
      'duplicate',
    ],
    [
      'a parameter name used twice',
      {
        type: 'setConfigParameter',
        parameter: { id: 'cp#3', name: 'Width', kind: 'variable', variable: 'height' },
      },
      'duplicate',
    ],
    [
      'two parameters for one variable',
      { type: 'setConfigParameter', parameter: { ...widthParam, id: 'cp#3', name: 'Again' } },
      'duplicate',
    ],
    [
      'a parameter for a missing variable',
      {
        type: 'setConfigParameter',
        parameter: { id: 'cp#3', name: 'Depth', kind: 'variable', variable: 'depth' },
      },
      'unknown-variable',
    ],
    [
      'a parameter for a missing feature',
      {
        type: 'setConfigParameter',
        parameter: { ...filletParam, id: 'cp#3', name: 'X', featureId: 'chamfer#1' },
      },
      'dependency',
    ],
    [
      'a parameter for a missing part',
      {
        type: 'setConfigParameter',
        parameter: { ...filletParam, id: 'cp#3', name: 'X', partId: 'part#7' },
      },
      'dependency',
    ],
    [
      'a parameter changed to another kind while rows hold its values',
      {
        type: 'setConfigParameter',
        parameter: { ...filletParam, id: 'cp#1', name: 'Cut', featureId: 'extrude#2' },
      },
      'kind-mismatch',
    ],
    [
      'a malformed row id',
      { type: 'setConfigRow', row: { id: 'row#3', name: 'X', values: {} } },
      'schema',
    ],
  ];

  it.each(cases)('refuses %s', (_label, command, code) => {
    refused(shelf(), command, code);
  });

  it('refuses a loaded table with unallocated ids or a dangling active row', () => {
    const doc = shelf();
    const table = doc.configurations!;
    const codes = (d: ManufaktureDocument) => validateDocument(d).map((e) => e.code);
    expect(codes({ ...doc, nextIds: { part: 2, cp: 2, cfg: 3 } })).toEqual(['invalid-id']);
    expect(codes({ ...doc, nextIds: { part: 2, cp: 3 } })).toEqual(['invalid-id', 'invalid-id']);
    expect(codes({ ...doc, configurations: { ...table, active: 'cfg#9' } })).toEqual(['not-found']);
  });
});

describe('uses of configured variables and features', () => {
  it('lists parameters and row values as uses of a variable', () => {
    const doc = shelf();
    expect(
      variableUses(doc, 'width').filter((u) => u.kind === 'parameter' || u.kind === 'row'),
    ).toEqual([{ kind: 'parameter', parameterId: 'cp#1' }]);
    expect(variableUses(doc, 'thickness').filter((u) => u.kind === 'row')).toEqual([
      { kind: 'row', rowId: 'cfg#2', parameterId: 'cp#1' },
    ]);
    expect(variableUsers(doc, 'width')).toContain('cp#1');
    expect(variableUsers(doc, 'thickness')).toContain('cfg#2');
  });

  it('refuses to delete a variable a parameter configures or a row value reads', () => {
    const doc = shelf();
    expect(
      refused(doc, { type: 'deleteVariable', name: 'width' }, 'variable-in-use').blockers,
    ).toContain('cp#1');
    // Only the row reads it: a variable of its own, used nowhere else.
    const lone = applied(doc, {
      type: 'batch',
      commands: [
        { type: 'setVariable', name: 'gap', expression: mm('3') },
        { type: 'setConfigRow', row: { ...wide, values: { 'cp#1': mm('#gap * 20') } } },
      ],
    });
    expect(
      refused(lone, { type: 'deleteVariable', name: 'gap' }, 'variable-in-use').blockers,
    ).toEqual(['cfg#2']);
  });

  it('refuses to delete a feature a suppression parameter names, unless the parameter goes too', () => {
    const doc = shelf();
    const error = refused(
      doc,
      { type: 'deleteFeature', partId: PART, featureId: 'fillet#1' },
      'dependency',
    );
    expect(error.blockers).toEqual(['cp#2']);
    const r = unwrap(
      applyCommand(doc, {
        type: 'batch',
        commands: [
          { type: 'deleteConfigParameter', parameterId: 'cp#2' },
          { type: 'deleteFeature', partId: PART, featureId: 'fillet#1' },
        ],
      }),
    );
    expect(r.document.configurations!.rows[0]!.values).toEqual({ 'cp#1': mm('30') });
    expect(applied(r.document, r.inverse)).toEqual(doc);
  });

  it('renames a configured variable everywhere, parameters and row values included', () => {
    const doc = withActive(shelf(), 'cfg#2');
    const renamed = applied(doc, unwrap(renameVariable(doc, 'width', 'span')));
    expect(renamed.configurations!.parameters[0]).toEqual({ ...widthParam, variable: 'span' });
    expect(variable(renamed, 'height')).toBe('#span / 2');
    const thick = applied(renamed, unwrap(renameVariable(renamed, 'thickness', 'plate')));
    expect(thick.configurations!.rows[1]!.values['cp#1']).toEqual(mm('2 * #plate + 50'));
    expect(variable(unwrap(configured(thick)), 'span')).toBe('2 * #plate + 50');
    expect(validateDocument(thick)).toEqual([]);
  });

  it('inlines a variable a row value reads, and one a parameter configures', () => {
    const doc = shelf();
    const noThickness = applied(doc, unwrap(inlineVariable(doc, 'thickness', '6mm')));
    expect(noThickness.configurations!.rows[1]!.values['cp#1']).toEqual(mm('2 * (6mm) + 50'));
    // Inlining the configured variable deletes its parameter and the rows' values for it.
    const r = unwrap(applyCommand(doc, unwrap(inlineVariable(doc, 'width', '40'))));
    expect(r.document.variables.map((v) => v.name)).toEqual(['thickness', 'height']);
    expect(r.document.configurations!.parameters).toEqual([filletParam]);
    expect(r.document.configurations!.rows.map((row) => row.values)).toEqual([
      { 'cp#2': true },
      {},
    ]);
    expect(applied(r.document, r.inverse)).toEqual(doc);
  });
});

describe('changes of the active configuration', () => {
  it('reports switching rows like a variable edit and a suppression', () => {
    const doc = shelf();
    const change = diffDocuments(doc, withActive(doc, 'cfg#1'));
    expect(change.configurationsChanged).toBe(true);
    expect(change.variables.changed).toEqual(['width']);
    expect(change.parts).toHaveLength(1);
    expect(change.parts[0]).toMatchObject({
      partId: PART,
      changed: ['fillet#1'],
      // sketch#1 reads width (and height, which reads width).
      firstAffectedIndex: 0,
    });
    // From one row to another: width changes; the fillet goes back to unsuppressed.
    const back = diffDocuments(withActive(doc, 'cfg#1'), withActive(doc, 'cfg#2'));
    expect(back.variables.changed).toEqual(['width']);
    expect(back.parts[0]).toMatchObject({ changed: ['fillet#1'], firstAffectedIndex: 0 });
  });

  it('reports an edit of the active row values, and nothing geometric for an inactive row', () => {
    const doc = withActive(shelf(), 'cfg#1');
    const edit = (row: ConfigRow) =>
      diffDocuments(doc, applied(doc, { type: 'setConfigRow', row }));
    const fillet = edit({ ...narrow, values: { 'cp#1': mm('30'), 'cp#2': false } });
    expect(fillet.variables.changed).toEqual([]);
    expect(fillet.parts[0]).toMatchObject({ changed: ['fillet#1'], firstAffectedIndex: 4 });
    const inactive = edit({ ...wide, values: { 'cp#1': mm('90') } });
    expect(inactive.configurationsChanged).toBe(true);
    expect(inactive.empty).toBe(false);
    expect(inactive.variables.changed).toEqual([]);
    expect(inactive.parts).toEqual([]);
    // A base edit hidden by the active row is still reported, for a build of the stored document.
    const base = diffDocuments(
      doc,
      applied(doc, { type: 'setVariable', name: 'width', expression: mm('45') }),
    );
    expect(base.variables.changed).toEqual(['width']);
    expect(base.parts[0]!.firstAffectedIndex).toBe(0);
  });
});

describe('saving configurations', () => {
  it('round-trips a table, with row values in canonical key order', () => {
    const doc = withActive(shelf(), 'cfg#1');
    const text = serialize(doc);
    expect(unwrap(deserialize(text)).document).toEqual(doc);
    const reordered: ManufaktureDocument = {
      ...doc,
      configurations: {
        ...doc.configurations!,
        rows: [{ ...narrow, values: { 'cp#2': true, 'cp#1': mm('30') } }, wide],
      },
    };
    expect(serialize(reordered)).toBe(text);
    const json = JSON.parse(text) as Record<string, unknown>;
    expect(Object.keys(json)).toEqual([
      'format',
      'version',
      'namingScheme',
      'id',
      'name',
      'units',
      'variables',
      'parts',
      'assemblies',
      'print',
      'configurations',
      'nextIds',
    ]);
  });
});
