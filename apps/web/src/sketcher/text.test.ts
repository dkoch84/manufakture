// @vitest-environment node
// Text in the sketcher: requests from text entities, previews from the outliner's replies, the
// placed glyphs drawn one path per glyph, hit boxes, and the checks a font file passes before
// any of it is read.

import { FontSchema, MAX_IMPORT_BYTES, type DocumentFont } from '@manufakture/core';
import {
  MAX_FLATTEN_POINTS,
  flattenRegion,
  outlinePartsRegions,
  type OutlineShape,
  type Region,
  type RegionCurve,
} from '@manufakture/sketch/geometry';
import type { OutlineEntity } from '@manufakture/sketch/model';
import { lengthQuantity } from '@manufakture/units';
import { describe, expect, it } from 'vitest';
import {
  boxDistance,
  checkFontFile,
  cutUtf16,
  documentFont,
  embeddingLabel,
  GLYPH_POINT_BUDGET,
  GLYPH_TOLERANCE_FRACTION,
  glyphOutlines,
  type GlyphOutline,
  millimetres,
  placedText,
  placedTextsCache,
  pointBudget,
  previewOf,
  regionFills,
  shapesBox,
  textRequestOf,
} from './text';
import { interBold, localTexter } from './text.test-helpers';

const BUNDLED: DocumentFont = {
  id: 'font#1',
  family: 'Inter',
  style: 'Bold',
  source: { kind: 'bundled', id: 'inter-bold', sha256: 'a'.repeat(64) },
};
const USER: DocumentFont = {
  id: 'font#2',
  family: 'Mine',
  style: 'Regular',
  source: { kind: 'file', fileName: 'mine.ttf', size: 3, sha256: 'b'.repeat(64), data: 'AAAA' },
};

function text(patch: Partial<OutlineEntity['source']> = {}, anchor: [number, number] = [0, 0]) {
  return {
    id: 'e5',
    kind: 'outline',
    construction: false,
    anchor,
    angle: 0,
    source: {
      kind: 'text',
      text: 'OK',
      font: 'font#1',
      size: millimetres(6),
      align: { horizontal: 'center', vertical: 'middle' },
      ...patch,
    },
  } satisfies OutlineEntity;
}

describe('textRequestOf', () => {
  it('asks for the bundled font by id and a user font by its stored bytes', () => {
    const a = textRequestOf(text(), [BUNDLED], {});
    expect(a).toMatchObject({
      ok: true,
      request: {
        font: { kind: 'bundled', id: 'inter-bold' },
        text: 'OK',
        size: 6,
        letterSpacing: 0,
        lineSpacing: 1,
      },
    });
    const b = textRequestOf(text({ font: 'font#2' }), [BUNDLED, USER], {});
    expect(b.ok && b.request.font).toEqual({
      kind: 'file',
      fileName: 'mine.ttf',
      size: 3,
      sha256: 'b'.repeat(64),
      data: 'AAAA',
    });
  });

  it('evaluates the size from variables, and keys on what the layout depends on, not the anchor', () => {
    const vars = { size: lengthQuantity(8) };
    const sized = text({ size: { source: '#size', lengthUnit: 'mm', angleUnit: 'deg' } });
    const a = textRequestOf(sized, [BUNDLED], vars);
    expect(a.ok && a.request.size).toBe(8);
    const moved = textRequestOf({ ...sized, anchor: [5, 5], angle: 1 }, [BUNDLED], vars);
    expect(moved.key).toBe(a.key);
    expect(textRequestOf(sized, [BUNDLED], { size: lengthQuantity(9) }).key).not.toBe(a.key);
    expect(textRequestOf(text({ text: 'OK!' }), [BUNDLED], {}).key).not.toBe(
      textRequestOf(text(), [BUNDLED], {}).key,
    );
  });

  it('says why a text cannot be laid out', () => {
    expect(textRequestOf(text({ font: 'font#9' }), [BUNDLED], {})).toMatchObject({
      ok: false,
      message: 'The font font#9 is not in the document.',
    });
    expect(textRequestOf(text({ size: millimetres(0) }), [BUNDLED], {})).toMatchObject({
      ok: false,
      message: 'The size must be a length above 0.',
    });
    expect(
      textRequestOf(
        text({ size: { source: '#nope', lengthUnit: 'mm', angleUnit: 'deg' } }),
        [BUNDLED],
        {},
      ).ok,
    ).toBe(false);
    expect(
      textRequestOf(
        text({ lineSpacing: { source: '2 mm', lengthUnit: 'mm', angleUnit: 'deg' } }),
        [BUNDLED],
        {},
      ),
    ).toMatchObject({ ok: false, message: 'The line spacing must be a number.' });
  });
});

describe('previews of the real outliner', () => {
  it('places the glyphs at the anchor, one outline per glyph with its counters', async () => {
    const texter = localTexter();
    const entity = text({ text: 'OK i' });
    const r = textRequestOf(entity, [BUNDLED], {});
    if (!r.ok) throw new Error(r.message);
    const preview = previewOf(r.key, await texter.outline(r.request));
    expect(preview.error).toBeNull();
    // "O" (with its counter), "K", and "i" (two regions): three glyphs drawn.
    const shapes = placedText(entity, preview);
    const glyphs = glyphOutlines(shapes, 0.01);
    expect(glyphs.map((g) => g.key)).toEqual(['e5.g0', 'e5.g1', 'e5.g3']);
    expect(glyphs.map((g) => g.loops.length)).toEqual([2, 1, 2]);
    // Centred on the anchor, both ways.
    const box = shapesBox(shapes)!;
    expect((box.min[0] + box.max[0]) / 2).toBeCloseTo(0, 0);
    expect(box.max[1]).toBeGreaterThan(2.5);
    expect(box.min[1]).toBeLessThan(-2.5);
    // Moved with the anchor, with no new layout.
    const moved = shapesBox(placedText({ ...entity, anchor: [10, 20] }, preview))!;
    expect(moved.min[0] - box.min[0]).toBeCloseTo(10, 9);
    expect(moved.min[1] - box.min[1]).toBeCloseTo(20, 9);
    expect(boxDistance(box, [0, 0])).toBe(0);
    expect(boxDistance(box, [box.max[0] + 3, 0])).toBeCloseTo(3, 9);
  });

  it('turns missing characters and failures into what the panel shows', async () => {
    const texter = localTexter();
    const r = textRequestOf(text({ text: 'A一' }), [BUNDLED], {});
    if (!r.ok) throw new Error(r.message);
    const preview = previewOf(r.key, await texter.outline(r.request));
    expect(preview.warnings[0]).toBe('The font has no glyph for "一"; it is left out.');
    expect(
      previewOf('k', { ok: false, code: 'font', message: 'This font could not be read (x): y' }),
    ).toMatchObject({ layout: null, error: 'This font could not be read (x): y' });
    expect(previewOf('k', null).error).toBe('The text could not be laid out.');
  });

  it('draws nothing until a text has a layout', () => {
    expect(placedText(text(), undefined)).toEqual([]);
    expect(
      placedText(text(), {
        key: 'k',
        layout: { glyphs: [], result: outlinePartsRegions([]) },
        error: null,
        warnings: [],
      }),
    ).toEqual([]);
  });
});

describe('glyphOutlines under its point budget', () => {
  /** A glyph: a disk of `n` Beziers of radius `r` at `center`, as a placed outline shape. */
  function disk(key: string, n: number, r: number, center: [number, number]): OutlineShape {
    const k = (4 / 3) * Math.tan(Math.PI / (2 * n));
    const at = (a: number): [number, number] => [
      center[0] + r * Math.cos(a),
      center[1] + r * Math.sin(a),
    ];
    const curves = Array.from({ length: n }, (_, i) => {
      const p0 = at((2 * Math.PI * i) / n);
      const p3 = at((2 * Math.PI * (i + 1)) / n);
      const d0: [number, number] = [p0[0] - center[0], p0[1] - center[1]];
      const d3: [number, number] = [p3[0] - center[0], p3[1] - center[1]];
      const p1: [number, number] = [p0[0] - k * d0[1], p0[1] + k * d0[0]];
      const p2: [number, number] = [p3[0] + k * d3[1], p3[1] - k * d3[0]];
      const curve: RegionCurve = {
        kind: 'bezier',
        points: [p0, p1, p2, p3],
        start: p0,
        end: p3,
        edgeId: `${key}.c0.s${i}`,
        entityId: 'e1',
        fragile: false,
        reversed: false,
      };
      return curve;
    });
    return {
      entityId: 'e1',
      key: `${key}.c0`,
      fragile: false,
      outer: { curves, area: Math.PI * r * r },
      holes: [],
    };
  }
  const points = (glyphs: GlyphOutline[]) =>
    glyphs.reduce((n, g) => n + g.loops.reduce((m, l) => m + l.length, 0), 0);

  it('flattens a glyph no finer than a fraction of its size, however far the view zooms in', () => {
    const [glyph] = glyphOutlines([disk('e1.g0', 8, 3, [0, 0])], 1e-9);
    expect(glyph!.approximate).toBe(false);
    // At 6 mm / 1000 a circle of 8 Beziers needs a few dozen points, not 8 x 256.
    expect(points([glyph!])).toBeLessThan(200);
    expect(GLYPH_TOLERANCE_FRACTION).toBe(1e-3);
  });

  it('keeps a text of MAX_TEXT_CURVES curves at a fine tolerance bounded and fast', () => {
    // 2000 glyphs of 250 Beziers: 500,000 curves, as many as a text may have.
    const shapes = Array.from({ length: 2000 }, (_, i) =>
      disk(`e1.g${i}`, 250, 3, [(i % 50) * 8, Math.floor(i / 50) * 8]),
    );
    const started = performance.now();
    const glyphs = glyphOutlines(shapes, 1e-4);
    const elapsed = performance.now() - started;
    expect(glyphs).toHaveLength(2000);
    // Within the budget, plus four points for each glyph drawn as a box.
    expect(points(glyphs)).toBeLessThanOrEqual(GLYPH_POINT_BUDGET + 4 * glyphs.length);
    expect(glyphs[0]!.approximate).toBe(false);
    expect(glyphs.at(-1)!.approximate).toBe(true);
    expect(glyphs.at(-1)!.loops).toEqual([
      [expect.any(Array), expect.any(Array), expect.any(Array), expect.any(Array)],
    ]);
    expect(elapsed).toBeLessThan(1500);
  });

  it('draws glyphs past the budget as control polygons while those fit', () => {
    const shapes = [disk('e1.g0', 8, 3, [0, 0]), disk('e1.g1', 8, 3, [10, 0])];
    const all = glyphOutlines(shapes, 0.001);
    const first = points([all[0]!]);
    // Room for the first glyph and the second one's 24 control points, not its curve.
    const glyphs = glyphOutlines(shapes, 0.001, first + 30);
    expect(glyphs.map((g) => g.approximate)).toEqual([false, true]);
    expect(glyphs[1]!.loops[0]).toHaveLength(24);
    // No room at all: boxes.
    const boxes = glyphOutlines(shapes, 0.001, 0);
    expect(boxes.map((g) => g.loops[0]!.length)).toEqual([4, 4]);
    const [min, , max] = boxes[1]!.loops[0]!;
    expect(min![0]).toBeLessThanOrEqual(7);
    expect(max![0]).toBeGreaterThanOrEqual(13);
  });

  it('shares one budget across the calls of a drawing, and stops flattening once it ran out', () => {
    const first = points(glyphOutlines([disk('e1.g0', 8, 3, [0, 0])], 0.001));
    const budget = pointBudget(first + 30);
    const a = glyphOutlines([disk('e1.g0', 8, 3, [0, 0])], 0.001, budget);
    expect(a[0]!.approximate).toBe(false);
    expect(budget.left).toBe(30);
    // The next text (another sketch's) gets what is left: a control polygon, not its curve.
    const b = glyphOutlines([disk('e2.g0', 8, 3, [10, 0])], 0.001, budget);
    expect(b[0]!.approximate).toBe(true);
    expect(budget.exhausted).toBe(true);
    // Once exhausted, not even a glyph that would fit is flattened again.
    const c = glyphOutlines([disk('e3.g0', 1, 3, [20, 0])], 0.001, budget);
    expect(c[0]!.approximate).toBe(true);
  });

  it('keeps many sketches of large texts within one budget in all', () => {
    // 50 sketches, each a text of 40 glyphs of 250 Beziers at a fine tolerance.
    const sketches = Array.from({ length: 50 }, (_, k) =>
      Array.from({ length: 40 }, (_, i) => disk(`e${k}.g${i}`, 250, 3, [i * 8, k * 8])),
    );
    const budget = pointBudget();
    const started = performance.now();
    const drawn = sketches.map((shapes) => glyphOutlines(shapes, 1e-4, budget));
    const elapsed = performance.now() - started;
    const glyphs = drawn.flat();
    expect(points(glyphs)).toBeLessThanOrEqual(GLYPH_POINT_BUDGET + 4 * glyphs.length);
    expect(drawn.at(-1)!.every((g) => g.approximate)).toBe(true);
    expect(elapsed).toBeLessThan(1500);
  });
});

describe('regionFills', () => {
  const region = (id: string) => ({ id }) as unknown as Region;

  it('stops at the first region past the budget, so the work does not grow with the regions', () => {
    const asked: number[] = [];
    // Every region is over budget: flattening it spends what was left, then throws.
    const overBudget: typeof flattenRegion = (_r, _d, options = {}) => {
      asked.push(options.maxPoints ?? Infinity);
      throw new RangeError('too many points');
    };
    const regions = Array.from({ length: 20 }, (_, i) => region(`r${i}`));
    expect(regionFills(regions, 1000, overBudget)).toEqual([]);
    // One attempt of up to 1000 points, not 20.
    expect(asked).toEqual([1000]);
  });

  it('fills regions while they fit, and skips one that fails for another reason', () => {
    const asked: number[] = [];
    const flatten: typeof flattenRegion = (r, _d, options = {}) => {
      asked.push(options.maxPoints!);
      const id = (r as unknown as { id: string }).id;
      if (id === 'bad') throw new Error('degenerate');
      if (id === 'big') throw new RangeError('too many points');
      return [Array.from({ length: 100 }, (_, i) => [i, 0] as [number, number])];
    };
    const fills = regionFills(['a', 'bad', 'b', 'big', 'c'].map(region), 1000, flatten);
    expect(fills).toHaveLength(2);
    expect(asked).toEqual([1000, 900, 900, 800]);
  });

  it('asks no one region for more than the per-region flattening cap', () => {
    const asked: number[] = [];
    const flatten: typeof flattenRegion = (_r, _d, options = {}) => {
      asked.push(options.maxPoints!);
      return [[[0, 0]]];
    };
    regionFills([region('a')], 3 * MAX_FLATTEN_POINTS, flatten);
    expect(asked).toEqual([MAX_FLATTEN_POINTS]);
  });
});

describe('placedTextsCache', () => {
  it('keeps the placed shapes, and the same map, while no text moved or changed', async () => {
    const texter = localTexter();
    const entity = text({ text: 'OK' });
    const r = textRequestOf(entity, [BUNDLED], {});
    if (!r.ok) throw new Error(r.message);
    const previews = { e5: previewOf(r.key, await texter.outline(r.request)) };
    const place = placedTextsCache();
    const line = {
      id: 'l1',
      kind: 'line',
      construction: false,
      start: [0, 0],
      end: [1, 0],
    } as const;
    const a = place([entity, line], previews);
    expect(a.get('e5')!.length).toBeGreaterThan(0);
    // Another entity was dragged: the same map.
    expect(place([entity, { ...line, end: [2, 0] }], previews)).toBe(a);
    // The text moved: placed again, at the new anchor.
    const moved = place([{ ...entity, anchor: [10, 0] }, line], previews);
    expect(moved).not.toBe(a);
    expect(shapesBox(moved.get('e5')!)!.min[0] - shapesBox(a.get('e5')!)!.min[0]).toBeCloseTo(
      10,
      9,
    );
    // Turned: placed again; its layout gone: no shapes.
    expect(place([{ ...entity, anchor: [10, 0], angle: 1 }], previews)).not.toBe(moved);
    expect(place([entity], {}).size).toBe(0);
  });
});

describe('checkFontFile', () => {
  const ttf = new Uint8Array([0, 1, 0, 0]);
  const otf = new TextEncoder().encode('OTTO');
  it('accepts TrueType and OpenType files by extension and signature', () => {
    expect(checkFontFile('Inter-Bold.ttf', 1000, interBold().subarray(0, 4))).toBeNull();
    expect(checkFontFile('Font.OTF', 1000, otf)).toBeNull();
    expect(checkFontFile('mac.ttf', 1000, new TextEncoder().encode('true'))).toBeNull();
  });

  it('refuses collections, web fonts, other files, empty and oversized ones', () => {
    expect(checkFontFile('set.ttc', 1000, new TextEncoder().encode('ttcf'))).toMatch(/collections/);
    expect(checkFontFile('web.woff2', 1000, new TextEncoder().encode('wOF2'))).toMatch(/WOFF/);
    expect(checkFontFile('renamed.ttf', 1000, new TextEncoder().encode('wOFF'))).toMatch(/WOFF/);
    expect(checkFontFile('renamed.ttf', 1000, new TextEncoder().encode('ttcf'))).toMatch(
      /collections/,
    );
    expect(checkFontFile('page.ttf', 1000, new TextEncoder().encode('<htm'))).toBe(
      'The file is not a TrueType or OpenType font.',
    );
    expect(checkFontFile('font.png', 1000, ttf)).toBe(
      'Choose a TrueType (.ttf) or OpenType (.otf) font file.',
    );
    expect(checkFontFile('font.ttf', 0, ttf)).toBe('The file is empty.');
    expect(checkFontFile('font.ttf', MAX_IMPORT_BYTES + 1, ttf)).toMatch(/at most 20 MiB/);
    expect(checkFontFile('font.ttf', MAX_IMPORT_BYTES, ttf)).toBeNull();
  });
});

describe('fonts for the document', () => {
  it('describes the embedding permissions', () => {
    const flags = { noSubsetting: false, bitmapOnly: false, restrictive: false };
    expect(embeddingLabel({ level: 'installable', ...flags })).toMatch(/^Installable/);
    expect(
      embeddingLabel({ level: 'restricted', ...flags, restrictive: true, noSubsetting: true }),
    ).toBe("Restricted: may not be embedded without the owner's permission (no subsetting)");
  });

  it('stores a user font as base64 with its size and SHA-256, names cut to what core allows', () => {
    const font = documentFont(
      'font#3',
      { family: 'x'.repeat(300), style: '  ' },
      'mine.ttf',
      new Uint8Array([1, 2, 3]),
      'c'.repeat(64),
      (b) => Buffer.from(b).toString('base64'),
    );
    expect(font).toEqual({
      id: 'font#3',
      family: 'x'.repeat(200),
      style: 'Regular',
      source: {
        kind: 'file',
        fileName: 'mine.ttf',
        size: 3,
        sha256: 'c'.repeat(64),
        data: 'AQID',
      },
    });
  });

  it('cuts names in UTF-16 code units, as core counts, never inside a surrogate pair', () => {
    const emoji = '\u{1F600}'; // two code units
    const toBase64 = (b: Uint8Array) => Buffer.from(b).toString('base64');
    // 150 emoji are 300 code units: cut to 200, that is 100 whole emoji.
    const font = documentFont(
      'font#3',
      { family: emoji.repeat(150), style: 'a' + emoji.repeat(150) },
      emoji.repeat(200) + '.ttf',
      new Uint8Array([1]),
      'c'.repeat(64),
      toBase64,
    );
    expect(font.family).toBe(emoji.repeat(100));
    // "a" plus 99 emoji is 199 code units; the next would split a pair.
    expect(font.style).toBe('a' + emoji.repeat(99));
    expect(font.style.length).toBe(199);
    expect(font.source.kind === 'file' && font.source.fileName).toBe(emoji.repeat(127));
    expect(FontSchema.safeParse(font).success).toBe(true);
    expect(cutUtf16('abc', 2)).toBe('ab');
    expect(cutUtf16('abc', 5)).toBe('abc');
  });
});
