import { act, fireEvent, render, screen, within } from '@testing-library/react';
import type { FeatureResult } from '@manufakture/regen';
import { describe, expect, it, vi } from 'vitest';
import { demoDocument } from '../model/demo';
import { createModelStore } from '../model/model';
import { createDocumentStore } from '../state/document';
import { createSelectionStore, featureItem } from '../state/selection';
import { FeatureTree } from './FeatureTree';

function result(featureId: string, patch: Partial<FeatureResult> = {}): FeatureResult {
  return {
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
  };
}

function setup(options: { disabled?: boolean } = {}) {
  const documents = createDocumentStore(demoDocument());
  const model = createModelStore();
  const selection = createSelectionStore();
  const onEdit = vi.fn();
  model.setState({
    available: true,
    generation: 1,
    document: documents.getState().document,
    parts: [
      {
        partId: 'part#1',
        bodies: [],
        features: [
          result('sketch#1', { kind: 'sketch' }),
          result('extrude#1'),
          result('fillet#1', {
            kind: 'fillet',
            status: 'error',
            errors: [
              {
                code: 'reference-lost',
                message: 'Edge r2 of Fillet 1 is gone; re-pick it',
                referenceId: 'r2',
                missing: ['extrude#1:side:e9'],
              },
            ],
          }),
          result('sketch#2', { kind: 'sketch' }),
          result('extrude#2', { warnings: [{ code: 'extension', message: 'Look at this' }] }),
        ],
      },
    ],
  });
  render(
    <FeatureTree
      documents={documents}
      model={model}
      selection={selection}
      onEdit={onEdit}
      disabled={options.disabled ?? false}
    />,
  );
  const ids = () => documents.getState().document.parts[0]!.features.map((f) => f.id);
  const row = (id: string) => screen.getByTestId(`feature-${id}`);
  return { documents, model, selection, onEdit, ids, row };
}

describe('the feature tree', () => {
  it('lists the features in order with their statuses', () => {
    const t = setup();
    const rows = screen.getAllByRole('listitem').filter((el) => el.dataset.feature);
    expect(rows.map((r) => r.dataset.feature)).toEqual(t.ids());
    expect(rows.map((r) => r.dataset.status)).toEqual(['ok', 'ok', 'error', 'ok', 'warning']);
    expect(within(t.row('fillet#1')).getByText('Fillet 1')).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Fillet 1: Failed' }).querySelector('svg'),
    ).not.toBeNull();
  });

  it('shows the error in a tooltip with a re-pick action for a lost reference', () => {
    const t = setup();
    fireEvent.mouseEnter(screen.getByTestId('status-fillet#1'));
    const tip = screen.getByTestId('feature-tip');
    expect(tip.textContent).toContain('Edge r2 of Fillet 1 is gone; re-pick it');
    fireEvent.click(within(tip).getByRole('button', { name: 'Re-pick r2' }));
    expect(t.onEdit).toHaveBeenCalledWith('fillet#1', { repick: 'r2' });
  });

  it('selects on click, edits on double-click and Enter, and hovers the feature', () => {
    const t = setup();
    fireEvent.click(t.row('extrude#1'));
    expect(t.selection.getState().selected).toEqual([featureItem('extrude#1')]);
    expect(t.row('extrude#1').getAttribute('aria-selected')).toBe('true');
    fireEvent.doubleClick(t.row('extrude#1'));
    expect(t.onEdit).toHaveBeenLastCalledWith('extrude#1');
    fireEvent.keyDown(t.row('sketch#2'), { key: 'Enter' });
    expect(t.onEdit).toHaveBeenLastCalledWith('sketch#2');
    fireEvent.mouseEnter(t.row('fillet#1'));
    expect(t.selection.getState().hovered).toEqual(featureItem('fillet#1'));
    fireEvent.mouseLeave(t.row('fillet#1'));
    expect(t.selection.getState().hovered).toBeNull();
  });

  it('renames inline as one undoable step', () => {
    const t = setup();
    fireEvent.keyDown(t.row('extrude#1'), { key: 'F2' });
    const input = screen.getByRole('textbox', { name: 'New name for Extrude 1' });
    fireEvent.change(input, { target: { value: 'Block' } });
    // Enter commits, and the input may blur before React has re-rendered (as it goes away):
    // still one rename.
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
    expect(within(t.row('extrude#1')).getByText('Block')).toBeTruthy();
    expect(t.documents.getState().undoLabel).toBe('Rename Extrude 1');
    expect(t.documents.core.undoStack).toHaveLength(1);
    // Escape leaves the name alone.
    fireEvent.click(screen.getByRole('button', { name: 'Rename Block' }));
    const again = screen.getByRole('textbox', { name: 'New name for Block' });
    fireEvent.change(again, { target: { value: 'Other' } });
    fireEvent.keyDown(again, { key: 'Escape' });
    expect(within(t.row('extrude#1')).getByText('Block')).toBeTruthy();
    expect(t.documents.core.undoStack).toHaveLength(1);
  });

  it('suppresses and unsuppresses', () => {
    const t = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Suppress Fillet 1' }));
    expect(t.row('fillet#1').dataset.status).toBe('suppressed');
    fireEvent.click(screen.getByRole('button', { name: 'Unsuppress Fillet 1' }));
    expect(t.row('fillet#1').dataset.status).not.toBe('suppressed');
    expect(t.documents.getState().undoLabel).toBe('Unsuppress Fillet 1');
  });

  it('warns before deleting a feature others are built from, and deletes them together', () => {
    const t = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Delete Sketch 1' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Delete Sketch 1' });
    expect(dialog.textContent).toContain('Extrude 1, Fillet 1 are built from it');
    // The question takes focus, so the keyboard can answer it.
    expect(dialog.contains(document.activeElement)).toBe(true);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(t.ids()).toHaveLength(5);
    // Escape cancels too, and focus goes back to the row.
    t.row('sketch#1').focus();
    fireEvent.keyDown(t.row('sketch#1'), { key: 'Delete' });
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(document.activeElement).toBe(t.row('sketch#1'));
    expect(t.ids()).toHaveLength(5);
    fireEvent.click(screen.getByRole('button', { name: 'Delete Sketch 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete 3 features' }));
    expect(t.ids()).toEqual(['sketch#2', 'extrude#2']);
    act(() => void t.documents.getState().undo());
    expect(t.ids()).toHaveLength(5);
    // Nothing depends on the hole: it goes at once.
    fireEvent.keyDown(t.row('extrude#2'), { key: 'Delete' });
    expect(t.ids()).toHaveLength(4);
  });

  it('moves with Alt+arrows, and explains a move that would break a dependency', () => {
    const t = setup();
    fireEvent.keyDown(t.row('sketch#2'), { key: 'ArrowUp', altKey: true });
    expect(t.ids()).toEqual(['sketch#1', 'extrude#1', 'sketch#2', 'fillet#1', 'extrude#2']);
    fireEvent.keyDown(t.row('fillet#1'), { key: 'ArrowUp', altKey: true });
    fireEvent.keyDown(t.row('fillet#1'), { key: 'ArrowUp', altKey: true });
    // Up past sketch#2 was fine; past the extrusion it is built from is not.
    expect(t.ids()).toEqual(['sketch#1', 'extrude#1', 'fillet#1', 'sketch#2', 'extrude#2']);
    expect(screen.getByTestId('tree-message').textContent).toContain(
      'Fillet 1 cannot move above Extrude 1: it is built from it.',
    );
  });

  it('moves the rollback bar with the keyboard, one undo step each', () => {
    const t = setup();
    const bar = screen.getByRole('slider', { name: 'Rollback bar' });
    expect(bar.getAttribute('aria-valuenow')).toBe('5');
    fireEvent.keyDown(bar, { key: 'ArrowUp' });
    fireEvent.keyDown(screen.getByRole('slider', { name: 'Rollback bar' }), { key: 'ArrowUp' });
    expect(t.documents.getState().document.parts[0]!.rollbackIndex).toBe(3);
    expect(t.row('sketch#2').dataset.status).toBe('rolled-back');
    expect(screen.getByRole('slider').getAttribute('aria-valuetext')).toBe('After Fillet 1');
    act(() => void t.documents.getState().undo());
    expect(t.documents.getState().document.parts[0]!.rollbackIndex).toBe(4);
    fireEvent.keyDown(screen.getByRole('slider'), { key: 'End' });
    expect(t.documents.getState().document.parts[0]!.rollbackIndex).toBeNull();
  });

  it('drags a feature to a new place', () => {
    const t = setup();
    const list = screen.getByRole('list', { name: 'Features' });
    fireEvent.pointerDown(t.row('fillet#1'), { button: 0, buttons: 1, clientY: 0, pointerId: 1 });
    fireEvent.pointerMove(list, { buttons: 1, clientY: 100, pointerId: 1 });
    expect(list.className).toContain('dragging');
    fireEvent.pointerUp(list, { button: 0, buttons: 0, clientY: 100, pointerId: 1 });
    expect(t.ids()).toEqual(['sketch#1', 'extrude#1', 'sketch#2', 'extrude#2', 'fillet#1']);
  });

  it('forgets a press released outside the list, so a later hover does not drag', () => {
    const t = setup();
    const list = screen.getByRole('list', { name: 'Features' });
    fireEvent.pointerDown(t.row('fillet#1'), { button: 0, buttons: 1, clientY: 0, pointerId: 1 });
    // Released over the viewport, then the pointer comes back with no button down.
    fireEvent.pointerUp(window, { button: 0, buttons: 0, pointerId: 1 });
    fireEvent.pointerMove(list, { buttons: 0, clientY: 100, pointerId: 1 });
    expect(list.className).not.toContain('dragging');
    fireEvent.pointerUp(list, { button: 0, buttons: 0, clientY: 100, pointerId: 1 });
    expect(t.ids()).toEqual(['sketch#1', 'extrude#1', 'fillet#1', 'sketch#2', 'extrude#2']);
    expect(t.documents.getState().canUndo).toBe(false);
  });

  it('drops a pending press when the pointer moves with no button down', () => {
    const t = setup();
    const list = screen.getByRole('list', { name: 'Features' });
    const bar = screen.getByRole('slider', { name: 'Rollback bar' });
    // The release was never seen (it happened outside the window).
    fireEvent.pointerDown(bar, { button: 0, buttons: 1, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(list, { buttons: 0, clientY: -100, pointerId: 1 });
    expect(list.className).not.toContain('dragging');
    fireEvent.pointerMove(list, { buttons: 1, clientY: -100, pointerId: 1 });
    fireEvent.pointerUp(list, { button: 0, buttons: 0, clientY: -100, pointerId: 1 });
    expect(t.documents.getState().document.parts[0]!.rollbackIndex).toBeNull();
    expect(t.documents.getState().canUndo).toBe(false);
  });

  it('changes nothing while disabled', () => {
    const t = setup({ disabled: true });
    expect(
      (screen.getByRole('button', { name: 'Delete Sketch 1' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.doubleClick(t.row('extrude#1'));
    fireEvent.keyDown(t.row('extrude#2'), { key: 'Delete' });
    expect(t.onEdit).not.toHaveBeenCalled();
    expect(t.ids()).toHaveLength(5);
  });
});
