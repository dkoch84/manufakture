import { describe, expect, it } from 'vitest';
import { diffDocuments } from './changes';
import {
  CommandSchema,
  applyCommand,
  partPrintItems,
  restoredDocument,
  variablePrintSetups,
  variableUsers,
  type Command,
} from './commands';
import { createPrintSetup } from './document';
import { deserialize, serialize } from './format';
import {
  printItemExpressions,
  printItemIds,
  printSetupExpressions,
  printSetupIds,
  printThresholdExpressions,
} from './features';
import type { CoreErrorCode } from './result';
import {
  DocumentSchema,
  PrintDataSchema,
  PrintItemSchema,
  PrintSetupSchema,
  type ManufaktureDocument,
  type PrintItem,
  type PrintSetup,
} from './schema';
import { DocumentStore } from './store';
import { validateDocument } from './validate';
import { inlineVariable, renameVariable, variableUses } from './variables';
import { PART, bracket, clone, deepFreeze, mm, unwrap } from './test-helpers';

/** Print setups (format v8, ADR 0012): schema, validation, commands, variables, changes. */

const S = 'print#1';
const deg = (source: string) => ({ source, lengthUnit: 'mm', angleUnit: 'deg' }) as const;

function apply(doc: ManufaktureDocument, command: Command) {
  return unwrap(applyCommand(doc, command));
}

function refused(doc: ManufaktureDocument, command: Command, code: CoreErrorCode) {
  const r = applyCommand(doc, command);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error.code).toBe(code);
  return r.ok ? undefined : r.error;
}

/** The print setups, without the counters, which undo never moves back. */
function setups(doc: ManufaktureDocument) {
  return doc.print.setups;
}

/**
 * Applies `command`, then its inverse, then the inverse of that: undo gives back the setups and
 * the parts, with the counters where `command` left them, and redo gives back the result.
 */
function roundTrip(doc: ManufaktureDocument, command: Command): ManufaktureDocument {
  const done = apply(doc, command);
  const undone = apply(done.document, done.inverse);
  expect(setups(undone.document)).toEqual(setups(doc));
  expect(undone.document.parts).toEqual(doc.parts);
  expect(undone.document.print.nextIds).toEqual(done.document.print.nextIds);
  const redone = apply(undone.document, undone.inverse);
  expect(redone.document.print).toEqual(done.document.print);
  return done.document;
}

function item(id: string, extra: Partial<PrintItem> = {}): PrintItem {
  return { id, part: PART, orientation: { kind: 'asModelled' }, ...extra };
}

const LAY_FLAT: PrintItem['orientation'] = {
  kind: 'layFlat',
  face: { id: 'r1', ref: { face: 'extrude#1:cap:start' } },
  turn: deg('90'),
};

function setup(extra: Partial<PrintSetup> = {}): PrintSetup {
  return { ...createPrintSetup(S, 'Plate 1', 'bambu-a1-mini', 0.4), ...extra };
}

/**
 * The bracket with a setup: item#1 lays body extrude#1 flat on its start cap, turned 90 degrees;
 * item#2 is the whole part as modelled, three copies. Thresholds read `thickness`.
 */
function printed(): ManufaktureDocument {
  let doc = apply(bracket(), {
    type: 'setVariable',
    name: 'angle',
    expression: deg('50'),
  }).document;
  doc = apply(doc, {
    type: 'addPrintSetup',
    setup: setup({
      thresholds: { overhang: deg('angle + 5'), minWall: mm('thickness / 6') },
      items: [
        item('item#1', { body: 'extrude#1', orientation: LAY_FLAT }),
        item('item#2', { copies: 3 }),
      ],
    }),
  }).document;
  return doc;
}

describe('schema', () => {
  const ok = (value: unknown) => PrintSetupSchema.safeParse(value).success;

  it('accepts setups with every orientation and some thresholds', () => {
    expect(ok(setup())).toBe(true);
    expect(
      ok(
        setup({
          thresholds: { teardrop: mm('5') },
          items: [
            item('item#1'),
            item('item#2', { body: 'pattern#2:i3', orientation: LAY_FLAT, copies: 1000 }),
            item('item#3', {
              orientation: { kind: 'layFlat', face: { id: 'r2#a', ref: { face: 'x' } } },
            }),
            item('item#4', {
              body: 'derived#1:from/extrude#1',
              orientation: { kind: 'rotate', x: deg('90'), y: deg('0'), z: deg('-45') },
            }),
          ],
        }),
      ),
    ).toBe(true);
    expect(PrintDataSchema.safeParse({ setups: [], nextIds: {} }).success).toBe(true);
  });

  const refusedSetups: [string, unknown][] = [
    ['a setup id of another counter', setup({ id: 'setup#1' })],
    ['a setup id with too many digits', setup({ id: `print#${'9'.repeat(16)}` })],
    ['an empty name', setup({ name: '  ' })],
    ['a printer id with spaces and capitals', setup({ printer: 'Bambu A1' })],
    ['an empty printer id', setup({ printer: '' })],
    ['a printer id that is too long', setup({ printer: 'a'.repeat(65) })],
    ['a zero nozzle', setup({ nozzle: 0 })],
    ['a negative nozzle', setup({ nozzle: -0.4 })],
    ['an absurd nozzle', setup({ nozzle: 11 })],
    ['a nozzle that is not a number', { ...setup(), nozzle: '0.4' }],
    ['empty thresholds', setup({ thresholds: {} })],
    ['an unknown threshold', { ...setup(), thresholds: { brim: mm('5') } }],
    ['a threshold that is a number', { ...setup(), thresholds: { minWall: 0.8 } }],
    ['an unknown key', { ...setup(), plate: 1 }],
    ['no items list', (({ items: _i, ...rest }) => (void _i, rest))(setup())],
  ];

  it.each(refusedSetups)('refuses %s', (_label, value) => {
    expect(ok(value)).toBe(false);
  });

  const itemOk = (value: unknown) => PrintItemSchema.safeParse(value).success;
  const refusedItems: [string, unknown][] = [
    ['an item id of another counter', item('inst#1')],
    ['an empty part', item('item#1', { part: '' })],
    ['a body that is not a body id', item('item#1', { body: 'Body 1' })],
    ['an empty body', item('item#1', { body: '' })],
    ['no orientation', (({ orientation: _o, ...rest }) => (void _o, rest))(item('item#1'))],
    ['an unknown orientation', { ...item('item#1'), orientation: { kind: 'upsideDown' } }],
    ['a lay-flat with no face', { ...item('item#1'), orientation: { kind: 'layFlat' } }],
    [
      'a lay-flat on an edge',
      {
        ...item('item#1'),
        orientation: { kind: 'layFlat', face: { id: 'r1', ref: { faces: ['a', 'b'] } } },
      },
    ],
    [
      'a lay-flat face with a bad reference id',
      {
        ...item('item#1'),
        orientation: { kind: 'layFlat', face: { id: 'e1', ref: { face: 'a' } } },
      },
    ],
    [
      'a rotation with an axis missing',
      { ...item('item#1'), orientation: { kind: 'rotate', x: deg('1'), y: deg('2') } },
    ],
    [
      'an as-modelled orientation with an angle',
      { ...item('item#1'), orientation: { kind: 'asModelled', turn: deg('1') } },
    ],
    ['zero copies', item('item#1', { copies: 0 })],
    ['fractional copies', item('item#1', { copies: 1.5 })],
    ['too many copies', item('item#1', { copies: 1001 })],
    ['an unknown key', { ...item('item#1'), colour: '#ffffff' }],
  ];

  it.each(refusedItems)('refuses an item with %s', (_label, value) => {
    expect(itemOk(value)).toBe(false);
  });

  it('requires the print section in a version 8 document', () => {
    const { print: _print, ...rest } = bracket();
    void _print;
    expect(DocumentSchema.safeParse(rest).success).toBe(false);
  });
});

describe('validation', () => {
  it('accepts a printer the table does not know and bodies and faces that do not exist', () => {
    const doc = clone(printed());
    const s = doc.print.setups[0]!;
    s.printer = 'printer-from-the-future';
    s.items[0]!.body = 'extrude#99';
    s.items[0]!.orientation = {
      kind: 'layFlat',
      face: { id: 'r1', ref: { face: 'nothing#7:cap:end' } },
    };
    expect(validateDocument(doc)).toEqual([]);
    expect(unwrap(deserialize(serialize(doc))).document).toEqual(doc);
  });

  const broken: [string, (doc: ManufaktureDocument) => void, CoreErrorCode, unknown[]][] = [
    [
      'an item of a part that does not exist',
      (d) => (d.print.setups[0]!.items[1]!.part = 'part#9'),
      'dependency',
      ['print', 'setups', 0, 'items', 1, 'part'],
    ],
    [
      'a setup id never allocated',
      (d) => (d.print.setups[0]!.id = 'print#2'),
      'invalid-id',
      ['print', 'setups', 0, 'id'],
    ],
    [
      'an item id never allocated',
      (d) => (d.print.setups[0]!.items[1]!.id = 'item#3'),
      'invalid-id',
      ['print', 'setups', 0, 'items', 1, 'id'],
    ],
    [
      'a reference id never allocated',
      (d) => {
        const o = d.print.setups[0]!.items[0]!.orientation;
        if (o.kind === 'layFlat') o.face.id = 'r2';
      },
      'invalid-id',
      ['print', 'setups', 0, 'items', 0, 'orientation', 'face', 'id'],
    ],
    [
      'a split reference id',
      (d) => {
        const o = d.print.setups[0]!.items[0]!.orientation;
        if (o.kind === 'layFlat') o.face.id = 'r1#a';
      },
      'invalid-id',
      ['print', 'setups', 0, 'items', 0, 'orientation', 'face', 'id'],
    ],
    [
      'an item id used twice, across setups',
      (d) => {
        d.print.nextIds.print = 3;
        d.print.setups.push({
          ...clone(d.print.setups[0]!),
          id: 'print#2',
          items: [item('item#2')],
        });
      },
      'duplicate',
      ['print', 'setups', 1, 'items', 0, 'id'],
    ],
    [
      'a threshold naming an unknown variable',
      (d) => (d.print.setups[0]!.thresholds = { minGap: mm('nope * 2') }),
      'unknown-variable',
      ['print', 'setups', 0, 'thresholds', 'minGap', 'source'],
    ],
    [
      'an orientation angle that does not parse',
      (d) =>
        (d.print.setups[0]!.items[1]!.orientation = {
          kind: 'rotate',
          x: deg('0'),
          y: deg('(('),
          z: deg('0'),
        }),
      'expression',
      ['print', 'setups', 0, 'items', 1, 'orientation', 'y', 'source'],
    ],
  ];

  it.each(broken)('reports %s', (_label, change, code, path) => {
    const doc = clone(printed());
    change(doc);
    const issues = validateDocument(doc);
    expect(issues.map((i) => [i.code, i.path])).toContainEqual([code, path]);
    const r = deserialize(JSON.stringify(doc));
    expect(r.ok).toBe(false);
  });
});

describe('commands', () => {
  it('parses every print command', () => {
    const commands: Command[] = [
      { type: 'addPrintSetup', setup: setup() },
      { type: 'editPrintSetup', setupId: S, nozzle: 0.6, thresholds: null },
      { type: 'deletePrintSetup', setupId: S },
      { type: 'restorePrintSetup', setup: setup(), index: 0 },
      { type: 'addPrintItem', setupId: S, item: item('item#1'), index: 0 },
      { type: 'editPrintItem', setupId: S, item: item('item#1') },
      { type: 'deletePrintItem', setupId: S, itemId: 'item#1' },
      { type: 'restorePrintItem', setupId: S, item: item('item#1'), index: 0 },
    ];
    for (const c of commands) expect(CommandSchema.safeParse(c).success).toBe(true);
    expect(
      CommandSchema.safeParse({ type: 'editPrintSetup', setupId: S, printer: 'Not An Id' }).success,
    ).toBe(false);
  });

  it('adds a setup with its items, allocating every id, and undoes it', () => {
    const base = bracket();
    const doc = roundTrip(base, {
      type: 'addPrintSetup',
      setup: setup({ items: [item('item#1', { orientation: LAY_FLAT }), item('item#4')] }),
    });
    expect(doc.print.setups.map((s) => s.id)).toEqual([S]);
    expect(doc.print.nextIds).toEqual({ print: 2, item: 5, r: 2 });
    // Print reference ids are their own namespace: the part's `r` counter does not move.
    expect(doc.parts).toEqual(base.parts);
  });

  it('places a setup at an index, and refuses one past the end', () => {
    const doc = printed();
    const two = apply(doc, {
      type: 'addPrintSetup',
      setup: setup({ id: 'print#2', name: 'First' }),
      index: 0,
    }).document;
    expect(two.print.setups.map((s) => s.id)).toEqual(['print#2', S]);
    refused(
      doc,
      { type: 'addPrintSetup', setup: setup({ id: 'print#3' }), index: 5 },
      'invalid-index',
    );
  });

  it('never reuses an id, even once the setup or item is gone', () => {
    const doc = printed();
    refused(doc, { type: 'addPrintSetup', setup: setup() }, 'duplicate');
    const gone = apply(doc, { type: 'deletePrintSetup', setupId: S }).document;
    expect(gone.print.setups).toEqual([]);
    refused(gone, { type: 'addPrintSetup', setup: setup() }, 'id-reused');
    refused(
      gone,
      { type: 'addPrintSetup', setup: setup({ id: 'print#2', items: [item('item#2')] }) },
      'id-reused',
    );
    const noItem = apply(doc, { type: 'deletePrintItem', setupId: S, itemId: 'item#2' }).document;
    refused(noItem, { type: 'addPrintItem', setupId: S, item: item('item#2') }, 'id-reused');
    refused(
      noItem,
      { type: 'restorePrintItem', setupId: S, item: item('item#3'), index: 1 },
      'invalid-id',
    );
  });

  it('edits a setup field by field, and undoes each', () => {
    const doc = printed();
    const renamed = roundTrip(doc, { type: 'editPrintSetup', setupId: S, name: '  Plate A ' });
    expect(renamed.print.setups[0]!.name).toBe('Plate A');
    const moved = roundTrip(doc, {
      type: 'editPrintSetup',
      setupId: S,
      printer: 'bambu-x1c',
      nozzle: 0.6,
    });
    expect(moved.print.setups[0]).toMatchObject({ printer: 'bambu-x1c', nozzle: 0.6 });
    const defaults = roundTrip(doc, { type: 'editPrintSetup', setupId: S, thresholds: null });
    expect('thresholds' in defaults.print.setups[0]!).toBe(false);
    const set = roundTrip(defaults, {
      type: 'editPrintSetup',
      setupId: S,
      thresholds: { minHole: mm('2') },
    });
    expect(set.print.setups[0]!.thresholds).toEqual({ minHole: mm('2') });
    refused(doc, { type: 'editPrintSetup', setupId: S, name: ' ' }, 'invalid-name');
    refused(doc, { type: 'editPrintSetup', setupId: 'print#9', name: 'x' }, 'not-found');
  });

  it('deletes a setup with its items and puts it back where it was', () => {
    let doc = printed();
    doc = apply(doc, { type: 'addPrintSetup', setup: setup({ id: 'print#2' }) }).document;
    const gone = roundTrip(doc, { type: 'deletePrintSetup', setupId: S });
    expect(gone.print.setups.map((s) => s.id)).toEqual(['print#2']);
    refused(doc, { type: 'deletePrintSetup', setupId: 'print#7' }, 'not-found');
  });

  it('adds, edits and deletes items, and undoes each', () => {
    const doc = printed();
    const added = roundTrip(doc, {
      type: 'addPrintItem',
      setupId: S,
      item: item('item#3', {
        orientation: { kind: 'layFlat', face: { id: 'r2', ref: { face: 'extrude#1:cap:end' } } },
      }),
      index: 0,
    });
    expect(added.print.setups[0]!.items.map((i) => i.id)).toEqual(['item#3', 'item#1', 'item#2']);
    expect(added.print.nextIds).toMatchObject({ item: 4, r: 3 });

    const edited = roundTrip(doc, {
      type: 'editPrintItem',
      setupId: S,
      item: item('item#2', { body: 'extrude#1', copies: 2 }),
    });
    expect(edited.print.setups[0]!.items[1]).toEqual(
      item('item#2', { body: 'extrude#1', copies: 2 }),
    );

    const deleted = roundTrip(doc, { type: 'deletePrintItem', setupId: S, itemId: 'item#1' });
    expect(deleted.print.setups[0]!.items.map((i) => i.id)).toEqual(['item#2']);

    refused(doc, { type: 'deletePrintItem', setupId: S, itemId: 'item#9' }, 'not-found');
    refused(doc, { type: 'addPrintItem', setupId: 'print#9', item: item('item#3') }, 'not-found');
    refused(doc, { type: 'addPrintItem', setupId: S, item: item('item#1') }, 'duplicate');
  });

  it('re-picking a face takes a fresh reference id and never reuses the old one', () => {
    const doc = printed();
    const repick = (id: string): Command => ({
      type: 'editPrintItem',
      setupId: S,
      item: item('item#1', {
        body: 'extrude#1',
        orientation: { kind: 'layFlat', face: { id, ref: { face: 'extrude#1:side:e1' } } },
      }),
    });
    const fresh = roundTrip(doc, repick('r2'));
    expect(fresh.print.nextIds.r).toBe(3);
    // Keeping the id is fine; an id from the past or the future that this item never had is not.
    apply(doc, repick('r1'));
    const moved = apply(fresh, repick('r3')).document;
    refused(moved, repick('r2'), 'id-reused');
    refused(doc, repick('r1#a'), 'invalid-id');
  });

  it('refuses an item of a part that does not exist', () => {
    refused(
      printed(),
      { type: 'addPrintItem', setupId: S, item: item('item#3', { part: 'part#9' }) },
      'dependency',
    );
  });

  it('never blocks modelling: deleting or suppressing what an item names is allowed', () => {
    const doc = printed();
    // Every feature, newest first, including extrude#1 that item#1's body and face come from.
    const ids = doc.parts[0]!.features.map((f) => f.id).reverse();
    const empty = apply(doc, {
      type: 'batch',
      commands: ids.map((featureId) => ({ type: 'deleteFeature', partId: PART, featureId })),
    }).document;
    expect(empty.parts[0]!.features).toEqual([]);
    expect(empty.print).toEqual(doc.print);
    expect(validateDocument(empty)).toEqual([]);
    apply(doc, { type: 'suppressFeature', partId: PART, featureId: 'extrude#1', suppressed: true });
    apply(doc, { type: 'deleteFeature', partId: PART, featureId: 'fillet#1' });
    apply(doc, {
      type: 'editFeature',
      partId: PART,
      feature: { ...doc.parts[0]!.features[1]!, name: 'Base' },
    });
  });

  it('refuses to delete a part that a print item prints, naming the items', () => {
    let doc = printed();
    doc = apply(doc, { type: 'addPart', partId: 'part#2', name: 'Lid' }).document;
    doc = apply(doc, {
      type: 'addPrintItem',
      setupId: S,
      item: item('item#3', { part: 'part#2' }),
    }).document;
    expect(partPrintItems(doc, PART)).toEqual([`${S}/item#1`, `${S}/item#2`]);
    const error = refused(doc, { type: 'deletePart', partId: 'part#2' }, 'dependency');
    expect(error?.blockers).toEqual([`${S}/item#3`]);
    expect(error?.message).toMatch(/print item print#1\/item#3 prints it/);
    const freed = apply(doc, { type: 'deletePrintItem', setupId: S, itemId: 'item#3' }).document;
    apply(freed, { type: 'deletePart', partId: 'part#2' });
  });

  it('keeps the higher print counters when a document is restored', () => {
    const past = printed();
    const current = apply(past, { type: 'deletePrintSetup', setupId: S }).document;
    const later = apply(current, {
      type: 'addPrintSetup',
      setup: setup({ id: 'print#4', items: [item('item#7')] }),
    }).document;
    const restored = restoredDocument(later, past);
    expect(restored.print.setups).toEqual(past.print.setups);
    expect(restored.print.nextIds).toEqual({ print: 5, item: 8, r: 2 });
    apply(later, { type: 'replaceDocument', document: restored });
  });

  it('never modifies the document it is given', () => {
    const doc = deepFreeze(printed());
    const commands: Command[] = [
      { type: 'editPrintSetup', setupId: S, thresholds: { minGap: mm('0.3') } },
      { type: 'deletePrintItem', setupId: S, itemId: 'item#1' },
      { type: 'editPrintItem', setupId: S, item: item('item#2', { copies: 9 }) },
      { type: 'deletePrintSetup', setupId: S },
    ];
    for (const c of commands) apply(doc, c);
  });
});

describe('variables', () => {
  it('lists print expressions with the setup, the item and the path', () => {
    const doc = printed();
    const s = doc.print.setups[0]!;
    expect(printSetupIds(s)).toEqual([S, 'item#1', 'r1', 'item#2']);
    expect(printItemIds(s.items[1]!)).toEqual(['item#2']);
    expect(printThresholdExpressions(s).map((x) => [x.path, x.expected])).toEqual([
      [['thresholds', 'overhang'], 'angle'],
      [['thresholds', 'minWall'], 'length'],
    ]);
    expect(printItemExpressions(s.items[0]!).map((x) => x.path)).toEqual([['orientation', 'turn']]);
    expect(
      printItemExpressions(
        item('item#9', { orientation: { kind: 'rotate', x: deg('1'), y: deg('2'), z: deg('3') } }),
      ).map((x) => [x.path, x.expected]),
    ).toEqual([
      [['orientation', 'x'], 'angle'],
      [['orientation', 'y'], 'angle'],
      [['orientation', 'z'], 'angle'],
    ]);
    expect(printSetupExpressions(s).map((x) => x.path)).toEqual([
      ['thresholds', 'overhang'],
      ['thresholds', 'minWall'],
      ['items', 0, 'orientation', 'turn'],
    ]);
  });

  it('counts print uses, and refuses to delete a variable a threshold reads', () => {
    let doc = printed();
    doc = apply(doc, {
      type: 'editPrintItem',
      setupId: S,
      item: {
        ...doc.print.setups[0]!.items[0]!,
        orientation: { ...LAY_FLAT, turn: deg('angle * 2') },
      },
    }).document;
    expect(variableUses(doc, 'angle')).toEqual([
      { kind: 'print', setupId: S, path: ['thresholds', 'overhang'], expected: 'angle' },
      {
        kind: 'print',
        setupId: S,
        itemId: 'item#1',
        path: ['items', 0, 'orientation', 'turn'],
        expected: 'angle',
      },
    ]);
    expect(variablePrintSetups(doc, 'angle').map((s) => s.id)).toEqual([S]);
    expect(variableUsers(doc, 'angle')).toEqual([S]);
    expect(variableUsers(doc, 'thickness')).toContain(S);
    const error = refused(doc, { type: 'deleteVariable', name: 'angle' }, 'variable-in-use');
    expect(error?.blockers).toEqual([S]);
  });

  it('renames a variable in thresholds and orientations, as one undo step', () => {
    let doc = printed();
    doc = apply(doc, {
      type: 'editPrintItem',
      setupId: S,
      item: item('item#2', {
        orientation: { kind: 'rotate', x: deg('angle'), y: deg('0'), z: deg('-angle') },
      }),
    }).document;
    const command = unwrap(renameVariable(doc, 'angle', 'tilt'));
    const done = apply(doc, command);
    const s = done.document.print.setups[0]!;
    expect(s.thresholds?.overhang).toEqual(deg('#tilt + 5'));
    expect(s.thresholds?.minWall).toEqual(mm('thickness / 6'));
    expect(s.items[1]!.orientation).toEqual({
      kind: 'rotate',
      x: deg('#tilt'),
      y: deg('0'),
      z: deg('-#tilt'),
    });
    expect(variableUses(done.document, 'angle')).toEqual([]);
    expect(apply(done.document, done.inverse).document).toEqual(doc);
  });

  it('inlines a variable into thresholds and orientations', () => {
    let doc = printed();
    doc = apply(doc, {
      type: 'editPrintItem',
      setupId: S,
      item: { ...doc.print.setups[0]!.items[0]!, orientation: { ...LAY_FLAT, turn: deg('angle') } },
    }).document;
    const done = apply(doc, unwrap(inlineVariable(doc, 'angle', '50 deg')));
    const s = done.document.print.setups[0]!;
    expect(s.thresholds?.overhang).toEqual(deg('(50 deg) + 5'));
    expect(s.items[0]!.orientation).toEqual({ ...LAY_FLAT, turn: deg('50 deg') });
    expect(done.document.variables.map((v) => v.name)).not.toContain('angle');
    expect(apply(done.document, done.inverse).document).toEqual(doc);
  });
});

describe('changes', () => {
  it('reports a print edit separately, never as a part change', () => {
    const doc = printed();
    const next = apply(doc, { type: 'editPrintSetup', setupId: S, nozzle: 0.2 }).document;
    const change = diffDocuments(doc, next);
    expect(change.empty).toBe(false);
    expect(change.printChanged).toBe(true);
    expect(change.print).toEqual({
      setups: { added: [], removed: [], changed: [S] },
      reordered: false,
    });
    expect(change.parts).toEqual([]);
    expect(change.assemblies).toEqual([]);
  });

  it('reports added, removed and reordered setups', () => {
    const doc = printed();
    const two = apply(doc, { type: 'addPrintSetup', setup: setup({ id: 'print#2' }) }).document;
    expect(diffDocuments(doc, two).print.setups.added).toEqual(['print#2']);
    expect(diffDocuments(two, doc).print.setups.removed).toEqual(['print#2']);
    const swapped = { ...two, print: { ...two.print, setups: [...two.print.setups].reverse() } };
    const change = diffDocuments(two, swapped);
    expect(change.print.reordered).toBe(true);
    expect(change.printChanged).toBe(true);
    expect(change.parts).toEqual([]);
  });

  it('marks a setup whose threshold reads a changed variable, and dirties no part', () => {
    const doc = printed();
    const next = apply(doc, { type: 'setVariable', name: 'angle', expression: deg('40') }).document;
    const change = diffDocuments(doc, next);
    expect(change.printChanged).toBe(true);
    expect(change.print.setups.changed).toEqual([S]);
    expect(change.variables.changed).toEqual(['angle']);
    expect(change.parts).toEqual([]);
  });

  it('reports no print change for a part edit, nor for nothing', () => {
    const doc = printed();
    const next = apply(doc, {
      type: 'renameFeature',
      partId: PART,
      featureId: 'fillet#1',
      name: 'Round',
    }).document;
    const change = diffDocuments(doc, next);
    expect(change.printChanged).toBe(false);
    expect(change.print.setups).toEqual({ added: [], removed: [], changed: [] });
    const none = diffDocuments(doc, doc);
    expect(none.empty).toBe(true);
    expect(none.printChanged).toBe(false);
  });

  it('carries print changes through the store, undo included', () => {
    const store = unwrap(DocumentStore.create(printed()));
    const change = unwrap(store.execute({ type: 'deletePrintItem', setupId: S, itemId: 'item#2' }));
    expect(change.printChanged).toBe(true);
    expect(change.parts).toEqual([]);
    const undo = unwrap(store.undo());
    expect(undo.printChanged).toBe(true);
    expect(undo.print.setups.changed).toEqual([S]);
  });
});

describe('saving', () => {
  it('round trips print setups, with the counters in canonical key order', () => {
    const doc = printed();
    const shuffled: ManufaktureDocument = {
      ...doc,
      print: { ...doc.print, nextIds: { r: 2, item: 3, print: 2 } },
    };
    const text = serialize(shuffled);
    expect(text).toBe(serialize(doc));
    const loaded = unwrap(deserialize(text));
    expect(loaded.document).toEqual(doc);
    expect(loaded.migrated).toBe(false);
    const json = JSON.parse(text) as { print: { nextIds: object } };
    expect(Object.keys(json.print.nextIds)).toEqual(['item', 'print', 'r']);
    expect(serialize(loaded.document)).toBe(text);
  });
});
