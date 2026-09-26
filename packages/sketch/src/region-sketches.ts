// Test sketches for region detection (regions, fills, kernel profiles).
// Not exported from the package.

import type { ArcEntity, CircleEntity, LineEntity, SketchEntity, Vec2 } from './model';

export const line = (id: string, start: Vec2, end: Vec2, construction = false): LineEntity => ({
  id,
  kind: 'line',
  construction,
  start,
  end,
});

export const circle = (id: string, center: Vec2, radius: number): CircleEntity => ({
  id,
  kind: 'circle',
  construction: false,
  center,
  radius,
});

/** Counter-clockwise from `start` to `end`. */
export const arc = (id: string, center: Vec2, start: Vec2, end: Vec2): ArcEntity => ({
  id,
  kind: 'arc',
  construction: false,
  center,
  start,
  end,
});

/** A counter-clockwise rectangle `<p>1` (bottom), `<p>2` (right), `<p>3` (top), `<p>4` (left). */
export function rect(p: string, x0: number, y0: number, x1: number, y1: number): LineEntity[] {
  const c: Vec2[] = [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
  return c.map((start, i) => line(`${p}${i + 1}`, start, c[(i + 1) % 4]!));
}

/** A slot along x: two lines and two half-circle end arcs, all tangent. */
export function slot(x0: number, x1: number, y: number, r: number): SketchEntity[] {
  return [
    line('s1', [x0, y - r], [x1, y - r]),
    arc('s2', [x1, y], [x1, y - r], [x1, y + r]),
    line('s3', [x1, y + r], [x0, y + r]),
    arc('s4', [x0, y], [x0, y + r], [x0, y - r]),
  ];
}

export const SKETCHES = {
  rectWithHole: (w = 40, h = 30, r = 5): SketchEntity[] => [
    ...rect('l', 0, 0, w, h),
    circle('c1', [w / 2, h / 2], r),
  ],
  overlappingRects: (s = 1): SketchEntity[] => [
    ...rect('a', 0, 0, 10 * s, 10 * s),
    ...rect('b', 5 * s, 5 * s, 15 * s, 15 * s),
  ],
  circleAndLine: (): SketchEntity[] => [circle('c1', [0, 0], 10), line('l1', [-15, 2], [15, 2])],
  slot: (): SketchEntity[] => slot(0, 30, 0, 5),
  tJunction: (): SketchEntity[] => [...rect('l', 0, 0, 20, 10), line('m', [10, 0], [10, 10])],
  island: (): SketchEntity[] => [
    ...rect('l', 0, 0, 40, 40),
    circle('c1', [20, 20], 12),
    circle('c2', [20, 20], 5),
  ],
};
