import { describe, expect, it } from 'vitest';
import { loadFont } from './font';
import {
  KerningTooComplex,
  MAX_KERN_LOOKUP_INDEXES,
  MAX_KERN_SUBTABLES,
  readGposKerning,
} from './kerning';
import { buildTtf, multiplyingGpos, triangleGlyph } from './test-fonts';

/** Reads a crafted GPOS on its own; returns what happened and how long it took. */
function read(gpos: Uint8Array): { result: unknown; ms: number } {
  const started = performance.now();
  let result: unknown;
  try {
    const kerning = readGposKerning(gpos, { offset: 0, length: gpos.length });
    for (let i = 0; i < 10; i++) kerning?.pair(i, i + 1);
    result = kerning;
  } catch (error) {
    result = error;
  }
  return { result, ms: performance.now() - started };
}

describe('GPOS kerning: hostile tables', () => {
  it('reads a feature listed 65,535 times once', () => {
    // Before the fix this table (one lookup index per listing) took about 4 s.
    const { result, ms } = read(
      multiplyingGpos({ features: 65535, lookups: 1, distinct: false, subtables: 1 }),
    );
    expect(result).toMatchObject({ lookups: 1 });
    expect(ms).toBeLessThan(500);
  });

  it('refuses a feature with more lookup indexes than any real font, fast', () => {
    // 163 KB: one feature listed 65,535 times, listing lookup 0 16,000 times (3.9 s before).
    const gpos = multiplyingGpos({
      features: 65535,
      lookups: 16000,
      distinct: false,
      subtables: 1,
    });
    expect(gpos.length).toBeGreaterThan(160_000);
    const { result, ms } = read(gpos);
    expect(result).toBeInstanceOf(KerningTooComplex);
    expect((result as Error).message).toMatch(/lookup indexes/);
    expect(ms).toBeLessThan(500);
  });

  it('refuses lookups that all point at one lookup with thousands of subtables, fast', () => {
    // 1,000 lookup indexes (under the cap) to one lookup listing 4,000 subtables
    // (also under it): 4 million subtables in all, each walked by every pair before.
    const { result, ms } = read(
      multiplyingGpos({ features: 1, lookups: 1000, distinct: true, subtables: 4000 }),
    );
    expect(result).toBeInstanceOf(KerningTooComplex);
    expect((result as Error).message).toMatch(/subtables/);
    expect(ms).toBeLessThan(500);
  });

  it('keeps a subtable listed many times in one lookup once', () => {
    const { result, ms } = read(
      multiplyingGpos({ features: 1, lookups: 1, distinct: false, subtables: MAX_KERN_SUBTABLES }),
    );
    expect(result).toMatchObject({ lookups: 1 });
    expect(ms).toBeLessThan(500);
  });

  it('caps at MAX_KERN_LOOKUP_INDEXES and MAX_KERN_SUBTABLES', () => {
    expect(MAX_KERN_LOOKUP_INDEXES).toBe(1024);
    expect(MAX_KERN_SUBTABLES).toBe(4096);
    const at = (lookups: number, subtables: number) =>
      read(multiplyingGpos({ features: 1, lookups, distinct: true, subtables })).result;
    expect(at(MAX_KERN_LOOKUP_INDEXES, 1)).toMatchObject({ lookups: MAX_KERN_LOOKUP_INDEXES });
    expect(at(MAX_KERN_LOOKUP_INDEXES + 1, 1)).toBeInstanceOf(KerningTooComplex);
    expect(at(4, MAX_KERN_SUBTABLES / 4)).toMatchObject({ lookups: 4 });
    expect(at(4, MAX_KERN_SUBTABLES / 4 + 1)).toBeInstanceOf(KerningTooComplex);
  });

  it('loads a font with such a table without kerning, and with a warning', () => {
    const gpos = multiplyingGpos({
      features: 65535,
      lookups: 16000,
      distinct: false,
      subtables: 1,
    });
    const started = performance.now();
    const font = loadFont(
      buildTtf([new Uint8Array(0), triangleGlyph()], {
        cmap: [
          [65, 1],
          [86, 1],
        ],
        tables: { GPOS: gpos },
      }),
    );
    expect(performance.now() - started).toBeLessThan(500);
    expect(font.warnings).toEqual([
      "The font's GPOS kerning could not be read and is not used: the kerning table has more lookup indexes than any real font",
    ]);
    expect(font.kerning(1, 1)).toBe(0);
  });
});
