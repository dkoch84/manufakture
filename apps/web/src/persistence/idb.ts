// The IndexedDB backend, for browsers without a usable OPFS: one object store of paths to
// bytes. Each write is its own transaction, so it is atomic here; the library does not rely
// on that.

import { segments, type StorageBackend } from './backend';

const DB_NAME = 'manufakture';
const STORE = 'files';

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error('IndexedDB request failed'));
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
  });
}

/** Keys that start with `prefix`. */
const under = (prefix: string) => IDBKeyRange.bound(prefix, `${prefix}￿`);

export class IdbBackend implements StorageBackend {
  readonly kind = 'indexeddb';
  readonly #db: IDBDatabase;

  constructor(db: IDBDatabase) {
    this.#db = db;
  }

  async read(path: string): Promise<Uint8Array | null> {
    segments(path);
    const tx = this.#db.transaction(STORE, 'readonly');
    const value: unknown = await request(tx.objectStore(STORE).get(path));
    return value instanceof Uint8Array ? value : null;
  }

  async write(path: string, bytes: Uint8Array): Promise<void> {
    segments(path);
    const tx = this.#db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(bytes.slice(), path);
    await done(tx);
  }

  async remove(path: string): Promise<void> {
    segments(path);
    const tx = this.#db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(path);
    await done(tx);
  }

  async removeTree(dir: string): Promise<void> {
    segments(dir);
    const tx = this.#db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(under(`${dir}/`));
    await done(tx);
  }

  async list(dir: string): Promise<string[]> {
    segments(dir);
    const prefix = `${dir}/`;
    const tx = this.#db.transaction(STORE, 'readonly');
    const keys = await request(tx.objectStore(STORE).getAllKeys(under(prefix)));
    const names = new Set<string>();
    for (const k of keys) names.add(String(k).slice(prefix.length).split('/')[0]!);
    return [...names].sort();
  }
}

/** The IndexedDB backend, or null when this browser has none (or refuses to open it). */
export async function openIdb(): Promise<IdbBackend | null> {
  try {
    if (typeof indexedDB === 'undefined') return null;
    const open = indexedDB.open(DB_NAME, 1);
    open.onupgradeneeded = () => {
      if (!open.result.objectStoreNames.contains(STORE)) open.result.createObjectStore(STORE);
    };
    return new IdbBackend(await request(open));
  } catch {
    return null;
  }
}
