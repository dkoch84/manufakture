import { describe, expect, it } from 'vitest';
import { IntervalIndex, overlaps, splice, subtract, type Interval } from './intervals';

describe('subtract', () => {
  it('cuts holes out of a run and drops slivers', () => {
    expect(subtract(0, 100, [[30, 66]])).toEqual([
      [0, 30],
      [66, 100],
    ]);
    expect(
      subtract(
        0,
        100,
        [
          [-5, 10],
          [99.5, 120],
        ],
        1,
      ),
    ).toEqual([[10, 99.5]]);
    expect(subtract(0, 100, [[0, 100]])).toEqual([]);
  });

  it('cuts the same pieces as cutting every piece with every hole, in any hole order', () => {
    const EPS = 1e-6;
    const naive = (holes: readonly Interval[], min: number): Interval[] => {
      let parts: Interval[] = [[0, 100]];
      for (const [h0, h1] of holes)
        parts = parts.flatMap(([p0, p1]): Interval[] => {
          if (h1 <= p0 + EPS || h0 >= p1 - EPS) return [[p0, p1]];
          return [
            ...(h0 > p0 ? [[p0, h0] as Interval] : []),
            ...(h1 < p1 ? [[h1, p1] as Interval] : []),
          ];
        });
      return parts.filter(([p0, p1]) => p1 - p0 >= min);
    };
    let seed = 7;
    const rand = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
    for (let t = 0; t < 2000; t++) {
      const holes = Array.from({ length: Math.floor(rand() * 10) }, (): Interval => {
        // Whole millimetres, some nudged by under the tolerance, some empty or reversed.
        const a = Math.round(rand() * 120 - 10) + (rand() < 0.3 ? 4e-7 : 0);
        const w = rand() < 0.1 ? -5 : rand() < 0.2 ? 0 : Math.round(rand() * 30);
        return [a, a + w];
      });
      const min = [EPS, 0, 1][t % 3]!;
      expect(subtract(0, 100, holes, min)).toEqual(naive(holes, min));
    }
  });
});

describe('IntervalIndex', () => {
  it('answers as testing every interval does', () => {
    let seed = 11;
    const rand = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
    const span = (): Interval => {
      const a = Math.round(rand() * 100);
      return [a, a + Math.round(rand() * 20) + (rand() < 0.2 ? 0.005 : 0)];
    };
    for (let t = 0; t < 500; t++) {
      const items = Array.from({ length: Math.floor(rand() * 12) }, span);
      const index = new IntervalIndex(items);
      for (let q = 0; q < 20; q++) {
        const s = span();
        expect(index.overlapsAny(s, 0.01)).toBe(items.some((i) => overlaps(i, s, 0.01)));
        expect(index.containsAny(s, 1e-6)).toBe(
          items.some((i) => s[0] >= i[0] - 1e-6 && s[1] <= i[1] + 1e-6),
        );
      }
    }
  });
});

describe('overlaps', () => {
  it('treats touching as not overlapping', () => {
    expect(overlaps([0, 1], [1, 2], 0.01)).toBe(false);
    expect(overlaps([0, 1.5], [1, 2], 0.01)).toBe(true);
  });
});

describe('splice', () => {
  it('leaves a run that fits the stock whole', () => {
    expect(splice([[0, 192]], 192, [], 24)).toEqual({
      pieces: [[0, 192]],
      splices: [],
      tooClose: [],
    });
  });

  it('keeps a splice the offset away from the course below', () => {
    const below = splice([[0, 360]], 192, [], 24);
    expect(below.splices).toEqual([192]);
    const above = splice([[0, 360]], 192, below.splices, 24);
    expect(above.pieces).toEqual([
      [0, 168],
      [168, 360],
    ]);
    expect(above.tooClose).toEqual([]);
  });

  it('avoids a remainder shorter than the offset', () => {
    expect(splice([[0, 200]], 192, [], 24).pieces).toEqual([
      [0, 176],
      [176, 200],
    ]);
  });

  it('reports a splice it cannot keep clear', () => {
    // Splices below every 10 leave nowhere 24 clear.
    const avoid = Array.from({ length: 50 }, (_, i) => i * 10);
    const r = splice([[0, 400]], 192, avoid, 24);
    expect(r.tooClose.length).toBeGreaterThan(0);
    for (const [a, b] of r.pieces) expect(b - a).toBeLessThanOrEqual(192);
  });
});
