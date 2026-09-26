import { describe, expect, it } from 'vitest';
import { meshProperties, mergeMeshes, weld } from './mesh';
import { boxMesh, soupOf } from './test-helpers';

describe('weld', () => {
  it('turns a triangle soup back into shared vertices, keeping the winding', () => {
    const box = boxMesh();
    const soup = soupOf(box);
    expect(soup.positions.length / 3).toBe(36);
    const welded = weld(soup);
    expect(welded.positions.length / 3).toBe(8);
    expect(welded.indices.length).toBe(36);
    expect(meshProperties(welded).volume).toBeCloseTo(1, 6);
  });

  it('merges points within the tolerance, also across a cell boundary, and not beyond it', () => {
    const tri = (dz: number) => ({
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, dz, 1, 0, 0, 0, 1, 0]),
      indices: new Uint32Array([0, 1, 2, 3, 4, 5]),
    });
    // 0 and -0.00005 lie in different 1e-4 grid cells.
    expect(weld(tri(-0.00005)).positions.length / 3).toBe(3);
    expect(weld(tri(0.0002)).positions.length / 3).toBe(4);
    expect(weld(tri(0.0002), { tolerance: 0.001 }).positions.length / 3).toBe(3);
    expect(() => weld(tri(0), { tolerance: 0 })).toThrow(RangeError);
  });

  it('drops triangles that welding collapses', () => {
    const sliver = {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 0.00001, 0]),
      indices: new Uint32Array([0, 1, 2]),
    };
    expect(weld(sliver).indices.length).toBe(0);
  });
});

describe('mergeMeshes and meshProperties', () => {
  it('merges with shifted indices, and sums volumes', () => {
    const a = boxMesh([0, 0, 0], [1, 2, 3]);
    const b = boxMesh([10, 0, 0], [2, 2, 2]);
    const m = mergeMeshes([a, b]);
    expect(m.positions.length / 3).toBe(16);
    expect(Math.max(...m.indices)).toBe(15);
    const p = meshProperties(m);
    expect(p.volume).toBeCloseTo(6 + 8, 6);
    expect(p.triangles).toBe(24);
  });

  it('gives volume, area, centre of mass and bounding box of a box', () => {
    const p = meshProperties(boxMesh([1, 2, 3], [4, 5, 6]));
    expect(p.volume).toBeCloseTo(120, 6);
    expect(p.area).toBeCloseTo(2 * (20 + 30 + 24), 6);
    p.centerOfMass!.forEach((v, i) => expect(v).toBeCloseTo([3, 4.5, 6][i]!, 6));
    expect(p.boundingBox).toEqual({ min: [1, 2, 3], max: [5, 7, 9] });
  });

  it('keeps its precision far from the origin', () => {
    const p = meshProperties(boxMesh([10_000, 10_000, 10_000], [1, 1, 1]));
    expect(p.volume).toBeCloseTo(1, 3);
  });

  it('an empty mesh has nothing', () => {
    const p = meshProperties({ positions: new Float32Array(), indices: new Uint32Array() });
    expect(p).toMatchObject({ volume: 0, area: 0, centerOfMass: null, boundingBox: null });
  });
});
