// Builds the two meshes, checks their sizes, and caches them for the other probes and the worker.

import { describe, expect, it } from 'vitest';
import { bounds, triangleCount } from './geometry.ts';
import { buildMeshes, readCached } from './meshes.ts';
import { round, writeResult } from './results.ts';

describe('meshes', () => {
  it('builds the bracket and a filleted part near 100k triangles', async () => {
    const t0 = performance.now();
    const meshes = await buildMeshes();
    const ms = performance.now() - t0;
    const { bracket, filleted } = meshes;
    expect(triangleCount(bracket)).toBeGreaterThan(1000);
    expect(triangleCount(filleted)).toBeGreaterThan(80_000);
    expect(triangleCount(filleted)).toBeLessThan(130_000);
    const cached = readCached('filleted')!;
    expect(cached.indices).toEqual(filleted.indices);
    writeResult('meshes', {
      buildMs: round(ms),
      meshes: Object.values(meshes).map((m) => ({
        name: m.name,
        triangles: triangleCount(m),
        vertices: m.positions.length / 3,
        bounds: bounds(m),
      })),
    });
  });
});
