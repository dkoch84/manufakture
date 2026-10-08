// The document library: every document the browser holds, stored so that a crash at any point
// never loses the last saved state. See docs/user/files.md for the user's view and the README
// in this directory for the layout.
//
// Layout, per document (`documents/<id>/`):
//
//   head.json               the pointer: which snapshot is current, its SHA-256, name, dates,
//                           and which version list is current
//   snapshot-<rev>.json     the document at revision <rev>, in storage form (blobs.ts)
//   log-<rev>.json          the commands that led from the previous revision to <rev>
//   versions-<n>.json       the named versions, the n-th time the list was written
//   branches-<n>.json       the branches besides main, the n-th time the list was written
//   sync-<n>.json           the sync state (T7.1d), the n-th write, for the revision it names
//   blobs/<sha256>          each imported file, once
//   branches/<branch>/      a branch's own head.json, snapshot-<rev>.json and log-<rev>.json
//
// The document directory itself is the main branch, so a document saved before branches existed
// is its main branch unchanged. Every other branch keeps its own head, snapshots and log in
// `branches/<branch id>/`, under the same rules; the blobs, the version list (each version
// records its branch) and the branch list are the document's, committed by the main head.
//
// A save never overwrites a file anything points at. It first deletes what an earlier failed
// save left above the head, then writes, in order: new blobs, the log segment,
// `snapshot-<rev+1>.json` (a new name), and last `head.json`; then it deletes snapshots older
// than the one the head named before (that one stays as the spare), except the ones kept as
// history: those a named version points at, and a checkpoint every CHECKPOINT_EVERY
// revisions. A version list is committed the same way: `versions-<n+1>.json`, then the head
// naming it. Any retained revision reads directly; any other one is rebuilt from the nearest
// retained snapshot below it by replaying the logged commands (`readRevision`).
//
// Writes are not assumed atomic (OPFS has no atomic replace or rename in every browser), so
// loading trusts nothing: it takes the newest snapshot that reads completely (JSON parses, the
// document migrates and validates, every blob matches its hash), rewrites the head if it was
// stale or damaged, and deletes the files of any later, broken save above the head. A crash
// before the new snapshot is complete leaves the previous one; a crash after it, before the
// head, is recovered forward. A later snapshot that is complete (its JSON parses) but does not
// read as a valid document (a blob it needs went missing, or a future release checks more) is
// not a torn write: before anything is repointed or deleted, it and its log segment are copied
// aside as `damaged-snapshot-<rev>-<sha>.json` and `damaged-log-<rev>-<sha>.json`, names nothing
// else matches, so they stay until the document is deleted.
//
// Several tabs may have one document open. Every operation on a document (on any of its
// branches) holds a Web Lock named after it (where the browser has Web Locks), so two tabs never
// interleave their files, and a
// save refuses (`RevisionConflict`) when the head has moved past the revision this library last
// opened or saved: another tab saved in between, and overwriting would silently drop its work.

import {
  FORMAT_VERSION,
  MAX_DOCUMENT_NAME,
  applyCommand,
  createdIds,
  migrateJson,
  parseDocument,
  serialize,
  type Command,
  type ManufaktureDocument,
  type SyncEntry,
} from '@manufakture/core';
import { fileName, fromBase64, sha256Hex } from '@manufakture/io';
import { SyncClient, changedObjects, documentObjects } from '@manufakture/sync';
import type { BackendKind, StorageBackend } from './backend';
import { BlobStore, blobRefs, externalize, hydrateFrom, isSha256 } from './blobs';

export const ROOT = 'documents';
const HEAD = 'head.json';
const SNAPSHOT = /^snapshot-(\d{1,12})\.json$/;
const LOG = /^log-(\d{1,12})\.json$/;
const VERSIONS = /^versions-(\d{1,12})\.json$/;
const BRANCHES = /^branches-(\d{1,12})\.json$/;
const SYNC = /^sync-(\d{1,12})\.json$/;
/** The directory, in a document's, that holds the branches besides main. */
const BRANCH_DIR = 'branches';

const pad = (rev: number) => String(rev).padStart(8, '0');
const snapshotName = (rev: number) => `snapshot-${pad(rev)}.json`;
const logName = (rev: number) => `log-${pad(rev)}.json`;
const versionsName = (n: number) => `versions-${pad(n)}.json`;
const branchesName = (n: number) => `branches-${pad(n)}.json`;
const syncName = (n: number) => `sync-${pad(n)}.json`;
/**
 * The document of a version that came from the sync server (T7.1e) and names no revision saved
 * here: `remote-<version id>.json` in the main directory, in storage form.
 */
const remoteName = (versionId: string) => `remote-${versionId}.json`;
const REMOTE = /^remote-[A-Za-z0-9][A-Za-z0-9_-]{0,127}\.json$/;

/**
 * The main branch: the document's own directory. Every operation that takes a branch means this
 * one when given none (see each method for the exceptions).
 */
export const MAIN_BRANCH = 'main';
/** What the main branch is called; it cannot be renamed or deleted. */
export const MAIN_BRANCH_NAME = 'Main';
/** Branches one document holds at most, besides main. */
export const MAX_BRANCHES = 100;

/**
 * A save keeps the snapshot of every revision `1 + k * CHECKPOINT_EVERY` (1, 65, 129, ...), so
 * any revision is at most CHECKPOINT_EVERY - 1 log segments from a retained snapshot.
 */
export const CHECKPOINT_EVERY = 64;
export const isCheckpoint = (rev: number): boolean => (rev - 1) % CHECKPOINT_EVERY === 0;

/** A version's description, at most this many characters (its name is a document name's). */
export const MAX_VERSION_DESCRIPTION = 2000;
/**
 * Versions one document holds at most; also what an imported file may list. Half the `.mfk`
 * entry limit (MFK_LIMITS.maxEntries), so an export with every version (one entry each, beside
 * the document, the manifest and the blobs) can be imported again.
 */
export const MAX_VERSIONS = 500;
/** Where a complete snapshot that cannot be read is kept, with its log segment: never pruned. */
const damagedName = (kind: 'snapshot' | 'log', rev: number, sha256: string) =>
  `damaged-${kind}-${pad(rev)}-${sha256.slice(0, 16)}.json`;

/** Document ids that are safe as directory names; the app makes UUIDs. */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
export const isStorableId = (id: string): boolean => SAFE_ID.test(id);
/** Branch ids: main, or one safe as a directory name (the app makes UUIDs). */
export const isBranchId = (branch: string): boolean =>
  typeof branch === 'string' && SAFE_ID.test(branch);

/** The Web Locks API as the library uses it: `navigator.locks`, or a stand-in in tests. */
export interface DocumentLocks {
  /** Run `callback` holding the exclusive lock `name`, across tabs of this origin. */
  request<T>(name: string, callback: () => Promise<T>): Promise<T>;
}

/** The browser's Web Locks, or null where there are none (older browsers, insecure origins). */
export function browserLocks(): DocumentLocks | null {
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
  if (!locks || typeof locks.request !== 'function') return null;
  return { request: (name, callback) => locks.request(name, () => callback()) };
}

/**
 * A save refused because the stored document moved on since this library opened or saved it:
 * another tab (or window) saved it in between. Nothing was committed; both versions are intact.
 */
export class RevisionConflict extends Error {
  readonly documentId: string;
  /** The revision stored now, and the one this library expected. */
  readonly stored: number;
  readonly expected: number;

  constructor(documentId: string, stored: number, expected: number) {
    super(
      `It was changed in another tab or window (saved there as revision ${stored}; this tab ` +
        `has revision ${expected}). This tab's changes were not saved over it.`,
    );
    this.name = 'RevisionConflict';
    this.documentId = documentId;
    this.stored = stored;
    this.expected = expected;
  }
}

/**
 * A save refused because its branch was deleted (in another tab, say) since this library opened
 * it. Nothing was written; like any conflict, the tab can keep its version as a copy.
 */
export class BranchDeleted extends RevisionConflict {
  readonly branch: string;

  constructor(documentId: string, branch: string, expected: number) {
    super(documentId, 0, expected);
    this.name = 'BranchDeleted';
    this.message =
      'Its branch was deleted in another tab or window, so the changes made here were not ' +
      'saved to it.';
    this.branch = branch;
  }
}

export type LibraryResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      message: string;
      /** Set when what failed is that the branch asked for does not exist (or was deleted). */
      noBranch?: true;
      /**
       * Set when the document was saved by a newer app (ADR 0004 decision 2): refused, and the
       * home screen offers to update the app (src/pwa/UpdateNeeded.tsx).
       */
      newer?: true;
      /**
       * Set by `setBranchReview` with `expected` when the branch's review state was not the one
       * expected (someone changed it meanwhile): nothing was written.
       */
      reviewChanged?: true;
    };

/** The failure for a branch that is not there; never echoes the id it was given. */
const NO_BRANCH = { ok: false, message: 'There is no such branch.', noBranch: true } as const;

/** One step of the command log, as the document store ran it. */
export interface LogEntry {
  cause: 'execute' | 'undo' | 'redo';
  label: string;
  command: Command;
  /** When it ran, ISO 8601. */
  at: string;
}

/** One saved revision's log entries, as the history panel lists them (commands left out). */
export interface LoggedRevision {
  /** The revision these entries lead to. */
  revision: number;
  entries: { cause: LogEntry['cause']; label: string; at: string }[];
}

/** A document as the home screen lists it. */
export interface DocumentSummary {
  id: string;
  name: string;
  /** ISO 8601. */
  createdAt: string;
  savedAt: string;
  revision: number;
  /** Stored size: the current snapshot and the imported files. */
  bytes: number;
  /** Set when no revision of the document can be read: why. */
  damaged?: string;
}

export interface Opened {
  document: ManufaktureDocument;
  /** Core migrated it from an older file format; the next save writes the current one. */
  migrated: boolean;
  /** The head was stale or damaged, and the document was recovered from its snapshots. */
  recovered: boolean;
  /** The stored revision it was read from. */
  revision: number;
}

interface Head {
  format: 'manufakture-head';
  id: string;
  name: string;
  revision: number;
  snapshotSha256: string;
  snapshotBytes: number;
  blobBytes: number;
  createdAt: string;
  savedAt: string;
  /** Which `versions-<n>.json` is current; 0 (or absent, before versions existed): none. */
  versions: number;
  /**
   * Which `branches-<n>.json` is current; 0 (or absent, before branches existed): none. Only the
   * main branch's head names lists; a branch's head has 0 for both.
   */
  branches: number;
  /**
   * Which `sync-<n>.json` is current (T7.1d): the document's sync state, for the revision the
   * file names. 0 (or absent, before sync existed): the document does not sync. Main only.
   */
  sync?: number;
}

/** What a main head commits besides its revision: how many times each list was written. */
type Lists = Pick<Head, 'versions' | 'branches' | 'sync'>;

/**
 * A document's sync state (T7.1d, ADR 0009 decision 4), saved with the revision it belongs to:
 * `sync-<n>.json`, committed by the main head like the lists, and written before that head by the
 * same save that writes the snapshot, so a reload never pairs a queue with another revision.
 */
export interface SyncRecord {
  /** The server's base address (`ServerSettings.url`); never the token. */
  server: string;
  /** The client key this browser proves its client id with (apps/server binds it at the first hello). */
  clientKey: string;
  /** The server's last confirmed document, the one `state` builds on. */
  confirmed: ManufaktureDocument;
  /** `SyncClient.save()`: plain JSON, validated by `SyncClient.restore`. */
  state: unknown;
  /** Versions and branches made here while syncing that the server does not hold yet (T7.1e). */
  uploads?: SyncUploads;
}

/** Versions and branches waiting to be stored on the sync server (T7.1e), by id. */
export interface SyncUploads {
  /**
   * Each version with the server revision it names once that is known (`rev`), or the local id of
   * the queue entry whose landing tells it (`after`, `SyncClient`'s `local`).
   */
  versions: { id: string; rev?: number; after?: number }[];
  branches: string[];
}

/** The most uploads a sync record keeps of each kind. */
export const MAX_UPLOADS = 500;

/** `uploads` as read from a sync file, or null when it is not one. */
export function parseUploads(v: unknown): SyncUploads | null {
  if (!isRecord(v) || !Array.isArray(v.versions) || !Array.isArray(v.branches)) return null;
  if (v.versions.length > MAX_UPLOADS || v.branches.length > MAX_UPLOADS) return null;
  const count = (n: unknown) => n === undefined || (Number.isSafeInteger(n) && (n as number) >= 0);
  const versions: SyncUploads['versions'] = [];
  for (const u of v.versions) {
    if (!isRecord(u) || typeof u.id !== 'string' || !VERSION_ID.test(u.id)) return null;
    if (!count(u.rev) || !count(u.after)) return null;
    versions.push({
      id: u.id,
      ...(u.rev === undefined ? {} : { rev: u.rev as number }),
      ...(u.after === undefined ? {} : { after: u.after as number }),
    });
  }
  const branches: string[] = [];
  for (const b of v.branches) {
    if (typeof b !== 'string' || !isBranchId(b) || b === MAIN_BRANCH) return null;
    branches.push(b);
  }
  return { versions, branches };
}

/** A sync record as read back, and whether it belongs to the revision the head names. */
export interface StoredSync {
  record: SyncRecord;
  /**
   * The record was saved with the head's revision. False when a later save of the document did
   * not carry sync state (another tab, an older app): the document then holds changes the queue
   * does not.
   */
  paired: boolean;
}

/**
 * A named version: a revision given a name, kept for good. Its id is permanent, so other
 * documents can pin it (a derived part pins `documentId` plus `versionId`).
 */
export interface Version {
  id: string;
  name: string;
  description: string;
  /** The stored revision it names, and that snapshot's SHA-256. */
  revision: number;
  snapshotSha256: string;
  /** ISO 8601. */
  createdAt: string;
  /** The branch whose revision it names; absent: the main branch. */
  branch?: string;
  /**
   * Set on a version that came from the sync server (T7.1e) and names no revision saved in this
   * browser: the revision of its branch's server log. Its `revision` is then 0 and its document is
   * kept beside the revisions (`remote-<id>.json`), checked against `snapshotSha256` as usual.
   */
  serverRev?: number;
  /**
   * Set on a version of main that records an approved review (T8.3b writes it when it merges an
   * agent's branch): which review the work came from, so a later export can say so. Only main's
   * versions carry one; an imported `.mfk` keeps none.
   */
  review?: ReviewReference;
}

/**
 * The review a merge into main came from (ADR 0016 decisions 11 and 12): the agent branch, its
 * session and client as its provenance names them, the bundle the reviewer approved (stored in
 * that branch's directory as `review-<bundleRevision>.json`) and the merge's label.
 */
export interface ReviewReference {
  /** The agent branch's id. */
  branch: string;
  sessionId: string;
  /** Self-reported by the agent's client, as its provenance had it: shown, never trusted. */
  clientName: string;
  /** The head revision of the branch the approved bundle was built at. */
  bundleRevision: number;
  /** The merge's label in main's history, naming the session. */
  label: string;
}

/** A review reference's label, at most this many characters. */
export const MAX_REVIEW_LABEL = 200;

/** A version from the sync server, to keep here (`adoptVersion`). */
export interface RemoteVersion {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  /** The branch it names a revision of. */
  branch: string;
  /** That revision of the branch's server log. */
  serverRev: number;
}

/** What the library tells its subscribers: a document's versions or branches changed. */
export interface LibraryChange {
  id: string;
  kind: 'versions' | 'branches';
}

/**
 * A version that is not in this browser, looked up elsewhere (the sync server, T7.1e) by
 * `documentId` plus `versionId`: its record and document, or null when it is not there either.
 */
export type RemoteVersionSource = (
  documentId: string,
  versionId: string,
) => Promise<{ version: RemoteVersion; document: ManufaktureDocument } | null>;

/** A branch of a document: its own head, history and versions, beside the main branch. */
export interface Branch {
  /** MAIN_BRANCH, or a UUID: the directory under `branches/`, and `?branch=` in the URL. */
  id: string;
  name: string;
  /** The version it was branched from; null for the main branch. */
  fromVersion: string | null;
  /** ISO 8601. */
  createdAt: string;
  /** Set on a branch an agent session made; absent on a person's (and on main). */
  provenance?: BranchProvenance;
}

/** Where an agent branch stands in review. */
export type ReviewState = 'open' | 'submitted' | 'changes-requested' | 'approved' | 'rejected';
export const REVIEW_STATES: readonly ReviewState[] = [
  'open',
  'submitted',
  'changes-requested',
  'approved',
  'rejected',
];

/**
 * Who made a branch when it was not a person in the app (docs/plans/agent-surface.md, decision
 * 3). Library data kept in the branch list, not document format: a release that does not know it
 * reads the list as before.
 */
export interface BranchProvenance {
  origin: 'agent';
  /** The session that made it: an id as documents have (`isStorableId`). */
  sessionId: string;
  /** The name the agent's client gave for itself: self-reported, so shown, never trusted. */
  clientName: string;
  review: ReviewState;
}

/** A client's self-reported name, at most this many characters. */
export const MAX_CLIENT_NAME = 200;

export interface VersionMeta {
  name: string;
  description?: string;
  /** The review the version's work came from; main's versions only (`Version.review`). */
  review?: ReviewReference;
}

/** A revision read back, possibly rebuilt by replaying the log. */
export interface ReadRevision {
  document: ManufaktureDocument;
  revision: number;
  /** The retained snapshot the replay started from (`revision` itself when it is retained). */
  from: number;
  /**
   * Retained snapshots on the way that the replay did not reproduce: each was logged, and the
   * replay went on from the snapshot.
   */
  mismatches: number[];
}

interface LogSegment {
  format: 'manufakture-log';
  /** The revision these commands lead to. */
  revision: number;
  /** The revision they start from; null for the first save. */
  base: number | null;
  /** Commands in storage form: imported files by reference (blobs.ts). */
  entries: unknown[];
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function parseHead(bytes: Uint8Array | null, id: string): Head | null {
  if (!bytes) return null;
  try {
    const h = JSON.parse(decoder.decode(bytes)) as Partial<Head>;
    const valid =
      h.format === 'manufakture-head' &&
      h.id === id &&
      typeof h.name === 'string' &&
      Number.isInteger(h.revision) &&
      typeof h.snapshotSha256 === 'string' &&
      typeof h.snapshotBytes === 'number' &&
      typeof h.blobBytes === 'number' &&
      typeof h.createdAt === 'string' &&
      typeof h.savedAt === 'string' &&
      (h.versions === undefined || (Number.isInteger(h.versions) && h.versions >= 0)) &&
      (h.branches === undefined || (Number.isInteger(h.branches) && h.branches >= 0));
    if (h.sync !== undefined && !(Number.isInteger(h.sync) && h.sync >= 0)) return null;
    return valid
      ? ({ ...h, versions: h.versions ?? 0, branches: h.branches ?? 0, sync: h.sync ?? 0 } as Head)
      : null;
  } catch {
    return null;
  }
}

function summaryOf(head: Head): DocumentSummary {
  return {
    id: head.id,
    name: head.name,
    createdAt: head.createdAt,
    savedAt: head.savedAt,
    revision: head.revision,
    bytes: head.snapshotBytes + head.blobBytes,
  };
}

function revisions(names: readonly string[], pattern: RegExp): number[] {
  return names
    .map((n) => pattern.exec(n)?.[1])
    .filter((r): r is string => r !== undefined)
    .map(Number)
    .sort((a, b) => b - a);
}

const CAUSES: ReadonlySet<unknown> = new Set(['execute', 'undo', 'redo']);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Whether `v` is a log segment for revision `rev`, with entries of the right shape. */
function isLogSegment(v: unknown, rev: number): v is LogSegment {
  if (!isRecord(v) || v.format !== 'manufakture-log' || v.revision !== rev) return false;
  const base = v.base;
  if (base !== null && !(Number.isInteger(base) && (base as number) >= 0 && (base as number) < rev))
    return false;
  return (
    Array.isArray(v.entries) &&
    v.entries.every(
      (e) =>
        isRecord(e) &&
        CAUSES.has(e.cause) &&
        typeof e.label === 'string' &&
        typeof e.at === 'string' &&
        isRecord(e.command) &&
        typeof e.command.type === 'string',
    )
  );
}

/** Version ids: the app makes UUIDs; an imported one is kept when it has this shape. */
const VERSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** A version's name and description as given: trimmed name of 1 to 200 characters. */
function versionMeta(meta: VersionMeta): { name: string; description: string } | string {
  const name = typeof meta.name === 'string' ? meta.name.trim() : '';
  if (name.length === 0 || name.length > MAX_DOCUMENT_NAME) {
    return `A version name must be 1 to ${MAX_DOCUMENT_NAME} characters.`;
  }
  const description = meta.description ?? '';
  if (typeof description !== 'string' || description.length > MAX_VERSION_DESCRIPTION) {
    return `A version description must be at most ${MAX_VERSION_DESCRIPTION} characters.`;
  }
  return { name, description };
}

/** Text a person reads that came from elsewhere: 1 to `max` characters, unpadded, no Cc/Cf/Cs. */
const shownText = (v: unknown, max: number): v is string =>
  typeof v === 'string' &&
  v.length > 0 &&
  v.length <= max &&
  v.trim() === v &&
  !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(v);

/**
 * A review reference, checked field by field (other fields are left out): the branch an agent
 * branch id (never main), the session a storable id, the client name as provenance checks it, the
 * bundle's revision a positive safe integer and the label shown text of at most
 * MAX_REVIEW_LABEL characters. Null when anything is off.
 */
export function parseReviewReference(v: unknown): ReviewReference | null {
  if (!isRecord(v)) return null;
  const { branch, sessionId, clientName, bundleRevision, label } = v;
  if (typeof branch !== 'string' || !isBranchId(branch) || branch === MAIN_BRANCH) return null;
  if (typeof sessionId !== 'string' || !isStorableId(sessionId)) return null;
  if (!shownText(clientName, MAX_CLIENT_NAME)) return null;
  if (!Number.isSafeInteger(bundleRevision) || (bundleRevision as number) < 1) return null;
  if (!shownText(label, MAX_REVIEW_LABEL)) return null;
  return { branch, sessionId, clientName, bundleRevision: bundleRevision as number, label };
}

/**
 * One version record, checked field by field (it may come from an imported file): exactly the
 * known fields are kept. Null when anything is off, a review reference included (and one on a
 * version that is not of main).
 */
function parseVersion(v: unknown): Version | null {
  if (!isRecord(v)) return null;
  const { id, name, description, revision, snapshotSha256, createdAt, branch, serverRev, review } =
    v;
  if (typeof id !== 'string' || !VERSION_ID.test(id)) return null;
  if (typeof name !== 'string' || typeof description !== 'string') return null;
  const meta = versionMeta({ name, description });
  if (typeof meta === 'string' || meta.name !== name) return null;
  if (serverRev !== undefined && (!Number.isSafeInteger(serverRev) || (serverRev as number) < 0)) {
    return null;
  }
  // Revision 0 is a version from the server that names no revision saved here.
  const least = serverRev === undefined ? 1 : 0;
  if (!Number.isSafeInteger(revision) || (revision as number) < least) return null;
  if (typeof snapshotSha256 !== 'string' || !isSha256(snapshotSha256)) return null;
  if (typeof createdAt !== 'string' || createdAt.length > 64 || Number.isNaN(Date.parse(createdAt)))
    return null;
  // Main is recorded by leaving the field out, as versions made before branches are.
  if (branch !== undefined && (typeof branch !== 'string' || !isBranchId(branch))) return null;
  if (branch === MAIN_BRANCH) return null;
  let reviewed: ReviewReference | null = null;
  if (review !== undefined) {
    reviewed = parseReviewReference(review);
    if (!reviewed || branch !== undefined) return null;
  }
  return {
    id,
    name,
    description,
    revision: revision as number,
    snapshotSha256,
    createdAt,
    ...(branch === undefined ? {} : { branch }),
    ...(serverRev === undefined ? {} : { serverRev: serverRev as number }),
    ...(reviewed ? { review: reviewed } : {}),
  };
}

/** The branch a version names a revision of. */
export const versionBranch = (v: Pick<Version, 'branch'>): string => v.branch ?? MAIN_BRANCH;

/** A branch's name as given: trimmed, 1 to MAX_DOCUMENT_NAME characters. */
function branchName(name: unknown): string | null {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  return trimmed.length > 0 && trimmed.length <= MAX_DOCUMENT_NAME ? trimmed : null;
}

/**
 * A branch's provenance, checked field by field (other fields are left out). Null when anything
 * is off: a session id that is not a storable id, a client name that is empty, longer than
 * MAX_CLIENT_NAME, padded, holding control or format characters (Unicode Cc and Cf: bidi
 * overrides, zero-width marks) or a lone surrogate, or an unknown review state. Lenient about
 * the review state, which any of `REVIEW_STATES` may be: this reads stored branches. A new
 * branch takes `newProvenance`.
 */
export function parseProvenance(v: unknown): BranchProvenance | null {
  if (!isRecord(v)) return null;
  const { origin, sessionId, clientName, review } = v;
  if (origin !== 'agent') return null;
  if (typeof sessionId !== 'string' || !isStorableId(sessionId)) return null;
  if (
    typeof clientName !== 'string' ||
    clientName.length === 0 ||
    clientName.length > MAX_CLIENT_NAME ||
    clientName.trim() !== clientName ||
    /[\p{Cc}\p{Cf}\p{Cs}]/u.test(clientName)
  ) {
    return null;
  }
  if (typeof review !== 'string' || !REVIEW_STATES.includes(review as ReviewState)) return null;
  return { origin, sessionId, clientName, review: review as ReviewState };
}

/**
 * The provenance of a branch about to be made: as `parseProvenance` checks it, and only in
 * review state `open`, since a new branch has not been reviewed. A string saying what is wrong.
 */
function newProvenance(v: unknown): BranchProvenance | string {
  const parsed = parseProvenance(v);
  if (!parsed) return 'The branch provenance is invalid.';
  if (parsed.review !== 'open') return 'A new agent branch starts in review state "open".';
  return parsed;
}

/**
 * One branch record, checked field by field. Null when anything is off, provenance included: a
 * damaged provenance never reads as a person's branch.
 */
function parseBranch(v: unknown): Branch | null {
  if (!isRecord(v)) return null;
  const { id, name, fromVersion, createdAt, provenance } = v;
  if (typeof id !== 'string' || !isBranchId(id) || id === MAIN_BRANCH) return null;
  if (typeof name !== 'string' || branchName(name) !== name) return null;
  if (typeof fromVersion !== 'string' || !VERSION_ID.test(fromVersion)) return null;
  if (typeof createdAt !== 'string' || createdAt.length > 64 || Number.isNaN(Date.parse(createdAt)))
    return null;
  if (provenance === undefined) return { id, name, fromVersion, createdAt };
  const parsed = parseProvenance(provenance);
  return parsed ? { id, name, fromVersion, createdAt, provenance: parsed } : null;
}

/**
 * A list of branch records (main left out): each valid, ids and names unique (and none named
 * as main), at most MAX_BRANCHES. Null otherwise.
 */
function parseBranches(value: unknown): Branch[] | null {
  if (!Array.isArray(value) || value.length > MAX_BRANCHES) return null;
  const out: Branch[] = [];
  const ids = new Set<string>();
  const names = new Set<string>([MAIN_BRANCH_NAME]);
  for (const v of value) {
    const branch = parseBranch(v);
    if (!branch || ids.has(branch.id) || names.has(branch.name)) return null;
    ids.add(branch.id);
    names.add(branch.name);
    out.push(branch);
  }
  return out;
}

/** A list of version records: each valid, ids unique, at most MAX_VERSIONS. Null otherwise. */
export function parseVersions(value: unknown): Version[] | null {
  if (!Array.isArray(value) || value.length > MAX_VERSIONS) return null;
  const out: Version[] = [];
  const ids = new Set<string>();
  for (const v of value) {
    const version = parseVersion(v);
    if (!version || ids.has(version.id)) return null;
    ids.add(version.id);
    out.push(version);
  }
  return out;
}

/**
 * A list the main head commits by number: the named versions (`versions-<n>.json`) or the
 * branches (`branches-<n>.json`). Both follow one rule: the n-th write of the list is a new
 * file, then the head naming it is the commit.
 */
interface ListKind<T> {
  /** The head's field naming the current list, and the file's field holding the items. */
  field: 'versions' | 'branches';
  pattern: RegExp;
  file: (n: number) => string;
  format: string;
  parse: (value: unknown) => T[] | null;
  /** For messages: "Its list of <noun> is damaged." */
  noun: string;
}

const VERSION_LIST: ListKind<Version> = {
  field: 'versions',
  pattern: VERSIONS,
  file: versionsName,
  format: 'manufakture-versions',
  parse: parseVersions,
  noun: 'versions',
};

const BRANCH_LIST: ListKind<Branch> = {
  field: 'branches',
  pattern: BRANCHES,
  file: branchesName,
  format: 'manufakture-branches',
  parse: parseBranches,
  noun: 'branches',
};

/** List file `n` of document `id`, or null when it is missing, torn or of the wrong shape. */
function parseListFile<T>(
  kind: ListKind<T>,
  bytes: Uint8Array | null,
  id: string,
  n: number,
): T[] | null {
  if (!bytes) return null;
  let v: unknown;
  try {
    v = JSON.parse(decoder.decode(bytes));
  } catch {
    return null;
  }
  if (!isRecord(v) || v.format !== kind.format || v.id !== id || v.generation !== n) return null;
  return kind.parse(v[kind.field]);
}

/** List file `n` of document `id` holding `items`, as written. */
function listFile<T>(kind: ListKind<T>, id: string, n: number, items: readonly T[]): Uint8Array {
  const file = { format: kind.format, id, generation: n, [kind.field]: items };
  return encoder.encode(`${JSON.stringify(file, null, 2)}\n`);
}

/** A list as read: which one (`n`, 0 for none) and what it holds. */
type ListRead<T> =
  | {
      ok: true;
      n: number;
      items: T[];
      /** The list `n` is missing and this is an older one: items may be missing from it. */
      fallback?: boolean;
    }
  | { ok: false; message: string };

/** Whether `name` is a snapshot or log above `rev`, or a list above the one `lists` names. */
function isStale(name: string, rev: number, lists: Lists): boolean {
  const later = (SNAPSHOT.exec(name) ?? LOG.exec(name))?.[1];
  if (later !== undefined) return Number(later) > rev;
  const versions = VERSIONS.exec(name)?.[1];
  if (versions !== undefined) return Number(versions) > lists.versions;
  const sync = SYNC.exec(name)?.[1];
  if (sync !== undefined) return Number(sync) > (lists.sync ?? 0);
  const branches = BRANCHES.exec(name)?.[1];
  return branches !== undefined && Number(branches) > lists.branches;
}

const NO_LISTS: Lists = { versions: 0, branches: 0, sync: 0 };

/** The parsed file `sync-<n>.json` of document `id`, or null when it is missing, torn or wrong. */
function parseSyncFile(
  bytes: Uint8Array | null,
  id: string,
  n: number,
): {
  revision: number;
  server: string;
  clientKey: string;
  confirmed: unknown;
  state: unknown;
  uploads?: SyncUploads;
} | null {
  if (!bytes) return null;
  let v: unknown;
  try {
    v = JSON.parse(decoder.decode(bytes));
  } catch {
    return null;
  }
  if (!isRecord(v) || v.format !== 'manufakture-sync' || v.id !== id || v.generation !== n) {
    return null;
  }
  const ok =
    Number.isInteger(v.revision) &&
    (v.revision as number) > 0 &&
    typeof v.server === 'string' &&
    typeof v.clientKey === 'string' &&
    isRecord(v.confirmed) &&
    isRecord(v.state);
  const uploads = v.uploads === undefined ? undefined : parseUploads(v.uploads);
  return ok && uploads !== null
    ? {
        revision: v.revision as number,
        server: v.server as string,
        clientKey: v.clientKey as string,
        confirmed: v.confirmed,
        state: v.state,
        ...(uploads && { uploads }),
      }
    : null;
}

/** How a warning names a branch: nothing for main, " (branch <id>)" for the others. */
const onBranch = (branch: string) => (branch === MAIN_BRANCH ? '' : ` (branch ${branch})`);

/** Why a stored or imported document could not be read. */
export interface DecodeFailure {
  ok: false;
  message: string;
  /** Written by a newer app: refused, never modified, and no older copy is tried instead. */
  newer: boolean;
  /** The text is whole JSON (not a file cut short): what failed is the document in it. */
  complete: boolean;
}

/**
 * Read a document in storage form (a snapshot, or an `.mfk`'s `document.json`): parse the
 * JSON, refuse a newer format, put back the imported files from `read` (each checked against
 * its SHA-256 and size), then run core's migrations and validation.
 */
export async function decodeStored(
  text: string,
  read: (sha256: string) => Promise<Uint8Array | null>,
): Promise<{ ok: true; document: ManufaktureDocument; migrated: boolean } | DecodeFailure> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      newer: false,
      complete: false,
      message: `The document is not valid JSON: ${why}`,
    };
  }
  // Refuse a newer file before touching it, with core's message.
  const peek = migrateJson(value);
  if (!peek.ok) {
    return {
      ok: false,
      newer: peek.error.code === 'version',
      complete: true,
      message: peek.error.message,
    };
  }
  // The imported files go back in before the migrations run: every format version so far keeps
  // an import's `source` (with `sha256`, `size`, `fileName`) where hydrateFrom looks for it. A
  // future migration that moves imports must hydrate after migrating instead, or blobs would
  // silently not be found (and the document then fails validation, never loads wrong data).
  let hydrated: unknown;
  try {
    hydrated = await hydrateFrom(value, read);
  } catch (e) {
    return {
      ok: false,
      newer: false,
      complete: true,
      message: e instanceof Error ? e.message : String(e),
    };
  }
  const parsed = parseDocument(hydrated);
  if (!parsed.ok) {
    return {
      ok: false,
      newer: false,
      complete: true,
      message: `The document is invalid: ${parsed.error.message}`,
    };
  }
  return { ok: true, document: parsed.value.document, migrated: parsed.value.migrated };
}

/** The storage form of a document: canonical JSON with imported files taken out. */
export function encodeStored(doc: ManufaktureDocument): {
  text: string;
  blobs: Map<string, string>;
  /** Total size of the imported files. */
  blobBytes: number;
} {
  const { value, blobs } = externalize(JSON.parse(serialize(doc)));
  const blobBytes = blobRefs(value).reduce((n, r) => n + r.size, 0);
  return { text: `${JSON.stringify(value, null, 2)}\n`, blobs, blobBytes };
}

/**
 * Whether `doc` is what the stored snapshot holds: its storage form has the snapshot's SHA-256,
 * or (a snapshot written in an older format, which reads migrated) the two serialize alike.
 */
async function sameStored(
  doc: ManufaktureDocument,
  stored: { bytes: Uint8Array; document: ManufaktureDocument },
): Promise<boolean> {
  const text = encodeStored(doc).text;
  if ((await sha256Hex(encoder.encode(text))) === (await sha256Hex(stored.bytes))) return true;
  return serialize(doc) === serialize(stored.document);
}

export interface LibraryOptions {
  now?: () => Date;
  newId?: () => string;
  /** Locks across tabs; default the browser's Web Locks. Null: none (one tab only). */
  locks?: DocumentLocks | null;
  /** Where recoveries worth knowing about are reported; default `console.warn`. */
  warn?: (message: string) => void;
}

/** A readable revision of a document, found without changing anything. */
interface Found {
  rev: number;
  bytes: Uint8Array;
  document: ManufaktureDocument;
  migrated: boolean;
  head: Head | null;
  names: string[];
  /** The head names this revision, but records another SHA-256 for it. */
  mismatch: boolean;
  /** Later snapshots that are complete but do not read as this document, and why. */
  damaged: { rev: number; bytes: Uint8Array; message: string }[];
}

type FindResult = { ok: true; found: Found } | { ok: false; message: string; newer?: true };

export class DocumentLibrary {
  readonly #backend: StorageBackend;
  readonly #now: () => Date;
  readonly #newId: () => string;
  readonly #locks: DocumentLocks | null;
  readonly #warn: (message: string) => void;
  readonly #blobStores = new Map<string, BlobStore>();
  readonly #listeners = new Set<(change: LibraryChange) => void>();
  #remote: RemoteVersionSource | null = null;
  /** Operations run one at a time, so two saves never interleave their files. */
  #queue: Promise<unknown> = Promise.resolve();
  /**
   * Per document and branch (`#key`): the revision this library last opened or saved (what it
   * builds on).
   */
  readonly #known = new Map<string, number>();
  /**
   * Per document and branch: the snapshot this library last wrote, committed or not (its own
   * work), and the log entries written with it.
   */
  readonly #written = new Map<
    string,
    { revision: number; sha256: string; entries: readonly LogEntry[] }
  >();

  constructor(backend: StorageBackend, options: LibraryOptions = {}) {
    this.#backend = backend;
    this.#now = options.now ?? (() => new Date());
    this.#newId = options.newId ?? (() => crypto.randomUUID());
    this.#locks = options.locks === undefined ? browserLocks() : options.locks;
    this.#warn = options.warn ?? ((message) => console.warn(message));
  }

  /** Where the documents are: OPFS, IndexedDB, or memory (nothing survives a reload). */
  get kind(): BackendKind {
    return this.#backend.kind;
  }

  /**
   * Calls `listener` whenever this library changed a document's versions or branches (made,
   * renamed, deleted, or kept from the sync server). Changes other tabs make are not reported.
   * Returns the function that stops it.
   */
  subscribe(listener: (change: LibraryChange) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * Where `readVersion` looks for a version this browser does not hold (the sync server, T7.1e),
   * or null for nowhere. A version found there is kept with its document when the document is
   * here (`adoptVersion`), so a pin by `documentId` plus `versionId` resolves offline after that.
   */
  setRemoteVersions(source: RemoteVersionSource | null): void {
    this.#remote = source;
  }

  /** `result`, after telling the subscribers when it succeeded. */
  async #notify<T>(
    id: string,
    kind: LibraryChange['kind'],
    result: Promise<LibraryResult<T>>,
  ): Promise<LibraryResult<T>> {
    const r = await result;
    if (r.ok) {
      for (const listener of [...this.#listeners]) {
        try {
          listener({ id, kind });
        } catch (e) {
          this.#warn(`manufakture: a library listener failed: ${String(e)}`);
        }
      }
    }
    return r;
  }

  #run<T>(op: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(op, op);
    this.#queue = next.catch(() => undefined);
    return next;
  }

  /** Run `op` holding document `id`'s lock (across tabs), when there are locks. */
  #locked<T>(id: string, op: () => Promise<T>): Promise<T> {
    return this.#locks ? this.#locks.request(`manufakture-document-${id}`, op) : op();
  }

  /** The directory of document `id`'s branch `branch`: the document's own one for main. */
  #dir(id: string, branch: string = MAIN_BRANCH): string {
    if (!isStorableId(id)) throw new Error(`Cannot store a document with the id "${id}"`);
    if (branch === MAIN_BRANCH) return `${ROOT}/${id}`;
    if (!isBranchId(branch)) throw new Error(`Cannot store a branch with the id "${branch}"`);
    return `${ROOT}/${id}/${BRANCH_DIR}/${branch}`;
  }

  /** The key of a document's branch in the per-branch maps. */
  #key(id: string, branch: string): string {
    return branch === MAIN_BRANCH ? id : `${id}/${branch}`;
  }

  #blobs(id: string): BlobStore {
    let store = this.#blobStores.get(id);
    if (!store) {
      store = new BlobStore(this.#backend, `${this.#dir(id)}/blobs`);
      this.#blobStores.set(id, store);
    }
    return store;
  }

  async #head(id: string, branch: string = MAIN_BRANCH): Promise<Head | null> {
    return parseHead(await this.#backend.read(`${this.#dir(id, branch)}/${HEAD}`), id);
  }

  /**
   * Every document, most recently saved first. Damaged ones are listed with the reason. Only
   * reads: a document without a readable head is described from its newest readable snapshot,
   * and repaired when it is opened.
   */
  list(): Promise<DocumentSummary[]> {
    return this.#run(async () => {
      const out: DocumentSummary[] = [];
      for (const id of await this.#backend.list(ROOT)) {
        if (!isStorableId(id)) continue;
        const head = await this.#head(id);
        if (head) {
          out.push(summaryOf(head));
          continue;
        }
        const found = await this.#find(id);
        if (found.ok) {
          const { document, bytes, rev } = found.found;
          const stored = blobRefs(JSON.parse(decoder.decode(bytes))).reduce(
            (n, r) => n + r.size,
            0,
          );
          out.push({
            id,
            name: document.name,
            createdAt: '',
            savedAt: '',
            revision: rev,
            bytes: bytes.length + stored,
          });
        } else {
          out.push({
            id,
            name: id,
            createdAt: '',
            savedAt: '',
            revision: 0,
            bytes: 0,
            damaged: found.message,
          });
        }
      }
      return out.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
    });
  }

  /** Whether a document with this id is stored. */
  has(id: string): Promise<boolean> {
    return this.#run(
      async () => isStorableId(id) && (await this.#backend.list(this.#dir(id))).length > 0,
    );
  }

  /**
   * Read a document: the newest revision that reads completely (see the top of the file). This
   * library then builds on that revision: its next save of the document conflicts if another
   * tab saves in between.
   */
  open(id: string, branch: string = MAIN_BRANCH): Promise<LibraryResult<Opened>> {
    return this.#run(async () => {
      if (!isStorableId(id)) return { ok: false, message: `There is no document "${id}".` };
      if (!isBranchId(branch)) return NO_BRANCH;
      return this.#locked(id, async () => {
        if (branch !== MAIN_BRANCH) {
          const listed = await this.#branch(id, branch);
          if (!listed.ok) return listed;
        }
        const opened = await this.#open(id, branch);
        if (opened.ok) this.#known.set(this.#key(id, branch), opened.value.revision);
        return opened;
      });
    });
  }

  /**
   * Branch `branch` (not main) of document `id`, as the branch list records it: refused when
   * the list does not name it (never made, deleted, or made by a change that did not commit).
   */
  async #branch(id: string, branch: string): Promise<LibraryResult<Branch>> {
    const names = await this.#backend.list(this.#dir(id));
    if (names.length === 0) return { ok: false, message: `There is no document "${id}".` };
    const listed = await this.#readList(BRANCH_LIST, id, await this.#head(id), names);
    if (!listed.ok) return listed;
    const found = listed.items.find((b) => b.id === branch);
    return found ? { ok: true, value: found } : NO_BRANCH;
  }

  /** The newest revision that reads completely; changes nothing. */
  async #find(id: string, branch: string = MAIN_BRANCH): Promise<FindResult> {
    const dir = this.#dir(id, branch);
    const names = await this.#backend.list(dir);
    const snapshots = revisions(names, SNAPSHOT);
    if (snapshots.length === 0) {
      return {
        ok: false,
        message:
          names.length === 0 ? `There is no document "${id}".` : 'No saved copy of it can be read.',
      };
    }
    const head = await this.#head(id, branch);
    const blobs = this.#blobs(id);
    let firstError: string | null = null;
    const damaged: Found['damaged'] = [];
    for (const rev of snapshots) {
      const bytes = await this.#backend.read(`${dir}/${snapshotName(rev)}`);
      if (!bytes) continue;
      // A snapshot the head names but with another SHA-256 is still used when it reads as a
      // valid document of this id: two tabs saving at once without locks can leave one tab's
      // head over the other's snapshot, and both are real work. Falling back would lose it.
      const mismatch = head?.revision === rev && (await sha256Hex(bytes)) !== head.snapshotSha256;
      const decoded = await decodeStored(decoder.decode(bytes), (sha) => blobs.read(sha));
      if (!decoded.ok) {
        if (decoded.newer) return { ok: false, message: decoded.message, newer: true };
        firstError ??= mismatch ? 'Its latest saved copy is damaged.' : decoded.message;
        if (decoded.complete) damaged.push({ rev, bytes, message: decoded.message });
        continue;
      }
      if (decoded.document.id !== id) {
        firstError ??= 'A saved copy belongs to another document.';
        damaged.push({ rev, bytes, message: 'It belongs to another document.' });
        continue;
      }
      return {
        ok: true,
        found: {
          rev,
          bytes,
          document: decoded.document,
          migrated: decoded.migrated,
          head,
          names,
          mismatch,
          damaged,
        },
      };
    }
    return { ok: false, message: firstError ?? 'No saved copy of it can be read.' };
  }

  /** `#find`, then repair the head when it does not name what was found, and tidy up. */
  async #open(id: string, branch: string = MAIN_BRANCH): Promise<LibraryResult<Opened>> {
    const r = await this.#find(id, branch);
    if (!r.ok) return r;
    const { rev, bytes, document, migrated, head, names, mismatch, damaged } = r.found;
    // Keep what is about to be passed over: the originals are deleted below once they lie
    // above the head.
    for (const d of damaged) await this.#quarantine(id, branch, d, names);
    const where = onBranch(branch);
    if (mismatch) {
      this.#warn(
        `manufakture: revision ${rev} of document ${id}${where} does not match the SHA-256 its ` +
          'head records, but reads as a valid document; it is used, and the head is corrected.',
      );
    }
    const recovered = head?.revision !== rev || mismatch;
    // The lists the main head names; without a head, the newest ones that read (a list is
    // complete before the head naming it is written, so a torn head leaves the new one). A
    // branch's head names none.
    let lists = branch === MAIN_BRANCH ? await this.#lists(id, head, names) : NO_LISTS;
    // The sync state that belongs to the revision found: what the head names, or after a crash
    // the newest file saved with that revision (written before the head that would name it).
    if (branch === MAIN_BRANCH && recovered) {
      lists = { ...lists, sync: await this.#syncFor(id, rev, names) };
    }
    if (recovered) await this.#repair(id, branch, rev, bytes, document, head, lists);
    // Only what lies above both the head and the revision found: never the snapshot the head
    // named (even when it could not be read) or anything below it.
    await this.#dropAbove(id, branch, Math.max(rev, head?.revision ?? rev), names, lists);
    return { ok: true, value: { document, migrated, recovered, revision: rev } };
  }

  /** Which lists the main head commits: as it names them, else the newest that read. */
  async #lists(id: string, head: Head | null, names: readonly string[]): Promise<Lists> {
    const versions = await this.#readList(VERSION_LIST, id, head, names);
    const branches = await this.#readList(BRANCH_LIST, id, head, names);
    return {
      versions: versions.ok ? versions.n : (head?.versions ?? 0),
      branches: branches.ok ? branches.n : (head?.branches ?? 0),
      sync: head?.sync ?? 0,
    };
  }

  /** The newest `sync-<n>.json` that reads and was saved with revision `rev`, or 0. */
  async #syncFor(id: string, rev: number, names: readonly string[]): Promise<number> {
    const dir = this.#dir(id);
    for (const n of revisions(names, SYNC)) {
      const file = parseSyncFile(await this.#backend.read(`${dir}/${syncName(n)}`), id, n);
      if (file?.revision === rev) return n;
    }
    return 0;
  }

  /**
   * Copy a complete snapshot that does not read, and its log segment, to names no snapshot or
   * log pattern matches, so no recovery or save ever deletes them (deleting the document does).
   */
  async #quarantine(
    id: string,
    branch: string,
    damaged: Found['damaged'][number],
    names: readonly string[],
  ): Promise<void> {
    const dir = this.#dir(id, branch);
    const sha = await sha256Hex(damaged.bytes);
    const snapshotCopy = damagedName('snapshot', damaged.rev, sha);
    if (names.includes(snapshotCopy)) return;
    const log = names.includes(logName(damaged.rev))
      ? await this.#backend.read(`${dir}/${logName(damaged.rev)}`)
      : null;
    if (log) await this.#backend.write(`${dir}/${damagedName('log', damaged.rev, sha)}`, log);
    // The snapshot last: its copy existing means both are kept.
    await this.#backend.write(`${dir}/${snapshotCopy}`, damaged.bytes);
    this.#warn(
      `manufakture: revision ${damaged.rev} of document ${id}${onBranch(branch)} is complete ` +
        'but cannot be read ' +
        `(${damaged.message}); it is kept as ${snapshotCopy}.`,
    );
  }

  /** Point the head at `rev`, the snapshot recovered. */
  async #repair(
    id: string,
    branch: string,
    rev: number,
    snapshot: Uint8Array,
    doc: ManufaktureDocument,
    old: Head | null,
    lists: Lists,
  ): Promise<void> {
    const dir = this.#dir(id, branch);
    const now = this.#now().toISOString();
    const head: Head = {
      format: 'manufakture-head',
      id,
      name: doc.name,
      revision: rev,
      snapshotSha256: await sha256Hex(snapshot),
      snapshotBytes: snapshot.length,
      blobBytes: blobRefs(JSON.parse(decoder.decode(snapshot))).reduce((n, r) => n + r.size, 0),
      createdAt: old?.createdAt ?? now,
      savedAt: old?.savedAt ?? now,
      ...lists,
    };
    await this.#backend.write(
      `${dir}/${HEAD}`,
      encoder.encode(`${JSON.stringify(head, null, 2)}\n`),
    );
  }

  /**
   * Delete the logs and snapshots above revision `rev`, and the lists above the ones `lists`
   * names: what a save or a list change that died left behind.
   */
  async #dropAbove(
    id: string,
    branch: string,
    rev: number,
    names: readonly string[],
    lists: Lists,
  ): Promise<void> {
    const dir = this.#dir(id, branch);
    for (const name of names) {
      if (isStale(name, rev, lists)) await this.#backend.remove(`${dir}/${name}`);
    }
  }

  /**
   * The list of `kind` the main head names (`n` is its number); without a head, the newest list
   * that reads. Changes nothing.
   */
  async #readList<T>(
    kind: ListKind<T>,
    id: string,
    head: Head | null,
    names?: readonly string[],
  ): Promise<ListRead<T>> {
    const dir = this.#dir(id);
    const read = async (n: number) =>
      parseListFile(kind, await this.#backend.read(`${dir}/${kind.file(n)}`), id, n);
    if (head) {
      const n = head[kind.field];
      if (n === 0) return { ok: true, n: 0, items: [] };
      const bytes = await this.#backend.read(`${dir}/${kind.file(n)}`);
      const items = parseListFile(kind, bytes, id, n);
      if (items) return { ok: true, n, items };
      if (bytes) return { ok: false, message: `Its list of ${kind.noun} is damaged.` };
      // Missing: without Web Locks, another tab can delete a list as stale between its write
      // and the head naming it. The spare (the list before) is kept for that; read the newest
      // older list that reads, still as list `n`, so the next change writes above it.
      const older = revisions(names ?? (await this.#backend.list(dir)), kind.pattern).filter(
        (m) => m < n,
      );
      for (const m of older) {
        const list = await read(m);
        if (list) return { ok: true, n, items: list, fallback: true };
      }
      return { ok: false, message: `Its list of ${kind.noun} is missing.` };
    }
    for (const n of revisions(names ?? (await this.#backend.list(dir)), kind.pattern)) {
      const items = await read(n);
      if (items) return { ok: true, n, items };
    }
    return { ok: true, n: 0, items: [] };
  }

  /** Whether revision `rev`'s log segment starts a history (`base: null`): nothing leads to it. */
  async #isRoot(
    id: string,
    branch: string,
    rev: number,
    names: readonly string[],
  ): Promise<boolean> {
    if (!names.includes(logName(rev))) return false;
    const bytes = await this.#backend.read(`${this.#dir(id, branch)}/${logName(rev)}`);
    if (!bytes) return false;
    try {
      const segment: unknown = JSON.parse(decoder.decode(bytes));
      return isLogSegment(segment, rev) && segment.base === null;
    } catch {
      return false;
    }
  }

  /**
   * Save `doc` as a new revision of branch `branch` (default: main), with `entries` (the
   * commands since the last save) as its log segment. Throws when storage fails; the previous revision is then still there. Throws a
   * `RevisionConflict`, having written nothing, when another tab saved the branch since this
   * library last opened or saved it, and a `BranchDeleted` when the branch is gone.
   */
  save(
    doc: ManufaktureDocument,
    entries: readonly LogEntry[] = [],
    branch?: string,
    sync?: SyncRecord,
  ): Promise<DocumentSummary> {
    const on = branch ?? MAIN_BRANCH;
    if (sync !== undefined && on !== MAIN_BRANCH) {
      return Promise.reject(new Error('Only the main branch of a document syncs.'));
    }
    return this.#run(() => this.#locked(doc.id, () => this.#save(doc, entries, on, sync)));
  }

  /** Whether `head` commits the snapshot this library itself last wrote on the branch. */
  #ours(id: string, branch: string, head: Head): boolean {
    const w = this.#written.get(this.#key(id, branch));
    return w?.revision === head.revision && w.sha256 === head.snapshotSha256;
  }

  #checkRevision(id: string, branch: string, head: Head | null): void {
    const known = this.#known.get(this.#key(id, branch));
    if (head && known !== undefined && head.revision !== known && !this.#ours(id, branch, head)) {
      throw new RevisionConflict(id, head.revision, known);
    }
  }

  async #save(
    doc: ManufaktureDocument,
    entries: readonly LogEntry[],
    branch: string = MAIN_BRANCH,
    sync?: SyncRecord,
  ): Promise<DocumentSummary> {
    const id = doc.id;
    const key = this.#key(id, branch);
    const main = branch === MAIN_BRANCH;
    const dir = this.#dir(id, branch);
    if (!main) {
      // Never write a branch the list does not name: it was deleted (and the files written
      // would be an orphan the next branch change deletes).
      const listed = await this.#branch(id, branch);
      if (!listed.ok) {
        if (listed.noBranch) {
          throw new BranchDeleted(id, branch, this.#known.get(key) ?? 0);
        }
        throw new Error(listed.message);
      }
    }
    let names = await this.#backend.list(dir);
    let head = await this.#head(id, branch);
    if (!head && revisions(names, SNAPSHOT).length > 0) {
      // A damaged or missing head over saved copies: recover it first, so the save builds on
      // (and keeps) the last good revision rather than guessing.
      await this.#open(id, branch);
      names = await this.#backend.list(dir);
      head = await this.#head(id, branch);
    }
    this.#checkRevision(id, branch, head);

    // This library's previous save committed (its head is there) but reported a failure, say
    // the head write threw after the bytes landed: the caller retries with those commands first,
    // and they are logged already.
    let fresh = entries;
    const written = this.#written.get(key);
    if (head && written && head.revision !== this.#known.get(key) && this.#ours(id, branch, head)) {
      const logged = written.entries;
      if (logged.length > 0 && logged.every((e, i) => fresh[i] === e)) {
        fresh = fresh.slice(logged.length);
      }
    }

    // Whatever lies above the head is from a save that did not finish (this library's own
    // failed attempt, when it retries): delete it, so the log holds each command once. The same
    // for lists above the ones the head names. Without a head (and no snapshot that reads), the
    // newest lists that read are kept and named by the new head: never lost. A branch's
    // directory holds no lists.
    let lists: Lists = head
      ? { versions: head.versions, branches: head.branches, sync: head.sync ?? 0 }
      : NO_LISTS;
    if (!head && main) lists = await this.#lists(id, null, names);
    const stale = names.filter((n) => isStale(n, head?.revision ?? Infinity, lists));
    for (const name of stale) await this.#backend.remove(`${dir}/${name}`);
    names = names.filter((n) => !stale.includes(n));
    // The revisions the versions name are kept below (step 6); read before anything is written.
    // The version list is the document's, in the main directory, whichever branch this is.
    const listed = head
      ? await this.#readList(
          VERSION_LIST,
          id,
          main ? head : await this.#head(id),
          main ? names : undefined,
        )
      : null;
    const rev = head
      ? head.revision + 1
      : Math.max(0, ...revisions(names, SNAPSHOT), ...revisions(names, LOG)) + 1;

    const stored = encodeStored(doc);
    const blobs = this.#blobs(id);
    for (const [sha, data] of stored.blobs) await blobs.put(sha, data);

    if (fresh.length > 0) {
      const logged = externalize(fresh);
      for (const [sha, data] of logged.blobs) await blobs.put(sha, data);
      const segment: LogSegment = {
        format: 'manufakture-log',
        revision: rev,
        base: head?.revision ?? null,
        entries: logged.value as unknown[],
      };
      await this.#backend.write(
        `${dir}/${logName(rev)}`,
        encoder.encode(`${JSON.stringify(segment)}\n`),
      );
    }

    // The sync state of this revision, before its snapshot: the head commits both at once.
    if (sync !== undefined) {
      const n = (lists.sync ?? 0) + 1;
      await this.#writeSync(id, n, rev, sync);
      lists = { ...lists, sync: n };
    }

    const snapshot = encoder.encode(stored.text);
    const snapshotSha256 = await sha256Hex(snapshot);
    await this.#backend.write(`${dir}/${snapshotName(rev)}`, snapshot);
    this.#written.set(key, { revision: rev, sha256: snapshotSha256, entries: fresh });

    // Without locks another tab may have committed meanwhile (a save, or a list whose head this
    // one would overwrite): look again before the commit.
    const current = await this.#head(id, branch);
    if (
      (current?.revision ?? null) !== (head?.revision ?? null) ||
      (current?.snapshotSha256 ?? null) !== (head?.snapshotSha256 ?? null) ||
      (current?.versions ?? null) !== (head?.versions ?? null) ||
      (current?.branches ?? null) !== (head?.branches ?? null) ||
      (current?.sync ?? null) !== (head?.sync ?? null)
    ) {
      throw new RevisionConflict(id, current?.revision ?? 0, head?.revision ?? 0);
    }
    // The same for the branch itself: without locks another tab may have deleted it since the
    // check above, and committed that before removing its directory. A head written now would
    // land in a directory no list names, and the save would look done while the next branch
    // change deletes it.
    if (!main) {
      const still = await this.#branch(id, branch);
      if (!still.ok && still.noBranch) {
        throw new BranchDeleted(id, branch, this.#known.get(key) ?? 0);
      }
    }

    const now = this.#now().toISOString();
    const next: Head = {
      format: 'manufakture-head',
      id,
      name: doc.name,
      revision: rev,
      snapshotSha256,
      snapshotBytes: snapshot.length,
      blobBytes: stored.blobBytes,
      createdAt: head?.createdAt ?? now,
      savedAt: now,
      ...lists,
    };
    await this.#backend.write(
      `${dir}/${HEAD}`,
      encoder.encode(`${JSON.stringify(next, null, 2)}\n`),
    );
    this.#known.set(key, rev);

    // The new revision is committed. The one the head named before stays as the spare; older
    // snapshots go, except the history: what a version names, the checkpoints, and a revision
    // nothing leads to (the first of an imported history). Best effort.
    if (head) await this.#prune(id, branch, head.revision, names, listed).catch(() => undefined);
    if (head && sync !== undefined) await this.#pruneSync(id, head.sync ?? 0);
    return summaryOf(next);
  }

  /** Write `sync-<n>.json`: `record` as saved with revision `rev`, its files as blobs. */
  async #writeSync(id: string, n: number, rev: number, record: SyncRecord): Promise<void> {
    const blobs = this.#blobs(id);
    const confirmed = encodeStored(record.confirmed);
    for (const [sha, data] of confirmed.blobs) await blobs.put(sha, data);
    const state = externalize(record.state);
    for (const [sha, data] of state.blobs) await blobs.put(sha, data);
    const file = {
      format: 'manufakture-sync',
      id,
      generation: n,
      revision: rev,
      server: record.server,
      clientKey: record.clientKey,
      confirmed: JSON.parse(confirmed.text) as unknown,
      state: state.value,
      ...(record.uploads && { uploads: record.uploads }),
    };
    await this.#backend.write(
      `${this.#dir(id)}/${syncName(n)}`,
      encoder.encode(`${JSON.stringify(file)}\n`),
    );
  }

  /** Delete the sync files below `keep` (best effort): `keep`, the one before, is the spare. */
  async #pruneSync(id: string, keep: number): Promise<void> {
    const dir = this.#dir(id);
    const names = await this.#backend.list(dir).catch(() => [] as string[]);
    for (const n of revisions(names, SYNC)) {
      if (n < keep) await this.#backend.remove(`${dir}/${syncName(n)}`).catch(() => undefined);
    }
  }

  /**
   * Save the sync state alone (T7.1d): for the revision the main head names, which must be what
   * the caller shows (nothing waits to be saved). `sync-<n+1>.json`, then the head naming it, as
   * for a list. Throws `RevisionConflict`, having committed nothing, when another tab saved the
   * document since this library opened or saved it, and when the head moves meanwhile.
   */
  saveSync(id: string, record: SyncRecord): Promise<void> {
    return this.#run(() =>
      this.#locked(id, async () => {
        if (!isStorableId(id)) throw new Error(`There is no document "${id}".`);
        const dir = this.#dir(id);
        const head = await this.#head(id);
        if (!head) throw new Error('The document is not saved yet.');
        this.#checkRevision(id, MAIN_BRANCH, head);
        // What a sync save that died left above the head.
        const names = await this.#backend.list(dir);
        for (const n of revisions(names, SYNC)) {
          if (n > (head.sync ?? 0)) await this.#backend.remove(`${dir}/${syncName(n)}`);
        }
        const n = (head.sync ?? 0) + 1;
        await this.#writeSync(id, n, head.revision, record);
        const current = await this.#head(id);
        if (
          current?.revision !== head.revision ||
          current.snapshotSha256 !== head.snapshotSha256 ||
          current.versions !== head.versions ||
          current.branches !== head.branches ||
          current.sync !== head.sync
        ) {
          throw new RevisionConflict(id, current?.revision ?? 0, head.revision);
        }
        const next: Head = { ...head, sync: n };
        await this.#backend.write(
          `${dir}/${HEAD}`,
          encoder.encode(`${JSON.stringify(next, null, 2)}\n`),
        );
        await this.#pruneSync(id, head.sync ?? 0);
      }),
    );
  }

  /**
   * The sync state the main head names, with its files put back, or null when the document does
   * not sync. When that state cannot be read, the result is a failure, never an older state: an
   * older queue may hand out `clientSeq` values the server has already accepted from the newer
   * one, and the server would answer them with other entries' outcomes. Switching sync off and on
   * again starts over from the server's copy.
   */
  readSync(id: string): Promise<LibraryResult<StoredSync | null>> {
    return this.#run(async () => {
      if (!isStorableId(id)) return { ok: false, message: `There is no document "${id}".` };
      return this.#locked(id, async () => {
        const head = await this.#head(id);
        if (!head || !head.sync) return { ok: true, value: null };
        const n = head.sync;
        const fail = (why: string): LibraryResult<StoredSync | null> => ({
          ok: false,
          message:
            `Its sync state cannot be read${why}. Switch sync off and on again to start over ` +
            "from the server's copy (changes not yet on the server are kept in this browser).",
        });
        const file = parseSyncFile(
          await this.#backend.read(`${this.#dir(id)}/${syncName(n)}`),
          id,
          n,
        );
        if (!file) return fail('');
        const blobs = this.#blobs(id);
        const confirmed = await decodeStored(JSON.stringify(file.confirmed), (sha) =>
          blobs.read(sha),
        );
        if (!confirmed.ok) return fail(`: ${confirmed.message}`);
        let state: unknown;
        try {
          state = await hydrateFrom(file.state, (sha) => blobs.read(sha));
        } catch (e) {
          return fail(`: ${e instanceof Error ? e.message : String(e)}`);
        }
        return {
          ok: true,
          value: {
            record: {
              server: file.server,
              clientKey: file.clientKey,
              confirmed: confirmed.document,
              state,
              ...(file.uploads && { uploads: file.uploads }),
            },
            paired: file.revision === head.revision,
          },
        };
      });
    });
  }

  /** Stop syncing the document: a head naming no sync state (the commit), then its files go. */
  dropSync(id: string): Promise<void> {
    return this.#run(() =>
      this.#locked(id, async () => {
        if (!isStorableId(id)) return;
        const dir = this.#dir(id);
        const head = await this.#head(id);
        if (head?.sync) {
          const next: Head = { ...head, sync: 0 };
          await this.#backend.write(
            `${dir}/${HEAD}`,
            encoder.encode(`${JSON.stringify(next, null, 2)}\n`),
          );
        }
        if (!head) return;
        for (const n of revisions(await this.#backend.list(dir), SYNC)) {
          await this.#backend.remove(`${dir}/${syncName(n)}`).catch(() => undefined);
        }
      }),
    );
  }

  async #prune(
    id: string,
    branch: string,
    spare: number,
    names: readonly string[],
    listed: ListRead<Version> | null,
  ): Promise<void> {
    if (listed && (!listed.ok || listed.fallback)) {
      this.#warn(
        `manufakture: the version list of document ${id} cannot be read; no snapshot is deleted.`,
      );
      return;
    }
    // Only this branch's versions name revisions in this directory.
    const named = new Set(
      (listed?.items ?? []).filter((v) => versionBranch(v) === branch).map((v) => v.revision),
    );
    const dir = this.#dir(id, branch);
    const all = revisions(names, SNAPSHOT);
    // The lowest retained snapshot is where the history starts: a document saved before
    // checkpoints existed keeps it past its first checkpoint.
    const root = Math.min(...all);
    for (const old of all) {
      if (old >= spare || old === root || isCheckpoint(old) || named.has(old)) continue;
      if (await this.#isRoot(id, branch, old, names)) continue;
      await this.#backend.remove(`${dir}/${snapshotName(old)}`).catch(() => undefined);
    }
  }

  /**
   * The log per saved revision, oldest first: each revision with the causes, labels and times of
   * the commands that led to it, without the commands (so no imported file is read). Follows the
   * chain of segments back from the head, as `readLog` does; a save without commands, or one
   * whose segment is gone, is not listed. For the history panel's timeline. Of branch `branch`
   * (default: main).
   */
  readHistory(id: string, branch?: string): Promise<LibraryResult<LoggedRevision[]>> {
    const on = branch ?? MAIN_BRANCH;
    return this.#run(async () => {
      if (!isStorableId(id)) return { ok: false, message: `There is no document "${id}".` };
      if (!isBranchId(on)) return NO_BRANCH;
      const chain = await this.#logChain(id, on);
      if (!chain.ok) return chain;
      return {
        ok: true,
        value: chain.value.map((segment) => ({
          revision: segment.revision,
          entries: (segment.entries as LogEntry[]).map(({ cause, label, at }) => ({
            cause,
            label,
            at,
          })),
        })),
      };
    });
  }

  /** The log segments that lead to the branch's head, oldest first. */
  async #logChain(id: string, branch: string): Promise<LibraryResult<LogSegment[]>> {
    const dir = this.#dir(id, branch);
    const head = await this.#head(id, branch);
    if (!head) return { ok: true, value: [] };
    const present = new Set(revisions(await this.#backend.list(dir), LOG));
    const chain: LogSegment[] = [];
    let rev = head.revision;
    while (rev > 0) {
      const bytes = present.has(rev) ? await this.#backend.read(`${dir}/${logName(rev)}`) : null;
      // A save without commands writes no segment, and started from the revision before.
      if (!bytes) {
        rev -= 1;
        continue;
      }
      let segment: unknown;
      try {
        segment = JSON.parse(decoder.decode(bytes));
      } catch {
        segment = null;
      }
      if (!isLogSegment(segment, rev)) {
        return { ok: false, message: `The command log is damaged at revision ${rev}.` };
      }
      chain.push(segment);
      rev = segment.base ?? 0;
    }
    return { ok: true, value: chain.reverse() };
  }

  /**
   * The command log, oldest first, with imported files put back (and checked). It follows the
   * chain of segments back from the head (each names the revision it started from), so a
   * segment a failed save left behind is never part of it. Of branch `branch` (default: main).
   */
  readLog(id: string, branch?: string): Promise<LibraryResult<LogEntry[]>> {
    const on = branch ?? MAIN_BRANCH;
    return this.#run(async () => {
      if (!isStorableId(id)) return { ok: false, message: `There is no document "${id}".` };
      if (!isBranchId(on)) return NO_BRANCH;
      const blobs = this.#blobs(id);
      const chain = await this.#logChain(id, on);
      if (!chain.ok) return chain;
      const out: LogEntry[] = [];
      try {
        for (const segment of chain.value) {
          const entries = (await hydrateFrom(segment.entries, (sha) =>
            blobs.read(sha),
          )) as LogEntry[];
          out.push(...entries);
        }
      } catch (e) {
        return { ok: false, message: e instanceof Error ? e.message : String(e) };
      }
      return { ok: true, value: out };
    });
  }

  /**
   * Name the stored document's current revision on branch `branch` (default: main): records
   * `{ id, name, description, revision, snapshotSha256, createdAt, branch }` in a new version list, committed by the main head like
   * a save. The snapshot it names is then kept for good. The caller saves first (autosave's
   * `createVersion` does); a library that knows the branch refuses with `RevisionConflict` when
   * another tab saved it meanwhile, since the version would name that tab's work.
   */
  createVersion(id: string, meta: VersionMeta, branch?: string): Promise<LibraryResult<Version>> {
    return this.#notify(id, 'versions', this.#createVersion(id, meta, branch));
  }

  /**
   * With `revision`: name that stored revision of branch `branch` instead of the current one
   * (`branchFromRevision`). Its retained snapshot's SHA-256; a revision no longer kept is
   * rebuilt and its snapshot written again first (`#revisionStamp`).
   * No `RevisionConflict`: the revision is named, not the head.
   */
  #createVersion(
    id: string,
    meta: VersionMeta,
    branch?: string,
    revision?: number,
  ): Promise<LibraryResult<Version>> {
    const on = branch ?? MAIN_BRANCH;
    return this.#run(async () => {
      if (!isStorableId(id)) return { ok: false, message: `There is no document "${id}".` };
      if (!isBranchId(on)) return NO_BRANCH;
      const checked = versionMeta(meta);
      if (typeof checked === 'string') return { ok: false, message: checked };
      let review: ReviewReference | null = null;
      if (meta.review !== undefined) {
        if (on !== MAIN_BRANCH) {
          return { ok: false, message: 'Only a version of the main branch records a review.' };
        }
        review = parseReviewReference(meta.review);
        if (!review) return { ok: false, message: 'The review reference is invalid.' };
      }
      return this.#locked(id, async () => {
        let named: Pick<Head, 'revision' | 'snapshotSha256'> | null = null;
        if (on !== MAIN_BRANCH || revision !== undefined) {
          if (on !== MAIN_BRANCH) {
            const listed = await this.#branch(id, on);
            if (!listed.ok) return listed;
          }
          // Open first: it repairs the branch's head and deletes what a failed save left.
          const opened = await this.#open(id, on);
          if (!opened.ok) return opened;
          const head = await this.#head(id, on);
          if (!head) return { ok: false, message: 'Its head cannot be read.' };
          if (revision === undefined) {
            this.#checkRevision(id, on, head);
            named = head;
          } else if (revision === head.revision) {
            named = head;
          } else {
            const stamp = await this.#revisionStamp(id, on, revision, head.revision);
            if (!stamp.ok) return stamp;
            named = stamp.value;
          }
        }
        return this.#changeList(
          VERSION_LIST,
          id,
          (versions, head) => {
            if (versions.length >= MAX_VERSIONS) {
              return `A document holds at most ${MAX_VERSIONS} versions.`;
            }
            const at = named ?? head;
            const version: Version = {
              id: this.#newId(),
              ...checked,
              revision: at.revision,
              snapshotSha256: at.snapshotSha256,
              createdAt: this.#now().toISOString(),
              ...(on === MAIN_BRANCH ? {} : { branch: on }),
              ...(review ? { review } : {}),
            };
            return { items: [...versions, version], result: version };
          },
          on === MAIN_BRANCH,
        );
      });
    });
  }

  /**
   * What a version of revision `rev` (not the head) of a branch records about it: the SHA-256 of
   * its snapshot. A revision whose snapshot is no longer kept (or does not read) is rebuilt by
   * replay and written as `snapshot-<rev>.json` in storage form, its blobs stored first as a save
   * stores them, so the version names a file that pruning keeps and `readVersion` reads directly.
   * Recording only the hash of a replay would break once a format bump changes the storage form.
   * A snapshot there that does not read is copied aside first, as loading does with one above
   * the head. `rev` must be a revision of the branch, an integer from 1 to `headRevision`: it is
   * checked before any file name is made of it.
   */
  async #revisionStamp(
    id: string,
    branch: string,
    rev: number,
    headRevision: number,
  ): Promise<LibraryResult<Pick<Head, 'revision' | 'snapshotSha256'>>> {
    if (!Number.isSafeInteger(rev) || rev < 1 || rev > headRevision) {
      return { ok: false, message: 'There is no revision of it with that number.' };
    }
    const dir = this.#dir(id, branch);
    const bytes = await this.#backend.read(`${dir}/${snapshotName(rev)}`);
    if (bytes && (await this.#decodeSnapshot(id, bytes))) {
      return { ok: true, value: { revision: rev, snapshotSha256: await sha256Hex(bytes) } };
    }
    const rebuilt = await this.#readRevision(id, branch, rev);
    if (!rebuilt.ok) return rebuilt;
    const stored = encodeStored(rebuilt.value.document);
    const blobs = this.#blobs(id);
    for (const [sha, data] of stored.blobs) await blobs.put(sha, data);
    if (bytes) {
      const copy = damagedName('snapshot', rev, await sha256Hex(bytes));
      await this.#backend.write(`${dir}/${copy}`, bytes);
      this.#warn(
        `manufakture: revision ${rev} of document ${id}${onBranch(branch)} cannot be read from ` +
          `its snapshot; it is kept as ${copy} and the snapshot rebuilt from the log.`,
      );
    }
    const snapshot = encoder.encode(stored.text);
    await this.#backend.write(`${dir}/${snapshotName(rev)}`, snapshot);
    return { ok: true, value: { revision: rev, snapshotSha256: await sha256Hex(snapshot) } };
  }

  /** Rename a version (its id, revision and snapshot stay). Versions are never deleted. */
  renameVersion(id: string, versionId: string, name: string): Promise<LibraryResult<Version>> {
    return this.#notify(id, 'versions', this.#renameVersion(id, versionId, name));
  }

  #renameVersion(id: string, versionId: string, name: string): Promise<LibraryResult<Version>> {
    return this.#run(async () => {
      if (!isStorableId(id)) return { ok: false, message: `There is no document "${id}".` };
      return this.#locked(id, () =>
        this.#changeList(
          VERSION_LIST,
          id,
          (versions) => {
            const at = versions.findIndex((v) => v.id === versionId);
            if (at < 0) return `There is no version "${versionId}" of it.`;
            const checked = versionMeta({ name, description: versions[at]!.description });
            if (typeof checked === 'string') return checked;
            const renamed = { ...versions[at]!, name: checked.name };
            return {
              items: versions.map((v, i) => (i === at ? renamed : v)),
              result: renamed,
            };
          },
          true,
        ),
      );
    });
  }

  /**
   * Write a changed list of `kind`: list `n+1`, then the main head naming it (the commit), then
   * delete the older lists (best effort). Holds the document lock. `checkMain`: refuse with
   * `RevisionConflict` when another tab saved the main branch since this library opened it.
   */
  async #changeList<T, R>(
    kind: ListKind<T>,
    id: string,
    change: (items: readonly T[], head: Head) => string | { items: T[]; result: R },
    checkMain: boolean,
    after?: (items: readonly T[], read: ListRead<T> & { ok: true }) => Promise<void>,
  ): Promise<LibraryResult<R>> {
    // Open first: it repairs the head and deletes what a failed change left above it.
    const opened = await this.#open(id);
    if (!opened.ok) return opened;
    const dir = this.#dir(id);
    const head = await this.#head(id);
    if (!head) return { ok: false, message: 'Its head cannot be read.' };
    if (checkMain) this.#checkRevision(id, MAIN_BRANCH, head);
    const listed = await this.#readList(kind, id, head);
    if (!listed.ok) return listed;
    const changed = change(listed.items, head);
    if (typeof changed === 'string') return { ok: false, message: changed };
    // Never write a list that would not read back (a new id that is taken, say).
    if (!kind.parse(changed.items)) {
      return { ok: false, message: `The list of ${kind.noun} would not be valid.` };
    }
    const n = head[kind.field] + 1;
    await this.#backend.write(`${dir}/${kind.file(n)}`, listFile(kind, id, n, changed.items));
    // Without locks another tab may have committed meanwhile: look again before the commit.
    const current = await this.#head(id);
    if (
      current?.revision !== head.revision ||
      current.snapshotSha256 !== head.snapshotSha256 ||
      current.versions !== head.versions ||
      current.branches !== head.branches ||
      current.sync !== head.sync
    ) {
      throw new RevisionConflict(id, current?.revision ?? 0, head.revision);
    }
    const next: Head = { ...head, [kind.field]: n };
    await this.#backend.write(
      `${dir}/${HEAD}`,
      encoder.encode(`${JSON.stringify(next, null, 2)}\n`),
    );
    // The list before stays as the spare: without Web Locks another tab may have deleted this
    // one as stale before the head named it, and reading then falls back to the spare.
    for (const old of revisions(await this.#backend.list(dir), kind.pattern)) {
      if (old < n - 1)
        await this.#backend.remove(`${dir}/${kind.file(old)}`).catch(() => undefined);
    }
    if (after) await after(changed.items, listed).catch(() => undefined);
    return { ok: true, value: changed.result };
  }

  /**
   * The document's named versions, oldest first: every branch's when `branch` is not given (a
   * version names its own branch, so a pin needs no branch), else that branch's. Only reads.
   */
  listVersions(id: string, branch?: string): Promise<LibraryResult<Version[]>> {
    return this.#run(async () => {
      if (!isStorableId(id)) return { ok: false, message: `There is no document "${id}".` };
      return this.#locked(id, async () => {
        const names = await this.#backend.list(this.#dir(id));
        if (names.length === 0) return { ok: false, message: `There is no document "${id}".` };
        const listed = await this.#readList(VERSION_LIST, id, await this.#head(id), names);
        if (!listed.ok) return listed;
        const items =
          branch === undefined
            ? listed.items
            : listed.items.filter((v) => versionBranch(v) === branch);
        return { ok: true, value: items };
      });
    });
  }

  /**
   * The review main's work at `revision` (default: main's head) last came from: the latest
   * version of main at or before that revision that records one (`Version.review`, written when
   * an agent's branch is approved and merged), with that record. Null when none does: the work is
   * a person's. What an export from main says about where its work came from.
   */
  reviewOf(
    id: string,
    revision?: number,
  ): Promise<LibraryResult<{ version: Version; review: ReviewReference } | null>> {
    return this.#run(async () => {
      if (!isStorableId(id)) return { ok: false, message: `There is no document "${id}".` };
      if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 1)) {
        return { ok: false, message: 'There is no revision of it with that number.' };
      }
      return this.#locked(id, async () => {
        const names = await this.#backend.list(this.#dir(id));
        if (names.length === 0) return { ok: false, message: `There is no document "${id}".` };
        const head = await this.#head(id);
        const listed = await this.#readList(VERSION_LIST, id, head, names);
        if (!listed.ok) return listed;
        const at = revision ?? head?.revision ?? 0;
        let found: (Version & { review: ReviewReference }) | null = null;
        for (const v of listed.items) {
          if (v.review === undefined || v.branch !== undefined || v.serverRev !== undefined)
            continue;
          if (v.revision > at || (found && v.revision < found.revision)) continue;
          found = v as Version & { review: ReviewReference };
        }
        return { ok: true, value: found ? { version: found, review: found.review } : null };
      });
    });
  }

  /**
   * A named version's document: its snapshot, checked against the SHA-256 the version records.
   * When that snapshot is gone or changed, the revision is rebuilt from the log and must match
   * the SHA-256 instead.
   */
  readVersion(
    id: string,
    versionId: string,
  ): Promise<LibraryResult<{ version: Version; document: ManufaktureDocument }>> {
    type Read = LibraryResult<{ version: Version; document: ManufaktureDocument }>;
    const local = this.#run(async (): Promise<Read & { missing?: 'document' | 'version' }> => {
      if (!isStorableId(id)) return { ok: false, message: `There is no document "${id}".` };
      return this.#locked(id, async () => {
        const names = await this.#backend.list(this.#dir(id));
        if (names.length === 0) {
          return { ok: false, message: `There is no document "${id}".`, missing: 'document' };
        }
        const listed = await this.#readList(VERSION_LIST, id, await this.#head(id), names);
        if (!listed.ok) return listed;
        const version = listed.items.find((v) => v.id === versionId);
        if (!version) {
          return {
            ok: false,
            message: `There is no version "${versionId}" of it.`,
            missing: 'version',
          };
        }
        return this.#readVersion(id, version);
      });
    });
    return local.then(async (r): Promise<Read> => {
      if (r.ok) return r;
      const { missing, ...failure } = r;
      const remote = this.#remote;
      if (missing === undefined || remote === null || !VERSION_ID.test(versionId)) return failure;
      // Outside the queue and the lock: the lookup goes over the network.
      const found = await remote(id, versionId).catch(() => null);
      if (!found || found.document.id !== id || found.version.id !== versionId) return failure;
      if (missing === 'version') {
        const kept = await this.adoptVersion(id, found.version, found.document);
        if (kept.ok) return { ok: true, value: { version: kept.value, document: found.document } };
      }
      // Not kept (the document is not here): the version as the server has it.
      const text = encodeStored(found.document).text;
      const version: Version = {
        id: found.version.id,
        name: found.version.name,
        description: found.version.description,
        revision: 0,
        snapshotSha256: await sha256Hex(encoder.encode(text)),
        createdAt: found.version.createdAt,
        ...(found.version.branch === MAIN_BRANCH ? {} : { branch: found.version.branch }),
        serverRev: found.version.serverRev,
      };
      return { ok: true, value: { version, document: found.document } };
    });
  }

  /**
   * Keep a version that came from the sync server (T7.1e): its document beside the revisions
   * (`remote-<id>.json`, in storage form) and its record, with revision 0 and `serverRev`, in the
   * version list, committed by the main head like any version. It must be of this document. A
   * version already here is returned as it is.
   */
  adoptVersion(
    id: string,
    remote: RemoteVersion,
    document: ManufaktureDocument,
  ): Promise<LibraryResult<Version>> {
    return this.#notify(
      id,
      'versions',
      this.#run(async (): Promise<LibraryResult<Version>> => {
        if (!isStorableId(id)) return { ok: false, message: `There is no document "${id}".` };
        if (document.id !== id) {
          return { ok: false, message: 'The version belongs to another document.' };
        }
        const checked = versionMeta(remote);
        const branch = remote.branch;
        if (
          typeof checked === 'string' ||
          checked.name !== remote.name ||
          !VERSION_ID.test(remote.id) ||
          !isBranchId(branch) ||
          !Number.isSafeInteger(remote.serverRev) ||
          remote.serverRev < 0 ||
          remote.createdAt.length > 64 ||
          Number.isNaN(Date.parse(remote.createdAt))
        ) {
          return { ok: false, message: 'The version record is invalid.' };
        }
        return this.#locked(id, async () => {
          const opened = await this.#open(id);
          if (!opened.ok) return opened;
          const listed = await this.#readList(VERSION_LIST, id, await this.#head(id));
          if (!listed.ok) return listed;
          const here = listed.items.find((v) => v.id === remote.id);
          if (here) return { ok: true, value: here };
          const dir = this.#dir(id);
          // What an adoption that died before its commit left (no list names it). Only under
          // Web Locks: without them another tab may be between its write and its commit.
          if (this.#locks && !listed.fallback) {
            const named = new Set(listed.items.map((v) => remoteName(v.id)));
            for (const name of await this.#backend.list(dir)) {
              if (REMOTE.test(name) && !named.has(name)) {
                await this.#backend.remove(`${dir}/${name}`).catch(() => undefined);
              }
            }
          }
          const stored = encodeStored(document);
          const blobs = this.#blobs(id);
          for (const [sha, data] of stored.blobs) await blobs.put(sha, data);
          const bytes = encoder.encode(stored.text);
          // Written before the list that names it, so a reader never finds a version without its
          // document; taken away again when the list is not committed.
          const file = `${dir}/${remoteName(remote.id)}`;
          await this.#backend.write(file, bytes);
          const version: Version = {
            id: remote.id,
            ...checked,
            revision: 0,
            snapshotSha256: await sha256Hex(bytes),
            createdAt: remote.createdAt,
            ...(branch === MAIN_BRANCH ? {} : { branch }),
            serverRev: remote.serverRev,
          };
          let taken = false;
          const undo = () =>
            taken ? Promise.resolve() : this.#backend.remove(file).catch(() => undefined);
          const changed = await this.#changeList(
            VERSION_LIST,
            id,
            (versions) => {
              if (versions.some((v) => v.id === version.id)) {
                // Another tab kept it meanwhile, under the same file: that file stays.
                taken = true;
                return 'There is a version with its id already.';
              }
              if (versions.length >= MAX_VERSIONS) {
                return `A document holds at most ${MAX_VERSIONS} versions.`;
              }
              return { items: [...versions, version], result: version };
            },
            false,
          ).catch(async (e: unknown) => {
            await undo();
            throw e;
          });
          if (!changed.ok) await undo();
          return changed;
        });
      }),
    );
  }

  async #readVersion(
    id: string,
    version: Version,
  ): Promise<LibraryResult<{ version: Version; document: ManufaktureDocument }>> {
    if (version.revision === 0) {
      // A version from the sync server: its document is kept beside the revisions.
      const kept = await this.#backend.read(`${this.#dir(id)}/${remoteName(version.id)}`);
      if (kept && (await sha256Hex(kept)) === version.snapshotSha256) {
        const stored = await this.#decodeSnapshot(id, kept);
        if (stored) return { ok: true, value: { version, document: stored } };
      }
      return { ok: false, message: `The saved copy of the version "${version.name}" is damaged.` };
    }
    const branch = versionBranch(version);
    const dir = this.#dir(id, branch);
    const bytes = await this.#backend.read(`${dir}/${snapshotName(version.revision)}`);
    if (bytes && (await sha256Hex(bytes)) === version.snapshotSha256) {
      const stored = await this.#decodeSnapshot(id, bytes);
      if (stored) return { ok: true, value: { version, document: stored } };
    }
    const rebuilt = await this.#readRevision(id, branch, version.revision);
    if (rebuilt.ok) {
      const text = encodeStored(rebuilt.value.document).text;
      if ((await sha256Hex(encoder.encode(text))) === version.snapshotSha256) {
        return { ok: true, value: { version, document: rebuilt.value.document } };
      }
    }
    return { ok: false, message: `The saved copy of the version "${version.name}" is damaged.` };
  }

  /** A snapshot's bytes as this document, or null when they do not read as it. */
  async #decodeSnapshot(id: string, bytes: Uint8Array): Promise<ManufaktureDocument | null> {
    const blobs = this.#blobs(id);
    const decoded = await decodeStored(decoder.decode(bytes), (sha) => blobs.read(sha));
    return decoded.ok && decoded.document.id === id ? decoded.document : null;
  }

  async #readSnapshot(
    id: string,
    branch: string,
    rev: number,
  ): Promise<{ bytes: Uint8Array; document: ManufaktureDocument } | null> {
    const bytes = await this.#backend.read(`${this.#dir(id, branch)}/${snapshotName(rev)}`);
    if (!bytes) return null;
    const document = await this.#decodeSnapshot(id, bytes);
    return document ? { bytes, document } : null;
  }

  /**
   * Revision `rev` of the document: the nearest retained snapshot at or below it (or the one
   * `options.from` names), then the logged commands of every later revision up to `rev`,
   * replayed through core's `applyCommand`. Each retained snapshot on the way is compared with
   * the replay (by its SHA-256, and by canonical `serialize` when the snapshot was written in an
   * older format); on a mismatch, or a command that no longer applies, the replay is logged and
   * goes on from the snapshot. A revision whose log segment starts a history (`base: null`)
   * cannot be replayed into. Of branch `options.branch` (default: main): each branch's revisions are its own.
   */
  readRevision(
    id: string,
    rev: number,
    options: { from?: number; branch?: string } = {},
  ): Promise<LibraryResult<ReadRevision>> {
    const on = options.branch ?? MAIN_BRANCH;
    return this.#run(async () => {
      if (!isStorableId(id)) return { ok: false, message: `There is no document "${id}".` };
      if (!isBranchId(on)) return NO_BRANCH;
      return this.#locked(id, async () => {
        if (on !== MAIN_BRANCH) {
          const listed = await this.#branch(id, on);
          if (!listed.ok) return listed;
        }
        return this.#readRevision(id, on, rev, options.from);
      });
    });
  }

  async #readRevision(
    id: string,
    branch: string,
    rev: number,
    from?: number,
  ): Promise<LibraryResult<ReadRevision>> {
    const dir = this.#dir(id, branch);
    let head = await this.#head(id, branch);
    if (!head) {
      // Repair it first, as opening does.
      const opened = await this.#open(id, branch);
      if (!opened.ok) return opened;
      head = await this.#head(id, branch);
      if (!head) return { ok: false, message: 'Its head cannot be read.' };
    }
    if (!Number.isSafeInteger(rev) || rev < 1 || rev > head.revision) {
      return { ok: false, message: `There is no revision ${rev} of it.` };
    }
    const names = await this.#backend.list(dir);
    const retained = revisions(names, SNAPSHOT).filter((r) => r <= rev);
    let candidates = retained;
    if (from !== undefined) {
      if (!retained.includes(from)) {
        return { ok: false, message: `Revision ${from} is not kept, or is after ${rev}.` };
      }
      candidates = [from];
    }
    let start: { rev: number; document: ManufaktureDocument } | null = null;
    for (const s of candidates) {
      const stored = await this.#readSnapshot(id, branch, s);
      if (stored) {
        start = { rev: s, document: stored.document };
        break;
      }
    }
    if (!start) {
      const first = await this.#historyStart(id, branch, names);
      return {
        ok: false,
        message:
          first === null
            ? 'No saved copy of it can be read.'
            : `Revision ${rev} is older than its history, which starts at revision ${first}.`,
      };
    }

    const logs = new Set(revisions(names, LOG));
    const kept = new Set(retained);
    const mismatches: number[] = [];
    let doc = start.document;
    for (let k = start.rev + 1; k <= rev; k++) {
      const step = await this.#replay(id, branch, k, doc, logs);
      if (kept.has(k)) {
        const stored = await this.#readSnapshot(id, branch, k);
        if (stored && !(step.ok && (await sameStored(step.document, stored)))) {
          this.#warn(
            `manufakture: replaying the log of document ${id}${onBranch(branch)} does not ` +
              `reproduce revision ${k}` +
              `${step.ok ? '' : ` (${step.message})`}; the snapshot is used.`,
          );
          mismatches.push(k);
          doc = stored.document;
          continue;
        }
      }
      if (step.ok) {
        doc = step.document;
        continue;
      }
      // Go on from the next retained snapshot that reads, if there is one before `rev`.
      let resumed: { rev: number; document: ManufaktureDocument } | null = null;
      for (const r of [...kept].filter((r) => r > k).sort((a, b) => a - b)) {
        const stored = await this.#readSnapshot(id, branch, r);
        if (stored) {
          resumed = { rev: r, document: stored.document };
          break;
        }
      }
      this.#warn(
        `manufakture: revision ${k} of document ${id}${onBranch(branch)} cannot be rebuilt ` +
          `(${step.message})` +
          (resumed ? `; going on from revision ${resumed.rev}.` : '.'),
      );
      if (!resumed) {
        return { ok: false, message: `Revision ${rev} cannot be rebuilt: ${step.message}.` };
      }
      mismatches.push(resumed.rev);
      doc = resumed.document;
      k = resumed.rev;
    }
    return { ok: true, value: { document: doc, revision: rev, from: start.rev, mismatches } };
  }

  /** Revision `rev` from revision `rev - 1`: its log segment's commands applied to `doc`. */
  async #replay(
    id: string,
    branch: string,
    rev: number,
    doc: ManufaktureDocument,
    logs: ReadonlySet<number>,
  ): Promise<{ ok: true; document: ManufaktureDocument } | { ok: false; message: string }> {
    // A save without commands writes no segment: the document did not change.
    if (!logs.has(rev)) return { ok: true, document: doc };
    const bytes = await this.#backend.read(`${this.#dir(id, branch)}/${logName(rev)}`);
    let segment: unknown;
    try {
      segment = bytes ? JSON.parse(decoder.decode(bytes)) : null;
    } catch {
      segment = null;
    }
    if (!isLogSegment(segment, rev)) {
      return { ok: false, message: `the command log is damaged at revision ${rev}` };
    }
    if (segment.base !== rev - 1) {
      return { ok: false, message: `no logged history leads to revision ${rev}` };
    }
    let entries: LogEntry[];
    try {
      const blobs = this.#blobs(id);
      entries = (await hydrateFrom(segment.entries, (sha) => blobs.read(sha))) as LogEntry[];
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
    let current = doc;
    for (const entry of entries) {
      const applied = applyCommand(current, entry.command);
      if (!applied.ok) {
        return {
          ok: false,
          message: `a logged command no longer applies at revision ${rev}: ${applied.error.message}`,
        };
      }
      current = applied.value.document;
    }
    return { ok: true, document: current };
  }

  /**
   * The oldest revision that can be read back: the oldest retained snapshot that reads. A
   * document saved before snapshots were kept as history starts at its oldest remaining one. Of
   * branch `branch` (default: main).
   */
  historyStart(id: string, branch?: string): Promise<LibraryResult<number>> {
    const on = branch ?? MAIN_BRANCH;
    return this.#run(async () => {
      if (!isStorableId(id)) return { ok: false, message: `There is no document "${id}".` };
      if (!isBranchId(on)) return NO_BRANCH;
      return this.#locked(id, async () => {
        const names = await this.#backend.list(this.#dir(id, on));
        const first = await this.#historyStart(id, on, names);
        return first === null
          ? { ok: false, message: 'No saved copy of it can be read.' }
          : { ok: true, value: first };
      });
    });
  }

  async #historyStart(
    id: string,
    branch: string,
    names: readonly string[],
  ): Promise<number | null> {
    for (const rev of revisions(names, SNAPSHOT).reverse()) {
      if (await this.#readSnapshot(id, branch, rev)) return rev;
    }
    return null;
  }

  /**
   * Rename a stored document, as a logged `renameDocument` command on branch `branch` (default:
   * main). The list of documents shows the
   * main branch's name.
   */
  rename(id: string, name: string, branch?: string): Promise<LibraryResult<DocumentSummary>> {
    const on = branch ?? MAIN_BRANCH;
    return this.#run(async () => {
      if (!isStorableId(id)) return { ok: false, message: `There is no document "${id}".` };
      if (!isBranchId(on)) return NO_BRANCH;
      return this.#locked(id, async () => {
        if (on !== MAIN_BRANCH) {
          const listed = await this.#branch(id, on);
          if (!listed.ok) return listed;
        }
        const opened = await this.#open(id, on);
        if (!opened.ok) return opened;
        const command: Command = { type: 'renameDocument', name };
        const applied = applyCommand(opened.value.document, command);
        if (!applied.ok) return { ok: false, message: applied.error.message };
        const entry: LogEntry = {
          cause: 'execute',
          label: 'Rename document',
          command,
          at: this.#now().toISOString(),
        };
        // It builds on what it just read, under the lock.
        this.#known.set(this.#key(id, on), opened.value.revision);
        return { ok: true, value: await this.#save(applied.value.document, [entry], on) };
      });
    });
  }

  /**
   * A copy under a new id, named "<name> (copy)", with its own files and no history or
   * branches: of branch `branch` (default: main).
   */
  duplicate(id: string, branch?: string): Promise<LibraryResult<DocumentSummary>> {
    const on = branch ?? MAIN_BRANCH;
    return this.#run(async () => {
      if (!isStorableId(id)) return { ok: false, message: `There is no document "${id}".` };
      if (!isBranchId(on)) return NO_BRANCH;
      const opened = await this.#locked(id, async (): Promise<LibraryResult<Opened>> => {
        if (on !== MAIN_BRANCH) {
          const listed = await this.#branch(id, on);
          if (!listed.ok) return listed;
        }
        return this.#open(id, on);
      });
      if (!opened.ok) return opened;
      return { ok: true, value: (await this.#saveCopy(opened.value.document)).summary };
    });
  }

  /**
   * Save `doc` (typically the open document, as this tab has it) as a new document named
   * "<name> (copy)" with no history: how a tab keeps its version when another tab saved the
   * same document meanwhile.
   */
  saveCopy(
    doc: ManufaktureDocument,
  ): Promise<{ summary: DocumentSummary; document: ManufaktureDocument }> {
    return this.#run(() => this.#saveCopy(doc));
  }

  async #saveCopy(
    doc: ManufaktureDocument,
  ): Promise<{ summary: DocumentSummary; document: ManufaktureDocument }> {
    const name = `${doc.name} (copy)`.slice(0, MAX_DOCUMENT_NAME);
    const document = { ...doc, id: this.#newId(), name };
    const summary = await this.#locked(document.id, () => this.#save(document, [], MAIN_BRANCH));
    return { summary, document };
  }

  /**
   * Store an imported document with its versions, under an id nothing holds: each version's
   * document as a revision of its own (1, 2, ...; identical ones share one), oldest first, then
   * the document as the newest, then the version list and the head. No log leads to any of
   * them (each segment says `base: null`), so replay never crosses from one into the next.
   * Version ids, names and dates are kept; revisions and SHA-256s are this store's.
   */
  async #saveImported(
    doc: ManufaktureDocument,
    imported: readonly PackedVersion[],
  ): Promise<DocumentSummary> {
    const id = doc.id;
    const dir = this.#dir(id);
    const blobs = this.#blobs(id);
    let rev = 0;
    const write = async (stored: ReturnType<typeof encodeStored>) => {
      for (const [sha, data] of stored.blobs) await blobs.put(sha, data);
      rev += 1;
      const segment: LogSegment = {
        format: 'manufakture-log',
        revision: rev,
        base: null,
        entries: [],
      };
      await this.#backend.write(
        `${dir}/${logName(rev)}`,
        encoder.encode(`${JSON.stringify(segment)}\n`),
      );
      const snapshot = encoder.encode(stored.text);
      await this.#backend.write(`${dir}/${snapshotName(rev)}`, snapshot);
      return { sha256: await sha256Hex(snapshot), bytes: snapshot.length };
    };
    const records: Version[] = [];
    let last = null as { text: string; sha256: string } | null;
    const ordered = [...imported].sort((a, b) => a.version.revision - b.version.revision);
    for (const { version, document } of ordered) {
      const stored = encodeStored({ ...document, id });
      if (last?.text !== stored.text) last = { text: stored.text, ...(await write(stored)) };
      // Branches are not exported: every imported version is a revision of the main branch.
      const record: Version = { ...version, revision: rev, snapshotSha256: last.sha256 };
      delete record.branch;
      // A revision of this document now, not one of a server log.
      delete record.serverRev;
      // A review recorded in another library is not one of this one's.
      delete record.review;
      records.push(record);
    }
    const stored = encodeStored(doc);
    const written = await write(stored);
    await this.#backend.write(`${dir}/${versionsName(1)}`, listFile(VERSION_LIST, id, 1, records));
    const now = this.#now().toISOString();
    const head: Head = {
      format: 'manufakture-head',
      id,
      name: doc.name,
      revision: rev,
      snapshotSha256: written.sha256,
      snapshotBytes: written.bytes,
      blobBytes: stored.blobBytes,
      createdAt: now,
      savedAt: now,
      versions: 1,
      branches: 0,
    };
    await this.#backend.write(
      `${dir}/${HEAD}`,
      encoder.encode(`${JSON.stringify(head, null, 2)}\n`),
    );
    this.#known.set(id, rev);
    return summaryOf(head);
  }

  /** Delete a document and everything stored with it, every branch included. */
  remove(id: string): Promise<void> {
    if (!isStorableId(id)) return Promise.reject(new Error(`Cannot delete a document "${id}"`));
    return this.#run(() =>
      this.#locked(id, async () => {
        await this.#backend.removeTree(this.#dir(id));
        this.#blobStores.delete(id);
        for (const map of [this.#known, this.#written]) {
          for (const key of [...map.keys()]) {
            if (key === id || key.startsWith(`${id}/`)) map.delete(key);
          }
        }
      }),
    );
  }

  /** A new, empty-history document saved as revision 1 of its main branch. */
  create(doc: ManufaktureDocument): Promise<DocumentSummary> {
    return this.save(doc, [], MAIN_BRANCH);
  }

  /** The document's branches: main first, then the others, oldest first. Only reads. */
  listBranches(id: string): Promise<LibraryResult<Branch[]>> {
    return this.#run(async () => {
      if (!isStorableId(id)) return { ok: false, message: `There is no document "${id}".` };
      return this.#locked(id, async () => {
        const names = await this.#backend.list(this.#dir(id));
        if (names.length === 0) return { ok: false, message: `There is no document "${id}".` };
        const head = await this.#head(id);
        const listed = await this.#readList(BRANCH_LIST, id, head, names);
        if (!listed.ok) return listed;
        const main: Branch = {
          id: MAIN_BRANCH,
          name: MAIN_BRANCH_NAME,
          fromVersion: null,
          createdAt: head?.createdAt ?? '',
        };
        return { ok: true, value: [main, ...listed.items] };
      });
    });
  }

  /**
   * A new branch of document `id`, starting from version `fromVersion` (of any branch): its
   * directory gets that version's document as revision 1 and a head, then the branch list
   * naming it is committed by the main head. A crash before that commit leaves a directory no
   * list names, which the next branch change deletes. The new branch is not opened.
   */
  createBranch(
    id: string,
    fromVersion: string,
    name: string,
    options: { provenance?: BranchProvenance } = {},
  ): Promise<LibraryResult<Branch>> {
    return this.#notify(
      id,
      'branches',
      this.#createBranch(id, fromVersion, name, undefined, options.provenance),
    );
  }

  /**
   * A new branch of document `id` from revision `options.revision` (default: the head) of
   * branch `options.from` (default: main), through a version of that revision named
   * `options.version`, since branches start from versions: `createVersion`, then
   * `createBranch` with `options.provenance`. The name and provenance are checked before the
   * version is made; a branch that still cannot be made (its name taken meanwhile, the branch
   * limit) leaves the version, as versions are kept for good, and the failure says so.
   */
  async branchFromRevision(
    id: string,
    options: {
      from?: string;
      revision?: number;
      version: VersionMeta;
      name: string;
      provenance?: BranchProvenance;
    },
  ): Promise<LibraryResult<{ version: Version; branch: Branch }>> {
    if (branchName(options.name) === null) {
      return { ok: false, message: `A branch name must be 1 to ${MAX_DOCUMENT_NAME} characters.` };
    }
    if (options.provenance !== undefined) {
      const origin = newProvenance(options.provenance);
      if (typeof origin === 'string') return { ok: false, message: origin };
    }
    const listed = await this.listBranches(id);
    if (!listed.ok) return listed;
    const problem = branchProblem(listed.value.slice(1), branchName(options.name)!);
    if (problem) return { ok: false, message: problem };
    if (listed.value.length - 1 >= MAX_BRANCHES) {
      return { ok: false, message: `A document holds at most ${MAX_BRANCHES} branches.` };
    }
    const version = await this.#notify(
      id,
      'versions',
      this.#createVersion(id, options.version, options.from, options.revision),
    );
    if (!version.ok) return version;
    const branch = await this.createBranch(id, version.value.id, options.name, {
      ...(options.provenance ? { provenance: options.provenance } : {}),
    });
    if (!branch.ok) {
      return {
        ok: false,
        message: `${branch.message} The version "${version.value.name}" was made and is kept.`,
      };
    }
    return { ok: true, value: { version: version.value, branch: branch.value } };
  }

  /**
   * Set the review state of agent branch `branch` (one with provenance), committed by the main
   * head like any branch change. A person's branch, and main, have none to set. The library does
   * not check who asks: its callers (the review UI, T8.3b, and the session server, T8.4b) decide
   * who may call it, and an agent session must never reach it for its own branch. Note that
   * `adoptBranch` does not carry provenance yet (T8.4b), so a branch synced to another browser
   * arrives there as a person's.
   *
   * `expected` makes it a compare-and-set: the change is made only when the branch's review state
   * is one of `expected` at the moment of the change (under the library's lock); otherwise nothing
   * is written and the failure has `reviewChanged`. A session uses it so that a reviewer's decision
   * made while it worked is never overwritten.
   */
  setBranchReview(
    id: string,
    branch: string,
    review: ReviewState,
    options: { expected?: ReviewState | readonly ReviewState[] } = {},
  ): Promise<LibraryResult<Branch>> {
    const expected =
      options.expected === undefined
        ? undefined
        : typeof options.expected === 'string'
          ? [options.expected]
          : options.expected;
    return this.#notify(
      id,
      'branches',
      this.#run(async () => {
        if (!isStorableId(id)) return { ok: false, message: `There is no document "${id}".` };
        if (branch === MAIN_BRANCH || !isBranchId(branch)) return NO_BRANCH;
        if (!REVIEW_STATES.includes(review)) {
          return { ok: false, message: `There is no review state "${String(review)}".` };
        }
        if (expected !== undefined && !expected.every((e) => REVIEW_STATES.includes(e))) {
          return { ok: false, message: 'There is no such expected review state.' };
        }
        let changedMeanwhile = false;
        const result = await this.#locked(id, () =>
          this.#changeList(
            BRANCH_LIST,
            id,
            (items) => {
              const at = items.findIndex((b) => b.id === branch);
              if (at < 0) return 'There is no such branch.';
              const provenance = items[at]!.provenance;
              if (!provenance) return 'It is not an agent branch, so it has no review state.';
              if (expected !== undefined && !expected.includes(provenance.review)) {
                changedMeanwhile = true;
                return `The branch is ${provenance.review}, not ${expected.join(' or ')}.`;
              }
              const changed = { ...items[at]!, provenance: { ...provenance, review } };
              return { items: items.map((b, i) => (i === at ? changed : b)), result: changed };
            },
            false,
          ),
        );
        return !result.ok && changedMeanwhile
          ? { ...result, reviewChanged: true as const }
          : result;
      }),
    );
  }

  /**
   * A branch that came from the sync server (T7.1e), kept here under its own id and time: made
   * from its version as `createBranch` makes one (the version must be here, adopted first if it
   * came from the server too). When its name is taken here, it gets " (2)", " (3)", ... A branch
   * already here is returned as it is.
   */
  adoptBranch(id: string, record: Branch): Promise<LibraryResult<Branch>> {
    if (record.fromVersion === null || !isBranchId(record.id) || record.id === MAIN_BRANCH) {
      return Promise.resolve({ ok: false, message: 'The branch record is invalid.' });
    }
    return this.#notify(
      id,
      'branches',
      this.#createBranch(id, record.fromVersion, record.name, {
        id: record.id,
        createdAt: record.createdAt,
      }),
    );
  }

  #createBranch(
    id: string,
    fromVersion: string,
    name: string,
    given?: { id: string; createdAt: string },
    provenance?: BranchProvenance,
  ): Promise<LibraryResult<Branch>> {
    return this.#run(async () => {
      if (!isStorableId(id)) return { ok: false, message: `There is no document "${id}".` };
      const origin = provenance === undefined ? null : newProvenance(provenance);
      if (typeof origin === 'string') return { ok: false, message: origin };
      const checked = branchName(name);
      if (checked === null) {
        return {
          ok: false,
          message: `A branch name must be 1 to ${MAX_DOCUMENT_NAME} characters.`,
        };
      }
      return this.#locked(id, async () => {
        const opened = await this.#open(id);
        if (!opened.ok) return opened;
        const versions = await this.#readList(VERSION_LIST, id, await this.#head(id));
        if (!versions.ok) return versions;
        const version = versions.items.find((v) => v.id === fromVersion);
        if (!version) return { ok: false, message: `There is no version "${fromVersion}" of it.` };
        const branches = await this.#readList(BRANCH_LIST, id, await this.#head(id));
        if (!branches.ok) return branches;
        if (given !== undefined) {
          const here = branches.items.find((b) => b.id === given.id);
          if (here) return { ok: true, value: here };
          if (Number.isNaN(Date.parse(given.createdAt)) || given.createdAt.length > 64) {
            return { ok: false, message: 'The branch record is invalid.' };
          }
        }
        let named = checked;
        for (let n = 2; given !== undefined && branchProblem(branches.items, named); n++) {
          const suffix = ` (${n})`;
          named = `${checked.slice(0, MAX_DOCUMENT_NAME - suffix.length)}${suffix}`;
          if (n > MAX_BRANCHES + 1) break;
        }
        const problem = branchProblem(branches.items, named);
        if (problem) return { ok: false, message: problem };
        if (branches.items.length >= MAX_BRANCHES) {
          return { ok: false, message: `A document holds at most ${MAX_BRANCHES} branches.` };
        }
        const read = await this.#readVersion(id, version);
        if (!read.ok) return read;

        const branch: Branch = {
          id: given?.id ?? this.#newId(),
          name: named,
          fromVersion: version.id,
          createdAt: given?.createdAt ?? this.#now().toISOString(),
          ...(origin ? { provenance: origin } : {}),
        };
        if (!isBranchId(branch.id) || branch.id === MAIN_BRANCH) {
          return { ok: false, message: 'The new branch has no usable id.' };
        }
        // Its directory first, whole: whatever an earlier attempt left there goes.
        const dir = this.#dir(id, branch.id);
        await this.#backend.removeTree(dir);
        const stored = encodeStored(read.value.document);
        const blobs = this.#blobs(id);
        for (const [sha, data] of stored.blobs) await blobs.put(sha, data);
        const snapshot = encoder.encode(stored.text);
        await this.#backend.write(`${dir}/${snapshotName(1)}`, snapshot);
        const head: Head = {
          format: 'manufakture-head',
          id,
          name: read.value.document.name,
          revision: 1,
          snapshotSha256: await sha256Hex(snapshot),
          snapshotBytes: snapshot.length,
          blobBytes: stored.blobBytes,
          createdAt: branch.createdAt,
          savedAt: branch.createdAt,
          ...NO_LISTS,
        };
        await this.#backend.write(
          `${dir}/${HEAD}`,
          encoder.encode(`${JSON.stringify(head, null, 2)}\n`),
        );
        const r = await this.#changeList(
          BRANCH_LIST,
          id,
          (items) => {
            const again = branchProblem(items, named);
            if (again) return again;
            if (items.some((b) => b.id === branch.id))
              return 'There is a branch with its id already.';
            return { items: [...items, branch], result: branch };
          },
          false,
          (items, listed) => this.#dropOrphans(id, items, listed),
        );
        if (!r.ok) return r;
        // Without Web Locks another tab's branch change may have taken this directory for an
        // orphan between its writes and the commit: write it again if its head is gone.
        if (!(await this.#head(id, branch.id))) {
          this.#warn(`manufakture: branch ${branch.id} of document ${id} was written again.`);
          await this.#backend.write(`${dir}/${snapshotName(1)}`, snapshot);
          await this.#backend.write(
            `${dir}/${HEAD}`,
            encoder.encode(`${JSON.stringify(head, null, 2)}\n`),
          );
        }
        this.#known.set(this.#key(id, branch.id), 1);
        return r;
      });
    });
  }

  /** Rename branch `branch` (not main). */
  renameBranch(id: string, branch: string, name: string): Promise<LibraryResult<Branch>> {
    return this.#notify(id, 'branches', this.#renameBranch(id, branch, name));
  }

  #renameBranch(id: string, branch: string, name: string): Promise<LibraryResult<Branch>> {
    return this.#run(async () => {
      if (!isStorableId(id)) return { ok: false, message: `There is no document "${id}".` };
      if (branch === MAIN_BRANCH) {
        return { ok: false, message: 'The main branch cannot be renamed.' };
      }
      const checked = branchName(name);
      if (checked === null) {
        return {
          ok: false,
          message: `A branch name must be 1 to ${MAX_DOCUMENT_NAME} characters.`,
        };
      }
      return this.#locked(id, () =>
        this.#changeList(
          BRANCH_LIST,
          id,
          (items) => {
            const at = items.findIndex((b) => b.id === branch);
            if (at < 0) return 'There is no such branch.';
            const problem = branchProblem(
              items.filter((b) => b.id !== branch),
              checked,
            );
            if (problem) return problem;
            const renamed = { ...items[at]!, name: checked };
            return { items: items.map((b, i) => (i === at ? renamed : b)), result: renamed };
          },
          false,
        ),
      );
    });
  }

  /**
   * Delete branch `branch` (not main): the branch list without it is committed by the main
   * head, then its directory goes (best effort; a directory no list names is deleted by the
   * next branch change). A branch that a version names is kept: versions are for good, and
   * other documents may pin them.
   */
  deleteBranch(id: string, branch: string): Promise<LibraryResult<void>> {
    return this.#notify(id, 'branches', this.#deleteBranch(id, branch));
  }

  #deleteBranch(id: string, branch: string): Promise<LibraryResult<void>> {
    return this.#run(async () => {
      if (!isStorableId(id)) return { ok: false, message: `There is no document "${id}".` };
      if (branch === MAIN_BRANCH) {
        return { ok: false, message: 'The main branch cannot be deleted.' };
      }
      return this.#locked(id, async () => {
        const opened = await this.#open(id);
        if (!opened.ok) return opened;
        const versions = await this.#readList(VERSION_LIST, id, await this.#head(id));
        if (!versions.ok) return versions;
        const named = versions.items.filter((v) => v.branch === branch);
        if (named.length > 0) {
          return {
            ok: false,
            message:
              `It has ${named.length === 1 ? 'a named version' : `${named.length} named versions`}` +
              ', which are kept for good, so it cannot be deleted.',
          };
        }
        const r = await this.#changeList(
          BRANCH_LIST,
          id,
          (items) =>
            items.some((b) => b.id === branch)
              ? { items: items.filter((b) => b.id !== branch), result: undefined }
              : 'There is no such branch.',
          false,
          (items, listed) => this.#dropOrphans(id, items, listed),
        );
        if (!r.ok) return r;
        const key = this.#key(id, branch);
        this.#known.delete(key);
        this.#written.delete(key);
        return r;
      });
    });
  }

  /**
   * Delete the branch directories the committed list `items` does not name: a branch deleted,
   * or one whose creation died before its commit. Not when the list was read from the spare (a
   * branch named only in the missing list would look unnamed), and never a branch a version
   * names, even when no list does (a list lost to a release from before branches, or rebuilt
   * without a head): its snapshots are what that version, and the pins on it, read. Nothing is
   * deleted when the version list cannot be read.
   */
  async #dropOrphans(
    id: string,
    items: readonly Branch[],
    read: ListRead<Branch> & { ok: true },
  ): Promise<void> {
    if (read.fallback) return;
    const versions = await this.#readList(VERSION_LIST, id, await this.#head(id));
    if (!versions.ok || versions.fallback) return;
    const keep = new Set([
      ...items.map((b) => b.id),
      ...versions.items.map((v) => versionBranch(v)),
    ]);
    const root = `${this.#dir(id)}/${BRANCH_DIR}`;
    for (const name of await this.#backend.list(root)) {
      if (!keep.has(name) && isBranchId(name)) await this.#backend.removeTree(`${root}/${name}`);
    }
  }

  /**
   * What merging branch `from` into branch `into` would do, without saving anything: the
   * commands `from` made since the two branches forked, rebased onto `into` by `SyncClient`'s
   * replay and id remap (ADR 0009 decision 9). With `options.document`, that is taken as `into`'s
   * current state instead of its saved head (the editor's, with changes not saved yet). See
   * `rebaseOnto` for what the plan reports.
   */
  previewMerge(
    id: string,
    from: string,
    into: string,
    options: { document?: ManufaktureDocument } = {},
  ): Promise<LibraryResult<MergePlan>> {
    return this.#run(async () => {
      if (!isStorableId(id)) return { ok: false, message: `There is no document "${id}".` };
      if (!isBranchId(from) || !isBranchId(into)) return NO_BRANCH;
      return this.#locked(id, () => this.#planMerge(id, from, into, options.document));
    });
  }

  /**
   * Merge branch `from` into branch `into`: `previewMerge`'s result committed as one new revision
   * of `into`, whose log holds one `replaceDocument` command labelled `mergeLabel(name)`, so the
   * merge is one step in its history and undoes as one. Nothing is saved when nothing applies
   * (`saved` is null then). Throws as `save` does (a `RevisionConflict` when another tab saved
   * `into` since this library last opened or saved it). The app merges into the open branch
   * through the editor instead (`mergeCommand`), so the merge is on its undo stack.
   */
  mergeBranch(
    id: string,
    from: string,
    into: string,
  ): Promise<LibraryResult<{ plan: MergePlan; saved: DocumentSummary | null }>> {
    return this.#run(async () => {
      if (!isStorableId(id)) return { ok: false, message: `There is no document "${id}".` };
      if (!isBranchId(from) || !isBranchId(into)) return NO_BRANCH;
      return this.#locked(id, async () => {
        const planned = await this.#planMerge(id, from, into);
        if (!planned.ok) return planned;
        const plan = planned.value;
        if (!plan.changed) return { ok: true, value: { plan, saved: null } };
        const entry: LogEntry = {
          cause: 'execute',
          label: mergeLabel(plan.fromName),
          command: mergeCommand(plan),
          at: this.#now().toISOString(),
        };
        const saved = await this.#save(plan.document, [entry], into);
        return { ok: true, value: { plan, saved } };
      });
    });
  }

  async #planMerge(
    id: string,
    from: string,
    into: string,
    current?: ManufaktureDocument,
  ): Promise<LibraryResult<MergePlan>> {
    if (from === into) return { ok: false, message: 'A branch cannot be merged into itself.' };
    const names = await this.#backend.list(this.#dir(id));
    if (names.length === 0) return { ok: false, message: `There is no document "${id}".` };
    const mainHead = await this.#head(id);
    const branches = await this.#readList(BRANCH_LIST, id, mainHead, names);
    if (!branches.ok) return branches;
    const versions = await this.#readList(VERSION_LIST, id, mainHead, names);
    if (!versions.ok) return versions;
    const a = await this.#lineage(id, from, branches.items, versions.items);
    if (!a.ok) return a;
    const b = await this.#lineage(id, into, branches.items, versions.items);
    if (!b.ok) return b;
    const fork = forkOf(a.value, b.value);
    if (!fork) return { ok: false, message: 'The two branches have no common history.' };

    // The commands `from` made since the fork: the rest of the stretch they share, then each
    // later stretch of its lineage whole.
    const entries: LogEntry[] = [];
    for (let i = fork.index; i < a.value.length; i++) {
      const s = a.value[i]!;
      const after = i === fork.index ? fork.revision : s.from;
      const read = await this.#logEntries(id, s.branch, after, s.to);
      if (!read.ok) return read;
      entries.push(...read.value);
    }
    const base = await this.#readRevision(id, fork.branch, fork.revision);
    if (!base.ok) {
      return { ok: false, message: `The state the branches share cannot be read: ${base.message}` };
    }
    let target = current;
    if (target === undefined) {
      const opened = await this.#open(id, into);
      if (!opened.ok) return opened;
      target = opened.value.document;
    }
    const nameOf = (branch: string) =>
      branch === MAIN_BRANCH
        ? MAIN_BRANCH_NAME
        : (branches.items.find((x) => x.id === branch)?.name ?? branch);
    const rebased = rebaseOnto(base.value.document, target, entries);
    if (!rebased.ok) return rebased;
    return {
      ok: true,
      value: {
        ...rebased.value,
        from,
        into,
        fromName: nameOf(from),
        intoName: nameOf(into),
        fork: { branch: fork.branch, revision: fork.revision },
      },
    };
  }

  /**
   * Where branch `branch`'s states come from, oldest first: main's revisions up to the version
   * the first branch was made from, that branch's up to the version the next one was made from,
   * and so on down to `branch`'s own, up to its head. A branch's revision 1 is the version it was
   * made from, so its own commands start at revision 2.
   */
  async #lineage(
    id: string,
    branch: string,
    branches: readonly Branch[],
    versions: readonly Version[],
  ): Promise<LibraryResult<Stretch[]>> {
    const out: Stretch[] = [];
    let on = branch;
    let to: number | null = null;
    for (let depth = 0; depth <= MAX_BRANCHES + 1; depth++) {
      if (on !== MAIN_BRANCH && !branches.some((x) => x.id === on)) return NO_BRANCH;
      if (to === null) {
        const head = await this.#head(id, on);
        if (!head) {
          const opened = await this.#open(id, on);
          if (!opened.ok) return opened;
          to = opened.value.revision;
        } else to = head.revision;
      }
      if (on === MAIN_BRANCH) {
        out.unshift({ branch: on, from: 0, to });
        return { ok: true, value: out };
      }
      out.unshift({ branch: on, from: 1, to });
      const made = branches.find((x) => x.id === on)!;
      const version = versions.find((v) => v.id === made.fromVersion);
      if (!version) {
        return {
          ok: false,
          message: `The version the branch "${made.name}" was made from is gone.`,
        };
      }
      if (version.revision === 0) {
        return {
          ok: false,
          message: `The branch "${made.name}" was made from a version from the sync server, whose history this browser does not hold: merge it in the browser it was made in.`,
        };
      }
      on = versionBranch(version);
      to = version.revision;
    }
    return { ok: false, message: 'The branches are nested too deeply to merge.' };
  }

  /** The logged commands of branch `branch` that led from revision `after` to revision `to`. */
  async #logEntries(
    id: string,
    branch: string,
    after: number,
    to: number,
  ): Promise<LibraryResult<LogEntry[]>> {
    if (to <= after) return { ok: true, value: [] };
    const chain = await this.#logChain(id, branch);
    if (!chain.ok) return chain;
    const segments = chain.value.filter((s) => s.revision > after && s.revision <= to);
    // The segments must lead from `after` without a gap: a history that starts later (or a
    // damaged segment) cannot say what the branch did.
    const first = segments[0];
    if (first && first.base !== null && first.base < after) {
      return { ok: false, message: `The command log cannot be read from revision ${after}.` };
    }
    if (first && first.base === null && after > 0) {
      return { ok: false, message: `The command log starts after revision ${after}.` };
    }
    const blobs = this.#blobs(id);
    const out: LogEntry[] = [];
    try {
      for (const segment of segments) {
        out.push(...((await hydrateFrom(segment.entries, (sha) => blobs.read(sha))) as LogEntry[]));
      }
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
    return { ok: true, value: out };
  }

  /**
   * The document as a `.mfk` file (see mfk.ts), of branch `options.branch` (default: main); with
   * `versions`, its named versions (of every branch) and their documents go in too (the
   * manifest), so pins in other documents still resolve after an import.
   */
  exportMfk(
    id: string,
    options: { versions?: boolean; branch?: string } = {},
  ): Promise<LibraryResult<{ name: string; bytes: Uint8Array }>> {
    const on = options.branch ?? MAIN_BRANCH;
    return this.#run(async () => {
      if (!isStorableId(id)) return { ok: false, message: `There is no document "${id}".` };
      if (!isBranchId(on)) return NO_BRANCH;
      const read = await this.#locked(
        id,
        async (): Promise<
          LibraryResult<{ document: ManufaktureDocument; versions: PackedVersion[] }>
        > => {
          if (on !== MAIN_BRANCH) {
            const listed = await this.#branch(id, on);
            if (!listed.ok) return listed;
          }
          const opened = await this.#open(id, on);
          if (!opened.ok) return opened;
          const versions: PackedVersion[] = [];
          if (options.versions) {
            const listed = await this.#readList(VERSION_LIST, id, await this.#head(id));
            if (!listed.ok) return listed;
            for (const v of listed.items) {
              const r = await this.#readVersion(id, v);
              if (!r.ok) return r;
              versions.push(r.value);
            }
          }
          return { ok: true, value: { document: opened.value.document, versions } };
        },
      );
      if (!read.ok) return read;
      try {
        return { ok: true, value: await packDocument(read.value.document, read.value.versions) };
      } catch (e) {
        const { MfkError } = await import('./mfk');
        if (e instanceof MfkError) return { ok: false, message: e.message };
        throw e;
      }
    });
  }

  /**
   * Import a `.mfk` file as a new document: unpacked within limits, every blob checked, run
   * through core's migrations and validation. It keeps its id unless that is taken (or not
   * storable), and gets a new one then.
   */
  importMfk(
    bytes: Uint8Array,
  ): Promise<LibraryResult<{ summary: DocumentSummary; migrated: boolean }>> {
    return this.#run(async () => {
      const { unpackMfk, MfkError } = await import('./mfk');
      let contents: ReturnType<typeof unpackMfk>;
      try {
        contents = unpackMfk(bytes);
      } catch (e) {
        if (e instanceof MfkError) return { ok: false, message: e.message };
        throw e;
      }
      const decoded = await decodeStored(
        contents.document,
        async (sha) => contents.blobs.get(sha) ?? null,
      );
      if (!decoded.ok) {
        return decoded.newer
          ? { ok: false, message: decoded.message, newer: true }
          : { ok: false, message: decoded.message };
      }
      let versions: PackedVersion[] = [];
      if (contents.manifest !== null) {
        const read = await readManifest(contents, decoded.document.id);
        if (!read.ok) return read;
        versions = read.value;
      }
      let doc = decoded.document;
      if (!isStorableId(doc.id)) doc = { ...doc, id: this.#newId() };
      const wanted = doc;
      // Under the id's lock, so another tab cannot take the id between the check and the save.
      const summary = await this.#locked(wanted.id, async () => {
        const taken = (await this.#backend.list(this.#dir(wanted.id))).length > 0;
        // A new id is a fresh UUID: nothing else can hold it.
        const target = taken ? { ...wanted, id: this.#newId() } : wanted;
        if (versions.length === 0) return this.#save(target, [], MAIN_BRANCH);
        return this.#saveImported(target, versions);
      });
      return { ok: true, value: { summary, migrated: decoded.migrated } };
    });
  }
}

/** Why a branch cannot be called `name` among `others` (main included), or null. */
function branchProblem(others: readonly Branch[], name: string): string | null {
  if (name === MAIN_BRANCH_NAME || others.some((b) => b.name === name)) {
    return `There is a branch called "${name}" already.`;
  }
  return null;
}

/** A version with its document, as a `.mfk` carries it. */
export interface PackedVersion {
  version: Version;
  document: ManufaktureDocument;
}

/** What `manifest.json` in a `.mfk` says: the versions it holds (`versions/<id>.json`). */
const MANIFEST_FORMAT = 'manufakture-manifest';

/**
 * `doc` as a `.mfk` file, named after it; with `versions`, a manifest listing them and each
 * version's document in storage form, its `snapshotSha256` that entry's.
 */
export async function packDocument(
  doc: ManufaktureDocument,
  versions: readonly PackedVersion[] = [],
): Promise<{ name: string; bytes: Uint8Array }> {
  const stored = encodeStored(doc);
  const blobs = new Map([...stored.blobs].map(([sha, data]) => [sha, fromBase64(data)]));
  let extras: { manifest: string; versions: Map<string, string> } | undefined;
  if (versions.length > 0) {
    const texts = new Map<string, string>();
    const records: Version[] = [];
    for (const { version, document } of versions) {
      const s = encodeStored(document);
      for (const [sha, data] of s.blobs) if (!blobs.has(sha)) blobs.set(sha, fromBase64(data));
      texts.set(version.id, s.text);
      records.push({ ...version, snapshotSha256: await sha256Hex(encoder.encode(s.text)) });
    }
    const manifest = { format: MANIFEST_FORMAT, versions: records };
    extras = { manifest: `${JSON.stringify(manifest, null, 2)}\n`, versions: texts };
  }
  const { packMfk, MFK_LIMITS, MfkError } = await import('./mfk');
  // A file the import would refuse is not written.
  const entries = 1 + blobs.size + (extras ? 1 + extras.versions.size : 0);
  if (entries > MFK_LIMITS.maxEntries) {
    throw new MfkError(
      `It holds too many versions and imported files for one .mfk file (${entries} entries; ` +
        `at most ${MFK_LIMITS.maxEntries}).`,
    );
  }
  return { name: fileName(doc.name, 'mfk'), bytes: packMfk(stored.text, blobs, extras) };
}

/**
 * The versions an imported `.mfk`'s manifest lists, each checked as outside input: the record's
 * fields, ids unique, its document present with the SHA-256 recorded, readable (blobs checked,
 * migrated, validated) and of document `documentId`. Any fault refuses the whole file.
 */
async function readManifest(
  contents: {
    manifest: string | null;
    versions: ReadonlyMap<string, string>;
    blobs: ReadonlyMap<string, Uint8Array>;
  },
  documentId: string,
): Promise<LibraryResult<PackedVersion[]>> {
  let value: unknown;
  try {
    value = JSON.parse(contents.manifest ?? '');
  } catch {
    return { ok: false, message: 'The file is damaged: its manifest is not valid JSON.' };
  }
  if (!isRecord(value) || value.format !== MANIFEST_FORMAT) {
    return { ok: false, message: 'The file is damaged: its manifest is not one this app reads.' };
  }
  const versions = parseVersions(value.versions);
  if (!versions) {
    return { ok: false, message: 'The file is damaged: its list of versions is invalid.' };
  }
  const out: PackedVersion[] = [];
  for (const version of versions) {
    const text = contents.versions.get(version.id);
    if (text === undefined) {
      return {
        ok: false,
        message: `The file lists the version "${version.name}" but does not hold it.`,
      };
    }
    if ((await sha256Hex(encoder.encode(text))) !== version.snapshotSha256) {
      return {
        ok: false,
        message: `The version "${version.name}" in the file is damaged: its SHA-256 does not match.`,
      };
    }
    const decoded = await decodeStored(text, async (sha) => contents.blobs.get(sha) ?? null);
    if (!decoded.ok) {
      return {
        ok: false,
        message: `The version "${version.name}" in the file cannot be read: ${decoded.message}`,
      };
    }
    if (decoded.document.id !== documentId) {
      return {
        ok: false,
        message: `The version "${version.name}" in the file belongs to another document.`,
      };
    }
    out.push({ version, document: decoded.document });
  }
  return { ok: true, value: out };
}

// ---------------------------------------------------------------------------------------------
// Merging branches by replay (ADR 0009 decision 9)

/** Revisions `(from, to]` of one branch: one piece of where a branch's states come from. */
interface Stretch {
  branch: string;
  from: number;
  to: number;
}

/**
 * Where two lineages part: the branch and revision whose state both start from, and the index
 * of that stretch (the same in both). Null when they share nothing (they always share main).
 */
function forkOf(
  a: readonly Stretch[],
  b: readonly Stretch[],
): { branch: string; revision: number; index: number } | null {
  let fork: { branch: string; revision: number; index: number } | null = null;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x.branch !== y.branch) break;
    fork = { branch: x.branch, revision: Math.min(x.to, y.to), index: i };
    if (x.to !== y.to) break;
  }
  return fork;
}

/** A command of the merged branch the replay kept, as the preview lists it. */
export interface MergeStep {
  cause: LogEntry['cause'];
  label: string;
}

/** What rebasing a branch's commands onto another's state gives (`rebaseOnto`). */
export interface Rebased {
  /** The state of the branch merged into before the merge. */
  before: ManufaktureDocument;
  /** Its state after: `before` with the kept commands replayed on top. */
  document: ManufaktureDocument;
  /** The commands that apply, in order, after their ids were renamed where needed. */
  applied: MergeStep[];
  /**
   * The commands that do not apply on the other branch (an edit of a feature it deleted, a
   * delete of a feature it made something depend on), each with why. They are left out.
   */
  dropped: (MergeStep & { message: string })[];
  /** Ids the merged commands made that the other branch had taken meanwhile, and their new ids. */
  renamed: { from: string; to: string }[];
  /**
   * Objects (a feature, a variable, a part's settings, ...) the branch merged into changed since
   * the fork that the merge changes again: the merged branch's version replaces its own whole.
   * The merge is last-writer-wins per object, never per field (ADR 0009 decision 7), with the
   * merged branch as the later writer. Named for the user.
   */
  replaced: string[];
  /** Whether the merge changes anything. */
  changed: boolean;
}

/** `Rebased` for two branches of a stored document. */
export interface MergePlan extends Rebased {
  from: string;
  into: string;
  fromName: string;
  intoName: string;
  /** The branch and revision the two branches share. */
  fork: { branch: string; revision: number };
}

/** The label of a merge in the history and on the undo stack. */
export const mergeLabel = (fromName: string): string => `Merge "${fromName}"`;

/** The one command that makes a merge: undone as one step. */
export function mergeCommand(plan: Pick<Rebased, 'document'>): Command {
  return { type: 'replaceDocument', document: plan.document };
}

const MERGE_CLIENT = 'merge';
const MERGE_TARGET = 'merge-target';

/**
 * The commands `entries` (a branch's, made on `base`) replayed onto `into` (another branch's
 * state that also descends from `base`), the way a sync client rebases its queue (ADR 0009
 * decisions 4 and 5): the commands go into an offline `SyncClient` at `base` as its pending
 * queue, and `into` arrives as the other side's change. Fresh ids the other branch took are
 * renamed, commands that no longer apply are dropped, and a restore is replayed as its intent
 * (decision 9, amendment item 11). Fails when the commands do not apply to `base` itself, which
 * means the history is not the branch's.
 */
export function rebaseOnto(
  base: ManufaktureDocument,
  into: ManufaktureDocument,
  entries: readonly LogEntry[],
): LibraryResult<Rebased> {
  const client = new SyncClient(base, 0, { clientId: MERGE_CLIENT, online: false });
  const dropped: Rebased['dropped'] = [];
  const renames = new Map<string, string>();
  client.on('dropped', ({ drops }) => {
    for (const d of drops) {
      dropped.push({ cause: causeOf(entries, d.label), label: d.label, message: d.error.message });
    }
  });
  client.on('remapped', ({ table }) => {
    for (const scope of Object.values(table)) {
      for (const [old, now] of Object.entries(scope)) {
        if (now !== null && old !== now) renames.set(old, now);
      }
    }
  });
  const causes = new Map<number, LogEntry['cause']>();
  for (const [i, e] of entries.entries()) {
    const r = client.submit(
      e.command.type === 'replaceDocument'
        ? { restore: { document: e.command.document }, label: e.label, at: e.at }
        : { command: e.command, label: e.label, at: e.at },
    );
    if (!r.ok) {
      return {
        ok: false,
        message: `"${e.label}" (step ${i + 1}) does not apply where the branches part: ${r.error.message}`,
      };
    }
    causes.set(r.value.local, e.cause);
  }
  const command: Command = { type: 'replaceDocument', document: into };
  const created = createdIds(base, command);
  if (!created.ok) {
    return { ok: false, message: `The branch cannot be merged into: ${created.error.message}` };
  }
  const received = client.receive([
    {
      rev: 1,
      entry: {
        clientId: MERGE_TARGET,
        clientSeq: 1,
        baseRev: 0,
        format: FORMAT_VERSION,
        cause: 'execute',
        label: MERGE_TARGET,
        command,
        created: created.value as SyncEntry['created'],
        at: entries.at(-1)?.at ?? '',
      },
    },
  ]);
  if (!received.ok) {
    return { ok: false, message: `The branch cannot be merged into: ${received.error.message}` };
  }
  const document = client.document;
  const applied = client.pending.map((p) => ({
    cause: causes.get(p.local) ?? 'execute',
    label: p.label,
  }));
  return {
    ok: true,
    value: {
      before: into,
      document,
      applied,
      dropped,
      renamed: [...renames].map(([from, to]) => ({ from, to })),
      replaced: replacedObjects(base, into, document),
      changed: serialize(document) !== serialize(into),
    },
  };
}

function causeOf(entries: readonly LogEntry[], label: string): LogEntry['cause'] {
  return entries.find((e) => e.label === label)?.cause ?? 'execute';
}

/**
 * The objects the branch merged into changed since `base` (`into`'s own work: added, edited or
 * deleted) that the merge changes again: what the merged branch's version replaced whole.
 */
function replacedObjects(
  base: ManufaktureDocument,
  into: ManufaktureDocument,
  merged: ManufaktureDocument,
): string[] {
  const ours = changedObjects(base, into);
  if (ours.length === 0) return [];
  const intoObjects = documentObjects(into);
  const mergedObjects = documentObjects(merged);
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  return ours
    .filter((k) => !same(mergedObjects.get(k), intoObjects.get(k)))
    .map((k) => objectName(k, [into, base]));
}

/** How the preview names an object key of `documentObjects` (sync's `ObjectKey`). */
function objectName(key: string, docs: readonly ManufaktureDocument[]): string {
  const [kind, a = '', b = ''] = key.split('\u0000');
  const first = <T>(pick: (doc: ManufaktureDocument) => T | undefined): T | undefined => {
    for (const doc of docs) {
      const found = pick(doc);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  const partName = first((d) => d.parts.find((p) => p.id === a)?.name) ?? a;
  switch (kind) {
    case 'f': {
      const name = first(
        (d) => d.parts.find((p) => p.id === a)?.features.find((f) => f.id === b)?.name,
      );
      return `${name ?? b} (${partName})`;
    }
    case 'p':
      return `the settings of ${partName}`;
    case 'v':
      return `the variable #${a}`;
    case 'a':
      return first((d) => d.assemblies.find((x) => x.id === a)?.name) ?? a;
    case 'd':
      return first((d) => d.drawings?.find((x) => x.id === a)?.name) ?? a;
    default:
      return `the document's ${a}`;
  }
}
