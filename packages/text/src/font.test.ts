import { describe, expect, it } from 'vitest';
import {
  FontError,
  MAX_FONT_BYTES,
  embeddingPermissions,
  fontSha256,
  loadFont,
  type FontErrorCode,
} from './font';
import { layoutText } from './layout';
import { MAX_CMAP_CODE_POINTS } from './sfnt';
import { inter, interBytes, random, tableRecord } from './test-helpers';

function expectFontError(fn: () => unknown, code: FontErrorCode, message?: string | RegExp): void {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(FontError);
  expect((caught as FontError).code).toBe(code);
  if (message) expect((caught as FontError).message).toMatch(message);
}

/** An sfnt header and table directory with the given tags, each table 4 zero bytes. */
function fakeSfnt(signature: string, tags: string[]): Uint8Array {
  const data = new Uint8Array(12 + tags.length * 16 + tags.length * 4);
  const view = new DataView(data.buffer);
  for (let i = 0; i < 4; i++) data[i] = signature.charCodeAt(i);
  view.setUint16(4, tags.length);
  tags.forEach((tag, i) => {
    const record = 12 + i * 16;
    for (let k = 0; k < 4; k++) data[record + k] = tag.charCodeAt(k);
    view.setUint32(record + 8, 12 + tags.length * 16 + i * 4);
    view.setUint32(record + 12, 4);
  });
  return data;
}

describe('loadFont', () => {
  it('reads the bundled font and its names', () => {
    const font = inter();
    expect(font.info).toEqual({
      family: 'Inter',
      style: 'Bold',
      fullName: 'Inter Bold',
      version: 'Version 4.001;git-9221beed3',
      copyright: 'Copyright 2016 The Inter Project Authors',
      license:
        'This Font Software is licensed under the SIL Open Font License, Version 1.1. This license is available with a FAQ at: http://scripts.sil.org/OFL',
      licenseUrl: 'http://scripts.sil.org/OFL',
      fsType: 0,
      embedding: {
        level: 'installable',
        noSubsetting: false,
        bitmapOnly: false,
        restrictive: false,
      },
      outlines: 'truetype',
      variable: false,
      unitsPerEm: 2048,
      glyphCount: 2937,
    });
    expect(font.capHeight).toBe(1490);
    // USE_TYPO_METRICS is set: typo ascender 1984 - descender -494 + line gap 0.
    expect(font.lineHeight).toBe(2478);
    expect(font.warnings).toEqual([]);
  });

  it('accepts an ArrayBuffer as well as a Uint8Array', () => {
    const buffer = new ArrayBuffer(interBytes().byteLength);
    new Uint8Array(buffer).set(interBytes());
    const font = loadFont(buffer);
    expect(font.info.family).toBe('Inter');
  });

  it('kerns pairs as HarfBuzz does, from GPOS including its Extension lookups', () => {
    // Reference values: HarfBuzz (uharfbuzz) shaping each pair with kern on and off; the
    // first glyph's advance difference. Checked over all 11,881 pairs of printable ASCII
    // and some Latin-1 letters while writing this package; these are a sample.
    const reference: Record<string, number> = {
      AV: -162,
      VA: -162,
      To: -160,
      Wo: -102,
      LT: -186,
      Ty: -128,
      AT: -182,
      'P.': -69,
      Yo: -224,
      'r.': -128,
      'F,': -81,
      av: -35,
      ke: -46,
      "L'": -186,
      'T-': -107,
      ÄV: -162,
      HH: 0,
      oo: 0,
      '11': 0,
      'f)': 0,
    };
    const font = inter();
    for (const [pair, value] of Object.entries(reference)) {
      const [a, b] = [...pair].map((c) => font.glyph(c)!.index);
      expect([pair, font.kerning(a!, b!)]).toEqual([pair, value]);
    }
  });

  it('decodes embedding permissions, the least restrictive level winning', () => {
    expect(embeddingPermissions(0)).toEqual({
      level: 'installable',
      noSubsetting: false,
      bitmapOnly: false,
      restrictive: false,
    });
    expect(embeddingPermissions(0x2)).toMatchObject({ level: 'restricted', restrictive: true });
    expect(embeddingPermissions(0x4)).toMatchObject({
      level: 'preview-and-print',
      restrictive: true,
    });
    expect(embeddingPermissions(0x8)).toMatchObject({ level: 'editable', restrictive: false });
    expect(embeddingPermissions(0x6)).toMatchObject({ level: 'preview-and-print' });
    expect(embeddingPermissions(0xe)).toMatchObject({ level: 'editable' });
    expect(embeddingPermissions(0x104)).toMatchObject({ noSubsetting: true, bitmapOnly: false });
    expect(embeddingPermissions(0x200)).toMatchObject({ level: 'installable', bitmapOnly: true });
  });

  it('hashes bytes as lower-case hex SHA-256', async () => {
    expect(await fontSha256(new TextEncoder().encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('loadFont refuses what it cannot use, cleanly', () => {
  it('refuses an empty file', () => {
    expectFontError(() => loadFont(new Uint8Array(0)), 'empty');
  });

  it('caps the file size at MAX_FONT_BYTES (20 MiB) before parsing', () => {
    expect(MAX_FONT_BYTES).toBe(20 * 1024 * 1024);
    expectFontError(
      () => loadFont(new Uint8Array(MAX_FONT_BYTES + 1)),
      'too-large',
      /20\.0 MiB; the limit is 20 MiB/,
    );
    expectFontError(() => loadFont(interBytes(), { maxBytes: 1000 }), 'too-large');
  });

  it('refuses collections, web fonts and files that are not fonts', () => {
    expectFontError(() => loadFont(fakeSfnt('ttcf', [])), 'unsupported-format', /collections/);
    expectFontError(() => loadFont(fakeSfnt('wOFF', [])), 'unsupported-format', /WOFF/);
    expectFontError(() => loadFont(fakeSfnt('wOF2', [])), 'unsupported-format', /WOFF/);
    expectFontError(
      () => loadFont(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>')),
      'unsupported-format',
      /not a TrueType or OpenType font/,
    );
    expectFontError(() => loadFont(new Uint8Array([0, 1, 0, 0])), 'malformed', /too short/);
  });

  it('refuses a font without outlines (bitmap only) or without required tables', () => {
    const base = ['cmap', 'head', 'hhea', 'hmtx', 'maxp'];
    expectFontError(
      () => loadFont(fakeSfnt('\0\x01\0\0', [...base, 'EBDT', 'EBLC'])),
      'no-outlines',
    );
    expectFontError(
      () => loadFont(fakeSfnt('\0\x01\0\0', ['cmap', 'glyf', 'loca'])),
      'malformed',
      /"head"/,
    );
  });

  it('refuses a damaged table directory and tables that run past the end', () => {
    const bytes = interBytes();
    new DataView(bytes.buffer).setUint16(4, 60000);
    expectFontError(() => loadFont(bytes), 'malformed', /directory/);
    expectFontError(() => loadFont(interBytes().subarray(0, 4096)), 'malformed', /past the end/);
  });

  it('refuses a character map that expands to more code points than any real font', () => {
    // Inter's format 12 subtable: widen its first group to all of Unicode.
    const bytes = interBytes();
    const view = new DataView(bytes.buffer);
    const cmap = tableRecord(bytes, 'cmap');
    let widened = false;
    for (let i = 0; i < view.getUint16(cmap.offset + 2); i++) {
      const at = cmap.offset + view.getUint32(cmap.offset + 4 + i * 8 + 4);
      if (view.getUint16(at) !== 12) continue;
      view.setUint32(at + 16, 0);
      view.setUint32(at + 20, 0x10ffff);
      widened = true;
    }
    expect(widened).toBe(true);
    expect(MAX_CMAP_CODE_POINTS).toBe(0x40000);
    expectFontError(() => loadFont(bytes), 'malformed', /maps more characters than any real font/);

    // A group count that runs past the table.
    const damaged = interBytes();
    const dv = new DataView(damaged.buffer);
    for (let i = 0; i < dv.getUint16(cmap.offset + 2); i++) {
      const at = cmap.offset + dv.getUint32(cmap.offset + 4 + i * 8 + 4);
      if (dv.getUint16(at) === 12) dv.setUint32(at + 12, 0x0fffffff);
    }
    expectFontError(() => loadFont(damaged), 'malformed', /character map \(cmap\) is damaged/);
  });

  it('wraps parser failures in a FontError', () => {
    // Garbage in tables only the parser reads.
    for (const table of ['head', 'maxp', 'name']) {
      const bytes = interBytes();
      const { offset, length } = tableRecord(bytes, table);
      bytes.fill(0xff, offset, offset + length);
      expectFontError(() => loadFont(bytes), 'malformed', /could not be read/);
    }
  });

  it('drops a damaged GPOS table with a warning instead of failing', () => {
    const bytes = interBytes();
    // Cut the GPOS table down to its first 10 bytes: its lists now lie outside it.
    const view = new DataView(bytes.buffer);
    const count = view.getUint16(4);
    for (let i = 0; i < count; i++) {
      if (String.fromCharCode(...bytes.subarray(12 + i * 16, 16 + i * 16)) === 'GPOS') {
        view.setUint32(12 + i * 16 + 12, 10);
      }
    }
    expect(tableRecord(bytes, 'GPOS').length).toBe(10);
    const font = loadFont(bytes);
    expect(font.warnings).toHaveLength(1);
    expect(font.warnings[0]).toMatch(/kerning could not be read/);
    const a = font.glyph('A')!.index;
    const v = font.glyph('V')!.index;
    expect(font.kerning(a, v)).toBe(0);
  });

  it('never throws anything but FontError on randomly damaged files', () => {
    const next = random(1045);
    const original = interBytes();
    let loaded = 0;
    for (let round = 0; round < 300; round++) {
      const bytes = original.slice(
        0,
        round % 3 === 0 ? Math.floor(next() * original.length) : original.length,
      );
      const flips = 1 + Math.floor(next() * 40);
      for (let i = 0; i < flips; i++)
        bytes[Math.floor(next() * bytes.length)] = Math.floor(next() * 256);
      try {
        const font = loadFont(bytes);
        loaded++;
        // A damaged glyph surfaces when it is laid out, again as a FontError.
        layoutText(font, 'Ag 0Ø', { size: 5 });
      } catch (error) {
        if (!(error instanceof FontError)) throw error;
      }
    }
    // Most single flips land in glyph data and leave a loadable font.
    expect(loaded).toBeGreaterThan(0);
  });
});
