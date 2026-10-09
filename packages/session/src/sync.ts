// Sessions over sync (ADR 0016 decisions 1, 10 and 12; M8 plan T8.4b). A session works on its
// agent branch through a `DocumentLibrary`; over sync that library is a `SyncedLibrary`, whose
// files are a working copy (in memory by default) of what the sync server holds, and whose every
// change that matters goes to the server first:
//
// - Main is read from the server (`pullMain`) into the working copy, never written back: the
//   copy's main follows the server's, and nothing the session does reaches the server's main.
// - A new session branch starts from a version of Main's head. When the server has one already,
//   the branch starts from it and no version is added; otherwise its start version goes to the
//   server with the branch, in the same request, and the server records which agent token made
//   both (an agent token never adds a version to Main on its own). An update from Main asks the
//   server to carry the reviewer's comment over (`commentFrom`), so the comment never comes from
//   the agent.
// - Every batch is one sync entry on the branch's server log, judged by core there like any
//   other, submitted before the working copy saves it; a refusal leaves both as they were.
// - Review states change on the server first (a compare-and-set), then here; reading the branches
//   takes the server's states and comments into the working copy, so a reviewer's decision is
//   seen before every write.
// - Bundles and their images are stored on the server with the branch (`SyncBundleStore`).
//
// The server holds one writer per agent branch (its lease), renewed here while the session is
// open (a hello every `keepAliveMs`), so an agent thinking for minutes keeps its branch; the
// branch locks here are this process's own (`MemoryBranchLocks`).

import { randomBytes, randomUUID } from 'node:crypto';
import {
  FORMAT_VERSION,
  applyCommand,
  createdIds,
  migrateCommand,
  serialize,
  type ManufaktureDocument,
  type SyncEntry,
} from '@manufakture/core';
import {
  DocumentLibrary,
  MAIN_BRANCH,
  MemoryBackend,
  MemoryBranchLocks,
  isBranchId,
  isStorableId,
  type Branch,
  type BranchLock,
  type BranchLocks,
  type BranchProvenance,
  type DocumentSummary,
  type LibraryOptions,
  type LibraryResult,
  type LogEntry,
  type MergePlan,
  type Opened,
  type ReviewState,
  type StorageBackend,
  type SyncRecord,
  type Version,
  type VersionMeta,
} from '@manufakture/library';
import {
  ServerApi,
  ServerApiError,
  type ServerBranch,
  type ServerDocumentInfo,
  type ServerVersion,
} from '@manufakture/sync';
import type { BundleStore, StoredBundle } from './bundles';

/**
 * A refusal from the sync server, worded for the agent: the session passes its message on as it
 * is (it names the server's code, never the token or the server's address).
 */
export class RemoteRefusal extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'RemoteRefusal';
  }
}

/** What the agent reads for a server error: fixed text with the server's code. */
function refusal(e: unknown): RemoteRefusal {
  if (e instanceof RemoteRefusal) return e;
  if (e instanceof ServerApiError) {
    if (e.status === 0) return new RemoteRefusal('The sync server could not be reached.', e.code);
    if (e.status === 401) {
      return new RemoteRefusal('The sync server did not accept the token (revoked?).', e.code);
    }
    if (e.code === 'branch-busy') {
      return new RemoteRefusal('Another client is writing this branch on the sync server.', e.code);
    }
    return new RemoteRefusal(`The sync server refused it (${e.code}).`, e.code);
  }
  return new RemoteRefusal('The sync server failed.', 'failed');
}

/**
 * A failure over sync: `noBranch` when the branch is not there, `busy` when another client holds
 * it (the server's lease, or a session of this process).
 */
export interface SyncFailure {
  ok: false;
  message: string;
  noBranch?: true;
  busy?: true;
}

function failure(e: unknown): SyncFailure {
  const r = refusal(e);
  if (r.code === 'not-found') {
    return { ok: false, message: 'There is no such branch.', noBranch: true };
  }
  return r.code === 'branch-busy'
    ? { ok: false, message: r.message, busy: true }
    : { ok: false, message: r.message };
}

/** This process's claim on a branch's server log: its client, sequence and the head it built. */
interface Writer {
  clientId: string;
  key: string;
  /** The last `clientSeq` sent (never reused). */
  seq: number;
  /** The last one accepted. */
  latest?: number;
  /** The server log's head revision. */
  rev: number;
  /** The branch's document at that revision (the created ids of the next entry are its). */
  head: ManufaktureDocument;
}

/**
 * Branch locks for sessions over sync: this process's own (`MemoryBranchLocks`), and releasing
 * one lets go of the branch's server log too (`SyncedLibrary.release`), so a session closed here
 * can be resumed elsewhere at once.
 */
class SyncedBranchLocks implements BranchLocks {
  readonly #inner = new MemoryBranchLocks();
  readonly #library: SyncedLibrary;

  constructor(library: SyncedLibrary) {
    this.#library = library;
  }

  async acquire(documentId: string, branch: string): Promise<BranchLock | null> {
    const lock = await this.#inner.acquire(documentId, branch);
    if (lock === null) return null;
    return {
      documentId,
      branch,
      held: () => lock.held(),
      release: async () => {
        const was = await lock.held();
        await lock.release();
        if (was) await this.#library.release(documentId, branch);
      },
    };
  }
}

export interface SyncedLibraryOptions extends LibraryOptions {
  /** The working copy's storage (default: memory, so nothing of the server lands on disk). */
  backend?: StorageBackend;
  /**
   * How often, in milliseconds, the server's lease on each branch this process holds is renewed
   * (default `DEFAULT_KEEP_ALIVE_MS`). Keep it well under the server's `writerLeaseMs`.
   */
  keepAliveMs?: number;
}

/** The lease on a branch is renewed every 30 s (the server's lease lasts 120 s by default). */
export const DEFAULT_KEEP_ALIVE_MS = 30_000;

const key = (id: string, branch: string) => `${id}\u0000${branch}`;

export class SyncedLibrary extends DocumentLibrary {
  readonly api: ServerApi;
  /** The server's main revision the working copy's main holds, per document. */
  readonly #mainRev = new Map<string, number>();
  readonly #writers = new Map<string, Writer>();
  readonly #clock: () => Date;
  readonly #keepAliveMs: number;
  #keepAlive: ReturnType<typeof setInterval> | null = null;

  constructor(api: ServerApi, options: SyncedLibraryOptions = {}) {
    const { backend, keepAliveMs, ...rest } = options;
    super(backend ?? new MemoryBackend(), rest);
    this.api = api;
    this.#clock = options.now ?? (() => new Date());
    this.#keepAliveMs = keepAliveMs ?? DEFAULT_KEEP_ALIVE_MS;
  }

  /** This process holds the branch's log now: its lease is renewed while it does. */
  #hold(k: string, w: Writer): void {
    this.#writers.set(k, w);
    if (this.#keepAlive === null) {
      this.#keepAlive = setInterval(() => void this.#renew(), this.#keepAliveMs);
      // Never what keeps the process alive.
      (this.#keepAlive as { unref?: () => void }).unref?.();
    }
  }

  /** This process no longer holds the branch's log. */
  #drop(k: string): void {
    this.#writers.delete(k);
    if (this.#writers.size === 0 && this.#keepAlive !== null) {
      clearInterval(this.#keepAlive);
      this.#keepAlive = null;
    }
  }

  /**
   * Renews the lease on every branch this process holds: a hello for its client again, which
   * the server answers by taking the lease anew. A refusal changes nothing here: the next write
   * meets it and says so.
   */
  async #renew(): Promise<void> {
    for (const [k, w] of [...this.#writers]) {
      const [id, branch] = k.split('\u0000') as [string, string];
      await this.api.hello(id, branch, w).catch(() => undefined);
    }
  }

  /** The branch locks sessions on this library take (`SessionManagerOptions.locks`). */
  readonly locks: BranchLocks = new SyncedBranchLocks(this);

  /** Lets go of the branch's server log, if this process holds it (its session closed). */
  async release(id: string, branch: string): Promise<void> {
    const k = key(id, branch);
    const w = this.#writers.get(k);
    if (w === undefined) return;
    this.#drop(k);
    await this.api.release(id, branch, w).catch(() => undefined);
  }

  /** The documents the token may read, as the server lists them. */
  async remoteDocuments(): Promise<LibraryResult<ServerDocumentInfo[]>> {
    try {
      return { ok: true, value: await this.api.listDocuments() };
    } catch (e) {
      return failure(e);
    }
  }

  /** A document's branch records on the server, provenance included. */
  async remoteBranches(id: string): Promise<LibraryResult<ServerBranch[]>> {
    try {
      return { ok: true, value: await this.api.listBranches(id) };
    } catch (e) {
      return failure(e);
    }
  }

  /**
   * Main as the server has it, in the working copy (made there on first use): its revision on
   * the server. The copy's main is a cache; it is never sent anywhere.
   */
  async pullMain(id: string): Promise<LibraryResult<number>> {
    if (!isStorableId(id)) return { ok: false, message: `There is no document "${id}".` };
    let snap;
    try {
      snap = await this.api.snapshot(id);
    } catch (e) {
      return failure(e);
    }
    if (snap === null) return { ok: false, message: `There is no document "${id}".` };
    if (!(await super.has(id))) {
      await super.save(snap.document, [], MAIN_BRANCH);
    } else if (this.#mainRev.get(id) !== snap.rev) {
      const opened = await super.open(id, MAIN_BRANCH);
      if (!opened.ok) return opened;
      if (serialize(opened.value.document) !== serialize(snap.document)) {
        await super.save(
          snap.document,
          [
            {
              cause: 'execute',
              label: 'Main on the sync server',
              command: { type: 'replaceDocument', document: snap.document },
              at: this.#clock().toISOString(),
            },
          ],
          MAIN_BRANCH,
        );
      }
    }
    this.#mainRev.set(id, snap.rev);
    return { ok: true, value: snap.rev };
  }

  async #ensure(id: string): Promise<LibraryResult<void>> {
    if (this.#mainRev.has(id) && (await super.has(id))) return { ok: true, value: undefined };
    const pulled = await this.pullMain(id);
    return pulled.ok ? { ok: true, value: undefined } : pulled;
  }

  /** Main is the server's: read it from there first. */
  override async open(id: string, branch: string = MAIN_BRANCH): Promise<LibraryResult<Opened>> {
    if (branch === MAIN_BRANCH) {
      const pulled = await this.pullMain(id);
      if (!pulled.ok) return pulled;
    }
    return super.open(id, branch);
  }

  /** A merge preview against Main is against the server's Main. */
  override async previewMerge(
    id: string,
    from: string,
    into: string,
    options: { document?: ManufaktureDocument } = {},
  ): Promise<LibraryResult<MergePlan>> {
    if (into === MAIN_BRANCH && options.document === undefined) {
      const pulled = await this.pullMain(id);
      if (!pulled.ok) return pulled;
    }
    return super.previewMerge(id, from, into, options);
  }

  /**
   * The branches here, with each agent branch's review state and comment as the server has them
   * now (a reviewer's decision is taken in before anything reads it).
   */
  override async listBranches(id: string): Promise<LibraryResult<Branch[]>> {
    const ensured = await this.#ensure(id);
    if (!ensured.ok) return ensured;
    const remote = await this.remoteBranches(id);
    if (!remote.ok) return remote;
    const local = await super.listBranches(id);
    if (!local.ok) return local;
    let changed = false;
    for (const b of local.value) {
      const p = remote.value.find((r) => r.id === b.id)?.provenance;
      if (p === undefined || b.provenance === undefined) continue;
      if (p.review !== b.provenance.review || p.comment !== b.provenance.comment) {
        const set = await super.setBranchReview(id, b.id, p.review, {
          comment: p.comment ?? null,
        });
        if (!set.ok) return set;
        changed = true;
      }
    }
    return changed ? super.listBranches(id) : local;
  }

  /**
   * A new agent branch from Main's head on the server. When the server has a version of that
   * revision already, the branch starts from it (kept here as a version from the server) and no
   * version is added; otherwise the start version is made here and goes to the server with the
   * branch. Then this process's claim on its log. Anything that fails undoes the branch (a start
   * version made here stays here: versions only name a revision).
   */
  override async branchFromRevision(
    id: string,
    options: {
      from?: string;
      revision?: number;
      version: VersionMeta;
      name: string;
      provenance?: BranchProvenance;
      reviewCommentFrom?: string;
    },
  ): Promise<LibraryResult<{ version: Version; branch: Branch }>> {
    if ((options.from ?? MAIN_BRANCH) !== MAIN_BRANCH || options.revision !== undefined) {
      return { ok: false, message: "Over sync, a branch is made from Main's head." };
    }
    const rev = await this.pullMain(id);
    if (!rev.ok) return rev;
    let existing: ServerVersion | undefined;
    try {
      // The owner's version of Main's head, or this token's own; never another token's start
      // version, which the server refuses to start from.
      const self = this.api.agentTokenId;
      existing = (await this.api.listVersions(id)).find(
        (v) =>
          v.branch === MAIN_BRANCH &&
          v.rev === rev.value &&
          (v.createdBy === undefined || v.createdBy === self),
      );
    } catch (e) {
      return failure(e);
    }
    let made: LibraryResult<{ version: Version; branch: Branch }>;
    if (existing !== undefined) {
      const version = await this.#adopt(id, existing.id);
      if (!version.ok) return version;
      const branch = await super.createBranch(id, version.value.id, options.name, {
        ...(options.provenance ? { provenance: options.provenance } : {}),
        ...(options.reviewCommentFrom === undefined
          ? {}
          : { reviewCommentFrom: options.reviewCommentFrom }),
      });
      made = branch.ok
        ? { ok: true, value: { version: version.value, branch: branch.value } }
        : branch;
    } else {
      made = await super.branchFromRevision(id, options);
    }
    if (!made.ok) return made;
    const { version, branch } = made.value;
    let stored: ServerBranch;
    try {
      const p = branch.provenance;
      stored = await this.api.createBranch(
        id,
        {
          id: branch.id,
          name: branch.name,
          fromVersion: version.id,
          createdAt: branch.createdAt,
          ...(p === undefined
            ? {}
            : {
                provenance: {
                  origin: p.origin,
                  sessionId: p.sessionId,
                  clientName: p.clientName,
                  review: 'open' as const,
                },
              }),
        },
        {
          ...(options.reviewCommentFrom === undefined
            ? {}
            : { commentFrom: options.reviewCommentFrom }),
          ...(existing !== undefined
            ? {}
            : {
                startVersion: {
                  id: version.id,
                  name: version.name,
                  description: version.description ?? '',
                  branch: MAIN_BRANCH,
                  rev: rev.value,
                  createdAt: version.createdAt,
                },
              }),
        },
      );
    } catch (e) {
      await super.deleteBranch(id, branch.id);
      return failure(e);
    }
    const opened = await super.open(id, branch.id);
    const claimed = opened.ok ? await this.#claim(id, branch.id, 0, opened.value.document) : opened;
    if (!claimed.ok) {
      await this.api.deleteBranch(id, branch.id, 'open').catch(() => undefined);
      await super.deleteBranch(id, branch.id);
      return claimed;
    }
    // The comment is the server's (copied there from the branch replaced), never the session's.
    let kept = branch;
    const sp = stored.provenance;
    if (sp !== undefined && sp.comment !== branch.provenance?.comment) {
      const set = await super.setBranchReview(id, branch.id, sp.review, {
        comment: sp.comment ?? null,
      });
      if (set.ok) kept = set.value;
    }
    return { ok: true, value: { version, branch: kept } };
  }

  /** Version `versionId` of the server, kept in the working copy (read from there if not yet). */
  async #adopt(id: string, versionId: string): Promise<LibraryResult<Version> | SyncFailure> {
    const versions = await super.listVersions(id);
    if (!versions.ok) return versions;
    const here = versions.value.find((v) => v.id === versionId);
    if (here !== undefined) return { ok: true, value: here };
    let read;
    try {
      read = await this.api.readVersion(id, versionId);
    } catch (e) {
      return failure(e);
    }
    if (read === null) {
      return { ok: false, message: 'The version the branch was made from is gone.' };
    }
    return super.adoptVersion(
      id,
      {
        id: read.version.id,
        name: read.version.name,
        description: read.version.description,
        createdAt: read.version.createdAt,
        branch: read.version.branch,
        serverRev: read.version.rev,
      },
      read.document,
    );
  }

  /** Takes the branch's server log for this process (the server's one-writer lease). */
  async #claim(
    id: string,
    branch: string,
    rev: number,
    head: ManufaktureDocument,
  ): Promise<LibraryResult<void> | SyncFailure> {
    const writer: Writer = {
      clientId: `session-${randomUUID()}`,
      key: randomBytes(32).toString('base64url'),
      seq: 0,
      rev,
      head,
    };
    try {
      const welcome = await this.api.hello(id, branch, writer);
      if (welcome.head !== rev) {
        return { ok: false, message: 'The branch on the sync server moved meanwhile.' };
      }
    } catch (e) {
      return failure(e);
    }
    this.#hold(key(id, branch), writer);
    return { ok: true, value: undefined };
  }

  /**
   * An agent branch the server has, made in the working copy with its whole log (one revision per
   * entry, as the session wrote them), and claimed for this process: what resuming it needs.
   */
  async materialize(id: string, branch: string): Promise<LibraryResult<Branch> | SyncFailure> {
    if (branch === MAIN_BRANCH || !isBranchId(branch)) {
      return { ok: false, message: 'There is no such branch.', noBranch: true };
    }
    const ensured = await this.#ensure(id);
    if (!ensured.ok) return ensured;
    const remote = await this.remoteBranches(id);
    if (!remote.ok) return remote;
    const record = remote.value.find((b) => b.id === branch);
    if (record === undefined) {
      return { ok: false, message: 'There is no such branch.', noBranch: true };
    }
    if (this.#writers.has(key(id, branch))) {
      // A session of this process holds it: it is not built again under that session.
      return {
        ok: false,
        message: 'Another client is writing this branch: a session here.',
        busy: true,
      };
    }
    const listed = await super.listBranches(id);
    if (!listed.ok) return listed;
    if (listed.value.some((b) => b.id === branch)) {
      // Made here already (a session of this process): drop it and build it again from the
      // server, which is the truth.
      this.#drop(key(id, branch));
      await super.deleteBranch(id, branch);
    }
    const from = await this.#adopt(id, record.fromVersion);
    if (!from.ok) return from;
    const adopted = await super.adoptBranch(id, record as Branch);
    if (!adopted.ok) return adopted;
    const opened = await super.open(id, branch);
    if (!opened.ok) return opened;
    let doc = opened.value.document;
    let rev = 0;
    try {
      for (;;) {
        const page = await this.api.pull(id, branch, rev);
        if (page.length === 0) break;
        for (const p of page) {
          if (p.rev !== rev + 1) throw new RemoteRefusal('The branch log has a gap.', 'damaged');
          const command = migrateCommand(p.entry.command, p.entry.format);
          const applied = command.ok ? applyCommand(doc, command.value) : command;
          if (!command.ok || !applied.ok) {
            throw new RemoteRefusal('The branch log does not apply.', 'damaged');
          }
          const next = applied.value.document;
          await super.save(
            next,
            [
              {
                cause: p.entry.cause,
                label: p.entry.label,
                command: command.value,
                at: p.entry.at,
              },
            ],
            branch,
          );
          doc = next;
          rev = p.rev;
        }
      }
    } catch (e) {
      await super.deleteBranch(id, branch);
      return failure(e);
    }
    const claimed = await this.#claim(id, branch, rev, doc);
    if (!claimed.ok) {
      await super.deleteBranch(id, branch);
      return claimed;
    }
    return adopted;
  }

  /**
   * A branch revision: one sync entry on the server first (core judges it there), then the
   * working copy. Main is only ever the working copy's cache (the session never saves to it).
   */
  override async save(
    doc: ManufaktureDocument,
    entries: readonly LogEntry[] = [],
    branch?: string,
    sync?: SyncRecord,
  ): Promise<DocumentSummary> {
    const on = branch ?? MAIN_BRANCH;
    if (on === MAIN_BRANCH) return super.save(doc, entries, branch, sync);
    const k = key(doc.id, on);
    const w = this.#writers.get(k);
    if (w === undefined) {
      throw new RemoteRefusal(
        'This process does not hold the branch on the sync server: open or resume it again.',
        'not-held',
      );
    }
    if (entries.length !== 1) {
      throw new RemoteRefusal('A synced branch revision holds exactly one batch.', 'invalid');
    }
    const e = entries[0]!;
    const created = createdIds(w.head, e.command);
    if (!created.ok) throw new RemoteRefusal('The batch does not apply to the branch.', 'invalid');
    const seq = w.seq + 1;
    const entry: SyncEntry = {
      clientId: w.clientId,
      clientSeq: seq,
      ...(w.latest === undefined ? {} : { prevSeq: w.latest }),
      baseRev: w.rev,
      format: FORMAT_VERSION,
      cause: e.cause,
      label: e.label.slice(0, 1000),
      command: e.command as unknown as SyncEntry['command'],
      created: created.value as SyncEntry['created'],
      at: e.at,
    };
    let answers;
    try {
      answers = await this.api.submit(doc.id, on, w.key, {
        type: 'submit',
        entries: [entry],
        floor: seq,
      });
    } catch (err) {
      throw refusal(err);
    } finally {
      w.seq = seq;
    }
    const answer = answers.find(
      (m) => (m.type === 'ack' || m.type === 'refuse') && m.clientSeq === seq,
    );
    if (answer?.type === 'refuse') {
      throw new RemoteRefusal(
        `The sync server refused the batch (${answer.error.code}).`,
        answer.error.code,
      );
    }
    if (answer?.type !== 'ack') {
      throw new RemoteRefusal('The sync server did not take the batch.', 'unanswered');
    }
    if (answer.rev !== w.rev + 1) {
      // Someone else wrote the branch: this copy no longer matches it.
      this.#drop(k);
      throw new RemoteRefusal('The branch on the sync server moved meanwhile.', 'moved');
    }
    w.latest = seq;
    w.rev = answer.rev;
    try {
      const saved = await super.save(doc, entries, on);
      w.head = doc;
      return saved;
    } catch (err) {
      // The server has it and the copy does not: this process stops writing the branch (a resume
      // builds the copy again from the server).
      this.#drop(k);
      throw err;
    }
  }

  /**
   * A review state, set on the server first (compare-and-set there), then in the working copy
   * as the server answered. The server decides what an agent token may set.
   */
  override async setBranchReview(
    id: string,
    branch: string,
    review: ReviewState,
    options: { expected?: ReviewState | readonly ReviewState[]; comment?: string | null } = {},
  ): Promise<LibraryResult<Branch>> {
    if (branch === MAIN_BRANCH || !isBranchId(branch)) {
      return super.setBranchReview(id, branch, review, options);
    }
    let stored: ServerBranch;
    try {
      stored = await this.api.setReview(id, branch, {
        review,
        ...(options.expected === undefined
          ? {}
          : {
              expected:
                typeof options.expected === 'string' ? options.expected : [...options.expected],
            }),
        ...(options.comment === undefined ? {} : { comment: options.comment }),
      });
    } catch (e) {
      if (e instanceof ServerApiError && e.code === 'review-changed') {
        await this.listBranches(id);
        return { ok: false, message: 'The review state changed meanwhile.', reviewChanged: true };
      }
      return failure(e);
    }
    const p = stored.provenance;
    if (p === undefined) return { ok: false, message: 'It is not an agent branch.' };
    return super.setBranchReview(id, branch, p.review, { comment: p.comment ?? null });
  }

  /** A branch goes on the server (while its review state is the one here), then here. */
  override async deleteBranch(id: string, branch: string): Promise<LibraryResult<void>> {
    if (branch !== MAIN_BRANCH && isBranchId(branch)) {
      const listed = await super.listBranches(id);
      const here = listed.ok ? listed.value.find((b) => b.id === branch) : undefined;
      try {
        await this.api.deleteBranch(id, branch, here?.provenance?.review);
      } catch (e) {
        return failure(e);
      }
      this.#drop(key(id, branch));
    }
    return super.deleteBranch(id, branch);
  }
}

/**
 * Review bundles over sync: each image and bundle stored on the server with the branch, and in
 * the working copy (`local`) for this process's reads. A bundle not here (a branch resumed in
 * another process) is read from the server.
 */
export class SyncBundleStore implements BundleStore {
  readonly #local: BundleStore;
  readonly #api: ServerApi;

  constructor(local: BundleStore, api: ServerApi) {
    this.#local = local;
    this.#api = api;
  }

  async put(record: StoredBundle): Promise<void> {
    try {
      await this.#api.putBundle(record.documentId, record.branch, record.revision, record);
    } catch (e) {
      throw refusal(e);
    }
    await this.#local.put(record);
  }

  async latest(documentId: string, branch: string): Promise<StoredBundle | null> {
    const here = await this.#local.latest(documentId, branch);
    if (here !== null) return here;
    const there = await this.#api.getBundle(documentId, branch).catch(() => null);
    const r = there?.record;
    return r !== undefined && r.format === 'manufakture-review-bundle'
      ? (r as unknown as StoredBundle)
      : null;
  }

  async putBlob(documentId: string, bytes: Uint8Array): Promise<string> {
    const sha = await this.#local.putBlob(documentId, bytes);
    try {
      await this.#api.putBlob(sha, bytes);
    } catch (e) {
      throw refusal(e);
    }
    return sha;
  }

  readBlob(documentId: string, sha256: string): Promise<Uint8Array | null> {
    return this.#local.readBlob(documentId, sha256);
  }
}
