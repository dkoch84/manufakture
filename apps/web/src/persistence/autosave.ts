// Autosave: every change to the open document (a command, an undo, a redo) is recorded in the
// command log and saved to the library once edits pause (`delayMs` after the last one), and at
// least every `maxDelayMs` while they keep coming. Saves run one at a time.
//
// Changes wait per document: opening another document (a `load`) saves what is pending for the
// one before it, and a document's commands never go into another's log. A save that fails keeps
// its changes and is tried again with backoff (`retryMs`, doubling up to `maxRetryMs`), with the
// next change, or on `flush`. A save refused because another tab saved the document meanwhile
// (a `RevisionConflict`) is not retried: the status says `conflict` until the user chooses
// (reload the newer version, or keep this tab's version as a copy) and the app calls `forget`.

import type { ChangeEvent, ManufaktureDocument } from '@manufakture/core';
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { DocumentStoreApi } from '../state/document';
import {
  RevisionConflict,
  type DocumentLibrary,
  type DocumentSummary,
  type LogEntry,
} from './library';

export interface SaveStatus {
  /**
   * `idle`: nothing changed since the document was opened. `pending`: changes wait for the
   * pause. `saving`, `saved`, `error` (the last save failed; `message` says why; it is tried
   * again), and `conflict` (another tab saved the document; `message` says so; not retried).
   */
  state: 'idle' | 'pending' | 'saving' | 'saved' | 'error' | 'conflict';
  message: string | null;
  /** The document the status is about, which may not be the open one (a failed earlier save). */
  documentId: string;
  /** Its name, for saying which document when it is not the open one. */
  documentName: string;
}

export interface Autosave {
  status: StoreApi<SaveStatus>;
  /**
   * Save what is pending now; resolves once it (and any save in flight) is done: true when
   * every change is saved, false when a save failed or is refused for a conflict.
   */
  flush(): Promise<boolean>;
  /** Drop what is pending for document `id` because it is being deleted: never save it again. */
  discard(id: string): void;
  /** Drop what is pending for document `id` and its conflict: the user chose another version. */
  forget(id: string): void;
  /** Whether any change is not saved yet (pending, being saved, failed or in conflict). */
  unsaved(): boolean;
  /** Stop listening, after saving what is pending. */
  stop(): Promise<void>;
}

export interface AutosaveOptions {
  delayMs?: number;
  maxDelayMs?: number;
  /** The first retry after a failed save; each further failure doubles it, up to the max. */
  retryMs?: number;
  maxRetryMs?: number;
  /** After every successful save. */
  onSaved?: (summary: DocumentSummary) => void;
  now?: () => Date;
}

interface Pending {
  document: ManufaktureDocument;
  entries: LogEntry[];
}

export function startAutosave(
  documents: DocumentStoreApi,
  library: DocumentLibrary,
  options: AutosaveOptions = {},
): Autosave {
  const {
    delayMs = 800,
    maxDelayMs = 5000,
    retryMs = 2000,
    maxRetryMs = 60_000,
    onSaved,
    now = () => new Date(),
  } = options;
  const openDocument = () => documents.core.document;
  const status = createStore<SaveStatus>()(() => ({
    state: 'idle',
    message: null,
    documentId: openDocument().id,
    documentName: openDocument().name,
  }));
  /** Changes not saved yet, by document id, in the order they came. */
  const pending = new Map<string, Pending>();
  /** Documents being deleted: a failed save of one is not kept for another attempt. */
  const deleted = new Set<string>();
  /** Documents another tab saved meanwhile: not saved again until `forget`. */
  const conflicted = new Set<string>();
  /** Changes a flush has taken whose save has not finished yet. */
  let saving = 0;
  let failures = 0;
  let stopped = false;
  let quiet: ReturnType<typeof setTimeout> | null = null;
  let deadline: ReturnType<typeof setTimeout> | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<unknown> = Promise.resolve();

  const setStatus = (
    state: SaveStatus['state'],
    doc: ManufaktureDocument,
    message = null as string | null,
  ) => status.setState({ state, message, documentId: doc.id, documentName: doc.name });

  const clearTimers = () => {
    for (const t of [quiet, deadline, retry]) if (t !== null) clearTimeout(t);
    quiet = deadline = retry = null;
  };

  /** Save `take`, the pending changes of document `id`; false when that failed. */
  const saveOne = async (id: string, take: Pending): Promise<boolean> => {
    // Deleted after the flush took its changes, before their turn: the save would bring it back.
    if (deleted.has(id)) {
      saving -= 1;
      return true;
    }
    const shown = () => openDocument().id === id || status.getState().documentId === id;
    if (shown()) setStatus('saving', take.document);
    try {
      const summary = await library.save(take.document, take.entries);
      if (shown()) {
        const newer = pending.get(id);
        setStatus(newer ? 'pending' : 'saved', newer?.document ?? take.document);
      }
      onSaved?.(summary);
      return true;
    } catch (e) {
      if (deleted.has(id)) return true;
      // Keep the changes (their log entries first) for the next attempt, beside any newer ones.
      const newer = pending.get(id);
      pending.set(id, {
        document: newer?.document ?? take.document,
        entries: [...take.entries, ...(newer?.entries ?? [])],
      });
      const message = e instanceof Error ? e.message : String(e);
      if (e instanceof RevisionConflict) conflicted.add(id);
      setStatus(e instanceof RevisionConflict ? 'conflict' : 'error', take.document, message);
      return false;
    } finally {
      saving -= 1;
    }
  };

  const scheduleRetry = () => {
    if (stopped) return;
    const retryable = [...pending.keys()].some((id) => !conflicted.has(id));
    if (!retryable) return;
    failures += 1;
    const wait = Math.min(maxRetryMs, retryMs * 2 ** (failures - 1));
    if (retry !== null) clearTimeout(retry);
    retry = setTimeout(() => {
      retry = null;
      void flush();
    }, wait);
  };

  const flush = (): Promise<boolean> => {
    clearTimers();
    // What is pending now; a document in conflict keeps its changes until `forget`.
    const batch = [...pending].filter(([id]) => !conflicted.has(id));
    const blocked = pending.size > batch.length;
    for (const [id] of batch) pending.delete(id);
    saving += batch.length;
    const run = inFlight.then(async () => {
      let ok = !blocked;
      for (const [id, take] of batch) if (!(await saveOne(id, take))) ok = false;
      if (ok) failures = 0;
      else scheduleRetry();
      return ok;
    });
    inFlight = run;
    return run;
  };

  const schedule = () => {
    if (stopped) return;
    if (quiet !== null) clearTimeout(quiet);
    quiet = setTimeout(() => void flush(), delayMs);
    deadline ??= setTimeout(() => void flush(), maxDelayMs);
  };

  const onChange = (event: ChangeEvent) => {
    const doc = event.document;
    if (event.cause === 'load') {
      // Another document (or this one again, say imported back after it was deleted): save the
      // pending changes of the ones before.
      deleted.delete(doc.id);
      void flush();
      setStatus(pending.has(doc.id) ? 'pending' : 'idle', doc);
      return;
    }
    if (!event.command) return;
    deleted.delete(doc.id);
    const entry: LogEntry = {
      cause: event.cause,
      label: event.label,
      command: event.command,
      at: now().toISOString(),
    };
    pending.set(doc.id, {
      document: doc,
      entries: [...(pending.get(doc.id)?.entries ?? []), entry],
    });
    const current = status.getState();
    const failing =
      current.documentId === doc.id && (current.state === 'error' || current.state === 'conflict');
    if (!failing) setStatus('pending', doc);
    if (!conflicted.has(doc.id)) schedule();
  };
  const unsubscribe = documents.core.subscribe(onChange);

  const drop = (id: string) => {
    pending.delete(id);
    conflicted.delete(id);
    if (pending.size === 0) {
      clearTimers();
      failures = 0;
    }
  };

  return {
    status,
    flush,
    discard(id) {
      deleted.add(id);
      drop(id);
    },
    forget(id) {
      drop(id);
      if (status.getState().documentId === id) setStatus('idle', openDocument());
    },
    unsaved: () => pending.size > 0 || saving > 0,
    async stop() {
      stopped = true;
      unsubscribe();
      await flush();
      clearTimers();
    },
  };
}
