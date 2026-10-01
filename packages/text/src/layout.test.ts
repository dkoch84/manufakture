import { outlineRegions, type PathCommand, type Vec2 } from '@manufakture/sketch/geometry';
import { describe, expect, it } from 'vitest';
import { layoutText } from './layout';
import { inter } from './test-helpers';

/** Bounding box of a path's points (control points included). */
function bounds(path: readonly PathCommand[]): { min: Vec2; max: Vec2 } {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const c of path) {
    if (c.kind === 'close') continue;
    const points =
      c.kind === 'quadTo'
        ? [c.control, c.to]
        : c.kind === 'cubicTo'
          ? [c.control1, c.control2, c.to]
          : [c.to];
    for (const p of points) {
      xs.push(p[0]);
      ys.push(p[1]);
    }
  }
  return { min: [Math.min(...xs), Math.min(...ys)], max: [Math.max(...xs), Math.max(...ys)] };
}

describe('layoutText: glyph outlines', () => {
  it('"O" is one region with one hole', () => {
    const layout = layoutText(inter(), 'O', { size: 10 });
    const { regions, issues } = outlineRegions(layout.glyphs[0]!.path);
    expect(issues).toEqual([]);
    expect(regions).toHaveLength(1);
    expect(regions[0]!.holes).toHaveLength(1);
  });

  it('"i" is two separate regions', () => {
    const layout = layoutText(inter(), 'i', { size: 10 });
    const { regions, issues } = outlineRegions(layout.glyphs[0]!.path);
    expect(issues).toEqual([]);
    expect(regions).toHaveLength(2);
    expect(regions.every((r) => r.holes.length === 0)).toBe(true);
  });

  it('keeps the control points of "O" from the font file', () => {
    // From the font's glyf table with fontTools 4.x (`Glyph.getCoordinates`): the
    // on-curve and off-curve points of "O", in font units.
    const onCurve = [
      [789, -20],
      [94, 744],
      [789, 1510],
      [1484, 744],
      [789, 251],
      [1174, 744],
      [789, 1239],
      [404, 744],
    ];
    const offCurve = [
      [592, -20],
      [277, 160],
      [94, 502],
      [94, 987],
      [277, 1330],
      [592, 1510],
      [987, 1510],
      [1301, 1330],
      [1484, 987],
      [1484, 501],
      [1301, 160],
      [987, -20],
      [963, 251],
      [1174, 504],
      [1174, 985],
      [963, 1239],
      [616, 1239],
      [404, 984],
      [404, 505],
      [616, 251],
    ];
    // Size = cap height in font units: one millimetre per font unit.
    const font = inter();
    const layout = layoutText(font, 'O', { size: font.capHeight });
    expect(layout.scale).toBe(1);
    const path = layout.glyphs[0]!.path;
    const round = (p: Vec2) => [Math.round(p[0] * 1e6) / 1e6, Math.round(p[1] * 1e6) / 1e6];
    // TrueType outlines are quadratic: every off-curve point is one quadTo's control, in order.
    const controls = path.flatMap((c) => (c.kind === 'quadTo' ? [round(c.control)] : []));
    expect(controls).toEqual(offCurve);
    expect(path.some((c) => c.kind === 'cubicTo')).toBe(false);
    // Every on-curve point is an end point; the others are the implied midpoints between
    // two off-curve points.
    const ends = path.flatMap((c) => (c.kind === 'close' ? [] : [round(c.to)]));
    for (const p of onCurve) expect(ends).toContainEqual(p);
    expect(path.filter((c) => c.kind === 'moveTo')).toHaveLength(2);
  });

  it('scales by cap height: "H" stands exactly `size` tall on the baseline', () => {
    const layout = layoutText(inter(), 'H', { size: 7.5 });
    const box = bounds(layout.glyphs[0]!.path);
    expect(box.min[1]).toBeCloseTo(0, 12);
    expect(box.max[1]).toBeCloseTo(7.5, 12);
    expect(layout.scale).toBeCloseTo(7.5 / 1490, 15);
  });

  it('gives a space no outline and reports characters the font lacks', () => {
    const layout = layoutText(inter(), 'a b⌀c😀', { size: 5 });
    expect(layout.glyphs.map((g) => [g.index, g.char, g.path.length > 0])).toEqual([
      [0, 'a', true],
      [1, ' ', false],
      [2, 'b', true],
      [3, '⌀', false],
      [4, 'c', true],
      [5, '😀', false],
    ]);
    expect(layout.missing).toEqual(['⌀', '😀']);
    // Missing characters take no space: "c" follows "b" directly.
    const [b, c] = [layout.glyphs[2]!, layout.glyphs[4]!];
    const kern =
      inter().kerning(inter().glyph('b')!.index, inter().glyph('c')!.index) * layout.scale;
    expect(c.origin[0]).toBeCloseTo(b.origin[0] + b.advance + kern, 12);
  });
});

describe('layoutText: widths and spacing', () => {
  it('matches the advance widths opentype.js reads, without kerning', () => {
    const font = inter();
    const text = 'Hello, World 123';
    const layout = layoutText(font, text, { size: 10, kerning: false });
    const units = [...text].reduce((sum, c) => sum + font.glyph(c)!.advanceWidth!, 0);
    expect(layout.lines[0]!.width).toBeCloseTo(units * layout.scale, 12);
  });

  it('kerns: "AVATAR" is as wide as HarfBuzz lays it out', () => {
    // HarfBuzz (uharfbuzz) advances for "AVATAR" in Inter Bold 4.1, kern on: 1367, 1367,
    // 1347, 1185, 1529, 1345; kern off: 1529, 1529, 1529, 1367, 1529, 1345.
    const font = inter();
    const kerned = layoutText(font, 'AVATAR', { size: 10 });
    const plain = layoutText(font, 'AVATAR', { size: 10, kerning: false });
    expect(kerned.lines[0]!.width / kerned.scale).toBeCloseTo(8140, 9);
    expect(plain.lines[0]!.width / plain.scale).toBeCloseTo(8828, 9);
    // The V is pulled 162 units towards the A.
    expect(kerned.glyphs[1]!.origin[0] / kerned.scale).toBeCloseTo(1529 - 162, 9);
  });

  it('adds letter spacing between neighbouring glyphs only', () => {
    const font = inter();
    const plain = layoutText(font, 'ABC', { size: 10 });
    const spaced = layoutText(font, 'ABC', { size: 10, letterSpacing: 0.5 });
    expect(spaced.lines[0]!.width).toBeCloseTo(plain.lines[0]!.width + 1, 12);
    expect(spaced.glyphs[2]!.origin[0]).toBeCloseTo(plain.glyphs[2]!.origin[0] + 1, 12);
  });

  it('spaces baselines by the line height times lineSpacing, lines running down', () => {
    const font = inter();
    const layout = layoutText(font, 'A\nB\r\nC', { size: 10 });
    const step = (2478 / 1490) * 10;
    expect(layout.lines.map((l) => l.text)).toEqual(['A', 'B', 'C']);
    expect(layout.lines.map((l) => l.baseline)).toEqual(
      [0, -step, -2 * step].map((v) => expect.closeTo(v, 12)),
    );
    const loose = layoutText(font, 'A\nB', { size: 10, lineSpacing: 1.5 });
    expect(loose.lines[1]!.baseline).toBeCloseTo(-1.5 * step, 12);
    // Indices count the line breaks ("\r\n" as two code points).
    expect(layout.glyphs.map((g) => [g.char, g.index, g.line])).toEqual([
      ['A', 0, 0],
      ['B', 2, 1],
      ['C', 5, 2],
    ]);
  });
});

describe('layoutText: alignment', () => {
  const font = inter();
  const text = 'Wide line\nshort';

  it('aligns each line left, centre or right of the anchor', () => {
    const left = layoutText(font, text, { size: 5 });
    const center = layoutText(font, text, { size: 5, align: 'center' });
    const right = layoutText(font, text, { size: 5, align: 'right' });
    for (let i = 0; i < 2; i++) {
      const width = left.lines[i]!.width;
      expect(left.lines[i]!.x).toBe(0);
      expect(center.lines[i]!.x).toBeCloseTo(-width / 2, 12);
      expect(right.lines[i]!.x).toBeCloseTo(-width, 12);
    }
    // Glyphs move with their line.
    const first = (l: typeof left, line: number) =>
      l.glyphs.find((g) => g.line === line)!.origin[0];
    expect(first(center, 1)).toBeCloseTo(-left.lines[1]!.width / 2, 12);
    expect(first(right, 0)).toBeCloseTo(-left.lines[0]!.width, 12);
    const lastW = right.glyphs.filter((g) => g.line === 0).at(-1)!;
    expect(lastW.origin[0] + lastW.advance).toBeCloseTo(0, 12);
  });

  it('puts the first baseline, the cap height or the middle of the block at y = 0', () => {
    const size = 6;
    const step = (2478 / 1490) * size;
    const baseline = layoutText(font, text, { size });
    const top = layoutText(font, text, { size, verticalAlign: 'top' });
    const middle = layoutText(font, text, { size, verticalAlign: 'middle' });
    expect(baseline.lines[0]!.baseline).toBe(0);
    expect(top.lines[0]!.baseline).toBeCloseTo(-size, 12);
    // From the first line's cap height to the last line's baseline, centred.
    const capTop = middle.lines[0]!.baseline + size;
    expect((capTop + middle.lines[1]!.baseline) / 2).toBeCloseTo(0, 12);
    expect(middle.lines[0]!.baseline - middle.lines[1]!.baseline).toBeCloseTo(step, 12);
    // A capital on a single top-aligned line hangs from y = 0.
    const box = bounds(layoutText(font, 'H', { size, verticalAlign: 'top' }).glyphs[0]!.path);
    expect(box.max[1]).toBeCloseTo(0, 12);
  });

  it('refuses a size that is not a positive number', () => {
    for (const size of [0, -1, Number.NaN, Infinity]) {
      expect(() => layoutText(font, 'A', { size })).toThrow(RangeError);
    }
    expect(() => layoutText(font, 'A', { size: 1, lineSpacing: -1 })).toThrow(RangeError);
    expect(() => layoutText(font, 'A', { size: 1, letterSpacing: Number.NaN })).toThrow(RangeError);
  });
});
