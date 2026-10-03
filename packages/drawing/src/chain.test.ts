import { describe, expect, it } from 'vitest';
import { MAX_CHAIN_MARKS, MAX_CHAIN_POINTS, chainSpans, layoutChain } from './chain';
import { DEFAULT_DIMENSION_STYLE } from './dimension';
import type { DisplayItem, TextItem } from './display';
import { layoutSheet } from './drawing';
import { formatDimensionLength, type ValueFormat } from './format';
import type { Vec2 } from './geometry';

const IN = 25.4;
const FT_IN: ValueFormat = { length: { unit: 'ft-in', denominator: 16 } };
const IDENTITY = { scale: 1, offset: [0, 0] as Vec2 };
/** 1/4" = 1'-0": a quarter inch of paper per foot of model. */
const QUARTER_INCH = { scale: 1 / 48, offset: [20, 40] as Vec2 };

const texts = (items: readonly DisplayItem[]) =>
  items.filter((i): i is TextItem => i.kind === 'text');

/** A 16' wall, its start at 0, with a 36" door rough opening centred 48" along it. */
const WALL: Vec2[] = [0, 30, 66, 192].map((x) => [x * IN, 0]);

describe('chained dimensions', () => {
  it('measures consecutive spans along the chain, dropping repeated points', () => {
    expect(chainSpans('horizontal', WALL).map((v) => Math.round((v / IN) * 1e9) / 1e9)).toEqual([
      30, 36, 126,
    ]);
    const two = chainSpans('horizontal', [WALL[0]!, WALL[0]!, WALL[3]!]);
    expect(two).toHaveLength(1);
    expect(two[0]! / IN).toBeCloseTo(192, 9);
    expect(
      chainSpans('vertical', [
        [0, 0],
        [5, 10],
        [0, 30],
      ]),
    ).toEqual([10, 20]);
    const aligned = chainSpans('aligned', [
      [0, 0],
      [3, 4],
      [6, 8],
    ]);
    expect(aligned[0]).toBeCloseTo(5, 12);
    expect(aligned[1]).toBeCloseTo(5, 12);
    expect(chainSpans('aligned', [[1, 1]])).toEqual([]);
  });

  it('gives a 16 ft wall with a door the expected string, in feet and inches', () => {
    const { items, warnings } = layoutChain(
      { id: 'chain#1', view: 'view#1', kind: 'horizontal', points: WALL, offset: -8 },
      QUARTER_INCH,
      FT_IN,
    );
    expect(warnings).toEqual([]);
    // The three spans in order, then the overall in a second row.
    expect(texts(items).map((t) => t.text)).toEqual([`2' 6"`, `3' 0"`, `10' 6"`, `16' 0"`]);
    expect(formatDimensionLength(192 * IN, FT_IN)).toBe(`16' 0"`);
    // Every item belongs to the chain.
    expect(items.every((i) => i.owner === 'chain#1')).toBe(true);
    // The first row lies 8 mm below the wall (paper y 40), the overall row further out.
    const rows = items
      .filter((i): i is Extract<DisplayItem, { kind: 'line' }> => i.kind === 'line')
      .filter((l) => Math.abs(l.a[1] - l.b[1]) < 1e-9 && l.a[1] < 40 - 1)
      .map((l) => l.a[1]);
    expect(Math.max(...rows)).toBeCloseTo(32, 9);
    expect(Math.min(...rows)).toBeLessThan(32 - DEFAULT_DIMENSION_STYLE.textHeight);
  });

  it('draws the extension line two spans share once', () => {
    const { items } = layoutChain(
      { id: 'chain#1', view: 'view#1', kind: 'horizontal', points: WALL, offset: -8 },
      QUARTER_INCH,
      FT_IN,
    );
    const vertical = items.filter(
      (i): i is Extract<DisplayItem, { kind: 'line' }> =>
        i.kind === 'line' && Math.abs(i.a[0] - i.b[0]) < 1e-9 && i.a[1] > 30,
    );
    // One extension line per point of the first row, from the wall down.
    const xs = new Set(vertical.map((l) => l.a[0].toFixed(6)));
    expect(xs.size).toBe(4);
  });

  it('nudges a value that would overlap the one before it across the line, a row at a time', () => {
    // Three narrow spans at 1:1: none of the values fits between its arrows.
    const { items } = layoutChain(
      {
        id: 'chain#2',
        view: 'view#1',
        kind: 'horizontal',
        points: [
          [0, 0],
          [4, 0],
          [8, 0],
          [12, 0],
        ],
        offset: 10,
        overall: false,
      },
      IDENTITY,
    );
    const ys = texts(items).map((t) => t.at[1]);
    expect(new Set(ys.map((y) => y.toFixed(6))).size).toBeGreaterThan(1);
    // Never more than MAX_NUDGE rows away.
    const row = DEFAULT_DIMENSION_STYLE.textHeight + 2 * DEFAULT_DIMENSION_STYLE.textGap;
    expect(Math.max(...ys) - Math.min(...ys)).toBeLessThanOrEqual(3 * row + 1e-9);
  });

  it('puts the overall row outside on the side of the offset, for a vertical chain too', () => {
    const { items } = layoutChain(
      {
        id: 'chain#3',
        view: 'view#1',
        kind: 'vertical',
        points: [
          [0, 0],
          [0, 900],
          [0, 2350],
        ],
        offset: 12,
      },
      { scale: 0.05, offset: [100, 50] },
      { length: { unit: 'mm' } },
    );
    expect(texts(items).map((t) => t.text)).toEqual(['900', '1450', '2350']);
    const overall = texts(items).at(-1)!;
    expect(overall.at[0]).toBeGreaterThan(texts(items)[0]!.at[0]);
  });

  it('draws a layout mark (an X) on the first row at each mark', () => {
    const marks: Vec2[] = [0, 16, 32, 48].map((x) => [x * IN, 0]);
    const { items } = layoutChain(
      { id: 'chain#4', view: 'view#1', kind: 'horizontal', points: WALL, offset: -8, marks },
      QUARTER_INCH,
      FT_IN,
    );
    const crosses = items.filter(
      (i) =>
        i.kind === 'line' && Math.abs(i.a[0] - i.b[0]) > 1e-9 && Math.abs(i.a[1] - i.b[1]) > 1e-9,
    );
    // Two strokes per mark (arrowheads are polylines, not lines).
    expect(crosses).toHaveLength(8);
  });

  it('warns about a chain with one point, or over its bounds, and draws nothing', () => {
    const one = layoutChain(
      {
        id: 'c',
        view: 'v',
        kind: 'horizontal',
        points: [
          [0, 0],
          [0, 0],
        ],
        offset: 5,
      },
      IDENTITY,
    );
    expect(one.items).toEqual([]);
    expect(one.warnings.map((w) => w.code)).toEqual(['degenerate-dimension']);
    const many = Array.from({ length: MAX_CHAIN_POINTS + 1 }, (_, i): Vec2 => [i, 0]);
    expect(
      layoutChain({ id: 'c', view: 'v', kind: 'horizontal', points: many, offset: 5 }, IDENTITY)
        .warnings,
    ).toHaveLength(1);
    const marks = Array.from({ length: MAX_CHAIN_MARKS + 1 }, (_, i): Vec2 => [i, 0]);
    expect(
      layoutChain(
        { id: 'c', view: 'v', kind: 'horizontal', points: WALL, offset: 5, marks },
        IDENTITY,
      ).warnings,
    ).toHaveLength(1);
  });

  it('is laid out by layoutSheet in its view, and warns about an unknown view', () => {
    const list = layoutSheet({
      sheet: { size: 'A3' },
      scale: { paper: 1, model: 48, notation: 'imperial' },
      views: [
        {
          id: 'view#1',
          edges: [
            {
              item: 0,
              cls: 'sharp',
              visible: true,
              curve: { kind: 'line', a: [0, 0], b: [192 * IN, 0] },
            },
          ],
        },
      ],
      chains: [
        { id: 'chain#1', view: 'view#1', kind: 'horizontal', points: WALL, offset: -8 },
        { id: 'chain#2', view: 'view#9', kind: 'horizontal', points: WALL, offset: -8 },
      ],
      format: FT_IN,
      titleBlock: false,
    });
    expect(
      texts(list.items)
        .filter((t) => t.owner === 'chain#1')
        .map((t) => t.text),
    ).toEqual([`2' 6"`, `3' 0"`, `10' 6"`, `16' 0"`]);
    expect(list.warnings.map((w) => [w.code, w.subject])).toEqual([['unknown-view', 'chain#2']]);
  });
});
