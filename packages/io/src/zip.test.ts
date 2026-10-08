// `readZip` against hand-built and hand-patched zips: one case per defensive check (ported in
// part from packages/library/src/mfk.test.ts, whose reader makes the same checks).

import { zipSync, type Zippable } from 'fflate';
import { describe, expect, it } from 'vitest';
import { ZipReadError, readZip, type ZipReadLimits } from './zip';

const encode = (s: string) => new TextEncoder().encode(s);
const LIMITS: ZipReadLimits = { maxFileBytes: 1 << 20, maxEntries: 10, maxTotalBytes: 1 << 20 };
const WHAT = 'a test zip';
const all = () => 1 << 20;
const read = (bytes: Uint8Array, limits = LIMITS, wanted: (n: string) => number | null = all) =>
  readZip(bytes, limits, wanted, WHAT);

/** Where each central directory header starts. */
function centralOffsets(zipped: Uint8Array): number[] {
  const view = new DataView(zipped.buffer, zipped.byteOffset, zipped.byteLength);
  const out: number[] = [];
  for (let i = 0; i + 4 <= zipped.length; i++) {
    if (view.getUint32(i, true) === 0x02014b50) out.push(i);
  }
  return out;
}

/** Patch a field of the `index`-th central directory header. */
function patchCentral(
  zipped: Uint8Array,
  index: number,
  offset: number,
  value: number,
  bytes: 2 | 4 = 4,
): Uint8Array {
  const out = zipped.slice();
  const view = new DataView(out.buffer);
  const at = centralOffsets(zipped)[index]! + offset;
  if (bytes === 2) view.setUint16(at, value, true);
  else view.setUint32(at, value, true);
  return out;
}

/** The end of central directory record's offset. */
const eocdOf = (zipped: Uint8Array) => zipped.length - 22;

/** A zip of stored entries written by hand (fflate refuses duplicate names). */
function storedZip(entries: [string, Uint8Array][]): Uint8Array {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const n = encode(name);
    const local = new Uint8Array(30 + n.length + data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, n.length, true);
    local.set(n, 30);
    local.set(data, 30 + n.length);
    const central = new Uint8Array(46 + n.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, n.length, true);
    cv.setUint32(42, offset, true);
    central.set(n, 46);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const directory = centrals.reduce((s, c) => s + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, directory, true);
  ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + directory + 22);
  let at = 0;
  for (const part of [...locals, ...centrals, eocd]) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

const files: Zippable = { a: encode('first entry'), b: encode('second entry'), c: encode('third') };
const deflated = zipSync(files, { level: 6 });
const stored = storedZip([
  ['a', encode('first entry')],
  ['b', encode('second entry')],
]);

const refused = (bytes: Uint8Array, message: string | RegExp, limits = LIMITS) => {
  expect(() => read(bytes, limits)).toThrow(ZipReadError);
  expect(() => read(bytes, limits)).toThrow(message);
};

describe('readZip', () => {
  it('reads stored and deflated entries, and only the wanted ones', () => {
    expect(new TextDecoder().decode(read(deflated).get('b'))).toBe('second entry');
    expect(new TextDecoder().decode(read(stored).get('a'))).toBe('first entry');
    expect([...read(deflated, LIMITS, (n) => (n === 'c' ? 100 : null)).keys()]).toEqual(['c']);
  });

  it('refuses what is not a zip, too large a file and too many entries', () => {
    refused(new Uint8Array(5), /too short/);
    refused(new Uint8Array(100), /no end of central directory/);
    refused(deflated, /larger than/, { ...LIMITS, maxFileBytes: deflated.length - 1 });
    refused(deflated, 'The file has more than 2 entries.', { ...LIMITS, maxEntries: 2 });
  });

  it('refuses ZIP64', () => {
    const z = deflated.slice();
    new DataView(z.buffer).setUint16(eocdOf(z) + 10, 0xffff, true);
    refused(z, /ZIP64 is not supported/);
    const y = deflated.slice();
    new DataView(y.buffer).setUint32(eocdOf(y) + 16, 0xffffffff, true);
    refused(y, /ZIP64 is not supported/);
  });

  it('refuses a directory outside the file', () => {
    const z = deflated.slice();
    new DataView(z.buffer).setUint32(eocdOf(z) + 12, 1 << 16, true);
    refused(z, /directory lies outside the file/);
  });

  it('refuses two directory records sharing one compressed stream', () => {
    const second = new DataView(deflated.buffer).getUint32(centralOffsets(deflated)[1]! + 42, true);
    refused(
      patchCentral(deflated, 2, 42, second),
      'The file is damaged: two of its entries overlap.',
    );
  });

  it('refuses an entry whose offset lies outside the file or past the directory', () => {
    refused(patchCentral(deflated, 0, 42, deflated.length + 100), /an entry lies outside it/);
    // Its local header is fine, but its compressed size runs into the directory.
    refused(patchCentral(deflated, 0, 20, deflated.length), /an entry lies outside it/);
    // An offset that points into the directory itself.
    refused(patchCentral(deflated, 0, 42, centralOffsets(deflated)[0]!), /lies outside it/);
  });

  it('refuses an unsupported compression method and an encrypted entry', () => {
    refused(patchCentral(deflated, 0, 10, 12, 2), 'a uses an unsupported compression method.');
    refused(patchCentral(deflated, 1, 8, 1, 2), 'b is encrypted.');
  });

  it('refuses a stored entry whose two sizes differ', () => {
    refused(patchCentral(stored, 0, 24, 3), 'a is damaged: its sizes do not agree.');
  });

  it('refuses a deflated entry that inflates past, or ends short of, its claimed size', () => {
    const big = zipSync({ a: encode('x'.repeat(5000)) }, { level: 6 });
    refused(
      patchCentral(big, 0, 24, 10),
      'a is damaged: it inflates to more than the 10 B it claims.',
    );
    refused(patchCentral(big, 0, 24, 6000), 'a is damaged: it inflates to less than it claims.');
  });

  it('refuses a corrupt deflate stream', () => {
    const z = zipSync({ a: encode('x'.repeat(5000)) }, { level: 6 });
    const bad = z.slice();
    // The deflate data starts after the 30-byte local header and the one-byte name.
    bad[31] = 0xff;
    bad[32] = 0xff;
    refused(bad, /a is damaged/);
  });

  it('checks per-entry and total sizes, counting the larger of the two sizes', () => {
    expect(() => read(deflated, LIMITS, () => 5)).toThrow('a is larger than 5 B uncompressed.');
    refused(deflated, /holds more than 20 B uncompressed/, { ...LIMITS, maxTotalBytes: 20 });
  });

  it('refuses a name listed twice', () => {
    refused(
      storedZip([
        ['a', encode('one')],
        ['a', encode('two')],
      ]),
      'The file holds a twice.',
    );
    // Unless it is not wanted: then it is never looked at.
    const twice = storedZip([
      ['a', encode('one')],
      ['a', encode('two')],
      ['b', encode('three')],
    ]);
    expect([...read(twice, LIMITS, (n) => (n === 'b' ? 100 : null)).keys()]).toEqual(['b']);
  });
});
