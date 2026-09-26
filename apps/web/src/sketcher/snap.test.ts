import type { ArcEntity, LineEntity, SketchEntity, Vec2 } from '@manufakture/sketch/model';
import { describe, expect, it } from 'vitest';
import { indexEntities } from './geometry';
import { inferFromAnchor, nearestVertex, snapCursor, type PickPoint } from './snap';

const line = (id: string, start: Vec2, end: Vec2): LineEntity => ({
  id,
  kind: 'line',
  construction: false,
  start,
  end,
});

const entities: SketchEntity[] = [
  line('e1', [0, 0], [10, 0]),
  line('e2', [10, 0], [10, 10]),
  { id: 'e3', kind: 'circle', construction: false, center: [30, 30], radius: 5 },
];
const options = { tolerance: 1 };

describe('snapping', () => {
  it('snaps to the nearest vertex, preferring sketch geometry over the origin', () => {
    // e1's start and the origin are the same place: the entity wins.
    expect(nearestVertex(entities, [0.2, 0.1], 1)?.ref).toEqual({ entity: 'e1', at: 'start' });
    expect(nearestVertex([], [0.2, 0.1], 1)?.ref).toEqual({ entity: '@origin' });
    // The closer of two candidates wins.
    expect(nearestVertex(entities, [10.1, 0.3], 1)?.ref).toEqual({ entity: 'e1', at: 'end' });
    expect(nearestVertex(entities, [30.4, 30], 1)?.ref).toEqual({ entity: 'e3', at: 'center' });
    expect(nearestVertex(entities, [5, 5], 1)).toBeNull();
    expect(nearestVertex(entities, [30, 30], 1, new Set(['e3']))).toBeNull();
  });

  it('snaps to a point before a curve, to a curve before an axis', () => {
    const onPoint = snapCursor(entities, [9.6, 0.2], options);
    expect(onPoint.target).toEqual({ kind: 'point', ref: { entity: 'e1', at: 'end' } });
    expect(onPoint.position).toEqual([10, 0]);

    const onLine = snapCursor(entities, [5, 0.3], options);
    expect(onLine.target).toEqual({ kind: 'curve', entity: 'e1' });
    expect(onLine.position).toEqual([5, 0]);

    const onCircle = snapCursor(entities, [35.5, 30], options);
    expect(onCircle.target).toEqual({ kind: 'curve', entity: 'e3' });
    expect(onCircle.position[0]).toBeCloseTo(35, 12);

    const onAxis = snapCursor(entities, [-20, 0.5], options);
    expect(onAxis.target).toEqual({ kind: 'curve', entity: '@x-axis' });
    expect(onAxis.position).toEqual([-20, 0]);
    expect(snapCursor(entities, [0.4, -20], options).target).toEqual({
      kind: 'curve',
      entity: '@y-axis',
    });

    expect(snapCursor(entities, [20, 20], options).target).toBeNull();
    expect(snapCursor(entities, [5, 0.3], { ...options, curves: false }).target).toBeNull();
  });

  it('does nothing while the suppress modifier is held', () => {
    const p = snapCursor(entities, [9.9, 0.1], { ...options, suppress: true });
    expect(p).toEqual({ position: [9.9, 0.1], target: null });
  });
});

describe('inference from the anchor', () => {
  const idx = indexEntities(entities);
  const anchor: PickPoint = { position: [20, 20], target: null };
  const free = (p: Vec2): PickPoint => ({ position: p, target: null });

  it('straightens a nearly horizontal or vertical segment and marks it', () => {
    const h = inferFromAnchor(free([40, 21]), anchor, idx, options);
    expect(h).toMatchObject({ position: [40, 20], horizontal: true });
    const v = inferFromAnchor(free([20.5, 0]), anchor, idx, options);
    expect(v).toMatchObject({ position: [20, 0], vertical: true });
    // Leftwards and downwards count too.
    expect(inferFromAnchor(free([0, 20.9]), anchor, idx, options).horizontal).toBe(true);
    // Beyond the angle limit nothing is inferred.
    const diagonal = inferFromAnchor(free([40, 25]), anchor, idx, options);
    expect(diagonal).toEqual(free([40, 25]));
  });

  it('does not infer from a segment shorter than the tolerance, or while suppressed', () => {
    expect(inferFromAnchor(free([20.5, 20.01]), anchor, idx, options).horizontal).toBeUndefined();
    const suppressed = inferFromAnchor(free([40, 21]), anchor, idx, { ...options, suppress: true });
    expect(suppressed.horizontal).toBeUndefined();
  });

  it('keeps a point snap where it is, inferring only exact alignment', () => {
    const pinned: PickPoint = {
      position: [10, 20],
      target: { kind: 'point', ref: { entity: 'x', at: 'end' } },
    };
    expect(inferFromAnchor(pinned, anchor, idx, options)).toMatchObject({
      position: [10, 20],
      horizontal: true,
    });
    const off = { ...pinned, position: [10, 20.5] as Vec2 };
    expect(inferFromAnchor(off, anchor, idx, options).horizontal).toBeUndefined();
  });

  it('drops a curve snap that straightening moved the point off', () => {
    const snapped: PickPoint = { position: [40, 21], target: { kind: 'curve', entity: 'e9' } };
    const r = inferFromAnchor(snapped, anchor, idx, options);
    expect(r.target).toBeNull();
    expect(r.horizontal).toBe(true);
  });

  it('infers a tangent when a line leaves the end of an arc along it', () => {
    // A quarter arc from (1,0) to (0,1) about the origin ends heading -x.
    const a: ArcEntity = {
      id: 'a1',
      kind: 'arc',
      construction: false,
      center: [0, 0],
      start: [1, 0],
      end: [0, 1],
    };
    const index = indexEntities([a]);
    const fromEnd: PickPoint = {
      position: [0, 1],
      target: { kind: 'point', ref: { entity: 'a1', at: 'end' } },
    };
    const r = inferFromAnchor(free([-5, 1.2]), fromEnd, index, options);
    expect(r.tangent).toEqual({ entity: 'a1', at: 'end' });
    expect(r.position[1]).toBeCloseTo(1, 12);
    expect(r.horizontal).toBeUndefined();
    // Well off the tangent: no tangency.
    expect(inferFromAnchor(free([-5, 4]), fromEnd, index, options).tangent).toBeUndefined();
  });
});
