// A headless document session (ADR 0016 decision 1; M8 plan "The headless session model"): one
// agent on one agent branch of one document, in this process. See README.md.
//
// Every write is one batch: core applies it (all or nothing), regen rebuilds what changed under
// the regen limit, and the library saves it as one revision of the branch with one log entry and
// the agent's label. A batch core refuses, or whose regen runs over, leaves the branch as it was.
// The session never writes Main: its branch is made by `branchFromRevision` with agent provenance,
// a resumed branch must carry agent provenance, and every save checks the branch again.

import { randomUUID } from 'node:crypto';
import {
  applyCommand,
  createdIds,
  diffDocuments,
  serialize,
  type Command,
  type CreatedIds,
  type ManufaktureDocument,
} from '@manufakture/core';
import {
  BranchDeleted,
  MAIN_BRANCH,
  RevisionConflict,
  isBranchId,
  isStorableId,
  type Branch,
  type BranchLock,
  type BranchLocks,
  type DocumentLibrary,
  type LogEntry,
  type ReviewState,
  type Version,
} from '@manufakture/library';
import type { ExtensionRegistry, FeatureStatus, RegenResult } from '@manufakture/regen';
import {
  MAX_BUNDLE_BYTES,
  MAX_NOTE,
  type BundleBuilder,
  type BundleStore,
  type StoredBundle,
} from './bundles';
import { EngineLost, KernelTimeout, ScriptStopped, type Engine, type EngineApi } from './engine';
import { coreRefusal, done, sessionError, type Refusal, type SessionResult } from './errors';
import { References } from './imports';
import type { SessionLimits } from './limits';
import { ModelState } from './model';
import {
  errorsOf,
  findGeometry,
  measure,
  objectOf,
  quantities,
  tree,
  type ErrorLine,
  type GeometryHit,
  type QueryContext,
  type Quantities,
} from './queries';
import { nodeExtensions } from './node-host';
import { replayOnto } from './rebase';
import { schemaIndex, schemaOf } from './schema';
import { batchProblem, resolveSymbols } from './symbols';
import { RemoteRefusal } from './sync';

/** The domains the session's engine registers, built on first use. */
let sessionExtensions: Pick<ExtensionRegistry, 'lookup'> | undefined;

/** What a session needs from its host (`SessionManager` provides it). */
export interface SessionHost {
  library: DocumentLibrary;
  locks: BranchLocks;
  limits: SessionLimits;
  /** Starts the session's own engine (one kernel service per session, never shared). */
  engine: () => Promise<Engine>;
  /**
   * The extension types a batch may use, for the params fields that hold ids (symbolic ids are
   * resolved there too). Default: the domains the session's engine registers (`nodeExtensions`).
   */
  extensions?: Pick<ExtensionRegistry, 'lookup'>;
  bundles?: BundleStore;
  now?: () => Date;
  /** Told when the session closes (the manager's bookkeeping). */
  onClose?: (session: Session) => void;
  /** Whether a session with this id is open in this process (a resume of it is refused). */
  isOpen?: (sessionId: string) => boolean;
  /**
   * The server-side log: the full error behind a refusal whose message to the agent is generic
   * (file system errors name absolute paths; a worker's error text is not the agent's business).
   */
  log?: (event: SessionLogEvent) => void;
}

/** One error the agent was told about only in general terms. */
export interface SessionLogEvent {
  sessionId: string;
  documentId: string;
  /** What the session was doing. */
  context: string;
  error: unknown;
}

export interface OpenOptions {
  documentId: string;
  /** What the agent's client calls itself: shown with the branch, never trusted. */
  clientName: string;
  /** Default: a new UUID. */
  sessionId?: string;
}

export interface ResumeOptions {
  documentId: string;
  /** An agent branch in review state `open` or `changes-requested`. */
  branch: string;
}

export interface ApplyInput {
  /** The batch's label in the history: 1 to `MAX_LABEL` characters. */
  label: string;
  /** The commands, in order: one batch. Ids may be symbolic (`extrude#$boss`). */
  commands: unknown[];
  /** Apply and regenerate, then put everything back: nothing is saved. */
  dryRun?: boolean;
}

export interface StatusChange {
  partId: string;
  featureId: string;
  before: FeatureStatus | null;
  after: FeatureStatus | null;
}

/** A body whose shape changed in the batch. */
export interface BodySummary {
  partId: string;
  bodyId: string;
  volume: number;
  area: number;
  boundingBox: { min: number[]; max: number[] } | null;
}

export interface BatchReport {
  label: string;
  dryRun: boolean;
  /** The branch revision after the batch (unchanged for a dry run). */
  revision: number;
  /** Each symbolic id and the real id it got. */
  symbols: Record<string, string>;
  /** The ids the batch made, by counter scope. */
  created: CreatedIds;
  statusChanges: StatusChange[];
  /** Every regen error and warning of the result, errors first (at most `MAX_REPORTED`). */
  errors: ErrorLine[];
  /** Bodies whose shape changed (at most `MAX_REPORTED`). */
  measured: BodySummary[];
  regenMs: number;
  review: ReviewState;
}

export interface UpdateReport {
  /** False when Main has not moved since the branch was made: nothing was done. */
  changed: boolean;
  /** The branch the session works on now (a new one when `changed`). */
  branch: string;
  previousBranch: string;
  baseVersion: string;
  revision: number;
  /** The branch's batches that apply on Main's head, in order, by label. */
  applied: string[];
  /** Those that do not, with why: left out of the new branch. */
  dropped: { label: string; message: string }[];
  /** Ids the batches made that Main had taken meanwhile, and their new ids. */
  renamed: { from: string; to: string }[];
  /**
   * What the batches overwrote of Main's changes since the branch was made: each object (a
   * feature, a variable, the domains, ...) with the fields Main's value is lost in (both changed
   * them; the branch's wins), or `fields` empty for the whole object. Edits of a feature or of
   * domain data are merged field by field, so only fields both sides changed are here.
   */
  overwritten: { name: string; fields: string[] }[];
  /** Batches replayed whole where a field merge was possible, each with why. */
  mergedWhole: { label: string; reasons: string[] }[];
}

export interface SessionInfo {
  sessionId: string;
  documentId: string;
  branch: string;
  branchName: string;
  baseVersion: string;
  revision: number;
  review: ReviewState;
  batches: number;
  closed: boolean;
  engine: Engine['kind'];
  /** How many times this session's kernel was replaced (worker restarts, in-place recycles). */
  kernelReplaced: number;
  /** The newest stored bundle, and whether the branch moved past it. */
  bundle: { revision: number; stale: boolean } | null;
}

export interface HistoryItem {
  revision: number;
  cause: LogEntry['cause'];
  label: string;
  at: string;
}

/** The longest batch label. */
export const MAX_LABEL = 200;
/** Most errors and measured bodies a batch report lists. */
export const MAX_REPORTED = 100;

/** Commands in `command`, counting those inside batches (not the batches). */
export function commandCount(command: Command): number {
  return command.type === 'batch' ? command.commands.reduce((n, c) => n + commandCount(c), 0) : 1;
}

/**
 * How many times one regen goes on after the script hard limit ended its worker. Each stop costs
 * that limit (10 s) of the regen's own time limit, which bounds it anyway.
 */
const MAX_SCRIPT_STOPS = 3;

const CONTROL = /[\p{Cc}\p{Cf}]/u;
/** A note may break lines. */
const NOTE_CONTROL = /[^\P{Cc}\n\t]|\p{Cf}/u;

function labelProblem(label: unknown): string | null {
  if (typeof label !== 'string') return 'A label is a string.';
  const t = label.trim();
  if (t.length === 0 || t.length > MAX_LABEL) return `A label is 1 to ${MAX_LABEL} characters.`;
  if (CONTROL.test(t) || !(t as unknown as { isWellFormed(): boolean }).isWellFormed()) {
    return 'A label holds no control or format characters.';
  }
  return null;
}

/** `call`'s value or error, or `'timeout'` when it takes longer than `ms`. */
async function within<T>(
  call: Promise<T>,
  ms: number,
): Promise<{ value: T } | { error: unknown } | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ms);
  });
  try {
    return await Promise.race([
      call.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      ),
      late,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** An error of the session's own, whose message is meant for the agent. */
class Refused extends Error {}

interface Undoable {
  revision: number;
  label: string;
  command: Command;
  /** Known when the batch ran in this session; read from the library otherwise. */
  inverse?: Command;
  /** Commands of the same revision before this one (a revision of several entries). */
  prior: Command[];
}

type RegenOutcome =
  | { ok: true; result: RegenResult; ms: number }
  | { ok: false; reason: 'timeout' | 'kernel'; message: string };

export class Session {
  readonly id: string;
  readonly documentId: string;
  readonly #host: SessionHost;
  #branch: Branch;
  #base: Version;
  #revision: number;
  #document: ManufaktureDocument;
  #lock: BranchLock;
  #engine: Engine;
  readonly #model = new ModelState();
  readonly #references = new References();
  #generation = 0;
  #batches = 0;
  #stack: Undoable[];
  #closed = false;
  /** `close` was asked: new calls answer `closed`; the call in flight gets `regenStopMs`. */
  #closing = false;
  #queue: Promise<unknown> = Promise.resolve();
  #idle: ReturnType<typeof setTimeout> | null = null;
  /** Kernels replaced by this session (restarts and kills). */
  #replacements = 0;
  /** A library save in flight: a forced close waits for it before releasing the lock. */
  #saving: Promise<unknown> | null = null;
  /** The engine's API with every call under `kernelMsPerCall`. */
  readonly #kernel: EngineApi;

  private constructor(fields: {
    id: string;
    documentId: string;
    host: SessionHost;
    branch: Branch;
    base: Version;
    revision: number;
    document: ManufaktureDocument;
    lock: BranchLock;
    engine: Engine;
    stack: Undoable[];
  }) {
    this.id = fields.id;
    this.documentId = fields.documentId;
    this.#host = fields.host;
    this.#branch = fields.branch;
    this.#base = fields.base;
    this.#revision = fields.revision;
    this.#document = fields.document;
    this.#lock = fields.lock;
    this.#engine = fields.engine;
    this.#stack = fields.stack;
    const api = () => this.#engine.api;
    this.#kernel = {
      regen: (document, options) => this.#deadline(() => api().regen(document, options)),
      run: ((request) => this.#deadline(() => api().run(request))) as EngineApi['run'],
      release: (shapes) => this.#deadline(() => api().release(shapes)),
      cancel: (generation) => this.#deadline(() => api().cancel(generation)),
      stats: () => this.#deadline(() => api().stats()),
      interference: (assemblyId, options) =>
        this.#deadline(() => api().interference(assemblyId, options)),
      orientedSizes: (document, partId, options) =>
        this.#deadline(() => api().orientedSizes(document, partId, options)),
    };
  }

  // -------------------------------------------------------------------------------------------
  // Open, resume, close

  /**
   * A new session: Main's head is recorded as a version ("Agent session <id> start"), an agent
   * branch is made from it, locked, loaded and fully regenerated.
   */
  static async open(host: SessionHost, options: OpenOptions): Promise<SessionResult<Session>> {
    const { documentId, clientName } = options;
    if (typeof documentId !== 'string' || !isStorableId(documentId)) {
      return sessionError('not-found', 'There is no such document.');
    }
    if (typeof clientName !== 'string') {
      return sessionError('invalid-input', 'A client name is a string.');
    }
    const id = options.sessionId ?? randomUUID();
    if (!isStorableId(id)) return sessionError('invalid-input', 'A session id is a storable id.');
    if (host.isOpen?.(id)) return sessionError('locked', 'A session with that id is open.');
    const made = await host.library.branchFromRevision(documentId, {
      version: { name: `Agent session ${id} start` },
      name: `Agent session ${id}`,
      provenance: { origin: 'agent', sessionId: id, clientName, review: 'open' },
    });
    if (!made.ok) {
      const missing = made.noBranch || /There is no document/.test(made.message);
      return sessionError(missing ? 'not-found' : 'invalid-input', made.message);
    }
    // A session that does not start leaves no branch behind (its start version stays: versions
    // only name a revision of Main).
    const discard = async () => {
      const deleted = await host.library.deleteBranch(documentId, made.value.branch.id);
      if (!deleted.ok) {
        host.log?.({
          sessionId: id,
          documentId,
          context: 'deleting the branch of a session that did not start',
          error: new Error(deleted.message),
        });
      }
    };
    let lock: BranchLock | null;
    try {
      lock = await host.locks.acquire(documentId, made.value.branch.id, id);
    } catch (e) {
      host.log?.({ sessionId: id, documentId, context: 'taking the branch lock', error: e });
      lock = null;
    }
    if (lock === null) {
      await discard();
      return sessionError('locked', 'The new branch could not be locked.');
    }
    return Session.#start(host, {
      id,
      documentId,
      branch: made.value.branch,
      base: made.value.version,
      lock,
      stack: [],
      discard,
    });
  }

  /** Reopen an agent branch in review state `open` or `changes-requested`. */
  static async resume(host: SessionHost, options: ResumeOptions): Promise<SessionResult<Session>> {
    const { documentId, branch } = options;
    if (typeof documentId !== 'string' || !isStorableId(documentId)) {
      return sessionError('not-found', 'There is no such document.');
    }
    if (branch === MAIN_BRANCH) {
      return sessionError(
        'main-refused',
        'An agent never works on Main: open a new session instead.',
      );
    }
    if (typeof branch !== 'string' || !isBranchId(branch)) {
      return sessionError('not-found', 'There is no such branch.');
    }
    const listed = await host.library.listBranches(documentId);
    if (!listed.ok) return sessionError('not-found', listed.message);
    const record = listed.value.find((b) => b.id === branch);
    if (record === undefined) return sessionError('not-found', 'There is no such branch.');
    const problem = resumable(record);
    if (problem !== null) return sessionError('branch-state', problem);
    const versions = await host.library.listVersions(documentId);
    if (!versions.ok) return sessionError('storage', versions.message);
    const base = versions.value.find((v) => v.id === record.fromVersion);
    if (base === undefined) {
      return sessionError('storage', 'The version the branch was made from is gone.');
    }
    const id = record.provenance!.sessionId;
    if (host.isOpen?.(id)) return sessionError('locked', 'The session of this branch is open.');
    const lock = await host.locks.acquire(documentId, branch, id);
    if (lock === null) return sessionError('locked', 'Another session holds this branch.');
    const stack = await undoStack(host.library, documentId, branch);
    if (!stack.ok) {
      await lock.release();
      return stack;
    }
    return Session.#start(host, { id, documentId, branch: record, base, lock, stack: stack.value });
  }

  static async #start(
    host: SessionHost,
    fields: {
      id: string;
      documentId: string;
      branch: Branch;
      base: Version;
      lock: BranchLock;
      stack: Undoable[];
      /** Undo what `open` made (its branch) when the session does not start. */
      discard?: () => Promise<void>;
    },
  ): Promise<SessionResult<Session>> {
    const { discard, ...rest } = fields;
    const fail = async () => {
      await discard?.().catch(() => undefined);
      await fields.lock.release().catch(() => undefined);
    };
    const opened = await host.library.open(fields.documentId, fields.branch.id);
    if (!opened.ok) {
      await fail();
      return sessionError('storage', opened.message);
    }
    let engine: Engine;
    try {
      engine = await host.engine();
    } catch (e) {
      host.log?.({
        sessionId: fields.id,
        documentId: fields.documentId,
        context: 'starting the engine',
        error: e,
      });
      await fail();
      return sessionError('kernel', 'The geometry kernel did not start.');
    }
    // The branch's own scripts are those not in its base version as they are there (ADR 0016
    // decision 2): only they run.
    const base = await host.library.readVersion(fields.documentId, fields.base.id);
    if (!base.ok) {
      await engine.close().catch(() => undefined);
      await fail();
      return sessionError('storage', base.message);
    }
    engine.scriptBase = base.value.document;
    const session = new Session({
      ...rest,
      host,
      revision: opened.value.revision,
      document: opened.value.document,
      engine,
    });
    const first = await session.#settle(session.#document);
    if (!first.ok) {
      await session.#engine.close().catch(() => undefined);
      session.#closed = true;
      await fail();
      return sessionError(
        first.reason === 'timeout' ? 'regen-timeout' : 'kernel',
        `The document could not be regenerated: ${first.message}`,
        first.reason === 'timeout' ? host.limits.regenMsPerBatch : undefined,
      );
    }
    await session.#syncReferences();
    session.#touch();
    return done(session);
  }

  /**
   * Release the kernel, the solver and the branch lock. The branch and its bundles stay. A call
   * in flight gets `regenStopMs` to finish; then the session is ended anyway (its worker is
   * terminated, which ends a kernel call that hangs), so a stuck call never holds the session's
   * slot. Calls made from now on answer `closed`.
   */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closing = true;
    if (this.#idle !== null) clearTimeout(this.#idle);
    await within(this.#queue, this.#host.limits.regenStopMs);
    await this.#shutdown();
  }

  get closed(): boolean {
    return this.#closed;
  }

  get branch(): string {
    return this.#branch.id;
  }

  get document(): ManufaktureDocument {
    return this.#document;
  }

  async #shutdown(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#closing = true;
    if (this.#idle !== null) clearTimeout(this.#idle);
    await this.#engine.close().catch(() => undefined);
    // A save already in the library finishes before the lock goes (no new one starts: closed).
    if (this.#saving !== null) await within(this.#saving, this.#host.limits.regenStopMs);
    await this.#lock.release().catch(() => undefined);
    this.#host.onClose?.(this);
  }

  /** Closed, or closing: calls answer `closed`. */
  #ended(): boolean {
    return this.#closed || this.#closing;
  }

  /**
   * Calls run one at a time, in order; each resets the idle timer. Once the session is closing,
   * a call is not queued behind the one in flight: it answers `closed` at once.
   */
  #serial<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#ended()) return Promise.resolve().then(fn);
    const run = this.#queue.then(fn, fn);
    this.#queue = run.catch(() => undefined);
    this.#touch();
    return run;
  }

  #touch(): void {
    if (this.#ended()) return;
    if (this.#idle !== null) clearTimeout(this.#idle);
    const ms = this.#host.limits.idleMs;
    if (ms > 0) {
      this.#idle = setTimeout(() => void this.close(), ms);
      this.#idle.unref();
    }
  }

  #closedError(): { ok: false; error: Refusal } {
    return sessionError('closed', 'The session is closed.');
  }

  // -------------------------------------------------------------------------------------------
  // Regen

  /**
   * Any kernel call but a regen, under `kernelMsPerCall`: past it the kernel is ended (a worker
   * engine terminates and starts again; an in-process one can only leave the call running) and
   * the call throws `KernelTimeout`.
   */
  async #deadline<T>(call: () => Promise<T>): Promise<T> {
    const ms = this.#host.limits.kernelMsPerCall;
    const r = await within((async () => call())(), ms);
    if (r === 'timeout') {
      await this.#replaceEngine('kill').catch(() => undefined);
      throw new KernelTimeout(ms);
    }
    if ('error' in r) throw r.error;
    return r.value;
  }

  /**
   * Regen `document` under the time limit. A regen that does not stop is ended (worker). A script
   * run that passed its hard limit ended the worker (`ScriptStopped`): on a new one, which fails
   * that run with a timeout, the regen is tried again within what is left of the time limit.
   */
  async #regen(document: ManufaktureDocument): Promise<RegenOutcome> {
    const t0 = performance.now();
    const limit = this.#host.limits.regenMsPerBatch;
    for (let stops = 0; ; stops++) {
      const outcome = await this.#regenOnce(
        document,
        Math.max(1, limit - (performance.now() - t0)),
      );
      if (outcome !== 'script-stopped') {
        return outcome.ok ? { ...outcome, ms: performance.now() - t0 } : outcome;
      }
      if (stops >= MAX_SCRIPT_STOPS || performance.now() - t0 >= limit) {
        return {
          ok: false,
          reason: 'timeout',
          message: `the regen took longer than ${limit} ms (scripts ran past their time limit)`,
        };
      }
    }
  }

  async #regenOnce(
    document: ManufaktureDocument,
    ms: number,
  ): Promise<RegenOutcome | 'script-stopped'> {
    const generation = ++this.#generation;
    const engine = this.#engine;
    const t0 = performance.now();
    const call = engine.api.regen(document, { generation });
    const first = await within(call, ms);
    if (first === 'timeout') {
      // Not awaited: a worker stuck in one operation never reads the cancel.
      engine.api.cancel(generation).catch(() => undefined);
      const stopped = await within(call, this.#host.limits.regenStopMs);
      if (stopped === 'timeout') await this.#replaceEngine('kill').catch(() => undefined);
      else this.#model.reset();
      return {
        ok: false,
        reason: 'timeout',
        message: `the regen took longer than ${this.#host.limits.regenMsPerBatch} ms`,
      };
    }
    if ('error' in first) {
      const restarted = await this.#replaceEngine('restart').then(
        () => true,
        () => false,
      );
      if (first.error instanceof ScriptStopped && restarted) return 'script-stopped';
      return { ok: false, reason: 'kernel', message: this.#public(first.error, 'regen') };
    }
    if (first.value === null) {
      return { ok: false, reason: 'kernel', message: 'the regen was superseded' };
    }
    this.#model.update(first.value);
    return { ok: true, result: first.value, ms: performance.now() - t0 };
  }

  /**
   * Regen `document` and make sure its shapes are live: a worker engine whose heap passed the
   * threshold is replaced first (and regenerated), and an in-process kernel that recycled right
   * after the regen (T8.0a) is regenerated once more.
   */
  async #settle(document: ManufaktureDocument): Promise<RegenOutcome> {
    let last: RegenOutcome | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      let before: number;
      try {
        before = (await this.#kernel.stats()).instance;
      } catch (e) {
        if (!(e instanceof KernelTimeout)) {
          await this.#replaceEngine('restart').catch(() => undefined);
        }
        last = { ok: false, reason: 'kernel', message: this.#public(e, 'kernel stats') };
        continue;
      }
      const outcome = await this.#regen(document);
      if (!outcome.ok) return outcome;
      last = outcome;
      try {
        if (await this.#deadline(() => this.#engine.wantsRestart())) {
          await this.#replaceEngine('restart');
          continue;
        }
        const now = (await this.#kernel.run({ generation: this.#generation, ops: [] })).instance;
        if (now !== before) continue;
      } catch (e) {
        if (!(e instanceof KernelTimeout)) {
          await this.#replaceEngine('restart').catch(() => undefined);
        }
        last = { ok: false, reason: 'kernel', message: this.#public(e, 'kernel check') };
        continue;
      }
      return outcome;
    }
    return last ?? { ok: false, reason: 'kernel', message: 'the kernel kept recycling' };
  }

  async #replaceEngine(how: 'restart' | 'kill'): Promise<void> {
    if (how === 'kill') {
      if (!(await this.#engine.kill())) return;
    } else {
      await this.#engine.restart();
    }
    // A new kernel: every shape and cached body is gone, and its next regen sends everything.
    this.#replacements++;
    this.#model.reset();
    this.#references.forget();
  }

  /**
   * Read the reference bodies again (imports.ts). A read that runs over `kernelMsPerCall` ended
   * the kernel: the document is regenerated, and that body keeps its error (it is not read again
   * until its file changes).
   */
  async #syncReferences(): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await this.#references.sync(this.#document, this.#kernel, this.#generation);
        return;
      } catch (e) {
        if (e instanceof KernelTimeout) {
          if (this.#ended() || !(await this.#settle(this.#document)).ok) return;
          continue;
        }
        if (!(e instanceof EngineLost)) this.#logError('reading reference imports', e);
        return;
      }
    }
  }

  /** Tell the host's log about `error`; return what the agent may read of it. */
  #public(error: unknown, context: string): string {
    // A sync server's refusal is fixed text with its code (sync.ts): the agent reads it as is.
    if (
      error instanceof Refused ||
      error instanceof KernelTimeout ||
      error instanceof RemoteRefusal
    )
      return error.message;
    if (error instanceof BranchDeleted) return 'The branch is gone.';
    if (error instanceof RevisionConflict) return 'The branch was saved elsewhere meanwhile.';
    this.#logError(context, error);
    return generic(error, context);
  }

  #logError(context: string, error: unknown): void {
    try {
      this.#host.log?.({ sessionId: this.id, documentId: this.documentId, context, error });
    } catch {
      // A log that throws changes nothing here.
    }
  }

  // -------------------------------------------------------------------------------------------
  // Writes

  /** Whether the branch may be written now: the lock is held and its review state allows it. */
  async #writable(): Promise<SessionResult<Branch>> {
    if (this.#branch.id === MAIN_BRANCH) {
      return sessionError('main-refused', 'An agent never writes Main.');
    }
    if (!(await this.#lock.held())) {
      await this.#shutdown();
      return sessionError('lock-lost', 'The branch lock was taken by another process.');
    }
    const listed = await this.#host.library.listBranches(this.documentId);
    if (!listed.ok) return sessionError('storage', listed.message);
    const record = listed.value.find((b) => b.id === this.#branch.id);
    if (record === undefined) return sessionError('not-found', 'The branch is gone.');
    if (record.provenance?.origin !== 'agent') {
      return sessionError('branch-state', 'The branch is not an agent branch.');
    }
    const review = record.provenance.review;
    if (review === 'approved' || review === 'rejected') {
      return sessionError('branch-state', `The branch was ${review}: it takes no more work.`);
    }
    this.#branch = record;
    return done(record);
  }

  /**
   * Save one batch on the branch, its state checked again right before (the regen before it may
   * take `regenMsPerBatch`): a reviewer's decision made meanwhile is never overwritten. A branch
   * that was submitted or had changes requested returns to `open` first, by a compare-and-set on
   * the state just read; when the save then fails, it is set back the same way.
   */
  async #saveChecked(
    document: ManufaktureDocument,
    entry: LogEntry,
  ): Promise<SessionResult<number>> {
    const writable = await this.#writable();
    if (!writable.ok) return writable;
    const lib = this.#host.library;
    const seen = writable.value.provenance!.review;
    if (seen !== 'open') {
      const set = await lib.setBranchReview(this.documentId, this.#branch.id, 'open', {
        expected: seen,
      });
      if (!set.ok) {
        return set.reviewChanged
          ? sessionError(
              'branch-state',
              'The review state of the branch changed meanwhile: the batch was not saved.',
            )
          : sessionError('storage', set.message);
      }
      this.#branch = set.value;
    }
    try {
      return done((await this.#saveTo(this.#branch.id, document, entry)).revision);
    } catch (e) {
      if (seen !== 'open') {
        const back = await lib.setBranchReview(this.documentId, this.#branch.id, seen, {
          expected: 'open',
        });
        if (back.ok) this.#branch = back.value;
      }
      return sessionError('storage', `The batch was not saved: ${this.#public(e, 'saving')}`);
    }
  }

  /**
   * Apply one batch with its label (ADR 0016 decision 1). Ids may be symbolic: the report gives
   * the real ones. Errors are data: core's refusal, or a limit's.
   */
  apply(input: ApplyInput): Promise<SessionResult<BatchReport>> {
    return this.#serial(async () => {
      if (this.#ended()) return this.#closedError();
      const { label, commands } = (input ?? {}) as Partial<ApplyInput>;
      const dryRun = input?.dryRun === true;
      const problem = labelProblem(label);
      if (problem !== null) return sessionError('invalid-label', problem);
      if (!Array.isArray(commands) || commands.length === 0) {
        return sessionError('invalid-input', 'A batch is a non-empty list of commands.');
      }
      const limits = this.#host.limits;
      if (commands.length > limits.commandsPerBatch) {
        return sessionError(
          'too-many-commands',
          `A batch holds at most ${limits.commandsPerBatch} commands; this one has ${commands.length}.`,
          limits.commandsPerBatch,
        );
      }
      if (this.#batches >= limits.batchesPerSession) {
        return sessionError(
          'too-many-batches',
          `A session takes at most ${limits.batchesPerSession} batches: close it and open a new one.`,
          limits.batchesPerSession,
        );
      }
      // Nested commands counted, and depth capped, before anything parses the batch.
      const shape = batchProblem(commands, limits.commandsPerBatch);
      if (shape !== null) return sessionError(shape.code, shape.message, shape.limit);
      const extensions = this.#host.extensions ?? (sessionExtensions ??= nodeExtensions());
      const resolved = resolveSymbols(
        this.#document,
        { type: 'batch', commands },
        { idFields: (type) => extensions.lookup(type)?.definition.idFields },
      );
      if (!resolved.ok) {
        const p = resolved.problem;
        if (p.kind === 'core') return coreRefusal(p.error);
        return p.kind === 'too-deep'
          ? sessionError('too-deep', p.message, p.limit)
          : sessionError('symbol', p.message);
      }
      const { command, table } = resolved.value;
      const count = commandCount(command);
      if (count > limits.commandsPerBatch) {
        return sessionError(
          'too-many-commands',
          `A batch holds at most ${limits.commandsPerBatch} commands; this one has ${count}.`,
          limits.commandsPerBatch,
        );
      }
      return this.#write(command, label!.trim(), 'execute', dryRun, table);
    });
  }

  /** Undo the branch's last batch, as a new revision with the batch's inverse. */
  undo(): Promise<SessionResult<BatchReport>> {
    return this.#serial(async () => {
      if (this.#ended()) return this.#closedError();
      const top = this.#stack.at(-1);
      if (top === undefined) return sessionError('nothing-to-undo', 'There is no batch to undo.');
      if (this.#batches >= this.#host.limits.batchesPerSession) {
        return sessionError(
          'too-many-batches',
          `A session takes at most ${this.#host.limits.batchesPerSession} batches.`,
          this.#host.limits.batchesPerSession,
        );
      }
      const inverse = top.inverse !== undefined ? done(top.inverse) : await this.#inverseOf(top);
      if (!inverse.ok) return inverse;
      top.inverse = inverse.value;
      return this.#write(inverse.value, top.label, 'undo', false, {});
    });
  }

  async #inverseOf(entry: Undoable): Promise<SessionResult<Command>> {
    const read = await this.#host.library.readRevision(this.documentId, entry.revision - 1, {
      branch: this.#branch.id,
    });
    if (!read.ok) return sessionError('storage', `The batch cannot be undone: ${read.message}`);
    let doc = read.value.document;
    for (const c of entry.prior) {
      const r = applyCommand(doc, c);
      if (!r.ok) return coreRefusal(r.error);
      doc = r.value.document;
    }
    const r = applyCommand(doc, entry.command);
    return r.ok ? done(r.value.inverse) : coreRefusal(r.error);
  }

  async #write(
    command: Command,
    label: string,
    cause: 'execute' | 'undo',
    dryRun: boolean,
    symbols: Record<string, string>,
  ): Promise<SessionResult<BatchReport>> {
    const limits = this.#host.limits;
    const before = this.#document;
    const beforeResult = this.#model.last;
    const applied = applyCommand(before, command);
    if (!applied.ok) return coreRefusal(applied.error);
    const after = applied.value.document;
    if (diffDocuments(before, after).empty) {
      return sessionError('no-change', 'The batch changes nothing.');
    }
    const bytes = Buffer.byteLength(serialize(after), 'utf8');
    if (bytes > limits.documentBytes) {
      return sessionError(
        'document-too-large',
        `The document would be ${bytes} bytes; a document is at most ${limits.documentBytes}.`,
        limits.documentBytes,
      );
    }
    if (!dryRun) {
      const writable = await this.#writable();
      if (!writable.ok) return writable;
    }
    const created = createdIds(before, command);
    this.#batches++;
    const regen = await this.#settle(after);
    if (!regen.ok) {
      await this.#restore(before);
      return regen.reason === 'timeout'
        ? sessionError(
            'regen-timeout',
            `The regen took longer than ${limits.regenMsPerBatch} ms: the batch was rolled back.`,
            limits.regenMsPerBatch,
          )
        : sessionError('kernel', `The batch was rolled back: ${regen.message}`);
    }
    const replaced = this.#replacements;
    const measured = await this.#measureChanged(beforeResult, regen.result);
    // A measurement that ran over its time ended the kernel: build the result again first.
    if (this.#replacements !== replaced && !dryRun) {
      const again = await this.#settle(after);
      if (!again.ok) {
        await this.#restore(before);
        return sessionError('kernel', `The batch was rolled back: ${again.message}`);
      }
    }
    const report = (revision: number): BatchReport => ({
      label,
      dryRun,
      revision,
      symbols,
      created: created.ok ? created.value : {},
      statusChanges: statusChanges(beforeResult, regen.result),
      errors: errorsOf(regen.result, this.#references).slice(0, MAX_REPORTED),
      measured,
      regenMs: Math.round(regen.ms),
      review: this.#branch.provenance?.review ?? 'open',
    });
    if (dryRun) {
      await this.#restore(before);
      return done(report(this.#revision));
    }
    const committed = await this.#saveChecked(after, {
      cause,
      label,
      command,
      at: this.#now().toISOString(),
    });
    if (!committed.ok) {
      if (!this.#closed) await this.#restore(before);
      return committed;
    }
    const saved = committed.value;
    this.#document = after;
    this.#revision = saved;
    if (cause === 'undo') this.#stack.pop();
    else
      this.#stack.push({
        revision: saved,
        label,
        command,
        inverse: applied.value.inverse,
        prior: [],
      });
    await this.#syncReferences();
    return done(report(saved));
  }

  /**
   * The only way this session saves: one revision with one log entry, never on Main (checked here
   * once more, whatever the caller checked before).
   */
  #saveTo(branch: string, document: ManufaktureDocument, entry: LogEntry) {
    if (branch === MAIN_BRANCH || !isBranchId(branch)) {
      return Promise.reject(new Refused('An agent never writes Main.'));
    }
    // Closed: the branch lock is released, or about to be.
    if (this.#closed) return Promise.reject(new Refused('The session is closed.'));
    const saving = this.#host.library.save(document, [entry], branch);
    this.#saving = saving;
    void saving.then(
      () => {
        if (this.#saving === saving) this.#saving = null;
      },
      () => {
        if (this.#saving === saving) this.#saving = null;
      },
    );
    return saving;
  }

  /** Put the engine back on `document` (a rollback): cached, so cheap. */
  async #restore(document: ManufaktureDocument): Promise<void> {
    const back = await this.#settle(document);
    if (!back.ok) await this.#replaceEngine('restart').catch(() => undefined);
    await this.#syncReferences();
  }

  #now(): Date {
    return this.#host.now?.() ?? new Date();
  }

  async #measureChanged(before: RegenResult | null, after: RegenResult): Promise<BodySummary[]> {
    const was = new Map(
      (before?.parts ?? []).flatMap((p) =>
        p.bodies.map((b) => [`${p.partId}/${b.bodyId}`, b.bodyKey]),
      ),
    );
    const changed = after.parts
      .flatMap((p) => p.bodies.map((b) => ({ partId: p.partId, body: b })))
      .filter(({ partId, body }) => was.get(`${partId}/${body.bodyId}`) !== body.bodyKey)
      .slice(0, MAX_REPORTED);
    if (changed.length === 0) return [];
    try {
      const reply = await this.#kernel.run({
        generation: this.#generation,
        ops: changed.map(({ body }) => ({
          op: 'measure' as const,
          shape: body.shape,
          targets: [],
          body: true,
        })),
      });
      if (reply.status !== 'done') return [];
      return reply.results.flatMap((r, i) => {
        const value = r.ok ? (r.value as { body: BodySummary | null }).body : null;
        if (!value) return [];
        const { partId, body } = changed[i]!;
        return [
          {
            partId,
            bodyId: body.bodyId,
            volume: value.volume,
            area: value.area,
            boundingBox: value.boundingBox,
          },
        ];
      });
    } catch {
      return [];
    }
  }

  // -------------------------------------------------------------------------------------------
  // Update from Main

  /**
   * Replay the branch's batches onto Main's current head (T7.1f's merge, command by command) on
   * a new agent branch made from that head, which replaces this one; report what did not apply.
   */
  updateFromMain(): Promise<SessionResult<UpdateReport>> {
    return this.#serial(async () => {
      if (this.#ended()) return this.#closedError();
      const writable = await this.#writable();
      if (!writable.ok) return writable;
      const lib = this.#host.library;
      const id = this.documentId;
      const old = this.#branch;
      const main = await lib.open(id, MAIN_BRANCH);
      if (!main.ok) return sessionError('storage', main.message);
      const unchanged = (): UpdateReport => ({
        changed: false,
        branch: old.id,
        previousBranch: old.id,
        baseVersion: this.#base.id,
        revision: this.#revision,
        applied: [],
        dropped: [],
        renamed: [],
        overwritten: [],
        mergedWhole: [],
      });
      if (
        (this.#base.branch ?? MAIN_BRANCH) === MAIN_BRANCH &&
        this.#base.revision === main.value.revision
      ) {
        return done(unchanged());
      }
      const base = await lib.readVersion(id, this.#base.id);
      if (!base.ok) return sessionError('storage', base.message);
      // Main's revisions are counted where it is kept (a sync server's working copy counts its
      // own), so a base whose document is Main's head is unchanged too.
      if (serialize(base.value.document) === serialize(main.value.document)) {
        return done(unchanged());
      }
      const log = await lib.readLog(id, old.id);
      if (!log.ok) return sessionError('storage', log.message);
      const replayed = replayOnto(base.value.document, main.value.document, log.value);
      if (!replayed.ok) return sessionError('storage', replayed.message);
      const { entries, dropped, renamed, overwritten, mergedWhole } = replayed.value;

      // A new branch from Main's head, under the old branch's name: the old one is renamed aside
      // first, and deleted once the new one holds every batch.
      const name = old.name;
      const aside = await lib.renameBranch(id, old.id, `${name} (before update)`.slice(0, 200));
      if (!aside.ok) return sessionError('storage', aside.message);
      // The new branch is open, and a reviewer's comment carries over from the old one (the agent
      // is still working on the changes asked for, ADR 0016): the library copies it from the
      // stored branch, so it never comes from the session.
      const { origin, sessionId, clientName } = old.provenance!;
      const provenance = { origin, sessionId, clientName, review: 'open' as const };
      const made = await lib.branchFromRevision(id, {
        version: { name: `Agent session ${this.id} update from Main` },
        name,
        provenance,
        reviewCommentFrom: old.id,
      });
      if (!made.ok) {
        await lib.renameBranch(id, old.id, name);
        return sessionError('storage', made.message);
      }
      const fresh = made.value.branch;
      const undoNew = async (lock: BranchLock | null) => {
        await lock?.release();
        await lib.deleteBranch(id, fresh.id);
        await lib.renameBranch(id, old.id, name);
      };
      const lock = await this.#host.locks.acquire(id, fresh.id, this.id);
      if (lock === null) {
        await undoNew(null);
        return sessionError('locked', 'Another session took the new branch.');
      }
      let doc = main.value.document;
      let revision = 1;
      const stack: Undoable[] = [];
      try {
        for (const e of entries) {
          const r = applyCommand(doc, e.command);
          if (!r.ok) throw new Refused(`"${e.label}" does not apply: ${r.error.message}`);
          const saved = await this.#saveTo(fresh.id, r.value.document, {
            cause: e.cause,
            label: e.label,
            command: e.command,
            at: this.#now().toISOString(),
          });
          revision = saved.revision;
          if (e.cause === 'undo') stack.pop();
          else
            stack.push({
              revision,
              label: e.label,
              command: e.command,
              inverse: r.value.inverse,
              prior: [],
            });
          doc = r.value.document;
        }
      } catch (e) {
        await undoNew(lock);
        return sessionError(
          'storage',
          `The branch was not updated: ${this.#public(e, 'updating from Main')}`,
        );
      }
      // Main's head is the new base: scripts Main has are no longer the branch's own.
      const priorBase = this.#engine.scriptBase ?? null;
      this.#engine.scriptBase = main.value.document;
      const regen = await this.#settle(doc);
      if (!regen.ok) {
        this.#engine.scriptBase = priorBase;
        await undoNew(lock);
        await this.#restore(this.#document);
        return sessionError(
          regen.reason === 'timeout' ? 'regen-timeout' : 'kernel',
          `The branch was not updated: ${regen.message}`,
        );
      }
      // The old branch's review state again (a reviewer may have acted meanwhile), then the old
      // branch goes: that is the commit. Either refused, the new branch goes instead.
      const listed = await lib.listBranches(id);
      const now = listed.ok ? listed.value.find((b) => b.id === old.id) : undefined;
      const refuse = async (r: { ok: false; error: Refusal }) => {
        this.#engine.scriptBase = priorBase;
        await undoNew(lock);
        await this.#restore(this.#document);
        return r;
      };
      if (
        now === undefined ||
        now.provenance?.review !== old.provenance?.review ||
        now.provenance?.comment !== fresh.provenance?.comment
      ) {
        return refuse(
          now === undefined && !listed.ok
            ? sessionError('storage', listed.message)
            : sessionError(
                'branch-state',
                'The review state of the branch changed meanwhile: it was not updated.',
              ),
        );
      }
      const deleted = await lib.deleteBranch(id, old.id);
      if (!deleted.ok) {
        return refuse(sessionError('storage', `The branch was not updated: ${deleted.message}`));
      }
      // Committed: the session works on the new branch.
      const oldLock = this.#lock;
      this.#lock = lock;
      this.#branch = fresh;
      this.#base = made.value.version;
      this.#document = doc;
      this.#revision = revision;
      this.#stack = stack;
      await oldLock.release().catch(() => undefined);
      await this.#syncReferences();
      return done({
        changed: true,
        branch: fresh.id,
        previousBranch: old.id,
        baseVersion: made.value.version.id,
        revision,
        applied: entries.map((e) => e.label),
        dropped,
        renamed,
        overwritten,
        mergedWhole,
      });
    });
  }

  // -------------------------------------------------------------------------------------------
  // Submit

  /**
   * Build the review bundle with `builder` (T8.3a's), store it with the branch for its head
   * revision, and set the branch's review state to `submitted`. A later write returns the branch
   * to `open`, and the bundle is then stale.
   */
  submit(
    builder: BundleBuilder,
    note = '',
  ): Promise<SessionResult<{ revision: number; review: ReviewState }>> {
    return this.#serial(async () => {
      if (this.#ended()) return this.#closedError();
      if (
        typeof note !== 'string' ||
        note.length > MAX_NOTE ||
        NOTE_CONTROL.test(note) ||
        !(note as unknown as { isWellFormed(): boolean }).isWellFormed()
      ) {
        return sessionError(
          'invalid-input',
          `A note is text of at most ${MAX_NOTE} characters, with no control or format characters but line breaks and tabs.`,
        );
      }
      const store = this.#host.bundles;
      if (store === undefined) return sessionError('bundle', 'This host stores no bundles.');
      const writable = await this.#writable();
      if (!writable.ok) return writable;
      const review = writable.value.provenance?.review;
      if (review !== 'open') {
        return sessionError(
          'branch-state',
          `The branch is ${review}: only an open branch is submitted (a write reopens one with changes requested).`,
        );
      }
      if (this.#stack.length === 0 && this.#revision <= 1) {
        return sessionError('branch-state', 'The branch has no work to submit.');
      }
      const base = await this.#host.library.readVersion(this.documentId, this.#base.id);
      if (!base.ok) return sessionError('storage', base.message);
      let bundle: unknown;
      try {
        bundle = await builder(
          { versionId: this.#base.id, document: base.value.document },
          {
            branch: this.#branch.id,
            revision: this.#revision,
            document: this.#document,
            regen: this.#model.last,
          },
          {
            documentId: this.documentId,
            library: this.#host.library,
            // The builder's engine runs the same scripts as the session's, and fails the runs
            // the hard limit stopped there without running them again.
            engine: async () => {
              const engine = await this.#host.engine();
              try {
                engine.scriptBase = base.value.document;
                await engine.addRunawayScripts?.(this.#engine.runawayScripts ?? []);
              } catch (e) {
                await engine.close().catch(() => undefined);
                throw e;
              }
              return engine;
            },
            limits: this.#host.limits,
            putBlob: (bytes) => store.putBlob(this.documentId, bytes),
          },
        );
      } catch (e) {
        return sessionError(
          'bundle',
          `The review bundle could not be built: ${this.#public(e, 'building the bundle')}`,
        );
      }
      const record: StoredBundle = {
        format: 'manufakture-review-bundle',
        documentId: this.documentId,
        branch: this.#branch.id,
        revision: this.#revision,
        baseVersion: this.#base.id,
        note,
        submittedAt: this.#now().toISOString(),
        bundle,
      };
      let size: number;
      try {
        size = Buffer.byteLength(JSON.stringify(record), 'utf8');
      } catch (e) {
        return sessionError(
          'bundle',
          `The review bundle is not JSON data: ${this.#public(e, 'measuring the bundle')}`,
        );
      }
      if (size > MAX_BUNDLE_BYTES) {
        return sessionError(
          'bundle',
          `The review bundle is ${size} bytes; at most ${MAX_BUNDLE_BYTES}.`,
          MAX_BUNDLE_BYTES,
        );
      }
      try {
        await store.put(record);
      } catch (e) {
        return sessionError(
          'bundle',
          `The review bundle was not stored: ${this.#public(e, 'storing the bundle')}`,
        );
      }
      // Submitting is the one forward move an agent makes on its own branch (ADR 0016 decision 9;
      // the other is back to open on a write), and only from open: a reviewer's decision made
      // while the bundle was built stands.
      const set = await this.#host.library.setBranchReview(
        this.documentId,
        this.#branch.id,
        'submitted',
        { expected: 'open' },
      );
      if (!set.ok) {
        return set.reviewChanged
          ? sessionError(
              'branch-state',
              'The review state of the branch changed meanwhile: it was not submitted.',
            )
          : sessionError('storage', set.message);
      }
      this.#branch = set.value;
      return done({ revision: this.#revision, review: 'submitted' as const });
    });
  }

  // -------------------------------------------------------------------------------------------
  // Reads

  #context(): QueryContext {
    return {
      document: this.#document,
      model: this.#model,
      api: this.#kernel,
      generation: this.#generation,
      references: this.#references,
    };
  }

  #read<T>(fn: () => T | Promise<T>): Promise<SessionResult<T>> {
    return this.#serial(async () => {
      if (this.#ended()) return this.#closedError();
      try {
        return done(await fn());
      } catch (e) {
        if (e instanceof KernelTimeout) {
          // The kernel was ended: build the document again for the next call.
          if (!this.#ended()) {
            await this.#settle(this.#document);
            await this.#syncReferences();
          }
          return sessionError(
            'kernel-timeout',
            `${e.message} The kernel was restarted; ask for less at once.`,
            e.ms,
          );
        }
        if (e instanceof EngineLost) {
          if (this.#ended()) return this.#closedError();
          await this.#replaceEngine('restart').catch(() => undefined);
          await this.#settle(this.#document);
          return sessionError('kernel', 'The kernel was restarted; ask again.');
        }
        return sessionError('kernel', `The query failed: ${this.#public(e, 'a query')}`);
      }
    });
  }

  #readResult<T>(
    fn: () => SessionResult<T> | Promise<SessionResult<T>>,
  ): Promise<SessionResult<T>> {
    return this.#read(fn).then((r) => (r.ok ? r.value : r));
  }

  async info(): Promise<SessionInfo> {
    const latest = this.#host.bundles
      ? await this.#host.bundles.latest(this.documentId, this.#branch.id).catch(() => null)
      : null;
    return {
      sessionId: this.id,
      documentId: this.documentId,
      branch: this.#branch.id,
      branchName: this.#branch.name,
      baseVersion: this.#base.id,
      revision: this.#revision,
      review: this.#branch.provenance?.review ?? 'open',
      batches: this.#batches,
      closed: this.#closed,
      engine: this.#engine.kind,
      kernelReplaced: this.#engine.replaced,
      bundle:
        latest === null
          ? null
          : { revision: latest.revision, stale: latest.revision !== this.#revision },
    };
  }

  tree(): Promise<SessionResult<ReturnType<typeof tree>>> {
    return this.#read(() => tree(this.#document, this.#model.last));
  }

  object(query: unknown): Promise<SessionResult<unknown>> {
    return this.#readResult(() => objectOf(this.#document, query));
  }

  schema(query: {
    command?: unknown;
    feature?: unknown;
  }): Promise<SessionResult<Record<string, unknown>>> {
    return this.#readResult(() => schemaOf(query));
  }

  schemaIndex(): { commands: string[]; features: string[] } {
    return schemaIndex();
  }

  findGeometry(query: unknown): Promise<SessionResult<GeometryHit[]>> {
    return this.#readResult(() => findGeometry(this.#context(), query));
  }

  measure(query: unknown): Promise<SessionResult<unknown>> {
    return this.#readResult(() => measure(this.#context(), query));
  }

  quantities(): Promise<SessionResult<Quantities>> {
    return this.#read(() => quantities(this.#context()));
  }

  errors(): Promise<SessionResult<ErrorLine[]>> {
    return this.#read(() => errorsOf(this.#model.last, this.#references));
  }

  /** The branch's batches, oldest first, with labels and revisions. */
  history(): Promise<SessionResult<HistoryItem[]>> {
    return this.#readResult(async () => {
      const read = await this.#host.library.readHistory(this.documentId, this.#branch.id);
      if (!read.ok) return sessionError('storage', read.message);
      return done(
        read.value.flatMap((r) => r.entries.map((e) => ({ revision: r.revision, ...e }))),
      );
    });
  }

  /** The last regen, for hosts that render or build bundles (plain data). */
  get regen(): RegenResult | null {
    return this.#model.last;
  }
}

function resumable(record: Branch): string | null {
  if (record.provenance?.origin !== 'agent') return 'It is not an agent branch.';
  const review = record.provenance.review;
  if (review !== 'open' && review !== 'changes-requested') {
    return `The branch is ${review}: only an open branch, or one with changes requested, is resumed.`;
  }
  return null;
}

/** The branch's batches not undone, oldest first, from its log. */
async function undoStack(
  library: DocumentLibrary,
  documentId: string,
  branch: string,
): Promise<SessionResult<Undoable[]>> {
  const history = await library.readHistory(documentId, branch);
  if (!history.ok) return sessionError('storage', history.message);
  const log = await library.readLog(documentId, branch);
  if (!log.ok) return sessionError('storage', log.message);
  const stack: Undoable[] = [];
  let i = 0;
  for (const revision of history.value) {
    const prior: Command[] = [];
    for (let k = 0; k < revision.entries.length; k++) {
      const entry = log.value[i++];
      if (entry === undefined) return sessionError('storage', 'The branch log is incomplete.');
      if (entry.cause === 'undo') stack.pop();
      else
        stack.push({
          revision: revision.revision,
          label: entry.label,
          command: entry.command,
          prior: [...prior],
        });
      prior.push(entry.command);
    }
  }
  return done(stack);
}

function statusChanges(before: RegenResult | null, after: RegenResult): StatusChange[] {
  const key = (p: string, f: string) => `${p}\u0000${f}`;
  const was = new Map(
    (before?.parts ?? []).flatMap((p) =>
      p.features.map((f) => [key(p.partId, f.featureId), f.status]),
    ),
  );
  const out: StatusChange[] = [];
  const seen = new Set<string>();
  for (const p of after.parts) {
    for (const f of p.features) {
      const k = key(p.partId, f.featureId);
      seen.add(k);
      const old = was.get(k) ?? null;
      if (old !== f.status)
        out.push({ partId: p.partId, featureId: f.featureId, before: old, after: f.status });
    }
  }
  for (const [k, status] of was) {
    if (seen.has(k)) continue;
    const [partId, featureId] = k.split('\u0000') as [string, string];
    out.push({ partId, featureId, before: status, after: null });
  }
  return out.slice(0, MAX_REPORTED);
}

/**
 * What the agent reads of an error that is not the session's own: a general message, with the
 * system error code when there is one (`ENOSPC`), never the error's text (absolute paths, a
 * worker's internals). The full error goes to the host's log.
 */
function generic(e: unknown, context: string): string {
  const code = (e as { code?: unknown } | null)?.code;
  const known = typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,31}$/.test(code) ? code : null;
  const what =
    context === 'saving' || context === 'updating from Main'
      ? 'storage failed'
      : context.includes('bundle')
        ? 'the bundle builder or store failed'
        : 'the kernel failed';
  return known === null ? `${what}.` : `${what} (${known}).`;
}
