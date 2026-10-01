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

describe('the active tab', () => {
  it('opens a new assembly, keeps the part studio to go back to, and follows undo and redo', () => {
    const store = createDocumentStore(createDocument({ id: 'd', name: 'D' }));
    const s = () => store.getState();
    expect(s().activeAssemblyId).toBeNull();
    s().execute({ type: 'addAssembly', assemblyId: 'assembly#1', name: 'Assembly 1' });
    expect(s()).toMatchObject({ activeAssemblyId: 'assembly#1', activePartId: 'part#1' });
    // Back to the part studio, then an assembly edit undone from there shows the assembly.
    expect(s().setActivePart('part#1')).toBe(true);
    expect(s().activeAssemblyId).toBeNull();
    s().execute({ type: 'renameAssembly', assemblyId: 'assembly#1', name: 'Box' });
    s().execute(addVariable('a'));
    s().undo();
    expect(s().activeAssemblyId).toBeNull();
    s().undo();
    expect(s().activeAssemblyId).toBe('assembly#1');
    // A part studio added from anywhere becomes the tab.
    s().execute({ type: 'addPart', partId: 'part#2', name: 'Part 2' });
    expect(s()).toMatchObject({ activeAssemblyId: null, activePartId: 'part#2' });
    // Undoing the part's addition goes back to the part studio before it, not the assembly.
    s().undo();
    expect(s()).toMatchObject({ activeAssemblyId: null, activePartId: 'part#1' });
    expect(s().setActiveAssembly('assembly#9')).toBe(false);
    expect(s().setActiveAssembly('assembly#1')).toBe(true);
    // The assembly is deleted: its tab goes, the part studio shows.
    s().execute({ type: 'deleteAssembly', assemblyId: 'assembly#1' });
    expect(s().activeAssemblyId).toBeNull();
    s().undo();
    expect(s().activeAssemblyId).toBe('assembly#1');
    s().load(createDocument({ id: 'e', name: 'E' }));
    expect(s().activeAssemblyId).toBeNull();
  });
});

describe('undo and redo from an assembly tab', () => {
  it('edit part, switch to assembly, undo shows the part studio, redo too', () => {
    const store = createDocumentStore(createDocument({ id: 'd', name: 'D' }));
    const s = () => store.getState();
    s().execute({ type: 'addAssembly', assemblyId: 'assembly#1', name: 'Assembly 1' });
    s().setActivePart('part#1');
    s().execute({ type: 'renamePart', partId: 'part#1', name: 'Box' });
    expect(s().setActiveAssembly('assembly#1')).toBe(true);
    s().undo();
    expect(s().document.parts[0]!.name).toBe('Part 1');
    expect(s()).toMatchObject({ activeAssemblyId: null, activePartId: 'part#1' });
    s().setActiveAssembly('assembly#1');
    s().redo();
    expect(s().document.parts[0]!.name).toBe('Box');
    expect(s()).toMatchObject({ activeAssemblyId: null, activePartId: 'part#1' });
    // A change that touches neither leaves the assembly tab as it is.
    s().execute(addVariable('a'));
    s().setActiveAssembly('assembly#1');
    s().undo();
    expect(s().activeAssemblyId).toBe('assembly#1');
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

describe('the active part studio', () => {
  const twoParts = () => {
    const store = createDocumentStore(createDocument({ id: 'd', name: 'D' }));
    store.getState().execute({ type: 'addPart', partId: 'part#2', name: 'Two' }, 'Add Two');
    return store;
  };

  it('starts on the first part, and a new part studio becomes active', () => {
    const store = twoParts();
    expect(store.getState().activePartId).toBe('part#2');
    expect(store.getState().setActivePart('part#1')).toBe(true);
    expect(store.getState().activePartId).toBe('part#1');
    expect(store.getState().setActivePart('part#9')).toBe(false);
    expect(store.getState().activePartId).toBe('part#1');
  });

  it('undo and redo switch to the part studio they touch', () => {
    const store = twoParts();
    store
      .getState()
      .execute({ type: 'setMaterial', partId: 'part#2', material: 'pla' }, 'Set material');
    store.getState().setActivePart('part#1');
    store.getState().undo();
    expect(store.getState().activePartId).toBe('part#2');
    store.getState().setActivePart('part#1');
    store.getState().redo();
    expect(store.getState().activePartId).toBe('part#2');
    // A change that touches no part keeps the tab.
    store.getState().setActivePart('part#1');
    store.getState().execute({ type: 'renameDocument', name: 'E' });
    store.getState().undo();
    expect(store.getState().activePartId).toBe('part#1');
  });

  it('falls back to a neighbour when the active part goes, and to the first on another document', () => {
    const store = twoParts();
    store.getState().undo();
    expect(store.getState().activePartId).toBe('part#1');
    store.getState().redo();
    expect(store.getState().activePartId).toBe('part#2');
    store.getState().load(createDocument({ id: 'other', name: 'Other' }));
    expect(store.getState().activePartId).toBe('part#1');
  });

  it('keeps the tab when the same document loads again with that part', () => {
    const store = twoParts();
    store.getState().setActivePart('part#2');
    store.getState().load(store.getState().document);
    expect(store.getState().activePartId).toBe('part#2');
  });
});
