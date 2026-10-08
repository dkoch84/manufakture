// Where documents are stored: a tiny file system of paths ('documents/<id>/head.json') to bytes.
// The library (library.ts) builds its crash-safe scheme on these few operations, and never
// relies on a write being atomic or on a rename existing, since OPFS offers neither in every
// browser. In the app: OPFS and IndexedDB when OPFS is missing (apps/web/src/persistence); here,
// memory, for tests and for a browser with no storage at all; and a directory on disk in Node
// (node.ts, `@manufakture/library/node`).

export type BackendKind = 'opfs' | 'indexeddb' | 'memory' | 'node';

export interface StorageBackend {
  readonly kind: BackendKind;
  /** The bytes of the file at `path`, or null when there is none. */
  read(path: string): Promise<Uint8Array | null>;
  /**
   * Replace the file at `path` with `bytes`, creating directories as needed. Not atomic: a
   * crash may leave the file missing, empty or cut short.
   */
  write(path: string, bytes: Uint8Array): Promise<void>;
  /** Delete the file at `path`; nothing happens when there is none. */
  remove(path: string): Promise<void>;
  /** Delete the directory `dir` and everything in it; nothing happens when there is none. */
  removeTree(dir: string): Promise<void>;
  /** Names of the files and directories directly in `dir` (none when it does not exist). */
  list(dir: string): Promise<string[]>;
}

/** Path segments, refusing empty ones and `.` or `..`, so a path never leaves the root. */
export function segments(path: string): string[] {
  const parts = path.split('/');
  for (const p of parts) {
    if (p === '' || p === '.' || p === '..') throw new Error(`Invalid storage path: ${path}`);
  }
  return parts;
}

/** Everything in memory: tests, and browsers without OPFS or IndexedDB (nothing survives). */
export class MemoryBackend implements StorageBackend {
  readonly kind = 'memory';
  readonly files = new Map<string, Uint8Array>();

  async read(path: string): Promise<Uint8Array | null> {
    segments(path);
    const bytes = this.files.get(path);
    return bytes ? bytes.slice() : null;
  }

  async write(path: string, bytes: Uint8Array): Promise<void> {
    segments(path);
    this.files.set(path, bytes.slice());
  }

  async remove(path: string): Promise<void> {
    segments(path);
    this.files.delete(path);
  }

  async removeTree(dir: string): Promise<void> {
    segments(dir);
    const prefix = `${dir}/`;
    for (const key of [...this.files.keys()]) if (key.startsWith(prefix)) this.files.delete(key);
  }

  async list(dir: string): Promise<string[]> {
    segments(dir);
    const prefix = `${dir}/`;
    const names = new Set<string>();
    for (const key of this.files.keys()) {
      if (key.startsWith(prefix)) names.add(key.slice(prefix.length).split('/')[0]!);
    }
    return [...names].sort();
  }
}

export function memoryBackend(): MemoryBackend {
  return new MemoryBackend();
}
