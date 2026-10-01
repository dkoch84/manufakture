import { threadSize } from '@manufakture/kernel';
import { describe, expect, it } from 'vitest';
import type { BodyInput } from '../viewport/bodies';
import {
  bestSize,
  cylinderLabel,
  pickedCylinder,
  sizeFits,
  sizeLabel,
  threadSizesFor,
} from './threads';

const M6 = threadSize('iso-metric', 'M6')!;

/** A body with two named faces: a cylinder (a hole when `hole`) and a plane. */
function body(radius: number, hole: boolean): BodyInput {
  return {
    id: 'part#1/extrude#1',
    names: ['extrude#1:side:e5', 'extrude#1:cap:end'],
    mesh: { faceNames: new Uint32Array([0, 1]), edgeNames: new Uint32Array() },
    topology: {
      faces: [
        {
          index: 1,
          surface: 'cylinder',
          centroid: [0, 0, 0],
          area: 1,
          normal: null,
          axis: [0, 0, 1],
          radius,
          axisOrigin: [0, 0, 0],
          hole,
        },
        {
          index: 2,
          surface: 'plane',
          centroid: [0, 0, 0],
          area: 1,
          normal: [0, 0, 1],
          axis: null,
          radius: null,
        },
      ],
      edges: [],
      vertices: [],
    },
  } as unknown as BodyInput;
}

describe('the picked cylinder', () => {
  it('is a shaft or a hole, by the side of the material', () => {
    expect(pickedCylinder([body(3, false)], 'extrude#1:side:e5')).toEqual({
      side: 'external',
      radius: 3,
    });
    expect(pickedCylinder([body(2.5, true)], 'extrude#1:side:e5')).toEqual({
      side: 'internal',
      radius: 2.5,
    });
    expect(pickedCylinder([body(3, false)], 'extrude#1:cap:end')).toBeNull();
    expect(pickedCylinder([body(3, false)], 'extrude#9:side:e1')).toBeNull();
    expect(cylinderLabel({ side: 'internal', radius: 2.5 })).toBe('A hole 5 mm across');
  });
});

describe('sizes for a cylinder', () => {
  it('lists only the sizes that can be cut into it with the clearance', () => {
    const shaft = { side: 'external' as const, radius: 3 };
    const sizes = threadSizesFor('iso-metric', shaft, 0.2).map((s) => s.size);
    expect(sizes).toContain('M6');
    expect(sizes).not.toContain('M3');
    expect(sizes).not.toContain('M10');
    expect(threadSizesFor('iso-metric', null, 0.2)).toHaveLength(14);
    expect(sizeFits(M6, { side: 'external', radius: 5 }, 0.2)).toBe(false);
  });

  it('starts from the size the cylinder was most likely made for', () => {
    expect(bestSize('iso-metric', { side: 'external', radius: 3 }, 0.2)?.size).toBe('M6');
    // A hole at the tap drill, or at the minor diameter.
    expect(bestSize('iso-metric', { side: 'internal', radius: 2.5 }, 0.2)?.size).toBe('M6');
    expect(bestSize('iso-metric', { side: 'internal', radius: M6.minor / 2 }, 0.2)?.size).toBe(
      'M6',
    );
    expect(bestSize('unc', { side: 'external', radius: 3.175 }, 0.2)?.size).toBe('1/4-20');
    expect(bestSize('iso-metric', { side: 'external', radius: 0.5 }, 0.2)).toBeUndefined();
    expect(sizeLabel(M6)).toBe('M6 x 1');
    expect(sizeLabel(threadSize('unc', '#10')!)).toBe('#10-24');
  });
});
