import { placementMatrix } from '@manufakture/io';
import { UNNAMED } from '@manufakture/kernel/types';
import { describe, expect, it } from 'vitest';
import { transformPoint } from '../viewport/bodies';
import { assemblyBundle, boxBundle } from './bundles.test-fixture';
import { openBundle } from './load';
import { boundsOf, matrixToTransform, toMeshData, viewerBodies } from './scene';

describe('toMeshData', () => {
  it('rebuilds per-triangle faces and a name table from the string names', () => {
    const { mesh, names } = toMeshData({
      positions: new Float32Array(12),
      normals: new Float32Array(12),
      indices: new Uint32Array([0, 1, 2, 0, 2, 3, 1, 2, 3]),
      faceRanges: new Uint32Array([0, 6, 6, 3]),
      edgePositions: new Float32Array(6),
      edgeRanges: new Uint32Array([0, 2]),
      faceNames: ['top', null],
      edgeNames: ['top'],
    });
    expect([...mesh.triangleFaces]).toEqual([1, 1, 2]);
    expect(names).toEqual(['top']);
    expect([...mesh.faceNames]).toEqual([0, UNNAMED]);
    expect([...mesh.edgeNames]).toEqual([0]);
    expect(mesh.faceFragile).toHaveLength(2);
    expect(mesh.edgeFragile).toHaveLength(1);
  });
});

describe('matrixToTransform', () => {
  const cases: [string, [number, number, number, number]][] = [
    ['identity', [0, 0, 0, 1]],
    ['90 about Z', [0, 0, Math.SQRT1_2, Math.SQRT1_2]],
    ['180 about X', [1, 0, 0, 0]],
    ['180 about Y', [0, 1, 0, 0]],
    ['180 about Z', [0, 0, 1, 0]],
    ['oblique', [0.1825742, 0.3651484, 0.5477226, 0.7302967]],
  ];
  for (const [label, rotation] of cases) {
    it(`maps points as the matrix does: ${label}`, () => {
      const m = placementMatrix({ translation: [5, -6, 7], rotation });
      const t = matrixToTransform(m);
      const p = [1, 2, 3];
      // The matrix's own mapping: p' = R p + t with R[r][c] = m[c * 3 + r].
      const want = [0, 1, 2].map(
        (r) => m[r]! * p[0]! + m[3 + r]! * p[1]! + m[6 + r]! * p[2]! + m[9 + r]!,
      );
      const got = transformPoint(t, p);
      for (let k = 0; k < 3; k++) expect(got[k]).toBeCloseTo(want[k]!, 6);
    });
  }
});

describe('viewerBodies', () => {
  it('makes one viewport body per body of a part studio, with colours and names', async () => {
    const bodies = viewerBodies(openBundle(await boxBundle()));
    expect(bodies.map((b) => [b.id, b.name, b.input.color, b.input.transform])).toEqual([
      ['0/0', 'Base', '#3366cc', undefined],
      ['0/1', 'Block', undefined, undefined],
    ]);
    expect(bodies[0]!.bounds).toEqual({ min: [0, 0, 0], max: [40, 30, 20] });
    expect(boundsOf(bodies)).toEqual({ min: [0, 0, 0], max: [60, 30, 20] });
    expect(boundsOf([])).toBeNull();
  });

  it('places each instance of an assembly, sharing the mesh', async () => {
    const bodies = viewerBodies(openBundle(await assemblyBundle()));
    expect(bodies.map((b) => [b.id, b.instanceName])).toEqual([
      ['0/0', 'Left'],
      ['1/0', 'Right'],
    ]);
    expect(bodies[0]!.input.mesh).toBe(bodies[1]!.input.mesh);
    const right = bodies[1]!.bounds!;
    // The cube turned 90 degrees about Z and moved to x = 100 spans x 90..100, y 0..10.
    for (const [got, want] of [
      [right.min, [90, 0, 0]],
      [right.max, [100, 10, 10]],
    ] as const) {
      for (let k = 0; k < 3; k++) expect(got[k]).toBeCloseTo(want[k]!, 4);
    }
  });

  it('cleans names for display', async () => {
    const bytes = await boxBundle({ bodyNames: ['\u202eevil\u202c\nname', '\u0007'] });
    const bodies = viewerBodies(openBundle(bytes));
    expect(bodies.map((b) => b.name)).toEqual(['evil name', 'Body 2']);
  });
});
