import { describe, expect, it } from 'vitest';
import { createSelectionStore, featureItem, geometryRef } from '../state/selection';
import { followDialog, followSelection, renamedFeature } from './follow';

const table = { 'part:part#1': { 'extrude#3': 'extrude#4', 'fillet#2': null } };

describe('following sync renames', () => {
  it('names a feature after the renames', () => {
    expect(renamedFeature(table, 'part#1', 'extrude#3')).toBe('extrude#4');
    expect(renamedFeature(table, 'part#1', 'fillet#2')).toBeNull();
    expect(renamedFeature(table, 'part#1', 'sketch#1')).toBe('sketch#1');
    expect(renamedFeature(table, 'part#2', 'extrude#3')).toBe('extrude#3');
  });

  it('renames selected features, drops gone ones and faces of the part, keeps the rest', () => {
    const selection = createSelectionStore();
    const otherFace = geometryRef('face', 'part#2/extrude#1', 'extrude#1:cap:end');
    selection
      .getState()
      .select([
        featureItem('extrude#3'),
        featureItem('fillet#2'),
        featureItem('sketch#1'),
        geometryRef('face', 'part#1/extrude#3', 'extrude#3:cap:end'),
        otherFace,
      ]);
    selection.getState().setHovered(featureItem('extrude#3'));
    followSelection(selection, table, 'part#1');
    expect(selection.getState().selected).toEqual([
      featureItem('extrude#4'),
      featureItem('sketch#1'),
      otherFace,
    ]);
    expect(selection.getState().hovered).toBeNull();
  });

  it('leaves the selection alone when the part has no renames', () => {
    const selection = createSelectionStore();
    selection.getState().select([featureItem('extrude#3')]);
    const before = selection.getState().selected;
    followSelection(selection, table, 'part#2');
    expect(selection.getState().selected).toBe(before);
  });

  it('moves an open dialog to the new id, closes it when its feature is gone', () => {
    expect(followDialog({ kind: 'extrude', featureId: 'extrude#3' }, table, 'part#1')).toEqual({
      kind: 'extrude',
      featureId: 'extrude#4',
    });
    expect(followDialog({ kind: 'fillet', featureId: 'fillet#2' }, table, 'part#1')).toBeNull();
    const fresh: { kind: string; featureId?: string } = { kind: 'extrude' };
    expect(followDialog(fresh, table, 'part#1')).toBe(fresh);
    expect(followDialog(null, table, 'part#1')).toBeNull();
  });
});
