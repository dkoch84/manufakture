import { fromBase64, sha256Hex, toBase64 } from '@manufakture/io';
import { describe, expect, it } from 'vitest';
import { BlobStore, blobRefs, externalize, hydrate, hydrateFrom, isSha256 } from './blobs';
import {
  applyCommand,
  deserialize,
  type DerivedFeature,
  type DerivedSource,
  type Instance,
  type ManufaktureDocument,
} from '@manufakture/core';
import {
  BUNDLED_FONT,
  assemblyWithPinnedInstance,
  cubeStl,
  derivedFeature,
  partWithDerived,
  partWithFonts,
  partWithImport,
  pinnedInstance,
  stlImport,
  unwrapDoc,
  userFont,
  newBackend,
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
    const store = new BlobStore(newBackend(), 'blobs');
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

describe('pinned instances', () => {
  const instanceSource = (doc: unknown, i = 0) =>
    (doc as ManufaktureDocument).assemblies[0]!.instances[i]!.source as DerivedSource;

  it("moves an instance's pinned version out like a derived part's, and puts it back", async () => {
    const doc = await assemblyWithPinnedInstance();
    const source = instanceSource(doc);
    const { value, blobs } = externalize(doc);
    const stored = instanceSource(value);
    expect('data' in stored).toBe(false);
    const { data: _data, ...rest } = source;
    void _data;
    expect(stored).toEqual(rest);
    expect(JSON.stringify(value)).not.toContain('"format": "manufakture"');
    expect([...blobs.keys()]).toEqual([source.sha256]);
    expect(new TextDecoder().decode(fromBase64(blobs.get(source.sha256)!))).toBe(source.data);
    // Counted as a blob the document needs, so it is read, checked and kept.
    expect(blobRefs(value)).toEqual([
      {
        sha256: source.sha256,
        size: source.size,
        fileName: '"Release 1" of Bracket',
        derived: true,
      },
    ]);
    expect(hydrate(value, blobs)).toEqual(doc);
    const bytes = new TextEncoder().encode(source.data);
    expect(await hydrateFrom(value, async () => bytes)).toEqual(doc);
    await expect(hydrateFrom(value, async () => null)).rejects.toThrow(
      'The pinned version "Release 1" of Bracket is missing.',
    );
  });

  it('stores a version pinned by a derived feature and an instance once', async () => {
    let doc = await partWithDerived();
    doc = unwrapDoc(
      applyCommand(doc, { type: 'addAssembly', assemblyId: 'assembly#1', name: 'Box' }),
    );
    doc = unwrapDoc(
      applyCommand(doc, {
        type: 'addInstance',
        assemblyId: 'assembly#1',
        instance: await pinnedInstance(),
      }),
    );
    const feature = doc.parts[0]!.features.at(-1) as DerivedFeature;
    expect(instanceSource(doc).sha256).toBe(feature.source.sha256);
    const { value, blobs } = externalize(doc);
    expect(blobs.size).toBe(1);
    expect(blobRefs(value)).toHaveLength(1);
    expect(hydrate(value, blobs)).toEqual(doc);
  });

  it('moves pins out of logged addInstance, editInstance and replaceDocument commands', async () => {
    const instance = await pinnedInstance();
    const pin = instance.source as DerivedSource;
    const commands = [
      { type: 'addInstance', assemblyId: 'assembly#1', instance },
      { type: 'editInstance', assemblyId: 'assembly#1', instanceId: 'inst#1', source: pin },
      { type: 'replaceDocument', document: await assemblyWithPinnedInstance() },
      { type: 'batch', commands: [{ type: 'addInstance', assemblyId: 'assembly#1', instance }] },
    ];
    for (const command of commands) {
      const { value, blobs } = externalize(command);
      expect([...blobs.keys()]).toEqual([pin.sha256]);
      expect(JSON.stringify(value)).not.toContain('"format": "manufakture"');
      expect(blobRefs(value).map((r) => r.sha256)).toEqual([pin.sha256]);
      expect(hydrate(value, blobs)).toEqual(command);
    }
  });

  it('leaves an instance of a part of the same document alone', () => {
    const instance: Instance = {
      id: 'inst#1',
      name: 'Instance 1',
      source: { part: 'part#1', configuration: 'cfg#1' },
      fixed: true,
      suppressed: false,
      pose: { translation: [0, 0, 0], rotation: [0, 0, 0, 1] },
    };
    const command = { type: 'addInstance', assemblyId: 'assembly#1', instance };
    expect(externalize(command)).toEqual({ value: command, blobs: new Map() });
    expect(blobRefs(command)).toEqual([]);
  });

  it("opens a document stored with an instance's pinned version inline", async () => {
    // Stored before pinned instances moved out: no blob needed, none read, nothing changed.
    const doc = await assemblyWithPinnedInstance();
    const legacy: unknown = JSON.parse(JSON.stringify(doc));
    expect(blobRefs(legacy)).toEqual([]);
    expect(hydrate(legacy, new Map())).toEqual(doc);
    expect(
      await hydrateFrom(legacy, async () => {
        throw new Error('no blob should be read');
      }),
    ).toEqual(doc);
    // Saved again, it moves out.
    expect(externalize(legacy).blobs.size).toBe(1);
  });

  it('refuses a pinned instance whose sha256 could name a path', () => {
    const source = { documentId: 'd', versionId: 'v', partId: 'part#1', sha256: '../x' };
    const bad = { id: 'inst#1', source: { ...source, data: '{}' } };
    expect(() => externalize(bad)).toThrow('A pinned instance has no valid SHA-256');
    const missing = { id: 'inst#1', source: { ...source, size: 2 } };
    expect(() => blobRefs(missing)).toThrow('A pinned instance names no valid blob');
  });
});

describe('user fonts', () => {
  it('moves a user font out like an imported file, leaves a bundled one alone, and puts it back', async () => {
    const doc = await partWithFonts();
    const font = doc.fonts[1]!;
    if (font.source.kind !== 'file') throw new Error('expected a file font');
    const { value, blobs } = externalize(doc);
    const stored = value as ManufaktureDocument;
    expect(stored.fonts[0]).toEqual(BUNDLED_FONT);
    expect('data' in stored.fonts[1]!.source).toBe(false);
    expect([...blobs]).toEqual([[font.source.sha256, font.source.data]]);
    expect(blobRefs(value)).toEqual([
      { sha256: font.source.sha256, size: font.source.size, fileName: 'Label.otf', font: true },
    ]);
    expect(hydrate(value, blobs)).toEqual(doc);
    const bytes = fromBase64(font.source.data);
    expect(await hydrateFrom(value, async () => bytes)).toEqual(doc);
    await expect(hydrateFrom(value, async () => null)).rejects.toThrow(
      'The font file Label.otf is missing.',
    );
  });

  it('moves fonts out of logged addFont and restoreFont commands, one blob per file', async () => {
    const font = await userFont();
    const command = {
      type: 'batch',
      commands: [
        { type: 'addFont', font },
        { type: 'restoreFont', font: { ...font, id: 'font#3' }, index: 0 },
      ],
    };
    const { value, blobs } = externalize(command);
    expect(blobs.size).toBe(1);
    expect(JSON.stringify(value)).not.toContain(font.source.kind === 'file' && font.source.data);
    expect(hydrate(value, blobs)).toEqual(command);
  });

  it('takes only font ids core accepts (at most 15 digits) as fonts', async () => {
    const font = await userFont();
    const long = { ...font, id: 'font#1234567890123456' };
    // Not a font: left as it is, its bytes inline.
    expect(externalize(long).blobs.size).toBe(0);
    expect(externalize({ ...font, id: 'font#123456789012345' }).blobs.size).toBe(1);
  });

  it('refuses a font file whose sha256 could name a path', () => {
    const bad = { id: 'font#2', source: { kind: 'file', sha256: '../x', data: 'AA==' } };
    expect(() => externalize(bad)).toThrow('A font file has no valid SHA-256');
    const missing = { id: 'font#2', source: { kind: 'file', sha256: '../x', size: 1 } };
    expect(() => blobRefs(missing)).toThrow('A font file names no valid blob');
  });
});

describe('BlobStore', () => {
  it('writes a blob once, rewrites one that a crash cut short, and refuses a wrong hash', async () => {
    const backend = newBackend();
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
