// Syncing the open document (T7.1d; docs/user/sync.md): which document syncs, the per-document
// switch, the sync state in the library (`sync-<n>.json`, saved with its revision), one tab per
// document doing the syncing (a Web Lock), and the notices. The loop itself is loop.ts.
//
// - The server and its token are the ones the share links use (`src/sharing/client.ts`, in this
//   origin's storage). A document's sync state names the server address it belongs to, never the
//   token; a document whose server is not the one set does not sync.
// - Switching sync on stores the document on the server when the server does not have it, or
//   starts from the server's copy and puts this browser's on top of it as one change (a restore)
//   when the two differ. "Open from the server" stores the server's copy in this browser.
// - Only the main branch syncs. Opening another branch stops syncing until main is open again.
// - The tab holding the Web Lock `manufakture-sync-<id>` syncs; another tab with the document
//   open says so, and follows through the library as before (its saves conflict as they always
//   did). It takes over when the lock is free.
// - A rebase that drops commands shows a notice, and the work before it is kept as a branch
//   (branch.ts).
//
// Kept free of React: SyncPanel.tsx shows `state`.

import {
  serialize,
  type Command,
  type ManufaktureDocument,
  type RenameTable,
} from '@manufakture/core';
import { SyncClient, type DroppedCommand } from '@manufakture/sync';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { flushForSync, registerSyncSource } from '../persistence/autosave';
import {
  MAIN_BRANCH as LIBRARY_MAIN,
  type DocumentLibrary,
  type SyncRecord,
} from '../persistence/library';
import { branchFromSearch } from '../persistence/url';
import { loadServerSettings, type ServerSettings } from '../sharing/client';
import type { DocumentStoreApi } from '../state/document';
import {
  SyncError,
  createServerDocument,
  fetchSnapshot,
  listServerDocuments,
  socketProtocols,
  socketUrl,
  type ServerDocument,
} from './api';
import { droppedText, keepAsBranch } from './branch';
import { SyncLoop, type LoopStatus } from './loop';
import { webSocketConnect, type Connect } from './transport';

/** What the status line says. */
export type SyncStatus =
  | LoopStatus
  /** The open document does not sync. */
  | { readonly kind: 'off' }
  /** Looking at the stored state, or waiting for the lock. */
  | { readonly kind: 'starting' }
  /** Another tab of this browser syncs the document. */
  | { readonly kind: 'other-tab' }
  /** It syncs, but no server is set in this browser (or a different one). */
  | { readonly kind: 'no-server'; readonly message: string }
  /** A branch other than main is open: only main syncs. */
  | { readonly kind: 'branch' }
  /** It cannot sync: the stored state does not read, say. */
  | { readonly kind: 'problem'; readonly message: string };

export interface SyncNotice {
  readonly id: number;
  readonly text: string;
  /** The branch the work before a rebase was kept on, once it is made. */
  readonly branch?: { readonly id: string; readonly name: string };
  /** Making that branch failed: why. */
  readonly branchError?: string;
}

export interface SyncState {
  /** The open document. */
  documentId: string;
  /** Whether it syncs (its sync state is stored). */
  enabled: boolean;
  status: SyncStatus;
  notices: readonly SyncNotice[];
  /** An action (switching on or off, opening from the server) is under way. */
  busy: boolean;
  /** The last action's failure, to show. */
  error: string | null;
}

/** Locks across tabs: `acquire` gives a release function, or null when another tab holds it. */
export interface SyncLocks {
  acquire(name: string): Promise<(() => void) | null>;
}

/** The browser's Web Locks, or null where there are none. */
export function browserSyncLocks(): SyncLocks | null {
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
  if (!locks) return null;
  return {
    acquire: (name) =>
      new Promise((resolve) => {
        void locks.request(name, { ifAvailable: true }, (lock) => {
          if (!lock) {
            resolve(null);
            return undefined;
          }
          return new Promise<void>((release) => resolve(() => release()));
        });
      }),
  };
}

/** 32 random bytes as base64url: a client key (apps/server `CLIENT_KEY`). */
export function newClientKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

export interface SyncControllerOptions {
  readonly documents: DocumentStoreApi;
  readonly library: DocumentLibrary;
  /** The server set in this browser (default: the share links' setting). */
  readonly settings?: () => ServerSettings | null;
  /** The open branch (default: the page URL's). */
  readonly branch?: () => string;
  /** Default: the browser's Web Locks; null: none (this tab syncs). */
  readonly locks?: SyncLocks | null;
  /** The connection for a document (default: a WebSocket). */
  readonly connect?: (server: ServerSettings, documentId: string, clientKey: string) => Connect;
  readonly fetch?: typeof fetch;
  /** Saves what autosave holds; true when nothing of the document waits (default: autosave's). */
  readonly flush?: (documentId: string) => Promise<boolean>;
  readonly online?: () => boolean;
  readonly newClientId?: () => string;
  readonly newClientKey?: () => string;
  readonly now?: () => Date;
  /** How often another tab's lock is looked at again (default 5 s). */
  readonly lockPollMs?: number;
  /** Passed to each loop (tests). */
  readonly loop?: {
    retryMs?: number;
    reconnectMs?: number;
    maxReconnectMs?: number;
    saveDelayMs?: number;
  };
}

interface Attached {
  readonly id: string;
  readonly loop: SyncLoop;
  readonly server: ServerSettings;
  readonly clientKey: string;
  readonly release: () => void;
}

export class SyncController {
  readonly state: StoreApi<SyncState>;
  readonly #documents: DocumentStoreApi;
  readonly #library: DocumentLibrary;
  readonly #settings: () => ServerSettings | null;
  readonly #branch: () => string;
  readonly #locks: SyncLocks | null;
  readonly #connect: (server: ServerSettings, documentId: string, clientKey: string) => Connect;
  readonly #fetch: typeof fetch | undefined;
  readonly #flush: (documentId: string) => Promise<boolean>;
  readonly #online: () => boolean;
  readonly #newClientId: () => string;
  readonly #newClientKey: () => string;
  readonly #now: () => Date;
  readonly #lockPollMs: number;
  readonly #loopOptions: SyncControllerOptions['loop'];
  #attached: Attached | null = null;
  /**
   * The state of the document that was syncing until another one opened: what autosave saves
   * with that document's last changes, which it saves after the switch.
   */
  #retired: { id: string; record: SyncRecord } | null = null;
  /** Bumped by every (re)attach and by stop: an attach that is overtaken gives up. */
  #generation = 0;
  #pollTimer: ReturnType<typeof setTimeout> | null = null;
  #reattachTimer: ReturnType<typeof setTimeout> | null = null;
  #nextNotice = 1;
  /** Local changes made while an attach is under way, replayed into the client after. */
  #buffer: { id: string; changes: { command: Command; label: string }[] } | null = null;
  readonly #cleanup: Array<() => void> = [];
  readonly #remapListeners = new Set<(table: RenameTable) => void>();
  #started = false;

  constructor(options: SyncControllerOptions) {
    this.#documents = options.documents;
    this.#library = options.library;
    this.#settings = options.settings ?? (() => loadServerSettings());
    this.#branch =
      options.branch ??
      (() =>
        typeof window === 'undefined'
          ? LIBRARY_MAIN
          : (branchFromSearch(window.location.search) ?? LIBRARY_MAIN));
    this.#locks = options.locks === undefined ? browserSyncLocks() : options.locks;
    this.#connect =
      options.connect ??
      ((server, id, key) => webSocketConnect(socketUrl(server, id), socketProtocols(server, key)));
    this.#fetch = options.fetch;
    this.#flush = options.flush ?? flushForSync;
    this.#online =
      options.online ?? (() => (typeof navigator === 'undefined' ? true : navigator.onLine));
    this.#newClientId = options.newClientId ?? (() => crypto.randomUUID());
    this.#newClientKey = options.newClientKey ?? newClientKey;
    this.#now = options.now ?? (() => new Date());
    this.#lockPollMs = options.lockPollMs ?? 5_000;
    this.#loopOptions = options.loop;
    this.state = createStore<SyncState>()(() => ({
      documentId: options.documents.core.document.id,
      enabled: false,
      status: { kind: 'off' },
      notices: [],
      busy: false,
      error: null,
    }));
  }

  /** Follows the open document from now on; returns `stop`. */
  start(): () => void {
    if (this.#started) return () => this.stop();
    this.#started = true;
    this.#cleanup.push(
      this.#documents.core.subscribe((event) => {
        if (event.cause === 'load') {
          // Another document (or branch, or this one again): detach now, look again once the
          // app has settled which branch is open. The last changes of the one before are saved
          // after this, with its state as it is now.
          const a = this.#attached;
          if (a !== null && !a.loop.stopped) {
            this.#retired = { id: a.id, record: recordOf(a.loop.client, a.server, a.clientKey) };
          }
          this.#detach();
          this.#scheduleAttach();
          return;
        }
        const buffer = this.#buffer;
        if (
          buffer !== null &&
          buffer.id === event.document.id &&
          event.cause !== 'remote' &&
          event.command
        ) {
          buffer.changes.push({ command: event.command, label: event.label });
        }
      }),
      registerSyncSource((id, branch) => this.#recordFor(id, branch)),
    );
    if (typeof window !== 'undefined') {
      const online = () => this.#attached?.loop.setOnline(true);
      const offline = () => this.#attached?.loop.setOnline(false);
      window.addEventListener('online', online);
      window.addEventListener('offline', offline);
      this.#cleanup.push(() => {
        window.removeEventListener('online', online);
        window.removeEventListener('offline', offline);
      });
    }
    void this.#attach();
    return () => this.stop();
  }

  stop(): void {
    this.#generation++;
    this.#detach();
    for (const c of this.#cleanup.splice(0)) c();
    if (this.#reattachTimer !== null) clearTimeout(this.#reattachTimer);
    this.#reattachTimer = null;
    this.#started = false;
  }

  /** The loop of the open document, while it syncs (tests and the test hook). */
  get loop(): SyncLoop | null {
    return this.#attached?.loop ?? null;
  }

  /** Look again at the open document (after the server setting changed, say). */
  refresh(): Promise<void> {
    this.#detach();
    return this.#attach();
  }

  /**
   * Calls `listener` when sync renames ids of the open document (ADR 0009 decision 5), before the
   * store shows the renamed document, so app state naming features (the selection, an open
   * dialog) can follow. Returns the function that stops it.
   */
  onRemapped(listener: (table: RenameTable) => void): () => void {
    this.#remapListeners.add(listener);
    return () => this.#remapListeners.delete(listener);
  }

  dismissNotice(id: number): void {
    this.state.setState((s) => ({ notices: s.notices.filter((n) => n.id !== id) }));
  }

  /** The documents on the server. */
  listServerDocuments(): Promise<ServerDocument[]> {
    const server = this.#settings();
    if (!server) return Promise.reject(new SyncError('Set a server first.'));
    return listServerDocuments(server, this.#fetchOptions());
  }

  /**
   * Switches sync on for the open document (main branch): stores it on the server, or starts
   * from the server's copy with this browser's on top when they differ.
   */
  enable(): Promise<boolean> {
    return this.#action(async () => {
      const server = this.#settings();
      if (!server) throw new SyncError('Set a server first.');
      if (this.#branch() !== LIBRARY_MAIN) {
        throw new SyncError('Only the main branch syncs: open it first.');
      }
      const id = this.#documents.core.document.id;
      if (!(await this.#flush(id))) {
        throw new SyncError('The document could not be saved, so sync was not switched on.');
      }
      const doc = this.#documents.core.document;
      if (doc.id !== id) throw new SyncError('Another document was opened meanwhile.');
      const snapshot = await fetchSnapshot(server, id, this.#fetchOptions());
      const clientId = this.#newClientId();
      let client: SyncClient;
      if (snapshot === null) {
        await createServerDocument(server, doc, this.#fetchOptions());
        client = new SyncClient(doc, 0, { clientId, online: false });
      } else {
        client = new SyncClient(snapshot.document, snapshot.rev, {
          clientId,
          highWater: snapshot.highWater,
          online: false,
        });
        if (serialize(snapshot.document) !== serialize(doc)) {
          const r = client.submit({
            restore: { document: doc },
            label: 'This browser’s copy',
          });
          if (!r.ok)
            throw new SyncError(`This browser's copy cannot be synced: ${r.error.message}`);
        }
      }
      const record = recordOf(client, server, this.#newClientKey());
      if (await this.#library.has(id)) {
        await this.#library.saveSync(id, record);
      } else {
        await this.#library.save(doc, [], undefined, record);
      }
      this.#detach();
      await this.#attach();
    });
  }

  /** Switches sync off for the open document: its sync state goes; the document stays. */
  disable(): Promise<boolean> {
    return this.#action(async () => {
      const id = this.#documents.core.document.id;
      this.#detach();
      this.#retired = null;
      this.#generation++;
      await this.#library.dropSync(id);
      this.state.setState({ enabled: false, status: { kind: 'off' } });
    });
  }

  /**
   * Stores the server's document `id` in this browser, syncing, unless it is here already.
   * Resolves with its id; the app then opens it.
   */
  async openFromServer(id: string): Promise<string | null> {
    let opened: string | null = null;
    const ok = await this.#action(async () => {
      const server = this.#settings();
      if (!server) throw new SyncError('Set a server first.');
      if (await this.#library.has(id)) {
        opened = id;
        return;
      }
      const snapshot = await fetchSnapshot(server, id, this.#fetchOptions());
      if (snapshot === null) throw new SyncError('The server has no such document.');
      const client = new SyncClient(snapshot.document, snapshot.rev, {
        clientId: this.#newClientId(),
        highWater: snapshot.highWater,
        online: false,
      });
      await this.#library.save(
        snapshot.document,
        [],
        undefined,
        recordOf(client, server, this.#newClientKey()),
      );
      opened = id;
    });
    return ok ? opened : null;
  }

  async #action(run: () => Promise<void>): Promise<boolean> {
    this.state.setState({ busy: true, error: null });
    try {
      await run();
      this.state.setState({ busy: false });
      return true;
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Something went wrong while switching sync.';
      this.state.setState({ busy: false, error: message });
      return false;
    }
  }

  #fetchOptions() {
    return this.#fetch ? { fetch: this.#fetch } : {};
  }

  /** The record to save with document `id` now, while it syncs here. */
  #recordFor(id: string, branch: string): SyncRecord | null {
    if (branch !== LIBRARY_MAIN) return null;
    const a = this.#attached;
    if (a !== null && a.id === id && !a.loop.stopped) {
      return recordOf(a.loop.client, a.server, a.clientKey);
    }
    return this.#retired?.id === id ? this.#retired.record : null;
  }

  #scheduleAttach(): void {
    if (this.#reattachTimer !== null) clearTimeout(this.#reattachTimer);
    this.#reattachTimer = setTimeout(() => {
      this.#reattachTimer = null;
      void this.#attach();
    }, 0);
  }

  #detach(): void {
    if (this.#pollTimer !== null) clearTimeout(this.#pollTimer);
    this.#pollTimer = null;
    this.#buffer = null;
    const a = this.#attached;
    this.#attached = null;
    if (a) {
      a.loop.stop();
      a.release();
    }
  }

  async #attach(): Promise<void> {
    const generation = ++this.#generation;
    const current = () => generation === this.#generation;
    const startDocument = this.#documents.core.document;
    const id = startDocument.id;
    // A retired state stays until the next switch: its document's last save may still be on its
    // way. While that document syncs again, the live state is used instead.
    this.#buffer = { id, changes: [] };
    this.state.setState({ documentId: id, status: { kind: 'starting' } });
    const give = (patch: Partial<SyncState>) => {
      if (!current()) return;
      this.#buffer = null;
      this.state.setState(patch);
    };

    const read = await this.#library.readSync(id).catch((e: unknown) => ({
      ok: false as const,
      message: e instanceof Error ? e.message : String(e),
    }));
    if (!current()) return;
    if (!read.ok) {
      give({ enabled: true, status: { kind: 'problem', message: read.message } });
      return;
    }
    const stored = read.value;
    if (stored === null) {
      give({ enabled: false, status: { kind: 'off' } });
      return;
    }
    const server = this.#settings();
    if (server === null) {
      give({
        enabled: true,
        status: { kind: 'no-server', message: 'Set the server it syncs with in this browser.' },
      });
      return;
    }
    if (server.url !== stored.record.server) {
      give({
        enabled: true,
        status: {
          kind: 'no-server',
          message: `It syncs with ${stored.record.server}, not the server set in this browser.`,
        },
      });
      return;
    }
    if (this.#branch() !== LIBRARY_MAIN) {
      give({ enabled: true, status: { kind: 'branch' } });
      return;
    }
    const release = this.#locks ? await this.#locks.acquire(`manufakture-sync-${id}`) : () => {};
    if (!current()) {
      release?.();
      return;
    }
    if (release === null) {
      give({ enabled: true, status: { kind: 'other-tab' } });
      // Take over once the other tab lets go (closed, or switched to another document).
      this.#pollTimer = setTimeout(() => {
        this.#pollTimer = null;
        if (current()) void this.#takeOver();
      }, this.#lockPollMs);
      return;
    }

    const restored = SyncClient.restore(stored.record.state, stored.record.confirmed, {
      online: this.#online(),
    });
    if (!restored.ok) {
      release();
      give({
        enabled: true,
        status: {
          kind: 'problem',
          message: `Its sync state cannot be used: ${restored.error.message}`,
        },
      });
      return;
    }
    const client = restored.value;
    const buffered = this.#buffer?.changes ?? [];
    this.#buffer = null;
    // The document as this tab shows it should be what the state shows (they were saved
    // together). Changes made since the attach began are replayed; anything else this tab
    // holds that the queue does not (saved without the state) goes on top as one change.
    const store = this.#documents.core;
    let replay = stored.paired && sameDocument(startDocument, client.document);
    if (replay) {
      for (const change of buffered) {
        if (!client.submit(change).ok) {
          replay = false;
          break;
        }
      }
    }
    if (!replay && !sameDocument(store.document, client.document)) {
      const r = client.submit({
        restore: { document: store.document },
        label: 'Changes made here while not syncing',
      });
      if (!r.ok) {
        this.#notice(`Changes in this tab could not be synced: ${r.error.message}`);
      }
    }
    const clientKey = stored.record.clientKey;
    let attached: Attached | null = null;
    const loop = new SyncLoop({
      client,
      store,
      connect: this.#connect(server, id, clientKey),
      persist: () => this.#persist(attached),
      online: this.#online,
      ...this.#loopOptions,
      onStatus: (status) => {
        if (this.#attached === attached) this.state.setState({ status });
      },
      onDropped: (drops, _before, kept) => this.#dropped(id, drops, kept),
      onRemapped: (table) => {
        for (const l of this.#remapListeners) l(table);
      },
      onProblem: (message) => this.#notice(message),
    });
    attached = { id, loop, server, clientKey, release };
    this.#attached = attached;
    this.state.setState({ enabled: true, status: loop.status });
    loop.start();
  }

  async #takeOver(): Promise<void> {
    // The other tab saved meanwhile: read what it left, so this tab builds on it.
    const id = this.#documents.core.document.id;
    const opened = await this.#library.open(id);
    if (opened.ok && !sameDocument(opened.value.document, this.#documents.core.document)) {
      this.#documents.core.applyRemote(opened.value.document, 'Saved in another tab');
    }
    await this.#attach();
  }

  /** Saves the state (after whatever autosave holds) before the loop sends. */
  async #persist(attached: Attached | null): Promise<boolean> {
    if (attached === null || this.#attached !== attached) return false;
    if (!(await this.#flush(attached.id))) return false;
    // Checked as the flush resolves: nothing of the document waits, so the head holds what the
    // store (and so the client) holds now.
    if (this.#attached !== attached || attached.loop.stopped) return false;
    const record = recordOf(attached.loop.client, attached.server, attached.clientKey);
    try {
      await this.#library.saveSync(attached.id, record);
      return true;
    } catch {
      return false;
    }
  }

  #notice(text: string, extra: Partial<SyncNotice> = {}): number {
    const id = this.#nextNotice++;
    this.state.setState((s) => ({ notices: [...s.notices, { id, text, ...extra }] }));
    return id;
  }

  #dropped(id: string, drops: readonly DroppedCommand[], kept: ManufaktureDocument): void {
    const noticeId = this.#notice(droppedText(drops));
    const update = (patch: Partial<SyncNotice>) =>
      this.state.setState((s) => ({
        notices: s.notices.map((n) => (n.id === noticeId ? { ...n, ...patch } : n)),
      }));
    void keepAsBranch(this.#library, id, kept, this.#now()).then(
      (branch) => update({ branch: { id: branch.id, name: branch.name } }),
      (e: unknown) =>
        update({ branchError: e instanceof Error ? e.message : 'The branch could not be made.' }),
    );
  }
}

function sameDocument(a: ManufaktureDocument, b: ManufaktureDocument): boolean {
  return a === b || serialize(a) === serialize(b);
}

function recordOf(client: SyncClient, server: ServerSettings, clientKey: string): SyncRecord {
  return {
    server: server.url,
    clientKey,
    confirmed: client.confirmedDocument,
    state: client.save(),
  };
}
