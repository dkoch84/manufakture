import { fromBase64, sha256Hex, toBase64 } from '@manufakture/io';
import { describe, expect, it } from 'vitest';
import { MemoryBackend } from './backend';
import { BlobStore, blobRefs, externalize, hydrate, hydrateFrom, isSha256 } from './blobs';
import { deserialize, type DerivedFeature } from '@manufakture/core';
import {
  cubeStl,
  derivedFeature,
  partWithDerived,
  partWithImport,
  stlImport,
} from './test-fixtures';

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

describe('derived sources', () => {
  const pin = (doc: unknown) =>
    (doc as { parts: { features: DerivedFeature[] }[] }).parts[0]!.features.at(-1)!.source;

  it('moves a pinned version out as its UTF-8 bytes, and puts the text back', async () => {
    const doc = await partWithDerived();
    const source = pin(doc);
    const { value, blobs } = externalize(doc);
    const stored = pin(value);
    expect('data' in stored).toBe(false);
    const { data: _data, ...rest } = source;
    void _data;
    expect(stored).toEqual(rest);
    expect([...blobs.keys()]).toEqual([source.sha256]);
    const bytes = fromBase64(blobs.get(source.sha256)!);
    expect(bytes.length).toBe(source.size);
    expect(await sha256Hex(bytes)).toBe(source.sha256);
    expect(new TextDecoder().decode(bytes)).toBe(source.data);
    // The pinned document's own import stays inside the pinned text: one blob, not two.
    expect(source.data).toContain('"kind": "import"');
    expect(blobRefs(value)).toEqual([
      {
        sha256: source.sha256,
        size: source.size,
        fileName: '"Release 1" of Bracket',
        derived: true,
      },
    ]);
    expect(hydrate(value, blobs)).toEqual(doc);
    expect(externalize(doc).value).toEqual(value);
    // The pinned text is still a document of its own.
    expect(deserialize(pin(hydrate(value, blobs)).data).ok).toBe(true);
  });

  it('checks the pinned version against its SHA-256 and size, and names it', async () => {
    const doc = await partWithDerived();
    const source = pin(doc);
    const { value } = externalize(doc);
    const bytes = new TextEncoder().encode(source.data);
    expect(await hydrateFrom(value, async () => bytes)).toEqual(doc);
    const flipped = bytes.slice();
    flipped[10] = flipped[10]! ^ 1;
    await expect(hydrateFrom(value, async () => flipped)).rejects.toThrow(
      'The pinned version "Release 1" of Bracket is damaged: its SHA-256 does not match.',
    );
    await expect(hydrateFrom(value, async () => null)).rejects.toThrow(
      'The pinned version "Release 1" of Bracket is missing.',
    );
  });

  it('stores a version pinned twice, by a document and by a command, once', async () => {
    const a = await derivedFeature(undefined, 'derived#1');
    const b = await derivedFeature(undefined, 'derived#2', 'Release 1');
    const command = {
      type: 'batch',
      commands: [
        { type: 'addFeature', partId: 'part#1', feature: a },
        { type: 'addFeature', partId: 'part#1', feature: b },
      ],
    };
    const { value, blobs } = externalize(command);
    expect(blobs.size).toBe(1);
    expect(JSON.stringify(value)).not.toContain('"format": "manufakture"');
    expect(hydrate(value, blobs)).toEqual(command);
    const store = new BlobStore(new MemoryBackend(), 'blobs');
    const [[sha, base64]] = [...blobs] as [[string, string]];
    expect(await store.put(sha, base64)).toBe(a.source.size);
    expect(await store.put(sha, base64)).toBe(0);
  });

  it('refuses a derived source whose sha256 could name a path, and a blob that is not UTF-8', () => {
    const bad = { id: 'derived#1', kind: 'derived', source: { sha256: '../x', data: '{}' } };
    expect(() => externalize(bad)).toThrow('A derived part has no valid SHA-256');
    const missing = { id: 'derived#1', kind: 'derived', source: { sha256: '../x', size: 2 } };
    expect(() => blobRefs(missing)).toThrow('A derived part names no valid blob');
    const sha = 'a'.repeat(64);
    const stored = { id: 'derived#1', kind: 'derived', source: { sha256: sha, size: 1 } };
    expect(hydrate(stored, new Map([[sha, toBase64(new Uint8Array([0xff]))]]))).toEqual(stored);
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
      'A stored file or pinned version does not match its SHA-256.',
    );
    expect(() => store.read('../../x')).toThrow('Not a blob name: ../../x');
  });
});
