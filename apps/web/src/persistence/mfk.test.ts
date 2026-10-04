import { createDocument, FORMAT_VERSION, serialize } from '@manufakture/core';
import { zipSync, type Zippable } from 'fflate';
import { describe, expect, it } from 'vitest';
import { MemoryBackend } from './backend';
import { DocumentLibrary } from './library';
import { MFK_LIMITS, packMfk, unpackMfk, type MfkLimits } from './mfk';
import { cubeStl, partDocument, partWithImport } from './test-fixtures';

const encode = (s: string) => new TextEncoder().encode(s);
const zip = (files: Zippable) => zipSync(files, { level: 6 });

function library(backend = new MemoryBackend()) {
  let n = 0;
  return new DocumentLibrary(backend, { newId: () => `new-${++n}` });
}

async function importMessage(lib: DocumentLibrary, bytes: Uint8Array) {
  const r = await lib.importMfk(bytes);
  return r.ok ? `ok ${r.value.summary.id}` : r.message;
}

describe('.mfk files', () => {
  it('round trip: export, delete, import gives the same document, blobs included', async () => {
    const lib = library();
    const doc = await partWithImport('doc-1');
    await lib.save(doc);
    const exported = await lib.exportMfk('doc-1');
    if (!exported.ok) throw new Error(exported.message);
    expect(exported.value.name).toBe('Bracket.mfk');
    const contents = unpackMfk(exported.value.bytes);
    expect([...contents.blobs.keys()]).toHaveLength(1);
    expect(contents.document).not.toContain('"data"');

    await lib.remove('doc-1');
    const imported = await lib.importMfk(exported.value.bytes);
    expect(imported).toMatchObject({
      ok: true,
      value: { summary: { id: 'doc-1' }, migrated: false },
    });
    const opened = await lib.open('doc-1');
    expect(opened.ok && opened.value.document).toEqual(doc);
  });

  it('imports under a new id when the id is taken or unsafe', async () => {
    const lib = library();
    await lib.save(partDocument('doc-1'));
    const exported = await lib.exportMfk('doc-1');
    if (!exported.ok) throw new Error(exported.message);
    expect(await importMessage(lib, exported.value.bytes)).toBe('ok new-1');
    const unsafe = { ...partDocument('doc-1'), id: '../../x' };
    expect(await importMessage(lib, packMfk(serialize(unsafe), new Map()))).toBe('ok new-2');
  });

  it('accepts a plain document with the imported files inline', async () => {
    const lib = library();
    const doc = await partWithImport('inline');
    expect(await importMessage(lib, packMfk(serialize(doc), new Map()))).toBe('ok inline');
    const opened = await lib.open('inline');
    expect(opened.ok && opened.value.document).toEqual(doc);
  });

  it('runs core migrations on import, and refuses a newer format with a clear message', async () => {
    const lib = library();
    const current = JSON.parse(serialize(createDocument({ id: 'old', name: 'Old' })));
    // Versions 1 and 2 differ from 3 only by features and fields this document does not use. A
    // file older than 14 has no `cam` key (the v13 to v14 migration refuses one), so drop it.
    const { cam: _cam, ...rest } = current as Record<string, unknown>;
    void _cam;
    const v1 = { ...rest, version: 1 };
    const r = await lib.importMfk(packMfk(JSON.stringify(v1), new Map()));
    expect(r).toMatchObject({ ok: true, value: { migrated: true, summary: { id: 'old' } } });
    const opened = await lib.open('old');
    expect(opened.ok && opened.value.document.version).toBe(FORMAT_VERSION);

    const newer = { ...current, id: 'newer', version: FORMAT_VERSION + 1 };
    expect(await importMessage(lib, packMfk(JSON.stringify(newer), new Map()))).toBe(
      `This document was saved by a newer version of manufakture (file format ${FORMAT_VERSION + 1}; this app reads up to ${FORMAT_VERSION}). It was not opened or changed.`,
    );
    const refused = await lib.importMfk(packMfk(JSON.stringify(newer), new Map()));
    expect(!refused.ok && refused.newer).toBe(true);
    expect(await lib.has('newer')).toBe(false);
  });

  it('reports JSON, validation, and blob problems', async () => {
    const lib = library();
    expect(await importMessage(lib, zip({ 'document.json': encode('{"format": ') }))).toMatch(
      /^The document is not valid JSON: /,
    );
    const invalid = { ...JSON.parse(serialize(partDocument('x'))), parts: [] };
    expect(await importMessage(lib, packMfk(JSON.stringify(invalid), new Map()))).toMatch(
      /^The document is invalid: /,
    );
    expect(await importMessage(lib, zip({ 'other.json': encode('{}') }))).toBe(
      'This is not a manufakture file: it has no document.json.',
    );
    expect(await importMessage(lib, encode('not a zip at all, just text'))).toMatch(
      /^This is not a manufakture file \(\.mfk\): the zip cannot be read/,
    );

    // A blob that is missing, or whose bytes do not match the SHA-256 the import stores.
    const source = new DocumentLibrary(new MemoryBackend());
    await source.save(await partWithImport('b'));
    const good = await source.exportMfk('b');
    if (!good.ok) throw new Error(good.message);
    const { document, blobs } = unpackMfk(good.value.bytes);
    expect(await importMessage(lib, packMfk(document, new Map()))).toBe(
      'The imported file cube.stl is missing.',
    );
    const [sha] = blobs.keys();
    const other = cubeStl(12);
    expect(await importMessage(lib, packMfk(document, new Map([[sha!, other]])))).toBe(
      'The imported file cube.stl is damaged: its SHA-256 does not match.',
    );
  });
});

describe('unpackMfk limits', () => {
  const small: MfkLimits = {
    maxFileBytes: 64 * 1024,
    maxEntries: 5,
    maxDocumentBytes: 2000,
    maxBlobBytes: 1000,
    maxTotalBytes: 3000,
  };
  const doc = encode('{}');
  const sha = (c: string) => c.repeat(64);

  it('refuses a file over the size cap before reading it', () => {
    expect(() => unpackMfk(new Uint8Array(small.maxFileBytes + 1), small)).toThrow(
      'The file is larger than 64.0 KB.',
    );
  });

  it('refuses too many entries, counting ones it would ignore', () => {
    const files: Zippable = { 'document.json': doc };
    for (let i = 0; i < 5; i++) files[`junk/${i}`] = encode('x');
    expect(() => unpackMfk(zip(files), small)).toThrow('The file has more than 5 entries.');
  });

  it('refuses entries whose uncompressed size is over the cap, before inflating them', () => {
    // 1 MB of zeros deflates to about a kilobyte: a small zip bomb.
    const bomb = zip({ 'document.json': new Uint8Array(1_000_000) });
    expect(bomb.length).toBeLessThan(small.maxFileBytes);
    expect(() => unpackMfk(bomb, small)).toThrow(
      'document.json is larger than 2.0 KB uncompressed.',
    );
    const blob = zip({ 'document.json': doc, [`blobs/${sha('a')}`]: new Uint8Array(1001) });
    expect(() => unpackMfk(blob, small)).toThrow(
      /^blobs\/a{64} is larger than 1000 B uncompressed\.$/,
    );
    const total = zip({
      'document.json': new Uint8Array(1500),
      [`blobs/${sha('a')}`]: new Uint8Array(900),
      [`blobs/${sha('b')}`]: new Uint8Array(900),
    });
    expect(() => unpackMfk(total, small)).toThrow('The file holds more than 2.9 KB uncompressed.');
  });

  it('reads only document.json and well-named blobs: other names, and traversal, are ignored', () => {
    const files: Zippable = {
      'document.json': doc,
      [`blobs/${sha('c')}`]: encode('blob'),
      '../escape.json': encode('no'),
      '/etc/passwd': encode('no'),
      'blobs/../document.json': encode('no'),
      [`blobs/${sha('d')}/../x`]: encode('no'),
      'blobs/NOTAHASH': encode('no'),
    };
    const r = unpackMfk(zip(files), MFK_LIMITS);
    expect(r.document).toBe('{}');
    expect([...r.blobs.keys()]).toEqual([sha('c')]);
    expect(r).toMatchObject({ manifest: null, versions: new Map() });
  });

  it('reads the manifest and well-named version documents, within the document limit', () => {
    const files: Zippable = {
      'document.json': doc,
      'manifest.json': encode('{"m":1}'),
      'versions/v-1.json': encode('{"v":1}'),
      'versions/../x.json': encode('no'),
      'versions/v 2.json': encode('no'),
      'versions/v-3.txt': encode('no'),
      'versions/a/b.json': encode('no'),
    };
    const r = unpackMfk(zip(files), MFK_LIMITS);
    expect(r.manifest).toBe('{"m":1}');
    expect(r.versions).toEqual(new Map([['v-1', '{"v":1}']]));
    const small: MfkLimits = { ...MFK_LIMITS, maxDocumentBytes: 6 };
    expect(() =>
      unpackMfk(zip({ 'document.json': doc, 'versions/v-1.json': encode('{"v":12}') }), small),
    ).toThrow('versions/v-1.json is larger than');
    expect(() =>
      unpackMfk(zip({ 'document.json': doc, 'manifest.json': new Uint8Array([0xff]) })),
    ).toThrow('manifest.json is not UTF-8 text.');
    expect(() =>
      packMfk('{}', new Map(), { manifest: '{}', versions: new Map([['../x', '']]) }),
    ).toThrow('Not a version id: ../x');
  });

  it('counts a stored entry at the size it is copied at, and refuses one whose sizes differ', () => {
    // Stored (not compressed): fflate copies `size` bytes whatever `originalSize` says, so an
    // entry claiming 1 byte would slip 5000 past a 100-byte cap.
    const stored = zipSync({ 'document.json': encode(`"${'x'.repeat(5000)}"`) }, { level: 0 });
    const lying = patchSizes(stored, 1);
    expect(() => unpackMfk(lying, { ...MFK_LIMITS, maxDocumentBytes: 100 })).toThrow(
      'document.json is damaged: its sizes do not agree.',
    );
    // Honest, but over the cap.
    expect(() => unpackMfk(stored, { ...MFK_LIMITS, maxDocumentBytes: 100 })).toThrow(
      'document.json is larger than 100 B uncompressed.',
    );
    // Many entries sharing one stored blob each count in the total.
    const blob = new Uint8Array(900);
    const shared = zipSync(
      { 'document.json': doc, [`blobs/${sha('a')}`]: blob, [`blobs/${sha('b')}`]: blob },
      { level: 0 },
    );
    expect(() => unpackMfk(shared, { ...small, maxTotalBytes: 1500 })).toThrow(
      'The file holds more than 1.5 KB uncompressed.',
    );
  });

  it('refuses compression methods other than stored and deflate', () => {
    const zipped = patchMethod(zip({ 'document.json': encode('{}') }), 12);
    expect(() => unpackMfk(zipped, small)).toThrow(
      'document.json uses an unsupported compression method.',
    );
  });

  it('refuses a deflated entry the moment it inflates past the size it claims', () => {
    // An entry that lies: its directory says 10 bytes, its data inflates to far more.
    const honest = zip({ 'document.json': encode(`"${'x'.repeat(5000)}"`) });
    expect(() => unpackMfk(patchSizes(honest, 10), MFK_LIMITS)).toThrow(
      'document.json is damaged: it inflates to more than the 10 B it claims.',
    );
    // And one that ends short of it.
    expect(() => unpackMfk(patchSizes(honest, 6000), MFK_LIMITS)).toThrow(
      'document.json is damaged: it inflates to less than it claims.',
    );
  });

  it('stops inflating a bomb that claims a small size, without decoding the rest', () => {
    // 64 MiB of zeros deflates to about 64 KB; the directory claims 100 bytes. Decoding the
    // whole stream into a 100-byte buffer (dropping what does not fit) would accept it.
    const bomb = patchSizes(zipSync({ 'document.json': new Uint8Array(64 * 1024 * 1024) }), 100);
    expect(bomb.length).toBeLessThan(1024 * 1024);
    const started = performance.now();
    expect(() => unpackMfk(bomb, MFK_LIMITS)).toThrow(
      'document.json is damaged: it inflates to more than the 100 B it claims.',
    );
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it('refuses entries that share compressed data or lie outside the file', () => {
    const files: Zippable = {
      'document.json': doc,
      [`blobs/${sha('a')}`]: encode('blob a'),
      [`blobs/${sha('b')}`]: encode('blob b'),
    };
    const zipped = zip(files);
    expect(unpackMfk(zipped, MFK_LIMITS).blobs.size).toBe(2);
    // The third directory entry points at the second's local header: one stream, read twice.
    const offsets = centralOffsets(zipped);
    const aliased = zipped.slice();
    new DataView(aliased.buffer).setUint32(offsets[2]! + 42, localOffsetOf(zipped, 1), true);
    expect(() => unpackMfk(aliased, MFK_LIMITS)).toThrow(
      `The file is damaged: the entries blobs/${sha('a')} and blobs/${sha('b')} overlap.`,
    );
    // A compressed size running past the directory.
    const outside = zipped.slice();
    new DataView(outside.buffer).setUint32(offsets[0]! + 20, zipped.length, true);
    expect(() => unpackMfk(outside, MFK_LIMITS)).toThrow(
      'The file is damaged: the entry document.json lies outside it.',
    );
  });
});

/** Where each central directory header starts. */
function centralOffsets(zipped: Uint8Array): number[] {
  const view = new DataView(zipped.buffer, zipped.byteOffset, zipped.byteLength);
  const out: number[] = [];
  for (let i = 0; i + 4 <= zipped.length; i++) {
    if (view.getUint32(i, true) === 0x02014b50) out.push(i);
  }
  return out;
}

/** The local header offset the `index`-th central directory entry records. */
function localOffsetOf(zipped: Uint8Array, index: number): number {
  const view = new DataView(zipped.buffer, zipped.byteOffset, zipped.byteLength);
  return view.getUint32(centralOffsets(zipped)[index]! + 42, true);
}

/** Rewrite the compression method of every entry in a zip's local and central headers. */
function patchMethod(zipped: Uint8Array, method: number): Uint8Array {
  const out = zipped.slice();
  const view = new DataView(out.buffer);
  for (let i = 0; i + 4 <= out.length; i++) {
    const sig = view.getUint32(i, true);
    if (sig === 0x04034b50) view.setUint16(i + 8, method, true);
    if (sig === 0x02014b50) view.setUint16(i + 10, method, true);
  }
  return out;
}

/** Rewrite the uncompressed size of every entry in a zip's local and central headers. */
function patchSizes(zipped: Uint8Array, size: number): Uint8Array {
  const out = zipped.slice();
  const view = new DataView(out.buffer);
  for (let i = 0; i + 4 <= out.length; i++) {
    const sig = view.getUint32(i, true);
    if (sig === 0x04034b50) view.setUint32(i + 22, size, true);
    if (sig === 0x02014b50) view.setUint32(i + 24, size, true);
  }
  return out;
}
