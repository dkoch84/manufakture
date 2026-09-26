import { createDocument, type Command } from '@manufakture/core';
import { describe, expect, it, vi } from 'vitest';
import { createDocumentStore, historyShortcut, isTextField } from './document';

const addVariable = (name: string, source = '5 mm'): Command => ({
  type: 'setVariable',
  name,
  expression: { source, lengthUnit: 'mm', angleUnit: 'deg' },
});

describe('the document store', () => {
  it('applies commands as undo steps and tracks what undo and redo would do', () => {
    const store = createDocumentStore(createDocument({ id: 'd', name: 'D' }));
    expect(store.getState()).toMatchObject({ canUndo: false, canRedo: false, undoLabel: null });

    expect(store.getState().execute(addVariable('a'), 'Add a').ok).toBe(true);
    expect(store.getState().execute(addVariable('b'), 'Add b').ok).toBe(true);
    expect(store.getState()).toMatchObject({ canUndo: true, canRedo: false, undoLabel: 'Add b' });
    expect(store.getState().document.variables.map((v) => v.name)).toEqual(['a', 'b']);

    store.getState().undo();
    expect(store.getState()).toMatchObject({
      undoLabel: 'Add a',
      redoLabel: 'Add b',
      canRedo: true,
    });
    expect(store.getState().document.variables.map((v) => v.name)).toEqual(['a']);
    store.getState().redo();
    expect(store.getState().document.variables.map((v) => v.name)).toEqual(['a', 'b']);
  });

  it('keeps a refused command out of the history and reports it', () => {
    const store = createDocumentStore(createDocument({ id: 'd', name: 'D' }));
    const r = store.getState().execute(addVariable('x', '2 * #missing'));
    expect(r.ok).toBe(false);
    expect(store.getState().lastError?.code).toBe('unknown-variable');
    expect(store.getState().canUndo).toBe(false);
    store.getState().execute(addVariable('x'));
    expect(store.getState().lastError).toBeNull();
  });

  it('clears the history when a document is loaded', () => {
    const store = createDocumentStore(createDocument({ id: 'd', name: 'D' }));
    store.getState().execute(addVariable('a'));
    store.getState().load(createDocument({ id: 'e', name: 'E' }));
    expect(store.getState()).toMatchObject({ canUndo: false, document: { id: 'e' } });
  });

  it('shares every change with subscribers of the core store', () => {
    const store = createDocumentStore(createDocument({ id: 'd', name: 'D' }));
    const events = vi.fn();
    store.core.subscribe((e) => events(e.cause, e.label));
    store.getState().execute(addVariable('a'), 'Add a');
    store.getState().undo();
    expect(events.mock.calls).toEqual([
      ['execute', 'Add a'],
      ['undo', 'Add a'],
    ]);
    // A change made on the core store directly still reaches the React side.
    store.core.execute(addVariable('z'));
    expect(store.getState().document.variables.map((v) => v.name)).toEqual(['z']);
  });
});

describe('the undo and redo shortcuts', () => {
  const key = (
    k: string,
    mods: Partial<Record<'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey', boolean>> = {},
    target: EventTarget | null = null,
  ) => ({
    key: k,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    target,
    ...mods,
  });

  it('maps Ctrl or Cmd with Z and Y', () => {
    expect(historyShortcut(key('z', { ctrlKey: true }))).toBe('undo');
    expect(historyShortcut(key('z', { metaKey: true }))).toBe('undo');
    expect(historyShortcut(key('Z', { ctrlKey: true, shiftKey: true }))).toBe('redo');
    expect(historyShortcut(key('y', { ctrlKey: true }))).toBe('redo');
    expect(historyShortcut(key('z'))).toBeNull();
    expect(historyShortcut(key('z', { ctrlKey: true, altKey: true }))).toBeNull();
  });

  it('leaves text fields their own undo', () => {
    const text = document.createElement('input');
    const box = document.createElement('input');
    box.type = 'checkbox';
    expect(historyShortcut(key('z', { ctrlKey: true }, text))).toBeNull();
    expect(historyShortcut(key('z', { ctrlKey: true }, box))).toBe('undo');
    expect(isTextField(document.createElement('textarea'))).toBe(true);
    expect(isTextField(document.createElement('button'))).toBe(false);
  });
});
