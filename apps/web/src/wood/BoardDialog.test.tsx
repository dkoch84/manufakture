import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ExtensionFeature } from '@manufakture/core';
import { describe, expect, it, vi } from 'vitest';
import { createDocumentStore } from '../state/document';
import { createSelectionStore, featureItem } from '../state/selection';
import { BoardDialog } from './BoardDialog';
import { INCH_UNITS, woodDocument, woodModel } from './wood.test-fixture';

function setup(
  options: { units?: typeof INCH_UNITS; featureId?: string; select?: string[] } = {},
  documents = createDocumentStore(woodDocument(options.units)),
) {
  const model = woodModel();
  const selection = createSelectionStore();
  if (options.select) selection.getState().select(options.select.map(featureItem));
  const onClose = vi.fn();
  const onPreview = vi.fn();
  const view = render(
    <BoardDialog
      featureId={options.featureId}
      documents={documents}
      model={model}
      selection={selection}
      onPreview={onPreview}
      onClose={onClose}
    />,
  );
  const features = () => documents.getState().document.parts[0]!.features;
  return { documents, onClose, onPreview, features, view };
}

const stockOptions = () =>
  within(screen.getByTestId('field-stock'))
    .getAllByRole('option')
    .map((o) => o.textContent);

describe('the board dialog', () => {
  it('makes a 3/4" plywood panel in an inch document, with its material, as one undo step', () => {
    const t = setup({ units: INCH_UNITS });
    expect(screen.getByRole('dialog', { name: 'Board: New board' })).toBeTruthy();
    // US stock first in an inch document, grouped by kind, sizes in inches.
    expect(screen.getByTestId('stock-region-us').getAttribute('aria-pressed')).toBe('true');
    expect((screen.getByTestId('field-stock') as HTMLSelectElement).value).toBe('us-ply-23-32');
    expect(stockOptions()).toContain('3/4" plywood (23/32") (unverified)');
    expect(stockOptions()).toContain('2x4 (1-1/2" x 3-1/2")');
    expect(screen.getByTestId('stock-unverified').textContent).toContain('Typical size');
    // The preview: the blank it would build, with its grain arrow, drawn in the view.
    expect(screen.getByTestId('board-preview').textContent).toBe(
      'Blank: 23-5/8" x 11-13/16" x 23/32" (length along the grain, width, thickness), shown in the view.',
    );
    expect(t.onPreview).toHaveBeenLastCalledWith(expect.any(Array));
    expect(t.onPreview.mock.lastCall![0]).toHaveLength(6 + 4);

    fireEvent.click(screen.getByTestId('dialog-ok'));
    expect(t.onClose).toHaveBeenCalled();
    const board = t.features().at(-1) as ExtensionFeature;
    expect(board).toMatchObject({
      id: 'extension#1',
      name: 'Board 1',
      extension: 'wood.board',
      params: { form: 'panel', stock: 'us-ply-23-32', sketch: 'sketch#2' },
    });
    expect(t.documents.getState().document.parts[0]!.bodies).toEqual([
      { id: 'extension#1', material: 'plywood' },
    ]);
    t.documents.getState().undo();
    expect(t.features()).toHaveLength(2);
    expect(t.documents.getState().document.parts[0]!.bodies).toEqual([]);
    // Closing clears the preview.
    t.view.unmount();
    expect(t.onPreview).toHaveBeenLastCalledWith([]);
  });

  it('opens on metric stock in a millimetre document; US sizes are one click away', () => {
    setup();
    expect(screen.getByTestId('stock-region-metric').getAttribute('aria-pressed')).toBe('true');
    expect((screen.getByTestId('field-stock') as HTMLSelectElement).value).toBe('mm-ply-18');
    expect(stockOptions()).toContain('18 mm plywood (unverified)');
    fireEvent.click(screen.getByTestId('stock-region-us'));
    expect(stockOptions()).toContain('2x4 (38.10 mm x 88.90 mm)');
    fireEvent.change(screen.getByTestId('field-stock'), { target: { value: 'us-ply-23-32' } });
    expect(screen.getByTestId('stock-summary').textContent).toBe(
      '3/4" plywood: 18.26 mm thick, sheets 2438.40 mm x 1219.20 mm.',
    );
  });

  it('makes a 2x4 stick along a line, turned and justified', () => {
    const t = setup({ units: INCH_UNITS, select: ['sketch#1'] });
    expect((screen.getByTestId('field-form') as HTMLSelectElement).value).toBe('stick');
    // Sticks are cut from lumber: no sheet goods offered.
    expect(stockOptions().some((o) => o?.includes('plywood'))).toBe(false);
    fireEvent.change(screen.getByTestId('field-rotation'), { target: { value: '90' } });
    fireEvent.change(screen.getByTestId('field-justifyWidth'), { target: { value: 'positive' } });
    expect(screen.getByTestId('board-preview').textContent).toContain('96" x 3-1/2" x 1-1/2"');
    fireEvent.click(screen.getByTestId('dialog-ok'));
    expect(t.features().at(-1)).toMatchObject({
      params: {
        form: 'stick',
        stock: 'us-2x4',
        line: 'e1',
        justify: { thickness: 'centre', width: 'positive' },
      },
      expressions: { rotation: { source: '90' } },
    });
  });

  it('shows what is wrong and applies nothing, and Escape cancels', () => {
    const t = setup({ select: ['sketch#1'] });
    fireEvent.change(screen.getByTestId('field-length'), { target: { value: '0' } });
    fireEvent.click(screen.getByTestId('dialog-ok'));
    expect(t.onClose).not.toHaveBeenCalled();
    expect(t.features()).toHaveLength(2);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(t.onClose).toHaveBeenCalled();
    expect(t.features()).toHaveLength(2);
  });

  it('edits a board: its form is read back, and a new stock is one undo step', () => {
    const first = setup({ units: INCH_UNITS });
    fireEvent.click(screen.getByTestId('dialog-ok'));
    first.view.unmount();
    const t = setup({ units: INCH_UNITS, featureId: 'extension#1' }, first.documents);
    expect(screen.getByRole('dialog', { name: 'Board: Board 1' })).toBeTruthy();
    expect((screen.getByTestId('field-grain') as HTMLSelectElement).value).toBe('longest');
    fireEvent.change(screen.getByTestId('field-stock'), { target: { value: 'us-mdf-3-4' } });
    // MDF has no grain: no arrow in the preview, and a note says what the direction is for.
    expect(t.onPreview.mock.lastCall![0]).toHaveLength(6);
    expect(screen.getByRole('dialog').textContent).toContain('has no grain');
    fireEvent.click(screen.getByTestId('dialog-ok'));
    const doc = t.documents.getState().document;
    expect(doc.parts[0]!.features).toHaveLength(3);
    expect(doc.parts[0]!.bodies).toEqual([{ id: 'extension#1', material: 'mdf' }]);
    t.documents.getState().undo();
    expect(t.documents.getState().document.parts[0]!.bodies).toEqual([
      { id: 'extension#1', material: 'plywood' },
    ]);
  });

  it('offers no editing for a board this build cannot read', () => {
    const documents = createDocumentStore(woodDocument());
    const r = documents.getState().execute(
      {
        type: 'addFeature',
        partId: 'part#1',
        feature: {
          id: 'extension#1',
          kind: 'extension',
          name: 'Board 1',
          suppressed: false,
          extension: 'wood.board',
          schemaVersion: 7,
          operation: 'new',
          dependsOn: ['sketch#2'],
          references: [],
          expressions: {},
          params: { form: 'panel', stock: 'mm-ply-18', sketch: 'sketch#2' },
        },
      },
      'Add',
    );
    expect(r.ok).toBe(true);
    const t = setup({ featureId: 'extension#1' }, documents);
    expect(screen.getByRole('alert').textContent).toContain('cannot be edited here');
    expect(screen.queryByTestId('dialog-ok')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(t.onClose).toHaveBeenCalled();
  });
});
