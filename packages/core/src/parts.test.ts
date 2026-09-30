import { describe, expect, it } from 'vitest';
import { diffDocuments } from './changes';
import { applyCommand, type Command } from './commands';
import { createDocument } from './document';
import { deserialize, serialize } from './format';
import { previewIds } from './ids';
import type { CoreErrorCode } from './result';
import type { ManufaktureDocument } from './schema';
import { DocumentStore } from './store';
import { PART, bracket, clone, deepFreeze, unwrap } from './test-helpers';

/** Part studios: add, rename, delete, reorder and duplicate, their inverses, and part ids. */

function base(): ManufaktureDocument {
  return deepFreeze(bracket());
}

function apply(doc: ManufaktureDocument, command: Command) {
  return unwrap(applyCommand(doc, command));
}

function refused(doc: ManufaktureDocument, command: Command, code: CoreErrorCode) {
  const r = applyCommand(doc, command);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error.code).toBe(code);
  return r;
}

const partIds = (doc: ManufaktureDocument) => doc.parts.map((p) => p.id);

/** Applies `command`, then its inverse, then the inverse of that, checking each step. */
function roundTrip(doc: ManufaktureDocument, command: Command): ManufaktureDocument {
  const done = apply(doc, command);
  const undone = apply(done.document, done.inverse);
  expect(undone.document.parts).toEqual(doc.parts);
  const redone = apply(undone.document, undone.inverse);
  expect(redone.document.parts).toEqual(done.document.parts);
  return done.document;
}

describe('addPart', () => {
  it('adds an empty part studio with the next id, last by default', () => {
    const doc = base();
    const [id] = previewIds(doc.nextIds, 'part');
    expect(id).toBe('part#2');
    const next = roundTrip(doc, { type: 'addPart', partId: id!, name: '  Lid ' });
    expect(partIds(next)).toEqual([PART, 'part#2']);
    expect(next.parts[1]).toEqual({
      id: 'part#2',
      name: 'Lid',
      features: [],
      rollbackIndex: null,
      nextIds: {},
      bodies: [],
    });
    expect(next.nextIds.part).toBe(3);
  });

  it('inserts at an index', () => {
    const next = apply(base(), { type: 'addPart', partId: 'part#2', name: 'A', index: 0 });
    expect(partIds(next.document)).toEqual(['part#2', PART]);
    refused(base(), { type: 'addPart', partId: 'part#2', name: 'A', index: 5 }, 'invalid-index');
  });

  it('refuses a used id, an existing id, a malformed id and a blank name', () => {
    const doc = base();
    refused(doc, { type: 'addPart', partId: PART, name: 'A' }, 'duplicate');
    refused(doc, { type: 'addPart', partId: 'lid', name: 'A' }, 'invalid-id');
    refused(doc, { type: 'addPart', partId: 'part#0', name: 'A' }, 'invalid-id');
    refused(doc, { type: 'addPart', partId: 'part#2', name: '  ' }, 'invalid-name');
    refused(doc, { type: 'addPart', partId: 'part#2', name: 'x'.repeat(201) }, 'invalid-name');
    const added = apply(doc, { type: 'addPart', partId: 'part#2', name: 'A' }).document;
    const deleted = apply(added, { type: 'deletePart', partId: 'part#2' }).document;
    refused(deleted, { type: 'addPart', partId: 'part#2', name: 'A' }, 'id-reused');
  });

  it('accepts an id past the counter and moves the counter beyond it', () => {
    const next = apply(base(), { type: 'addPart', partId: 'part#7', name: 'A' }).document;
    expect(next.nextIds.part).toBe(8);
  });
});

describe('part ids after delete and undo', () => {
  it('never hands out an id again: not after delete, not after undo', () => {
    const store = unwrap(DocumentStore.create(base()));
    const add = () => {
      const [id] = previewIds(store.document.nextIds, 'part');
      unwrap(store.execute({ type: 'addPart', partId: id!, name: 'Part' }));
      return id!;
    };
    expect(add()).toBe('part#2');
    unwrap(store.execute({ type: 'deletePart', partId: 'part#2' }));
    expect(add()).toBe('part#3');
    unwrap(store.undo());
    expect(partIds(store.document)).toEqual([PART]);
    expect(add()).toBe('part#4');
    // The undone add cannot be redone once something else ran, and part#3 stays unused.
    expect(store.canRedo).toBe(false);
    expect(store.document.nextIds.part).toBe(5);
  });

  it('undo of a delete puts the part back with its id, without moving the counter', () => {
    const store = unwrap(DocumentStore.create(base()));
    unwrap(store.execute({ type: 'addPart', partId: 'part#2', name: 'Lid' }));
    const before = store.document;
    unwrap(store.execute({ type: 'deletePart', partId: 'part#2' }));
    unwrap(store.undo());
    expect(store.document).toEqual(before);
    unwrap(store.redo());
    expect(partIds(store.document)).toEqual([PART]);
    expect(store.document.nextIds.part).toBe(3);
  });
});

describe('renamePart', () => {
  it('trims, undoes to the old name, and refuses a blank name or a missing part', () => {
    const next = roundTrip(base(), { type: 'renamePart', partId: PART, name: ' Bracket ' });
    expect(next.parts[0]!.name).toBe('Bracket');
    refused(base(), { type: 'renamePart', partId: PART, name: '' }, 'invalid-name');
    refused(base(), { type: 'renamePart', partId: 'part#9', name: 'A' }, 'not-found');
  });
});

describe('deletePart', () => {
  it('refuses the last part studio', () => {
    refused(base(), { type: 'deletePart', partId: PART }, 'last-part');
  });

  it('removes a part and undoes it at the same index', () => {
    const doc = apply(apply(base(), { type: 'addPart', partId: 'part#2', name: 'B' }).document, {
      type: 'addPart',
      partId: 'part#3',
      name: 'C',
    }).document;
    const next = roundTrip(doc, { type: 'deletePart', partId: 'part#2' });
    expect(partIds(next)).toEqual([PART, 'part#3']);
    // The first part can go too, once there are others.
    expect(partIds(roundTrip(doc, { type: 'deletePart', partId: PART }))).toEqual([
      'part#2',
      'part#3',
    ]);
  });

  it('refuses while a configuration parameter suppresses a feature of the part', () => {
    const doc = apply(base(), {
      type: 'batch',
      commands: [
        { type: 'addPart', partId: 'part#2', name: 'B' },
        {
          type: 'setConfigParameter',
          parameter: {
            id: 'cp#1',
            name: 'Rounded',
            kind: 'suppression',
            partId: PART,
            featureId: 'fillet#1',
          },
        },
      ],
    }).document;
    const r = refused(doc, { type: 'deletePart', partId: PART }, 'dependency');
    if (!r.ok) expect(r.error.blockers).toEqual(['cp#1']);
    // Deleting the parameter in the same batch lets the part go, and undo brings both back.
    roundTrip(doc, {
      type: 'batch',
      commands: [
        { type: 'deleteConfigParameter', parameterId: 'cp#1' },
        { type: 'deletePart', partId: PART },
      ],
    });
  });
});

describe('restorePart', () => {
  it('refuses an id that was never allocated or already exists', () => {
    const doc = base();
    const part = { ...clone(doc.parts[0]!), id: 'part#5' };
    refused(doc, { type: 'restorePart', part, index: 1 }, 'invalid-id');
    refused(doc, { type: 'restorePart', part: clone(doc.parts[0]!), index: 0 }, 'duplicate');
  });
});

describe('reorderParts', () => {
  it('moves a part and undoes the move', () => {
    const doc = apply(base(), {
      type: 'batch',
      commands: [
        { type: 'addPart', partId: 'part#2', name: 'B' },
        { type: 'addPart', partId: 'part#3', name: 'C' },
      ],
    }).document;
    expect(partIds(roundTrip(doc, { type: 'reorderParts', partId: 'part#3', index: 0 }))).toEqual([
      'part#3',
      PART,
      'part#2',
    ]);
    expect(partIds(roundTrip(doc, { type: 'reorderParts', partId: PART, index: 2 }))).toEqual([
      'part#2',
      'part#3',
      PART,
    ]);
    refused(doc, { type: 'reorderParts', partId: PART, index: 3 }, 'invalid-index');
    refused(doc, { type: 'reorderParts', partId: 'part#9', index: 0 }, 'not-found');
  });
});

describe('duplicatePart', () => {
  it('copies features with the same ids, body props, material, counters and rollback bar', () => {
    const doc = apply(base(), {
      type: 'batch',
      commands: [
        { type: 'setMaterial', partId: PART, material: 'aluminium-6061' },
        { type: 'setBodyProps', partId: PART, bodyId: 'extrude#1', props: { name: 'Bracket' } },
        { type: 'setRollback', partId: PART, index: 3 },
        { type: 'addPart', partId: 'part#2', name: 'Other' },
      ],
    }).document;
    const next = roundTrip(doc, {
      type: 'duplicatePart',
      sourcePartId: PART,
      partId: 'part#3',
      name: 'Copy',
    });
    // Placed just after its source by default.
    expect(partIds(next)).toEqual([PART, 'part#3', 'part#2']);
    const source = next.parts[0]!;
    expect(next.parts[1]).toEqual({ ...source, id: 'part#3', name: 'Copy' });
    expect(next.nextIds.part).toBe(4);
  });

  it('keeps the copies independent: editing one leaves the other', () => {
    const doc = apply(base(), {
      type: 'duplicatePart',
      sourcePartId: PART,
      partId: 'part#2',
      name: 'Copy',
    }).document;
    const renamed = apply(doc, {
      type: 'renameFeature',
      partId: 'part#2',
      featureId: 'extrude#1',
      name: 'Base',
    }).document;
    expect(renamed.parts[0]!.features.find((f) => f.id === 'extrude#1')!.name).not.toBe('Base');
    expect(renamed.parts[1]!.features.find((f) => f.id === 'extrude#1')!.name).toBe('Base');
  });

  it('refuses a missing source or a used id', () => {
    const doc = base();
    refused(
      doc,
      { type: 'duplicatePart', sourcePartId: 'part#9', partId: 'part#2', name: 'A' },
      'not-found',
    );
    refused(
      doc,
      { type: 'duplicatePart', sourcePartId: PART, partId: PART, name: 'A' },
      'duplicate',
    );
  });
});

describe('several part studios', () => {
  it('survive a save and load, in order', () => {
    const doc = apply(createDocument({ id: 'd', name: 'D' }), {
      type: 'batch',
      commands: [
        { type: 'addPart', partId: 'part#2', name: 'Two' },
        { type: 'reorderParts', partId: 'part#2', index: 0 },
      ],
    }).document;
    const loaded = unwrap(deserialize(serialize(doc))).document;
    expect(partIds(loaded)).toEqual(['part#2', PART]);
    expect(loaded.nextIds.part).toBe(3);
  });

  it('report the parts added and removed as changes', () => {
    const doc = base();
    const added = apply(doc, { type: 'addPart', partId: 'part#2', name: 'B' }).document;
    const change = diffDocuments(doc, added);
    expect(change.empty).toBe(false);
    expect(change.parts.map((p) => [p.partId, p.status])).toEqual([['part#2', 'added']]);
    const removed = apply(added, { type: 'deletePart', partId: 'part#2' }).document;
    expect(diffDocuments(added, removed).parts.map((p) => [p.partId, p.status])).toEqual([
      ['part#2', 'removed'],
    ]);
    const moved = apply(
      apply(added, { type: 'reorderParts', partId: 'part#2', index: 0 }).document,
      { type: 'renamePart', partId: PART, name: 'Renamed' },
    ).document;
    expect(diffDocuments(added, moved).empty).toBe(false);
  });
});
