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
//   blobs/<sha256>          each imported file, once
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
// Several tabs may have one document open. Every operation on a document holds a Web Lock named
// after it (where the browser has Web Locks), so two tabs never interleave their files, and a
// save refuses (`RevisionConflict`) when the head has moved past the revision this library last
// opened or saved: another tab saved in between, and overwriting would silently drop its work.

import {
  MAX_DOCUMENT_NAME,
  applyCommand,
  migrateJson,
  parseDocument,
  serialize,
  type Command,
  type ManufaktureDocument,
} from '@manufakture/core';
import { fileName, fromBase64, sha256Hex } from '@manufakture/io';
import type { BackendKind, StorageBackend } from './backend';
import { BlobStore, blobRefs, externalize, hydrateFrom, isSha256 } from './blobs';

export const ROOT = 'documents';
const HEAD = 'head.json';
const SNAPSHOT = /^snapshot-(\d{1,12})\.json$/;
const LOG = /^log-(\d{1,12})\.json$/;
const VERSIONS = /^versions-(\d{1,12})\.json$/;

const pad = (rev: number) => String(rev).padStart(8, '0');
const snapshotName = (rev: number) => `snapshot-${pad(rev)}.json`;
const logName = (rev: number) => `log-${pad(rev)}.json`;
const versionsName = (n: number) => `versions-${pad(n)}.json`;

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

export type LibraryResult<T> = { ok: true; value: T } | { ok: false; message: string };

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
}

export interface VersionMeta {
  name: string;
  description?: string;
}

interface VersionsFile {
  format: 'manufakture-versions';
  id: string;
  /** Which write of the list this is: the `<n>` in its name. */
  generation: number;
  versions: Version[];
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
      (h.versions === undefined || (Number.isInteger(h.versions) && h.versions >= 0));
    return valid ? ({ ...h, versions: h.versions ?? 0 } as Head) : null;
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

/**
 * One version record, checked field by field (it may come from an imported file): exactly the
 * known fields are kept. Null when anything is off.
 */
function parseVersion(v: unknown): Version | null {
  if (!isRecord(v)) return null;
  const { id, name, description, revision, snapshotSha256, createdAt } = v;
  if (typeof id !== 'string' || !VERSION_ID.test(id)) return null;
  if (typeof name !== 'string' || typeof description !== 'string') return null;
  const meta = versionMeta({ name, description });
  if (typeof meta === 'string' || meta.name !== name) return null;
  if (!Number.isSafeInteger(revision) || (revision as number) < 1) return null;
  if (typeof snapshotSha256 !== 'string' || !isSha256(snapshotSha256)) return null;
  if (typeof createdAt !== 'string' || createdAt.length > 64 || Number.isNaN(Date.parse(createdAt)))
    return null;
  return {
    id,
    name,
    description,
    revision: revision as number,
    snapshotSha256,
    createdAt,
  };
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

/** `versions-<n>.json` of document `id`, or null when it is missing, torn or of the wrong shape. */
function parseVersionsFile(bytes: Uint8Array | null, id: string, n: number): Version[] | null {
  if (!bytes) return null;
  let v: unknown;
  try {
    v = JSON.parse(decoder.decode(bytes));
  } catch {
    return null;
  }
  if (!isRecord(v) || v.format !== 'manufakture-versions' || v.id !== id || v.generation !== n)
    return null;
  return parseVersions(v.versions);
}

/** A version list as read: which one (`n`, 0 for none) and what it holds. */
type VersionsRead =
  | {
      ok: true;
      n: number;
      versions: Version[];
      /** The list `n` is missing and this is an older one: versions may be missing from it. */
      fallback?: boolean;
    }
  | { ok: false; message: string };

/** Whether `name` is a snapshot or log above `rev`, or a version list above `versions`. */
function isStale(name: string, rev: number, versions: number): boolean {
  const later = (SNAPSHOT.exec(name) ?? LOG.exec(name))?.[1];
  if (later !== undefined) return Number(later) > rev;
  const list = VERSIONS.exec(name)?.[1];
  return list !== undefined && Number(list) > versions;
}

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

type FindResult = { ok: true; found: Found } | { ok: false; message: string };

export class DocumentLibrary {
  readonly #backend: StorageBackend;
  readonly #now: () => Date;
  readonly #newId: () => string;
  readonly #locks: DocumentLocks | null;
  readonly #warn: (message: string) => void;
  readonly #blobStores = new Map<string, BlobStore>();
  /** Operations run one at a time, so two saves never interleave their files. */
  #queue: Promise<unknown> = Promise.resolve();
  /** Per document: the revision this library last opened or saved (what it builds on). */
  readonly #known = new Map<string, number>();
  /**
   * Per document: the snapshot this library last wrote, committed or not (its own work), and the
   * log entries written with it.
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

  #run<T>(op: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(op, op);
    this.#queue = next.catch(() => undefined);
    return next;
  }

  /** Run `op` holding document `id`'s lock (across tabs), when there are locks. */
  #locked<T>(id: string, op: () => Promise<T>): Promise<T> {
    return this.#locks ? this.#locks.request(`manufakture-document-${id}`, op) : op();
  }

  #dir(id: string): string {
    if (!isStorableId(id)) throw new Error(`Cannot store a document with the id "${id}"`);
    return `${ROOT}/${id}`;
  }

  #blobs(id: string): BlobStore {
    let store = this.#blobStores.get(id);
    if (!store) {
      store = new BlobStore(this.#backend, `${this.#dir(id)}/blobs`);
      this.#blobStores.set(id, store);
    }
    return store;
  }

  async #head(id: string): Promise<Head | null> {
    return parseHead(await this.#backend.read(`${this.#dir(id)}/${HEAD}`), id);
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
  open(id: string): Promise<LibraryResult<Opened>> {
    return this.#run(async () => {
      if (!isStorableId(id)) return { ok: false, message: `There is no document "${id}".` };
      return this.#locked(id, async () => {
        const opened = await this.#open(id);
        if (opened.ok) this.#known.set(id, opened.value.revision);
        return opened;
      });
    });
  }

  /** The newest revision that reads completely; changes nothing. */
  async #find(id: string): Promise<FindResult> {
    const dir = this.#dir(id);
    const names = await this.#backend.list(dir);
    const snapshots = revisions(names, SNAPSHOT);
    if (snapshots.length === 0) {
      return {
        ok: false,
        message:
          names.length === 0 ? `There is no document "${id}".` : 'No saved copy of it can be read.',
      };
    }
    const head = await this.#head(id);
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
        if (decoded.newer) return { ok: false, message: decoded.message };
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
  async #open(id: string): Promise<LibraryResult<Opened>> {
    const r = await this.#find(id);
    if (!r.ok) return r;
    const { rev, bytes, document, migrated, head, names, mismatch, damaged } = r.found;
    // Keep what is about to be passed over: the originals are deleted below once they lie
    // above the head.
    for (const d of damaged) await this.#quarantine(id, d, names);
    if (mismatch) {
      this.#warn(
        `manufakture: revision ${rev} of document ${id} does not match the SHA-256 its head ` +
          'records, but reads as a valid document; it is used, and the head is corrected.',
      );
    }
    const recovered = head?.revision !== rev || mismatch;
    // The version list the head names; without a head, the newest one that reads (a list is
    // complete before the head naming it is written, so a torn head leaves the new one).
    const listed = await this.#versions(id, head, names);
    const versions = listed.ok ? listed.n : (head?.versions ?? 0);
    if (recovered) await this.#repair(id, rev, bytes, document, head, versions);
    // Only what lies above both the head and the revision found: never the snapshot the head
    // named (even when it could not be read) or anything below it.
    await this.#dropAbove(id, Math.max(rev, head?.revision ?? rev), names, versions);
    return { ok: true, value: { document, migrated, recovered, revision: rev } };
  }

  /**
   * Copy a complete snapshot that does not read, and its log segment, to names no snapshot or
   * log pattern matches, so no recovery or save ever deletes them (deleting the document does).
   */
  async #quarantine(
    id: string,
    damaged: Found['damaged'][number],
    names: readonly string[],
  ): Promise<void> {
    const dir = this.#dir(id);
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
      `manufakture: revision ${damaged.rev} of document ${id} is complete but cannot be read ` +
        `(${damaged.message}); it is kept as ${snapshotCopy}.`,
    );
  }

  /** Point the head at `rev`, the snapshot recovered. */
  async #repair(
    id: string,
    rev: number,
    snapshot: Uint8Array,
    doc: ManufaktureDocument,
    old: Head | null,
    versions: number,
  ): Promise<void> {
    const dir = this.#dir(id);
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
      versions,
    };
    await this.#backend.write(
      `${dir}/${HEAD}`,
      encoder.encode(`${JSON.stringify(head, null, 2)}\n`),
    );
  }

  /**
   * Delete the logs and snapshots above revision `rev`, and the version lists above `versions`:
   * what a save or a version change that died left behind.
   */
  async #dropAbove(
    id: string,
    rev: number,
    names: readonly string[],
    versions: number,
  ): Promise<void> {
    const dir = this.#dir(id);
    for (const name of names) {
      if (isStale(name, rev, versions)) await this.#backend.remove(`${dir}/${name}`);
    }
  }

  /**
   * The version list the head names (`n` is its number); without a head, the newest list that
   * reads. Changes nothing.
   */
  async #versions(id: string, head: Head | null, names?: readonly string[]): Promise<VersionsRead> {
    const dir = this.#dir(id);
    if (head) {
      if (head.versions === 0) return { ok: true, n: 0, versions: [] };
      const bytes = await this.#backend.read(`${dir}/${versionsName(head.versions)}`);
      const versions = parseVersionsFile(bytes, id, head.versions);
      if (versions) return { ok: true, n: head.versions, versions };
      if (bytes) return { ok: false, message: 'Its list of versions is damaged.' };
      // Missing: without Web Locks, another tab can delete a list as stale between its write
      // and the head naming it. The spare (the list before) is kept for that; read the newest
      // older list that reads, still as list `n`, so the next change writes above it.
      const older = revisions(names ?? (await this.#backend.list(dir)), VERSIONS).filter(
        (m) => m < head.versions,
      );
      for (const m of older) {
        const list = parseVersionsFile(
          await this.#backend.read(`${dir}/${versionsName(m)}`),
          id,
          m,
        );
        if (list) return { ok: true, n: head.versions, versions: list, fallback: true };
      }
      return { ok: false, message: 'Its list of versions is missing.' };
    }
    for (const n of revisions(names ?? (await this.#backend.list(dir)), VERSIONS)) {
      const versions = parseVersionsFile(
        await this.#backend.read(`${dir}/${versionsName(n)}`),
        id,
        n,
      );
      if (versions) return { ok: true, n, versions };
    }
    return { ok: true, n: 0, versions: [] };
  }

  /** Whether revision `rev`'s log segment starts a history (`base: null`): nothing leads to it. */
  async #isRoot(id: string, rev: number, names: readonly string[]): Promise<boolean> {
    if (!names.includes(logName(rev))) return false;
    const bytes = await this.#backend.read(`${this.#dir(id)}/${logName(rev)}`);
    if (!bytes) return false;
    try {
      const segment: unknown = JSON.parse(decoder.decode(bytes));
      return isLogSegment(segment, rev) && segment.base === null;
    } catch {
      return false;
    }
  }

  /**
   * Save `doc` as a new revision, with `entries` (the commands since the last save) as its log
   * segment. Throws when storage fails; the previous revision is then still there. Throws a
   * `RevisionConflict`, having written nothing, when another tab saved the document since this
   * library last opened or saved it.
   */
  save(doc: ManufaktureDocument, entries: readonly LogEntry[] = []): Promise<DocumentSummary> {
    return this.#run(() => this.#locked(doc.id, () => this.#save(doc, entries)));
  }

  /** Whether `head` commits the snapshot this library itself last wrote. */
  #ours(id: string, head: Head): boolean {
    const w = this.#written.get(id);
    return w?.revision === head.revision && w.sha256 === head.snapshotSha256;
  }

  #checkRevision(id: string, head: Head | null): void {
    const known = this.#known.get(id);
    if (head && known !== undefined && head.revision !== known && !this.#ours(id, head)) {
      throw new RevisionConflict(id, head.revision, known);
    }
  }

  async #save(doc: ManufaktureDocument, entries: readonly LogEntry[]): Promise<DocumentSummary> {
    const id = doc.id;
    const dir = this.#dir(id);
    let names = await this.#backend.list(dir);
    let head = await this.#head(id);
    if (!head && revisions(names, SNAPSHOT).length > 0) {
      // A damaged or missing head over saved copies: recover it first, so the save builds on
      // (and keeps) the last good revision rather than guessing.
      await this.#open(id);
      names = await this.#backend.list(dir);
      head = await this.#head(id);
    }
    this.#checkRevision(id, head);

    // This library's previous save committed (its head is there) but reported a failure, say
    // the head write threw after the bytes landed: the caller retries with those commands first,
    // and they are logged already.
    let fresh = entries;
    const written = this.#written.get(id);
    if (head && written && head.revision !== this.#known.get(id) && this.#ours(id, head)) {
      const logged = written.entries;
      if (logged.length > 0 && logged.every((e, i) => fresh[i] === e)) {
        fresh = fresh.slice(logged.length);
      }
    }

    // Whatever lies above the head is from a save that did not finish (this library's own
    // failed attempt, when it retries): delete it, so the log holds each command once. The same
    // for version lists above the one the head names. Without a head (and no snapshot that
    // reads), the newest list that reads is kept and named by the new head: never lost.
    let versions = head?.versions ?? 0;
    if (head) {
      const stale = names.filter((n) => isStale(n, head.revision, head.versions));
      for (const name of stale) await this.#backend.remove(`${dir}/${name}`);
      names = names.filter((n) => !stale.includes(n));
    } else {
      const kept = await this.#versions(id, null, names);
      versions = kept.ok ? kept.n : 0;
      const stale = names.filter((n) => {
        const list = VERSIONS.exec(n)?.[1];
        return list !== undefined && Number(list) > versions;
      });
      for (const name of stale) await this.#backend.remove(`${dir}/${name}`);
      names = names.filter((n) => !stale.includes(n));
    }
    // The revisions the versions name are kept below (step 6); read before anything is written.
    const listed = head ? await this.#versions(id, head, names) : null;
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

    const snapshot = encoder.encode(stored.text);
    const snapshotSha256 = await sha256Hex(snapshot);
    await this.#backend.write(`${dir}/${snapshotName(rev)}`, snapshot);
    this.#written.set(id, { revision: rev, sha256: snapshotSha256, entries: fresh });

    // Without locks another tab may have committed meanwhile (a save, or a version list whose
    // head this one would overwrite): look again before the commit.
    const current = await this.#head(id);
    if (
      (current?.revision ?? null) !== (head?.revision ?? null) ||
      (current?.snapshotSha256 ?? null) !== (head?.snapshotSha256 ?? null) ||
      (current?.versions ?? null) !== (head?.versions ?? null)
    ) {
      throw new RevisionConflict(id, current?.revision ?? 0, head?.revision ?? 0);
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
      versions,
    };
    await this.#backend.write(
      `${dir}/${HEAD}`,
      encoder.encode(`${JSON.stringify(next, null, 2)}\n`),
    );
    this.#known.set(id, rev);

    // The new revision is committed. The one the head named before stays as the spare; older
    // snapshots go, except the history: what a version names, the checkpoints, and a revision
    // nothing leads to (the first of an imported history). Best effort.
    if (head) await this.#prune(id, head.revision, names, listed).catch(() => undefined);
    return summaryOf(next);
  }

  async #prune(
    id: string,
    spare: number,
    names: readonly string[],
    listed: VersionsRead | null,
  ): Promise<void> {
    if (listed && (!listed.ok || listed.fallback)) {
      this.#warn(
        `manufakture: the version list of document ${id} cannot be read; no snapshot is deleted.`,
      );
      return;
    }
    const named = new Set(listed?.versions.map((v) => v.revision) ?? []);
    const dir = this.#dir(id);
    const all = revisions(names, SNAPSHOT);
    // The lowest retained snapshot is where the history starts: a document saved before
    // checkpoints existed keeps it past its first checkpoint.
    const root = Math.min(...all);
    for (const old of all) {
      if (old >= spare || old === root || isCheckpoint(old) || named.has(old)) continue;
      if (await this.#isRoot(id, old, names)) continue;
      await this.#backend.remove(`${dir}/${snapshotName(old)}`).catch(() => undefined);
    }
  }

  /**
   * The log per saved revision, oldest first: each revision with the causes, labels and times of
   * the commands that led to it, without the commands (so no imported file is read). Follows the
   * chain of segments back from the head, as `readLog` does; a save without commands, or one
   * whose segment is gone, is not listed. For the history panel's timeline.
   */
  readHistory(id: string): Promise<LibraryResult<LoggedRevision[]>> {
    return this.#run(async () => {
      if (!isStorableId(id)) return { ok: false, message: `There is no document "${id}".` };
      const chain = await this.#logChain(id);
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

  /** The log segments that lead to the head, oldest first. */
  async #logChain(id: string): Promise<LibraryResult<LogSegment[]>> {
    const dir = this.#dir(id);
    const head = await this.#head(id);
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
   * segment a failed save left behind is never part of it.
   */
  readLog(id: string): Promise<LibraryResult<LogEntry[]>> {
    return this.#run(async () => {
      if (!isStorableId(id)) return { ok: false, message: `There is no document "${id}".` };
      const blobs = this.#blobs(id);
      const chain = await this.#logChain(id);
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
   * Name the stored document's current revision: records `{ id, name, description, revision,
   * snapshotSha256, createdAt }` in a new version list, committed by the head like a save. The
   * snapshot it names is then kept for good. The caller saves first (autosave's
   * `createVersion` does); a library that knows the document refuses with `RevisionConflict`
   * when another tab saved it meanwhile, since the version would name that tab's work.
   */
  createVersion(id: string, meta: VersionMeta): Promise<LibraryResult<Version>> {
    return this.#run(async () => {
      if (!isStorableId(id)) return { ok: false, message: `There is no document "${id}".` };
      const checked = versionMeta(meta);
      if (typeof checked === 'string') return { ok: false, message: checked };
      return this.#locked(id, () =>
        this.#changeVersions(id, (versions, head) => {
          if (versions.length >= MAX_VERSIONS) {
            return `A document holds at most ${MAX_VERSIONS} versions.`;
          }
          const version: Version = {
            id: this.#newId(),
            ...checked,
            revision: head.revision,
            snapshotSha256: head.snapshotSha256,
            createdAt: this.#now().toISOString(),
          };
          return { versions: [...versions, version], result: version };
        }),
      );
    });
  }

  /** Rename a version (its id, revision and snapshot stay). Versions are never deleted. */
  renameVersion(id: string, versionId: string, name: string): Promise<LibraryResult<Version>> {
    return this.#run(async () => {
      if (!isStorableId(id)) return { ok: false, message: `There is no document "${id}".` };
      return this.#locked(id, () =>
        this.#changeVersions(id, (versions) => {
          const at = versions.findIndex((v) => v.id === versionId);
          if (at < 0) return `There is no version "${versionId}" of it.`;
          const checked = versionMeta({ name, description: versions[at]!.description });
          if (typeof checked === 'string') return checked;
          const renamed = { ...versions[at]!, name: checked.name };
          return {
            versions: versions.map((v, i) => (i === at ? renamed : v)),
            result: renamed,
          };
        }),
      );
    });
  }

  /**
   * Write a changed version list: `versions-<n+1>.json`, then the head naming it (the commit),
   * then delete the older lists (best effort). Holds the document lock.
   */
  async #changeVersions<T>(
    id: string,
    change: (
      versions: readonly Version[],
      head: Head,
    ) => string | { versions: Version[]; result: T },
  ): Promise<LibraryResult<T>> {
    // Open first: it repairs the head and deletes what a failed change left above it.
    const opened = await this.#open(id);
    if (!opened.ok) return opened;
    const dir = this.#dir(id);
    const head = await this.#head(id);
    if (!head) return { ok: false, message: 'Its head cannot be read.' };
    this.#checkRevision(id, head);
    const listed = await this.#versions(id, head);
    if (!listed.ok) return listed;
    const changed = change(listed.versions, head);
    if (typeof changed === 'string') return { ok: false, message: changed };
    // Never write a list that would not read back (a new id that is taken, say).
    if (!parseVersions(changed.versions)) {
      return { ok: false, message: 'The version list would not be valid.' };
    }
    const n = head.versions + 1;
    const file: VersionsFile = {
      format: 'manufakture-versions',
      id,
      generation: n,
      versions: changed.versions,
    };
    await this.#backend.write(
      `${dir}/${versionsName(n)}`,
      encoder.encode(`${JSON.stringify(file, null, 2)}\n`),
    );
    // Without locks another tab may have committed meanwhile: look again before the commit.
    const current = await this.#head(id);
    if (
      current?.revision !== head.revision ||
      current.snapshotSha256 !== head.snapshotSha256 ||
      current.versions !== head.versions
    ) {
      throw new RevisionConflict(id, current?.revision ?? 0, head.revision);
    }
    const next: Head = { ...head, versions: n };
    await this.#backend.write(
      `${dir}/${HEAD}`,
      encoder.encode(`${JSON.stringify(next, null, 2)}\n`),
    );
    // The list before stays as the spare: without Web Locks another tab may have deleted this
    // one as stale before the head named it, and reading then falls back to the spare.
    for (const old of revisions(await this.#backend.list(dir), VERSIONS)) {
      if (old < n - 1)
        await this.#backend.remove(`${dir}/${versionsName(old)}`).catch(() => undefined);
    }
    return { ok: true, value: changed.result };
  }

  /** The document's named versions, oldest first. Only reads. */
  listVersions(id: string): Promise<LibraryResult<Version[]>> {
    return this.#run(async () => {
      if (!isStorableId(id)) return { ok: false, message: `There is no document "${id}".` };
      return this.#locked(id, async () => {
        const names = await this.#backend.list(this.#dir(id));
        if (names.length === 0) return { ok: false, message: `There is no document "${id}".` };
        const listed = await this.#versions(id, await this.#head(id), names);
        return listed.ok ? { ok: true, value: listed.versions } : listed;
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
    return this.#run(async () => {
      if (!isStorableId(id)) return { ok: false, message: `There is no document "${id}".` };
      return this.#locked(id, async () => {
        const listed = await this.#versions(id, await this.#head(id));
        if (!listed.ok) return listed;
        const version = listed.versions.find((v) => v.id === versionId);
        if (!version) return { ok: false, message: `There is no version "${versionId}" of it.` };
        return this.#readVersion(id, version);
      });
    });
  }

  async #readVersion(
    id: string,
    version: Version,
  ): Promise<LibraryResult<{ version: Version; document: ManufaktureDocument }>> {
    const bytes = await this.#backend.read(`${this.#dir(id)}/${snapshotName(version.revision)}`);
    if (bytes && (await sha256Hex(bytes)) === version.snapshotSha256) {
      const stored = await this.#decodeSnapshot(id, bytes);
      if (stored) return { ok: true, value: { version, document: stored } };
    }
    const rebuilt = await this.#readRevision(id, version.revision);
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
    rev: number,
  ): Promise<{ bytes: Uint8Array; document: ManufaktureDocument } | null> {
    const bytes = await this.#backend.read(`${this.#dir(id)}/${snapshotName(rev)}`);
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
   * cannot be replayed into.
   */
  readRevision(
    id: string,
    rev: number,
    options: { from?: number } = {},
  ): Promise<LibraryResult<ReadRevision>> {
    return this.#run(async () => {
      if (!isStorableId(id)) return { ok: false, message: `There is no document "${id}".` };
      return this.#locked(id, () => this.#readRevision(id, rev, options.from));
    });
  }

  async #readRevision(
    id: string,
    rev: number,
    from?: number,
  ): Promise<LibraryResult<ReadRevision>> {
    const dir = this.#dir(id);
    let head = await this.#head(id);
    if (!head) {
      // Repair it first, as opening does.
      const opened = await this.#open(id);
      if (!opened.ok) return opened;
      head = await this.#head(id);
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
      const stored = await this.#readSnapshot(id, s);
      if (stored) {
        start = { rev: s, document: stored.document };
        break;
      }
    }
    if (!start) {
      const first = await this.#historyStart(id, names);
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
      const step = await this.#replay(id, k, doc, logs);
      if (kept.has(k)) {
        const stored = await this.#readSnapshot(id, k);
        if (stored && !(step.ok && (await sameStored(step.document, stored)))) {
          this.#warn(
            `manufakture: replaying the log of document ${id} does not reproduce revision ${k}` +
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
        const stored = await this.#readSnapshot(id, r);
        if (stored) {
          resumed = { rev: r, document: stored.document };
          break;
        }
      }
      this.#warn(
        `manufakture: revision ${k} of document ${id} cannot be rebuilt (${step.message})` +
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
    rev: number,
    doc: ManufaktureDocument,
    logs: ReadonlySet<number>,
  ): Promise<{ ok: true; document: ManufaktureDocument } | { ok: false; message: string }> {
    // A save without commands writes no segment: the document did not change.
    if (!logs.has(rev)) return { ok: true, document: doc };
    const bytes = await this.#backend.read(`${this.#dir(id)}/${logName(rev)}`);
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
   * document saved before snapshots were kept as history starts at its oldest remaining one.
   */
  historyStart(id: string): Promise<LibraryResult<number>> {
    return this.#run(async () => {
      if (!isStorableId(id)) return { ok: false, message: `There is no document "${id}".` };
      return this.#locked(id, async () => {
        const first = await this.#historyStart(id, await this.#backend.list(this.#dir(id)));
        return first === null
          ? { ok: false, message: 'No saved copy of it can be read.' }
          : { ok: true, value: first };
      });
    });
  }

  async #historyStart(id: string, names: readonly string[]): Promise<number | null> {
    for (const rev of revisions(names, SNAPSHOT).reverse()) {
      if (await this.#readSnapshot(id, rev)) return rev;
    }
    return null;
  }

  /** Rename a stored document, as a logged `renameDocument` command. */
  rename(id: string, name: string): Promise<LibraryResult<DocumentSummary>> {
    return this.#run(async () => {
      if (!isStorableId(id)) return { ok: false, message: `There is no document "${id}".` };
      return this.#locked(id, async () => {
        const opened = await this.#open(id);
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
        this.#known.set(id, opened.value.revision);
        return { ok: true, value: await this.#save(applied.value.document, [entry]) };
      });
    });
  }

  /** A copy under a new id, named "<name> (copy)", with its own files and no history. */
  duplicate(id: string): Promise<LibraryResult<DocumentSummary>> {
    return this.#run(async () => {
      if (!isStorableId(id)) return { ok: false, message: `There is no document "${id}".` };
      const opened = await this.#locked(id, () => this.#open(id));
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
    const summary = await this.#locked(document.id, () => this.#save(document, []));
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
      records.push({ ...version, revision: rev, snapshotSha256: last.sha256 });
    }
    const stored = encodeStored(doc);
    const written = await write(stored);
    const file: VersionsFile = {
      format: 'manufakture-versions',
      id,
      generation: 1,
      versions: records,
    };
    await this.#backend.write(
      `${dir}/${versionsName(1)}`,
      encoder.encode(`${JSON.stringify(file, null, 2)}\n`),
    );
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
    };
    await this.#backend.write(
      `${dir}/${HEAD}`,
      encoder.encode(`${JSON.stringify(head, null, 2)}\n`),
    );
    this.#known.set(id, rev);
    return summaryOf(head);
  }

  /** Delete a document and everything stored with it. */
  remove(id: string): Promise<void> {
    if (!isStorableId(id)) return Promise.reject(new Error(`Cannot delete a document "${id}"`));
    return this.#run(() =>
      this.#locked(id, async () => {
        await this.#backend.removeTree(this.#dir(id));
        this.#blobStores.delete(id);
        this.#known.delete(id);
        this.#written.delete(id);
      }),
    );
  }

  /** A new, empty-history document saved as revision 1. */
  create(doc: ManufaktureDocument): Promise<DocumentSummary> {
    return this.save(doc, []);
  }

  /**
   * The document as a `.mfk` file (see mfk.ts); with `versions`, its named versions and their
   * documents go in too (the manifest), so pins in other documents still resolve after an import.
   */
  exportMfk(
    id: string,
    options: { versions?: boolean } = {},
  ): Promise<LibraryResult<{ name: string; bytes: Uint8Array }>> {
    return this.#run(async () => {
      if (!isStorableId(id)) return { ok: false, message: `There is no document "${id}".` };
      const read = await this.#locked(
        id,
        async (): Promise<
          LibraryResult<{ document: ManufaktureDocument; versions: PackedVersion[] }>
        > => {
          const opened = await this.#open(id);
          if (!opened.ok) return opened;
          const versions: PackedVersion[] = [];
          if (options.versions) {
            const listed = await this.#versions(id, await this.#head(id));
            if (!listed.ok) return listed;
            for (const v of listed.versions) {
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
      if (!decoded.ok) return { ok: false, message: decoded.message };
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
        if (versions.length === 0) return this.#save(target, []);
        return this.#saveImported(target, versions);
      });
      return { ok: true, value: { summary, migrated: decoded.migrated } };
    });
  }
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
