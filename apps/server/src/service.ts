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
  PutBundleSchema,
  RECORD_ID,
  MAX_ENTRIES_PER_MESSAGE,
  ReviewChangeSchema,
  SubmitSchema,
  checkVersions,
  judgeEntry,
  type Outcome,
  type Provenance,
  type PushMessage,
  type PushedEntry,
  type ReviewState,
  type ServerBranch,
  type ServerMessage,
  type ServerVersion,
  type Versions,
  sameBranch,
  sameRecord,
} from '@manufakture/sync';
import { z } from 'zod';
import { TokenBucket, type Limits } from './limits';
import { OWNER, type Principal } from './tokens';
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

/** How many review bundles the server keeps per branch (the newest). */
export const BUNDLES_KEPT = 8;

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
  /** When it was last used (`now()`), for idle eviction. */
  used: number;
}

/** An entry's size as the store keeps it (JSON), for the agent log quota. */
function entryBytes(entry: unknown): number {
  return Buffer.byteLength(JSON.stringify(entry));
}

/** A checkpoint snapshot's size as the store keeps it (document and high-water mark, as JSON). */
function snapshotBytes(s: { document: ManufaktureDocument; highWater: CounterTable }): number {
  return (
    Buffer.byteLength(JSON.stringify(s.document)) + Buffer.byteLength(JSON.stringify(s.highWater))
  );
}

/** How many entries one read of a branch's log takes when its stored size is counted. */
const LOG_COUNT_PAGE = 1_000;

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

/** A schema key as the path shows it; anything else (a record's key, chosen by the sender) is `*`. */
const SCHEMA_KEY = /^[A-Za-z]{1,40}$/;

/**
 * Where a message fails its schema, without quoting it: zod's own messages can repeat what was
 * sent (an unrecognized key), so the answer names the issue's kind and its path, with indices and
 * schema field names kept and any other key replaced by `*`.
 */
function describe(error: z.ZodError): string {
  const first = error.issues[0];
  if (first === undefined) return 'invalid message';
  const path = first.path
    .map((p) => (typeof p === 'number' || (typeof p === 'string' && SCHEMA_KEY.test(p)) ? p : '*'))
    .join('.');
  return `Invalid message (${first.code}) at ${path || '(root)'}`;
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
  /**
   * Milliseconds a cached branch head or rate bucket may go unused before it is dropped from
   * memory (default `DEFAULT_IDLE_EVICT_MS`). The store is the truth, so an evicted head is only
   * loaded again (snapshot plus replay) on its next use.
   */
  readonly idleEvictMs?: number;
}

/** How long an unused document's head stays in memory by default: ten minutes. */
export const DEFAULT_IDLE_EVICT_MS = 10 * 60_000;

export class SyncService {
  private readonly store: SyncStore;
  private readonly limits: Limits;
  private readonly versions: Versions;
  private readonly now: () => number;
  private readonly idleEvictMs: number;
  private readonly branches = new Map<string, BranchState>();
  private readonly buckets = new Map<string, { bucket: TokenBucket; used: number }>();
  /**
   * The client holding each agent branch's log, when it was last heard, and the agent token it
   * speaks for (null: the owner's) (T8.4b).
   */
  private readonly writers = new Map<
    string,
    { clientId: string; at: number; tokenId: string | null }
  >();
  /**
   * Stored log bytes per branch (`documentId\u0000branch`), for the agent log quota
   * (`maxAgentLogBytes`): the agent token that made the branch (null: none) and, once counted for
   * that token's quota, the bytes of its entries and checkpoint snapshots. Counted from the store on
   * first use and kept up to date as submits commit, so it always matches what is stored; a
   * restart only means counting again.
   */
  private readonly logUse = new Map<
    string,
    { tokenId: string | null; bytes: number | undefined; used: number }
  >();
  private lastSweep: number;
  /**
   * Agent tokens revoked while this process runs. The transport checks the token once, when a
   * request arrives; a request already past that check when its token is revoked (its body still
   * arriving, say) is refused here instead.
   */
  private readonly revokedTokens = new Set<string>();

  constructor(store: SyncStore, options: SyncServiceOptions) {
    this.store = store;
    this.limits = options.limits;
    this.versions = options.versions ?? CURRENT_VERSIONS;
    this.now = options.now ?? Date.now;
    this.idleEvictMs = options.idleEvictMs ?? DEFAULT_IDLE_EVICT_MS;
    this.lastSweep = this.now();
  }

  /** How many branch heads and rate buckets are held in memory (tests). */
  cached(): { branches: number; buckets: number } {
    return { branches: this.branches.size, buckets: this.buckets.size };
  }

  /**
   * Drops branch heads and rate buckets unused for `idleEvictMs`, at most once per a quarter of
   * that, so memory follows the documents in use rather than every document ever opened. A bucket
   * idle that long is full again anyway (it refills in a minute), so dropping it changes nothing.
   */
  private evictIdle(t: number): void {
    if (t - this.lastSweep < this.idleEvictMs / 4) return;
    this.lastSweep = t;
    for (const [key, b] of this.branches) {
      if (t - b.used >= this.idleEvictMs) this.branches.delete(key);
    }
    for (const [key, b] of this.buckets) {
      if (t - b.used >= this.idleEvictMs) this.buckets.delete(key);
    }
    for (const [key, w] of this.writers) {
      if (t - w.at >= this.limits.writerLeaseMs) this.writers.delete(key);
    }
    for (const [key, u] of this.logUse) {
      if (t - u.used >= this.idleEvictMs) this.logUse.delete(key);
    }
  }

  // -----------------------------------------------------------------------------------------
  // Authorization (ADR 0016 decision 12, T8.4b). The owner's token may do everything; an agent
  // token reads the documents it is scoped to, makes agent branches of them, and writes only the
  // agent branches it made, never one approved or rejected and never main. Every check reads the
  // branch's stored record (its provenance and the token that made it), never what the request
  // says about it.

  /** Whether `p` may read document `documentId` (anything in it). */
  readCheck(p: Principal, documentId: string): ReplyError | undefined {
    const revoked = this.revokedCheck(p);
    if (revoked !== undefined) return revoked;
    if (p.kind === 'owner' || p.documents.has(documentId)) return undefined;
    return fail(403, 'out-of-scope', 'This token is not scoped to that document');
  }

  /** A 401 for an agent token revoked since its request was let in (`revoked`). */
  revokedCheck(p: Principal): ReplyError | undefined {
    if (p.kind === 'agent' && this.revokedTokens.has(p.tokenId)) {
      return fail(401, 'unauthorized', 'The token was revoked');
    }
    return undefined;
  }

  /**
   * An agent token adds a review bundle or a version to its branch only while the branch is
   * open, so the evidence a reviewer is looking at never changes under them. The session stores
   * its bundle before it submits.
   */
  private openCheck(p: Principal, documentId: string, branch: string): ReplyError | undefined {
    if (p.kind !== 'agent') return undefined;
    const review = this.store.branchMeta(documentId, branch)?.record.provenance?.review;
    if (review === 'open') return undefined;
    return fail(
      409,
      'branch-not-open',
      `The branch is ${review ?? 'gone'}: move it back to open before writing`,
    );
  }

  /**
   * Whether `p` may write branch `branch` of `documentId`: its log (hello, submits), its bundle,
   * its deletion. For an agent token: an agent branch (by its stored provenance) that this token
   * made, not approved or rejected; never main.
   */
  writeCheck(p: Principal, documentId: string, branch: string): ReplyError | undefined {
    if (p.kind === 'owner') return undefined;
    // readCheck refuses a revoked token first.
    const read = this.readCheck(p, documentId);
    if (read !== undefined) return read;
    if (branch === MAIN_BRANCH) {
      return fail(403, 'main-refused', 'An agent token never writes the main branch');
    }
    const meta = this.store.branchMeta(documentId, branch);
    if (meta === undefined) return fail(404, 'not-found', 'No such branch');
    const review = meta.record.provenance?.review;
    if (review === undefined) {
      return fail(403, 'not-agent-branch', 'An agent token writes only agent branches');
    }
    if (meta.createdBy !== p.tokenId) {
      return fail(403, 'not-own-branch', 'An agent token writes only the agent branches it made');
    }
    if (review === 'approved' || review === 'rejected') {
      return fail(403, 'branch-closed', `The branch was ${review}: it takes no more work`);
    }
    return undefined;
  }

  /**
   * One writer per agent branch: `clientId` takes (or keeps) the branch's log unless another
   * client was heard on it within `writerLeaseMs`. Person's branches and main are not leased.
   */
  private lease(
    documentId: string,
    branch: string,
    clientId: string,
    principal: Principal,
    take = true,
  ): ReplyError | undefined {
    if (branch === MAIN_BRANCH) return undefined;
    if (this.store.branchMeta(documentId, branch)?.record.provenance === undefined)
      return undefined;
    const key = `${documentId}\u0000${branch}`;
    const t = this.now();
    const held = this.writers.get(key);
    if (
      held !== undefined &&
      held.clientId !== clientId &&
      t - held.at < this.limits.writerLeaseMs
    ) {
      return fail(409, 'branch-busy', 'Another client is writing this agent branch');
    }
    if (take) {
      this.writers.set(key, {
        clientId,
        at: t,
        tokenId: principal.kind === 'agent' ? principal.tokenId : null,
      });
    }
    return undefined;
  }

  /**
   * Ends every lease agent token `tokenId` holds (it was revoked), so the owner, or a new token,
   * can take its branches at once.
   */
  dropLeases(tokenId: string): void {
    for (const [key, w] of this.writers) if (w.tokenId === tokenId) this.writers.delete(key);
  }

  /**
   * Agent token `tokenId` was revoked: its requests still in flight are refused from now on
   * (`revokedCheck`), its leases end (`dropLeases`), and the start versions it made that no branch
   * starts from any more go, so nothing it made outlives it without a branch. How many versions
   * went.
   */
  revoked(tokenId: string): number {
    this.revokedTokens.add(tokenId);
    this.dropLeases(tokenId);
    return this.store.sweepStartVersions(tokenId);
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
    if (!loaded.ok) {
      return fail(400, 'invalid-document', `The document is invalid (${loaded.error.code})`);
    }
    const doc = loaded.value.document;
    if (!DOCUMENT_ID.test(doc.id)) {
      return fail(400, 'invalid-document', `Document id must match ${DOCUMENT_ID.source}`);
    }
    if (this.store.hasDocument(doc.id)) {
      return fail(409, 'exists', 'The document already exists');
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
    if (!created) return fail(409, 'exists', 'The document already exists');
    return { ok: true, status: 201, id: doc.id, head: 0 };
  }

  /** The documents `p` may read. */
  listDocuments(p: Principal = OWNER) {
    const all = this.store.listDocuments();
    return p.kind === 'owner' ? all : all.filter((d) => p.documents.has(d.id));
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
    principal: Principal = OWNER,
  ): Reply {
    const parsed = HelloSchema.safeParse(raw);
    if (!parsed.success) return invalid(describe(parsed.error));
    const skew = checkVersions(parsed.data, this.versions);
    if (skew !== undefined) return fail(400, skew.code, skew.message, { messages: [skew] });
    const b = this.branch(documentId, branch);
    if (b === undefined) return fail(404, 'not-found', 'No such document');
    // A hello is how a client starts writing: an agent token's only on a branch it may write.
    const denied = this.writeCheck(principal, documentId, branch);
    if (denied !== undefined) return denied;
    // A busy branch is refused before the client is claimed; the lease is taken only once the
    // client has proven its key.
    const busy = this.lease(documentId, branch, parsed.data.clientId, principal, false);
    if (busy !== undefined) return busy;
    const claim = this.claim(documentId, branch, parsed.data.clientId, key);
    if (claim !== undefined) return claim;
    this.lease(documentId, branch, parsed.data.clientId, principal);
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

  /**
   * `POST /documents/:id/release?branch=`: a client lets go of an agent branch's log (its session
   * closed), so another may take it before the lease runs out. Only the client holding it, proven
   * by its key, can let it go.
   */
  release(
    documentId: string,
    raw: unknown,
    key: string | undefined,
    branch: string,
    principal: Principal = OWNER,
  ): ReplyError | { ok: true; status: 204 } {
    const clientId = (raw as { clientId?: unknown } | null)?.clientId;
    if (typeof clientId !== 'string' || clientId.length === 0 || clientId.length > 128) {
      return fail(400, 'invalid-request', 'A release names its client');
    }
    if (this.branch(documentId, branch) === undefined) {
      return fail(404, 'not-found', 'No such document');
    }
    const denied = this.writeCheck(principal, documentId, branch);
    if (denied !== undefined) return denied;
    const client = this.store.client(documentId, branch, clientId);
    if (client === undefined || key === undefined || !CLIENT_KEY.test(key)) {
      return fail(403, 'client-key', 'This client id is claimed with another key');
    }
    if (!timingSafeEqual(sha256(key), client.keyHash)) {
      return fail(403, 'client-key', 'This client id is claimed with another key');
    }
    const lease = `${documentId}\u0000${branch}`;
    if (this.writers.get(lease)?.clientId === clientId) this.writers.delete(lease);
    return { ok: true, status: 204 };
  }

  /** A submit (ADR 0009 decision 2): checked whole first, then judged entry by entry. */
  submit(
    documentId: string,
    raw: unknown,
    sender: Sender,
    branch: string = MAIN_BRANCH,
    principal: Principal = OWNER,
  ): Reply {
    const parsed = SubmitSchema.safeParse(raw);
    if (!parsed.success) return invalid(describe(parsed.error));
    const { entries, floor } = parsed.data;
    const b = this.branch(documentId, branch);
    if (b === undefined) return fail(404, 'not-found', 'No such document');
    // Checked on every submit, not only at the hello: a reviewer may have closed the branch since.
    const denied = this.writeCheck(principal, documentId, branch);
    if (denied !== undefined) return denied;
    // An agent token writes only an open branch: the session moves a submitted branch, or one
    // with changes requested, back to open (`setReview`) before it writes, so the review state on
    // the server always says whether work landed after a submit.
    if (principal.kind === 'agent') {
      const review = this.store.branchMeta(documentId, branch)?.record.provenance?.review;
      if (review !== 'open') {
        return fail(
          409,
          'branch-not-open',
          `The branch is ${review ?? 'gone'}: move it back to open before writing`,
        );
      }
    }
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
    const busy = this.lease(documentId, branch, clientId, principal);
    if (busy !== undefined) return busy;

    // Shape limits: format and created ids. An entry over the size limit is refused on its own
    // (`judgeEntry`), so the entries after it are still judged.
    let created = 0;
    for (const e of entries) {
      if (e.format > this.versions.format) {
        const skew = checkVersions(
          { protocol: this.versions.protocol, format: e.format },
          this.versions,
        )!;
        return fail(400, skew.code, skew.message, { messages: [skew] });
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
    // An agent token's log quota, before the rate bucket so a refused submit costs no tokens:
    // here on the entries alone, and again while judging, with the snapshots they make. Entries
    // with a recorded outcome are answered from it and store nothing, so a resend of only those
    // (to get its answers back) is never refused.
    let logRoom: number | undefined;
    if (principal.kind === 'agent') {
      let incoming = 0;
      for (const e of entries) if (!recorded(e.clientSeq)) incoming += entryBytes(e);
      if (incoming > 0) {
        logRoom = this.limits.maxAgentLogBytes - this.agentLogUsed(documentId, principal.tokenId);
        if (incoming > logRoom) return this.logQuotaError();
      }
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
      logRoom,
    );
  }

  /**
   * Judges a submit's entries and commits the outcome. `logRoom` (an agent token's submit): the
   * bytes of log it may still store; a submit whose accepted entries and checkpoint snapshots
   * need more is refused whole, before anything is written.
   */
  private judge(
    documentId: string,
    branch: string,
    b: BranchState,
    clientId: string,
    latest: number | undefined,
    previousFloor: number,
    floor: number,
    entries: SubmitWrite['accepted'][number]['entry'][],
    logRoom?: number,
  ): Reply {
    const started = this.now();
    // Stored log bytes this submit adds, measured when a quota applies or the branch's count is
    // cached (an agent's branch: the owner's entries there count against its quota too).
    const use = this.logUse.get(`${documentId}\u0000${branch}`);
    const measure = logRoom !== undefined || use?.bytes !== undefined;
    let added = 0;
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
          maxEntryBytes: this.limits.maxEntryBytes,
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
          if (measure) {
            added += entryBytes(entry);
            if (rev % CHECKPOINT_EVERY === 0) added += snapshotBytes(snapshots.at(-1)!);
            // Nothing is written yet: stop at the first excess, before measuring more snapshots.
            if (logRoom !== undefined && added > logRoom) return this.logQuotaError();
          }
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
    if (use?.bytes !== undefined) use.bytes += added;
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
      since >= b.rev
        ? []
        : this.store.entries(
            documentId,
            branch,
            since,
            MAX_ENTRIES_PER_MESSAGE,
            this.limits.maxPullBytes,
          );
    return { ok: true, status: 200, messages: [{ type: 'push', entries }] };
  }

  /**
   * `PUT /blobs/:sha256`: the bytes must hash to the name. An agent token stores at most
   * `maxAgentBlobBytes` of blobs (those it was the first to store).
   */
  putBlob(
    name: string,
    bytes: Buffer,
    principal: Principal = OWNER,
  ): ReplyError | { ok: true; status: 200 | 201 } {
    const revoked = this.revokedCheck(principal);
    if (revoked !== undefined) return revoked;
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
    const tokenId = principal.kind === 'agent' ? principal.tokenId : null;
    if (
      tokenId !== null &&
      this.store.agentBlobBytes(tokenId) + bytes.length > this.limits.maxAgentBlobBytes
    ) {
      return fail(
        403,
        'blob-quota',
        `An agent token stores at most ${this.limits.maxAgentBlobBytes} bytes of blobs`,
      );
    }
    if (this.store.blobBytes() + bytes.length > this.limits.maxBlobTotalBytes) {
      return fail(507, 'storage-full', 'The blob store is full');
    }
    return { ok: true, status: this.store.putBlob(name, bytes, tokenId) ? 201 : 200 };
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
    const t = this.now();
    this.evictIdle(t);
    let b = this.buckets.get(key);
    if (b === undefined) {
      b = { bucket: new TokenBucket(this.limits.entriesPerMinute, this.now), used: t };
      this.buckets.set(key, b);
    }
    b.used = t;
    return b.bucket;
  }

  /** The cached head of a document's branch, loaded (snapshot plus replay) on first use. */
  private branch(documentId: string, branch: string = MAIN_BRANCH): BranchState | undefined {
    if (!DOCUMENT_ID.test(documentId) || !BRANCH_ID.test(branch)) return undefined;
    const key = `${documentId}\u0000${branch}`;
    const t = this.now();
    this.evictIdle(t);
    const cached = this.branches.get(key);
    if (cached !== undefined) {
      cached.used = t;
      return cached;
    }
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
    const state: BranchState = { head, highWater: loaded.highWater, rev, used: t };
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
   * conflict (409). A stored version is never changed; it is deleted only as `deleteBranch` and
   * `deleteVersion` say. An agent token adds one only to an open branch it made (`openCheck`).
   */
  createVersion(
    documentId: string,
    body: unknown,
    principal: Principal = OWNER,
  ): Reply | RecordReply<ServerVersion> {
    if (!this.hasDocument(documentId)) return fail(404, 'not-found', 'No such document');
    const parsed = CreateVersionSchema.safeParse(body);
    if (!parsed.success) return fail(400, 'invalid-version', 'The version record is invalid');
    const v = parsed.data.version;
    const revoked = this.revokedCheck(principal);
    if (revoked !== undefined) return revoked;
    if (v.createdBy !== undefined) {
      return fail(
        400,
        'invalid-version',
        'The server records who made a version; a client never says',
      );
    }
    // A version only names a revision. An agent token names only its own branches' revisions:
    // never main's (a session's start version is stored with its branch, `createBranch`).
    if (principal.kind === 'agent' && v.branch === MAIN_BRANCH) {
      const denied = this.readCheck(principal, documentId);
      return (
        denied ?? fail(403, 'main-refused', 'An agent token adds no version to the main branch')
      );
    }
    if (v.branch !== MAIN_BRANCH) {
      const denied = this.writeCheck(principal, documentId, v.branch);
      if (denied !== undefined) return denied;
    }
    const stored = this.store.version(documentId, v.id);
    if (stored === undefined && v.branch !== MAIN_BRANCH) {
      const closed = this.openCheck(principal, documentId, v.branch);
      if (closed !== undefined) return closed;
    }
    if (stored !== undefined) {
      return sameRecord(stored, v)
        ? { ok: true, status: 200, record: stored }
        : fail(409, 'version-exists', 'Another version has this id');
    }
    const b = this.branch(documentId, v.branch);
    if (b === undefined)
      return fail(400, 'no-branch', 'The version names a branch that is not here');
    if (v.rev > b.rev) return fail(400, 'no-revision', 'The version names a revision not here yet');
    const quota = this.versionQuota(documentId, principal);
    if (quota !== undefined) return quota;
    const at = this.documentAt(documentId, v.branch, v.rev);
    const createdBy = principal.kind === 'agent' ? principal.tokenId : null;
    if (!this.store.insertVersion(documentId, v, at, createdBy)) {
      // Stored meanwhile: the same record (two identical uploads) is a resend, not a conflict.
      const now = this.store.version(documentId, v.id);
      return now !== undefined && sameRecord(now, v)
        ? { ok: true, status: 200, record: now }
        : fail(409, 'version-exists', 'Another version has this id');
    }
    return {
      ok: true,
      status: 201,
      record: createdBy === null ? v : { ...v, createdBy },
    };
  }

  /**
   * The log an agent token has stored in a document: the entries and checkpoint snapshots of
   * every branch of it the token made (`maxAgentLogBytes`), open or closed, whoever wrote them.
   * Counted from the store, so a fresh client id (the rate bucket is per client) or a restart does
   * not reset it.
   */
  private agentLogUsed(documentId: string, tokenId: string): number {
    let used = 0;
    for (const r of this.store.listBranches(documentId)) {
      used += this.agentLogBytes(documentId, r.id, tokenId);
    }
    return used;
  }

  private logQuotaError(): ReplyError {
    return fail(
      403,
      'log-quota',
      `An agent token stores at most ${this.limits.maxAgentLogBytes} bytes of log in a document; the owner deletes its closed branches to make room`,
    );
  }

  /**
   * The stored log bytes of a branch if agent token `tokenId` made it; 0 otherwise. Only the
   * token's own branches are counted (and cached); another's is only noted as not its.
   */
  private agentLogBytes(documentId: string, branch: string, tokenId: string): number {
    const key = `${documentId}\u0000${branch}`;
    const t = this.now();
    let use = this.logUse.get(key);
    if (use === undefined) {
      use = {
        tokenId: this.store.branchMeta(documentId, branch)?.createdBy ?? null,
        bytes: undefined,
        used: t,
      };
      this.logUse.set(key, use);
    }
    use.used = t;
    if (use.tokenId !== tokenId) return 0;
    use.bytes ??= this.storedLogBytes(documentId, branch);
    return use.bytes;
  }

  /**
   * What a branch's log takes in the store: every entry, and every checkpoint snapshot after the
   * one it started with (that one is the version it started from, not the writer's).
   */
  private storedLogBytes(documentId: string, branch: string): number {
    let bytes = 0;
    let head = 0;
    for (;;) {
      const page = this.store.entries(documentId, branch, head, LOG_COUNT_PAGE);
      if (page.length === 0) break;
      for (const p of page) bytes += entryBytes(p.entry);
      head = page[page.length - 1]!.rev;
    }
    for (let rev = CHECKPOINT_EVERY; rev <= head; rev += CHECKPOINT_EVERY) {
      const snapshot = this.store.snapshotAt(documentId, branch, rev);
      if (snapshot?.rev === rev) bytes += snapshotBytes(snapshot);
    }
    return bytes;
  }

  /** Whether one more version fits: the document's limit, and an agent token's own. */
  private versionQuota(documentId: string, principal: Principal): ReplyError | undefined {
    if (this.store.versionCount(documentId) >= this.limits.maxVersionsPerDocument) {
      return fail(
        403,
        'too-many-versions',
        `A document holds at most ${this.limits.maxVersionsPerDocument} versions`,
      );
    }
    if (
      principal.kind === 'agent' &&
      this.store.agentVersionCount(documentId, principal.tokenId) >=
        this.limits.maxAgentVersionsPerToken
    ) {
      return fail(
        403,
        'version-quota',
        `An agent token makes at most ${this.limits.maxAgentVersionsPerToken} versions of a document`,
      );
    }
    return undefined;
  }

  /**
   * `DELETE /documents/:id/versions/:versionId`, the owner's alone: a version an agent token made,
   * or a start version (the owner's one an agent's branch delete left behind included), that no
   * branch starts from, so the owner can always make room under `maxVersionsPerDocument`. The
   * owner's other versions are kept for good (409), as is any version a branch starts from (409).
   */
  deleteVersion(
    documentId: string,
    versionId: string,
    principal: Principal = OWNER,
  ): ReplyError | { ok: true; status: 204 } {
    if (principal.kind === 'agent') {
      return fail(403, 'owner-only', 'An agent token may not do this');
    }
    if (!this.hasDocument(documentId) || !RECORD_ID.test(versionId)) {
      return fail(404, 'not-found', 'No such version');
    }
    switch (this.store.deleteAgentVersion(documentId, versionId)) {
      case 'deleted':
        return { ok: true, status: 204 };
      case 'gone':
        return fail(404, 'not-found', 'No such version');
      case 'owner-made':
        return fail(409, 'version-kept', "The owner's versions are kept for good");
      case 'referenced':
        return fail(409, 'version-referenced', 'A branch starts from this version');
    }
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
  createBranch(
    documentId: string,
    body: unknown,
    principal: Principal = OWNER,
  ): Reply | RecordReply<ServerBranch> {
    if (!this.hasDocument(documentId)) return fail(404, 'not-found', 'No such document');
    const parsed = CreateBranchSchema.safeParse(body);
    if (!parsed.success) return fail(400, 'invalid-branch', 'The branch record is invalid');
    let r: ServerBranch = parsed.data.branch;
    const { commentFrom, startVersion } = parsed.data;
    // readCheck refuses a revoked token too.
    const denied = this.readCheck(principal, documentId);
    if (denied !== undefined) return denied;
    if (principal.kind === 'agent' && r.provenance === undefined) {
      return fail(403, 'agent-provenance', 'An agent token makes only agent branches');
    }
    if (
      startVersion !== undefined &&
      (r.provenance === undefined ||
        startVersion.id !== r.fromVersion ||
        startVersion.branch !== MAIN_BRANCH ||
        startVersion.createdBy !== undefined)
    ) {
      return fail(
        400,
        'invalid-branch',
        'A start version is a version of the main branch, made with an agent branch from it',
      );
    }
    if (r.provenance !== undefined) {
      if (r.provenance.review !== 'open' || r.provenance.comment !== undefined) {
        return fail(400, 'invalid-branch', 'A new agent branch is open, with no comment');
      }
    } else if (commentFrom !== undefined) {
      return fail(400, 'invalid-branch', 'Only an agent branch carries a comment over');
    }
    const createdBy = principal.kind === 'agent' ? principal.tokenId : null;
    const stored = this.store.branchMeta(documentId, r.id);
    if (stored !== undefined) {
      return sameBranch(stored.record, r) && stored.createdBy === createdBy
        ? { ok: true, status: 200, record: stored.record }
        : fail(409, 'branch-exists', 'Another branch has this id');
    }
    if (commentFrom !== undefined) {
      // The reviewer's comment of the branch an update from Main replaces, copied here: never
      // taken from the request (ADR 0016 decision 9).
      const source = this.store.branchMeta(documentId, commentFrom);
      const sp = source?.record.provenance;
      if (
        source === undefined ||
        sp === undefined ||
        sp.sessionId !== r.provenance!.sessionId ||
        sp.clientName !== r.provenance!.clientName ||
        (principal.kind === 'agent' && source.createdBy !== principal.tokenId)
      ) {
        return fail(
          400,
          'invalid-branch',
          "The comment carries over only from the same session's branch",
        );
      }
      if (sp.comment !== undefined)
        r = { ...r, provenance: { ...r.provenance!, comment: sp.comment } };
    }
    if (this.store.branchCount(documentId) >= this.limits.maxBranchesPerDocument) {
      return fail(
        403,
        'too-many-branches',
        `A document has at most ${this.limits.maxBranchesPerDocument} branches`,
      );
    }
    if (
      principal.kind === 'agent' &&
      this.store.openAgentBranchCount(documentId, principal.tokenId) >=
        this.limits.maxAgentBranchesPerToken
    ) {
      return fail(
        403,
        'branch-quota',
        `An agent token has at most ${this.limits.maxAgentBranchesPerToken} agent branches of a document under way`,
      );
    }
    let from = this.store.version(documentId, r.fromVersion);
    let start: { version: ServerVersion; snapshot: StoredSnapshot } | undefined;
    if (startVersion !== undefined) {
      if (from !== undefined) {
        if (!sameRecord(from, startVersion)) {
          return fail(409, 'version-exists', 'Another version has the id of the start version');
        }
      } else {
        const main = this.branch(documentId, MAIN_BRANCH)!;
        if (startVersion.rev > main.rev) {
          return fail(400, 'no-revision', 'The start version names a revision not here yet');
        }
        const quota = this.versionQuota(documentId, principal);
        if (quota !== undefined) return quota;
        start = {
          version: startVersion,
          snapshot: this.documentAt(documentId, MAIN_BRANCH, startVersion.rev),
        };
        from = startVersion;
      }
    }
    if (from === undefined) {
      return fail(400, 'no-version', 'The branch names a version that is not here');
    }
    // An agent token starts only from a version of main (ADR 0016 decision 12, N-3): a version
    // on another branch would bring that branch's commands along, and a merge into main would
    // carry them too, though the agent branch's own log never shows them.
    if (principal.kind === 'agent' && from.branch !== MAIN_BRANCH) {
      return fail(
        403,
        'not-main-version',
        'An agent token starts a branch only from a version of the main branch',
      );
    }
    // An agent token starts only from the owner's versions and its own: never from another
    // token's (its start version), which would keep that version alive past its own branch and
    // past that token's revocation.
    if (
      principal.kind === 'agent' &&
      start === undefined &&
      from.createdBy !== undefined &&
      from.createdBy !== principal.tokenId
    ) {
      return fail(
        403,
        'not-own-version',
        "An agent token does not start a branch from another token's version",
      );
    }
    // The version's document, with the high-water mark of its branch as of that revision (deleted
    // parts' counters included), so the new log never hands out an id the old one had used.
    const at = start?.snapshot ?? this.documentAt(documentId, from.branch, from.rev);
    if (!this.store.createBranch(documentId, r, at.document, at.highWater, createdBy, start)) {
      const now = this.store.branchMeta(documentId, r.id);
      return now !== undefined && sameBranch(now.record, r) && now.createdBy === createdBy
        ? { ok: true, status: 200, record: now.record }
        : fail(409, 'branch-exists', 'Another branch has this id');
    }
    this.logUse.delete(`${documentId}\u0000${r.id}`);
    return { ok: true, status: 201, record: r };
  }

  /**
   * `POST /documents/:id/branches/:branch/review`: a new review state for an agent branch,
   * compare-and-set with `expected`. The owner may make any change and set or remove the
   * reviewer's comment. An agent token, on a branch it made, may only (ADR 0016 decisions 9 and
   * 12): submit an open branch; reopen a submitted one or one with changes requested (as a write
   * does); and, while nothing was written since it reopened one, put back the state it reopened
   * it from (a failed write). Never approve, reject, or touch the comment.
   */
  setReview(
    documentId: string,
    branch: string,
    body: unknown,
    principal: Principal = OWNER,
  ): Reply | RecordReply<ServerBranch> {
    if (!this.hasDocument(documentId)) return fail(404, 'not-found', 'No such document');
    const parsed = ReviewChangeSchema.safeParse(body);
    if (!parsed.success) return fail(400, 'invalid-review', 'The review change is invalid');
    // readCheck refuses a revoked token too.
    const denied = this.readCheck(principal, documentId);
    if (denied !== undefined) return denied;
    if (branch === MAIN_BRANCH) {
      return principal.kind === 'agent'
        ? fail(403, 'main-refused', 'An agent token never writes the main branch')
        : fail(400, 'not-agent-branch', 'The main branch has no review state');
    }
    const meta = this.store.branchMeta(documentId, branch);
    if (meta === undefined) return fail(404, 'not-found', 'No such branch');
    const prov = meta.record.provenance;
    if (prov === undefined) {
      return principal.kind === 'agent'
        ? fail(403, 'not-agent-branch', 'An agent token writes only agent branches')
        : fail(400, 'not-agent-branch', "A person's branch has no review state");
    }
    const { review, expected, comment } = parsed.data;
    const current = prov.review;
    if (principal.kind === 'agent' && meta.createdBy !== principal.tokenId) {
      return fail(403, 'not-own-branch', 'An agent token writes only the agent branches it made');
    }
    if (expected !== undefined) {
      const allowed: readonly ReviewState[] = typeof expected === 'string' ? [expected] : expected;
      if (!allowed.includes(current)) {
        return fail(409, 'review-changed', `The branch is ${current}`);
      }
    }
    let reopened: { from: string; head: number } | null = null;
    if (principal.kind === 'agent') {
      if (comment !== undefined) {
        return fail(403, 'comment-refused', 'Only the reviewer sets a review comment');
      }
      const head = this.branch(documentId, branch)?.rev ?? -1;
      const reopen =
        (current === 'submitted' || current === 'changes-requested') && review === 'open';
      const submit = current === 'open' && review === 'submitted';
      const restore =
        current === 'open' &&
        review === meta.reopenedFrom &&
        meta.reopenedHead === head &&
        (review === 'submitted' || review === 'changes-requested');
      if (!reopen && !submit && !restore) {
        return fail(
          403,
          'review-refused',
          `An agent token may not move a branch from ${current} to ${review}`,
        );
      }
      if (reopen) reopened = { from: current, head };
    }
    const { comment: kept, ...rest } = prov;
    const nextComment = comment === undefined ? kept : (comment ?? undefined);
    const next: Provenance = {
      ...rest,
      review,
      ...(nextComment === undefined ? {} : { comment: nextComment }),
    };
    if (!this.store.updateReview(documentId, branch, current, next, reopened)) {
      return fail(409, 'review-changed', 'The review state changed meanwhile');
    }
    // A closed branch takes no more writes: whoever held its log lets go of it now.
    if (review === 'approved' || review === 'rejected') {
      this.writers.delete(`${documentId}\u0000${branch}`);
    }
    return { ok: true, status: 200, record: { ...meta.record, provenance: next } };
  }

  /**
   * `DELETE /documents/:id/branches/:branch`: a branch and its log go (an update from Main
   * replacing an agent branch, ADR 0016 decision 1), with the start version stored with it when
   * no other branch starts from that. With `expected`, only while its review state is that. A
   * branch that versions name stays (409), since versions are kept for good; except that the
   * owner may delete an agent branch with `withVersions`, taking the versions agent tokens made on
   * it along (never one the owner made), so an agent can never leave the owner unable to tidy up.
   */
  deleteBranch(
    documentId: string,
    branch: string,
    expected: string | undefined,
    principal: Principal = OWNER,
    withVersions = false,
  ): Reply | { ok: true; status: 204 } {
    if (!this.hasDocument(documentId)) return fail(404, 'not-found', 'No such document');
    if (branch === MAIN_BRANCH) {
      return principal.kind === 'agent'
        ? fail(403, 'main-refused', 'An agent token never writes the main branch')
        : fail(400, 'main', 'The main branch cannot be deleted');
    }
    if (!BRANCH_ID.test(branch)) return fail(404, 'not-found', 'No such branch');
    if (
      expected !== undefined &&
      !(['open', 'submitted', 'changes-requested', 'approved', 'rejected'] as string[]).includes(
        expected,
      )
    ) {
      return fail(400, 'invalid-request', 'expected must be a review state');
    }
    if (withVersions && principal.kind === 'agent') {
      return fail(403, 'owner-only', 'Only the owner deletes versions with a branch');
    }
    const denied = this.writeCheck(principal, documentId, branch);
    if (denied !== undefined) return denied;
    const meta = this.store.branchMeta(documentId, branch);
    if (meta === undefined) return fail(404, 'not-found', 'No such branch');
    const current = meta.record.provenance?.review;
    if (expected !== undefined && current !== expected) {
      return fail(409, 'review-changed', `The branch is ${current ?? "a person's"}`);
    }
    if (withVersions && current === undefined) {
      return fail(400, 'not-agent-branch', 'Versions go with an agent branch only');
    }
    const deleted = this.store.deleteBranch(documentId, branch, current, {
      withAgentVersions: withVersions,
    });
    if (deleted === 'has-versions') {
      return fail(
        409,
        'branch-has-versions',
        withVersions
          ? 'Versions the owner made name this branch, or other branches start from its versions, so it stays'
          : 'Versions name this branch, so it stays',
      );
    }
    if (deleted !== 'deleted') {
      return fail(409, 'review-changed', 'The branch changed meanwhile');
    }
    const key = `${documentId}\u0000${branch}`;
    this.branches.delete(key);
    this.writers.delete(key);
    this.logUse.delete(key);
    return { ok: true, status: 204 };
  }

  /**
   * `PUT /documents/:id/branches/:branch/bundle`: a review bundle for head `revision` (the
   * library's count, one above the server log's), stored with an agent branch. Its content is not
   * read here: the app checks it as untrusted (T8.3b). Bundles count against the document's
   * cap, the instance's, and, for an agent token, its own (every document's bundles it stored).
   */
  putBundle(
    documentId: string,
    branch: string,
    body: unknown,
    principal: Principal = OWNER,
  ): Reply | { ok: true; status: 201 } {
    if (!this.hasDocument(documentId)) return fail(404, 'not-found', 'No such document');
    const denied = this.writeCheck(principal, documentId, branch);
    if (denied !== undefined) return denied;
    const meta = branch === MAIN_BRANCH ? undefined : this.store.branchMeta(documentId, branch);
    if (meta === undefined) return fail(404, 'not-found', 'No such branch');
    if (meta.record.provenance === undefined) {
      return fail(400, 'not-agent-branch', 'Only an agent branch has review bundles');
    }
    const closed = this.openCheck(principal, documentId, branch);
    if (closed !== undefined) return closed;
    const parsed = PutBundleSchema.safeParse(body);
    if (!parsed.success) return fail(400, 'invalid-bundle', 'The review bundle is invalid');
    const { revision, record } = parsed.data;
    const head = this.branch(documentId, branch)!.rev;
    if (
      record.documentId !== documentId ||
      record.branch !== branch ||
      record.revision !== revision ||
      revision > head + 1
    ) {
      return fail(400, 'invalid-bundle', 'The review bundle is not of this branch head');
    }
    const text = JSON.stringify(record);
    const bytes = Buffer.byteLength(text);
    if (bytes > this.limits.maxBundleBytes) {
      return fail(
        413,
        'too-large',
        `A review bundle is at most ${this.limits.maxBundleBytes} bytes`,
      );
    }
    if (
      this.store.bundleBytes(documentId, { branch, revision }) + bytes >
      this.limits.maxBundleBytesPerDocument
    ) {
      return fail(
        507,
        'bundle-storage-full',
        `A document's review bundles hold at most ${this.limits.maxBundleBytesPerDocument} bytes`,
      );
    }
    const replaced = { documentId, branch, revision };
    const tokenId = principal.kind === 'agent' ? principal.tokenId : null;
    if (
      tokenId !== null &&
      this.store.agentBundleBytes(tokenId, replaced) + bytes > this.limits.maxAgentBundleBytes
    ) {
      return fail(
        403,
        'bundle-quota',
        `An agent token stores at most ${this.limits.maxAgentBundleBytes} bytes of review bundles`,
      );
    }
    if (this.store.totalBundleBytes(replaced) + bytes > this.limits.maxBundleTotalBytes) {
      return fail(
        507,
        'bundle-storage-full',
        `The server's review bundles hold at most ${this.limits.maxBundleTotalBytes} bytes`,
      );
    }
    this.store.putBundle(documentId, branch, revision, text, BUNDLES_KEPT, tokenId);
    return { ok: true, status: 201 };
  }

  /** `GET /documents/:id/branches/:branch/bundle/meta`: the newest bundle's revision and size. */
  bundleMeta(
    documentId: string,
    branch: string,
  ): ReplyError | { ok: true; revision: number; bytes: number } {
    if (!this.hasDocument(documentId) || !BRANCH_ID.test(branch) || branch === MAIN_BRANCH) {
      return fail(404, 'not-found', 'No such branch');
    }
    const m = this.store.bundleMeta(documentId, branch);
    if (m === undefined) return fail(404, 'not-found', 'No review bundle');
    return { ok: true, ...m };
  }

  /** `GET /documents/:id/branches/:branch/bundle`: the newest review bundle, or 404. */
  getBundle(
    documentId: string,
    branch: string,
  ): ReplyError | { ok: true; revision: number; record: unknown } {
    if (!this.hasDocument(documentId) || !BRANCH_ID.test(branch) || branch === MAIN_BRANCH) {
      return fail(404, 'not-found', 'No such branch');
    }
    const b = this.store.latestBundle(documentId, branch);
    if (b === undefined) return fail(404, 'not-found', 'No review bundle');
    return { ok: true, revision: b.revision, record: JSON.parse(b.record) as unknown };
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
