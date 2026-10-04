import { diffDocuments, type DocumentChange } from './changes';
import { applyCommand, type Command } from './commands';
import { fail, ok, type CoreResult } from './result';
import type { ManufaktureDocument } from './schema';
import { checkDocument } from './validate';

/**
 * One undo or redo step: `command` is what applying the step runs, `label` what the UI shows
 * ("Edit Extrude 1"). Both stacks hold plain data, so they can be persisted with the document.
 */
export interface HistoryEntry {
  readonly label: string;
  readonly command: Command;
}

/**
 * Why the document changed: a local command, its undo or redo, a `load` (open, revert), or
 * `remote`: entries from another client arrived through sync (T7.1d), or a rebase renamed or
 * dropped pending ones. A remote change leaves the undo and redo stacks as they are.
 */
export type ChangeCause = 'execute' | 'undo' | 'redo' | 'load' | 'remote';

export interface ChangeEvent {
  readonly cause: ChangeCause;
  /**
   * The command that was applied; absent for `load`. Recording these gives the op log. For
   * `remote` it is a `replaceDocument` of the new document: a rebase is not one command.
   */
  readonly command?: Command;
  readonly label: string;
  readonly previous: ManufaktureDocument;
  readonly document: ManufaktureDocument;
  readonly change: DocumentChange;
}

export type ChangeListener = (event: ChangeEvent) => void;

export interface StoreOptions {
  /** Undo steps kept; the oldest are dropped beyond this. Default 500. */
  readonly historyLimit?: number;
}

/**
 * Holds the current document and its undo and redo stacks, and notifies subscribers of every
 * change. The document it holds is always valid: every change goes through `applyCommand`, and
 * `load` checks the document first. Documents are immutable; a change replaces the whole object
 * and shares unchanged parts with the previous one.
 *
 * Undo applies the inverse recorded when the command ran, and records that command's own inverse
 * for redo. Counters in `nextIds` never go back on undo, so an id handed out once is never handed
 * out again, even after the step that allocated it is undone.
 */
export class DocumentStore {
  #document: ManufaktureDocument;
  #undo: HistoryEntry[] = [];
  #redo: HistoryEntry[] = [];
  readonly #listeners = new Set<ChangeListener>();
  readonly #limit: number;

  private constructor(document: ManufaktureDocument, options: StoreOptions) {
    this.#document = document;
    this.#limit = Math.max(1, options.historyLimit ?? 500);
  }

  /** A store for a document; fails if the document is invalid. */
  static create(
    document: ManufaktureDocument,
    options: StoreOptions = {},
  ): CoreResult<DocumentStore> {
    const checked = checkDocument(document);
    return checked.ok ? ok(new DocumentStore(document, options)) : checked;
  }

  get document(): ManufaktureDocument {
    return this.#document;
  }

  get canUndo(): boolean {
    return this.#undo.length > 0;
  }

  get canRedo(): boolean {
    return this.#redo.length > 0;
  }

  /** Undo steps, oldest first. */
  get undoStack(): readonly HistoryEntry[] {
    return this.#undo.slice();
  }

  /** Redo steps, the next one last. */
  get redoStack(): readonly HistoryEntry[] {
    return this.#redo.slice();
  }

  subscribe(listener: ChangeListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * Applies a command as one undo step and clears the redo stack. A command that changes nothing
   * succeeds without touching the history or notifying anyone.
   */
  execute(command: Command, label: string = command.type): CoreResult<DocumentChange> {
    const r = applyCommand(this.#document, command);
    if (!r.ok) return r;
    const change = diffDocuments(this.#document, r.value.document);
    if (change.empty) return ok(change);
    this.#undo.push({ label, command: r.value.inverse });
    if (this.#undo.length > this.#limit) this.#undo.splice(0, this.#undo.length - this.#limit);
    this.#redo = [];
    return ok(this.#commit('execute', command, label, r.value.document, change));
  }

  undo(): CoreResult<DocumentChange> {
    return this.#step(this.#undo, this.#redo, 'undo');
  }

  redo(): CoreResult<DocumentChange> {
    return this.#step(this.#redo, this.#undo, 'redo');
  }

  /** Replaces the document (open, revert) and clears both stacks. Fails if it is invalid. */
  load(document: ManufaktureDocument): CoreResult<DocumentChange> {
    const checked = checkDocument(document);
    if (!checked.ok) return checked;
    this.#undo = [];
    this.#redo = [];
    const change = diffDocuments(this.#document, document);
    return ok(this.#commit('load', undefined, 'load', document, change));
  }

  /**
   * Puts `document` in place as a change from another client (sync, T7.1d): validated like a
   * load, notified with the cause `remote` and a `replaceDocument` command (so the op log can
   * replay it), and the undo and redo stacks are kept. A document with another id is refused, as
   * is an invalid one; one equal to the current document changes nothing.
   */
  applyRemote(document: ManufaktureDocument, label = 'Synced changes'): CoreResult<DocumentChange> {
    if (document.id !== this.#document.id) {
      return fail('invalid-id', `A remote change is for document "${document.id}", not this one`);
    }
    if (document === this.#document) return ok(diffDocuments(document, document));
    const checked = checkDocument(document);
    if (!checked.ok) return checked;
    const change = diffDocuments(this.#document, document);
    if (change.empty) {
      // Same content (another object): adopt it quietly, so later remote changes diff against it.
      this.#document = document;
      return ok(change);
    }
    return ok(
      this.#commit('remote', { type: 'replaceDocument', document }, label, document, change),
    );
  }

  /**
   * Rewrites the undo and redo stacks with `rewrite` (sync renamed ids, ADR 0009 decision 5);
   * an entry it maps to null is dropped together with every older one, since an older step would
   * no longer undo onto the state it was recorded on. Notifies nobody: the next change does.
   */
  rewriteHistory(rewrite: (command: Command) => Command | null): void {
    const map = (stack: HistoryEntry[]): HistoryEntry[] => {
      const out: HistoryEntry[] = [];
      for (let i = stack.length - 1; i >= 0; i--) {
        const command = rewrite(stack[i]!.command);
        if (command === null) break;
        out.unshift({ label: stack[i]!.label, command });
      }
      return out;
    };
    this.#undo = map(this.#undo);
    this.#redo = map(this.#redo);
  }

  /** Empties the undo and redo stacks (sync dropped commands they may build on). */
  clearHistory(): void {
    this.#undo = [];
    this.#redo = [];
  }

  #step(
    from: HistoryEntry[],
    to: HistoryEntry[],
    cause: 'undo' | 'redo',
  ): CoreResult<DocumentChange> {
    const entry = from.at(-1);
    if (!entry) return fail('empty-history', `Nothing to ${cause}`);
    const r = applyCommand(this.#document, entry.command);
    // Cannot happen for a history this store recorded; if it does, keep the stacks as they are.
    if (!r.ok) return r;
    from.pop();
    to.push({ label: entry.label, command: r.value.inverse });
    const change = diffDocuments(this.#document, r.value.document);
    return ok(this.#commit(cause, entry.command, entry.label, r.value.document, change));
  }

  #commit(
    cause: ChangeCause,
    command: Command | undefined,
    label: string,
    document: ManufaktureDocument,
    change: DocumentChange,
  ): DocumentChange {
    const previous = this.#document;
    this.#document = document;
    const event: ChangeEvent = command
      ? { cause, command, label, previous, document, change }
      : { cause, label, previous, document, change };
    // Every listener runs even if one throws; the first error is rethrown afterwards.
    let failure: { error: unknown } | undefined;
    for (const listener of [...this.#listeners]) {
      try {
        listener(event);
      } catch (error) {
        failure ??= { error };
      }
    }
    if (failure) throw failure.error;
    return change;
  }
}
