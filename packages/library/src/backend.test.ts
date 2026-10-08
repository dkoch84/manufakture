import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { MemoryBackend, segments, type StorageBackend } from './backend';
import { NodeBackend } from './node';

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
const nodeBackend = async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'manufakture-backend-'));
  dirs.push(dir);
  return new NodeBackend(dir);
};

describe.each([
  { name: 'MemoryBackend', make: async (): Promise<StorageBackend> => new MemoryBackend() },
  { name: 'NodeBackend', make: nodeBackend },
])('$name', ({ make }) => {
  it('reads, writes, lists and removes files and trees', async () => {
    const b = await make();
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
    const b = await make();
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
    const b = await make();
    await expect(b.write('a/../b', new Uint8Array())).rejects.toThrow('Invalid storage path');
    await expect(b.read('a/../b')).rejects.toThrow('Invalid storage path');
    await expect(b.remove('../x')).rejects.toThrow('Invalid storage path');
    await expect(b.removeTree('documents/..')).rejects.toThrow('Invalid storage path');
    await expect(b.list('a//b')).rejects.toThrow('Invalid storage path');
  });
});
