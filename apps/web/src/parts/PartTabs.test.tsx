import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { demoDocument } from '../model/demo';
import { createDocumentStore } from '../state/document';
import { PART_STUDIO_PANEL_ID, newPartName } from './names';
import { PartTabs } from './PartTabs';

function setup(options: { disabled?: boolean } = {}) {
  const documents = createDocumentStore(demoDocument());
  render(<PartTabs documents={documents} {...options} />);
  const ids = () => documents.getState().document.parts.map((p) => p.id);
  const names = () => screen.getAllByRole('tab').map((t) => t.textContent);
  return { documents, ids, names };
}

const tab = (id: string) => screen.getByTestId(`part-tab-${id}`);
const button = (el: HTMLElement) => el as HTMLButtonElement;

describe('PartTabs', () => {
  it('shows one tab per part studio, the active one selected', () => {
    setup();
    expect(screen.getAllByRole('tab')).toHaveLength(1);
    expect(tab('part#1').getAttribute('aria-selected')).toBe('true');
    expect(button(screen.getByTestId('part-delete')).disabled).toBe(true);
  });

  it('adds a part studio named after its id and makes it active; undo goes back', () => {
    const { documents, names } = setup();
    fireEvent.click(screen.getByTestId('part-add'));
    expect(names()).toEqual(['Demo part', 'Part 2']);
    expect(documents.getState().activePartId).toBe('part#2');
    expect(tab('part#2').getAttribute('aria-selected')).toBe('true');
    expect(documents.getState().undoLabel).toBe('Add Part 2');
    act(() => void documents.getState().undo());
    expect(names()).toEqual(['Demo part']);
    expect(documents.getState().activePartId).toBe('part#1');
    // The undone id is not handed out again.
    fireEvent.click(screen.getByTestId('part-add'));
    expect(names()).toEqual(['Demo part', 'Part 3']);
  });

  it('switches tabs by click and by arrow keys', () => {
    const { documents } = setup();
    fireEvent.click(screen.getByTestId('part-add'));
    fireEvent.click(tab('part#1'));
    expect(documents.getState().activePartId).toBe('part#1');
    fireEvent.keyDown(tab('part#1'), { key: 'ArrowRight' });
    expect(documents.getState().activePartId).toBe('part#2');
    expect(document.activeElement).toBe(tab('part#2'));
  });

  it('renames by double click, Enter commits once, Escape cancels', () => {
    const { documents, names } = setup();
    fireEvent.doubleClick(tab('part#1'));
    const input = screen.getByTestId('part-rename-input');
    fireEvent.change(input, { target: { value: ' Bracket ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(names()).toEqual(['Bracket']);
    expect(documents.core.undoStack).toHaveLength(1);

    fireEvent.click(screen.getByTestId('part-rename'));
    const again = screen.getByTestId('part-rename-input');
    fireEvent.change(again, { target: { value: 'Other' } });
    fireEvent.keyDown(again, { key: 'Escape' });
    expect(names()).toEqual(['Bracket']);
  });

  it('holds only tabs in the tab list, each controlling the part studio panel', () => {
    setup();
    fireEvent.doubleClick(tab('part#1'));
    const list = screen.getByRole('tablist');
    expect(list.contains(screen.getByTestId('part-rename-input'))).toBe(false);
    expect([...list.children].every((c) => c.getAttribute('role') === 'tab')).toBe(true);
    expect(tab('part#1').getAttribute('aria-controls')).toBe(PART_STUDIO_PANEL_ID);
    expect(tab('part#1').id).toBe('part-tab-part#1');
  });

  it('reports a refused rename', () => {
    setup();
    fireEvent.doubleClick(tab('part#1'));
    const input = screen.getByTestId('part-rename-input');
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.blur(input);
    expect(screen.getByTestId('part-tabs-error').textContent).toMatch(/1 to 200 characters/);
  });

  it('duplicates the active part studio next to it, with its features', () => {
    const { documents, names } = setup();
    fireEvent.click(screen.getByTestId('part-add'));
    fireEvent.click(tab('part#1'));
    fireEvent.click(screen.getByTestId('part-duplicate'));
    expect(names()).toEqual(['Demo part', 'Demo part copy', 'Part 2']);
    const [first, copy] = documents.getState().document.parts;
    expect(copy!.features).toEqual(first!.features);
    expect(documents.getState().activePartId).toBe('part#3');
  });

  it('deletes the active part studio; the neighbour becomes active', () => {
    const { documents, ids } = setup();
    fireEvent.click(screen.getByTestId('part-add'));
    fireEvent.click(screen.getByTestId('part-delete'));
    expect(ids()).toEqual(['part#1']);
    expect(documents.getState().activePartId).toBe('part#1');
    // Undo brings the deleted one back and shows it.
    act(() => void documents.getState().undo());
    expect(ids()).toEqual(['part#1', 'part#2']);
    expect(documents.getState().activePartId).toBe('part#2');
  });

  it('refuses to delete a part studio a configuration parameter uses, and says why', () => {
    const { documents } = setup();
    fireEvent.click(screen.getByTestId('part-add'));
    act(() => {
      documents.getState().execute({
        type: 'setConfigParameter',
        parameter: {
          id: 'cp#1',
          name: 'Rounded',
          kind: 'suppression',
          partId: 'part#1',
          featureId: 'fillet#1',
        },
      });
    });
    fireEvent.click(tab('part#1'));
    fireEvent.click(screen.getByTestId('part-delete'));
    expect(screen.getByTestId('part-tabs-error').textContent).toMatch(/cp#1/);
    expect(documents.getState().document.parts).toHaveLength(2);
  });

  it('reorders by drag and drop, and by Alt+arrow', () => {
    const { documents, ids } = setup();
    fireEvent.click(screen.getByTestId('part-add'));
    fireEvent.click(screen.getByTestId('part-add'));
    expect(ids()).toEqual(['part#1', 'part#2', 'part#3']);
    fireEvent.dragStart(tab('part#3'));
    fireEvent.dragOver(tab('part#1'));
    fireEvent.drop(tab('part#1'));
    expect(ids()).toEqual(['part#3', 'part#1', 'part#2']);
    expect(documents.getState().undoLabel).toBe('Move Part 3');
    fireEvent.keyDown(tab('part#3'), { key: 'ArrowRight', altKey: true });
    expect(ids()).toEqual(['part#1', 'part#3', 'part#2']);
  });

  it('adds assemblies as tabs after the part studios, switches, renames and deletes them', () => {
    const { documents, names } = setup();
    fireEvent.click(screen.getByTestId('assembly-add'));
    expect(documents.getState().activeAssemblyId).toBe('assembly#1');
    expect(documents.getState().undoLabel).toBe('Add Assembly 1');
    const assemblyTab = () => screen.getByTestId('assembly-tab-assembly#1');
    expect(assemblyTab().getAttribute('aria-selected')).toBe('true');
    expect(tab('part#1').getAttribute('aria-selected')).toBe('false');
    expect(assemblyTab().getAttribute('aria-controls')).toBe(PART_STUDIO_PANEL_ID);
    // Assemblies cannot be duplicated; they can be deleted even beside a single part studio.
    expect(button(screen.getByTestId('part-duplicate')).disabled).toBe(true);
    expect(button(screen.getByTestId('part-delete')).disabled).toBe(false);

    // Arrow keys run over part studios and assemblies alike.
    fireEvent.keyDown(assemblyTab(), { key: 'ArrowLeft' });
    expect(documents.getState().activeAssemblyId).toBeNull();
    fireEvent.keyDown(tab('part#1'), { key: 'ArrowRight' });
    expect(documents.getState().activeAssemblyId).toBe('assembly#1');

    fireEvent.doubleClick(assemblyTab());
    const input = screen.getByTestId('part-rename-input');
    fireEvent.change(input, { target: { value: 'Chest' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(names()).toEqual(['Demo part', '\u29c9 Chest']);
    expect(documents.getState().undoLabel).toBe('Rename Assembly 1 to Chest');

    fireEvent.click(screen.getByTestId('part-delete'));
    expect(documents.getState().document.assemblies).toEqual([]);
    expect(documents.getState().activeAssemblyId).toBeNull();
    expect(tab('part#1').getAttribute('aria-selected')).toBe('true');
    act(() => void documents.getState().undo());
    expect(documents.getState().activeAssemblyId).toBe('assembly#1');
  });

  it('changes nothing while disabled', () => {
    const documents = createDocumentStore(demoDocument());
    documents.getState().execute({ type: 'addPart', partId: 'part#2', name: 'Two' });
    documents.getState().setActivePart('part#1');
    render(<PartTabs documents={documents} disabled />);
    expect(button(screen.getByTestId('part-add')).disabled).toBe(true);
    expect(button(tab('part#2')).disabled).toBe(true);
    fireEvent.doubleClick(tab('part#1'));
    expect(screen.queryByTestId('part-rename-input')).toBeNull();
    expect(documents.getState().activePartId).toBe('part#1');
  });
});

describe('newPartName', () => {
  it('numbers the part after its id', () => {
    expect(newPartName('part#4')).toBe('Part 4');
    expect(newPartName('lid')).toBe('Part');
  });
});
