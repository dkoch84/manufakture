// Picking the browser's storage, and what the home screen says about it: how much is used, and
// whether the browser has agreed to keep it (persistent storage is not evicted under pressure).

import { memoryBackend, type StorageBackend, DocumentLibrary } from '@manufakture/library';
import { appMergeValidator } from '../history/mergeValidator';
import { openIdb } from './idb';
import { openOpfs } from './opfs';

/** OPFS when it works, else IndexedDB, else memory (nothing survives a reload). */
export async function openBrowserBackend(): Promise<StorageBackend> {
  return (await openOpfs()) ?? (await openIdb()) ?? memoryBackend();
}

export async function openBrowserLibrary(): Promise<DocumentLibrary> {
  // Merges combine two branches' domain data and extension params only into values the app's
  // domains read.
  return new DocumentLibrary(await openBrowserBackend(), { mergeValidator: appMergeValidator });
}

export interface StorageInfo {
  /** Bytes this site uses, and may use, as the browser estimates them; null when unknown. */
  usage: number | null;
  quota: number | null;
  /** Whether the browser keeps this site's data under storage pressure; null when unknown. */
  persisted: boolean | null;
}

type StorageLike = Pick<StorageManager, 'estimate' | 'persisted' | 'persist'>;

function storageManager(): StorageLike | null {
  return typeof navigator !== 'undefined' && navigator.storage ? navigator.storage : null;
}

export async function storageInfo(
  storage: StorageLike | null = storageManager(),
): Promise<StorageInfo> {
  if (!storage) return { usage: null, quota: null, persisted: null };
  const [estimate, persisted] = await Promise.all([
    storage.estimate().catch(() => null),
    storage.persisted().catch(() => null),
  ]);
  return { usage: estimate?.usage ?? null, quota: estimate?.quota ?? null, persisted };
}

/**
 * Ask the browser to keep this site's storage. Some browsers decide silently, some ask the
 * user; either way the answer is returned (false when there is no API).
 */
export async function requestPersistence(
  storage: StorageLike | null = storageManager(),
): Promise<boolean> {
  if (!storage) return false;
  try {
    return (await storage.persisted()) || (await storage.persist());
  } catch {
    return false;
  }
}
