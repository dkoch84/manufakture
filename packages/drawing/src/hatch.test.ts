import { describe, expect, it } from 'vitest';
import type { HatchItem } from './display';
import { hatchLines } from './hatch';

const square = (x0: number, y0: number, s: number) =>
  [
    { kind: 'line', a: [x0, y0], b: [x0 + s, y0] },
    { kind: 'line', a: [x0 + s, y0], b: [x0 + s, y0 + s] },
    { kind: 'line', a: [x0 + s, y0 + s], b: [x0, y0 + s] },
    { kind: 'line', a: [x0, y0 + s], b: [x0, y0] },
  ] as const;

const hatch = (loops: HatchItem['loops'], angle = 0, spacing = 3): HatchItem => ({
  kind: 'hatch',
  layer: 'hatch',
  loops,
  angle,
  spacing,
});

describe('hatchLines', () => {
  it('fills a square with lines on the sheet-wide grid', () => {
    const lines = hatchLines(hatch([square(0.5, 0.5, 10)]));
    expect(lines.map(([a, b]) => [a[1], a[0], b[0]])).toEqual([
      [3, 0.5, 10.5],
      [6, 0.5, 10.5],
      [9, 0.5, 10.5],
    ]);
  });

  it('leaves holes empty (even-odd)', () => {
    const lines = hatchLines(hatch([square(0, 0, 12), square(4, 4, 4)], 0, 2));
    const at6 = lines.filter(([a]) => a[1] === 6);
    expect(at6.map(([a, b]) => [a[0], b[0]])).toEqual([
      [0, 4],
      [8, 12],
    ]);
  });

  it('turns the lines to the hatch angle', () => {
    const lines = hatchLines(hatch([square(0, 0, 10)], Math.PI / 4, 2));
    for (const [a, b] of lines) expect(Math.abs(b[1] - a[1] - (b[0] - a[0]))).toBeLessThan(1e-9);
    expect(lines.length).toBe(Math.floor((10 * Math.SQRT2) / 2));
  });

  it('hatches a circle inside its radius', () => {
    const lines = hatchLines(
      hatch([[{ kind: 'arc', center: [0, 0], radius: 5, start: 0, end: 2 * Math.PI }]], 0, 1),
      0.001,
    );
    const mid = lines.find(([a]) => Math.abs(a[1]) < 1e-9)!;
    expect(mid[0][0]).toBeCloseTo(-5, 2);
    expect(mid[1][0]).toBeCloseTo(5, 2);
    expect(hatchLines(hatch([square(0, 0, 1)], 0, 0))).toEqual([]);
  });
});
