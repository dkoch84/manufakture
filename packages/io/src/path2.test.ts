import { describe, expect, it } from 'vitest';
import { HELVETICA_CAP_HEIGHT, HELVETICA_DESCENT, helveticaTextWidth } from './helvetica';
import {
  baselinePoint,
  connectedRuns,
  formatNumber,
  itemsByLayer,
  layerDash,
  line,
  pageOf,
  polylinePath,
  segmentBeziers,
  segmentBounds,
  segmentPoint,
  sheetBounds,
  textCorners,
  type Segment2,
  type Sheet2,
  type Text2,
} from './path2';

const close = (a: readonly number[], b: readonly number[], tol = 1e-9) =>
  a.forEach((v, i) => expect(v).toBeCloseTo(b[i]!, -Math.log10(tol)));

describe('formatNumber', () => {
  it('writes at most six decimals, no trailing zeros, exponent or negative zero', () => {
    expect(formatNumber(1)).toBe('1');
    expect(formatNumber(0.1 + 0.2)).toBe('0.3');
    expect(formatNumber(-1e-9)).toBe('0');
    expect(formatNumber(1e-7)).toBe('0');
    expect(formatNumber(123456.1234567)).toBe('123456.123457');
    expect(formatNumber(2.5, 0)).toBe('3');
    expect(() => formatNumber(NaN)).toThrow();
  });
});

describe('segments', () => {
  it('runs arcs counter-clockwise when end > start and clockwise when end < start', () => {
    const ccw: Segment2 = { kind: 'arc', center: [0, 0], radius: 2, start: 0, end: Math.PI / 2 };
    const cw: Segment2 = { kind: 'arc', center: [0, 0], radius: 2, start: 0, end: -Math.PI / 2 };
    close(segmentPoint(ccw, 'end'), [0, 2]);
    close(segmentPoint(cw, 'end'), [0, -2]);
    expect(segmentBounds(ccw)).toEqual({ min: [expect.closeTo(0), 0], max: [2, 2] });
    const b = segmentBounds(cw);
    close([...b.min, ...b.max], [0, -2, 2, 0]);
  });

  it('bounds an ellipse arc by its true extremes', () => {
    const e: Segment2 = {
      kind: 'ellipseArc',
      center: [0, 0],
      major: 10,
      minor: 5,
      rotation: Math.PI / 4,
      start: 0,
      end: 2 * Math.PI,
    };
    // A rotated ellipse's half-width: sqrt(a^2 cos^2 + b^2 sin^2).
    const half = Math.sqrt((100 + 25) / 2);
    const b = segmentBounds(e);
    close([...b.min, ...b.max], [-half, -half, half, half]);
  });

  it('approximates arcs by Beziers within 3e-4 of the radius, a quarter turn each at most', () => {
    const e: Segment2 = {
      kind: 'ellipseArc',
      center: [3, 4],
      major: 10,
      minor: 4,
      rotation: 0.3,
      start: 0.2,
      end: -4,
    };
    const curves = segmentBeziers(e);
    expect(curves).toHaveLength(3);
    close(curves[0]![0], segmentPoint(e, 'start'));
    close(curves[2]![3], segmentPoint(e, 'end'));
    const arc: Segment2 = { kind: 'arc', center: [0, 0], radius: 1, start: 0, end: 2 * Math.PI };
    for (const [p0, c1, c2, p3] of segmentBeziers(arc)) {
      for (let t = 0; t <= 1; t += 0.05) {
        const u = 1 - t;
        const x = u ** 3 * p0[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t ** 3 * p3[0];
        const y = u ** 3 * p0[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t ** 3 * p3[1];
        expect(Math.abs(Math.hypot(x, y) - 1)).toBeLessThan(3e-4);
      }
    }
  });

  it('splits a path into connected runs', () => {
    const runs = connectedRuns([line([0, 0], [1, 0]), line([1, 0], [1, 1]), line([5, 5], [6, 6])]);
    expect(runs.map((r) => r.length)).toEqual([2, 1]);
  });
});

describe('sheets', () => {
  it('orders items by layer and refuses undeclared or duplicate layers', () => {
    const sheet: Sheet2 = {
      layers: [{ name: 'a' }, { name: 'b' }],
      items: [
        polylinePath('b', [
          [0, 0],
          [1, 1],
        ]),
        polylinePath('a', [
          [2, 2],
          [3, 3],
        ]),
      ],
    };
    expect(itemsByLayer(sheet).map((g) => [g.layer.name, g.items.length])).toEqual([
      ['a', 1],
      ['b', 1],
    ]);
    expect(() => itemsByLayer({ ...sheet, layers: [{ name: 'a' }] })).toThrow(/undeclared/);
    expect(() => itemsByLayer({ ...sheet, layers: [{ name: 'a' }, { name: 'a' }] })).toThrow(
      /Duplicate/,
    );
  });

  it('pages a sheet without a size by its bounds', () => {
    const sheet: Sheet2 = {
      layers: [{ name: 'cut' }],
      items: [
        {
          kind: 'path',
          layer: 'cut',
          segments: [{ kind: 'arc', center: [10, 20], radius: 5, start: 0, end: 2 * Math.PI }],
        },
      ],
    };
    expect(pageOf(sheet)).toEqual({ origin: [5, 15], width: 10, height: 10 });
    expect(pageOf({ ...sheet, size: { width: 100, height: 50 } })).toEqual({
      origin: [0, 0],
      width: 100,
      height: 50,
    });
  });

  it('puts the baseline below `at` along the text direction', () => {
    const t = {
      kind: 'text' as const,
      layer: 't',
      at: [10, 10] as const,
      text: 'X',
      height: 4,
      anchor: 'start' as const,
    };
    close(baselinePoint({ ...t, rotation: 0, baseline: 'top' }), [10, 6]);
    close(baselinePoint({ ...t, rotation: 0, baseline: 'middle' }), [10, 8]);
    close(baselinePoint({ ...t, rotation: Math.PI / 2, baseline: 'top' }), [14, 10]);
    close(baselinePoint({ ...t, rotation: 0, baseline: 'bottom' }), [10, 10]);
  });
});

describe('hostile numbers', () => {
  it('refuses to write a number whose rounded value is not finite or needs an exponent', () => {
    expect(() => formatNumber(1e303)).toThrow(RangeError);
    expect(() => formatNumber(2e21)).toThrow(RangeError);
    expect(() => formatNumber(-2e21)).toThrow(RangeError);
    expect(() => formatNumber(1e21, 0)).toThrow(RangeError);
    expect(() => formatNumber(Infinity)).toThrow(RangeError);
    expect(formatNumber(1e20)).toBe('100000000000000000000');
    expect(formatNumber(-123.4567891)).toBe('-123.456789');
  });

  it('bounds arcs at huge angles without looping: refused beyond 1e6 rad, normalised below', () => {
    for (const start of [1e20, -1e20, 1e7, NaN])
      expect(() =>
        segmentBounds({ kind: 'arc', center: [0, 0], radius: 1, start, end: start + 1 }),
      ).toThrow(RangeError);
    expect(() =>
      segmentBounds({
        kind: 'ellipseArc',
        center: [0, 0],
        major: 2,
        minor: 1,
        rotation: 0,
        start: 0,
        end: 1e20,
      }),
    ).toThrow(RangeError);
    // A start many turns out gives the same bounds as the same arc within one turn.
    const turns = 1000 * 2 * Math.PI;
    const near = segmentBounds({ kind: 'arc', center: [0, 0], radius: 1, start: 0.1, end: 2 });
    const far = segmentBounds({
      kind: 'arc',
      center: [0, 0],
      radius: 1,
      start: 0.1 + turns,
      end: 2 + turns,
    });
    close([...far.min, ...far.max], [...near.min, ...near.max], 1e-9);
    expect(near.max[1]).toBeCloseTo(1, 12);
  }, 1000);
});

describe('page bounds', () => {
  const textSheet = (anchor: 'start' | 'middle' | 'end', rotation = 0): Sheet2 => ({
    layers: [{ name: 't' }],
    items: [
      {
        kind: 'text',
        layer: 't',
        at: [10, 20],
        text: 'Hello',
        height: 5,
        rotation,
        anchor,
        baseline: 'bottom',
      },
    ],
  });
  const size = 5 / HELVETICA_CAP_HEIGHT;
  const width = helveticaTextWidth('Hello', size);

  it('counts text by its Helvetica box, so a page from bounds does not clip it', () => {
    expect(sheetBounds(textSheet('start'))).toEqual({
      min: [10, expect.closeTo(20 - HELVETICA_DESCENT * size, 9)],
      max: [expect.closeTo(10 + width, 9), 25],
    });
    const mid = sheetBounds(textSheet('middle'));
    expect(mid.min[0]).toBeCloseTo(10 - width / 2, 9);
    expect(mid.max[0]).toBeCloseTo(10 + width / 2, 9);
    const end = pageOf(textSheet('end'));
    expect(end.origin[0]).toBeCloseTo(10 - width, 9);
    expect(end.width).toBeCloseTo(width, 9);
    // A quarter turn: the run goes up.
    const up = sheetBounds(textSheet('start', Math.PI / 2));
    expect(up.min[1]).toBeCloseTo(20, 9);
    expect(up.max[1]).toBeCloseTo(20 + width, 9);
    expect(up.min[0]).toBeCloseTo(5, 9);
    expect(textCorners(textSheet('start').items[0] as Text2)).toHaveLength(4);
  });

  it('refuses a sheet with no size and no items, and gives thin sheets a minimal side', () => {
    expect(() => pageOf({ layers: [], items: [] })).toThrow(/needs items/);
    expect(pageOf({ layers: [], items: [], size: { width: 10, height: 10 } }).width).toBe(10);
    const flat = pageOf({
      layers: [{ name: 'a' }],
      items: [
        polylinePath('a', [
          [0, 5],
          [20, 5],
        ]),
      ],
    });
    expect(flat).toEqual({ origin: [0, 4.5], width: 20, height: 1 });
  });

  it('clamps negative dash entries and drops all-zero patterns', () => {
    expect(layerDash({ name: 'a', dash: [-2, 1] })).toEqual([0, 1]);
    expect(layerDash({ name: 'a', dash: [-2, -1] })).toEqual([]);
    expect(layerDash({ name: 'a', dash: [0] })).toEqual([]);
    expect(layerDash({ name: 'a' })).toEqual([]);
  });
});
