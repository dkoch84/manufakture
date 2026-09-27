import { describe, expect, it } from 'vitest';
import { MemoryBackend, segments } from './backend';
import { openIdb } from './idb';
import { openOpfs } from './opfs';
import { openBrowserBackend, requestPersistence, storageInfo } from './storage';

describe('MemoryBackend', () => {
  it('reads, writes, lists and removes files and trees', async () => {
    const b = new MemoryBackend();
    await b.write('documents/a/head.json', new Uint8Array([1]));
    await b.write('documents/a/blobs/x', new Uint8Array([2]));
    await b.write('documents/b/head.json', new Uint8Array([3]));
    expect(await b.list('documents')).toEqual(['a', 'b']);
    expect(await b.list('documents/a')).toEqual(['blobs', 'head.json']);
    expect(await b.list('nothing')).toEqual([]);
    expect(await b.read('documents/a/head.json')).toEqual(new Uint8Array([1]));
    expect(await b.read('documents/a/none')).toBeNull();
    await b.remove('documents/a/head.json');
    await b.remove('documents/a/head.json');
    await b.removeTree('documents/a');
    expect(await b.list('documents')).toEqual(['b']);
  });

  it('keeps its own copies of the bytes', async () => {
    const b = new MemoryBackend();
    const bytes = new Uint8Array([1, 2]);
    await b.write('f', bytes);
    bytes[0] = 9;
    const read = (await b.read('f'))!;
    read[1] = 9;
    expect(await b.read('f')).toEqual(new Uint8Array([1, 2]));
  });

  it('refuses paths that could leave the root', async () => {
    for (const p of ['../x', 'a/../../x', '/abs', 'a//b', 'a/./b', '']) {
      expect(() => segments(p)).toThrow('Invalid storage path');
    }
    const b = new MemoryBackend();
    await expect(b.write('a/../b', new Uint8Array())).rejects.toThrow('Invalid storage path');
    await expect(b.read('a/../b')).rejects.toThrow('Invalid storage path');
    await expect(b.remove('../x')).rejects.toThrow('Invalid storage path');
    await expect(b.removeTree('documents/..')).rejects.toThrow('Invalid storage path');
    await expect(b.list('a//b')).rejects.toThrow('Invalid storage path');
  });
});

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
