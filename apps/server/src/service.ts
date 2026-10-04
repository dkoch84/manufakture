import { createHash, timingSafeEqual } from 'node:crypto';
import {
  applyCommand,
  documentCounters,
  maxCounters,
  migrateCommand,
  parseDocument,
  type CounterTable,
  type ManufaktureDocument,
} from '@manufakture/core';
import {
  CURRENT_VERSIONS,
  CreateBranchSchema,
  CreateVersionSchema,
  HelloSchema,
  RECORD_ID,
  MAX_ENTRIES_PER_MESSAGE,
  SubmitSchema,
  checkVersions,
  judgeEntry,
  type Outcome,
  type PushMessage,
  type PushedEntry,
  type ServerBranch,
  type ServerMessage,
  type ServerVersion,
  type Versions,
  sameRecord,
} from '@manufakture/sync';
import { z } from 'zod';
import { TokenBucket, type Limits } from './limits';
import {
  CHECKPOINT_EVERY,
  MAIN_BRANCH,
  type StoredSnapshot,
  type SubmitWrite,
  type SyncStore,
} from './store';

/**
 * The sync server's logic, between the transport (`app.ts`: HTTP and WebSocket) and the store:
 * documents, the client claim, submits judged by `judgeEntry` (T7.1b) against a cached head, the
 * de-duplication table with its retention floor, pulls and blobs. Every answer is a `Reply` the
 * transport turns into an HTTP response or WebSocket messages.
 */

/** What the transport sends back. `messages` are protocol messages (`ServerMessageSchema`). */
export type Reply =
  | {
      readonly ok: true;
      readonly status: number;
      readonly messages: ServerMessage[];
      /** Entries this request got accepted, for every open connection of the document. */
      readonly push?: PushMessage;
    }
  | ReplyError;

export interface ReplyError {
  readonly ok: false;
  readonly status: number;
  /** A transport-level code (`unauthorized`, `rate-limited`, `client-key`, ...). */
  readonly code: string;
  readonly message: string;
  /** Protocol messages that explain it, when there are any (`below-floor`, version skew). */
  readonly messages?: ServerMessage[];
  readonly retryAfterMs?: number;
}

/** A version or branch record stored (201) or already there (200). */
export interface RecordReply<T> {
  readonly ok: true;
  readonly status: 200 | 201;
  readonly record: T;
}

/** How a submit's sender is known: by its client key (HTTP), or bound by its hello (WebSocket). */
export type Sender = { readonly key: string | undefined } | { readonly boundClientId: string };

/** A document id: URL-safe, as the app makes them (UUIDs). */
export const DOCUMENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** A client key: base64url, at least 32 characters (192 bits). */
export const CLIENT_KEY = /^[A-Za-z0-9_-]{32,128}$/;
/** A blob id: lower-case hex SHA-256. */
export const SHA256 = /^[0-9a-f]{64}$/;
/** A branch id (`main`, or the app's id of a branch) and a version id. */
export const BRANCH_ID = RECORD_ID;

const CreateDocumentSchema = z.strictObject({ document: z.unknown() });

interface BranchState {
  head: ManufaktureDocument;
  highWater: CounterTable;
  rev: number;
}

export function sha256(bytes: Buffer | string): Buffer {
  return createHash('sha256').update(bytes).digest();
}

function fail(
  status: number,
  code: string,
  message: string,
  extra: Partial<Pick<ReplyError, 'messages' | 'retryAfterMs'>> = {},
): ReplyError {
  return { ok: false, status, code, message, ...extra };
}

function describe(error: z.ZodError): string {
  const first = error.issues[0];
  if (first === undefined) return 'invalid message';
  return `${first.message} at ${first.path.map(String).join('.') || '(root)'}`;
}

function invalid(message: string): ReplyError {
  return fail(400, 'invalid-message', message, {
    messages: [{ type: 'error', code: 'invalid-message', message: message.slice(0, 2000) }],
  });
}

export interface SyncServiceOptions {
  readonly limits: Limits;
  /** The versions this server runs (default: this build's), for version-skew tests. */
  readonly versions?: Versions;
  readonly now?: () => number;
}

export class SyncService {
  private readonly store: SyncStore;
  private readonly limits: Limits;
  private readonly versions: Versions;
  private readonly now: () => number;
  private readonly branches = new Map<string, BranchState>();
  private readonly buckets = new Map<string, TokenBucket>();

  constructor(store: SyncStore, options: SyncServiceOptions) {
    this.store = store;
    this.limits = options.limits;
    this.versions = options.versions ?? CURRENT_VERSIONS;
    this.now = options.now ?? Date.now;
  }

  /** Whether the document has branch `branch` (main included), for the WebSocket route. */
  hasBranch(documentId: string, branch: string): boolean {
    return this.branch(documentId, branch) !== undefined;
  }

  /** `POST /documents`: a new document, its main branch at revision 0 holding `document`. */
  createDocument(body: unknown): Reply | { ok: true; status: 201; id: string; head: 0 } {
    const parsed = CreateDocumentSchema.safeParse(body);
    if (!parsed.success) return invalid(describe(parsed.error));
    const loaded = parseDocument(parsed.data.document);
    if (!loaded.ok) return fail(400, 'invalid-document', loaded.error.message.slice(0, 2000));
    const doc = loaded.value.document;
    if (!DOCUMENT_ID.test(doc.id)) {
      return fail(400, 'invalid-document', `Document id must match ${DOCUMENT_ID.source}`);
    }
    if (this.store.hasDocument(doc.id)) {
      return fail(409, 'exists', `Document ${doc.id} already exists`);
    }
    if (this.store.documentCount() >= this.limits.maxDocuments) {
      return fail(
        403,
        'too-many-documents',
        `This server holds at most ${this.limits.maxDocuments} documents`,
      );
    }
    const created = this.store.createDocument(
      { id: doc.id, name: doc.name.slice(0, 1000), createdAt: new Date(this.now()).toISOString() },
      doc,
      documentCounters(doc),
    );
    if (!created) return fail(409, 'exists', `Document ${doc.id} already exists`);
    return { ok: true, status: 201, id: doc.id, head: 0 };
  }

  listDocuments() {
    return this.store.listDocuments();
  }

  /**
   * `GET /documents/:id/snapshot`: the head document, its revision and the high-water mark of its
   * counters (a new client starts from these: `new SyncClient(document, rev, { highWater })`).
   */
  snapshot(
    documentId: string,
    branch: string = MAIN_BRANCH,
  ): { rev: number; document: ManufaktureDocument; highWater: CounterTable } | undefined {
    const b = this.branch(documentId, branch);
    return b === undefined ? undefined : { rev: b.rev, document: b.head, highWater: b.highWater };
  }

  /**
   * A client's `hello`: checks the versions, then claims the `clientId` for `key` (the first hello
   * for an id records the key's hash) or checks the key against the claim, so no other client can
   * submit as it, raise its floor or prune its rows.
   */
  hello(
    documentId: string,
    raw: unknown,
    key: string | undefined,
    branch: string = MAIN_BRANCH,
  ): Reply {
    const parsed = HelloSchema.safeParse(raw);
    if (!parsed.success) return invalid(describe(parsed.error));
    const skew = checkVersions(parsed.data, this.versions);
    if (skew !== undefined) return fail(400, skew.code, skew.message, { messages: [skew] });
    const b = this.branch(documentId, branch);
    if (b === undefined) return fail(404, 'not-found', 'No such document');
    const claim = this.claim(documentId, branch, parsed.data.clientId, key);
    if (claim !== undefined) return claim;
    return {
      ok: true,
      status: 200,
      messages: [{ type: 'welcome', ...this.versions, head: b.rev }],
    };
  }

  private claim(
    documentId: string,
    branch: string,
    clientId: string,
    key: string | undefined,
  ): ReplyError | undefined {
    if (key === undefined || !CLIENT_KEY.test(key)) {
      return fail(400, 'client-key', 'A client key (base64url, 32 to 128 characters) is required');
    }
    const hash = sha256(key);
    const client = this.store.client(documentId, branch, clientId);
    if (client === undefined) {
      if (this.store.clientCount(documentId, branch) >= this.limits.maxClientsPerDocument) {
        return fail(
          403,
          'too-many-clients',
          `A document has at most ${this.limits.maxClientsPerDocument} clients`,
        );
      }
      this.store.claimClient(documentId, branch, clientId, hash);
      return undefined;
    }
    if (!timingSafeEqual(hash, client.keyHash)) {
      return fail(403, 'client-key', 'This client id is claimed with another key');
    }
    return undefined;
  }

  /** A submit (ADR 0009 decision 2): checked whole first, then judged entry by entry. */
  submit(documentId: string, raw: unknown, sender: Sender, branch: string = MAIN_BRANCH): Reply {
    const parsed = SubmitSchema.safeParse(raw);
    if (!parsed.success) return invalid(describe(parsed.error));
    const { entries, floor } = parsed.data;
    const b = this.branch(documentId, branch);
    if (b === undefined) return fail(404, 'not-found', 'No such document');
    const clientId = entries[0]!.clientId;

    // The sender: a submit only ever speaks for the client its hello claimed.
    if ('boundClientId' in sender) {
      if (sender.boundClientId !== clientId) {
        return fail(
          403,
          'client-mismatch',
          'Entries must come from the client that sent the hello',
        );
      }
    } else {
      const client = this.store.client(documentId, branch, clientId);
      if (client === undefined)
        return fail(403, 'hello-first', 'Send a hello for this client first');
      if (sender.key === undefined || !CLIENT_KEY.test(sender.key)) {
        return fail(400, 'client-key', 'A client key is required');
      }
      if (!timingSafeEqual(sha256(sender.key), client.keyHash)) {
        return fail(403, 'client-key', 'This client id is claimed with another key');
      }
    }
    const client = this.store.client(documentId, branch, clientId)!;

    // Shape limits: format, entry size, created ids.
    let created = 0;
    for (const e of entries) {
      if (e.format > this.versions.format) {
        const skew = checkVersions(
          { protocol: this.versions.protocol, format: e.format },
          this.versions,
        )!;
        return fail(400, skew.code, skew.message, { messages: [skew] });
      }
      if (Buffer.byteLength(JSON.stringify(e)) > this.limits.maxEntryBytes) {
        return fail(
          413,
          'entry-too-large',
          `Entry ${e.clientSeq} is larger than ${this.limits.maxEntryBytes} bytes`,
        );
      }
      for (const ids of Object.values(e.created)) created += ids.length;
    }
    if (created > this.limits.maxCreatedIdsPerSubmit) {
      return fail(
        413,
        'too-many-ids',
        `A submit creates at most ${this.limits.maxCreatedIdsPerSubmit} ids`,
      );
    }
    const lowest = Math.min(...entries.map((e) => e.clientSeq));
    if (floor > lowest) {
      return invalid(`The floor ${floor} is above entry ${lowest} of the same submit`);
    }

    // Retention: a clientSeq or prevSeq below the stored floor that is no longer kept is a
    // protocol error; nothing is judged.
    // An entry with a recorded outcome is answered with it whatever its prevSeq names.
    const recorded = (seq: number) =>
      this.store.outcome(documentId, branch, clientId, seq) !== undefined;
    const kept = (seq: number) => seq >= client.floor || recorded(seq);
    const below: ServerMessage[] = [];
    for (const e of entries) {
      if (recorded(e.clientSeq)) continue;
      const stale = !kept(e.clientSeq)
        ? e.clientSeq
        : e.prevSeq !== undefined && !kept(e.prevSeq)
          ? e.prevSeq
          : undefined;
      if (stale !== undefined) {
        below.push({
          type: 'error',
          code: 'below-floor',
          clientSeq: e.clientSeq,
          message: `Entry ${e.clientSeq} names ${stale}, below the client's retention floor ${client.floor}`,
        });
      }
    }
    if (below.length > 0) {
      return fail(400, 'below-floor', 'An entry names a sequence below the retention floor', {
        messages: below,
      });
    }

    // Row and rate limits.
    const newFloor = Math.max(client.floor, floor);
    const rows =
      this.store.rowCount(documentId, branch, clientId, newFloor) +
      (client.latestAccepted !== undefined && client.latestAccepted < newFloor ? 1 : 0) +
      entries.length;
    if (rows > this.limits.maxRowsPerClient) {
      return fail(
        429,
        'too-many-rows',
        `A client keeps at most ${this.limits.maxRowsPerClient} entries in flight; resolve older ones first`,
      );
    }
    const bucket = this.bucket(documentId, clientId);
    const taken = bucket.take(entries.length);
    if (!taken.ok) {
      return fail(429, 'rate-limited', 'Too many entries; try again later', {
        retryAfterMs: taken.retryAfterMs,
      });
    }

    return this.judge(
      documentId,
      branch,
      b,
      clientId,
      client.latestAccepted,
      client.floor,
      newFloor,
      entries,
    );
  }

  private judge(
    documentId: string,
    branch: string,
    b: BranchState,
    clientId: string,
    latest: number | undefined,
    previousFloor: number,
    floor: number,
    entries: SubmitWrite['accepted'][number]['entry'][],
  ): Reply {
    const started = this.now();
    let head = b.head;
    let highWater = b.highWater;
    let rev = b.rev;
    let latestAccepted = latest;
    const fresh = new Map<number, Outcome>();
    const outcomes: { clientSeq: number; outcome: Outcome }[] = [];
    const accepted: PushedEntry[] = [];
    const snapshots: SubmitWrite['snapshots'][number][] = [];
    const messages: ServerMessage[] = [];
    let unknown = false;
    const answer = (clientSeq: number, o: Outcome): ServerMessage =>
      o.kind === 'accepted'
        ? { type: 'ack', clientSeq, rev: o.rev }
        : { type: 'refuse', clientSeq, error: o.error, headRev: rev };

    for (const [i, entry] of entries.entries()) {
      // At least one entry is judged, so a client always makes progress.
      if (i > 0 && this.now() - started > this.limits.validationBudgetMs) break;
      const j = judgeEntry(
        {
          head,
          highWater,
          outcome: (c, s) =>
            c === clientId && fresh.has(s)
              ? fresh.get(s)
              : this.store.outcome(documentId, branch, c, s),
        },
        entry,
      );
      switch (j.kind) {
        case 'recorded':
          messages.push(answer(entry.clientSeq, j.outcome));
          break;
        case 'predecessor-unknown':
          unknown = true;
          messages.push({ type: 'predecessor-unknown', clientSeq: entry.clientSeq });
          break;
        case 'refused': {
          const o: Outcome = { kind: 'refused', error: j.error };
          fresh.set(entry.clientSeq, o);
          outcomes.push({ clientSeq: entry.clientSeq, outcome: o });
          messages.push(answer(entry.clientSeq, o));
          break;
        }
        case 'accepted': {
          rev += 1;
          head = j.document;
          highWater = j.highWater;
          accepted.push({ rev, entry });
          if (rev % CHECKPOINT_EVERY === 0) snapshots.push({ rev, document: head, highWater });
          const o: Outcome = { kind: 'accepted', rev };
          fresh.set(entry.clientSeq, o);
          outcomes.push({ clientSeq: entry.clientSeq, outcome: o });
          latestAccepted = Math.max(latestAccepted ?? 0, entry.clientSeq);
          messages.push(answer(entry.clientSeq, o));
          break;
        }
      }
    }

    // One transaction for everything; memory follows only once it is committed. A submit that
    // only got recorded outcomes and retryable answers, and does not raise the floor, writes
    // nothing.
    if (outcomes.length > 0 || floor !== previousFloor)
      this.store.commitSubmit({
        documentId,
        branch,
        clientId,
        accepted,
        outcomes,
        latestAccepted,
        floor,
        ...(accepted.length > 0 && { head: { rev, highWater } }),
        snapshots,
      });
    b.head = head;
    b.highWater = highWater;
    b.rev = rev;
    return {
      ok: true,
      status: unknown ? 409 : 200,
      messages,
      ...(accepted.length > 0 && { push: { type: 'push', entries: accepted } }),
    };
  }

  /** A pull: accepted entries after `since`, at most `MAX_ENTRIES_PER_MESSAGE`. */
  pull(documentId: string, since: number, branch: string = MAIN_BRANCH): Reply {
    const b = this.branch(documentId, branch);
    if (b === undefined) return fail(404, 'not-found', 'No such document');
    const entries =
      since >= b.rev ? [] : this.store.entries(documentId, branch, since, MAX_ENTRIES_PER_MESSAGE);
    return { ok: true, status: 200, messages: [{ type: 'push', entries }] };
  }

  /** `PUT /blobs/:sha256`: the bytes must hash to the name. */
  putBlob(name: string, bytes: Buffer): ReplyError | { ok: true; status: 200 | 201 } {
    if (!SHA256.test(name))
      return fail(400, 'invalid-hash', 'A blob is named by its lower-case hex SHA-256');
    if (bytes.length === 0) return fail(400, 'empty-blob', 'A blob has at least one byte');
    if (bytes.length > this.limits.maxBlobBytes) {
      return fail(413, 'too-large', `A blob is at most ${this.limits.maxBlobBytes} bytes`);
    }
    if (sha256(bytes).toString('hex') !== name) {
      return fail(400, 'hash-mismatch', 'The bytes do not hash to the blob name');
    }
    if (this.store.hasBlob(name)) return { ok: true, status: 200 };
    if (this.store.blobBytes() + bytes.length > this.limits.maxBlobTotalBytes) {
      return fail(507, 'storage-full', 'The blob store is full');
    }
    return { ok: true, status: this.store.putBlob(name, bytes) ? 201 : 200 };
  }

  getBlob(name: string): Buffer | undefined {
    return SHA256.test(name) ? this.store.getBlob(name) : undefined;
  }

  /** Whether a document exists (for the WebSocket route, before the upgrade). */
  hasDocument(documentId: string): boolean {
    return DOCUMENT_ID.test(documentId) && this.store.hasDocument(documentId);
  }

  private bucket(documentId: string, clientId: string): TokenBucket {
    const key = `${documentId}\u0000${clientId}`;
    let b = this.buckets.get(key);
    if (b === undefined) {
      this.buckets.set(key, (b = new TokenBucket(this.limits.entriesPerMinute, this.now)));
    }
    return b;
  }

  /** The cached head of a document's branch, loaded (snapshot plus replay) on first use. */
  private branch(documentId: string, branch: string = MAIN_BRANCH): BranchState | undefined {
    if (!DOCUMENT_ID.test(documentId) || !BRANCH_ID.test(branch)) return undefined;
    const key = `${documentId}\u0000${branch}`;
    const cached = this.branches.get(key);
    if (cached !== undefined) return cached;
    const loaded = this.store.loadBranch(documentId, branch);
    if (loaded === undefined) return undefined;
    let head = loaded.snapshot.document;
    let rev = loaded.snapshot.rev;
    for (const p of loaded.after) {
      if (p.rev !== rev + 1)
        throw new Error(`Document ${documentId}: revision ${rev + 1} is missing`);
      const command = migrateCommand(p.entry.command, p.entry.format);
      const applied = command.ok ? applyCommand(head, command.value) : command;
      if (!applied.ok) {
        throw new Error(
          `Document ${documentId}: revision ${p.rev} does not apply: ${applied.error.message}`,
        );
      }
      head = applied.value.document;
      rev = p.rev;
    }
    if (rev !== loaded.head)
      throw new Error(`Document ${documentId}: the log ends at ${rev}, not ${loaded.head}`);
    const state: BranchState = { head, highWater: loaded.highWater, rev };
    this.branches.set(key, state);
    return state;
  }

  // -----------------------------------------------------------------------------------------
  // Versions and branches (T7.1e)

  /** `GET /documents/:id/versions`: every branch's versions, in the order they were stored. */
  listVersions(documentId: string): Reply | { ok: true; versions: ServerVersion[] } {
    if (!this.hasDocument(documentId)) return fail(404, 'not-found', 'No such document');
    return { ok: true, versions: this.store.listVersions(documentId) };
  }

  /**
   * `POST /documents/:id/versions`: a version naming revision `rev` of branch `branch`. Its
   * document is stored as a snapshot of that revision, so reading it back replays nothing. A
   * resend of a stored version is answered as such (200); another record under its id is a
   * conflict (409). Versions are never changed or deleted.
   */
  createVersion(documentId: string, body: unknown): Reply | RecordReply<ServerVersion> {
    if (!this.hasDocument(documentId)) return fail(404, 'not-found', 'No such document');
    const parsed = CreateVersionSchema.safeParse(body);
    if (!parsed.success) return fail(400, 'invalid-version', 'The version record is invalid');
    const v = parsed.data.version;
    const stored = this.store.version(documentId, v.id);
    if (stored !== undefined) {
      return sameRecord(stored, v)
        ? { ok: true, status: 200, record: stored }
        : fail(409, 'version-exists', 'Another version has this id');
    }
    const b = this.branch(documentId, v.branch);
    if (b === undefined)
      return fail(400, 'no-branch', 'The version names a branch that is not here');
    if (v.rev > b.rev) return fail(400, 'no-revision', 'The version names a revision not here yet');
    if (this.store.versionCount(documentId) >= this.limits.maxVersionsPerDocument) {
      return fail(
        403,
        'too-many-versions',
        `A document holds at most ${this.limits.maxVersionsPerDocument} versions`,
      );
    }
    const at = this.documentAt(documentId, v.branch, v.rev);
    if (!this.store.insertVersion(documentId, v, at)) {
      // Stored meanwhile: the same record (two identical uploads) is a resend, not a conflict.
      const now = this.store.version(documentId, v.id);
      return now !== undefined && sameRecord(now, v)
        ? { ok: true, status: 200, record: now }
        : fail(409, 'version-exists', 'Another version has this id');
    }
    return { ok: true, status: 201, record: v };
  }

  /** `GET /documents/:id/versions/:versionId`: the version and its document. */
  readVersion(
    documentId: string,
    versionId: string,
  ): Reply | { ok: true; version: ServerVersion; document: ManufaktureDocument } {
    if (!this.hasDocument(documentId) || !RECORD_ID.test(versionId)) {
      return fail(404, 'not-found', 'No such version');
    }
    const version = this.store.version(documentId, versionId);
    if (version === undefined) return fail(404, 'not-found', 'No such version');
    return {
      ok: true,
      version,
      document: this.documentAt(documentId, version.branch, version.rev).document,
    };
  }

  /** `GET /documents/:id/branches`: the branch records (main has none). */
  listBranches(documentId: string): Reply | { ok: true; branches: ServerBranch[] } {
    if (!this.hasDocument(documentId)) return fail(404, 'not-found', 'No such document');
    return { ok: true, branches: this.store.listBranches(documentId) };
  }

  /**
   * `POST /documents/:id/branches`: a new branch log, at revision 0 holding the document of the
   * version it is made from, with its branch's high-water mark as of that revision. A resend is
   * answered as such (200); another record under its id is a conflict (409).
   */
  createBranch(documentId: string, body: unknown): Reply | RecordReply<ServerBranch> {
    if (!this.hasDocument(documentId)) return fail(404, 'not-found', 'No such document');
    const parsed = CreateBranchSchema.safeParse(body);
    if (!parsed.success) return fail(400, 'invalid-branch', 'The branch record is invalid');
    const r = parsed.data.branch;
    const stored = this.store.branchRecord(documentId, r.id);
    if (stored !== undefined) {
      return sameRecord(stored, r)
        ? { ok: true, status: 200, record: stored }
        : fail(409, 'branch-exists', 'Another branch has this id');
    }
    const from = this.store.version(documentId, r.fromVersion);
    if (from === undefined) {
      return fail(400, 'no-version', 'The branch names a version that is not here');
    }
    if (this.store.branchCount(documentId) >= this.limits.maxBranchesPerDocument) {
      return fail(
        403,
        'too-many-branches',
        `A document has at most ${this.limits.maxBranchesPerDocument} branches`,
      );
    }
    // The version's document, with the high-water mark of its branch as of that revision (deleted
    // parts' counters included), so the new log never hands out an id the old one had used.
    const at = this.documentAt(documentId, from.branch, from.rev);
    if (!this.store.createBranch(documentId, r, at.document, at.highWater)) {
      const now = this.store.branchRecord(documentId, r.id);
      return now !== undefined && sameRecord(now, r)
        ? { ok: true, status: 200, record: now }
        : fail(409, 'branch-exists', 'Another branch has this id');
    }
    return { ok: true, status: 201, record: r };
  }

  /**
   * Branch `branch`'s document at revision `rev` (at most its head): the newest snapshot at or
   * below it, then the logged entries after it, replayed.
   */
  private documentAt(documentId: string, branch: string, rev: number): StoredSnapshot {
    const b = this.branch(documentId, branch);
    if (b === undefined) throw new Error(`Document ${documentId} has no branch ${branch}`);
    if (rev === b.rev) return { rev, document: b.head, highWater: b.highWater };
    const snap = this.store.snapshotAt(documentId, branch, rev);
    if (snap === undefined) throw new Error(`Branch ${documentId}/${branch} has no snapshot`);
    let head = snap.document;
    let at = snap.rev;
    let highWater = snap.highWater;
    while (at < rev) {
      const batch = this.store.entries(documentId, branch, at, Math.min(rev - at, 10_000));
      if (batch.length === 0) throw new Error(`Branch ${documentId}/${branch} ends before ${rev}`);
      for (const p of batch) {
        if (p.rev !== at + 1)
          throw new Error(`Branch ${documentId}/${branch}: ${at + 1} is missing`);
        const command = migrateCommand(p.entry.command, p.entry.format);
        const applied = command.ok ? applyCommand(head, command.value) : command;
        if (!applied.ok) {
          throw new Error(
            `Branch ${documentId}/${branch}: revision ${p.rev} does not apply: ${applied.error.message}`,
          );
        }
        head = applied.value.document;
        highWater = maxCounters(highWater, documentCounters(head));
        at = p.rev;
      }
    }
    return { rev, document: head, highWater };
  }
}
