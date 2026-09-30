import { findPart } from '@manufakture/core';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createModelStore } from '../model/model';
import { modelBody, twoBodyDocument, twoBodyModel } from '../model/twoBodies.test-fixture';
import { createDocumentStore } from '../state/document';
import { createViewSettingsStore, hiddenBodiesOf } from '../state/viewSettings';
import { BodiesSection } from './BodiesSection';

function setup(bodies = twoBodyModel().bodies) {
  const documents = createDocumentStore(twoBodyDocument());
  const model = createModelStore();
  model.setState({
    available: true,
    generation: 1,
    document: documents.getState().document,
    parts: [{ ...twoBodyModel(), bodies }],
  });
  const settings = createViewSettingsStore(() => sessionStorage);
  const messages: (string | null)[] = [];
  render(
    <BodiesSection
      documents={documents}
      model={model}
      settings={settings}
      partId="part#1"
      onMessage={(m) => messages.push(m)}
    />,
  );
  const props = () => findPart(documents.getState().document, 'part#1')!.bodies;
  const hidden = () => hiddenBodiesOf(settings.getState(), documents.getState().document.id);
  return { documents, model, settings, props, hidden, messages };
}

const row = (bodyId: string) => screen.getByTestId(`body-${bodyId}`);

describe('BodiesSection', () => {
  it('lists every body with its name, colour, material and solid count', () => {
    setup();
    const section = screen.getByRole('region', { name: 'Bodies' });
    expect(within(section).getAllByRole('listitem')).toHaveLength(2);
    expect(within(row('extrude#1')).getByText('Body 1')).toBeTruthy();
    expect(within(row('extrude#3')).getByText('Body 2')).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>('Colour of Body 1').value).toBe('#c2cad3');
    // Only a body of several pieces says how many.
    expect(within(row('extrude#1')).queryByText(/solids/)).toBeNull();
    expect(within(row('extrude#3')).getByText('2 solids')).toBeTruthy();
    expect(screen.getByLabelText<HTMLSelectElement>('Material of Body 2').value).toBe('');
  });

  it('lists nothing for a part without bodies', () => {
    setup([]);
    expect(screen.queryByRole('region', { name: 'Bodies' })).toBeNull();
  });

  it('renames, colours and sets a material, each one undo step', () => {
    const t = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Rename Body 2' }));
    const input = screen.getByLabelText('New name for Body 2');
    fireEvent.change(input, { target: { value: '  Lid ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(t.props()).toEqual([{ id: 'extrude#3', name: 'Lid' }]);
    expect(within(row('extrude#3')).getByText('Lid')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Colour of Lid'), { target: { value: '#FF8800' } });
    expect(t.props()).toEqual([{ id: 'extrude#3', name: 'Lid', color: '#ff8800' }]);

    fireEvent.change(screen.getByLabelText('Material of Lid'), { target: { value: 'petg' } });
    expect(t.props()).toEqual([
      { id: 'extrude#3', name: 'Lid', color: '#ff8800', material: 'petg' },
    ]);
    expect(t.documents.getState().undoLabel).toBe('Set Lid to PETG');

    act(() => t.documents.getState().undo());
    act(() => t.documents.getState().undo());
    expect(t.props()).toEqual([{ id: 'extrude#3', name: 'Lid' }]);
    act(() => t.documents.getState().undo());
    expect(t.props()).toEqual([]);
    expect(within(row('extrude#3')).getByText('Body 2')).toBeTruthy();
  });

  it('an empty name goes back to the default one; an unchanged one records nothing', () => {
    const t = setup();
    fireEvent.doubleClick(within(row('extrude#1')).getByText('Body 1'));
    fireEvent.blur(screen.getByLabelText('New name for Body 1'));
    expect(t.documents.getState().canUndo).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Rename Body 1' }));
    fireEvent.change(screen.getByLabelText('New name for Body 1'), { target: { value: 'Base' } });
    fireEvent.blur(screen.getByLabelText('New name for Body 1'));
    expect(t.props()).toEqual([{ id: 'extrude#1', name: 'Base' }]);
    fireEvent.click(screen.getByRole('button', { name: 'Rename Base' }));
    fireEvent.change(screen.getByLabelText('New name for Base'), { target: { value: '' } });
    fireEvent.keyDown(screen.getByLabelText('New name for Base'), { key: 'Enter' });
    expect(t.props()).toEqual([]);
  });

  it('hides, shows and isolates bodies as view state, not as an undo step', () => {
    const t = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Hide Body 2' }));
    expect(t.hidden()).toEqual(['part#1/extrude#3']);
    expect(row('extrude#3').className).toContain('hidden');
    expect(t.documents.getState().canUndo).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Show Body 2' }));
    expect(t.hidden()).toEqual([]);

    fireEvent.click(screen.getByRole('button', { name: 'Isolate Body 2' }));
    expect(t.hidden()).toEqual(['part#1/extrude#1']);
    fireEvent.click(screen.getByRole('button', { name: 'Show all' }));
    expect(t.hidden()).toEqual([]);
    expect(screen.queryByRole('button', { name: 'Show all' })).toBeNull();
    expect(t.documents.getState().canUndo).toBe(false);
  });

  it('offers no isolate for a single body and names it after the part', () => {
    setup([modelBody('extrude#1')]);
    expect(within(row('extrude#1')).getByText('Demo part')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Isolate/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Hide Demo part' })).toBeTruthy();
  });

  it('names the part material as the default', () => {
    const t = setup();
    act(() => {
      t.documents.getState().execute({ type: 'setMaterial', partId: 'part#1', material: 'pla' });
    });
    const select = screen.getByLabelText<HTMLSelectElement>('Material of Body 1');
    expect(select.options[0]!.textContent).toBe('Part material (PLA)');
  });
});
