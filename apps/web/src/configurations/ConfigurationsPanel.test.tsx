import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createDocumentStore } from '../state/document';
import { boxDocument } from '../variables/box.test-fixture';
import { ConfigurationsPanel } from './ConfigurationsPanel';
import { ConfigurationSwitcher } from './ConfigurationSwitcher';

function setup(disabled = false) {
  const documents = createDocumentStore(boxDocument());
  render(
    <>
      <ConfigurationSwitcher documents={documents} />
      <ConfigurationsPanel documents={documents} disabled={disabled} />
    </>,
  );
  const table = () => documents.getState().document.configurations;
  return { documents, table };
}

const typeIn = (input: HTMLElement, value: string) => {
  fireEvent.change(input, { target: { value } });
};

/** Add a #w parameter and rows 600, 800 and 1000 through the panel. */
function build() {
  const t = setup();
  fireEvent.change(screen.getByTestId('config-add-parameter'), { target: { value: 'v:w' } });
  for (const name of ['600', '800', '1000']) {
    fireEvent.click(screen.getByTestId('config-add-row'));
    const n = t.table()!.rows.length;
    const input = screen.getByLabelText(`Name of configuration Configuration ${n}`);
    typeIn(input, name);
    fireEvent.keyDown(input, { key: 'Enter' });
  }
  return t;
}

describe('the Configurations panel', () => {
  it('starts empty, with a hint, and no switcher', () => {
    setup();
    expect(screen.getByText(/Variants of this design/)).toBeDefined();
    expect(screen.queryByTestId('configuration-switcher')).toBeNull();
  });

  it('adds parameters from variables and features, and rows, one undo step each', () => {
    const t = build();
    expect(t.table()!.parameters).toEqual([
      { id: 'cp#1', name: 'w', kind: 'variable', variable: 'w' },
    ]);
    expect(t.table()!.rows.map((r) => r.name)).toEqual(['600', '800', '1000']);
    expect(t.documents.getState().undoLabel).toBe('Rename configuration Configuration 3 to 1000');
    // #w is taken: it is no longer offered.
    const add = screen.getByTestId('config-add-parameter');
    expect(within(add).queryByText('#w')).toBeNull();
    fireEvent.change(add, { target: { value: 'f:part#1:fillet#1' } });
    expect(t.table()!.parameters[1]).toMatchObject({
      kind: 'suppression',
      featureId: 'fillet#1',
      name: 'Fillet 1 suppressed',
    });
    expect(screen.getByTestId('config-param-cp#2').textContent).toContain('Fillet 1');
  });

  it('edits a value on Enter; a wrong kind of value is not taken; undo puts it back', () => {
    const t = build();
    const cell = screen.getByTestId('config-cell-cfg#1-cp#1');
    typeIn(cell, '600');
    fireEvent.keyDown(cell, { key: 'Enter' });
    fireEvent.blur(cell);
    // A bare number for a length gets its unit written in.
    expect(t.table()!.rows[0]!.values['cp#1']).toMatchObject({ source: '600 mm' });
    expect(t.documents.getState().undoLabel).toBe('Set w in configuration 600');

    // An angle is not a width: shown, not stored.
    const other = screen.getByTestId('config-cell-cfg#2-cp#1');
    typeIn(other, '30 deg');
    fireEvent.blur(other);
    expect(t.table()!.rows[1]!.values).toEqual({});
    expect(other.getAttribute('aria-invalid')).toBe('true');

    act(() => void t.documents.getState().undo());
    expect(t.table()!.rows[0]!.values).toEqual({});
    expect((screen.getByTestId('config-cell-cfg#1-cp#1') as HTMLInputElement).value).toBe('');
    // An empty cell shows the document's own value.
    const row = screen.getByTestId('config-row-cfg#1');
    expect(row.textContent).toContain('As modelled: 40 mm');
  });

  it('clears a value when the cell is emptied', () => {
    const t = build();
    const cell = screen.getByTestId('config-cell-cfg#3-cp#1');
    typeIn(cell, '1000 mm');
    fireEvent.blur(cell);
    expect(t.table()!.rows[2]!.values['cp#1']).toMatchObject({ source: '1000 mm' });
    const again = screen.getByTestId('config-cell-cfg#3-cp#1');
    typeIn(again, '');
    fireEvent.blur(again);
    expect(t.table()!.rows[2]!.values).toEqual({});
  });

  it('sets a suppression per row: suppressed, not, or as modelled', () => {
    const t = setup();
    fireEvent.change(screen.getByTestId('config-add-parameter'), {
      target: { value: 'f:part#1:fillet#1' },
    });
    fireEvent.click(screen.getByTestId('config-add-row'));
    const select = screen.getByLabelText('Fillet 1 suppressed in Configuration 1');
    fireEvent.change(select, { target: { value: 'on' } });
    expect(t.table()!.rows[0]!.values).toEqual({ 'cp#1': true });
    fireEvent.change(select, { target: { value: 'off' } });
    expect(t.table()!.rows[0]!.values).toEqual({ 'cp#1': false });
    fireEvent.change(select, { target: { value: '' } });
    expect(t.table()!.rows[0]!.values).toEqual({});
  });

  it('refuses a duplicate name and keeps the old one', () => {
    const t = build();
    const input = screen.getByLabelText('Name of configuration 800');
    typeIn(input, '600');
    expect(screen.getByText('There is already a configuration named "600".')).toBeDefined();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(t.table()!.rows[1]!.name).toBe('800');
    fireEvent.keyDown(input, { key: 'Escape' });
    expect((input as HTMLInputElement).value).toBe('800');
  });

  it('shows a row from the panel or the switcher, and deletes rows and parameters', () => {
    const t = build();
    const switcher = screen.getByTestId('configuration-switcher') as HTMLSelectElement;
    expect([...switcher.options].map((o) => o.text)).toEqual([
      'None (as modelled)',
      '600',
      '800',
      '1000',
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Show 800' }));
    expect(t.table()!.active).toBe('cfg#2');
    expect(switcher.value).toBe('cfg#2');
    expect(screen.getByTestId('config-row-cfg#2-shown')).toBeDefined();
    fireEvent.change(switcher, { target: { value: 'cfg#3' } });
    expect(t.table()!.active).toBe('cfg#3');
    expect(t.documents.getState().undoLabel).toBe('Show configuration 1000');
    fireEvent.change(switcher, { target: { value: '' } });
    expect(t.table()!.active).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Delete configuration 600' }));
    expect(t.table()!.rows.map((r) => r.name)).toEqual(['800', '1000']);
    fireEvent.click(screen.getByRole('button', { name: 'Delete parameter w' }));
    expect(t.table()!.parameters).toEqual([]);
  });

  it('changes nothing while disabled', () => {
    setup(true);
    expect((screen.getByTestId('config-add-row') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('config-add-parameter') as HTMLSelectElement).disabled).toBe(true);
  });

  it('says when the active row cannot be applied', () => {
    const documents = createDocumentStore(boxDocument());
    render(
      <ConfigurationsPanel
        documents={documents}
        configurationError="The active configuration cannot be applied"
      />,
    );
    expect(screen.getByTestId('config-model-error').textContent).toBe(
      'The active configuration cannot be applied',
    );
  });
});
