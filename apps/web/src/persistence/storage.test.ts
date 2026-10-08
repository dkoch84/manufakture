import { describe, expect, it } from 'vitest';
import { openIdb } from './idb';
import { openOpfs } from './opfs';
import { openBrowserBackend, requestPersistence, storageInfo } from './storage';

describe('the browser backend', () => {
  it('falls back to memory where there is neither OPFS nor IndexedDB (as in jsdom)', async () => {
    expect(await openOpfs()).toBeNull();
    expect(await openIdb()).toBeNull();
    expect((await openBrowserBackend()).kind).toBe('memory');
  });

  it('reports storage use and asks for persistence through the storage manager', async () => {
    let persisted = false;
    const manager = {
      estimate: async () => ({ usage: 1234, quota: 5678 }),
      persisted: async () => persisted,
      persist: async () => (persisted = true),
    };
    expect(await storageInfo(manager)).toEqual({ usage: 1234, quota: 5678, persisted: false });
    expect(await requestPersistence(manager)).toBe(true);
    expect(await storageInfo(manager)).toEqual({ usage: 1234, quota: 5678, persisted: true });
    expect(await storageInfo(null)).toEqual({ usage: null, quota: null, persisted: null });
    expect(await requestPersistence(null)).toBe(false);
    const failing = { ...manager, persisted: () => Promise.reject(new Error('no')) };
    expect(await requestPersistence(failing)).toBe(false);
  });
});
