import type { CounterTable, ManufaktureDocument, SyncEntry } from '@manufakture/core';
import type {
  Outcome,
  Provenance,
  PushedEntry,
  ServerBranch,
  ServerVersion,
} from '@manufakture/sync';

/**
 * The server's storage, behind an interface so the sync logic does not know SQL (ADR 0009
 * decision 11). `SqliteStore` is the one implementation in M7 (product decision 0001, decision 3).
 *
 * The methods are synchronous because better-sqlite3 is, and because a submit is judged and
 * written with no other request in between. A store over a network database (Postgres, T7.1g,
 * skipped in M7) would need an asynchronous variant and a per-branch lock in the service; nothing
 * outside `SyncService` calls the store.
 *
 * Every change a submit makes (entries, outcomes, the client's floor and latest accepted entry,
 * the head, a snapshot) goes through `commitSubmit` as one transaction, so a crash leaves either
 * all of it or none of it.
 */

/**
 * The branch every document has. Other branches (T7.1e) are their own logs, each with a record
 * (`ServerBranch`) naming the version it started from.
 */
export const MAIN_BRANCH = 'main';

/** A snapshot of the head every this many revisions, so loading does not replay from 1. */
export const CHECKPOINT_EVERY = 100;

export interface DocumentInfo {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  /** The head revision of the main branch. */
  readonly head: number;
}

/** What loading a branch needs: its newest snapshot and the entries after it. */
export interface LoadedBranch {
  readonly head: number;
  readonly highWater: CounterTable;
  readonly snapshot: {
    readonly rev: number;
    readonly document: ManufaktureDocument;
    readonly highWater: CounterTable;
  };
  /** Entries after the snapshot, in revision order, up to the head. */
  readonly after: readonly PushedEntry[];
}

export interface ClientRecord {
  readonly clientId: string;
  /** SHA-256 of the client key the client claimed its id with. */
  readonly keyHash: Buffer;
  /** The highest retention floor the client has sent; never lowered. */
  readonly floor: number;
  readonly latestAccepted: number | undefined;
}

/** Everything one submit writes, in one transaction. */
export interface SubmitWrite {
  readonly documentId: string;
  readonly branch: string;
  readonly clientId: string;
  /** Accepted entries, in revision order, continuing from the stored head. */
  readonly accepted: readonly PushedEntry[];
  /** Outcomes to record (acceptances and refusals), by `clientSeq`. */
  readonly outcomes: readonly { readonly clientSeq: number; readonly outcome: Outcome }[];
  /** The client's latest accepted `clientSeq` after the submit. */
  readonly latestAccepted: number | undefined;
  /** The client's floor after the submit (already the maximum of the old and the sent one). */
  readonly floor: number;
  /** The new head and high-water mark, when entries were accepted. */
  readonly head?: { readonly rev: number; readonly highWater: CounterTable };
  /** Snapshots to write (revisions that are multiples of `CHECKPOINT_EVERY`). */
  readonly snapshots: readonly {
    readonly rev: number;
    readonly document: ManufaktureDocument;
    readonly highWater: CounterTable;
  }[];
}

/** A stored snapshot: a branch's document at `rev`. */
export interface StoredSnapshot {
  readonly rev: number;
  readonly document: ManufaktureDocument;
  readonly highWater: CounterTable;
}

/**
 * A branch record with what only the server knows of it (T8.4b): which agent token made it (null:
 * the owner, or a person's branch), and, after an agent moved it back to `open` from
 * `reopenedFrom`, the head revision it was at then, so that restoring that state is allowed only
 * while no write has landed since.
 */
export interface BranchMeta {
  readonly record: ServerBranch;
  readonly createdBy: string | null;
  readonly reopenedFrom: string | null;
  readonly reopenedHead: number | null;
}

/** A review bundle stored with a branch (T8.4b). */
export interface StoredBundle {
  readonly revision: number;
  /** The bundle record as JSON. */
  readonly record: string;
}

export interface SyncStore {
  /** Creates a document with its main branch at revision 0; false if the id exists. */
  createDocument(
    info: { id: string; name: string; createdAt: string },
    document: ManufaktureDocument,
    highWater: CounterTable,
  ): boolean;
  listDocuments(): DocumentInfo[];
  documentCount(): number;
  hasDocument(id: string): boolean;
  loadBranch(documentId: string, branch: string): LoadedBranch | undefined;
  /**
   * Accepted entries after `since`, at most `limit`, and no more than `maxBytes` of stored JSON
   * (the first entry is always included, whatever its size).
   */
  entries(
    documentId: string,
    branch: string,
    since: number,
    limit: number,
    maxBytes?: number,
  ): PushedEntry[];

  client(documentId: string, branch: string, clientId: string): ClientRecord | undefined;
  clientCount(documentId: string, branch: string): number;
  /** Records a new client with its key hash, floor 1 and no rows. */
  claimClient(documentId: string, branch: string, clientId: string, keyHash: Buffer): void;
  /** The recorded outcome of `(clientId, clientSeq)`. */
  outcome(
    documentId: string,
    branch: string,
    clientId: string,
    clientSeq: number,
  ): Outcome | undefined;
  /** How many de-duplication rows a client holds at or above `fromSeq` (all when absent). */
  rowCount(documentId: string, branch: string, clientId: string, fromSeq?: number): number;
  /** Writes a submit's changes and prunes the client's rows below its floor, in one transaction. */
  commitSubmit(write: SubmitWrite): void;

  /** Whether the document has branch `branch` (`main` included). */
  hasBranch(documentId: string, branch: string): boolean;
  /** The newest snapshot of a branch at or below `rev`. */
  snapshotAt(documentId: string, branch: string, rev: number): StoredSnapshot | undefined;

  /** The document's versions (every branch's), in the order they were stored. */
  listVersions(documentId: string): ServerVersion[];
  version(documentId: string, versionId: string): ServerVersion | undefined;
  versionCount(documentId: string): number;
  /**
   * Stores a version, and `snapshot` (its branch's document at its revision) unless that branch
   * has a snapshot at that revision already, in one transaction. False if the id is taken.
   * `createdBy` is the agent token that made it (null: the owner).
   */
  insertVersion(
    documentId: string,
    version: ServerVersion,
    snapshot: StoredSnapshot,
    createdBy?: string | null,
  ): boolean;
  /** How many versions of the document agent token `tokenId` made. */
  agentVersionCount(documentId: string, tokenId: string): number;

  /** The document's branch records (main has none), in the order they were made. */
  listBranches(documentId: string): ServerBranch[];
  branchRecord(documentId: string, branch: string): ServerBranch | undefined;
  /** How many branches the document has besides main. */
  branchCount(documentId: string): number;
  /**
   * Creates a branch with its record, at revision 0 holding `document`, in one transaction.
   * False if the document has a branch with that id.
   */
  createBranch(
    documentId: string,
    record: ServerBranch,
    document: ManufaktureDocument,
    highWater: CounterTable,
    createdBy?: string | null,
    startVersion?: { version: ServerVersion; snapshot: StoredSnapshot },
  ): boolean;
  /**
   * How many agent branches of the document agent token `tokenId` made that are not closed
   * (approved or rejected).
   */
  openAgentBranchCount(documentId: string, tokenId: string): number;
  /** A branch record with the server's own fields; undefined when there is none (or it is damaged). */
  branchMeta(documentId: string, branch: string): BranchMeta | undefined;
  /**
   * Changes an agent branch's provenance (its review state and comment) and the reopen marker, if
   * the stored review state is still `from`. False otherwise (nothing written).
   */
  updateReview(
    documentId: string,
    branch: string,
    from: string,
    provenance: Provenance,
    reopened: { from: string; head: number } | null,
  ): boolean;
  /** How many versions name a revision of `branch`. */
  branchVersionCount(documentId: string, branch: string): number;
  /**
   * Deletes a branch (never main) with its record, log, snapshots, clients, outcomes and bundles,
   * in one transaction; with `review`, only while its stored review state is that. The version it
   * started from goes too when it is a start version (stored with some branch by `createBranch`'s
   * `startVersion`) that no other branch starts from now, and either an agent token made it or
   * the owner made both it and this branch: a delete of an agent's branch never takes a version
   * the owner made. A start version stored with this branch that stays is marked as having
   * outlived it, so a branch made later under the same id never inherits it. Versions that name
   * the branch keep it (`has-versions`), unless `withAgentVersions` and every one of them was
   * made by an agent token and starts no other branch: those go with it.
   */
  deleteBranch(
    documentId: string,
    branch: string,
    review?: string,
    options?: { withAgentVersions?: boolean },
  ): 'deleted' | 'gone' | 'changed' | 'has-versions';
  /**
   * Stores a review bundle for `revision` (replacing one there), keeping the newest `keep`.
   * `createdBy` is the agent token that stored it (null: the owner).
   */
  putBundle(
    documentId: string,
    branch: string,
    revision: number,
    record: string,
    keep: number,
    createdBy?: string | null,
  ): void;
  /** The newest review bundle of a branch. */
  latestBundle(documentId: string, branch: string): StoredBundle | undefined;
  /** The newest review bundle's revision and size in bytes. */
  bundleMeta(documentId: string, branch: string): { revision: number; bytes: number } | undefined;
  /** The bytes of every review bundle of the document, but `except` (one branch's revision). */
  bundleBytes(documentId: string, except?: { branch: string; revision: number }): number;
  /** The bytes of every review bundle agent token `tokenId` stored, but `except`. */
  agentBundleBytes(
    tokenId: string,
    except?: { documentId: string; branch: string; revision: number },
  ): number;
  /** The bytes of every review bundle of the instance, but `except`. */
  totalBundleBytes(except?: { documentId: string; branch: string; revision: number }): number;
  /**
   * Deletes a version no branch starts from, made by an agent token or stored as a start version
   * (the owner tidying up, a start version an agent's branch delete left behind included). Any
   * other version of the owner's is `owner-made`; it and a `referenced` one stay.
   */
  deleteAgentVersion(
    documentId: string,
    versionId: string,
  ): 'deleted' | 'gone' | 'owner-made' | 'referenced';
  /**
   * Deletes the start versions agent token `tokenId` made that no branch starts from (it was
   * revoked), in every document: how many went.
   */
  sweepStartVersions(tokenId: string): number;

  /** Stores a blob, recording the agent token that stored it (null: the owner); false if it was already there. */
  putBlob(sha256: string, bytes: Buffer, createdBy?: string | null): boolean;
  /** The size of the blobs agent token `tokenId` stored. */
  agentBlobBytes(tokenId: string): number;
  getBlob(sha256: string): Buffer | undefined;
  hasBlob(sha256: string): boolean;
  /** The size of every blob together. */
  blobBytes(): number;

  close(): void;
}

export type { SyncEntry };
