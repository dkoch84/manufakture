import type { LineEntity, SketchEntity, Vec2 } from '@manufakture/sketch/model';
import { describe, expect, it } from 'vitest';
import { layoutDimension, measureDimension, proposeDimension } from './dimension';
import { indexEntities } from './geometry';

const line = (id: string, start: Vec2, end: Vec2): LineEntity => ({
  id,
  kind: 'line',
  construction: false,
  start,
  end,
});

const entities: SketchEntity[] = [
  line('e1', [0, 0], [10, 0]),
  line('e2', [10, 0], [10, 5]),
  line('e3', [0, 3], [10, 3]), // parallel to e1, 3 above
  line('e4', [0, 0], [5, 5]), // 45 degrees
  { id: 'e5', kind: 'circle', construction: false, center: [20, 0], radius: 2 },
  { id: 'e6', kind: 'arc', construction: false, center: [0, 20], start: [3, 20], end: [0, 23] },
];
const idx = indexEntities(entities);
const curve = (entity: string) => ({ kind: 'curve' as const, entity });
const point = (entity: string, at?: 'start' | 'end' | 'center') => ({
  kind: 'point' as const,
  ref: at ? { entity, at } : { entity },
});

describe('proposing a dimension', () => {
  it('gives a line its length, a circle its diameter, an arc its radius', () => {
    expect(proposeDimension([curve('e1')], idx)).toEqual({
      constraint: {
        kind: 'distance',
        a: { entity: 'e1', at: 'start' },
        b: { entity: 'e1', at: 'end' },
      },
      measured: 10,
      kind: 'length',
    });
    expect(proposeDimension([curve('e5')], idx)).toMatchObject({
      constraint: { kind: 'diameter', entity: 'e5' },
      measured: 4,
    });
    expect(proposeDimension([curve('e6')], idx)).toMatchObject({
      constraint: { kind: 'radius', entity: 'e6' },
      measured: 3,
    });
    expect(proposeDimension([point('e1', 'end')], idx)).toBeNull();
  });

  it('measures between two points, and a circle picked with a point stands for its centre', () => {
    expect(proposeDimension([point('e1', 'start'), point('e2', 'end')], idx)).toMatchObject({
      constraint: {
        kind: 'distance',
        a: { entity: 'e1', at: 'start' },
        b: { entity: 'e2', at: 'end' },
      },
      measured: Math.hypot(10, 5),
    });
    expect(proposeDimension([point('@origin'), curve('e5')], idx)).toMatchObject({
      constraint: { kind: 'distance', a: { entity: '@origin' }, b: { entity: 'e5', at: 'center' } },
      measured: 20,
    });
    // Coincident points have no distance to dimension.
    expect(proposeDimension([point('e1', 'end'), point('e2', 'start')], idx)).toBeNull();
  });

  it('measures a point to a line along the normal, in either pick order', () => {
    const expected = {
      constraint: { kind: 'distance', point: { entity: 'e2', at: 'end' }, line: 'e1' },
      measured: 5,
    };
    expect(proposeDimension([point('e2', 'end'), curve('e1')], idx)).toMatchObject(expected);
    expect(proposeDimension([curve('e1'), point('e2', 'end')], idx)).toMatchObject(expected);
    // To an axis.
    expect(proposeDimension([point('e2', 'end'), curve('@y-axis')], idx)).toMatchObject({
      measured: 10,
    });
  });

  it('gives parallel lines their distance and others the smaller angle', () => {
    expect(proposeDimension([curve('e1'), curve('e3')], idx)).toMatchObject({
      constraint: { kind: 'distance', point: { entity: 'e1', at: 'start' }, line: 'e3' },
      measured: 3,
    });
    const a = proposeDimension([curve('e1'), curve('e4')], idx)!;
    expect(a.constraint).toEqual({ kind: 'angle', a: 'e1', b: 'e4' });
    expect(a.measured).toBeCloseTo(Math.PI / 4, 12);
    // Picked the other way round the angle would be 315 degrees: the lines are swapped instead.
    const b = proposeDimension([curve('e4'), curve('e1')], idx)!;
    expect(b.constraint).toEqual({ kind: 'angle', a: 'e1', b: 'e4' });
    expect(b.measured).toBeCloseTo(Math.PI / 4, 12);
    expect(proposeDimension([curve('e1'), curve('e1')], idx)).toBeNull();
  });
});

describe('measuring and laying out a dimension', () => {
  it('measures what a constraint constrains', () => {
    expect(
      measureDimension(
        {
          kind: 'horizontalDistance',
          a: { entity: 'e4', at: 'end' },
          b: { entity: 'e1', at: 'start' },
        },
        idx,
      ),
    ).toBe(-5);
    expect(measureDimension({ kind: 'diameter', entity: 'e6' }, idx)).toBeCloseTo(6, 12);
    expect(measureDimension({ kind: 'angle', a: 'e1', b: 'e2' }, idx)).toBeCloseTo(Math.PI / 2, 12);
    expect(measureDimension({ kind: 'radius', entity: 'nope' }, idx)).toBeNull();
  });

  it('offsets a length dimension to the side, or through the label the user placed', () => {
    const c = {
      kind: 'distance',
      a: { entity: 'e1', at: 'start' },
      b: { entity: 'e1', at: 'end' },
    } as const;
    const byDefault = layoutDimension(c, idx, 2)!;
    // Left of the direction from start to end, i.e. above the line.
    expect(byDefault.label).toEqual([5, 2]);
    expect(byDefault.lines[2]).toEqual([
      [0, 2],
      [10, 2],
    ]);
    const placed = layoutDimension(c, idx, 2, [4, -3])!;
    expect(placed.label).toEqual([4, -3]);
    expect(placed.lines[2]).toEqual([
      [0, -3],
      [10, -3],
    ]);
    // A label past the end extends the dimension line to it.
    const beyond = layoutDimension(c, idx, 2, [14, -3])!;
    expect(beyond.lines).toHaveLength(4);
    expect(beyond.arrows).toHaveLength(2);
  });

  it('points a radius at the label and puts an angle arc at the vertex', () => {
    const r = layoutDimension({ kind: 'radius', entity: 'e5' }, idx, 2, [30, 0])!;
    expect(r.lines[0]).toEqual([
      [20, 0],
      [22, 0],
    ]);
    const a = layoutDimension({ kind: 'angle', a: 'e1', b: 'e4' }, idx, 2)!;
    const arc = a.lines[0]!;
    expect(Math.hypot(...arc[0]!)).toBeCloseTo(3, 9);
    expect(arc.at(-1)![0]).toBeCloseTo(arc.at(-1)![1], 9); // ends on the 45 degree line
  });
});
