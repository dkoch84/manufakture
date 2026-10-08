// A throwaway Node file system backend for the library: `StorageBackend` (five operations on
// paths under a root directory) on `node:fs/promises`, plus the one-writer-per-branch lock the
// session model asks for. Not the real one (T8.1a owns that); enough to run the library's
// crash-safe scheme on disk and to measure what a save costs.
//
// The library never relies on a write being atomic (OPFS has no atomic replace), so a plain
// `writeFile` would do; it writes a temporary file and renames it anyway, which costs one more
// metadata operation and means a reader never sees a torn file.

import { mkdir, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { segments, type BackendKind, type StorageBackend } from './vendor/persistence/backend';

export class NodeFsBackend implements StorageBackend {
  // `BackendKind` is 'opfs' | 'indexeddb' | 'memory': a Node backend needs a kind of its own in
  // T8.1a. Nothing in the library branches on it.
  readonly kind = 'memory' as BackendKind;
  readonly root: string;
  /** Operations and bytes, for the report. */
  readonly counts = { reads: 0, writes: 0, bytesWritten: 0, removes: 0, lists: 0 };
  #tmp = 0;

  constructor(root: string) {
    this.root = root;
  }

  #path(path: string): string {
    return join(this.root, ...segments(path));
  }

  async read(path: string): Promise<Uint8Array | null> {
    this.counts.reads++;
    try {
      return new Uint8Array(await readFile(this.#path(path)));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  }

  async write(path: string, bytes: Uint8Array): Promise<void> {
    this.counts.writes++;
    this.counts.bytesWritten += bytes.length;
    const file = this.#path(path);
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${++this.#tmp}.tmp`;
    await writeFile(tmp, bytes);
    await rename(tmp, file);
  }

  async remove(path: string): Promise<void> {
    this.counts.removes++;
    await rm(this.#path(path), { force: true });
  }

  async removeTree(dir: string): Promise<void> {
    this.counts.removes++;
    await rm(this.#path(dir), { recursive: true, force: true });
  }

  async list(dir: string): Promise<string[]> {
    this.counts.lists++;
    try {
      const names = await readdir(this.#path(dir));
      // The temporary files of a write in flight (or of one a crash cut short) are not entries.
      return names.filter((n) => !n.endsWith('.tmp')).sort();
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw e;
    }
  }
}

/** Thrown when another session (this process or another) holds the branch. */
export class BranchLocked extends Error {}

/**
 * Take the writer's lock on one branch of one document: a lock file created with O_EXCL, holding
 * the owner's pid and session id. Across processes, unlike `navigator.locks` (which Node 26 has,
 * but only within one process: the library's own locks therefore serialize this process only).
 * A stale lock (its pid gone) is taken over.
 */
export async function lockBranch(
  root: string,
  documentId: string,
  branch: string,
  sessionId: string,
): Promise<() => Promise<void>> {
  const dir = join(root, 'locks');
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${documentId}.${branch}.lock`);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(file, 'wx');
      await handle.writeFile(JSON.stringify({ pid: process.pid, sessionId }));
      await handle.close();
      return () => rm(file, { force: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const owner = JSON.parse(await readFile(file, 'utf8').catch(() => '{}')) as { pid?: number };
      if (owner.pid !== undefined && alive(owner.pid)) {
        throw new BranchLocked(`branch ${branch} of ${documentId} is open in another session`);
      }
      await rm(file, { force: true });
    }
  }
  throw new BranchLocked(`could not lock branch ${branch} of ${documentId}`);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A fresh library directory under `base` (a test's temp dir). */
export async function freshRoot(base: string, name: string): Promise<string> {
  const root = join(base, name);
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  return root;
}
