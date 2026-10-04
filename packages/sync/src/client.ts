import {
  DOCUMENT_SCOPE,
  FORMAT_VERSION,
  applyCommand,
  checkDocument,
  createdIds,
  documentCounters,
  emptyRemapReport,
  idCounter,
  idText,
  maxCounters,
  migrateCommand,
  nextNumber,
  remapCreatedIds,
  remapIds,
  remapScopeKey,
  restoredDocument,
  takenIds,
  TOMBSTONE_FIELD,
  TOMBSTONE_NAME,
  type Command,
  type CoreError,
  type CoreResult,
  type CounterTable,
  type CreatedIds,
  type ManufaktureDocument,
  type RemapReport,
  type RenameTable,
  type ScopeKey,
  type SyncEntry,
} from '@manufakture/core';
import { changedObjects, renameObjectKeys, type ObjectKey } from './objects';
import {
  CURRENT_VERSIONS,
  ENTRY_TOO_LARGE,
  MAX_ENTRIES_PER_MESSAGE,
  MAX_ENTRY_BYTES,
  MAX_MESSAGE_BYTES,
  PUSH_WINDOW,
  SUBMIT_OVERHEAD,
  ServerMessageSchema,
  checkVersions,
  describeIssues,
  jsonBytes,
  type ClientMessage,
  type HelloMessage,
  type ProtocolError,
  type PushedEntry,
  type Refusal,
  type ServerMessage,
} from './protocol';
import {
  SYNC_QUEUE_STATE_VERSION,
  SyncQueueStateSchema,
  checkQueueState,
  type EntryState,
  type SyncQueueState,
} from './state';

/**
 * The client engine of ADR 0009 (decisions 2, 4, 5, 6 and 8, with the amendment): a confirmed
 * document at a server revision, a queue of the client's own entries, rebase by replay with one
 * simultaneous rename table over the queue, undo and redo, and a saveable queue state. No
 * transport and no storage: messages go out through `takeOutgoing()` and `retry()` and come in
 * through `handle()`.
 */

export type Cause = 'execute' | 'undo' | 'redo';

/** A restore kept as its intent: the version it restores. */
export interface RestoreIntent {
  readonly document: ManufaktureDocument;
  /** The version's id, when it is a named one. */
  readonly version?: string;
}

export type SubmitInput =
  | { readonly command: Command; readonly label: string; readonly at?: string }
  /** Restore a past version: the command is `replaceDocument`, re-derived at every replay. */
  | { readonly restore: RestoreIntent; readonly label: string; readonly at?: string };

/** A command a rebase could not keep (ADR 0009 decision 4), for the user's notice. */
export interface DroppedCommand {
  readonly label: string;
  readonly cause: Cause;
  readonly command: Command;
  /** The server's refusal, or the `CoreError` of the local replay. */
  readonly error: Refusal;
}

/**
 * The client before a rebase that dropped commands (ADR 0009 decision 6): the confirmed document
 * and every pending command as they were before the others' entries arrived, for the app to keep
 * as a local branch.
 */
export interface PreRebaseState {
  readonly revision: number;
  readonly document: ManufaktureDocument;
  readonly commands: readonly { readonly label: string; readonly command: Command }[];
}

export interface SyncClientEvents {
  /** Ids were renamed (ADR 0009 decision 5): app state that names them follows `table`. */
  remapped: { readonly table: RenameTable; readonly report: RemapReport };
  /** A rebase dropped commands; `before` is the state to keep as a branch. */
  dropped: { readonly drops: readonly DroppedCommand[]; readonly before: PreRebaseState };
  /** The server speaks another protocol or format version. */
  incompatible: ProtocolError;
  /**
   * One of this client's entries was confirmed by the push stream at revision `rev`: the server's
   * document at `rev` holds it (T7.1e: a version made after it names that revision).
   */
  landed: { readonly local: number; readonly clientSeq: number; readonly rev: number };
}

export interface SyncClientOptions {
  readonly clientId: string;
  /** Whether entries are sent (default true). Offline, entries stay unsent and renameable. */
  readonly online?: boolean;
  /** The time an entry is made, ISO 8601 (default: now). */
  readonly now?: () => string;
  /** The server's high-water counters, when starting from a snapshot (default: the document's). */
  readonly highWater?: CounterTable;
  /**
   * How far past the revisions it has heard of the client trusts a revision from the server
   * (default `PUSH_WINDOW`). Smaller only in tests, to exercise the window; `restore` must be given
   * the same value.
   */
  readonly pushWindow?: number;
  /**
   * The largest entry sent, as JSON in UTF-8 bytes (default `MAX_ENTRY_BYTES`). A command whose
   * entry would be larger is dropped before it is sent, like a refused one: the notice, and the
   * work before it kept as a branch. Smaller only in tests.
   */
  readonly maxEntryBytes?: number;
  /**
   * The largest submit sent, in bytes (default `MAX_MESSAGE_BYTES`); at least `maxEntryBytes` plus
   * `SUBMIT_OVERHEAD`, so one entry always fits. Smaller only in tests.
   */
  readonly maxMessageBytes?: number;
}

export type UndoStatus = 'empty' | 'waiting' | 'ready';

export type UndoResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'empty' | 'waiting' }
  /** Another client changed what the command touched since (ADR 0009 decision 8). */
  | { readonly ok: false; readonly reason: 'changed'; readonly message: string }
  | { readonly ok: false; readonly reason: 'refused'; readonly error: CoreError };

export interface SyncClientStats {
  /** Entries the user made (executes, undos and redos). */
  made: number;
  /** Own entries confirmed by the push stream. */
  landed: number;
  /** Own entries dropped with a notice. */
  dropped: number;
  /** Own entries removed without one: an unsent entry undone, an inverse of a dropped command. */
  withdrawn: number;
  /** Rebases that renamed ids. */
  remaps: number;
  /** Entries handed to the transport again. */
  resubmits: number;
  /** An entry the client held as certain to be refused that the server accepted: a bug. */
  unexpectedAccepts: number;
}

interface Wire {
  readonly clientSeq: number;
  readonly prevSeq?: number;
  readonly baseRev: number;
  readonly format: number;
  readonly command: Command;
  readonly created: CreatedIds;
  transmitted: boolean;
  resend: boolean;
}

interface QueueEntry {
  readonly local: number;
  state: EntryState;
  readonly label: string;
  readonly cause: Cause;
  readonly at: string;
  command: Command;
  created: CreatedIds;
  readonly restore?: RestoreIntent;
  readonly undoOf?: number;
  wire?: Wire;
  verdict?: Refusal & { headRev: number };
  predecessorRefused?: true;
  certain?: true;
  acceptedRev?: number;
  /** From the latest replay: the command's inverse on the document before it (not saved). */
  inverse?: Command;
}

interface UndoRecord {
  readonly local: number;
  readonly label: string;
  inverse?: Command;
  touched: ObjectKey[];
  foreignChanged: boolean;
  confirmed: boolean;
}

interface RedoRecord {
  readonly local: number;
  readonly undoLocal?: number;
  readonly label: string;
  command: Command;
  readonly restore?: RestoreIntent;
}

type StoredCommand = SyncQueueState['entries'][number]['command'];
/** A command as stored JSON (it is plain JSON already). */
const stored = (c: Command): StoredCommand => c as unknown as StoredCommand;

type MutableTable = Record<ScopeKey, Record<string, string | null>>;
type MutableCounters = Record<ScopeKey, Record<string, number>>;

const HIDDEN_STATES: ReadonlySet<EntryState> = new Set([
  'held',
  'doomed',
  'predecessor-refused',
  'id-reused',
]);

/** Commands that tell the remap resolver which part an instance, setup or view shows. */
const DEFINERS: ReadonlySet<string> = new Set([
  'addInstance',
  'restoreInstance',
  'editInstance',
  'restoreAssembly',
  'addCamSetup',
  'restoreCamSetup',
  'editCamSetup',
  'addView',
  'editView',
  'restoreView',
  'addSheet',
  'restoreSheet',
  'addDrawing',
  'restoreDrawing',
  'replaceDocument',
]);

function defines(c: Command): boolean {
  return c.type === 'batch' ? c.commands.some(defines) : DEFINERS.has(c.type);
}

/** The (source, copy) part ids of the `duplicatePart` commands in a command. */
function duplicates(c: Command): [string, string][] {
  if (c.type === 'batch') return c.commands.flatMap(duplicates);
  return c.type === 'duplicatePart' ? [[c.sourcePartId, c.partId]] : [];
}

function isEmptyTable(table: RenameTable): boolean {
  return Object.values(table).every((t) => Object.keys(t).length === 0);
}

function setRename(table: MutableTable, scope: ScopeKey, from: string, to: string | null): void {
  (table[scope] ??= {})[from] = to;
}

function hasIds(created: CreatedIds): boolean {
  return Object.keys(created).length > 0;
}

/** Raises counters to cover `created`. */
function advance(next: MutableCounters, created: CreatedIds): void {
  for (const [scope, ids] of Object.entries(created)) {
    const into = (next[scope] ??= {});
    for (const id of ids) {
      const c = idCounter(id);
      if (c !== undefined) into[c.counter] = Math.max(nextNumber(into, c.counter), c.n + 1);
    }
  }
}

function raise(
  scope: ScopeKey,
  nextIds: Readonly<Record<string, number>>,
  need: MutableCounters,
): Readonly<Record<string, number>> {
  const want = need[scope];
  if (want === undefined) return nextIds;
  let out = nextIds;
  for (const [counter, n] of Object.entries(want)) {
    if (nextNumber(out, counter) < n) out = { ...out, [counter]: n };
  }
  return out;
}

/**
 * The document with every counter past the ids `entries` hold, so a new command never takes an id
 * a held entry already holds (ADR 0009 amendment, item 4).
 */
function reserve(doc: ManufaktureDocument, entries: readonly QueueEntry[]): ManufaktureDocument {
  const need: MutableCounters = {};
  for (const e of entries) advance(need, e.created);
  if (Object.keys(need).length === 0) return doc;
  return {
    ...doc,
    nextIds: raise(DOCUMENT_SCOPE, doc.nextIds, need),
    parts: doc.parts.map((p) => ({ ...p, nextIds: raise(`part:${p.id}`, p.nextIds, need) })),
    assemblies: doc.assemblies.map((a) => ({
      ...a,
      nextIds: raise(`assembly:${a.id}`, a.nextIds, need),
    })),
    cam: { ...doc.cam, nextIds: raise('cam', doc.cam.nextIds, need) },
    print: { ...doc.print, nextIds: raise('print', doc.print.nextIds, need) },
    ...(doc.drawings && {
      drawings: doc.drawings.map((d) => ({
        ...d,
        nextIds: raise(`drawing:${d.id}`, d.nextIds, need),
      })),
    }),
  };
}

/** Counters with sorted keys, so a saved state does not depend on the order counters appeared. */
function sortedCounters(table: CounterTable): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const scope of Object.keys(table).sort()) {
    const counters = table[scope]!;
    const into: Record<string, number> = (out[scope] = {});
    for (const c of Object.keys(counters).sort()) into[c] = counters[c]!;
  }
  return out;
}

function asRefusal(error: { code: string; message: string }): Refusal {
  return { code: error.code, message: error.message.slice(0, 2000) };
}

/**
 * A command with every sync tombstone (`kind#0`, `e0`, and the face-name number) replaced by an
 * ordinary id, so the schema can check the rest of it.
 */
/** The number a tombstone gets inside a face name. */
const TOMBSTONE_NAME_NUMBER = String(TOMBSTONE_NAME);

function withoutTombstones(command: unknown): unknown {
  const text = JSON.stringify(command)
    .replaceAll(TOMBSTONE_NAME_NUMBER, '1')
    .replace(new RegExp(`"([a-z][A-Za-z]*#|[a-z])${TOMBSTONE_FIELD}"`, 'g'), '"$11"');
  return JSON.parse(text) as unknown;
}

/**
 * A saved command, brought to the current format and validated (`strict`: it must pass the
 * schema). Otherwise a held entry, an undo inverse or a redo command may name a dropped command's
 * tombstones, which the schema refuses: such a command is kept when it passes with its tombstones
 * replaced, and its replay drops it. One saved under the current format is kept as it is; an
 * older one that only fails on tombstones stays as it was, and its replay drops it the same way.
 */
function migrated(command: unknown, format: number, strict = false): Command {
  const r = migrateCommand(command, format);
  if (r.ok) return format === FORMAT_VERSION ? (command as Command) : r.value;
  if (
    !strict &&
    r.error.code === 'schema' &&
    migrateCommand(withoutTombstones(command), format).ok
  ) {
    return command as Command;
  }
  throw new Error(`a saved command does not validate: ${r.error.message}`);
}

/** A restore's version, brought to the current format (and validated). */
function restoreDocument(document: unknown, format: number): ManufaktureDocument {
  if (format === FORMAT_VERSION) {
    const c = checkDocument(document as ManufaktureDocument);
    if (!c.ok) throw new Error(c.error.message);
    return document as ManufaktureDocument;
  }
  const r = migrateCommand({ type: 'replaceDocument', document }, format);
  if (!r.ok) throw new Error(r.error.message);
  if (r.value.type !== 'replaceDocument') throw new Error('expected a replaceDocument');
  return r.value.document;
}

/** Whether two JSON values are equal, whatever their keys' order. */
function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    return a.length === bb.length && a.every((x, i) => sameJson(x, bb[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const keys = Object.keys(ao).filter((k) => ao[k] !== undefined);
  if (keys.length !== Object.keys(bo).filter((k) => bo[k] !== undefined).length) return false;
  return keys.every((k) => Object.hasOwn(bo, k) && sameJson(ao[k], bo[k]));
}

/**
 * Whether a pushed copy of the client's own entry carries the command it sent. A copy under an
 * older format (sent before an app update) is compared after migration.
 */
function sameCommand(pushed: unknown, format: number, sent: Command): boolean {
  if (sameJson(pushed, sent)) return true;
  if (format === FORMAT_VERSION) return false;
  const m = migrateCommand(pushed, format);
  return m.ok && sameJson(m.value, sent);
}

/** Each command's size as JSON: commands are not changed in place, so the size is kept. */
const commandSizes = new WeakMap<object, number>();

function commandBytes(c: object): number {
  let n = commandSizes.get(c);
  if (n === undefined) {
    n = jsonBytes(c);
    commandSizes.set(c, n);
  }
  return n;
}

/** An entry's size as JSON in UTF-8 bytes, measuring its command once. */
function entryBytes(entry: Omit<SyncEntry, 'command'> & { readonly command: object }): number {
  // `null` stands in for the command: four bytes, replaced by the command's own size.
  return jsonBytes({ ...entry, command: null }) - 4 + commandBytes(entry.command);
}

type Listener<K extends keyof SyncClientEvents> = (event: SyncClientEvents[K]) => void;

export class SyncClient {
  readonly clientId: string;
  readonly stats: SyncClientStats = {
    made: 0,
    landed: 0,
    dropped: 0,
    withdrawn: 0,
    remaps: 0,
    resubmits: 0,
    unexpectedAccepts: 0,
  };
  private confirmed: ManufaktureDocument;
  private confirmedRev: number;
  private visible: ManufaktureDocument;
  private queue: QueueEntry[] = [];
  private nextSeq = 1;
  private latestAccepted: number | undefined;
  private nextLocal = 1;
  private readonly refusals = new Map<number, Refusal>();
  private pendingRenames: MutableTable = {};
  private highWater: CounterTable;
  private readonly buffer = new Map<number, PushedEntry>();
  /** The highest revision heard of (a welcome's head, a buffered entry): bounds server revisions. */
  private heard: number;
  private pullWanted: number | undefined;
  private pullRequested: number | undefined;
  private undoStack: UndoRecord[] = [];
  private redoStack: RedoRecord[] = [];
  private online: boolean;
  private incompatible: ProtocolError | undefined;
  private readonly now: () => string;
  private readonly listeners: { [K in keyof SyncClientEvents]: Set<Listener<K>> } = {
    remapped: new Set(),
    dropped: new Set(),
    incompatible: new Set(),
    landed: new Set(),
  };
  private readonly window: number;
  private readonly maxEntryBytes: number;
  private readonly maxMessageBytes: number;

  /** A client at `revision` of the server's log, whose confirmed document is `document`. */
  constructor(document: ManufaktureDocument, revision: number, options: SyncClientOptions) {
    this.clientId = options.clientId;
    this.confirmed = document;
    this.visible = document;
    this.confirmedRev = revision;
    this.heard = revision;
    this.online = options.online ?? true;
    this.now = options.now ?? (() => new Date().toISOString());
    this.window = options.pushWindow ?? PUSH_WINDOW;
    this.maxEntryBytes = options.maxEntryBytes ?? MAX_ENTRY_BYTES;
    this.maxMessageBytes = options.maxMessageBytes ?? MAX_MESSAGE_BYTES;
    if (this.maxMessageBytes < this.maxEntryBytes + SUBMIT_OVERHEAD) {
      throw new RangeError('maxMessageBytes must leave room for one entry of maxEntryBytes');
    }
    this.highWater = sortedCounters(
      maxCounters(options.highWater ?? {}, documentCounters(document)),
    );
  }

  /**
   * Rebuilds a client from `save()`'s state and the confirmed document saved with it. The state is
   * validated, and its commands are migrated from the format they were saved under.
   */
  static restore(
    state: unknown,
    document: ManufaktureDocument,
    options: Omit<SyncClientOptions, 'clientId' | 'highWater'> = {},
  ): CoreResult<SyncClient> {
    const parsed = SyncQueueStateSchema.safeParse(state);
    if (!parsed.success) {
      return {
        ok: false,
        error: {
          code: 'schema',
          message: `Invalid sync queue state: ${describeIssues(parsed.error)}`,
          path: [],
        },
      };
    }
    const s = parsed.data;
    const inconsistent = checkQueueState(s, options.pushWindow ?? PUSH_WINDOW);
    if (inconsistent !== undefined) {
      return {
        ok: false,
        error: {
          code: 'schema',
          message: `Inconsistent sync queue state: ${inconsistent}`,
          path: [],
        },
      };
    }
    try {
      const client = new SyncClient(document, s.confirmedRev, {
        ...options,
        clientId: s.clientId,
        highWater: s.highWater,
      });
      client.load(s);
      return { ok: true, value: client };
    } catch (e) {
      return {
        ok: false,
        error: {
          code: 'migration',
          message: `Cannot restore the sync queue: ${String(e)}`,
          path: [],
        },
      };
    }
  }

  private load(s: SyncQueueState): void {
    const f = s.format;
    const restoreOf = (
      r: SyncQueueState['entries'][number]['restore'],
    ): RestoreIntent | undefined =>
      r === undefined
        ? undefined
        : {
            document: restoreDocument(r.document, f),
            ...(r.version !== undefined && { version: r.version }),
          };
    this.nextSeq = s.nextSeq;
    if (s.latestAccepted !== undefined) this.latestAccepted = s.latestAccepted;
    this.nextLocal = s.nextLocal;
    this.queue = s.entries.map((e) => {
      const restore = restoreOf(e.restore);
      const entry: QueueEntry = {
        local: e.local,
        state: e.state,
        label: e.label,
        cause: e.cause,
        at: e.at,
        command: migrated(e.command, f),
        created: e.created,
        ...(restore && { restore }),
        ...(e.undoOf !== undefined && { undoOf: e.undoOf }),
        ...(e.predecessorRefused && { predecessorRefused: true as const }),
        ...(e.certain && { certain: true as const }),
        ...(e.acceptedRev !== undefined && { acceptedRev: e.acceptedRev }),
      };
      if (e.verdict) entry.verdict = { ...e.verdict };
      if (e.wire) {
        // A command sent under an older format is resent upgraded, so it is labelled with the
        // current format: the server and other clients must not migrate it a second time.
        entry.wire = {
          clientSeq: e.wire.clientSeq,
          ...(e.wire.prevSeq !== undefined && { prevSeq: e.wire.prevSeq }),
          baseRev: e.wire.baseRev,
          format: FORMAT_VERSION,
          command: migrated(e.wire.command, e.wire.format, true),
          created: e.wire.created,
          transmitted: e.wire.transmitted,
          resend: e.wire.resend,
        };
      }
      return entry;
    });
    for (const r of s.refusals) this.refusals.set(r.clientSeq, r.error);
    this.pendingRenames = structuredClone(s.pendingRenames) as MutableTable;
    for (const p of s.buffered) {
      this.buffer.set(p.rev, p);
      this.heard = Math.max(this.heard, p.rev);
    }
    if (s.pullWanted !== undefined) this.pullWanted = s.pullWanted;
    if (s.pullRequested !== undefined) this.pullRequested = s.pullRequested;
    this.undoStack = s.undo.map((u) => ({
      local: u.local,
      label: u.label,
      ...(u.inverse && { inverse: migrated(u.inverse, f) }),
      touched: [...u.touched],
      foreignChanged: u.foreignChanged,
      confirmed: u.confirmed,
    }));
    this.redoStack = s.redo.map((r) => {
      const restore = restoreOf(r.restore);
      return {
        local: r.local,
        ...(r.undoLocal !== undefined && { undoLocal: r.undoLocal }),
        label: r.label,
        command: migrated(r.command, f),
        ...(restore && { restore }),
      };
    });
    this.recomputeView();
  }

  /** The queue state as plain JSON; save it with `confirmedDocument`. */
  save(): SyncQueueState {
    const restore = (r: RestoreIntent | undefined) =>
      r === undefined
        ? undefined
        : {
            document: r.document as unknown as Record<string, unknown>,
            ...(r.version !== undefined && { version: r.version }),
          };
    const state: SyncQueueState = {
      version: SYNC_QUEUE_STATE_VERSION,
      format: FORMAT_VERSION,
      clientId: this.clientId,
      confirmedRev: this.confirmedRev,
      nextSeq: this.nextSeq,
      ...(this.latestAccepted !== undefined && { latestAccepted: this.latestAccepted }),
      nextLocal: this.nextLocal,
      entries: this.queue.map((e) => {
        const r = restore(e.restore);
        return {
          local: e.local,
          state: e.state,
          label: e.label,
          cause: e.cause,
          at: e.at,
          command: stored(e.command),
          created: e.created as Record<string, string[]>,
          ...(r && { restore: r }),
          ...(e.undoOf !== undefined && { undoOf: e.undoOf }),
          ...(e.wire && {
            wire: {
              clientSeq: e.wire.clientSeq,
              ...(e.wire.prevSeq !== undefined && { prevSeq: e.wire.prevSeq }),
              baseRev: e.wire.baseRev,
              format: e.wire.format,
              command: stored(e.wire.command),
              created: e.wire.created as Record<string, string[]>,
              transmitted: e.wire.transmitted,
              resend: e.wire.resend,
            },
          }),
          ...(e.verdict && { verdict: { ...e.verdict } }),
          ...(e.predecessorRefused && { predecessorRefused: true as const }),
          ...(e.certain && { certain: true as const }),
          ...(e.acceptedRev !== undefined && { acceptedRev: e.acceptedRev }),
        };
      }),
      refusals: [...this.refusals]
        .sort((a, b) => a[0] - b[0])
        .map(([clientSeq, error]) => ({ clientSeq, error })),
      pendingRenames: structuredClone(this.pendingRenames),
      highWater: sortedCounters(this.highWater),
      buffered: [...this.buffer.values()].sort((a, b) => a.rev - b.rev),
      ...(this.pullWanted !== undefined && { pullWanted: this.pullWanted }),
      ...(this.pullRequested !== undefined && { pullRequested: this.pullRequested }),
      undo: this.undoStack.map((u) => ({
        local: u.local,
        label: u.label,
        ...(u.inverse && { inverse: stored(u.inverse) }),
        touched: [...u.touched],
        foreignChanged: u.foreignChanged,
        confirmed: u.confirmed,
      })),
      redo: this.redoStack.map((r) => {
        const rs = restore(r.restore);
        return {
          local: r.local,
          ...(r.undoLocal !== undefined && { undoLocal: r.undoLocal }),
          label: r.label,
          command: stored(r.command),
          ...(rs && { restore: rs }),
        };
      }),
    };
    return state;
  }

  /** The last document the server confirmed. */
  get confirmedDocument(): ManufaktureDocument {
    return this.confirmed;
  }

  /** The revision of `confirmedDocument`. */
  get confirmedRevision(): number {
    return this.confirmedRev;
  }

  /** What the user sees: confirmed plus the shown pending entries. */
  get document(): ManufaktureDocument {
    return this.visible;
  }

  /** The pending entries, in queue order. */
  get pending(): readonly {
    readonly local: number;
    readonly label: string;
    readonly cause: Cause;
    readonly state: EntryState;
    readonly command: Command;
    readonly clientSeq?: number;
    readonly prevSeq?: number;
    readonly sent?: Command;
  }[] {
    return this.queue.map((e) => ({
      local: e.local,
      label: e.label,
      cause: e.cause,
      state: e.state,
      command: e.command,
      ...(e.wire && { clientSeq: e.wire.clientSeq, sent: e.wire.command }),
      ...(e.wire?.prevSeq !== undefined && { prevSeq: e.wire.prevSeq }),
    }));
  }

  /** Set when the server speaks another protocol or format version: nothing is applied. */
  get incompatibility(): ProtocolError | undefined {
    return this.incompatible;
  }

  on<K extends keyof SyncClientEvents>(event: K, listener: Listener<K>): () => void {
    const set = this.listeners[event] as Set<Listener<K>>;
    set.add(listener);
    return () => set.delete(listener);
  }

  private emit<K extends keyof SyncClientEvents>(event: K, payload: SyncClientEvents[K]): void {
    for (const l of this.listeners[event] as Set<Listener<K>>) l(payload);
  }

  /** The hello to open a connection with. */
  hello(): HelloMessage {
    return { type: 'hello', ...CURRENT_VERSIONS, clientId: this.clientId };
  }

  /** Online, unsent entries are sent; offline, they stay unsent (and renameable). */
  setOnline(online: boolean): void {
    if (this.online === online) return;
    this.online = online;
    if (online) this.sendUnsent();
  }

  // ---------------------------------------------------------------------------------------------
  // Local commands

  /**
   * Queues a command the user made on `document`. It must apply there; its created ids are
   * computed there. Clears the redo stack.
   */
  submit(input: SubmitInput): CoreResult<{ readonly local: number }> {
    return this.make(input, 'execute');
  }

  private make(
    input: SubmitInput,
    cause: Cause,
    undoOf?: number,
  ): CoreResult<{ readonly local: number }> {
    const restore = 'restore' in input ? input.restore : undefined;
    const command: Command =
      restore !== undefined
        ? {
            type: 'replaceDocument',
            document: restoredDocument(this.visible, restore.document, this.highWater),
          }
        : (input as { command: Command }).command;
    const applied = applyCommand(this.visible, command);
    if (!applied.ok) return applied;
    const created = createdIds(this.visible, command);
    if (!created.ok) return created;
    const entry: QueueEntry = {
      local: this.nextLocal++,
      state: 'unsent',
      label: input.label.slice(0, 1000),
      cause,
      at: input.at ?? this.now(),
      command,
      created: created.value,
      ...(restore && { restore }),
      ...(undoOf !== undefined && { undoOf }),
      inverse: applied.value.inverse,
    };
    this.stats.made++;
    if (cause === 'execute') this.redoStack = [];
    if (cause !== 'undo') {
      this.undoStack.push({
        local: entry.local,
        label: entry.label,
        touched: [],
        foreignChanged: false,
        confirmed: false,
      });
    }
    const anyHidden = this.queue.some((e) => HIDDEN_STATES.has(e.state));
    this.queue.push(entry);
    if (anyHidden || this.oversized(entry) !== undefined) {
      // Behind a held entry: held too, until the held ones are resolved (decision 4). Too large to
      // send: the rebase drops it, with the notice and the branch fallback.
      this.rebase(this.snapshot());
    } else {
      this.visible = applied.value.document;
      this.sendUnsent();
    }
    return { ok: true, value: { local: entry.local } };
  }

  /** Whether undo can act now: `waiting` while a held entry follows the newest shown command. */
  undoStatus(): UndoStatus {
    if (this.undoStack.length === 0) return 'empty';
    return this.queue.some((e) => HIDDEN_STATES.has(e.state)) ? 'waiting' : 'ready';
  }

  /** Whether redo can act now. */
  redoStatus(): UndoStatus {
    if (this.redoStack.length === 0) return 'empty';
    return this.queue.some((e) => HIDDEN_STATES.has(e.state)) ? 'waiting' : 'ready';
  }

  /** The label of the command undo would undo. */
  get undoLabel(): string | undefined {
    return this.visibleUndo().at(-1)?.label;
  }

  /**
   * The undo stack as the user sees it: a held entry (held, doomed, or refused and not yet
   * renamed) is hidden like the entry itself, and comes back when it returns or lands.
   */
  visibleUndo(): readonly { readonly local: number; readonly label: string }[] {
    const hidden = new Set(
      this.queue.filter((e) => HIDDEN_STATES.has(e.state)).map((e) => e.local),
    );
    return this.undoStack
      .filter((u) => !hidden.has(u.local))
      .map((u) => ({ local: u.local, label: u.label }));
  }

  /**
   * Undoes the newest shown command (ADR 0009 decision 8): an unsent one is removed from the
   * queue; otherwise its inverse is submitted, unless another client changed what it touched.
   */
  undo(): UndoResult {
    const status = this.undoStatus();
    if (status !== 'ready') return { ok: false, reason: status };
    const record = this.undoStack.at(-1)!;
    const entry = this.queue.find((e) => e.local === record.local);
    if (entry !== undefined && entry.wire === undefined && this.queue.at(-1) === entry) {
      this.queue.pop();
      this.undoStack.pop();
      this.redoStack.push({
        local: entry.local,
        label: entry.label,
        command: entry.command,
        ...(entry.restore && { restore: entry.restore }),
      });
      this.stats.withdrawn++;
      this.recomputeView();
      return { ok: true };
    }
    if (record.foreignChanged) {
      return {
        ok: false,
        reason: 'changed',
        message: `${record.label} was changed by another edit`,
      };
    }
    const inverse = entry !== undefined ? entry.inverse : record.inverse;
    if (inverse === undefined) {
      return {
        ok: false,
        reason: 'refused',
        error: { code: 'empty-history', message: 'Nothing to undo', path: [] },
      };
    }
    const applied = applyCommand(this.visible, inverse);
    if (!applied.ok) return { ok: false, reason: 'refused', error: applied.error };
    const redoCommand = applied.value.inverse;
    this.undoStack.pop();
    const made = this.make({ command: inverse, label: record.label }, 'undo', record.local);
    if (!made.ok) {
      this.undoStack.push(record);
      return { ok: false, reason: 'refused', error: made.error };
    }
    this.redoStack.push({
      local: record.local,
      undoLocal: made.value.local,
      label: record.label,
      command: redoCommand,
    });
    return { ok: true };
  }

  /** Redoes the newest undone command, as a new entry. */
  redo(): UndoResult {
    const status = this.redoStatus();
    if (status !== 'ready') return { ok: false, reason: status };
    const record = this.redoStack.pop()!;
    const made = this.make(
      record.restore
        ? { restore: record.restore, label: record.label }
        : { command: record.command, label: record.label },
      'redo',
    );
    return made.ok ? { ok: true } : { ok: false, reason: 'refused', error: made.error };
  }

  // ---------------------------------------------------------------------------------------------
  // Messages in

  /** Handles one message from the server, validating it first. */
  handle(raw: unknown): CoreResult<void> {
    const parsed = ServerMessageSchema.safeParse(raw);
    if (!parsed.success) {
      return {
        ok: false,
        error: {
          code: 'schema',
          message: `Invalid server message: ${describeIssues(parsed.error)}`,
          path: [],
        },
      };
    }
    return this.handleParsed(parsed.data);
  }

  private handleParsed(m: ServerMessage): CoreResult<void> {
    switch (m.type) {
      case 'welcome': {
        const skew = checkVersions(CURRENT_VERSIONS, m);
        if (skew !== undefined) return this.refuseServer(skew);
        this.heard = Math.max(this.heard, m.head);
        if (m.head > this.confirmedRev) this.wantPull(m.head);
        return { ok: true, value: undefined };
      }
      case 'error':
        if (m.code === 'protocol-version' || m.code === 'format-version') {
          return this.refuseServer(m);
        }
        // A late copy of an entry this client has resolved (the floor only passes those).
        if (m.code === 'below-floor') return { ok: true, value: undefined };
        return { ok: false, error: { code: 'schema', message: m.message, path: [] } };
      case 'ack':
        this.accepted(m.clientSeq, m.rev);
        return { ok: true, value: undefined };
      case 'refuse':
        this.refused(m.clientSeq, m.error, m.headRev);
        return { ok: true, value: undefined };
      case 'predecessor-unknown':
        this.predecessorUnknown(m.clientSeq);
        return { ok: true, value: undefined };
      case 'push':
        return this.receive(m.entries);
    }
  }

  private refuseServer(error: ProtocolError): CoreResult<void> {
    this.incompatible = error;
    this.emit('incompatible', error);
    return { ok: false, error: { code: 'version', message: error.message, path: [] } };
  }

  /**
   * A revision the server named (a refusal's head, an ack's revision, a pull target), clamped to
   * `PUSH_WINDOW` past the confirmed revision, so a server cannot park an entry behind a revision
   * that never comes. The confirmed revision only grows, so a saved value stays within the bound
   * `checkQueueState` holds a restored state to. A head further away is reached window by window:
   * `heard` keeps it, and the pull goes on once the client gets there.
   */
  private bounded(rev: number): number {
    return Math.min(rev, this.confirmedRev + this.window);
  }

  /**
   * The server's log disagrees with this client: nothing more is applied or sent, as for a
   * version mismatch. The state stays consistent (and saveable) at the last applied revision.
   */
  private serverFault(message: string): CoreResult<void> {
    return this.refuseServer({
      type: 'error',
      code: 'server-fault',
      message: message.slice(0, 2000),
    });
  }

  private wantPull(rev: number): void {
    this.pullWanted = Math.max(this.pullWanted ?? 0, this.bounded(rev));
  }

  /**
   * Accepted entries from the push stream or a pull, in any order and with duplicates. They are
   * applied in revision order; the client's own entries are matched to in-flight entries by
   * `clientSeq` first, which is their acknowledgement (so a lost ack is recovered here).
   */
  receive(entries: readonly PushedEntry[]): CoreResult<void> {
    if (this.incompatible !== undefined) {
      return {
        ok: false,
        error: { code: 'version', message: this.incompatible.message, path: [] },
      };
    }
    const before = this.snapshot();
    // Entries beyond the window are not buffered (the buffer stays bounded); a pull fetches them.
    const limit = this.confirmedRev + this.window;
    /** The highest revision pushed beyond the window (0: none). */
    let beyond = 0;
    for (const p of entries) {
      if (p.rev <= this.confirmedRev) continue;
      if (p.rev > limit) {
        beyond = Math.max(beyond, p.rev);
        continue;
      }
      this.buffer.set(p.rev, p);
      this.heard = Math.max(this.heard, p.rev);
    }
    let moved = false;
    const landed: SyncClientEvents['landed'][] = [];
    let failure: CoreError | undefined;
    let fault: string | undefined;
    for (
      let p = this.buffer.get(this.confirmedRev + 1);
      p;
      p = this.buffer.get(this.confirmedRev + 1)
    ) {
      const mine = p.entry.clientId === this.clientId;
      if (mine && p.entry.clientSeq >= this.nextSeq) {
        // This client never handed out that sequence: applying it would raise `latestAccepted`
        // past `nextSeq`, and the saved state would no longer restore.
        fault = `Confirmed entry ${p.rev} names this client's sequence ${p.entry.clientSeq}, never sent`;
        break;
      }
      const own = mine
        ? this.queue.find((e) => e.wire?.clientSeq === p!.entry.clientSeq)
        : undefined;
      let command: Command;
      if (own !== undefined) {
        command = own.wire!.command;
        if (!sameCommand(p.entry.command, p.entry.format, command)) {
          fault = `Confirmed entry ${p.rev} is this client's entry ${p.entry.clientSeq}, changed`;
          break;
        }
      } else {
        const m = migrateCommand(p.entry.command, p.entry.format);
        if (!m.ok) {
          failure = m.error;
          break;
        }
        command = m.value;
      }
      const r = applyCommand(this.confirmed, command);
      if (!r.ok) {
        // The server applied it to the same document: the log and this client disagree.
        fault = `Confirmed entry ${p.rev} does not apply: ${r.error.message}`;
        break;
      }
      this.buffer.delete(p.rev);
      const prev = this.confirmed;
      this.confirmed = r.value.document;
      this.confirmedRev = p.rev;
      this.highWater = sortedCounters(
        maxCounters(this.highWater, documentCounters(this.confirmed)),
      );
      moved = true;
      if (own !== undefined)
        landed.push({ local: own.local, clientSeq: own.wire!.clientSeq, rev: p.rev });
      if (mine) {
        this.latestAccepted = Math.max(this.latestAccepted ?? 0, p.entry.clientSeq);
      }
      if (own !== undefined) {
        if (own.certain || own.state === 'doomed') this.stats.unexpectedAccepts++;
        this.queue.splice(this.queue.indexOf(own), 1);
        this.stats.landed++;
        const record = this.undoStack.find((u) => u.local === own.local);
        if (record !== undefined) {
          record.confirmed = true;
          record.inverse = r.value.inverse;
          record.touched = changedObjects(prev, this.confirmed);
        }
      } else if (this.undoStack.some((u) => u.confirmed)) {
        // Selective undo (decision 8): what another change did to objects that were there.
        const changed = new Set(changedObjects(prev, this.confirmed, true));
        for (const u of this.undoStack) {
          if (u.confirmed && !u.foreignChanged && u.touched.some((k) => changed.has(k))) {
            u.foreignChanged = true;
          }
        }
      }
    }
    if (failure !== undefined || fault !== undefined) {
      // The entry that failed is not kept: a saved state never holds an entry that cannot apply,
      // and a pull (after an app update, for a format the client cannot read yet) fetches it again.
      this.buffer.clear();
    }
    if (this.pullWanted !== undefined) {
      if (this.confirmedRev >= this.pullWanted) {
        this.pullWanted = undefined;
        this.pullRequested = undefined;
      } else if (moved) {
        this.pullRequested = undefined;
      }
    }
    let lowest = Infinity;
    for (const rev of this.buffer.keys()) lowest = Math.min(lowest, rev);
    if (lowest !== Infinity) this.wantPull(lowest - 1);
    // Pulled toward the furthest entry seen, from where the client is now: `limit` was the window
    // before this delivery moved it, and pulling to it would stop where the client already is.
    else if (beyond > 0) this.wantPull(beyond);
    // A head beyond the last window: the pull goes on from here.
    if (this.heard > this.confirmedRev) this.wantPull(this.heard);
    // The entry that could not be read was dropped from the buffer: fetch it again (after an app
    // update, for a newer format), even when nothing else was waiting.
    if (failure !== undefined) this.wantPull(this.confirmedRev + 1);
    // What was applied is rebased before anything else, so the queue matches the confirmed document.
    if (moved) this.rebase(before);
    for (const l of landed) this.emit('landed', l);
    if (fault !== undefined) return this.serverFault(fault);
    return failure === undefined ? { ok: true, value: undefined } : { ok: false, error: failure };
  }

  /** The server accepted `clientSeq` at `rev`; the push stream will confirm it. */
  accepted(clientSeq: number, rev: number): void {
    const e = this.queue.find((x) => x.wire?.clientSeq === clientSeq);
    if (e === undefined) return;
    // Clamped where it is used (`retry`), against the bound of that moment.
    e.acceptedRev = rev;
    e.wire!.resend = false;
  }

  /**
   * The server refused `clientSeq`. A verdict belongs to one `clientSeq` (amendment, item 5): one
   * for a sequence no entry is in flight under is stale and ignored.
   */
  refused(clientSeq: number, error: Refusal, headRev: number): void {
    const e = this.queue.find((x) => x.wire?.clientSeq === clientSeq);
    if (e === undefined || e.verdict !== undefined || e.predecessorRefused) return;
    const before = this.snapshot();
    const head = this.bounded(headRev);
    e.verdict = { ...error, headRev: head };
    e.wire!.resend = false;
    this.refusals.set(clientSeq, error);
    if (error.code === 'predecessor-refused' && e.wire!.prevSeq !== undefined) {
      // Its predecessor was refused: everything chained to it is doomed (decision 4).
      if (!this.refusals.has(e.wire!.prevSeq)) {
        this.refusals.set(e.wire!.prevSeq, {
          code: 'refused',
          message: 'Refused (learned from a later entry)',
        });
      }
    }
    if (head > this.confirmedRev) this.wantPull(head);
    this.rebase(before);
  }

  /**
   * Not a verdict: the entry stays in flight, unchanged, and is sent again after its predecessors
   * (every in-flight entry up to it, in `clientSeq` order, in one submit).
   */
  predecessorUnknown(clientSeq: number): void {
    const e = this.queue.find((x) => x.wire?.clientSeq === clientSeq);
    if (e === undefined) return;
    for (const x of this.queue) {
      if (x.wire !== undefined && x.wire.clientSeq <= clientSeq && this.retryable(x)) {
        x.wire.resend = true;
      }
    }
  }

  private retryable(e: QueueEntry): boolean {
    return (
      e.wire !== undefined &&
      e.verdict === undefined &&
      e.predecessorRefused === undefined &&
      e.acceptedRev === undefined
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Messages out

  /**
   * Messages to send now: newly sent entries and requested resends (one submit, in `clientSeq`
   * order, with the retention floor), and a pull when the client is behind a revision it heard of.
   */
  takeOutgoing(): ClientMessage[] {
    const out: ClientMessage[] = [];
    if (!this.online || this.incompatible !== undefined) return out;
    const send = this.queue
      .filter((e) => this.retryable(e) && (!e.wire!.transmitted || e.wire!.resend))
      .sort((a, b) => a.wire!.clientSeq - b.wire!.clientSeq);
    if (send.length > 0) {
      // Cut by count and by bytes: no submit is larger than the server's message limit, which
      // would close the connection, and one entry (at most `maxEntryBytes`) always fits.
      const floor = this.floor();
      let entries: SyncEntry[] = [];
      let bytes = SUBMIT_OVERHEAD;
      for (const e of send) {
        const entry = this.syncEntry(e);
        const size = entryBytes(entry);
        if (
          entries.length > 0 &&
          (entries.length >= MAX_ENTRIES_PER_MESSAGE || bytes + 1 + size > this.maxMessageBytes)
        ) {
          out.push({ type: 'submit', entries, floor });
          entries = [];
          bytes = SUBMIT_OVERHEAD;
        }
        bytes += size + (entries.length > 0 ? 1 : 0);
        entries.push(entry);
        if (e.wire!.transmitted) this.stats.resubmits++;
        e.wire!.transmitted = true;
        e.wire!.resend = false;
      }
      if (entries.length > 0) out.push({ type: 'submit', entries, floor });
    }
    if (
      this.pullWanted !== undefined &&
      this.pullWanted > this.confirmedRev &&
      this.pullRequested !== this.pullWanted
    ) {
      this.pullRequested = this.pullWanted;
      out.push({ type: 'pull', since: this.confirmedRev });
    }
    return out;
  }

  /**
   * After a timeout: every in-flight entry without a verdict is sent again (in `clientSeq` order),
   * and an outstanding pull is asked for again.
   */
  retry(): ClientMessage[] {
    for (const e of this.queue) if (this.retryable(e)) e.wire!.resend = true;
    let acked = 0;
    for (const e of this.queue)
      if (e.acceptedRev !== undefined) acked = Math.max(acked, e.acceptedRev);
    if (acked > 0) this.wantPull(acked);
    this.pullRequested = undefined;
    return this.takeOutgoing();
  }

  /** The lowest sequence the client may still name (ADR 0009 decision 2). */
  private floor(): number {
    let floor = this.nextSeq;
    for (const e of this.queue) {
      if (e.wire === undefined) continue;
      floor = Math.min(floor, e.wire.clientSeq, e.wire.prevSeq ?? Infinity);
    }
    return floor;
  }

  /**
   * The refusal for an unsent entry too large to send, or undefined. Measured as it would be sent,
   * with every sequence and revision at its widest, so an entry that passes here fits once sent.
   */
  private oversized(e: QueueEntry): Refusal | undefined {
    const widest = Number.MAX_SAFE_INTEGER;
    const bytes = entryBytes({
      clientId: this.clientId,
      clientSeq: widest,
      prevSeq: widest,
      baseRev: widest,
      format: FORMAT_VERSION,
      cause: e.cause,
      label: e.label,
      command: e.command,
      created: e.created as SyncEntry['created'],
      at: e.at,
    });
    if (bytes <= this.maxEntryBytes) return undefined;
    return {
      code: ENTRY_TOO_LARGE,
      message: `The change is ${bytes} bytes, more than the ${this.maxEntryBytes} sync takes`,
    };
  }

  private syncEntry(e: QueueEntry): SyncEntry {
    const w = e.wire!;
    return {
      clientId: this.clientId,
      clientSeq: w.clientSeq,
      ...(w.prevSeq !== undefined && { prevSeq: w.prevSeq }),
      baseRev: w.baseRev,
      format: w.format,
      cause: e.cause,
      label: e.label,
      command: w.command as SyncEntry['command'],
      created: w.created as SyncEntry['created'],
      at: e.at,
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Rebase

  private snapshot(): PreRebaseState {
    return {
      revision: this.confirmedRev,
      document: this.confirmed,
      commands: this.queue.map((e) => ({ label: e.label, command: e.command })),
    };
  }

  /** Acts on refusals whose head revision has been pulled. */
  private processVerdicts(drops: DroppedCommand[]): void {
    for (const e of [...this.queue]) {
      if (e.wire === undefined || !this.queue.includes(e)) continue;
      if (e.verdict !== undefined && e.verdict.headRev <= this.confirmedRev) {
        const { code, message } = e.verdict;
        delete e.verdict;
        if (code === 'id-reused') {
          this.toUnsent(e);
          continue;
        } else if (code === 'predecessor-refused') {
          e.predecessorRefused = true;
        } else {
          this.drop(e, { code, message }, this.pendingRenames, e.created, drops);
          continue;
        }
      }
      if (e.predecessorRefused) {
        const prevSeq = e.wire.prevSeq;
        const pred = this.queue.find((x) => x.wire !== undefined && x.wire.clientSeq === prevSeq);
        // The predecessor was renamed (and resent) or dropped: this one goes back to unsent.
        if (pred === undefined) this.toUnsent(e);
      }
    }
  }

  private toUnsent(e: QueueEntry): void {
    delete e.wire;
    delete e.verdict;
    delete e.predecessorRefused;
    delete e.certain;
    delete e.acceptedRev;
    e.state = 'unsent';
  }

  /**
   * Removes a dropped entry. Its created ids become tombstones in `table` (keyed in the naming the
   * table's keys use), so an entry that names them fails instead of binding to whatever later takes
   * the number (amendment, item 7). An undo inverse of it goes with it, without a notice.
   */
  private drop(
    e: QueueEntry,
    error: Refusal,
    table: MutableTable,
    created: CreatedIds,
    drops: DroppedCommand[] | undefined,
  ): void {
    const i = this.queue.indexOf(e);
    if (i < 0) return;
    for (const [scope, ids] of Object.entries(created)) {
      for (const id of ids) setRename(table, scope, id, null);
    }
    this.queue.splice(i, 1);
    if (e.wire !== undefined && !this.refusals.has(e.wire.clientSeq)) {
      // Still in flight: the server will refuse it (its chain is refused), and anything that
      // names it is doomed.
      this.refusals.set(e.wire.clientSeq, error);
    }
    this.undoStack = this.undoStack.filter((u) => u.local !== e.local);
    this.redoStack = this.redoStack.filter((r) => r.local !== e.local && r.undoLocal !== e.local);
    if (drops !== undefined) {
      drops.push({ label: e.label, cause: e.cause, command: e.command, error });
      this.stats.dropped++;
    } else {
      this.stats.withdrawn++;
    }
    for (const x of [...this.queue]) {
      if (x.undoOf === e.local) this.drop(x, error, table, x.created, undefined);
    }
  }

  /**
   * Rebase by replay (decisions 4 and 5, amendment items 4 to 8). In-flight entries that may
   * still be accepted are replayed unchanged; then one pass over the queue gives every entry that
   * may be renamed the next free numbers for its own created ids and rewrites it through one
   * simultaneous table, keyed in the client's current naming; then shown entries are replayed and
   * unsent ones sent.
   */
  private rebase(before: PreRebaseState): void {
    const drops: DroppedCommand[] = [];
    this.processVerdicts(drops);

    // In-flight entries that may still be accepted: replayed unchanged.
    let doc = this.confirmed;
    const doomed = new Set<number>();
    const frozen = new Set<QueueEntry>();
    const hidden = new Set<QueueEntry>();
    let blocked = false;
    for (const e of this.queue) {
      const w = e.wire;
      if (w === undefined) continue;
      const knownRefused =
        e.verdict !== undefined ||
        e.predecessorRefused === true ||
        e.certain === true ||
        this.refusals.has(w.clientSeq);
      const chained =
        w.prevSeq !== undefined && (this.refusals.has(w.prevSeq) || doomed.has(w.prevSeq));
      if (knownRefused || chained) {
        doomed.add(w.clientSeq);
        hidden.add(e);
        blocked = true;
        continue;
      }
      frozen.add(e);
      if (blocked) {
        hidden.add(e);
        continue;
      }
      // Counters only grow: created ids below the confirmed counters can never be accepted.
      const taken = hasIds(takenIds(documentCounters(doc), w.created));
      const r = taken ? undefined : applyCommand(doc, w.command);
      if (r?.ok) {
        doc = r.value.document;
        e.inverse = r.value.inverse;
      } else if (r === undefined || r.error.code === 'id-reused') {
        // Certain to be refused: rename it in the client's naming now (amendment, item 4).
        e.certain = true;
        frozen.delete(e);
        doomed.add(w.clientSeq);
        hidden.add(e);
        blocked = true;
      } else {
        hidden.add(e);
        blocked = true;
      }
    }

    // One pass in queue order with one simultaneous table.
    const confirmedScopes = documentCounters(this.confirmed);
    const table: MutableTable = this.pendingRenames;
    this.pendingRenames = {};
    const next = structuredClone(documentCounters(doc)) as MutableCounters;
    const aliases = new Set<ScopeKey>();
    const definers: Command[] = [];
    const report = emptyRemapReport();
    let renamed = false;
    blocked = false;
    for (const e of [...this.queue]) {
      if (!this.queue.includes(e)) continue;
      if (frozen.has(e)) {
        if (hidden.has(e)) {
          blocked = true;
          advance(next, e.created);
        }
        if (defines(e.command)) definers.push(e.command);
        continue;
      }
      const oldCommand = e.command;
      const oldCreated = e.created;
      this.allocate(oldCreated, table, next, confirmedScopes, aliases);
      for (const [src, dst] of duplicates(oldCommand)) {
        // A duplicated part's ids are copies of the source's: they follow the source part's
        // renames so far, and its counters start from the source's (amendment, item 8).
        const from = table[`part:${src}`];
        if (from !== undefined) {
          const into = (table[`part:${dst}`] ??= {});
          for (const [k, v] of Object.entries(from)) if (!Object.hasOwn(into, k)) into[k] = v;
        }
        const newSrc = remapScopeKey(`part:${src}`, table);
        const newDst = remapScopeKey(`part:${dst}`, table);
        aliases.add(newDst);
        const srcCounters = next[newSrc];
        if (srcCounters !== undefined) {
          const into = (next[newDst] ??= {});
          for (const [c, n] of Object.entries(srcCounters)) {
            into[c] = Math.max(nextNumber(into, c), n);
          }
        }
      }
      if (!isEmptyTable(table)) {
        // Definers are walked again only so the resolver learns their instances and setups.
        const walk = definers.length > 0 ? emptyRemapReport() : report;
        const out = remapIds([...definers, oldCommand], table, {
          document: this.confirmed,
          report: walk,
        });
        e.command = out[out.length - 1]!;
        e.created = remapCreatedIds(oldCreated, table);
        if (
          out[out.length - 1] !== oldCommand &&
          JSON.stringify(e.command) !== JSON.stringify(oldCommand)
        ) {
          renamed = true;
          if (walk !== report) {
            const own = emptyRemapReport();
            remapIds([oldCommand], table, { report: own });
            report.renamed += own.renamed;
            report.orderFlips += own.orderFlips;
          }
        }
      }
      if (defines(oldCommand)) definers.push(oldCommand);
      if (hidden.has(e) || blocked) {
        hidden.add(e);
        blocked = true;
        continue;
      }
      if (e.restore !== undefined) {
        // A restore is rebased as its intent: the version, on the current head (item 11).
        e.command = {
          type: 'replaceDocument',
          document: restoredDocument(doc, e.restore.document, maxCounters(this.highWater, next)),
        };
      }
      // An unsent entry too large to send is dropped as the server would refuse it.
      const tooLarge = e.wire === undefined ? this.oversized(e) : undefined;
      if (tooLarge !== undefined) {
        this.drop(e, tooLarge, table, oldCreated, drops);
        continue;
      }
      const r = applyCommand(doc, e.command);
      if (!r.ok) {
        this.drop(e, asRefusal(r.error), table, oldCreated, drops);
        continue;
      }
      doc = r.value.document;
      e.inverse = r.value.inverse;
      for (const [scope, counters] of Object.entries(documentCounters(doc))) {
        const into = (next[scope] ??= {});
        for (const [c, n] of Object.entries(counters)) into[c] = Math.max(nextNumber(into, c), n);
      }
    }

    // Entry states.
    for (const e of this.queue) e.state = this.stateOf(e, hidden, doomed);
    this.visible = reserve(
      doc,
      this.queue.filter((e) => hidden.has(e)),
    );

    // The undo and redo stacks follow the renames (decision 8).
    if (!isEmptyTable(table)) {
      for (const u of this.undoStack) {
        if (u.confirmed && u.inverse !== undefined) {
          u.inverse = remapIds([u.inverse], table, { document: this.confirmed })[0]!;
        }
        u.touched = renameObjectKeys(u.touched, table);
      }
      for (const r of this.redoStack) {
        r.command = remapIds([r.command], table, { document: this.confirmed })[0]!;
      }
    }
    this.pruneRefusals();
    if (renamed) {
      this.stats.remaps++;
      this.emit('remapped', { table, report });
    }
    if (drops.length > 0) this.emit('dropped', { drops, before });
    this.sendUnsent();
  }

  /**
   * Gives `created`'s ids the next free numbers of their counters in `next` (in counter and number
   * order), adding a rename to `table` for each that moves. Ids in a scope the queue itself created
   * (a new part, assembly or drawing) keep their numbers: nobody else allocates there. A duplicated
   * part is not such a scope: its ids are the source's.
   */
  private allocate(
    created: CreatedIds,
    table: MutableTable,
    next: MutableCounters,
    confirmed: CounterTable,
    aliases: ReadonlySet<ScopeKey>,
  ): void {
    const scopes = Object.keys(created).sort((a, b) =>
      a === DOCUMENT_SCOPE ? -1 : b === DOCUMENT_SCOPE ? 1 : a < b ? -1 : a > b ? 1 : 0,
    );
    for (const scope of scopes) {
      const current = remapScopeKey(scope, table);
      if (!Object.hasOwn(confirmed, current) && !aliases.has(current)) continue;
      const counters = next[current];
      if (counters === undefined) continue;
      for (const id of created[scope]!) {
        const c = idCounter(id);
        if (c === undefined) continue;
        const n = nextNumber(counters, c.counter);
        counters[c.counter] = n + 1;
        if (n !== c.n) setRename(table, scope, id, idText(c.counter, n));
      }
    }
  }

  private stateOf(e: QueueEntry, hidden: Set<QueueEntry>, doomed: Set<number>): EntryState {
    const w = e.wire;
    if (w === undefined) return hidden.has(e) ? 'held' : 'unsent';
    if (e.verdict?.code === 'id-reused') return 'id-reused';
    if (e.predecessorRefused) return 'predecessor-refused';
    if (doomed.has(w.clientSeq)) return 'doomed';
    return hidden.has(e) ? 'held' : 'in-flight';
  }

  /** Keeps only the refusals that in-flight entries still name. */
  private pruneRefusals(): void {
    const named = new Set<number>();
    for (const e of this.queue) {
      if (e.wire === undefined) continue;
      named.add(e.wire.clientSeq);
      if (e.wire.prevSeq !== undefined) named.add(e.wire.prevSeq);
    }
    for (const seq of [...this.refusals.keys()]) if (!named.has(seq)) this.refusals.delete(seq);
  }

  /** Sends unsent entries in queue order up to the first held one (decision 2's `prevSeq`). */
  private sendUnsent(): void {
    if (!this.online) return;
    let prev = this.latestAccepted;
    for (const e of this.queue) {
      if (HIDDEN_STATES.has(e.state)) break;
      if (e.wire !== undefined) {
        prev = e.wire.clientSeq;
        continue;
      }
      e.wire = {
        clientSeq: this.nextSeq++,
        ...(prev !== undefined && { prevSeq: prev }),
        baseRev: this.confirmedRev,
        format: FORMAT_VERSION,
        command: e.command,
        created: e.created,
        transmitted: false,
        resend: false,
      };
      e.state = 'in-flight';
      prev = e.wire.clientSeq;
    }
  }

  /**
   * The shown document and the inverses, replayed from the saved states without renaming (after
   * `restore` and an undo that removed an unsent entry).
   */
  private recomputeView(): void {
    let doc = this.confirmed;
    const hidden: QueueEntry[] = [];
    for (const e of this.queue) {
      if (HIDDEN_STATES.has(e.state)) {
        hidden.push(e);
        continue;
      }
      const r = applyCommand(doc, e.wire?.command ?? e.command);
      if (!r.ok) throw new Error(`A shown entry does not apply: ${r.error.message}`);
      doc = r.value.document;
      e.inverse = r.value.inverse;
    }
    this.visible = reserve(doc, hidden);
  }
}
