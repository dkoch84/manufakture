import type { SketchConstraint, SketchEntity } from '@manufakture/sketch/model';
import { describe, expect, it } from 'vitest';
import { constraintGlyphs, constraintsFromSelection } from './constraints';
import { indexEntities } from './geometry';
import type { SketchItem } from './items';

const entities: SketchEntity[] = [
  { id: 'e1', kind: 'line', construction: false, start: [0, 0], end: [10, 0] },
  { id: 'e2', kind: 'line', construction: false, start: [10, 0], end: [10, 6] },
  { id: 'e3', kind: 'circle', construction: false, center: [5, 5], radius: 2 },
  { id: 'e4', kind: 'arc', construction: false, center: [0, 5], start: [2, 5], end: [0, 7] },
  { id: 'e5', kind: 'point', construction: false, position: [3, 3] },
];
const idx = indexEntities(entities);
const entity = (id: string): SketchItem => ({ kind: 'entity', id });
const point = (id: string, at?: 'start' | 'end' | 'center'): SketchItem => ({
  kind: 'point',
  ref: at ? { entity: id, at } : { entity: id },
});

describe('constraints from the selection', () => {
  it('makes horizontal and vertical from lines or from two points', () => {
    expect(constraintsFromSelection('horizontal', [entity('e1'), entity('e2')], idx)).toEqual([
      { kind: 'horizontal', line: 'e1' },
      { kind: 'horizontal', line: 'e2' },
    ]);
    expect(constraintsFromSelection('vertical', [point('e1', 'start'), point('e5')], idx)).toEqual([
      { kind: 'vertical', a: { entity: 'e1', at: 'start' }, b: { entity: 'e5' } },
    ]);
    // A line mixed with a point fits neither form; the axes cannot be made horizontal.
    expect(constraintsFromSelection('horizontal', [entity('e1'), point('e5')], idx)).toEqual([]);
    expect(constraintsFromSelection('horizontal', [entity('@x-axis')], idx)).toEqual([]);
  });

  it('makes a coincidence from two points and point-on-curve from a point and a curve', () => {
    expect(
      constraintsFromSelection('coincident', [point('e1', 'end'), point('@origin')], idx),
    ).toEqual([{ kind: 'coincident', a: { entity: 'e1', at: 'end' }, b: { entity: '@origin' } }]);
    // A point entity picked as an entity counts as a point.
    expect(constraintsFromSelection('coincident', [entity('e5'), entity('e3')], idx)).toEqual([
      { kind: 'pointOnObject', point: { entity: 'e5' }, on: 'e3' },
    ]);
    expect(constraintsFromSelection('coincident', [point('e5')], idx)).toEqual([]);
  });

  it('pairs curves for parallel, perpendicular, equal and tangent', () => {
    expect(constraintsFromSelection('perpendicular', [entity('e1'), entity('e2')], idx)).toEqual([
      { kind: 'perpendicular', a: 'e1', b: 'e2' },
    ]);
    expect(constraintsFromSelection('parallel', [entity('e1'), entity('@y-axis')], idx)).toEqual([
      { kind: 'parallel', a: 'e1', b: '@y-axis' },
    ]);
    expect(constraintsFromSelection('equal', [entity('e3'), entity('e4')], idx)).toEqual([
      { kind: 'equal', a: 'e3', b: 'e4' },
    ]);
    expect(constraintsFromSelection('equal', [entity('e1'), entity('e3')], idx)).toEqual([]);
    expect(constraintsFromSelection('tangent', [entity('e1'), entity('e3')], idx)).toEqual([
      { kind: 'tangent', a: 'e1', b: 'e3' },
    ]);
    expect(constraintsFromSelection('tangent', [entity('e1'), entity('e2')], idx)).toEqual([]);
  });

  it('makes midpoint and fix from points', () => {
    expect(constraintsFromSelection('midpoint', [point('e5'), entity('e1')], idx)).toEqual([
      { kind: 'midpoint', point: { entity: 'e5' }, line: 'e1' },
    ]);
    expect(constraintsFromSelection('fix', [point('e1', 'end'), point('e5')], idx)).toEqual([
      { kind: 'fix', point: { entity: 'e1', at: 'end' } },
      { kind: 'fix', point: { entity: 'e5' } },
    ]);
    expect(constraintsFromSelection('fix', [entity('e1')], idx)).toEqual([]);
  });
});

describe('constraint glyphs', () => {
  it('places glyphs by their geometry and stacks the ones that share a place', () => {
    const constraints: SketchConstraint[] = [
      { id: 'k1', kind: 'horizontal', line: 'e1' },
      {
        id: 'k2',
        kind: 'coincident',
        a: { entity: 'e1', at: 'end' },
        b: { entity: 'e2', at: 'start' },
      },
      { id: 'k3', kind: 'fix', point: { entity: 'e2', at: 'start' } },
      { id: 'k4', kind: 'perpendicular', a: 'e1', b: 'e2' },
      {
        id: 'k5',
        kind: 'distance',
        a: { entity: 'e1', at: 'start' },
        b: { entity: 'e1', at: 'end' },
        value: { source: '10', lengthUnit: 'mm', angleUnit: 'deg' },
      },
    ];
    const glyphs = constraintGlyphs(constraints, idx);
    expect(glyphs.map((g) => [g.constraintId, g.anchor, g.slot])).toEqual([
      ['k1', [5, 0], 0],
      ['k2', [10, 0], 0],
      ['k3', [10, 0], 1],
      ['k4', [5, 0], 1],
      ['k4', [10, 3], 0],
    ]);
    expect(glyphs[0]!.symbol).toBe('H');
  });
});
