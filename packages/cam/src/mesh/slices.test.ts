import { describe, expect, it } from 'vitest';
import { flattenSegments } from '../offset/flatten';
import { pointInLoops } from '../offset/geometry';
import type { Vec2 } from '../types';
import { DropCutter } from './dropcutter';
import { heightGrid, polygonArea, simplifyClosed, superLevelLoops } from './slices';
import { distToInner, filletedBlock, filletedBlockTop, type FilletedBlock } from './test-meshes';

const BLOCK: FilletedBlock = {
  x0: 0,
  y0: 0,
  x1: 40,
  y1: 30,
  bottom: -10,
  top: 0,
  radius: 5,
  segments: 16,
};

async function slices(cell: number, simplify: number) {
  const mesh = filletedBlock(BLOCK);
  const reach = cell * Math.SQRT2 + simplify;
  const grid = await heightGrid(
    new DropCutter(mesh, { kind: 'flat', radius: reach }),
    { minX: -reach, minY: -reach, maxX: 40 + reach, maxY: 30 + reach },
    cell,
    -1000,
  );
  if (!grid) throw new Error('grid too large');
  return { grid, reach };
}

describe('z-level slices', () => {
  it('contain every point with material above the level, and little more', async () => {
    const cell = 0.25;
    const simplify = 0.02;
    const { grid, reach } = await slices(cell, simplify);
    for (const level of [-9, -5, -2, -0.5]) {
      const loops = superLevelLoops(grid, level, simplify);
      expect(loops.length).toBe(1);
      expect(polygonArea(loops[0]!.segments.map((s) => s.start))).toBeGreaterThan(0);
      const polys = loops.map((l) => flattenSegments(l.segments, true, 0.001));
      // The slice's true outline: where the top surface is above the level.
      const d = Math.sqrt(BLOCK.radius ** 2 - Math.max(0, level - (BLOCK.top - BLOCK.radius)) ** 2);
      for (let x = -2; x <= 42; x += 0.37) {
        for (let y = -2; y <= 32; y += 0.41) {
          const inner = distToInner(BLOCK, x, y);
          const p: Vec2 = [x, y];
          if (filletedBlockTop(BLOCK, x, y) > level) expect(pointInLoops(p, polys)).toBe(true);
          // Nothing further out than the reach plus a cell (the interpolation).
          if (inner > d + reach + cell) expect(pointInLoops(p, polys)).toBe(false);
        }
      }
    }
  });

  it('are nested as the level falls', async () => {
    const { grid } = await slices(0.5, 0.02);
    const high = superLevelLoops(grid, -1, 0.02);
    const low = superLevelLoops(grid, -3, 0.02);
    const lowPolys = low.map((l) => flattenSegments(l.segments, true, 0.001));
    for (const loop of high)
      for (const s of loop.segments) expect(pointInLoops(s.start, lowPolys)).toBe(true);
  });

  it('give nothing above the part', async () => {
    const { grid } = await slices(0.5, 0.02);
    expect(superLevelLoops(grid, 0.001, 0.02)).toEqual([]);
  });

  it('trace holes clockwise', async () => {
    // A frame: a 20 x 20 square plate with a 10 x 10 hole, as triangles at z = 1.
    const quad = (x0: number, y0: number, x1: number, y1: number) => [
      [x0, y0, 1, x1, y0, 1, x1, y1, 1],
      [x0, y0, 1, x1, y1, 1, x0, y1, 1],
    ];
    const tris = [
      ...quad(0, 0, 20, 5),
      ...quad(0, 15, 20, 20),
      ...quad(0, 5, 5, 15),
      ...quad(15, 5, 20, 15),
    ];
    const mesh = {
      positions: Float32Array.from(tris.flat()),
      indices: Uint32Array.from(tris.flatMap((_, i) => [i * 3, i * 3 + 1, i * 3 + 2])),
    };
    const grid = await heightGrid(
      new DropCutter(mesh, { kind: 'flat', radius: 0.3 }),
      { minX: -1, minY: -1, maxX: 21, maxY: 21 },
      0.2,
      -100,
    );
    const loops = superLevelLoops(grid!, 0, 0.01);
    expect(loops).toHaveLength(2);
    const areas = loops
      .map((l) => polygonArea(l.segments.map((s) => s.start)))
      .sort((a, b) => a - b);
    expect(areas[0]).toBeLessThan(0);
    expect(areas[1]).toBeGreaterThan(0);
  });

  it('simplify a closed polygon within the tolerance', () => {
    const pts: Vec2[] = Array.from({ length: 400 }, (_, k) => {
      const a = (k / 400) * 2 * Math.PI;
      return [10 * Math.cos(a), 10 * Math.sin(a)];
    });
    const simple = simplifyClosed(pts, 0.01);
    expect(simple.length).toBeLessThan(200);
    expect(simple.length).toBeGreaterThan(8);
    // Every dropped point within the tolerance of the simplified polygon.
    for (const p of pts) {
      let best = Infinity;
      for (let i = 0; i < simple.length; i++) {
        const a = simple[i]!;
        const b = simple[(i + 1) % simple.length]!;
        const dx = b[0] - a[0];
        const dy = b[1] - a[1];
        const t = Math.min(
          1,
          Math.max(0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)),
        );
        best = Math.min(best, Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy));
      }
      expect(best).toBeLessThanOrEqual(0.01 + 1e-12);
    }
  });
});
