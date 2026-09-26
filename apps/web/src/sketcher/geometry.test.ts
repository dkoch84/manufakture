import type { ArcEntity, LineEntity, Vec2 } from '@manufakture/sketch/model';
import { describe, expect, it } from 'vitest';
import {
  arcAngles,
  arcContainsAngle,
  arcThroughPoints,
  centerArc,
  circleThrough,
  closestOnEntity,
  distance,
  indexEntities,
  outwardTangent,
  pointPosition,
  tangentArc,
  tessellate,
  wrapDelta,
} from './geometry';

const close = (a: Vec2, b: Vec2, digits = 9) => {
  expect(a[0]).toBeCloseTo(b[0], digits);
  expect(a[1]).toBeCloseTo(b[1], digits);
};

const arc = (center: Vec2, start: Vec2, end: Vec2): ArcEntity => ({
  id: 'a',
  kind: 'arc',
  construction: false,
  center,
  start,
  end,
});

const line = (start: Vec2, end: Vec2, id = 'l'): LineEntity => ({
  id,
  kind: 'line',
  construction: false,
  start,
  end,
});

describe('sketch geometry', () => {
  it('finds the circle through three points and refuses collinear ones', () => {
    const c = circleThrough([1, 0], [0, 1], [-1, 0])!;
    close(c.center, [0, 0]);
    expect(c.radius).toBeCloseTo(1, 12);
    expect(circleThrough([0, 0], [1, 1], [2, 2])).toBeNull();
    expect(circleThrough([0, 0], [0, 0], [0, 0])).toBeNull();
  });

  it('stores an arc drawn clockwise counter-clockwise, with its ends swapped', () => {
    // Over the top from (1,0) to (-1,0) is counter-clockwise.
    const ccw = arcThroughPoints([1, 0], [-1, 0], [0, 1])!;
    expect(ccw.reversed).toBe(false);
    close(ccw.start, [1, 0]);
    close(ccw.end, [-1, 0]);
    // Under the bottom is clockwise: stored from (-1,0) to (1,0).
    const cw = arcThroughPoints([1, 0], [-1, 0], [0, -1])!;
    expect(cw.reversed).toBe(true);
    close(cw.start, [-1, 0]);
    close(cw.end, [1, 0]);
    expect(arcAngles(arc(cw.center, cw.start, cw.end)).sweep).toBeCloseTo(Math.PI, 12);
  });

  it('builds a tangent arc that leaves along the given direction', () => {
    // Heading +x from the origin, ending up and to the right: a left turn.
    const left = tangentArc([0, 0], [1, 0], [2, 2])!;
    expect(left.reversed).toBe(false);
    close(left.center, [0, 2]);
    // Ending down and to the right: a right turn, stored reversed.
    const right = tangentArc([0, 0], [1, 0], [2, -2])!;
    expect(right.reversed).toBe(true);
    close(right.center, [0, -2]);
    close(right.end, [0, 0]);
    // Straight ahead is no arc.
    expect(tangentArc([0, 0], [1, 0], [5, 0])).toBeNull();
    // The tangent of the arc at the start is the direction given.
    const a = arc(left.center, left.start, left.end);
    close(outwardTangent(a, 'start')!, [-1, 0]);
  });

  it('sweeps a centre arc either way and keeps the end on the radius', () => {
    const ccw = centerArc([0, 0], [2, 0], Math.PI / 2)!;
    expect(ccw.reversed).toBe(false);
    close(ccw.end, [0, 2]);
    const cw = centerArc([0, 0], [2, 0], -Math.PI / 2)!;
    expect(cw.reversed).toBe(true);
    close(cw.start, [0, -2]);
    close(cw.end, [2, 0]);
    expect(centerArc([0, 0], [0, 0], 1)).toBeNull();
    expect(centerArc([0, 0], [1, 0], 0)).toBeNull();
  });

  it('gives the outward tangent at the ends of lines and arcs', () => {
    const l = line([0, 0], [2, 0]);
    close(outwardTangent(l, 'end')!, [1, 0]);
    close(outwardTangent(l, 'start')!, [-1, 0]);
    // A quarter arc from (1,0) to (0,1): leaves its end heading -x.
    const a = arc([0, 0], [1, 0], [0, 1]);
    close(outwardTangent(a, 'end')!, [-1, 0]);
    close(outwardTangent(a, 'start')!, [0, -1]);
  });

  it('finds the nearest point on an arc, falling back to an end outside its sweep', () => {
    const a = arc([0, 0], [1, 0], [0, 1]);
    close(closestOnEntity(a, [2, 2]), [Math.SQRT1_2, Math.SQRT1_2]);
    close(closestOnEntity(a, [-1, -0.2]), [0, 1]);
    close(closestOnEntity(a, [-0.2, -1]), [1, 0]);
    close(closestOnEntity(a, [-2, 0.1]), [0, 1]);
    expect(arcContainsAngle(a, Math.PI / 4)).toBe(true);
    expect(arcContainsAngle(a, Math.PI)).toBe(false);
  });

  it('clamps the nearest point on a line segment to its ends', () => {
    const l = line([0, 0], [2, 0]);
    close(closestOnEntity(l, [1, 3]), [1, 0]);
    close(closestOnEntity(l, [-5, 1]), [0, 0]);
  });

  it('resolves point references, including the sketch origin', () => {
    const idx = indexEntities([line([1, 2], [3, 4], 'e1')]);
    expect(pointPosition(idx, { entity: 'e1', at: 'end' })).toEqual([3, 4]);
    expect(pointPosition(idx, { entity: '@origin' })).toEqual([0, 0]);
    expect(pointPosition(idx, { entity: 'e1', at: 'center' })).toBeNull();
    expect(pointPosition(idx, { entity: 'nope', at: 'start' })).toBeNull();
  });

  it('tessellates arcs from their exact ends', () => {
    const a = arc([0, 0], [1, 0], [-1, 0]);
    const pts = tessellate(a);
    expect(pts[0]).toEqual([1, 0]);
    expect(pts.at(-1)).toEqual([-1, 0]);
    for (const p of pts) expect(distance(p, [0, 0])).toBeCloseTo(1, 9);
    expect(wrapDelta(3 * Math.PI)).toBeCloseTo(Math.PI, 12);
  });
});
