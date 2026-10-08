import { findPart } from '@manufakture/core';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createModelStore } from '../model/model';
import { modelBody, twoBodyDocument, twoBodyModel } from '../model/twoBodies.test-fixture';
import { createDocumentStore } from '../state/document';
import { createSelectionStore, geometryRef, type SelectionStore } from '../state/selection';
import { createViewSettingsStore, hiddenBodiesOf } from '../state/viewSettings';
import { BodiesSection } from './BodiesSection';

function setup(bodies = twoBodyModel().bodies, selection?: SelectionStore) {
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
      selection={selection}
      partId="part#1"
      onMessage={(m) => messages.push(m)}
    />,
  );
  const props = () => findPart(documents.getState().document, 'part#1')!.bodies;
  const groups = () => findPart(documents.getState().document, 'part#1')!.bodyGroups;
  const hidden = () => hiddenBodiesOf(settings.getState(), documents.getState().document.id);
  return { documents, model, settings, props, groups, hidden, messages };
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

describe('BodiesSection groups', () => {
  const three = () => [...twoBodyModel().bodies, modelBody('extrude#4', 1, [40, 0, 0])];
  const button = (name: string) => screen.getByRole('button', { name });
  const groupRow = (id: string) => screen.getByTestId(`body-group-${id}`);
  /** Ticks the bodies and groups them, keeping the default name. */
  const group = (...bodyIds: string[]) => {
    for (const id of bodyIds) fireEvent.click(screen.getByTestId(`body-pick-${id}`));
    fireEvent.click(screen.getByTestId('new-body-group'));
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
  };

  it('groups the ticked bodies, names the group and lists them under it; undo takes each back', () => {
    const t = setup(three());
    expect(screen.getByTestId<HTMLButtonElement>('new-body-group').disabled).toBe(true);
    fireEvent.click(screen.getByLabelText('Select Body 1'));
    fireEvent.click(screen.getByTestId('body-pick-extrude#4'));
    fireEvent.click(screen.getByTestId('new-body-group'));
    // Straight into naming it.
    const input = screen.getByLabelText('New name for group Group 1');
    fireEvent.change(input, { target: { value: ' Frame ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(t.groups()).toEqual([
      { id: 'group#1', name: 'Frame', bodies: ['extrude#1', 'extrude#4'] },
    ]);
    const g = groupRow('group#1');
    expect(within(g).getByText('Frame')).toBeTruthy();
    expect(within(g).getByTestId('body-group-count-group#1').textContent).toBe('2 bodies');
    expect(within(g).getByTestId('body-extrude#1')).toBeTruthy();
    expect(within(g).getByTestId('body-extrude#4')).toBeTruthy();
    expect(within(g).queryByTestId('body-extrude#3')).toBeNull();
    // The ticks are used up.
    expect(screen.getByTestId<HTMLInputElement>('body-pick-extrude#1').checked).toBe(false);
    act(() => t.documents.getState().undo());
    expect(t.groups()).toEqual([
      { id: 'group#1', name: 'Group 1', bodies: ['extrude#1', 'extrude#4'] },
    ]);
    act(() => t.documents.getState().undo());
    expect(t.groups()).toBeUndefined();
    expect(screen.queryByTestId('body-group-group#1')).toBeNull();
  });

  it('groups the bodies of the viewport selection when nothing is ticked', () => {
    const selection = createSelectionStore();
    selection
      .getState()
      .select([
        geometryRef('face', 'part#1/extrude#3', 'extrude#3:cap:end'),
        geometryRef('edge', 'part#1/extrude#3', 'extrude#3:side:e1'),
        geometryRef('face', 'assembly#1/inst#1/extrude#1', 'extrude#1:cap:end'),
      ]);
    const t = setup(three(), selection);
    group();
    expect(t.groups()).toEqual([{ id: 'group#1', name: 'Group 1', bodies: ['extrude#3'] }]);
    // Grouping leaves the selection alone.
    expect(selection.getState().selected).toHaveLength(3);
  });

  it('hides, shows and isolates a group as view state; a body hides on its own inside it', () => {
    const t = setup(three());
    group('extrude#1', 'extrude#3');
    fireEvent.click(button('Hide group Group 1'));
    expect([...t.hidden()].sort()).toEqual(['part#1/extrude#1', 'part#1/extrude#3']);
    expect(groupRow('group#1').className).toContain('hidden');
    expect(t.documents.getState().undoLabel).toBe('Group 2 bodies');
    fireEvent.click(button('Show group Group 1'));
    expect(t.hidden()).toEqual([]);

    fireEvent.click(button('Hide Body 2'));
    expect(t.hidden()).toEqual(['part#1/extrude#3']);
    expect(groupRow('group#1').className).toContain('partly-hidden');
    expect(button('Hide group Group 1')).toBeTruthy();
    fireEvent.click(button('Show Body 2'));

    fireEvent.click(button('Isolate group Group 1'));
    expect(t.hidden()).toEqual(['part#1/extrude#4']);
    fireEvent.click(button('Isolate Body 1'));
    expect([...t.hidden()].sort()).toEqual(['part#1/extrude#3', 'part#1/extrude#4']);
    fireEvent.click(button('Show all'));
    expect(t.hidden()).toEqual([]);
    expect(t.documents.getState().undoLabel).toBe('Group 2 bodies');
  });

  it('collapses and expands a group', () => {
    setup(three());
    group('extrude#1', 'extrude#3');
    const toggle = screen.getByTestId('body-group-toggle-group#1');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(button('Collapse Group 1'));
    expect(within(groupRow('group#1')).queryByTestId('body-extrude#1')).toBeNull();
    // The group's own buttons still work while it is collapsed.
    expect(button('Hide group Group 1')).toBeTruthy();
    fireEvent.click(button('Expand Group 1'));
    expect(within(groupRow('group#1')).getByTestId('body-extrude#1')).toBeTruthy();
  });

  it('renames, adds to, removes from and deletes a group; the bodies stay', () => {
    const t = setup(three());
    group('extrude#1');
    fireEvent.click(button('Rename group Group 1'));
    fireEvent.change(screen.getByLabelText('New name for group Group 1'), {
      target: { value: 'Seat' },
    });
    fireEvent.blur(screen.getByLabelText('New name for group Group 1'));
    expect(t.groups()![0]!.name).toBe('Seat');
    // An empty name keeps the old one.
    fireEvent.click(button('Rename group Seat'));
    fireEvent.change(screen.getByLabelText('New name for group Seat'), { target: { value: ' ' } });
    fireEvent.keyDown(screen.getByLabelText('New name for group Seat'), { key: 'Enter' });
    expect(t.groups()![0]!.name).toBe('Seat');

    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Add selected bodies to Seat' })
        .disabled,
    ).toBe(true);
    fireEvent.click(screen.getByTestId('body-pick-extrude#4'));
    fireEvent.click(button('Add selected bodies to Seat'));
    expect(t.groups()![0]!.bodies).toEqual(['extrude#1', 'extrude#4']);

    fireEvent.click(button('Remove Body 1 from Seat'));
    expect(t.groups()![0]!.bodies).toEqual(['extrude#4']);
    expect(within(groupRow('group#1')).queryByTestId('body-extrude#1')).toBeNull();
    expect(row('extrude#1')).toBeTruthy();

    fireEvent.click(button('Delete group Seat'));
    expect(t.groups()).toBeUndefined();
    expect(screen.getAllByTestId(/^body-extrude/)).toHaveLength(3);
    act(() => t.documents.getState().undo());
    expect(t.groups()).toEqual([{ id: 'group#1', name: 'Seat', bodies: ['extrude#4'] }]);
  });

  it('moves a body that joins a new group out of its old one', () => {
    const t = setup(three());
    group('extrude#1', 'extrude#3');
    group('extrude#3');
    expect(t.groups()).toEqual([
      { id: 'group#1', name: 'Group 1', bodies: ['extrude#1'] },
      { id: 'group#2', name: 'Group 2', bodies: ['extrude#3'] },
    ]);
  });

  it('does not show a member regen did not make, and a group with none shown has no Hide', () => {
    const t = setup(three());
    group('extrude#4');
    act(() => {
      t.model.setState({ parts: [{ ...twoBodyModel() }] });
    });
    expect(screen.getByTestId('body-group-count-group#1').textContent).toBe('0 bodies');
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Hide group Group 1' }).disabled,
    ).toBe(true);
    expect(t.groups()![0]!.bodies).toEqual(['extrude#4']);
  });
});
