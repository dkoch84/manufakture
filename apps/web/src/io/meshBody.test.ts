import { describe, expect, it, vi } from 'vitest';
import { OPEN_MESH_NOTE, meshBody, measureMesh, withMeshBodies } from './meshBody';

/** A 2 x 2 x 2 tetrahedron-free box: 8 vertices, 12 triangles, wound outward. */
function box() {
  // prettier-ignore
  const positions = new Float32Array([
    0, 0, 0,  2, 0, 0,  2, 2, 0,  0, 2, 0,
    0, 0, 2,  2, 0, 2,  2, 2, 2,  0, 2, 2,
  ]);
  // prettier-ignore
  const indices = new Uint32Array([
    0, 2, 1, 0, 3, 2,  4, 5, 6, 4, 6, 7,  0, 1, 5, 0, 5, 4,
    2, 3, 7, 2, 7, 6,  1, 2, 6, 1, 6, 5,  3, 0, 4, 3, 4, 7,
  ]);
  return { positions, indices };
}

describe('meshBody', () => {
  it('is one face of flat triangles with a placeholder name and no edges', () => {
    const body = meshBody('import#2', box());
    expect(body.id).toBe('import#2');
    expect(body.mesh.faceRanges).toEqual(new Uint32Array([0, 36]));
    expect(body.mesh.positions.length).toBe(36 * 3);
    expect(body.mesh.edgeRanges.length).toBe(0);
    expect(body.names[body.mesh.faceNames[0]!]).toBe('placeholder:face:1');
    // The first triangle is on the bottom: its three normals are -z.
    expect([...body.mesh.normals.subarray(0, 9)]).toEqual([0, 0, -1, 0, 0, -1, 0, 0, -1]);
  });
});

describe('measureMesh and withMeshBodies', () => {
  it('measures the body from the mesh, and no sub-shapes', () => {
    const r = measureMesh(box(), [{ kind: 'face', index: 1 }], true);
    expect(r.body!.volume).toBeCloseTo(8, 6);
    expect(r.body!.area).toBeCloseTo(24, 6);
    expect(r.body!.boundingBox).toEqual({ min: [0, 0, 0], max: [2, 2, 2] });
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ ok: false, status: 'not-found' });
    expect(measureMesh(box(), [], false).body).toBeNull();
  });

  it('reports no volume (and no centre of mass) for an open mesh, with a note', () => {
    const open = box();
    open.indices = open.indices.slice(3);
    const r = measureMesh(open, [], true);
    expect(r.body).toMatchObject({ volume: null, centerOfMass: null, note: OPEN_MESH_NOTE });
    expect(r.body!.area).toBeCloseTo(22, 6);
    expect(r.body!.boundingBox).toEqual({ min: [0, 0, 0], max: [2, 2, 2] });
    // A closed mesh has no note.
    expect(measureMesh(box(), [], true).body!.note).toBeUndefined();
  });

  it('reports no volume for a non-manifold mesh: a box with a face doubled', () => {
    const doubled = box();
    doubled.indices = new Uint32Array([...doubled.indices, 0, 2, 1]);
    expect(measureMesh(doubled, [], true).body!.volume).toBeNull();
  });

  it('answers for mesh bodies and passes the others on', async () => {
    const next = { measure: vi.fn(async () => ({ ok: false as const, message: 'kernel' })) };
    const m = withMeshBodies(next, () => new Map([['import#1', box()]]));
    const mine = await m.measure('import#1', [], true);
    expect(mine?.ok && mine.result.body!.volume).toBeCloseTo(8, 6);
    expect(await m.measure('demo-part', [], true)).toEqual({ ok: false, message: 'kernel' });
    expect(next.measure).toHaveBeenCalledTimes(1);
    const alone = withMeshBodies(null, () => new Map());
    expect((await alone.measure('x', [], true))?.ok).toBe(false);
  });
});
