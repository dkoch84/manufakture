// The user's tool library (T5.1d): app-level, in the browser's storage (OPFS, or the fallbacks
// `openBrowserBackend` picks), separate from documents. A document never refers to it; "use in
// document" copies a tool into the document's `cam.tools` (`use-in-document.ts`).
//
// Layout: `cam-library/tools-<n>.json`, one whole library file per write, `<n>` zero-padded to
// eight digits. Nothing is overwritten in place that a reader relies on: a save writes the next
// number (above every library and rejected file, so a number is never reused), then deletes the
// file it read and the older ones below it, which that file superseded and which are deleted
// unread. So a crash leaves either the old file or the new one readable. Loading takes the newest
// file that parses and validates. Every file is outside input (another build, another tab, a
// damaged disk) and checked strictly, like an imported one. A newer file that does not read is
// never deleted: a save first copies it aside to `rejected-tools-<n>.json` (or
// `rejected-tools-<n>-<k>.json` when that name holds other bytes; names the loader ignores), and
// only then removes it, for the user or a newer build to recover. A copy whose bytes are already
// kept is not made again (a retry after a crash). At most `MAX_REJECTED` (5) rejected copies are
// kept: after a successful save, every copy this save made or found already kept stays, and the
// remaining slots go to the newest older copies; the rest are deleted (a save that sets more than
// five aside keeps them all). File numbers stop at 99999999, the most eight digits hold: a save that
// would need a higher one is refused before it changes anything. When there are library files
// and none reads, nothing is saved at all.

import {
  LIBRARY_LIMITS,
  parseToolLibrary,
  serializeToolLibrary,
  validateLibraryTool,
  type LibraryTool,
} from '@manufakture/cam/library';
import { browserLocks, type DocumentLocks } from '../../persistence/library';
import type { StorageBackend } from '../../persistence/backend';

export const TOOL_LIBRARY_DIR = 'cam-library';
/** The library id a copied user tool's `source.library` names. */
export const USER_LIBRARY_ID = 'user';
/**
 * The largest library JSON accepted, for import and for a save: UTF-16 units of text, and bytes
 * of a picked file (about 8 MB).
 */
export const MAX_LIBRARY_JSON = 8 * 1024 * 1024;

const FILE = /^tools-(\d{8})\.json$/;
const REJECTED = /^rejected-tools-(\d{8})(?:-(\d+))?\.json$/;
/** The most rejected copies kept: the newest ones (by file number, then suffix). */
export const MAX_REJECTED = 5;
/** The highest file number the eight-digit pattern can name; a save never goes past it. */
export const MAX_FILE_NUMBER = 99_999_999;
const LOCK = 'manufakture-tool-library';
/** How often a load lists again when every file it listed vanished meanwhile (another tab saved). */
const RELIST_ATTEMPTS = 3;

const fileName = (n: number) => `tools-${String(n).padStart(8, '0')}.json`;
/** Where a library file that does not read is kept: the loader's pattern does not match it. */
export const rejectedName = (n: number, k = 0) =>
  `rejected-tools-${String(n).padStart(8, '0')}${k > 0 ? `-${k}` : ''}.json`;

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export type LibraryResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

export interface ImportSummary {
  readonly added: number;
  readonly replaced: number;
}

/** What a load found: the tools, the file they came from, and the newer files that did not read. */
interface Loaded {
  readonly tools: readonly LibraryTool[];
  /** The file number read, or null when there were no library files. */
  readonly revision: number | null;
  /** Files above `revision` that are present but do not read. */
  readonly rejected: readonly number[];
}

const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

function describe(e: unknown): string {
  if (typeof e === 'object' && e !== null && 'message' in e && typeof e.message === 'string') {
    return e.message;
  }
  return String(e);
}

/**
 * The user's tool library on a storage backend. Every change reads, edits and writes the whole
 * library holding a Web Lock (where the browser has them) and in an in-process queue, so neither
 * two tabs nor two calls in one tab lose each other's edits. Nothing here rejects: storage errors
 * (a full quota, say) come back as `{ ok: false, error }`.
 */
export class ToolLibraryStore {
  readonly #backend: StorageBackend;
  readonly #locks: DocumentLocks | null;
  readonly #decoder = new TextDecoder('utf-8', { fatal: true });
  readonly #encoder = new TextEncoder();
  #queue: Promise<unknown> = Promise.resolve();

  constructor(backend: StorageBackend, options: { locks?: DocumentLocks | null } = {}) {
    this.#backend = backend;
    this.#locks = options.locks === undefined ? browserLocks() : options.locks;
  }

  /** Runs `op` after every earlier operation of this store, holding the cross-tab lock if any. */
  #locked<T>(op: () => Promise<T>): Promise<T> {
    const run = () => (this.#locks ? this.#locks.request(LOCK, op) : op());
    const next = this.#queue.then(run, run);
    this.#queue = next.catch(() => undefined);
    return next;
  }

  /** File numbers present, highest first. */
  async #revisions(): Promise<number[]> {
    const names = await this.#backend.list(TOOL_LIBRARY_DIR);
    return names
      .map((n) => FILE.exec(n))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => Number(m[1]))
      .filter((n) => Number.isSafeInteger(n))
      .sort((a, b) => b - a);
  }

  /** The rejected copies present, newest first (by file number, then suffix). */
  async #rejectedFiles(): Promise<{ name: string; n: number; k: number }[]> {
    const names = await this.#backend.list(TOOL_LIBRARY_DIR);
    return names
      .map((name) => ({ name, m: REJECTED.exec(name) }))
      .filter((x): x is { name: string; m: RegExpExecArray } => x.m !== null)
      .map(({ name, m }) => ({ name, n: Number(m[1]), k: m[2] === undefined ? 0 : Number(m[2]) }))
      .filter((r) => Number.isSafeInteger(r.n) && Number.isSafeInteger(r.k))
      .sort((a, b) => b.n - a.n || b.k - a.k);
  }

  /**
   * Copies the bytes of library file `n`, which did not read, to a rejected name: the first of
   * `rejected-tools-<n>.json`, `-1`, `-2`, ... that is free, never over other bytes. Nothing is
   * written when a candidate already holds exactly these bytes.
   */
  async #keepRejected(n: number, bytes: Uint8Array): Promise<string> {
    for (let k = 0; ; k++) {
      const name = rejectedName(n, k);
      const path = `${TOOL_LIBRARY_DIR}/${name}`;
      const existing = await this.#backend.read(path);
      if (existing === null) {
        await this.#backend.write(path, bytes);
        return name;
      }
      if (sameBytes(existing, bytes)) return name;
    }
  }

  /**
   * Deletes rejected copies beyond `MAX_REJECTED` (best effort), lowest numbers first, but never
   * one this save made or found already kept (`current`): storage keeps no insertion order, and
   * stale copies with higher numbers must not push out what this save just set aside.
   */
  async #pruneRejected(current: ReadonlySet<string>): Promise<void> {
    const files = await this.#rejectedFiles();
    const excess = files.length - Math.max(MAX_REJECTED, current.size);
    if (excess <= 0) return;
    const candidates = files.filter((f) => !current.has(f.name)).reverse(); // oldest first
    for (const old of candidates.slice(0, excess)) {
      await this.#backend.remove(`${TOOL_LIBRARY_DIR}/${old.name}`).catch((e: unknown) => {
        console.warn(`Tool library: could not delete ${old.name}`, e);
      });
    }
  }

  /**
   * The newest readable library. Fails when library files are present and none reads, so that a
   * save never replaces a library this build cannot read.
   */
  async #load(): Promise<LibraryResult<Loaded>> {
    for (let attempt = 0; attempt < RELIST_ATTEMPTS; attempt++) {
      const revisions = await this.#revisions();
      if (revisions.length === 0)
        return { ok: true, value: { tools: [], revision: null, rejected: [] } };
      const rejected: number[] = [];
      for (const n of revisions) {
        const bytes = await this.#backend.read(`${TOOL_LIBRARY_DIR}/${fileName(n)}`);
        if (!bytes) continue; // gone since the listing: another tab's save cleaned it up
        let text: string | null;
        try {
          text = this.#decoder.decode(bytes);
        } catch {
          text = null;
        }
        const r = text === null ? null : parseToolLibrary(text);
        if (r?.ok) return { ok: true, value: { tools: r.value.tools, revision: n, rejected } };
        rejected.push(n);
        console.warn(
          `Tool library: ${fileName(n)} does not read (${r ? r.error.message : 'not UTF-8 text'}); it is kept and an older file is used`,
        );
      }
      if (rejected.length > 0) {
        return fail(
          `The tool library on this device cannot be read (${rejected.map(fileName).join(', ')}): it may come from a newer version or be damaged. Nothing is saved over it.`,
        );
      }
      // Every listed file vanished between the listing and the read: list again.
    }
    return fail('The tool library kept changing while it was read; try again.');
  }

  /**
   * Writes `tools` as the next file after `loaded`, keeps the files that did not read under
   * their rejected names, then deletes the files at or below the one read.
   */
  async #write(loaded: Loaded, tools: readonly LibraryTool[]): Promise<LibraryResult<void>> {
    const text = serializeToolLibrary(tools);
    if (text.length > MAX_LIBRARY_JSON) {
      return fail('The tool library would be too large to save');
    }
    try {
      const revisions = await this.#revisions();
      const rejectedFiles = await this.#rejectedFiles();
      const highest = Math.max(0, ...revisions, ...rejectedFiles.map((r) => r.n));
      const next = highest + 1;
      if (!Number.isSafeInteger(next) || next > MAX_FILE_NUMBER) {
        return fail(
          `The tool library cannot be saved: a file in its storage is numbered ${highest}, and the highest number a library file can have is ${MAX_FILE_NUMBER}. Nothing was changed.`,
        );
      }
      const kept = new Set<string>();
      // Keep every file that did not read before anything is deleted (a copy first: there is no
      // rename in every backend, and a crash between the two steps leaves both).
      for (const n of loaded.rejected) {
        const path = `${TOOL_LIBRARY_DIR}/${fileName(n)}`;
        const bytes = await this.#backend.read(path);
        if (!bytes) continue;
        kept.add(await this.#keepRejected(n, bytes));
        await this.#backend.remove(path);
      }
      await this.#backend.write(
        `${TOOL_LIBRARY_DIR}/${fileName(next)}`,
        this.#encoder.encode(text),
      );
      if (loaded.revision !== null) {
        for (const n of revisions) {
          if (n > loaded.revision || loaded.rejected.includes(n)) continue;
          await this.#backend.remove(`${TOOL_LIBRARY_DIR}/${fileName(n)}`).catch((e: unknown) => {
            console.warn(`Tool library: could not delete ${fileName(n)}`, e);
          });
        }
      }
      // Saved: pruning old rejected copies is best effort and never fails the save.
      await this.#pruneRejected(kept).catch((e: unknown) => {
        console.warn('Tool library: could not prune rejected copies', e);
      });
      return { ok: true, value: undefined };
    } catch (e) {
      return fail(`The tool library could not be saved: ${describe(e)}`);
    }
  }

  /** Reads, edits and writes the library under the lock; any storage error becomes a value. */
  #change<T>(
    edit: (
      tools: readonly LibraryTool[],
    ) => LibraryResult<{ tools?: readonly LibraryTool[]; value: T }>,
  ): Promise<LibraryResult<T>> {
    return this.#locked(async () => {
      try {
        const loaded = await this.#load();
        if (!loaded.ok) return loaded;
        const edited = edit(loaded.value.tools);
        if (!edited.ok) return edited;
        if (edited.value.tools) {
          const written = await this.#write(loaded.value, edited.value.tools);
          if (!written.ok) return written;
        }
        return { ok: true, value: edited.value.value };
      } catch (e) {
        return fail(`The tool library could not be read: ${describe(e)}`);
      }
    });
  }

  /** The user's tools, in their stored order; fails when the stored library cannot be read. */
  list(): Promise<LibraryResult<readonly LibraryTool[]>> {
    return this.#change((tools) => ({ ok: true, value: { value: tools } }));
  }

  /** Adds `tool`, or replaces the tool with its id. Refused (nothing written) when it is invalid. */
  put(tool: unknown): Promise<LibraryResult<LibraryTool>> {
    const checked = validateLibraryTool(tool);
    if (!checked.ok) return Promise.resolve(fail(checked.error.message));
    const t = checked.value;
    return this.#change((current) => {
      const tools = [...current];
      const i = tools.findIndex((x) => x.id === t.id);
      if (i >= 0) tools[i] = t;
      else if (tools.length >= LIBRARY_LIMITS.tools) {
        return fail(`The library holds at most ${LIBRARY_LIMITS.tools} tools`);
      } else tools.push(t);
      return { ok: true, value: { tools, value: t } };
    });
  }

  /** Removes the tool with `id`; `false` when there was none (nothing written). */
  remove(id: string): Promise<LibraryResult<boolean>> {
    return this.#change((tools) => {
      const kept = tools.filter((t) => t.id !== id);
      return kept.length === tools.length
        ? { ok: true, value: { value: false } }
        : { ok: true, value: { tools: kept, value: true } };
    });
  }

  /**
   * How many library files are kept aside under rejected names (files that did not read, set
   * aside by a save or a reset), for the UI to say so; they stay for the user or a newer build.
   */
  keptAside(): Promise<LibraryResult<number>> {
    return this.#locked(async () => {
      try {
        return { ok: true as const, value: (await this.#rejectedFiles()).length };
      } catch (e) {
        return fail(`The tool library could not be read: ${describe(e)}`);
      }
    });
  }

  /**
   * Start an empty library: every library file is first copied aside to a rejected name (so
   * nothing is lost, as a save keeps a file that does not read), then removed. The way out of a
   * library whose files this build cannot read, where every save is refused.
   */
  reset(): Promise<LibraryResult<{ keptAside: number }>> {
    return this.#locked(async () => {
      try {
        const kept = new Set<string>();
        for (const n of await this.#revisions()) {
          const path = `${TOOL_LIBRARY_DIR}/${fileName(n)}`;
          const bytes = await this.#backend.read(path);
          if (!bytes) continue;
          kept.add(await this.#keepRejected(n, bytes));
          await this.#backend.remove(path);
        }
        await this.#pruneRejected(kept).catch((e: unknown) => {
          console.warn('Tool library: could not prune rejected copies', e);
        });
        return { ok: true as const, value: { keptAside: kept.size } };
      } catch (e) {
        return fail(`The tool library could not be reset: ${describe(e)}`);
      }
    });
  }

  /** The library as JSON text, for a download. */
  async exportJson(): Promise<LibraryResult<string>> {
    const r = await this.list();
    return r.ok ? { ok: true, value: serializeToolLibrary(r.value) } : r;
  }

  /**
   * Imports a library file, checked strictly; nothing is written when any of it is invalid.
   * `merge` adds the file's tools and replaces those with the same id; `replace` makes the
   * library exactly the file's tools. A picked `File` (any `Blob`) is size-checked before it is
   * read; a caller passing text it read itself must check the file's size first.
   */
  async importJson(
    input: string | Blob,
    mode: 'merge' | 'replace' = 'merge',
  ): Promise<LibraryResult<ImportSummary>> {
    let json: string;
    if (typeof input === 'string') {
      json = input;
    } else {
      if (input.size > MAX_LIBRARY_JSON) return fail('The file is too large for a tool library');
      try {
        json = await input.text();
      } catch (e) {
        return fail(`The file could not be read: ${describe(e)}`);
      }
    }
    if (json.length > MAX_LIBRARY_JSON) return fail('The file is too large for a tool library');
    const parsed = parseToolLibrary(json);
    if (!parsed.ok) return fail(parsed.error.message);
    const incoming = parsed.value.tools;
    return this.#change((existing) => {
      const current = mode === 'replace' ? [] : [...existing];
      let replaced = 0;
      let added = 0;
      for (const t of incoming) {
        const i = current.findIndex((x) => x.id === t.id);
        if (i >= 0) {
          current[i] = t;
          replaced++;
        } else {
          current.push(t);
          added++;
        }
      }
      if (current.length > LIBRARY_LIMITS.tools) {
        return fail(`The library would hold more than ${LIBRARY_LIMITS.tools} tools`);
      }
      return { ok: true, value: { tools: current, value: { added, replaced } } };
    });
  }
}
