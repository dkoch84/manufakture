import type { CounterTable, ManufaktureDocument, SyncEntry } from '@manufakture/core';
import type { Outcome, PushedEntry } from '@manufakture/sync';

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

/** The only branch in M7; T7.1e adds the others. */
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
  /** Accepted entries after `since`, at most `limit`. */
  entries(documentId: string, branch: string, since: number, limit: number): PushedEntry[];

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

  /** Stores a blob; false if it was already there. */
  putBlob(sha256: string, bytes: Buffer): boolean;
  getBlob(sha256: string): Buffer | undefined;
  hasBlob(sha256: string): boolean;
  /** The size of every blob together. */
  blobBytes(): number;

  close(): void;
}

export type { SyncEntry };
