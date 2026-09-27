// The document library: every document the browser holds, stored so that a crash at any point
// never loses the last saved state. See docs/user/files.md for the user's view and the README
// in this directory for the layout.
//
// Layout, per document (`documents/<id>/`):
//
//   head.json               the pointer: which snapshot is current, its SHA-256, name, dates
//   snapshot-<rev>.json     the document at revision <rev>, in storage form (blobs.ts)
//   log-<rev>.json          the commands that led from the previous revision to <rev>
//   blobs/<sha256>          each imported file, once
//
// A save never overwrites a file anything points at. It first deletes what an earlier failed
// save left above the head, then writes, in order: new blobs, the log segment,
// `snapshot-<rev+1>.json` (a new name), and last `head.json`; then it deletes snapshots older
// than the one the head named before (that one stays as the spare). Writes are not assumed
// atomic (OPFS has no atomic replace or rename in every browser), so loading trusts nothing: it
// takes the newest snapshot that reads completely (JSON parses, the document migrates and
// validates, every blob matches its hash), rewrites the head if it was stale or damaged, and
// deletes the files of any later, broken save above the head. A crash before the new snapshot is
// complete leaves the previous one; a crash after it, before the head, is recovered forward. A
// later snapshot that is complete (its JSON parses) but does not read as a valid document (a
// blob it needs went missing, or a future release checks more) is not a torn write: before
// anything is repointed or deleted, it and its log segment are copied aside as
// `damaged-snapshot-<rev>-<sha>.json` and `damaged-log-<rev>-<sha>.json`, names nothing else
// matches, so they stay until the document is deleted.
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
import { BlobStore, blobRefs, externalize, hydrateFrom } from './blobs';

export const ROOT = 'documents';
const HEAD = 'head.json';
const SNAPSHOT = /^snapshot-(\d{1,12})\.json$/;
const LOG = /^log-(\d{1,12})\.json$/;

const pad = (rev: number) => String(rev).padStart(8, '0');
const snapshotName = (rev: number) => `snapshot-${pad(rev)}.json`;
const logName = (rev: number) => `log-${pad(rev)}.json`;
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
      typeof h.savedAt === 'string';
    return valid ? (h as Head) : null;
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
    if (recovered) await this.#repair(id, rev, bytes, document, head);
    // Only what lies above both the head and the revision found: never the snapshot the head
    // named (even when it could not be read) or anything below it.
    await this.#dropAbove(id, Math.max(rev, head?.revision ?? rev), names);
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
    };
    await this.#backend.write(
      `${dir}/${HEAD}`,
      encoder.encode(`${JSON.stringify(head, null, 2)}\n`),
    );
  }

  /** Delete the logs and snapshots above revision `rev`: what a save that died left behind. */
  async #dropAbove(id: string, rev: number, names: readonly string[]): Promise<void> {
    const dir = this.#dir(id);
    for (const name of names) {
      const later = (SNAPSHOT.exec(name) ?? LOG.exec(name))?.[1];
      if (later !== undefined && Number(later) > rev) await this.#backend.remove(`${dir}/${name}`);
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
    // failed attempt, when it retries): delete it, so the log holds each command once.
    if (head) {
      const committed = head.revision;
      const stale = names.filter((n) => {
        const r = (SNAPSHOT.exec(n) ?? LOG.exec(n))?.[1];
        return r !== undefined && Number(r) > committed;
      });
      for (const name of stale) await this.#backend.remove(`${dir}/${name}`);
      names = names.filter((n) => !stale.includes(n));
    }
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

    // Without locks another tab may have committed meanwhile: look again before the commit.
    const current = await this.#head(id);
    if (
      (current?.revision ?? null) !== (head?.revision ?? null) ||
      (current?.snapshotSha256 ?? null) !== (head?.snapshotSha256 ?? null)
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
    };
    await this.#backend.write(
      `${dir}/${HEAD}`,
      encoder.encode(`${JSON.stringify(next, null, 2)}\n`),
    );
    this.#known.set(id, rev);

    // The new revision is committed. The one the head named before stays as the spare; older
    // snapshots go.
    if (head) {
      for (const old of revisions(names, SNAPSHOT)) {
        if (old < head.revision)
          await this.#backend.remove(`${dir}/${snapshotName(old)}`).catch(() => undefined);
      }
    }
    return summaryOf(next);
  }

  /**
   * The command log, oldest first, with imported files put back (and checked). It follows the
   * chain of segments back from the head (each names the revision it started from), so a
   * segment a failed save left behind is never part of it.
   */
  readLog(id: string): Promise<LibraryResult<LogEntry[]>> {
    return this.#run(async () => {
      if (!isStorableId(id)) return { ok: false, message: `There is no document "${id}".` };
      const dir = this.#dir(id);
      const blobs = this.#blobs(id);
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
      const out: LogEntry[] = [];
      try {
        for (const segment of chain.reverse()) {
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

  /** The document as a `.mfk` file (see mfk.ts). */
  exportMfk(id: string): Promise<LibraryResult<{ name: string; bytes: Uint8Array }>> {
    return this.#run(async () => {
      if (!isStorableId(id)) return { ok: false, message: `There is no document "${id}".` };
      const opened = await this.#locked(id, () => this.#open(id));
      if (!opened.ok) return opened;
      return { ok: true, value: await packDocument(opened.value.document) };
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
      let doc = decoded.document;
      if (!isStorableId(doc.id)) doc = { ...doc, id: this.#newId() };
      const wanted = doc;
      // Under the id's lock, so another tab cannot take the id between the check and the save.
      const summary = await this.#locked(wanted.id, async () => {
        const taken = (await this.#backend.list(this.#dir(wanted.id))).length > 0;
        // A new id is a fresh UUID: nothing else can hold it.
        return this.#save(taken ? { ...wanted, id: this.#newId() } : wanted, []);
      });
      return { ok: true, value: { summary, migrated: decoded.migrated } };
    });
  }
}

/** `doc` as a `.mfk` file, named after it. */
export async function packDocument(
  doc: ManufaktureDocument,
): Promise<{ name: string; bytes: Uint8Array }> {
  const stored = encodeStored(doc);
  const blobs = new Map([...stored.blobs].map(([sha, data]) => [sha, fromBase64(data)]));
  const { packMfk } = await import('./mfk');
  return { name: fileName(doc.name, 'mfk'), bytes: packMfk(stored.text, blobs) };
}
