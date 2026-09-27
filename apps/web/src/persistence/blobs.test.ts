import { sha256Hex, toBase64 } from '@manufakture/io';
import { describe, expect, it } from 'vitest';
import { MemoryBackend } from './backend';
import { BlobStore, blobRefs, externalize, hydrate, hydrateFrom, isSha256 } from './blobs';
import { cubeStl, partWithImport, stlImport } from './test-fixtures';

describe('externalize and hydrate', () => {
  it('never lets a `__proto__` key in stored JSON set a prototype', () => {
    const parsed: unknown = JSON.parse(
      '{"a": 1, "__proto__": {"polluted": true}, "b": [{"__proto__": {"x": 1}}]}',
    );
    for (const out of [externalize(parsed).value, hydrate(parsed, new Map())] as Record<
      string,
      unknown
    >[]) {
      expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
      expect(out.polluted).toBeUndefined();
      expect(Object.getPrototypeOf((out.b as object[])[0])).toBe(Object.prototype);
      expect(out).toEqual({ a: 1, b: [{}] });
    }
  });

  it('moves every import file out by SHA-256, and puts it back', async () => {
    const doc = await partWithImport();
    const { value, blobs } = externalize(doc);
    const feature = (value as typeof doc).parts[0]!.features.at(-1)!;
    expect(feature.kind === 'import' && 'data' in feature.source).toBe(false);
    const source = (doc.parts[0]!.features.at(-1) as Awaited<ReturnType<typeof stlImport>>).source;
    expect([...blobs]).toEqual([[source.sha256, source.data]]);
    expect(blobRefs(value)).toEqual([
      { sha256: source.sha256, size: source.size, fileName: 'cube.stl' },
    ]);
    expect(hydrate(value, blobs)).toEqual(doc);
    // Untouched: the input keeps its data.
    expect(externalize(doc).value).toEqual(value);
  });

  it('finds imports inside commands, batches included, and stores a shared file once', async () => {
    const a = await stlImport(cubeStl(), 'import#1');
    const b = await stlImport(cubeStl(), 'import#2', 'again.stl');
    const command = {
      type: 'batch',
      commands: [
        { type: 'addFeature', partId: 'part#1', feature: a },
        { type: 'batch', commands: [{ type: 'addFeature', partId: 'part#1', feature: b }] },
      ],
    };
    const { value, blobs } = externalize(command);
    expect(blobs.size).toBe(1);
    expect(JSON.stringify(value)).not.toContain(a.source.data);
    expect(hydrate(value, blobs)).toEqual(command);
  });

  it('refuses a source whose sha256 could name a path', () => {
    const bad = { id: 'import#1', kind: 'import', source: { sha256: '../x', data: 'AA==' } };
    expect(() => externalize(bad)).toThrow('An imported file has no valid SHA-256');
    const missing = { id: 'import#1', kind: 'import', source: { sha256: '../x', size: 1 } };
    expect(() => blobRefs(missing)).toThrow('An imported file names no valid blob');
    expect(isSha256('a'.repeat(64))).toBe(true);
    expect(isSha256('A'.repeat(64))).toBe(false);
  });

  it('checks each blob against its SHA-256 and size when hydrating', async () => {
    const doc = await partWithImport();
    const { value } = externalize(doc);
    const bytes = cubeStl();
    expect(await hydrateFrom(value, async () => bytes)).toEqual(doc);
    const flipped = bytes.slice();
    flipped[90] = flipped[90]! ^ 1;
    await expect(hydrateFrom(value, async () => flipped)).rejects.toThrow(
      'The imported file cube.stl is damaged: its SHA-256 does not match.',
    );
    await expect(hydrateFrom(value, async () => bytes.subarray(1))).rejects.toThrow(/damaged/);
    await expect(hydrateFrom(value, async () => null)).rejects.toThrow(
      'The imported file cube.stl is missing.',
    );
  });
});

describe('BlobStore', () => {
  it('writes a blob once, rewrites one that a crash cut short, and refuses a wrong hash', async () => {
    const backend = new MemoryBackend();
    const bytes = cubeStl();
    const sha = await sha256Hex(bytes);
    const path = `docs/blobs/${sha}`;
    expect(await new BlobStore(backend, 'docs/blobs').put(sha, toBase64(bytes))).toBe(bytes.length);
    // Already there and matching: nothing written, by this store or a new one.
    const store = new BlobStore(backend, 'docs/blobs');
    expect(await store.put(sha, toBase64(bytes))).toBe(0);
    expect(await store.put(sha, toBase64(bytes))).toBe(0);
    // Cut short (a crash mid-write): found and rewritten.
    backend.files.set(path, bytes.slice(0, 10));
    expect(await new BlobStore(backend, 'docs/blobs').put(sha, toBase64(bytes))).toBe(bytes.length);
    expect(await store.read(sha)).toEqual(bytes);
    // Bytes that are not what the name says are never stored.
    await expect(store.put('0'.repeat(64), toBase64(bytes))).rejects.toThrow(
      'An imported file does not match its SHA-256.',
    );
    expect(() => store.read('../../x')).toThrow('Not a blob name: ../../x');
  });
});
