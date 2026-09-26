import { DocumentStore, type ManufaktureDocument } from '@manufakture/core';
import type { FeatureResult } from '@manufakture/regen';
import { describe, expect, it } from 'vitest';
import { demoDocument } from '../model/demo';
import {
  deleteFeature,
  dependentsOf,
  dropIndex,
  firstChanged,
  moveFeature,
  renameFeature,
  repicks,
  rollbackPosition,
  rowMessages,
  setRollback,
  suppressFeature,
  treeRows,
} from './tree';

const PART = 'part#1';

function store(doc: ManufaktureDocument = demoDocument()) {
  const s = DocumentStore.create(doc);
  if (!s.ok) throw new Error(s.error.message);
  return s.value;
}

const result = (featureId: string, patch: Partial<FeatureResult> = {}): FeatureResult => ({
  featureId,
  kind: 'extrude',
  index: 0,
  status: 'ok',
  errors: [],
  warnings: [],
  references: [],
  cached: false,
  ms: 0,
  ...patch,
});

describe('rows and statuses', () => {
  it('shows regen statuses, with suppression and the rollback bar read from the document', () => {
    const s = store();
    const built = s.document;
    s.execute({ type: 'suppressFeature', partId: PART, featureId: 'sketch#2', suppressed: true });
    s.execute({ type: 'setRollback', partId: PART, index: 4 });
    const results = new Map([
      ['sketch#1', result('sketch#1')],
      ['extrude#1', result('extrude#1', { warnings: [{ code: 'extension', message: 'w' }] })],
      [
        'fillet#1',
        result('fillet#1', {
          status: 'error',
          errors: [
            {
              code: 'reference-lost',
              message: 'Edge r3 is gone; re-pick it',
              referenceId: 'r3',
              missing: ['x'],
            },
          ],
        }),
      ],
      ['sketch#2', result('sketch#2')],
      ['extrude#2', result('extrude#2', { status: 'upstream-error' })],
    ]);
    const rows = treeRows(s.document.parts[0]!, results, {
      available: true,
      built,
      current: s.document,
    });
    expect(rows.map((r) => r.status)).toEqual([
      'ok',
      'warning',
      'error',
      'suppressed',
      'rolled-back',
    ]);
    // sketch#2 changed (suppressed) since the model was built: it and everything after is stale.
    expect(rows.map((r) => r.stale)).toEqual([false, false, false, true, true]);
    expect(repicks(rows[2]!.result)).toEqual([
      { referenceId: 'r3', message: 'Edge r3 is gone; re-pick it' },
    ]);
    expect(rowMessages(rows[2]!)).toEqual([
      { severity: 'error', text: 'Edge r3 is gone; re-pick it' },
    ]);
    expect(rowMessages(rows[1]!)).toEqual([{ severity: 'warning', text: 'w' }]);
    expect(rowMessages(rows[3]!)).toEqual([]);
  });

  it('is pending before regen reports, and unknown without a regen engine', () => {
    const doc = demoDocument();
    const part = doc.parts[0]!;
    const pending = treeRows(part, new Map(), { available: true, built: null, current: doc });
    expect(pending.every((r) => r.status === 'pending' && r.stale)).toBe(true);
    const unknown = treeRows(part, new Map(), { available: false, built: null, current: doc });
    expect(unknown.every((r) => r.status === 'unknown')).toBe(true);
  });

  it('does not count a rename as a change, but does a variable or the rollback bar', () => {
    const s = store();
    const built = s.document;
    s.execute({ type: 'renameFeature', partId: PART, featureId: 'extrude#1', name: 'Block' });
    expect(firstChanged(s.document.parts[0]!, built, s.document)).toBe(5);
    s.execute({ type: 'setRollback', partId: PART, index: 3 });
    expect(firstChanged(s.document.parts[0]!, built, s.document)).toBe(3);
    s.execute({
      type: 'setVariable',
      name: 'w',
      expression: { source: '3', lengthUnit: 'mm', angleUnit: 'deg' },
    });
    expect(firstChanged(s.document.parts[0]!, built, s.document)).toBe(0);
  });
});

describe('dragging to reorder', () => {
  it('turns a drop slot into the final index', () => {
    expect(dropIndex(1, 0)).toBe(0);
    expect(dropIndex(1, 1)).toBe(1);
    expect(dropIndex(1, 2)).toBe(1);
    expect(dropIndex(1, 4)).toBe(3);
  });

  it('allows independent moves and explains the ones that would break a dependency', () => {
    const s = store();
    // The hole's sketch does not depend on the block: it may move to the top.
    const up = moveFeature(s.document, PART, 'sketch#2', 0);
    expect(up).toEqual({
      ok: true,
      command: { type: 'reorderFeature', partId: PART, featureId: 'sketch#2', index: 0 },
    });
    // The fillet is built from the extrusion's faces.
    expect(moveFeature(s.document, PART, 'fillet#1', 1)).toEqual({
      ok: false,
      message: 'Fillet 1 cannot move above Extrude 1: it is built from it.',
    });
    // The extrusion cannot go below what is built from it.
    expect(moveFeature(s.document, PART, 'extrude#1', 4)).toEqual({
      ok: false,
      message: 'Extrude 1 cannot move below Fillet 1: it is built from Extrude 1.',
    });
    expect(moveFeature(s.document, PART, 'nothing#1', 0)).toMatchObject({ ok: false });
  });
});

describe('suppress, rename, delete, roll back', () => {
  it('toggles suppression as one step each way', () => {
    const s = store();
    const f = s.document.parts[0]!.features[2]!;
    const a = suppressFeature(PART, f);
    expect(a.label).toBe('Suppress Fillet 1');
    s.execute(a.command, a.label);
    const b = suppressFeature(PART, s.document.parts[0]!.features[2]!);
    expect(b.label).toBe('Unsuppress Fillet 1');
  });

  it('renames, refusing an empty name and ignoring no change', () => {
    const f = demoDocument().parts[0]!.features[1]!;
    expect(renameFeature(PART, f, '  Block ')).toMatchObject({
      ok: true,
      command: { type: 'renameFeature', name: 'Block' },
    });
    expect(renameFeature(PART, f, ' ')).toMatchObject({ ok: false });
    expect(renameFeature(PART, f, 'Extrude 1')).toMatchObject({ ok: true, command: null });
  });

  it('deletes a feature with everything built from it, as one undoable step', () => {
    const s = store();
    expect(dependentsOf(s.document.parts[0]!, 'sketch#1')).toEqual(['extrude#1', 'fillet#1']);
    const d = deleteFeature(s.document, PART, 'sketch#1')!;
    expect(d.dependents).toEqual(['Extrude 1', 'Fillet 1']);
    expect(s.execute(d.command, d.label).ok).toBe(true);
    expect(s.document.parts[0]!.features.map((f) => f.id)).toEqual(['sketch#2', 'extrude#2']);
    s.undo();
    expect(s.document.parts[0]!.features).toHaveLength(5);
    const alone = deleteFeature(s.document, PART, 'extrude#2')!;
    expect(alone.dependents).toEqual([]);
    expect(alone.command.type).toBe('deleteFeature');
  });

  it('moves the rollback bar, with the end stored as null', () => {
    const s = store();
    const part = () => s.document.parts[0]!;
    expect(rollbackPosition(part())).toBe(5);
    expect(setRollback(part(), 5)).toBeNull();
    const back = setRollback(part(), 2)!;
    s.execute(back.command, back.label);
    expect(part().rollbackIndex).toBe(2);
    const end = setRollback(part(), 99)!;
    expect(end.command).toEqual({ type: 'setRollback', partId: PART, index: null });
  });
});
