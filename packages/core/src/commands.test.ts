import { describe, expect, it } from 'vitest';
import { applyCommand, variableUsers, type Command } from './commands';
import { isFeatureActive } from './document';
import type { CoreErrorCode } from './result';
import type { ChamferFeature, Feature, ManufaktureDocument, SketchFeature } from './schema';
import { DocumentStore } from './store';
import {
  PART,
  bracket,
  clone,
  cornerFillet,
  deepFreeze,
  featureIds,
  mm,
  rectangleSketch,
  unwrap,
} from './test-helpers';

/** The bracket plus an unused variable, frozen so any mutation throws. */
function base(): ManufaktureDocument {
  const doc = unwrap(
    applyCommand(bracket(), { type: 'setVariable', name: 'spare', expression: mm('1') }),
  ).document;
  return deepFreeze(doc);
}

function chamfer(id = 'chamfer#1', refId = 'r3'): ChamferFeature {
  return {
    id,
    kind: 'chamfer',
    name: 'Chamfer 1',
    suppressed: false,
    edges: [{ id: refId, ref: { faces: ['extrude#1:cap:end', 'extrude#1:side:e3'] } }],
    distance: mm('1'),
  };
}

function sketch3(): SketchFeature {
  return {
    id: 'sketch#3',
    kind: 'sketch',
    name: 'Sketch 3',
    suppressed: false,
    plane: { type: 'plane', origin: [0, 0, 5], normal: [0, 0, 1], xDir: [0, 1, 0] },
    entities: [{ id: 'e6', kind: 'point', construction: true, position: [1, 2] }],
    constraints: [],
  };
}

const edit = (feature: Feature): Command => ({ type: 'editFeature', partId: PART, feature });

/**
 * The rectangle sketch with `e2` replaced by `pieces` (lines stacked along its length), and the
 * constraints on `e2` moved to the first piece.
 */
function splitSketch(pieces: string[]): SketchFeature {
  const s = clone(rectangleSketch());
  const step = 20 / pieces.length;
  s.entities.splice(
    1,
    1,
    ...pieces.map((id, i): SketchFeature['entities'][number] => ({
      id,
      kind: 'line',
      construction: false,
      start: [40, i * step],
      end: [40, (i + 1) * step],
    })),
  );
  s.constraints = JSON.parse(
    JSON.stringify(s.constraints).replaceAll('"entity":"e2"', `"entity":"${pieces[0]}"`),
  ) as SketchFeature['constraints'];
  return s;
}

const add = (feature: Feature, index?: number): Command =>
  index === undefined
    ? { type: 'addFeature', partId: PART, feature }
    : { type: 'addFeature', partId: PART, feature, index };

function expectError(
  doc: ManufaktureDocument,
  command: Command,
  code: CoreErrorCode,
  blockers?: string[],
) {
  const r = applyCommand(doc, command);
  expect(r.ok).toBe(false);
  if (r.ok) return;
  expect(r.error.code).toBe(
    r.error.code === code ? code : `${code} (got ${r.error.code}: ${r.error.message})`,
  );
  if (blockers) expect(r.error.blockers).toEqual(blockers);
}

function withoutCounters(doc: ManufaktureDocument) {
  return { ...doc, parts: doc.parts.map((p) => ({ ...p, nextIds: {} })) };
}

describe('undo and redo round trips', () => {
  const editedSketch = (): SketchFeature => {
    const s = clone(rectangleSketch());
    s.entities.push({ id: 'e6', kind: 'point', construction: true, position: [20, 10] });
    s.constraints = s.constraints.filter((c) => c.id !== 'k5');
    s.constraints.push({ id: 'k7', kind: 'fix', point: { entity: 'e6' } });
    return s;
  };

  const cases: [string, Command][] = [
    ['add a feature at the end', add(chamfer())],
    ['add a feature in the middle', add(sketch3(), 2)],
    ['add at index 0', add(sketch3(), 0)],
    [
      'edit an expression',
      { type: 'editFeature', partId: PART, feature: { ...cornerFillet(), radius: mm('3mm') } },
    ],
    [
      'edit a sketch: add and remove ids',
      { type: 'editFeature', partId: PART, feature: editedSketch() },
    ],
    ['delete the last feature', { type: 'deleteFeature', partId: PART, featureId: 'fillet#1' }],
    ['delete a middle feature', { type: 'deleteFeature', partId: PART, featureId: 'extrude#2' }],
    ['reorder down', { type: 'reorderFeature', partId: PART, featureId: 'fillet#1', index: 2 }],
    ['reorder up', { type: 'reorderFeature', partId: PART, featureId: 'extrude#2', index: 4 }],
    [
      'suppress',
      { type: 'suppressFeature', partId: PART, featureId: 'extrude#2', suppressed: true },
    ],
    [
      'rename',
      { type: 'renameFeature', partId: PART, featureId: 'fillet#1', name: 'Corner round' },
    ],
    ['roll back', { type: 'setRollback', partId: PART, index: 2 }],
    ['roll back to the start', { type: 'setRollback', partId: PART, index: 0 }],
    ['update a variable', { type: 'setVariable', name: 'thickness', expression: mm('8mm') }],
    [
      'create a variable first',
      { type: 'setVariable', name: 'margin', expression: mm('thickness / 2'), index: 0 },
    ],
    ['delete a variable', { type: 'deleteVariable', name: 'spare' }],
    [
      'change display units',
      {
        type: 'setDisplayUnits',
        units: { length: { unit: 'ft-in', denominator: 32 }, angle: { unit: 'rad' } },
      },
    ],
    ['rename the document', { type: 'renameDocument', name: 'Shelf bracket' }],
    [
      'batch',
      {
        type: 'batch',
        commands: [
          add(chamfer()),
          { type: 'renameFeature', partId: PART, featureId: 'chamfer#1', name: 'Edge break' },
          { type: 'reorderFeature', partId: PART, featureId: 'chamfer#1', index: 2 },
          { type: 'deleteFeature', partId: PART, featureId: 'fillet#1' },
          { type: 'setVariable', name: 'spare', expression: mm('2') },
        ],
      },
    ],
    [
      'nested batch',
      { type: 'batch', commands: [{ type: 'batch', commands: [add(sketch3())] }, add(chamfer())] },
    ],
  ];

  it.each(cases)('%s', (_label, command) => {
    const before = base();
    const done = unwrap(applyCommand(before, command));
    expect(done.document).not.toEqual(before);
    deepFreeze(done.document);

    // Undo: back to the original, except that counters never go back.
    const undone = unwrap(applyCommand(done.document, done.inverse));
    expect(withoutCounters(undone.document)).toEqual(withoutCounters(before));
    expect(undone.document.parts[0]!.nextIds).toEqual(done.document.parts[0]!.nextIds);
    deepFreeze(undone.document);

    // Redo: exactly the state after the command.
    const redone = unwrap(applyCommand(undone.document, undone.inverse));
    expect(redone.document).toEqual(done.document);

    // And again, through JSON: inverses are plain serializable data.
    const again = unwrap(
      applyCommand(redone.document, JSON.parse(JSON.stringify(redone.inverse)) as Command),
    );
    expect(withoutCounters(again.document)).toEqual(withoutCounters(before));
  });

  it('batch inverses run in reverse order', () => {
    const done = unwrap(
      applyCommand(base(), {
        type: 'batch',
        commands: [
          add(chamfer()),
          { type: 'renameFeature', partId: PART, featureId: 'chamfer#1', name: 'X' },
        ],
      }),
    );
    expect(done.inverse).toEqual({
      type: 'batch',
      commands: [
        { type: 'renameFeature', partId: PART, featureId: 'chamfer#1', name: 'Chamfer 1' },
        { type: 'deleteFeature', partId: PART, featureId: 'chamfer#1' },
      ],
    });
  });
});

describe('addFeature', () => {
  it('inserts at the rollback bar by default and moves the bar past it', () => {
    const rolled = unwrap(
      applyCommand(base(), { type: 'setRollback', partId: PART, index: 2 }),
    ).document;
    const doc = unwrap(applyCommand(rolled, add(sketch3()))).document;
    expect(featureIds(doc)).toEqual([
      'sketch#1',
      'extrude#1',
      'sketch#3',
      'sketch#2',
      'extrude#2',
      'fillet#1',
    ]);
    expect(doc.parts[0]!.rollbackIndex).toBe(3);
  });

  it.each([
    [null, 5, null],
    [null, 0, null],
    [2, 2, 3],
    [2, 1, 3],
    [2, 3, 2],
    [0, 0, 1],
  ])('rollback %s, insert at %s -> rollback %s', (rollback, at, expected) => {
    const rolled = unwrap(
      applyCommand(base(), { type: 'setRollback', partId: PART, index: rollback }),
    ).document;
    const doc = unwrap(applyCommand(rolled, add(sketch3(), at))).document;
    expect(doc.parts[0]!.rollbackIndex).toBe(expected);
  });

  it('allocates every id it introduces', () => {
    const doc = unwrap(applyCommand(base(), add(chamfer()))).document;
    expect(doc.parts[0]!.nextIds).toMatchObject({ chamfer: 2, r: 4, e: 6, k: 7 });
  });

  it('accepts ids past the counter and moves the counter beyond them', () => {
    const doc = unwrap(applyCommand(base(), add(chamfer('chamfer#7', 'r10')))).document;
    expect(doc.parts[0]!.nextIds).toMatchObject({ chamfer: 8, r: 11 });
  });

  it('never reuses the id of a deleted feature', () => {
    const deleted = unwrap(
      applyCommand(base(), { type: 'deleteFeature', partId: PART, featureId: 'fillet#1' }),
    ).document;
    expectError(deleted, add(cornerFillet()), 'id-reused', ['fillet#1']);
    expectError(
      deleted,
      add({
        ...cornerFillet(),
        id: 'fillet#2',
        edges: [{ id: 'r2', ref: { faces: ['extrude#1:cap:end'] } }],
      }),
      'id-reused',
      ['r2'],
    );
    unwrap(
      applyCommand(
        deleted,
        add({
          ...cornerFillet(),
          id: 'fillet#2',
          edges: [{ id: 'r3', ref: { faces: ['extrude#1:cap:end'] } }],
        }),
      ),
    );
  });

  it.each<[string, Command, CoreErrorCode]>([
    ['an existing id', add(cornerFillet()), 'duplicate'],
    ['a reference id in use elsewhere', add(chamfer('chamfer#1', 'r1')), 'id-reused'],
    [
      'a split of a never allocated id',
      add({
        ...sketch3(),
        entities: [{ id: 'e9#a', kind: 'point', construction: false, position: [0, 0] }],
      }),
      'invalid-id',
    ],
    [
      'a split of an entity in another sketch',
      add({
        ...sketch3(),
        entities: [{ id: 'e5#a', kind: 'point', construction: false, position: [0, 0] }],
      }),
      'invalid-id',
    ],
    [
      'a split of an id that is its own',
      add({
        ...sketch3(),
        entities: [
          { id: 'e6', kind: 'point', construction: true, position: [1, 2] },
          { id: 'e6#a', kind: 'point', construction: false, position: [0, 0] },
        ],
      }),
      'invalid-id',
    ],
    ['an index past the end', add(chamfer(), 6), 'invalid-index'],
    ['a position before its dependency', add({ ...chamfer() }, 1), 'dependency'],
    ['a missing part', { type: 'addFeature', partId: 'part#9', feature: chamfer() }, 'not-found'],
    ['an unparsable expression', add({ ...chamfer(), distance: mm('1 +') }), 'expression'],
    ['an unknown variable', add({ ...chamfer(), distance: mm('depth') }), 'unknown-variable'],
    [
      'an invalid feature',
      { type: 'addFeature', partId: PART, feature: { ...chamfer(), edges: [] } } as Command,
      'schema',
    ],
    ['an unknown command', { type: 'explode' } as unknown as Command, 'schema'],
  ])('refuses %s', (_label, command, code) => {
    expectError(base(), command, code);
  });
});

describe('editFeature', () => {
  it('allocates new sub-ids and keeps the counters of removed ones', () => {
    const s = clone(rectangleSketch());
    s.entities.push({ id: 'e8', kind: 'point', construction: false, position: [5, 5] });
    const doc = unwrap(
      applyCommand(base(), { type: 'editFeature', partId: PART, feature: s }),
    ).document;
    expect(doc.parts[0]!.nextIds.e).toBe(9);

    // Removing e8 again and later bringing it back is a reuse.
    const removed = unwrap(
      applyCommand(doc, { type: 'editFeature', partId: PART, feature: rectangleSketch() }),
    ).document;
    expect(removed.parts[0]!.nextIds.e).toBe(9);
    expectError(removed, { type: 'editFeature', partId: PART, feature: s }, 'id-reused', ['e8']);
  });

  it('accepts a sketch split: e2 becomes e2#a and e2#b', () => {
    const s = splitSketch(['e2#a', 'e2#b']);
    expect(JSON.stringify(s.constraints)).toContain('e2#a');
    const doc = unwrap(applyCommand(base(), edit(s))).document;
    expect(doc.parts[0]!.nextIds.e).toBe(6);
  });

  it('accepts a nested split: e2#a becomes e2#a#a and e2#a#b', () => {
    const split = unwrap(applyCommand(base(), edit(splitSketch(['e2#a', 'e2#b'])))).document;
    const nested = splitSketch(['e2#a#a', 'e2#a#b', 'e2#b']);
    const doc = unwrap(applyCommand(split, edit(nested))).document;
    expect((doc.parts[0]!.features[0] as SketchFeature).entities.map((e) => e.id)).toEqual([
      'e1',
      'e2#a#a',
      'e2#a#b',
      'e2#b',
      'e3',
      'e4',
    ]);
    expect(doc.parts[0]!.nextIds.e).toBe(6);
  });

  it('refuses to create a split piece again after it was deleted', () => {
    const split = unwrap(applyCommand(base(), edit(splitSketch(['e2#a', 'e2#b'])))).document;
    const deleted = unwrap(applyCommand(split, edit(splitSketch(['e2#b'])))).document;
    expectError(deleted, edit(splitSketch(['e2#a', 'e2#b'])), 'invalid-id', ['e2#a']);
    // A nested piece of the deleted one is refused too.
    expectError(deleted, edit(splitSketch(['e2#a#a', 'e2#b'])), 'invalid-id', ['e2#a#a']);
  });

  it('refuses a split that skips a level or keeps the entity it splits', () => {
    expectError(base(), edit(splitSketch(['e2#a#a', 'e2#a#b'])), 'invalid-id', ['e2#a#a']);
    const kept = clone(rectangleSketch());
    kept.entities.push({ id: 'e2#a', kind: 'point', construction: false, position: [1, 1] });
    expectError(base(), edit(kept), 'invalid-id', ['e2#a']);
  });

  it('refuses to split an entity or reference that belongs to another feature', () => {
    // e5 lives in sketch#2.
    const s = clone(rectangleSketch());
    s.entities.push({ id: 'e5#a', kind: 'point', construction: false, position: [1, 1] });
    expectError(base(), edit(s), 'invalid-id', ['e5#a']);
    // r1 is sketch#2's plane reference.
    expectError(
      base(),
      edit({ ...cornerFillet(), edges: [{ ...cornerFillet().edges[0]!, id: 'r1#a' }] }),
      'invalid-id',
      ['r1#a'],
    );
  });

  it('undoes and redoes a split', () => {
    const before = base();
    const store = unwrap(DocumentStore.create(before));
    unwrap(store.execute(edit(splitSketch(['e2#a', 'e2#b'])), 'Split'));
    const split = store.document;
    unwrap(store.undo());
    expect(store.document.parts[0]!.features).toEqual(before.parts[0]!.features);
    unwrap(store.redo());
    expect(store.document).toEqual(split);
    // Splitting again after the undo gives the same names: e2 is back, so they are new pieces.
    unwrap(store.undo());
    unwrap(store.execute(edit(splitSketch(['e2#a', 'e2#b'])), 'Split again'));
    expect(store.document.parts[0]!.features).toEqual(split.parts[0]!.features);
  });

  it.each<[string, Feature, CoreErrorCode]>([
    ['a change of kind', { ...chamfer(), id: 'fillet#1' } as Feature, 'kind-mismatch'],
    ['a missing feature', chamfer(), 'not-found'],
    ['an unknown variable', { ...cornerFillet(), radius: mm('r') }, 'unknown-variable'],
    [
      'a reference to a later feature',
      { ...cornerFillet(), edges: [{ id: 'r2', ref: { faces: ['chamfer#1:x'] } }] },
      'dependency',
    ],
  ])('refuses %s', (_label, feature, code) => {
    expectError(base(), { type: 'editFeature', partId: PART, feature }, code);
  });

  it('refuses a sketch edit that breaks its own constraints', () => {
    const s = clone(rectangleSketch());
    s.entities = s.entities.filter((e) => e.id !== 'e1');
    expectError(base(), { type: 'editFeature', partId: PART, feature: s }, 'sketch', ['e1']);
  });
});

describe('deleteFeature', () => {
  it.each([
    ['sketch#1', ['extrude#1']],
    ['extrude#1', ['sketch#2', 'fillet#1']],
    ['sketch#2', ['extrude#2']],
  ])('refuses to delete %s while %j depend on it', (id, blockers) => {
    expectError(
      base(),
      { type: 'deleteFeature', partId: PART, featureId: id },
      'dependency',
      blockers,
    );
  });

  it.each([
    [null, 'fillet#1', null],
    [5, 'fillet#1', 4],
    [4, 'fillet#1', 4],
    [4, 'extrude#2', 3],
    [3, 'extrude#2', 3],
  ])('rollback %s, delete %s -> rollback %s', (rollback, id, expected) => {
    const rolled = unwrap(
      applyCommand(base(), { type: 'setRollback', partId: PART, index: rollback }),
    ).document;
    const done = unwrap(
      applyCommand(rolled, { type: 'deleteFeature', partId: PART, featureId: id }),
    );
    expect(done.document.parts[0]!.rollbackIndex).toBe(expected);
    expect(unwrap(applyCommand(done.document, done.inverse)).document.parts[0]!.rollbackIndex).toBe(
      rollback,
    );
  });

  it('deletes a dependency chain from the end', () => {
    let doc = base();
    for (const id of ['fillet#1', 'extrude#2', 'sketch#2', 'extrude#1', 'sketch#1']) {
      doc = unwrap(
        applyCommand(doc, { type: 'deleteFeature', partId: PART, featureId: id }),
      ).document;
    }
    expect(featureIds(doc)).toEqual([]);
    expect(doc.parts[0]!.nextIds).toMatchObject({ sketch: 3, extrude: 3, fillet: 2 });
  });

  it('refuses a missing feature', () => {
    expectError(base(), { type: 'deleteFeature', partId: PART, featureId: 'hole#1' }, 'not-found');
  });
});

describe('reorderFeature', () => {
  // Bracket order: sketch#1, extrude#1, sketch#2, extrude#2, fillet#1.
  const s1 = 'sketch#1';
  const e1 = 'extrude#1';
  const s2 = 'sketch#2';
  const e2 = 'extrude#2';
  const f1 = 'fillet#1';
  const cases: [string, number, string[] | [CoreErrorCode, string[]?]][] = [
    [f1, 2, [s1, e1, f1, s2, e2]],
    [f1, 4, [s1, e1, s2, e2, f1]],
    [e2, 4, [s1, e1, s2, f1, e2]],
    [s1, 0, [s1, e1, s2, e2, f1]],
    [f1, 1, ['dependency', [e1]]],
    [f1, 0, ['dependency', [e1]]],
    [s2, 1, ['dependency', [e1]]],
    [s2, 3, ['dependency', [e2]]],
    [s2, 4, ['dependency', [e2]]],
    [e1, 0, ['dependency', [s1]]],
    [e1, 3, ['dependency', [s2]]],
    [e1, 4, ['dependency', [s2, f1]]],
    [s1, 2, ['dependency', [e1]]],
    [f1, 5, ['invalid-index']],
    ['hole#1', 0, ['not-found']],
  ];

  it.each(cases)('move %s to %s', (id, index, expected) => {
    const command: Command = { type: 'reorderFeature', partId: PART, featureId: id, index };
    if (typeof expected[0] === 'string' && expected[0].includes('#')) {
      const doc = unwrap(applyCommand(base(), command)).document;
      expect(featureIds(doc)).toEqual(expected);
    } else {
      const [code, blockers] = expected as [CoreErrorCode, string[]?];
      expectError(base(), command, code, blockers);
    }
  });

  it('keeps the rollback bar at its position', () => {
    const rolled = unwrap(
      applyCommand(base(), { type: 'setRollback', partId: PART, index: 3 }),
    ).document;
    const doc = unwrap(
      applyCommand(rolled, {
        type: 'reorderFeature',
        partId: PART,
        featureId: 'fillet#1',
        index: 2,
      }),
    ).document;
    expect(doc.parts[0]!.rollbackIndex).toBe(3);
    expect([0, 1, 2, 3, 4].map((i) => isFeatureActive(doc.parts[0]!, i))).toEqual([
      true,
      true,
      true,
      false,
      false,
    ]);
  });

  it('every order it accepts is a valid document, and every order it refuses breaks a dependency', () => {
    const doc = base();
    const ids = featureIds(doc);
    for (const id of ids) {
      for (let to = 0; to < ids.length; to++) {
        const r = applyCommand(doc, {
          type: 'reorderFeature',
          partId: PART,
          featureId: id,
          index: to,
        });
        const order = ids.filter((x) => x !== id);
        order.splice(to, 0, id);
        const pos = new Map(order.map((x, i) => [x, i]));
        const deps: Record<string, string[]> = {
          'extrude#1': ['sketch#1'],
          'sketch#2': ['extrude#1'],
          'extrude#2': ['sketch#2'],
          'fillet#1': ['extrude#1'],
        };
        const valid = Object.entries(deps).every(([f, ds]) =>
          ds.every((d) => pos.get(d)! < pos.get(f)!),
        );
        expect({ id, to, ok: r.ok }).toEqual({ id, to, ok: valid });
      }
    }
  });
});

describe('suppress, rename and rollback', () => {
  it('suppresses and unsuppresses', () => {
    const doc = unwrap(
      applyCommand(base(), {
        type: 'suppressFeature',
        partId: PART,
        featureId: 'sketch#2',
        suppressed: true,
      }),
    ).document;
    expect(doc.parts[0]!.features[2]!.suppressed).toBe(true);
    expect(isFeatureActive(doc.parts[0]!, 2)).toBe(false);
    expect(isFeatureActive(doc.parts[0]!, 3)).toBe(true);
  });

  it('trims names and refuses blank ones', () => {
    const doc = unwrap(
      applyCommand(base(), {
        type: 'renameFeature',
        partId: PART,
        featureId: 'fillet#1',
        name: '  Round  ',
      }),
    ).document;
    expect(doc.parts[0]!.features[4]!.name).toBe('Round');
    expectError(
      base(),
      { type: 'renameFeature', partId: PART, featureId: 'fillet#1', name: '  ' },
      'invalid-name',
    );
    expectError(
      base(),
      { type: 'renameFeature', partId: PART, featureId: 'fillet#1', name: 'x'.repeat(201) },
      'invalid-name',
    );
  });

  it.each([
    [null, true],
    [0, true],
    [5, true],
    [6, false],
  ])('rollback to %s: ok %s', (index, valid) => {
    const r = applyCommand(base(), { type: 'setRollback', partId: PART, index });
    expect(r.ok).toBe(valid);
  });
});

describe('restoreFeature', () => {
  it('refuses ids that were never allocated', () => {
    expectError(
      base(),
      { type: 'restoreFeature', partId: PART, feature: chamfer(), index: 5, rollbackIndex: null },
      'invalid-id',
      ['chamfer#1'],
    );
  });

  it('refuses to replace a feature at another index', () => {
    expectError(
      base(),
      {
        type: 'restoreFeature',
        partId: PART,
        feature: cornerFillet(),
        index: 2,
        rollbackIndex: null,
      },
      'invalid-index',
    );
  });

  it('restores the rollback bar it is given, and its inverse puts the old one back', () => {
    const deleted = unwrap(
      applyCommand(base(), { type: 'deleteFeature', partId: PART, featureId: 'fillet#1' }),
    ).document;
    const restored = unwrap(
      applyCommand(deleted, {
        type: 'restoreFeature',
        partId: PART,
        feature: cornerFillet(),
        index: 4,
        rollbackIndex: 1,
      }),
    );
    expect(restored.document.parts[0]!.rollbackIndex).toBe(1);
    const back = unwrap(applyCommand(restored.document, restored.inverse)).document;
    expect(back).toEqual(deleted);
  });
});

describe('variables', () => {
  it.each<[string, Command, CoreErrorCode, string[]?]>([
    [
      'an invalid name',
      { type: 'setVariable', name: 'my var', expression: mm('1') },
      'invalid-name',
    ],
    ['a function name', { type: 'setVariable', name: 'min', expression: mm('1') }, 'invalid-name'],
    ['a syntax error', { type: 'setVariable', name: 'x', expression: mm('4-1/2') }, 'expression'],
    [
      'an unknown variable',
      { type: 'setVariable', name: 'x', expression: mm('y + 1') },
      'unknown-variable',
      ['y'],
    ],
    [
      'a cycle',
      { type: 'setVariable', name: 'width', expression: mm('height * 2') },
      'variable-cycle',
      ['width', 'height'],
    ],
    [
      'an index past the end',
      { type: 'setVariable', name: 'x', expression: mm('1'), index: 5 },
      'invalid-index',
    ],
    [
      'deleting a variable in use',
      { type: 'deleteVariable', name: 'width' },
      'variable-in-use',
      ['height', 'sketch#1'],
    ],
    [
      'deleting a variable a feature uses',
      { type: 'deleteVariable', name: 'thickness' },
      'variable-in-use',
      ['extrude#1'],
    ],
    ['deleting a missing variable', { type: 'deleteVariable', name: 'nope' }, 'not-found'],
  ])('refuses %s', (_label, command, code, blockers) => {
    expectError(base(), command, code, blockers);
  });

  it('accepts imperial expressions under their own units', () => {
    const doc = unwrap(
      applyCommand(base(), {
        type: 'setVariable',
        name: 'board',
        expression: { source: `3' 4-1/2"`, lengthUnit: 'in', angleUnit: 'deg' },
      }),
    ).document;
    expect(doc.variables.at(-1)).toEqual({
      name: 'board',
      expression: { source: `3' 4-1/2"`, lengthUnit: 'in', angleUnit: 'deg' },
    });
  });

  it('lists the users of a variable', () => {
    expect(variableUsers(base(), 'width')).toEqual(['height', 'sketch#1']);
    expect(variableUsers(base(), 'height')).toEqual(['sketch#1']);
    expect(variableUsers(base(), 'spare')).toEqual([]);
  });

  it('keeps stored units when the display units change', () => {
    const before = base();
    const doc = unwrap(
      applyCommand(before, {
        type: 'setDisplayUnits',
        units: { length: { unit: 'in' }, angle: { unit: 'deg' } },
      }),
    ).document;
    expect(doc.units.length).toEqual({ unit: 'in' });
    // Nothing else is touched: variables and parts are the very same objects.
    expect(doc.variables).toBe(before.variables);
    expect(doc.parts).toBe(before.parts);
  });
});

describe('renameDocument', () => {
  it('trims the name, touches nothing else, and undoes to the old name', () => {
    const before = base();
    const done = unwrap(applyCommand(before, { type: 'renameDocument', name: '  Shelf  ' }));
    expect(done.document.name).toBe('Shelf');
    expect(done.document.parts).toBe(before.parts);
    expect(done.inverse).toEqual({ type: 'renameDocument', name: before.name });
  });

  it('refuses an empty or overlong name', () => {
    for (const name of ['', '   ', 'x'.repeat(201)]) {
      const r = applyCommand(base(), { type: 'renameDocument', name });
      expect(r.ok ? null : r.error.code).toBe('invalid-name');
    }
    expect(applyCommand(base(), { type: 'renameDocument', name: 'x'.repeat(200) }).ok).toBe(true);
  });
});

describe('batch', () => {
  it('is all or nothing', () => {
    const before = base();
    const r = applyCommand(before, {
      type: 'batch',
      commands: [add(chamfer()), { type: 'deleteFeature', partId: PART, featureId: 'sketch#1' }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('dependency');
  });

  it('checks the document only at the end, so intermediate states may be invalid', () => {
    const extrude3 = {
      id: 'extrude#3',
      kind: 'extrude',
      name: 'Extrude 3',
      suppressed: false,
      profile: { sketch: 'sketch#3' },
      operation: 'add',
      extent: { type: 'blind', distance: mm('2') },
      reverse: false,
    } as const satisfies Feature;
    expectError(base(), add(extrude3), 'dependency', ['sketch#3']);
    const doc = unwrap(
      applyCommand(base(), { type: 'batch', commands: [add(extrude3), add(sketch3(), 5)] }),
    ).document;
    expect(featureIds(doc).slice(-2)).toEqual(['sketch#3', 'extrude#3']);
  });

  it('refuses an empty batch', () => {
    expectError(base(), { type: 'batch', commands: [] }, 'schema');
  });
});
