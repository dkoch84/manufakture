// The open document: a zustand store around core's DocumentStore, which
// holds the document, applies commands and keeps the undo and redo stacks.
//
// React components read the document and the history flags from here; tools
// change the document only through `execute` (one command, one undo step).
// The core store stays reachable as `core` for what needs every ChangeEvent
// with its command and diff: regen scheduling, the feature tree (#933) and
// persistence with its op log (#935) subscribe to `core.subscribe`.

import {
  DocumentStore,
  createDocument,
  type Command,
  type CoreError,
  type CoreResult,
  type DocumentChange,
  type ManufaktureDocument,
} from '@manufakture/core';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';

export interface DocumentState {
  document: ManufaktureDocument;
  canUndo: boolean;
  canRedo: boolean;
  /** Label of the step `undo` would revert ("Add Sketch 1"), or null. */
  undoLabel: string | null;
  redoLabel: string | null;
  /** The last command that failed, for the UI to report; cleared by the next success. */
  lastError: CoreError | null;

  execute(command: Command, label?: string): CoreResult<DocumentChange>;
  undo(): CoreResult<DocumentChange>;
  redo(): CoreResult<DocumentChange>;
  /** Replace the document (open a file) and clear the history. */
  load(document: ManufaktureDocument): CoreResult<DocumentChange>;
}

export type DocumentStoreApi = StoreApi<DocumentState> & { core: DocumentStore };

export function newDocument(id: string = crypto.randomUUID()): ManufaktureDocument {
  return createDocument({ id, name: 'Untitled' });
}

export function createDocumentStore(
  initial: ManufaktureDocument = newDocument(),
  options: { historyLimit?: number } = {},
): DocumentStoreApi {
  const created = DocumentStore.create(initial, options);
  if (!created.ok) throw new Error(`Invalid document: ${created.error.message}`);
  const core = created.value;

  const snapshot = () => ({
    document: core.document,
    canUndo: core.canUndo,
    canRedo: core.canRedo,
    undoLabel: core.undoStack.at(-1)?.label ?? null,
    redoLabel: core.redoStack.at(-1)?.label ?? null,
  });

  const store = createStore<DocumentState>()((set) => {
    const track = (r: CoreResult<DocumentChange>) => {
      set(r.ok ? { lastError: null } : { lastError: r.error });
      return r;
    };
    return {
      ...snapshot(),
      lastError: null,
      execute: (command, label) => track(core.execute(command, label)),
      undo: () => track(core.undo()),
      redo: () => track(core.redo()),
      load: (document) => track(core.load(document)),
    };
  });
  // Every change, whatever caused it, refreshes the snapshot.
  core.subscribe(() => store.setState(snapshot()));
  return Object.assign(store, { core });
}

/** The app's document. Tests create their own with `createDocumentStore()`. */
export const documentStore: DocumentStoreApi = createDocumentStore();

export function useDocument<T>(selector: (state: DocumentState) => T): T {
  return useStore(documentStore, selector);
}

export type HistoryAction = 'undo' | 'redo';

/**
 * The history action a key press asks for: Ctrl+Z (Cmd+Z) undoes,
 * Ctrl+Shift+Z and Ctrl+Y redo. Presses in text fields are theirs.
 */
export function historyShortcut(e: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  target: EventTarget | null;
}): HistoryAction | null {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return null;
  if (isTextField(e.target)) return null;
  const key = e.key.toLowerCase();
  if (key === 'z') return e.shiftKey ? 'redo' : 'undo';
  if (key === 'y' && !e.shiftKey) return 'redo';
  return null;
}

/** Whether keyboard input at `target` is typing, not a shortcut. */
export function isTextField(target: EventTarget | null): boolean {
  if (typeof HTMLElement === 'undefined' || !(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  if (target instanceof HTMLInputElement) {
    return !['checkbox', 'radio', 'button', 'range', 'submit', 'reset'].includes(target.type);
  }
  return false;
}
