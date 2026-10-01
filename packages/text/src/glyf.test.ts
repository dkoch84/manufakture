import { describe, expect, it } from 'vitest';
import { FontError, loadFont } from './font';
import { MAX_COMPONENT_DEPTH, MAX_GLYPH_POINTS, MAX_GLYPH_SCAN, glyphChecker } from './glyf';
import { layoutText } from './layout';
import { readSfnt } from './sfnt';
import {
  buildTtf,
  compositeGlyph,
  compositeOf,
  manyContoursGlyph,
  noContoursGlyph,
  onePathGlyph,
  triangleGlyph,
} from './test-fonts';
import { interBytes } from './test-helpers';

const EMPTY = new Uint8Array(0);

/** Runs `fn`, returning the FontError it throws and how long it took. */
function failure(fn: () => unknown): { error: FontError; ms: number } {
  const started = performance.now();
  try {
    fn();
  } catch (error) {
    if (!(error instanceof FontError)) throw error;
    return { error, ms: performance.now() - started };
  }
  throw new Error('expected a FontError');
}

/** Glyph 1 is a chain of `levels` single-component composites ending in a triangle. */
function chain(levels: number): Uint8Array[] {
  const glyphs: Uint8Array[] = [EMPTY];
  for (let i = 1; i <= levels; i++) glyphs.push(compositeGlyph(i + 1, 1));
  glyphs.push(triangleGlyph());
  return glyphs;
}

describe('TrueType glyphs: hostile composites and contours', () => {
  it('lays out a small composite glyph normally', () => {
    const font = loadFont(
      buildTtf([EMPTY, compositeGlyph(2, 2), triangleGlyph()], { cmap: [[65, 1]] }),
    );
    expect(font.warnings).toEqual([]);
    const layout = layoutText(font, 'A', { size: 10 });
    // Two triangles: a moveTo, three lineTos (the last back to the start) and a close each.
    const triangle = ['moveTo', 'lineTo', 'lineTo', 'lineTo', 'close'];
    expect(layout.glyphs[0]!.path.map((c) => c.kind)).toEqual([...triangle, ...triangle]);
  });

  it('refuses nested composites that would expand exponentially, before expanding them', () => {
    // 300 references to 300 references to 300 references to a triangle: 27 million
    // triangles. opentype.js ran V8 out of memory on it (K = 50 took 1.1 s).
    for (const k of [50, 300]) {
      const font = loadFont(
        buildTtf(
          [
            EMPTY,
            compositeGlyph(2, k),
            compositeGlyph(3, k),
            compositeGlyph(4, k),
            triangleGlyph(),
          ],
          { cmap: [[65, 1]] },
        ),
      );
      const { error, ms } = failure(() => layoutText(font, 'A', { size: 10 }));
      expect(error.code).toBe('malformed');
      expect(error.message).toBe(
        'The font\'s glyph for "A" could not be read: it has more points than any real glyph.',
      );
      expect(ms).toBeLessThan(100);
    }
  });

  it('accepts components nested MAX_COMPONENT_DEPTH (8) deep and refuses one more', () => {
    expect(MAX_COMPONENT_DEPTH).toBe(8);
    // Seven composites over a triangle: depth 8.
    const ok = loadFont(buildTtf(chain(7), { cmap: [[65, 1]] }));
    expect(layoutText(ok, 'A', { size: 10 }).glyphs[0]!.path).toHaveLength(5);
    const deep = loadFont(buildTtf(chain(8), { cmap: [[65, 1]] }));
    const { error } = failure(() => layoutText(deep, 'A', { size: 10 }));
    expect(error.message).toMatch(/components nest more than 8 deep/);
    // The inner glyph is still fine when reached on its own.
    const inner = loadFont(buildTtf(chain(8), { cmap: [[65, 2]] }));
    expect(layoutText(inner, 'A', { size: 10 }).glyphs[0]!.path).toHaveLength(5);
  });

  it('refuses a composite that contains itself or a glyph that does not exist', () => {
    const cycle = loadFont(
      buildTtf([EMPTY, compositeGlyph(2, 1), compositeGlyph(1, 1)], { cmap: [[65, 1]] }),
    );
    expect(failure(() => cycle.glyph('A')).error.message).toMatch(/contains itself/);
    const missing = loadFont(buildTtf([EMPTY, compositeGlyph(9, 1)], { cmap: [[65, 1]] }));
    expect(failure(() => missing.glyph('A')).error.message).toMatch(/does not exist/);
  });

  it('refuses a simple glyph whose contours would take seconds to parse', () => {
    // 5,000 contours of 2 points: opentype.js checks each point against every
    // contour end, 50 million steps (0.8 s before).
    const font = loadFont(buildTtf([EMPTY, manyContoursGlyph(5000)], { cmap: [[65, 1]] }));
    const { error, ms } = failure(() => layoutText(font, 'A', { size: 10 }));
    expect(error.message).toMatch(/more points than any real glyph/);
    expect(ms).toBeLessThan(100);
    expect(MAX_GLYPH_POINTS).toBe(100_000);
    expect(MAX_GLYPH_SCAN).toBe(10_000_000);
    // 1,000 contours (2,000 points, 2 million steps) are within the caps.
    const fine = loadFont(buildTtf([EMPTY, manyContoursGlyph(1000)], { cmap: [[65, 1]] }));
    expect(fine.glyph('A')).not.toBeNull();
  });

  it('refuses a big glyph followed by many empty components, before expanding it', () => {
    // opentype.js appends each component with points.concat, copying the running
    // total: 65,000 points then 2,000 references to a glyph with no contours copy
    // 130 million points (a million references took 32 s), though the glyph has
    // only 65,001 points and contours.
    const font = loadFont(
      buildTtf(
        [EMPTY, onePathGlyph(65_000), noContoursGlyph(), compositeOf([1, ...Array(2000).fill(2)])],
        { cmap: [[65, 3]] },
      ),
    );
    const { error, ms } = failure(() => layoutText(font, 'A', { size: 10 }));
    expect(error.code).toBe('malformed');
    expect(error.message).toMatch(/more points than any real glyph/);
    expect(ms).toBeLessThan(100);
    // A few empty components after it are fine.
    const fine = loadFont(
      buildTtf([EMPTY, onePathGlyph(65_000), noContoursGlyph(), compositeOf([1, 2, 2, 2])], {
        cmap: [[65, 3]],
      }),
    );
    expect(fine.glyph('A')).not.toBeNull();
  });

  it('refuses tens of thousands of one-point components, before expanding them', () => {
    // 20,000 copies of a one-point glyph: 40,000 points and contours, but the
    // running-total copies add up to 400 million (50,000 took about 3 s).
    const font = loadFont(
      buildTtf([EMPTY, compositeGlyph(2, 20_000), onePathGlyph(1)], { cmap: [[65, 1]] }),
    );
    const { error, ms } = failure(() => layoutText(font, 'A', { size: 10 }));
    expect(error.code).toBe('malformed');
    expect(error.message).toMatch(/more points than any real glyph/);
    expect(ms).toBeLessThan(100);
  });

  it('passes every glyph of Inter Bold', () => {
    const bytes = interBytes();
    const sfnt = readSfnt(bytes);
    if (!('tables' in sfnt)) throw new Error('Inter did not parse');
    const check = glyphChecker(bytes, sfnt.tables);
    const glyphs = loadFont(bytes).info.glyphCount;
    expect(glyphs).toBeGreaterThan(2000);
    const refused: string[] = [];
    for (let i = 0; i < glyphs; i++) {
      const problem = check(i);
      if (problem) refused.push(`${i}: ${problem}`);
    }
    expect(refused).toEqual([]);
  });

  it('falls back to 0.7 em for the cap height, with a warning, when "H" is refused', () => {
    // The test fonts have no OS/2 table, so the cap height comes from "H".
    const font = loadFont(
      buildTtf(
        [
          EMPTY,
          compositeGlyph(2, 300),
          compositeGlyph(3, 300),
          compositeGlyph(4, 300),
          triangleGlyph(),
        ],
        { cmap: [[72, 1]] },
      ),
    );
    expect(font.capHeight).toBe(700);
    expect(font.warnings).toEqual([
      'The font\'s "H" could not be read for the cap height: The font\'s glyph for "H" could not be read: it has more points than any real glyph.',
    ]);
    // With a sound "H", its top is the cap height.
    expect(loadFont(buildTtf([EMPTY, triangleGlyph()], { cmap: [[72, 1]] })).capHeight).toBe(500);
  });

  it('maps characters in a font without a post table', () => {
    const font = loadFont(buildTtf([EMPTY, triangleGlyph()], { cmap: [[65, 1]], noPost: true }));
    expect(font.glyph('A')?.index).toBe(1);
    expect(font.warnings).toEqual([]);
  });
});
