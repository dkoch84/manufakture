// The Origin Private File System backend (ADR 0004 decision 8). Files are written through
// `createWritable`, which some browsers apply atomically on close and others do not; the
// library's scheme does not depend on it either way.

import { segments, type StorageBackend } from '@manufakture/library';

/** The directory iteration OPFS has, which the DOM typings in use do not all declare. */
interface IterableDirectory extends FileSystemDirectoryHandle {
  keys(): AsyncIterableIterator<string>;
}

function isNotFound(e: unknown): boolean {
  return (
    e instanceof DOMException && (e.name === 'NotFoundError' || e.name === 'TypeMismatchError')
  );
}

export class OpfsBackend implements StorageBackend {
  readonly kind = 'opfs';
  readonly #root: FileSystemDirectoryHandle;

  constructor(root: FileSystemDirectoryHandle) {
    this.#root = root;
  }

  /** The directory at `parts`, or null when a step is missing (and `create` is off). */
  async #dir(parts: readonly string[], create: boolean): Promise<FileSystemDirectoryHandle | null> {
    let dir = this.#root;
    try {
      for (const p of parts) dir = await dir.getDirectoryHandle(p, { create });
    } catch (e) {
      if (!create && isNotFound(e)) return null;
      throw e;
    }
    return dir;
  }

  async read(path: string): Promise<Uint8Array | null> {
    const parts = segments(path);
    const dir = await this.#dir(parts.slice(0, -1), false);
    if (!dir) return null;
    try {
      const handle = await dir.getFileHandle(parts.at(-1)!);
      return new Uint8Array(await (await handle.getFile()).arrayBuffer());
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e;
    }
  }

  async write(path: string, bytes: Uint8Array): Promise<void> {
    const parts = segments(path);
    const dir = (await this.#dir(parts.slice(0, -1), true))!;
    const handle = await dir.getFileHandle(parts.at(-1)!, { create: true });
    const writable = await handle.createWritable();
    try {
      await writable.write(bytes as Uint8Array<ArrayBuffer>);
      await writable.close();
    } catch (e) {
      await writable.abort().catch(() => undefined);
      throw e;
    }
  }

  async remove(path: string): Promise<void> {
    const parts = segments(path);
    const dir = await this.#dir(parts.slice(0, -1), false);
    if (!dir) return;
    try {
      await dir.removeEntry(parts.at(-1)!);
    } catch (e) {
      if (!isNotFound(e)) throw e;
    }
  }

  async removeTree(path: string): Promise<void> {
    const parts = segments(path);
    const dir = await this.#dir(parts.slice(0, -1), false);
    if (!dir) return;
    try {
      await dir.removeEntry(parts.at(-1)!, { recursive: true });
    } catch (e) {
      if (!isNotFound(e)) throw e;
    }
  }

  async list(path: string): Promise<string[]> {
    const dir = (await this.#dir(segments(path), false)) as IterableDirectory | null;
    if (!dir) return [];
    const names: string[] = [];
    for await (const name of dir.keys()) names.push(name);
    return names.sort();
  }
}

/**
 * The OPFS backend, when this browser has one that works: a probe file is written, read back
 * and deleted, since some browsers expose the API but refuse writes (private windows).
 */
export async function openOpfs(): Promise<OpfsBackend | null> {
  try {
    if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) return null;
    const root = await navigator.storage.getDirectory();
    const backend = new OpfsBackend(root);
    const probe = new Uint8Array([1, 2, 3]);
    await backend.write('probe/probe.bin', probe);
    const back = await backend.read('probe/probe.bin');
    await backend.removeTree('probe');
    return back && back.length === 3 ? backend : null;
  } catch {
    return null;
  }
}
