import { describe, expect, it } from 'vitest';
import { checkManifold } from './manifold';
import type { TriMesh } from './mesh';
import { boxMesh, soupOf } from './test-helpers';

const withIndices = (m: TriMesh, indices: number[]): TriMesh => ({
  positions: m.positions,
  indices: new Uint32Array(indices),
});

describe('checkManifold', () => {
  it('accepts a closed, outward box', () => {
    const r = checkManifold(boxMesh());
    expect(r).toMatchObject({
      ok: true,
      triangles: 12,
      edges: 18,
      boundaryEdges: 0,
      nonManifoldEdges: 0,
      inconsistentEdges: 0,
      degenerateTriangles: 0,
      problems: [],
    });
    expect(r.volume).toBeCloseTo(1, 6);
  });

  it('finds a hole', () => {
    const box = boxMesh();
    const r = checkManifold(withIndices(box, [...box.indices].slice(3)));
    expect(r.ok).toBe(false);
    expect(r.boundaryEdges).toBe(3);
    expect(r.problems[0]).toMatch(/3 open edge/);
  });

  it('finds a triangle wound the wrong way', () => {
    const box = boxMesh();
    const idx = [...box.indices];
    [idx[1], idx[2]] = [idx[2]!, idx[1]!];
    const r = checkManifold(withIndices(box, idx));
    expect(r.ok).toBe(false);
    expect(r.inconsistentEdges).toBe(3);
  });

  it('finds an edge shared by more than two triangles', () => {
    const box = boxMesh();
    const r = checkManifold(withIndices(box, [...box.indices, 0, 2, 1]));
    expect(r.nonManifoldEdges).toBe(3);
    expect(r.ok).toBe(false);
  });

  it('finds a mesh that is inside out', () => {
    const box = boxMesh();
    const idx = [...box.indices];
    for (let t = 0; t < idx.length; t += 3) [idx[t + 1], idx[t + 2]] = [idx[t + 2]!, idx[t + 1]!];
    const r = checkManifold(withIndices(box, idx));
    expect(r.inconsistentEdges).toBe(0);
    expect(r.volume).toBeCloseTo(-1, 6);
    expect(r.problems).toEqual(['the triangles face inward (volume <= 0)']);
  });

  it('finds degenerate triangles: a repeated corner, and zero area', () => {
    const box = boxMesh();
    expect(checkManifold(withIndices(box, [...box.indices, 0, 0, 1])).degenerateTriangles).toBe(1);
    const line: TriMesh = {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 2, 0, 0]),
      indices: new Uint32Array([0, 1, 2]),
    };
    expect(checkManifold(line).degenerateTriangles).toBe(1);
  });

  it('an unwelded soup is all open edges', () => {
    const r = checkManifold(soupOf(boxMesh()));
    expect(r.boundaryEdges).toBe(36);
    expect(r.ok).toBe(false);
  });

  it('an empty mesh is not ok', () => {
    const r = checkManifold({ positions: new Float32Array(), indices: new Uint32Array() });
    expect(r.ok).toBe(false);
    expect(r.problems).toContain('the mesh has no triangles');
  });
});
