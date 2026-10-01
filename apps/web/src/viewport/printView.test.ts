// The print workspace's additions to the viewport: the build volume's lines and the per-vertex
// thickness the heat map shades with.

import { describe, expect, it } from 'vitest';
import { findPrinter } from '@manufakture/print';
import {
  buildVolumeBounds,
  buildVolumeSegments,
  createOverhangMaterial,
  createThicknessMaterial,
  thicknessAttribute,
  vertexThickness,
} from './printView';

describe('build volume', () => {
  it('draws the plate outline, the top and the uprights, and crosses out the excluded corner', () => {
    const x1c = findPrinter('bambu-x1c')!;
    const volume = {
      area: x1c.area,
      height: x1c.height,
      excluded: x1c.excluded.map((e) => e.polygon),
    };
    const { frame, excluded } = buildVolumeSegments(volume);
    // 4 edges at the bed, 4 at the top, 4 uprights; 6 floats per segment.
    expect(frame.length).toBe(12 * 6);
    expect([...frame.slice(0, 6)]).toEqual([0, 0, 0, 256, 0, 0]);
    expect([...frame.slice(24, 30)]).toEqual([0, 0, 250, 256, 0, 250]);
    // The 18 x 28 corner: its outline and both diagonals.
    expect(excluded.length).toBe(6 * 6);
    expect([...excluded.slice(24, 30)]).toEqual([0, 0, 0, 18, 28, 0]);
    expect(buildVolumeBounds(volume)).toEqual({ min: [0, 0, 0], max: [256, 256, 250] });
    expect(buildVolumeBounds({ area: [], height: 1, excluded: [] })).toBeNull();
  });
});

describe('thickness per vertex', () => {
  it('takes the thinnest triangle of each vertex, and far for none or nothing in range', () => {
    // Two triangles sharing vertices 1 and 2; vertex 4 is used by none.
    const indices = [0, 1, 2, 1, 3, 2];
    const values = vertexThickness(indices, 5, [0.5, 2]);
    expect([...values]).toEqual([0.5, 0.5, 0.5, 2, 1e6]);
    expect([...vertexThickness(indices, 4, [Infinity, 3])]).toEqual([1e6, 3, 3, 3]);
    expect(thicknessAttribute(indices, 4, undefined).array).toEqual(new Float32Array(4).fill(1e6));
  });

  it('makes shading materials that clip with the section plane', () => {
    const planes: never[] = [];
    for (const m of [createOverhangMaterial(planes), createThicknessMaterial(planes)]) {
      expect(m.clipping).toBe(true);
      expect(m.clippingPlanes).toBe(planes);
      expect(m.vertexColors).toBe(true);
    }
  });
});
