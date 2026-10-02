import { describe, expect, it } from 'vitest';
import {
  TAU,
  curveBounds,
  curveLength,
  curvePoints,
  distanceToCurve,
  ellipsePoint,
  subtractIntervals,
  sweep,
  transformCurve,
  type Curve2,
} from './geometry';

const close = (a: readonly number[], b: readonly number[], digits = 9) =>
  a.forEach((v, i) => expect(v).toBeCloseTo(b[i]!, digits));

describe('sweep', () => {
  it('measures counter-clockwise, with full turns and wrap-around', () => {
    expect(sweep(0, Math.PI / 2)).toBeCloseTo(Math.PI / 2);
    expect(sweep(0, TAU)).toBe(TAU);
    expect(sweep(1, 1 + 3 * TAU)).toBe(TAU);
    expect(sweep((3 * Math.PI) / 2, Math.PI / 2)).toBeCloseTo(Math.PI);
    expect(sweep(1, 1)).toBe(0);
  });
});

describe('transformCurve', () => {
  it('scales and moves every kind of curve', () => {
    const t = { scale: 2, offset: [10, 20] as const };
    expect(transformCurve(t, { kind: 'line', a: [1, 2], b: [3, 4] })).toEqual({
      kind: 'line',
      a: [12, 24],
      b: [16, 28],
    });
    expect(transformCurve(t, { kind: 'arc', center: [1, 1], radius: 3, start: 0, end: 1 })).toEqual(
      { kind: 'arc', center: [12, 22], radius: 6, start: 0, end: 1 },
    );
    expect(
      transformCurve(t, {
        kind: 'ellipseArc',
        center: [0, 0],
        major: 2,
        minor: 1,
        rotation: 0.5,
        start: 0,
        end: 1,
      }),
    ).toEqual({
      kind: 'ellipseArc',
      center: [10, 20],
      major: 4,
      minor: 2,
      rotation: 0.5,
      start: 0,
      end: 1,
    });
    expect(
      transformCurve(t, {
        kind: 'polyline',
        points: [
          [0, 0],
          [1, 0],
        ],
      }),
    ).toEqual({
      kind: 'polyline',
      points: [
        [10, 20],
        [12, 20],
      ],
    });
  });
});

describe('curveBounds', () => {
  it('includes the quadrant points an arc passes', () => {
    const b = curveBounds({
      kind: 'arc',
      center: [0, 0],
      radius: 2,
      start: -0.1,
      end: Math.PI / 2 + 0.1,
    });
    close(b.min, [-2 * Math.sin(0.1), -2 * Math.sin(0.1)]);
    close(b.max, [2, 2]);
  });

  it('is exact for a rotated ellipse', () => {
    const e: Curve2 = {
      kind: 'ellipseArc',
      center: [1, 1],
      major: 3,
      minor: 1,
      rotation: Math.PI / 6,
      start: 0,
      end: TAU,
    };
    const b = curveBounds(e);
    const pts = curvePoints(e, 1e-6);
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    close(b.min, [Math.min(...xs), Math.min(...ys)], 5);
    close(b.max, [Math.max(...xs), Math.max(...ys)], 5);
  });
});

describe('lengths, points and distances', () => {
  it('measures a quarter circle and an ellipse', () => {
    expect(
      curveLength({ kind: 'arc', center: [0, 0], radius: 2, start: 0, end: Math.PI / 2 }),
    ).toBeCloseTo(Math.PI);
    const circleAsEllipse: Curve2 = {
      kind: 'ellipseArc',
      center: [0, 0],
      major: 1,
      minor: 1,
      rotation: 0.3,
      start: 0,
      end: TAU,
    };
    expect(curveLength(circleAsEllipse)).toBeCloseTo(TAU, 5);
  });

  it('places ellipse points by eccentric anomaly', () => {
    const e = {
      kind: 'ellipseArc',
      center: [0, 0],
      major: 2,
      minor: 1,
      rotation: Math.PI / 2,
      start: 0,
      end: 1,
    } as const;
    close(ellipsePoint(e, 0), [0, 2]);
    close(ellipsePoint(e, Math.PI / 2), [-1, 0]);
  });

  it('keeps chords of an arc within the tolerance', () => {
    const arc = { kind: 'arc', center: [0, 0], radius: 100, start: 0, end: Math.PI } as const;
    const pts = curvePoints(arc, 0.01);
    for (let i = 1; i < pts.length; i++) {
      const m = [(pts[i - 1]![0] + pts[i]![0]) / 2, (pts[i - 1]![1] + pts[i]![1]) / 2];
      expect(100 - Math.hypot(m[0]!, m[1]!)).toBeLessThanOrEqual(0.01 + 1e-12);
    }
  });

  it('measures distance to lines and arcs', () => {
    expect(distanceToCurve([5, 3], { kind: 'line', a: [0, 0], b: [10, 0] })).toBe(3);
    expect(distanceToCurve([13, 0], { kind: 'line', a: [0, 0], b: [10, 0] })).toBe(3);
    const arc = { kind: 'arc', center: [0, 0], radius: 5, start: 0, end: Math.PI / 2 } as const;
    expect(distanceToCurve([0, 7], arc)).toBeCloseTo(2);
    expect(distanceToCurve([0, -5], arc)).toBeCloseTo(Math.hypot(5, 5));
  });
});

describe('subtractIntervals', () => {
  it('leaves the gaps longer than the minimum', () => {
    expect(
      subtractIntervals(
        10,
        [
          [2, 3],
          [2.5, 4],
          [9.95, 12],
        ],
        0.1,
      ),
    ).toEqual([
      [0, 2],
      [4, 9.95],
    ]);
    expect(subtractIntervals(10, [], 0.1)).toEqual([[0, 10]]);
    expect(subtractIntervals(10, [[-1, 11]], 0.1)).toEqual([]);
  });
});
