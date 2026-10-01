// The checks ADR 0011 (decision 3) asks of the bundled font, run on the file in
// the repository. Results are recorded in the package README.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  flattenSegment,
  outlineRegionArea,
  outlineRegions,
  type OutlineLoop,
  type PathCommand,
  type Vec2,
} from '@manufakture/sketch/geometry';
import { describe, expect, it } from 'vitest';
import {
  BUNDLED_FONTS,
  DEFAULT_FONT_ID,
  INTER_BOLD,
  bundledFont,
  bundledFontUrl,
  fetchBundledFont,
} from './bundled';
import { fontSha256 } from './font';
import { layoutText } from './layout';
import { readSfnt } from './sfnt';
import { inter, interBytes } from './test-helpers';

const licenseText = () => readFileSync(new URL('../fonts/OFL.txt', import.meta.url), 'utf8');

describe('the bundled font', () => {
  it('is Inter Bold 4.1, byte for byte the release file', async () => {
    expect(DEFAULT_FONT_ID).toBe('inter-bold');
    expect(BUNDLED_FONTS).toEqual([INTER_BOLD]);
    expect(bundledFont('inter-bold')).toBe(INTER_BOLD);
    const bytes = interBytes();
    expect(bytes.byteLength).toBe(INTER_BOLD.size);
    expect(await fontSha256(bytes)).toBe(INTER_BOLD.sha256);
    expect(INTER_BOLD.sha256).toBe(
      '288316099b1e0a47a4716d159098005eef7c0066921f34e3200393dbdb01947f',
    );
  });

  it('ships OFL.txt, a verbatim copy of the release LICENSE.txt: OFL 1.1, no Reserved Font Name', async () => {
    const text = licenseText();
    expect(await fontSha256(new TextEncoder().encode(text))).toBe(
      '262481e844521b326f5ecd053e59b98c8b2da78c8ee1bdbb6e8174305e54935a',
    );
    const [copyright] = text.split('\n');
    expect(copyright).toBe(INTER_BOLD.copyright);
    expect(text).toContain('SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007');
    // A Reserved Font Name is declared in the header, before the license text, as
    // "with Reserved Font Name ...". The license's own definition of the term is not one.
    const header = text.slice(0, text.indexOf('-----'));
    expect(header).not.toMatch(/Reserved Font Name/i);
  });

  it('is static TrueType: glyf outlines, no fvar or gvar', () => {
    const sfnt = readSfnt(interBytes());
    if ('code' in sfnt) throw new Error(sfnt.message);
    expect(sfnt.flavor).toBe('truetype');
    expect(sfnt.tables.has('glyf')).toBe(true);
    for (const table of ['fvar', 'gvar', 'CFF ', 'CFF2'])
      expect(sfnt.tables.has(table)).toBe(false);
  });

  it('has name entries 0, 13 and 14 that agree with the license file, fsType 0', () => {
    const { info } = inter();
    expect(info.copyright).toBe('Copyright 2016 The Inter Project Authors');
    expect(licenseText()).toContain('The Inter Project Authors');
    expect(info.license).toContain('SIL Open Font License, Version 1.1');
    expect(info.licenseUrl).toBe('http://scripts.sil.org/OFL');
    expect(info.version).toBe(INTER_BOLD.version);
    expect(info.fsType).toBe(0);
    expect(info.variable).toBe(false);
  });

  it('is found next to the package and fetched with its hash checked', async () => {
    const url = bundledFontUrl('inter-bold');
    expect(url.pathname.endsWith('/packages/text/fonts/Inter-Bold.ttf')).toBe(true);
    const fromDisk = async (u: URL) => new Response(readFileSync(fileURLToPath(u)));
    const bytes = await fetchBundledFont('inter-bold', fromDisk);
    expect(bytes.byteLength).toBe(INTER_BOLD.size);

    const tampered = async (u: URL) => {
      const data = readFileSync(fileURLToPath(u));
      data[1000] = data[1000]! ^ 1;
      return new Response(data);
    };
    await expect(fetchBundledFont('inter-bold', tampered)).rejects.toThrow(
      /does not match its recorded SHA-256/,
    );
    await expect(
      fetchBundledFont('inter-bold', async () => new Response('', { status: 404 })),
    ).rejects.toThrow(/HTTP 404/);
    await expect(fetchBundledFont('nope')).rejects.toThrow(/Unknown bundled font/);
    expect(() => bundledFontUrl('nope')).toThrow(/Unknown bundled font/);
  });
});

/** Basic Latin, Latin-1 Supplement (degree, plus-minus and multiplication signs among them), diameter sign. */
function shippedCharacters(): string[] {
  const chars: string[] = [];
  for (let c = 0x20; c <= 0x7e; c++) chars.push(String.fromCodePoint(c));
  for (let c = 0xa0; c <= 0xff; c++) chars.push(String.fromCodePoint(c));
  chars.push('⌀');
  return chars;
}

/** A path drawing the given loops, to feed a result back in. */
function loopsToPath(loops: readonly OutlineLoop[]): PathCommand[] {
  const path: PathCommand[] = [];
  for (const loop of loops) {
    loop.segments.forEach((s, i) => {
      const p = s.kind === 'bezier' ? s.points : s.kind === 'line' ? [s.start, s.end] : [];
      if (i === 0) path.push({ kind: 'moveTo', to: p[0]! });
      if (p.length === 2) path.push({ kind: 'lineTo', to: p[1]! });
      else if (p.length === 3) path.push({ kind: 'quadTo', control: p[1]!, to: p[2]! });
      else path.push({ kind: 'cubicTo', control1: p[1]!, control2: p[2]!, to: p[3]! });
    });
    path.push({ kind: 'close' });
  }
  return path;
}

describe('overlapping contours in the bundled font (ADR 0011, decision 3)', () => {
  const font = inter();
  const glyphs = shippedCharacters().map((char) => ({
    char,
    layout: layoutText(font, char, { size: 10 }),
  }));

  it('has every character but the soft hyphen and the diameter sign', () => {
    const missing = glyphs.filter((g) => g.layout.missing.length > 0).map((g) => g.char);
    // U+00AD is invisible by definition; U+2300 is not in Inter (use "Ø").
    expect(missing).toEqual(['­', '⌀']);
  });

  it('has overlaps only in composite glyphs, which outlineRegions merges cleanly', () => {
    const merged: string[] = [];
    for (const { char, layout } of glyphs) {
      if (layout.missing.length > 0 || layout.glyphs[0]!.path.length === 0) continue;
      const result = outlineRegions(layout.glyphs[0]!.path);
      expect([char, result.issues.filter((i) => i.code !== 'merged')]).toEqual([char, []]);
      if (result.issues.length === 0) continue;
      merged.push(char);
      // The merged loops no longer cross: fed back in, they need no merging and fill the same area.
      const loops = result.regions.flatMap((r) => [r.outer, ...r.holes]);
      const again = outlineRegions(loopsToPath(loops));
      expect([char, again.issues]).toEqual([char, []]);
      const area = (r: typeof result) =>
        r.regions.reduce((sum, region) => sum + outlineRegionArea(region), 0);
      expect(area(again)).toBeCloseTo(area(result), 9);
    }
    // Base letter plus a cedilla, bar or slash component.
    expect(merged).toEqual(['Ç', 'Ð', 'Ø', 'ç', 'ø']);
    const slashed = outlineRegions(glyphs.find((g) => g.char === 'Ø')!.layout.glyphs[0]!.path);
    expect(slashed.regions).toHaveLength(1);
    expect(slashed.regions[0]!.holes).toHaveLength(2);
  });
});

describe('stroke widths of the bundled font (ADR 0011, decision 3)', () => {
  const font = inter();

  /** Where a horizontal (`axis` 1) or vertical (`axis` 0) line crosses a glyph, in font units. */
  function crossings(char: string, axis: 0 | 1, at: number): number[] {
    const layout = layoutText(font, char, { size: font.capHeight });
    const { regions } = outlineRegions(layout.glyphs[0]!.path);
    const out: number[] = [];
    const other = axis === 1 ? 0 : 1;
    for (const loop of regions.flatMap((r) => [r.outer, ...r.holes])) {
      for (const segment of loop.segments) {
        const points: Vec2[] = flattenSegment(segment, 0.01);
        for (let i = 0; i + 1 < points.length; i++) {
          const a = points[i]!;
          const b = points[i + 1]!;
          if ((a[axis] - at) * (b[axis] - at) < 0) {
            out.push(a[other] + ((b[other] - a[other]) * (at - a[axis])) / (b[axis] - a[axis]));
          }
        }
      }
    }
    return out.sort((p, q) => p - q);
  }

  it('measures stems, thin strokes and counters in font units', () => {
    expect(font.capHeight).toBe(1490);
    // Vertical stems, across at a quarter of the cap height and half the x-height (1118).
    const h = crossings('H', 1, 370);
    expect(h[1]! - h[0]!).toBeCloseTo(305, 6);
    const l = crossings('l', 1, 559);
    expect(l[1]! - l[0]!).toBeCloseTo(300, 6);
    // Horizontal strokes, down through the middle of the glyph.
    const bar = crossings('H', 0, 765);
    expect(bar[1]! - bar[0]!).toBeCloseTo(253, 6);
    const e = crossings('e', 0, font.glyph('e')!.advanceWidth! / 2);
    // Bottom stroke, crossbar, top stroke: the crossbar is the thinnest stroke measured.
    expect(e[3]! - e[2]!).toBeCloseTo(188, 0);
    // The counter of "e", between crossbar and top stroke: the narrowest counter measured.
    expect(e[4]! - e[3]!).toBeCloseTo(237, 0);
    // The bowl counter of "a", between its bottom stroke and the top of the bowl.
    const a = crossings('a', 0, font.glyph('a')!.advanceWidth! / 2);
    expect(a[2]! - a[1]!).toBeCloseTo(281, 0);
  });

  it('clears a 0.84 mm wall (two 0.42 mm lines, 0.4 mm nozzle) from 4.2 mm cap height', () => {
    const wall = 0.84;
    const stem = 300; // "l", the thinner of the two stems
    const minimumCapHeight = (wall * font.capHeight) / stem;
    expect(minimumCapHeight).toBeCloseTo(4.17, 2);
    // The thinnest stroke, the crossbar of "e", needs 6.7 mm.
    expect((wall * font.capHeight) / 188).toBeCloseTo(6.66, 2);
  });

  it('converts every glyph up to U+024F (Latin Extended-B), merging the ogonek of "Ų"', () => {
    const failed: string[] = [];
    const merged: string[] = [];
    for (let code = 0x20; code <= 0x24f; code++) {
      const char = String.fromCodePoint(code);
      const layout = layoutText(font, char, { size: 10 });
      if (layout.missing.length > 0 || layout.glyphs[0]!.path.length === 0) continue;
      const result = outlineRegions(layout.glyphs[0]!.path);
      const problems = result.issues.filter((i) => i.code !== 'merged');
      if (problems.length > 0 || result.regions.length === 0) failed.push(char);
      else if (result.issues.length > 0) merged.push(char);
    }
    expect(failed).toEqual([]);
    // "Ų" (U+0172) was refused as a crossing before T3.2c: its ogonek leaves the bowl at a
    // shallow angle, and a short piece by the crossing was read from the wrong side.
    expect(merged).toContain('Ų');
    const u = outlineRegions(layoutText(font, 'Ų', { size: 10 }).glyphs[0]!.path);
    expect(u.regions).toHaveLength(1);
    expect(u.regions[0]!.holes).toHaveLength(0);
  });
});
