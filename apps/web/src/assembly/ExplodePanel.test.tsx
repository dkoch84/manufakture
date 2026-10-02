import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createDocumentStore } from '../state/document';
import { createSelectionStore, geometryRef } from '../state/selection';
import { A, result, twoInstances } from './assembly.test-fixture';
import { ExplodePanel } from './ExplodePanel';
import { createAssemblyUiStore } from './state';

function setup() {
  const documents = createDocumentStore(twoInstances());
  const assemblyUi = createAssemblyUiStore();
  const selection = createSelectionStore();
  const onClose = vi.fn();
  render(
    <ExplodePanel
      documents={documents}
      assemblyId={A}
      assemblyUi={assemblyUi}
      result={result()}
      selection={selection}
      onClose={onClose}
    />,
  );
  const views = () => documents.getState().document.assemblies[0]!.explodedViews ?? [];
  return { documents, assemblyUi, selection, onClose, views };
}

const input = (id: string) => screen.getByTestId(id) as HTMLInputElement;

describe('ExplodePanel', () => {
  it('makes an exploded view and adds steps along an axis, one undoable command each', () => {
    const s = setup();
    expect(screen.getByTestId('explode-empty')).toBeTruthy();
    fireEvent.click(screen.getByTestId('explode-new'));
    expect(s.views().map((v) => v.name)).toEqual(['Exploded view 1']);
    expect(s.documents.getState().undoLabel).toBe('Add Exploded view 1');

    // Nothing ticked: the panel says what to do.
    fireEvent.click(screen.getByTestId('explode-add-step'));
    expect(screen.getByTestId('explode-message').textContent).toContain('Tick the instances');

    fireEvent.click(screen.getByTestId('explode-instance-inst#2'));
    fireEvent.change(input('explode-distance'), { target: { value: '30' } });
    fireEvent.click(screen.getByTestId('explode-add-step'));
    fireEvent.click(screen.getByTestId('explode-instance-inst#1'));
    fireEvent.change(screen.getByTestId('explode-axis'), { target: { value: '-x' } });
    fireEvent.change(input('explode-distance'), { target: { value: '12' } });
    fireEvent.click(screen.getByTestId('explode-add-step'));
    const steps = s.views()[0]!.steps;
    expect(steps.map((x) => [x.instances, x.direction, x.distance.source])).toEqual([
      [['inst#2'], { vector: [0, 0, 1] }, '30'],
      [['inst#1', 'inst#2'], { vector: [-1, 0, 0] }, '12'],
    ]);
    expect(s.documents.getState().undoLabel).toBe('Add step 2 to Exploded view 1');
    expect(screen.getByTestId('explode-step-direction-step#2').textContent).toBe('-X');
    expect(screen.getByTestId('explode-step-step#2').textContent).toContain('2. Box 1, Lid 1');

    // A bad distance is not added.
    fireEvent.change(input('explode-distance'), { target: { value: '12 +' } });
    fireEvent.click(screen.getByTestId('explode-add-step'));
    expect(s.views()[0]!.steps).toHaveLength(2);
  });

  it('reorders, edits and deletes steps, and plays them with the slider', () => {
    const s = setup();
    fireEvent.click(screen.getByTestId('explode-new'));
    fireEvent.click(screen.getByTestId('explode-instance-inst#2'));
    fireEvent.click(screen.getByTestId('explode-add-step'));
    fireEvent.change(screen.getByTestId('explode-axis'), { target: { value: '+y' } });
    fireEvent.click(screen.getByTestId('explode-add-step'));
    expect((screen.getByTestId('explode-step-up-step#1') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('explode-step-up-step#2'));
    expect(s.views()[0]!.steps.map((x) => x.id)).toEqual(['step#2', 'step#1']);

    const distance = input('explode-step-distance-step#1');
    fireEvent.change(distance, { target: { value: '75' } });
    fireEvent.keyDown(distance, { key: 'Enter' });
    expect(s.views()[0]!.steps[1]!.distance.source).toBe('75');
    expect(s.documents.getState().undoLabel).toBe('Edit step 2 of Exploded view 1');

    fireEvent.change(screen.getByTestId('explode-progress'), { target: { value: '40' } });
    expect(s.assemblyUi.getState().explode.progress).toBeCloseTo(0.4, 12);
    expect(screen.getByTestId('explode-progress-value').textContent).toBe('40%');

    fireEvent.click(screen.getByTestId('explode-step-delete-step#2'));
    expect(s.views()[0]!.steps.map((x) => x.id)).toEqual(['step#1']);
    act(() => {
      s.documents.getState().undo();
    });
    expect(screen.getByTestId('explode-step-step#2')).toBeTruthy();
  });

  it('ticks the instances selected in the view, shows step warnings and closes', () => {
    const s = setup();
    fireEvent.click(screen.getByTestId('explode-new'));
    act(() => {
      s.selection
        .getState()
        .select([geometryRef('face', `${A}/inst#1/extrude#1`, 'extrude#1:cap:end')]);
    });
    fireEvent.click(screen.getByTestId('explode-use-selection'));
    expect(s.assemblyUi.getState().explode.checked).toEqual(['inst#1']);
    expect(input('explode-instance-inst#1').checked).toBe(true);
    expect(input('explode-instance-inst#2').checked).toBe(false);
    fireEvent.keyDown(screen.getByTestId('explode-panel'), { key: 'Escape' });
    expect(s.onClose).toHaveBeenCalled();
  });

  it('lists what regen said about a step', () => {
    const documents = createDocumentStore(twoInstances());
    const assemblyUi = createAssemblyUiStore();
    documents.getState().execute(
      {
        type: 'addExplodedView',
        assemblyId: A,
        explodedView: {
          id: 'explode#1',
          name: 'Apart',
          steps: [
            {
              id: 'step#1',
              instances: ['inst#2'],
              direction: { instance: 'inst#1', face: { face: 'gone' } },
              distance: { source: '5', lengthUnit: 'mm', angleUnit: 'deg' },
            },
          ],
        },
      },
      'Add',
    );
    const r = result({
      explodedViews: [
        {
          explodedViewId: 'explode#1',
          name: 'Apart',
          steps: [
            {
              stepId: 'step#1',
              instances: ['inst#2'],
              direction: null,
              distance: 5,
              warnings: [{ code: 'direction', reason: 'lost', message: 'Step 1: gone is lost' }],
            },
          ],
        },
      ],
    });
    render(
      <ExplodePanel
        documents={documents}
        assemblyId={A}
        assemblyUi={assemblyUi}
        result={r}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByTestId('explode-step-step#1').textContent).toContain('Step 1: gone is lost');
    expect(screen.getByTestId('explode-step-direction-step#1').textContent).toBe(
      'along face of Box 1',
    );
    // Without a selection store there is nothing to take the instances from.
    expect(screen.queryByTestId('explode-use-selection')).toBeNull();
  });
});
