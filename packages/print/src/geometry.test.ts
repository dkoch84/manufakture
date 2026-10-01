import { describe, expect, it } from 'vitest';
import {
  applyPlacement,
  intersectConvex,
  isConvexCcw,
  normalize,
  outsideDistance,
  overlapDepth,
  placementMatrix,
  quatFromAxisAngle,
  quatMultiply,
  rectangle,
  rotateDirection,
  type Vec2,
} from './geometry';

const square = (x0: number, y0: number, x1: number, y1: number) => rectangle([x0, y0], [x1, y1]);

describe('rotations', () => {
  it('applies a placement as R p + t, and directions without t', () => {
    const p = {
      rotation: quatFromAxisAngle([0, 0, 1], Math.PI / 2),
      translation: [1, 2, 3] as const,
    };
    const q = applyPlacement(p, [1, 0, 0]);
    [1, 3, 3].forEach((v, i) => expect(q[i]).toBeCloseTo(v, 12));
    const d = rotateDirection(p, [1, 0, 0]);
    [0, 1, 0].forEach((v, i) => expect(d[i]).toBeCloseTo(v, 12));
  });

  it('multiplies quaternions as "b, then a"', () => {
    const a = quatFromAxisAngle([0, 0, 1], Math.PI / 2);
    const b = quatFromAxisAngle([1, 0, 0], Math.PI / 2);
    const d = rotateDirection({ rotation: quatMultiply(a, b), translation: [0, 0, 0] }, [0, 1, 0]);
    // b: y -> z; a: z stays.
    [0, 0, 1].forEach((v, i) => expect(d[i]).toBeCloseTo(v, 12));
  });

  it('normalises quaternions and treats a zero one as the identity', () => {
    expect(placementMatrix({ rotation: [0, 0, 0, 2], translation: [0, 0, 0] })).toEqual([
      1, 0, 0, 0, 1, 0, 0, 0, 1,
    ]);
    expect(placementMatrix({ rotation: [0, 0, 0, 0], translation: [0, 0, 0] })).toEqual([
      1, 0, 0, 0, 1, 0, 0, 0, 1,
    ]);
    expect(quatFromAxisAngle([0, 0, 0], 1)).toEqual([0, 0, 0, 1]);
    expect(normalize([0, 0, 0])).toBeNull();
  });
});

describe('polygons', () => {
  it('recognises convex counter-clockwise polygons', () => {
    expect(isConvexCcw(square(0, 0, 1, 1))).toBe(true);
    expect(isConvexCcw([...square(0, 0, 1, 1)].reverse())).toBe(false);
    const notch: Vec2[] = [
      [0, 0],
      [2, 0],
      [1, 0.5],
      [2, 2],
      [0, 2],
    ];
    expect(isConvexCcw(notch)).toBe(false);
    expect(
      isConvexCcw([
        [0, 0],
        [1, 0],
      ]),
    ).toBe(false);
  });

  it('intersects convex polygons', () => {
    const r = intersectConvex(square(0, 0, 325, 320), square(25, 0, 350, 320));
    expect(r).toEqual(square(25, 0, 325, 320));
    expect(intersectConvex(square(0, 0, 1, 1), square(2, 0, 3, 1))).toEqual([]);
    // Edge contact only has no area.
    expect(intersectConvex(square(0, 0, 1, 1), square(1, 0, 2, 1))).toEqual([]);
  });

  it('measures how far a point is outside', () => {
    const s = square(0, 0, 10, 10);
    expect(outsideDistance(s, [5, 5])).toBe(-5);
    expect(outsideDistance(s, [10, 5])).toBe(0);
    expect(outsideDistance(s, [12, 5])).toBe(2);
  });

  it('measures how deep two polygons overlap', () => {
    expect(overlapDepth(square(0, 0, 10, 10), square(8, 2, 20, 4))).toBe(2);
    expect(overlapDepth(square(0, 0, 10, 10), square(10, 0, 20, 10))).toBe(0);
    expect(overlapDepth(square(0, 0, 10, 10), square(11, 0, 20, 10))).toBe(-1);
  });
});
