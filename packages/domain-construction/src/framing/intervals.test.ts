import { describe, expect, it } from 'vitest';
import { overlaps, splice, subtract } from './intervals';

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
