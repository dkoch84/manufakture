import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { twoBodyDocument } from '../model/twoBodies.test-fixture';
import { createDocumentStore } from '../state/document';
import { createMeasureStore } from '../state/measure';
import { twoFaces } from './fixtures';
import { MeasurePanel, type MeasuredBody } from './MeasurePanel';

const BODIES: MeasuredBody[] = [
  { viewId: 'part#1/extrude#1', name: 'Base', material: null },
  { viewId: 'part#1/extrude#3', name: 'Lid', material: 'petg' },
];

function setup(selected: number) {
  const documents = createDocumentStore(twoBodyDocument());
  const measure = createMeasureStore();
  const result = twoFaces();
  const lid = { ...result.body!, volume: 1000 };
  measure.setState({
    status: 'ready',
    request: {
      bodyId: selected > 0 ? 'part#1/extrude#3' : 'part#1/extrude#1',
      targets: Array.from({ length: selected }, (_, i) => ({ kind: 'face', index: i + 1 })),
      revision: 1,
    },
    result: selected > 0 ? { ...result, body: lid } : result,
    bodies:
      selected > 0
        ? []
        : [
            { bodyId: 'part#1/extrude#1', body: result.body },
            { bodyId: 'part#1/extrude#3', body: lid },
          ],
  });
  render(<MeasurePanel measure={measure} documents={documents} bodies={BODIES} />);
  return { documents };
}

describe('MeasurePanel with several bodies', () => {
  it('lists every body with nothing selected, each weighed in its own material', () => {
    const t = setup(0);
    expect(screen.queryByTestId('measure-body')).toBeNull();
    const base = screen.getByTestId('measure-body1');
    const lid = screen.getByTestId('measure-body2');
    expect(within(base).getByRole('heading').textContent).toBe('Base');
    expect(within(lid).getByRole('heading').textContent).toBe('Lid');
    expect(screen.getByTestId('measure-value-body2.volume').textContent).toBe('1000.00 mm³');
    // PETG, 1270 kg/m3: 1.27 g for 1 cm3. The base has no material, so no mass.
    expect(screen.getByTestId('measure-value-body2.mass').textContent).toBe('1.27 g');
    expect(screen.queryByTestId('measure-value-body1.mass')).toBeNull();
    // The part material is every body's default.
    fireEvent.change(screen.getByLabelText('Part material'), { target: { value: 'pla' } });
    expect(t.documents.getState().document.parts[0]!.material).toBe('pla');
  });

  it('shows the body of the selection, by name, with its material', () => {
    setup(1);
    const body = screen.getByTestId('measure-body');
    expect(within(body).getByRole('heading').textContent).toBe('Body: Lid');
    expect(screen.getByTestId('measure-value-body.mass').textContent).toBe('1.27 g');
  });
});
