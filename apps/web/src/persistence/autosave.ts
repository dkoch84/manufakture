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
//
// Changes wait per document and branch: each change is recorded with the branch the open
// document was on when it was made (the `branch` option), and saved to that branch, so a change
// made while the app switches branches never lands on the other one.

import type { ChangeEvent, ManufaktureDocument } from '@manufakture/core';
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { DocumentStoreApi } from '../state/document';
import {
  MAIN_BRANCH,
  RevisionConflict,
  type DocumentLibrary,
  type DocumentSummary,
  type LibraryResult,
  type LogEntry,
  type Version,
  type VersionMeta,
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
  /**
   * Name the open document's current state: save what is pending first (and store the document
   * when it never was), then record the version. Fails without recording anything when the
   * save does.
   */
  createVersion(meta: VersionMeta): Promise<LibraryResult<Version>>;
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
  /** The branch the open document is on now (default: always main). */
  branch?: () => string;
}

interface Pending {
  document: ManufaktureDocument;
  entries: LogEntry[];
  /** The branch the changes were made on, and are saved to. */
  branch: string;
}

/** The key of a document's branch in the maps below. */
const keyOf = (id: string, branch: string) => `${id}\u0000${branch}`;
const isOf = (key: string, id: string) => key.startsWith(`${id}\u0000`);

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
    branch: branchNow = () => MAIN_BRANCH,
  } = options;
  const openDocument = () => documents.core.document;
  const status = createStore<SaveStatus>()(() => ({
    state: 'idle',
    message: null,
    documentId: openDocument().id,
    documentName: openDocument().name,
  }));
  /** Changes not saved yet, by document and branch (`keyOf`), in the order they came. */
  const pending = new Map<string, Pending>();
  /** Documents being deleted (by id): a failed save of one is not kept for another attempt. */
  const deleted = new Set<string>();
  /** Branches of documents (`keyOf`) another tab saved meanwhile: not saved until `forget`. */
  const conflicted = new Set<string>();
  const pendingFor = (id: string) => [...pending.keys()].some((k) => isOf(k, id));
  /** Changes a flush has taken whose save has not finished yet. */
  let saving = 0;
  let failures = 0;
  let stopped = false;
  let quiet: ReturnType<typeof setTimeout> | null = null;
  let deadline: ReturnType<typeof setTimeout> | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<unknown> = Promise.resolve();

  /** The branch the status is about (it is shown for the open document's branch only). */
  let statusBranch = branchNow();
  const setStatus = (
    state: SaveStatus['state'],
    doc: ManufaktureDocument,
    message = null as string | null,
    branch = branchNow(),
  ) => {
    statusBranch = branch;
    status.setState({ state, message, documentId: doc.id, documentName: doc.name });
  };

  const clearTimers = () => {
    for (const t of [quiet, deadline, retry]) if (t !== null) clearTimeout(t);
    quiet = deadline = retry = null;
  };

  /** Save `take`, the pending changes of one document's branch (`key`); false when that failed. */
  const saveOne = async (key: string, take: Pending): Promise<boolean> => {
    const id = take.document.id;
    // Deleted after the flush took its changes, before their turn: the save would bring it back.
    if (deleted.has(id)) {
      saving -= 1;
      return true;
    }
    // Whether the status is about this document's branch: open now, or what it shows already.
    const shown = () =>
      (openDocument().id === id && branchNow() === take.branch) ||
      (status.getState().documentId === id && statusBranch === take.branch);
    if (shown()) setStatus('saving', take.document, null, take.branch);
    try {
      const summary = await library.save(take.document, take.entries, take.branch);
      if (shown()) {
        const newer = pending.get(key);
        setStatus(newer ? 'pending' : 'saved', newer?.document ?? take.document, null, take.branch);
      }
      onSaved?.(summary);
      return true;
    } catch (e) {
      if (deleted.has(id)) return true;
      // Keep the changes (their log entries first) for the next attempt, beside any newer ones.
      const newer = pending.get(key);
      pending.set(key, {
        document: newer?.document ?? take.document,
        entries: [...take.entries, ...(newer?.entries ?? [])],
        branch: take.branch,
      });
      const message = e instanceof Error ? e.message : String(e);
      if (e instanceof RevisionConflict) conflicted.add(key);
      setStatus(
        e instanceof RevisionConflict ? 'conflict' : 'error',
        take.document,
        message,
        take.branch,
      );
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
    const batch = [...pending].filter(([key]) => !conflicted.has(key));
    const blocked = pending.size > batch.length;
    for (const [key] of batch) pending.delete(key);
    saving += batch.length;
    const run = inFlight.then(async () => {
      let ok = !blocked;
      for (const [key, take] of batch) if (!(await saveOne(key, take))) ok = false;
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
      setStatus(pendingFor(doc.id) ? 'pending' : 'idle', doc);
      return;
    }
    if (!event.command) return;
    deleted.delete(doc.id);
    // The branch the change is made on, read now: a switch that completes later does not move it.
    const branch = branchNow();
    const key = keyOf(doc.id, branch);
    const entry: LogEntry = {
      cause: event.cause,
      label: event.label,
      command: event.command,
      at: now().toISOString(),
    };
    pending.set(key, {
      document: doc,
      entries: [...(pending.get(key)?.entries ?? []), entry],
      branch,
    });
    const current = status.getState();
    const failing =
      current.documentId === doc.id && (current.state === 'error' || current.state === 'conflict');
    if (!failing) setStatus('pending', doc);
    if (!conflicted.has(key)) schedule();
  };
  const unsubscribe = documents.core.subscribe(onChange);

  const drop = (id: string) => {
    for (const key of [...pending.keys()]) if (isOf(key, id)) pending.delete(key);
    for (const key of [...conflicted]) if (isOf(key, id)) conflicted.delete(key);
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
    async createVersion(meta) {
      const id = openDocument().id;
      const branch = branchNow();
      const saved = await flush();
      if (!saved && pending.has(keyOf(id, branch))) {
        return {
          ok: false,
          message: `The document could not be saved: ${status.getState().message ?? 'unknown error'}`,
        };
      }
      try {
        if (!(await library.has(id))) onSaved?.(await library.save(openDocument(), [], branch));
        return await library.createVersion(id, meta, branch);
      } catch (e) {
        return { ok: false, message: e instanceof Error ? e.message : String(e) };
      }
    },
    async stop() {
      stopped = true;
      unsubscribe();
      await flush();
      clearTimers();
    },
  };
}
