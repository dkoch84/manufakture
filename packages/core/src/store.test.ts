import { describe, expect, it, vi } from 'vitest';
import type { Command } from './commands';
import { createDocument } from './document';
import { previewIds } from './ids';
import type { ChamferFeature, ManufaktureDocument } from './schema';
import { DocumentStore, type ChangeEvent } from './store';
import { PART, bracket, bracketCommands, clone, featureIds, mm, unwrap } from './test-helpers';

function store(doc: ManufaktureDocument = bracket(), historyLimit?: number): DocumentStore {
  return unwrap(DocumentStore.create(doc, historyLimit === undefined ? {} : { historyLimit }));
}

function chamfer(id: string, refId: string): ChamferFeature {
  return {
    id,
    kind: 'chamfer',
    name: 'Chamfer',
    suppressed: false,
    edges: [{ id: refId, ref: { faces: ['extrude#1:cap:end', 'extrude#1:side:e3'] } }],
    distance: mm('1'),
  };
}

const withoutCounters = (doc: ManufaktureDocument) => ({
  ...doc,
  parts: doc.parts.map((p) => ({ ...p, nextIds: {} })),
});

describe('DocumentStore', () => {
  it('refuses an invalid document', () => {
    const doc = clone(bracket());
    doc.variables[0]!.expression = mm('(');
    const r = DocumentStore.create(doc);
    expect(r.ok).toBe(false);
  });

  it('undoes and redoes a whole modelling session step by step', () => {
    const s = store(createDocument({ id: 'd', name: 'Bracket' }));
    const states = [s.document];
    for (const c of bracketCommands()) {
      unwrap(s.execute(c));
      states.push(s.document);
    }
    const commands = bracketCommands();
    const extra: Command[] = [
      { type: 'reorderFeature', partId: PART, featureId: 'fillet#1', index: 2 },
      { type: 'setVariable', name: 'thickness', expression: mm('10mm') },
      { type: 'suppressFeature', partId: PART, featureId: 'extrude#2', suppressed: true },
      { type: 'deleteFeature', partId: PART, featureId: 'extrude#2' },
      { type: 'setRollback', partId: PART, index: 2 },
    ];
    for (const c of extra) {
      unwrap(s.execute(c));
      states.push(s.document);
    }
    const final = s.document;
    expect(s.undoStack).toHaveLength(commands.length + extra.length);

    for (let i = states.length - 2; i >= 0; i--) {
      unwrap(s.undo());
      expect(withoutCounters(s.document)).toEqual(withoutCounters(states[i]!));
    }
    expect(s.canUndo).toBe(false);
    expect(s.undo()).toMatchObject({ ok: false, error: { code: 'empty-history' } });

    for (let i = 1; i < states.length; i++) {
      unwrap(s.redo());
      expect(withoutCounters(s.document)).toEqual(withoutCounters(states[i]!));
      // Counters stay where the furthest step left them.
      expect(s.document.parts[0]!.nextIds).toEqual(final.parts[0]!.nextIds);
    }
    expect(s.document).toEqual(final);
    expect(s.canRedo).toBe(false);
    expect(s.redo()).toMatchObject({ ok: false, error: { code: 'empty-history' } });
  });

  it('clears the redo stack on a new command', () => {
    const s = store();
    unwrap(s.execute({ type: 'renameFeature', partId: PART, featureId: 'fillet#1', name: 'A' }));
    unwrap(s.undo());
    expect(s.canRedo).toBe(true);
    unwrap(s.execute({ type: 'renameFeature', partId: PART, featureId: 'fillet#1', name: 'B' }));
    expect(s.canRedo).toBe(false);
  });

  it('never hands out an id again after its step is undone', () => {
    const s = store();
    const [id] = previewIds(s.document.parts[0]!.nextIds, 'chamfer');
    const [ref] = previewIds(s.document.parts[0]!.nextIds, 'r');
    unwrap(s.execute({ type: 'addFeature', partId: PART, feature: chamfer(id!, ref!) }));
    unwrap(s.undo());
    expect(featureIds(s.document)).not.toContain('chamfer#1');
    const r = s.execute({ type: 'addFeature', partId: PART, feature: chamfer('chamfer#1', 'r3') });
    expect(r).toMatchObject({ ok: false, error: { code: 'id-reused' } });
    // The editor asks for fresh ids and gets new ones.
    expect(previewIds(s.document.parts[0]!.nextIds, 'chamfer')).toEqual(['chamfer#2']);
    expect(previewIds(s.document.parts[0]!.nextIds, 'r')).toEqual(['r4']);
    // Redo is still possible until something else runs, and brings back the same ids.
    unwrap(s.redo());
    expect(featureIds(s.document)).toContain('chamfer#1');
  });

  it('leaves everything untouched when a command fails', () => {
    const s = store();
    const listener = vi.fn();
    s.subscribe(listener);
    const before = s.document;
    const r = s.execute({ type: 'deleteFeature', partId: PART, featureId: 'sketch#1' });
    expect(r.ok).toBe(false);
    expect(s.document).toBe(before);
    expect(s.canUndo).toBe(false);
    expect(listener).not.toHaveBeenCalled();
  });

  it('ignores a command that changes nothing', () => {
    const s = store();
    const listener = vi.fn();
    s.subscribe(listener);
    const r = unwrap(
      s.execute({ type: 'renameFeature', partId: PART, featureId: 'fillet#1', name: 'Fillet 1' }),
    );
    expect(r.empty).toBe(true);
    expect(s.canUndo).toBe(false);
    expect(listener).not.toHaveBeenCalled();
  });

  it('notifies subscribers with the cause, command, label and change', () => {
    const s = store();
    const events: ChangeEvent[] = [];
    const off = s.subscribe((e) => events.push(e));
    const before = s.document;
    const command: Command = { type: 'setVariable', name: 'thickness', expression: mm('9mm') };
    unwrap(s.execute(command, 'Set thickness'));
    unwrap(s.undo());
    unwrap(s.redo());
    off();
    unwrap(s.undo());

    expect(events.map((e) => [e.cause, e.label])).toEqual([
      ['execute', 'Set thickness'],
      ['undo', 'Set thickness'],
      ['redo', 'Set thickness'],
    ]);
    expect(events[0]!.command).toEqual(command);
    expect(events[0]!.previous).toBe(before);
    expect(events[1]!.command).toEqual({
      type: 'setVariable',
      name: 'thickness',
      expression: mm('6mm'),
    });
    expect(events[2]!.command).toEqual(command);
    expect(events[0]!.change.variables.changed).toEqual(['thickness']);
    // extrude#1 reads thickness, so regen restarts there.
    expect(events[0]!.change.parts).toMatchObject([{ partId: PART, firstAffectedIndex: 1 }]);
    expect(events[1]!.document).toEqual(before);
  });

  it('runs every listener even if one throws, then rethrows', () => {
    const s = store();
    const second = vi.fn();
    s.subscribe(() => {
      throw new Error('listener bug');
    });
    s.subscribe(second);
    expect(() =>
      s.execute({ type: 'renameFeature', partId: PART, featureId: 'fillet#1', name: 'X' }),
    ).toThrow('listener bug');
    expect(second).toHaveBeenCalledOnce();
    expect(s.document.parts[0]!.features[4]!.name).toBe('X');
    expect(s.canUndo).toBe(true);
  });

  it('keeps at most historyLimit undo steps', () => {
    const s = store(bracket(), 3);
    for (const name of ['a', 'b', 'c', 'd', 'e']) {
      unwrap(s.execute({ type: 'renameFeature', partId: PART, featureId: 'fillet#1', name }));
    }
    expect(s.undoStack.map((e) => e.command)).toEqual(
      ['b', 'c', 'd'].map((name) => ({
        type: 'renameFeature',
        partId: PART,
        featureId: 'fillet#1',
        name,
      })),
    );
    unwrap(s.undo());
    unwrap(s.undo());
    unwrap(s.undo());
    expect(s.document.parts[0]!.features[4]!.name).toBe('b');
    expect(s.canUndo).toBe(false);
  });

  it('loads a document, clearing history and notifying', () => {
    const s = store();
    unwrap(s.execute({ type: 'renameFeature', partId: PART, featureId: 'fillet#1', name: 'X' }));
    const events: ChangeEvent[] = [];
    s.subscribe((e) => events.push(e));
    const fresh = createDocument({ id: 'other', name: 'Other' });
    const change = unwrap(s.load(fresh));
    expect(s.document).toBe(fresh);
    expect(s.canUndo || s.canRedo).toBe(false);
    expect(events).toHaveLength(1);
    expect(events[0]!.cause).toBe('load');
    expect(events[0]!.command).toBeUndefined();
    expect(change.parts).toMatchObject([
      { partId: PART, removed: featureIds(bracket()), firstAffectedIndex: 0 },
    ]);

    const bad = clone(fresh);
    bad.parts[0]!.rollbackIndex = 3;
    expect(s.load(bad).ok).toBe(false);
    expect(s.document).toBe(fresh);
  });

  it('has serializable history stacks', () => {
    const s = store();
    unwrap(
      s.execute({ type: 'deleteFeature', partId: PART, featureId: 'fillet#1' }, 'Delete Fillet 1'),
    );
    unwrap(
      s.execute({ type: 'renameFeature', partId: PART, featureId: 'extrude#2', name: 'Hole' }),
    );
    unwrap(s.undo());
    const snapshot = JSON.parse(JSON.stringify({ undo: s.undoStack, redo: s.redoStack }));
    expect(snapshot).toEqual({ undo: s.undoStack, redo: s.redoStack });
    expect(snapshot.undo[0]).toEqual({
      label: 'Delete Fillet 1',
      command: {
        type: 'restoreFeature',
        partId: PART,
        feature: bracket().parts[0]!.features[4],
        index: 4,
        rollbackIndex: null,
      },
    });
  });
});
