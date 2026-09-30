import { fireEvent, render, screen, within } from '@testing-library/react';
import { applyCommand } from '@manufakture/core';
import { describe, expect, it } from 'vitest';
import { createDocumentStore } from '../state/document';
import { createSelectionStore } from '../state/selection';
import { boxDocument } from './box.test-fixture';
import { VariablesPanel } from './VariablesPanel';

function setup(doc = boxDocument()) {
  const documents = createDocumentStore(doc);
  const selection = createSelectionStore();
  render(<VariablesPanel documents={documents} selection={selection} />);
  const variables = () =>
    Object.fromEntries(
      documents.getState().document.variables.map((v) => [v.name, v.expression.source]),
    );
  return { documents, selection, variables };
}

const typeIn = (testId: string, value: string) => {
  const input = screen.getByTestId(testId) as HTMLInputElement;
  fireEvent.change(input, { target: { value } });
  input.setSelectionRange(value.length, value.length);
  fireEvent.select(input);
  return input;
};

describe('the Variables panel', () => {
  it('lists every variable with its expression, type, value and uses', () => {
    setup();
    const w = screen.getByTestId('variable-w');
    expect(within(w).getByText('#w')).toBeDefined();
    expect(screen.getByTestId('variable-h-value').textContent).toBe('15.00 mm');
    const h = screen.getByTestId('variable-h');
    expect(h.textContent).toContain('#d - 10mm');
    expect(h.textContent).toContain('Length');
    expect(screen.getByTestId('variable-d-uses').textContent).toBe(
      'Used in 2 places#hSketch 1: dimension k4',
    );
  });

  it('adds a variable as one undo step, with completion of the names it reads', () => {
    const t = setup();
    fireEvent.click(screen.getByTestId('variable-add'));
    expect(document.activeElement).toBe(screen.getByTestId('variable-name'));
    typeIn('variable-name', 'wall');
    const value = typeIn('variable-expression', '#');
    const list = screen.getByTestId('variable-expression-options');
    expect(
      within(list)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['#w40.00 mm', '#d25.00 mm', '#h15.00 mm', '#r2.00 mm']);
    fireEvent.keyDown(value, { key: 'Enter' }); // takes the completion, does not save
    expect(value.value).toBe('#w');
    expect(screen.getByTestId('variable-editor')).toBeDefined();
    typeIn('variable-expression', '#w / 8');
    expect(screen.getByTestId('variable-expression-note').textContent).toBe('= 5.00 mm');
    fireEvent.click(screen.getByTestId('variable-save'));
    expect(screen.queryByTestId('variable-editor')).toBeNull();
    expect(t.variables().wall).toBe('#w / 8');
    expect(t.documents.getState().undoLabel).toBe('Add variable #wall');
    expect(screen.getByTestId('variable-wall-value').textContent).toBe('5.00 mm');
  });

  it('writes the unit into a bare length', () => {
    const t = setup();
    fireEvent.click(screen.getByTestId('variable-add'));
    typeIn('variable-name', 'gap');
    typeIn('variable-expression', '3');
    fireEvent.submit(screen.getByTestId('variable-save').closest('form')!);
    expect(t.variables().gap).toBe('3 mm');
  });

  it('edits a value, and the change is one undo step', () => {
    const t = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Edit #w' }));
    expect((screen.getByTestId('variable-expression') as HTMLInputElement).value).toBe('40 mm');
    typeIn('variable-expression', '50 mm');
    fireEvent.click(screen.getByTestId('variable-save'));
    expect(t.variables().w).toBe('50 mm');
    expect(t.documents.getState().undoLabel).toBe('Edit variable #w');
    expect(screen.getByTestId('variable-w-value').textContent).toBe('50.00 mm');
  });

  it('rejects variables that read each other, at once, with a clear message', () => {
    const t = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Edit #d' }));
    typeIn('variable-expression', '#h + 1mm');
    const note = screen.getByTestId('variable-expression-note');
    expect(note.textContent).toBe('Variables cannot read each other in a loop: #d -> #h -> #d.');
    fireEvent.click(screen.getByTestId('variable-save'));
    expect(screen.getByTestId('variable-editor')).toBeDefined();
    expect(t.variables().d).toBe('25 mm');
    expect(t.documents.getState().canUndo).toBe(false);
  });

  it('shows name and type problems on Save, and Escape cancels', () => {
    const t = setup();
    fireEvent.click(screen.getByTestId('variable-add'));
    typeIn('variable-name', 'w');
    typeIn('variable-expression', '30deg');
    fireEvent.click(screen.getByTestId('variable-save'));
    const editor = screen.getByTestId('variable-editor');
    expect(editor.textContent).toContain('There is already a variable #w.');
    expect(screen.getByTestId('variable-expression-note').textContent).toBe(
      'This is an angle, not a length: change the type or the value.',
    );
    fireEvent.change(screen.getByTestId('variable-type'), { target: { value: 'angle' } });
    expect(screen.getByTestId('variable-expression-note').textContent).toBe('= 30.00°');
    fireEvent.keyDown(screen.getByTestId('variable-name'), { key: 'Escape' });
    expect(screen.queryByTestId('variable-editor')).toBeNull();
    expect(Object.keys(t.variables())).toEqual(['w', 'd', 'h', 'r']);
  });

  it('renames a variable and its uses as one undo step', () => {
    const t = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Edit #d' }));
    typeIn('variable-name', 'depth');
    fireEvent.click(screen.getByTestId('variable-save'));
    expect(t.variables()).toEqual({ w: '40 mm', depth: '25 mm', h: '#depth - 10mm', r: '2 mm' });
    expect(t.documents.getState().undoLabel).toBe('Rename variable #d to #depth');
    t.documents.getState().undo();
    expect(t.variables()).toEqual({ w: '40 mm', d: '25 mm', h: '#d - 10mm', r: '2 mm' });
  });

  it('deletes an unused variable, and offers to replace the uses of one in use', () => {
    const t = setup();
    fireEvent.click(screen.getByTestId('variable-add'));
    typeIn('variable-name', 'spare');
    typeIn('variable-expression', '1');
    fireEvent.click(screen.getByTestId('variable-save'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete #spare' }));
    expect(t.variables().spare).toBeUndefined();

    fireEvent.click(screen.getByRole('button', { name: 'Delete #d' }));
    const blocked = screen.getByTestId('variable-blocked');
    expect(blocked.getAttribute('role')).toBe('alert');
    expect(blocked.textContent).toContain('#d is used in 2 places');
    expect(blocked.textContent).toContain('Sketch 1: dimension k4');
    expect(t.variables().d).toBe('25 mm');

    // A use selects its feature.
    fireEvent.click(within(blocked).getByRole('button', { name: 'Sketch 1: dimension k4' }));
    expect(t.selection.getState().selected).toEqual([{ kind: 'feature', id: 'sketch#1' }]);

    fireEvent.click(screen.getByTestId('variable-replace'));
    expect(t.variables()).toEqual({ w: '40 mm', h: '(25mm) - 10mm', r: '2 mm' });
    expect(t.documents.getState().undoLabel).toBe('Replace #d with 25mm');
    t.documents.getState().undo();
    expect(t.variables().d).toBe('25 mm');
  });

  it('warns before replacing a configured variable with its value', () => {
    let doc = boxDocument();
    for (const command of [
      {
        type: 'setConfigParameter' as const,
        parameter: { id: 'cp#1', name: 'Depth', kind: 'variable' as const, variable: 'd' },
      },
      {
        type: 'setConfigRow' as const,
        row: {
          id: 'cfg#1',
          name: 'Deep',
          values: {
            'cp#1': { source: '50 mm', lengthUnit: 'mm' as const, angleUnit: 'deg' as const },
          },
        },
      },
      { type: 'setActiveConfiguration' as const, rowId: 'cfg#1' },
    ]) {
      const r = applyCommand(doc, command);
      if (!r.ok) throw new Error(r.error.message);
      doc = r.value.document;
    }
    const t = setup(doc);
    // The table says the variable is configured, and its value in the shown row.
    expect(screen.getByTestId('variable-d').textContent).toContain('Configured');
    expect(screen.getByTestId('variable-d-configured').textContent).toBe('In Deep: 50.00 mm');
    // #h reads #d, so the row changes it too.
    expect(screen.getByTestId('variable-h-configured').textContent).toBe('In Deep: 40.00 mm');
    expect(screen.queryByTestId('variable-w-configured')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Delete #d' }));
    expect(screen.getByTestId('variable-inline-warning').textContent).toBe(
      "#d is set by the configuration table (parameter Depth). Replacing it with its value deletes that parameter, and its value in configuration Deep: every configuration then gets the document's own value.",
    );
    const replace = screen.getByTestId('variable-replace');
    expect(replace.textContent).toBe('Replace with value, delete it and its parameter');
    fireEvent.click(replace);
    expect(t.variables().d).toBeUndefined();
    expect(t.documents.getState().document.configurations!.parameters).toEqual([]);
  });

  it('gives no warning for a variable the table does not configure', () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: 'Delete #d' }));
    expect(screen.queryByTestId('variable-inline-warning')).toBeNull();
  });
});
