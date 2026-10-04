// The sync loop of one document (T7.1d): between the open document's `DocumentStore`, a
// `SyncClient` (packages/sync) and a connection to the server.
//
// - Every local change (a command, an undo, a redo) is submitted to the client as it is made.
// - What the server sends goes through `SyncClient.handle`, which validates it; when the client's
//   document moves (others' entries, a rebase), the store gets it as a `remote` change, so regen
//   and the tree follow and the local undo stack stays as it is (renamed ids are renamed in it,
//   and it is emptied when a rebase drops commands it may build on).
// - Before anything `takeOutgoing()` or `retry()` returns is sent, the queue state is saved
//   (`persist`): a reload after a send always finds the entries it sent, so they are resent under
//   the same `clientSeq` and never applied twice or lost.
// - `retry()` runs on a timer while entries wait for verdicts, and after every reconnect.
// - The client stops for good on a version mismatch or a server fault (`incompatible`); the
//   status says which, and nothing more is sent.
//
// Kept free of React and of the library: the controller (controller.ts) gives it `persist`.

import {
  remapIds,
  type Command,
  type DocumentStore,
  type ManufaktureDocument,
  type RenameTable,
} from '@manufakture/core';
import type {
  ClientMessage,
  DroppedCommand,
  PreRebaseState,
  ProtocolError,
  SyncClient,
} from '@manufakture/sync';
import type { Connect, Transport } from './transport';

/** How often entries without a verdict are sent again, and the pull asked for again. */
export const RETRY_MS = 10_000;
/** The first reconnect wait; it doubles up to `MAX_RECONNECT_MS`. */
export const RECONNECT_MS = 1_000;
export const MAX_RECONNECT_MS = 30_000;
/** After a failed save before sending: when to try again. */
export const PERSIST_RETRY_MS = 2_000;

export type LoopStatus =
  /** Connecting (or reconnecting) to the server. */
  | { readonly kind: 'connecting'; readonly pending: number }
  /** Everything this browser made is confirmed. */
  | { readonly kind: 'synced' }
  /** `pending` entries wait to be sent or confirmed. */
  | { readonly kind: 'pending'; readonly pending: number }
  /** The browser is offline: changes are kept and sent on reconnect. */
  | { readonly kind: 'offline'; readonly pending: number }
  /** The server speaks a newer protocol or document format: update the app. */
  | { readonly kind: 'update-app'; readonly message: string }
  /** The server is older than this app: it must be upgraded. */
  | { readonly kind: 'upgrade-server'; readonly message: string }
  /** The server's log disagrees with this browser: syncing stopped (`server-fault`). */
  | { readonly kind: 'fault'; readonly message: string }
  /** The state could not be saved, so nothing is sent; tried again. */
  | { readonly kind: 'error'; readonly message: string; readonly pending: number };

export interface SyncLoopOptions {
  readonly client: SyncClient;
  readonly store: DocumentStore;
  readonly connect: Connect;
  /**
   * Saves the queue state (with the document, when it changed) before anything is sent: true
   * when it is saved. Nothing is sent when it fails.
   */
  readonly persist: () => Promise<boolean>;
  /** Whether the browser is online now (default: `navigator.onLine`, else true). */
  readonly online?: () => boolean;
  readonly retryMs?: number;
  readonly reconnectMs?: number;
  readonly maxReconnectMs?: number;
  readonly onStatus?: (status: LoopStatus) => void;
  /**
   * A rebase dropped commands (ADR 0009 decisions 4 and 6): the notice and the branch fallback.
   * `kept` is the document as the user last saw it with those commands in it, before others'
   * changes arrived: what the branch keeps.
   */
  readonly onDropped?: (
    drops: readonly DroppedCommand[],
    before: PreRebaseState,
    kept: ManufaktureDocument,
  ) => void;
  /**
   * Ids were renamed (ADR 0009 decision 5), before the store shows the renamed document: app
   * state that names features (a selection, an open dialog) follows `table`.
   */
  readonly onRemapped?: (table: RenameTable) => void;
  /** After a message changed the queue, the state is saved this much later (default 1 s). */
  readonly saveDelayMs?: number;
  /** A local change the client refused (it is undone locally), or a message it refused. */
  readonly onProblem?: (message: string) => void;
}

/** Whether the server's version error means this app is the older side. */
export function appIsOlder(error: ProtocolError): boolean {
  return /older than the server/.test(error.message);
}

/** Entry states the client does not show (packages/sync README, "Entry states"). */
const HIDDEN: ReadonlySet<string> = new Set(['held', 'doomed', 'predecessor-refused', 'id-reused']);

export class SyncLoop {
  readonly client: SyncClient;
  readonly #store: DocumentStore;
  readonly #connect: Connect;
  readonly #persist: () => Promise<boolean>;
  readonly #isOnline: () => boolean;
  readonly #retryMs: number;
  readonly #reconnectMs: number;
  readonly #maxReconnectMs: number;
  readonly #options: SyncLoopOptions;
  #transport: Transport | null = null;
  #online: boolean;
  #connected = false;
  #stopped = false;
  #reconnects = 0;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #retryTimer: ReturnType<typeof setInterval> | null = null;
  #persistTimer: ReturnType<typeof setTimeout> | null = null;
  #chain: Promise<void> = Promise.resolve();
  #persistFailed: string | null = null;
  /** The client document the store holds now (by identity). */
  #shown: unknown;
  #status: LoopStatus | null = null;
  /** The store's document before the client last hid pending entries (held, refused, ...). */
  #beforeHidden: ManufaktureDocument | null = null;
  #saveTimer: ReturnType<typeof setTimeout> | null = null;
  readonly #unsubscribe: Array<() => void> = [];

  constructor(options: SyncLoopOptions) {
    this.#options = options;
    this.client = options.client;
    this.#store = options.store;
    this.#connect = options.connect;
    this.#persist = options.persist;
    this.#isOnline =
      options.online ?? (() => (typeof navigator === 'undefined' ? true : navigator.onLine));
    this.#retryMs = options.retryMs ?? RETRY_MS;
    this.#reconnectMs = options.reconnectMs ?? RECONNECT_MS;
    this.#maxReconnectMs = options.maxReconnectMs ?? MAX_RECONNECT_MS;
    this.#shown = this.#store.document;
    this.#online = this.#isOnline();

    const client = this.client;
    this.#unsubscribe.push(
      client.on('remapped', ({ table }) => {
        // The local undo and redo steps name ids in the old naming: rename them too.
        const document = this.#store.document;
        this.#store.rewriteHistory((c) => remapIds([c], table, { document })[0] ?? c);
        options.onRemapped?.(table);
      }),
      client.on('dropped', ({ drops, before }) => {
        // The store still shows what it showed before this message: the user's work, unless
        // an earlier message already hid it (then the document from before that one).
        const kept = this.#beforeHidden ?? this.#store.document;
        this.#store.clearHistory();
        options.onDropped?.(drops, before, kept);
      }),
      client.on('incompatible', () => {
        this.#halt();
      }),
      this.#store.subscribe((event) => {
        if (this.#stopped) return;
        if (event.cause === 'remote' || event.cause === 'load' || !event.command) return;
        this.submitLocal(event.command, event.label);
      }),
    );
  }

  /** The current status. */
  get status(): LoopStatus {
    return this.#computeStatus();
  }

  get stopped(): boolean {
    return this.#stopped;
  }

  /** Connects and brings the store to the client's document. */
  start(): void {
    this.#showClientDocument();
    this.client.setOnline(this.#online);
    this.#open();
    this.#retryTimer = setInterval(() => this.#retryNow(), this.#retryMs);
    this.#report();
  }

  /** Stops: closes the connection; nothing more is applied or sent. */
  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    for (const off of this.#unsubscribe.splice(0)) off();
    this.#clearTimers();
    const t = this.#transport;
    this.#transport = null;
    t?.close();
  }

  /** The browser went online or offline. */
  setOnline(online: boolean): void {
    if (this.#stopped) return;
    this.#online = online;
    this.client.setOnline(online);
    if (online) {
      if (!this.#transport) this.#open();
      else this.#pump(false);
    }
    this.#report();
  }

  /**
   * Submits a local change made on the store. Normally the subscription does this; a change the
   * client refuses (it no longer applies to what the client shows) is undone in the store.
   */
  submitLocal(command: Command, label: string): void {
    const r = this.client.submit({ command, label });
    if (!r.ok) {
      this.#options.onProblem?.(`"${label}" could not be synced: ${r.error.message}`);
      this.#showClientDocument();
    } else {
      // The store already holds this document (an equal one): no remote change to show.
      this.#shown = this.client.document;
    }
    this.#pump(false);
    this.#report();
  }

  #open(): void {
    if (this.#stopped || this.client.incompatibility !== undefined) return;
    if (!this.#online) return;
    this.#connected = false;
    let transport: Transport | null = null;
    transport = this.#connect({
      onOpen: () => {
        if (this.#stopped || this.#transport !== transport) return;
        this.#connected = true;
        this.#reconnects = 0;
        transport!.send(this.client.hello());
        // Everything in flight may have been lost with the last connection.
        this.#pump(true);
        this.#report();
      },
      onMessage: (raw) => {
        if (this.#stopped || this.#transport !== transport) return;
        this.#receive(raw);
      },
      onClose: () => {
        if (this.#transport !== transport) return;
        this.#transport = null;
        this.#connected = false;
        if (!this.#stopped) this.#scheduleReconnect();
        this.#report();
      },
    });
    this.#transport = transport;
  }

  #scheduleReconnect(): void {
    if (this.#stopped || this.client.incompatibility !== undefined) return;
    if (this.#reconnectTimer !== null) return;
    const wait = Math.min(this.#maxReconnectMs, this.#reconnectMs * 2 ** this.#reconnects);
    this.#reconnects += 1;
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      if (!this.#transport) this.#open();
    }, wait);
  }

  #receive(raw: unknown): void {
    const r = this.client.handle(raw);
    if (!r.ok && this.client.incompatibility === undefined) {
      this.#options.onProblem?.(
        `The server sent something this app does not accept: ${r.error.message}`,
      );
    }
    this.#showClientDocument();
    if (this.client.incompatibility !== undefined) {
      this.#halt();
      return;
    }
    this.#pump(false);
    this.#saveSoon();
    this.#report();
  }

  /**
   * Saves the queue state a moment after a message changed it (an ack, a verdict), so a reload
   * does not resend what is settled. Nothing depends on it: the state saved before each send is
   * enough to be correct.
   */
  #saveSoon(): void {
    if (this.#saveTimer !== null || this.#stopped) return;
    this.#saveTimer = setTimeout(() => {
      this.#saveTimer = null;
      this.#chain = this.#chain.then(async () => {
        if (this.#stopped || this.client.incompatibility !== undefined) return;
        await this.#persist().catch(() => false);
      });
    }, this.#options.saveDelayMs ?? 1_000);
  }

  /** Brings the store to the client's document, as a remote change. */
  #showClientDocument(): void {
    const doc = this.client.document;
    const hidden = this.client.pending.some((e) => HIDDEN.has(e.state));
    if (!hidden) this.#beforeHidden = null;
    else this.#beforeHidden ??= this.#store.document;
    if (doc === this.#shown) return;
    const r = this.#store.applyRemote(doc);
    if (r.ok) this.#shown = doc;
    else this.#options.onProblem?.(`A synced change could not be shown: ${r.error.message}`);
  }

  #retryNow(): void {
    if (this.#stopped || !this.#connected) return;
    const waiting = this.client.pending.some(
      (e) => e.state === 'in-flight' || e.state === 'doomed',
    );
    if (waiting || this.#persistFailed !== null) this.#pump(true);
  }

  /**
   * Takes what is to be sent (`retry`: everything without a verdict again), saves the state, then
   * sends. One at a time, in order.
   */
  #pump(retry: boolean): void {
    this.#chain = this.#chain.then(async () => {
      if (this.#stopped || this.client.incompatibility !== undefined) return;
      if (!this.#connected || !this.#transport) return;
      const out: ClientMessage[] = retry ? this.client.retry() : this.client.takeOutgoing();
      if (out.length === 0) return;
      let saved: boolean;
      try {
        saved = await this.#persist();
      } catch {
        saved = false;
      }
      if (!saved) {
        // Nothing is sent that the saved state does not know about; `retry` sends it later.
        this.#persistFailed = 'The sync state could not be saved, so nothing was sent.';
        this.#schedulePersistRetry();
        this.#report();
        return;
      }
      this.#persistFailed = null;
      if (this.#stopped) return;
      for (const m of out) this.#transport?.send(m);
      this.#report();
    });
  }

  #schedulePersistRetry(): void {
    if (this.#persistTimer !== null || this.#stopped) return;
    this.#persistTimer = setTimeout(() => {
      this.#persistTimer = null;
      this.#pump(true);
    }, PERSIST_RETRY_MS);
  }

  #halt(): void {
    this.#clearTimers();
    const t = this.#transport;
    this.#transport = null;
    this.#connected = false;
    t?.close();
    this.#report();
  }

  #clearTimers(): void {
    if (this.#reconnectTimer !== null) clearTimeout(this.#reconnectTimer);
    if (this.#persistTimer !== null) clearTimeout(this.#persistTimer);
    if (this.#retryTimer !== null) clearInterval(this.#retryTimer);
    if (this.#saveTimer !== null) clearTimeout(this.#saveTimer);
    this.#reconnectTimer = this.#persistTimer = this.#retryTimer = this.#saveTimer = null;
  }

  #computeStatus(): LoopStatus {
    const error = this.client.incompatibility;
    if (error !== undefined) {
      if (error.code === 'server-fault') return { kind: 'fault', message: error.message };
      return appIsOlder(error)
        ? { kind: 'update-app', message: error.message }
        : { kind: 'upgrade-server', message: error.message };
    }
    const pending = this.client.pending.length;
    if (this.#persistFailed !== null) {
      return { kind: 'error', message: this.#persistFailed, pending };
    }
    if (!this.#online) return { kind: 'offline', pending };
    if (!this.#connected) return { kind: 'connecting', pending };
    return pending === 0 ? { kind: 'synced' } : { kind: 'pending', pending };
  }

  #report(): void {
    const next = this.#computeStatus();
    const prev = this.#status;
    if (prev !== null && JSON.stringify(prev) === JSON.stringify(next)) return;
    this.#status = next;
    this.#options.onStatus?.(next);
  }
}
