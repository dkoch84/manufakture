import { describe, expect, it } from 'vitest';
import type { MeshData } from '@manufakture/kernel';
import { boundsOf, pickIdAttribute, prepareBody, splitSharedVertices, unionBounds } from './bodies';
import { boxBody } from './testMeshes';

describe('prepareBody', () => {
  const body = prepareBody(boxBody({ min: [1, 2, 3], size: [4, 5, 6] }), 10);

  it('counts faces and edges and keeps the pick base', () => {
    expect(body.faceCount).toBe(6);
    expect(body.edgeCount).toBe(12);
    expect(body.pickBase).toBe(10);
  });

  it('lists the vertices of every face and their span', () => {
    // The box has four vertices per face, face by face.
    expect(body.positions).toBe(body.mesh.positions);
    for (let f = 0; f < 6; f++) {
      const list = body.faceVertexList.subarray(
        body.faceVertexOffsets[f],
        body.faceVertexOffsets[f + 1],
      );
      expect([...list]).toEqual([f * 4, f * 4 + 1, f * 4 + 2, f * 4 + 3]);
      expect(body.faceVertexStart[f]).toBe(f * 4);
      expect(body.faceVertexEnd[f]).toBe(f * 4 + 4);
    }
  });

  it('splits edge polylines into segments tagged with their edge', () => {
    expect(body.segments.length).toBe(12 * 6);
    expect([...body.segmentEdges]).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
  });

  it('turns polylines of n points into n - 1 segments', () => {
    const input = boxBody();
    // Edge 1 becomes a 3-point polyline: reuse the first two points of edge 2.
    input.mesh.edgePositions = new Float32Array([0, 0, 0, 1, 0, 0, 2, 0, 0]);
    input.mesh.edgeRanges = new Uint32Array([0, 3, 0, 0]);
    input.mesh.edgeNames = new Uint32Array(2);
    const b = prepareBody({ ...input, topology: null }, 0);
    expect([...b.segmentEdges]).toEqual([1, 1]);
    expect([...b.segments]).toEqual([0, 0, 0, 1, 0, 0, 1, 0, 0, 2, 0, 0]);
    expect(b.edgeFaces).toBeNull();
    expect(b.vertices).toEqual([]);
  });

  it('takes adjacency and vertices from the topology', () => {
    expect(body.edgeFaces).toHaveLength(12);
    expect(body.vertices).toHaveLength(8);
  });

  it('computes bounds', () => {
    expect(body.bounds).toEqual({ min: [1, 2, 3], max: [5, 7, 9] });
    expect(boundsOf(new Float32Array())).toBeNull();
  });

  it('unites bounds of several bodies', () => {
    const a = prepareBody(boxBody({ min: [0, 0, 0], size: [1, 1, 1] }), 0);
    const b = prepareBody(boxBody({ min: [-5, 2, 0], size: [1, 1, 10] }), 6);
    expect(unionBounds([a, b])).toEqual({ min: [-5, 0, 0], max: [1, 3, 10] });
    expect(unionBounds([])).toBeNull();
  });
});

/** Two faces of one quad (face 1: triangle 0, face 2: triangle 1) sharing the diagonal vertices 0 and 2. */
function sharedQuad(): MeshData {
  return {
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2, 2, 3, 0]),
    faceRanges: new Uint32Array([0, 3, 3, 3]),
    triangleFaces: new Uint32Array([1, 2]),
    edgePositions: new Float32Array(),
    edgeRanges: new Uint32Array(),
    faceNames: new Uint32Array([0xffffffff, 0xffffffff]),
    faceFragile: new Uint8Array(2),
    edgeNames: new Uint32Array(),
    edgeFragile: new Uint8Array(),
  };
}

describe('vertices shared between faces', () => {
  it('leaves a mesh whose faces have their own vertices untouched', () => {
    const { mesh } = boxBody();
    const d = splitSharedVertices(mesh);
    expect(d.positions).toBe(mesh.positions);
    expect(d.indices).toBe(mesh.indices);
    expect([...d.vertexFaces]).toEqual(Array.from({ length: 24 }, (_, v) => Math.floor(v / 4) + 1));
  });

  it('duplicates a shared vertex so every vertex belongs to one face', () => {
    const mesh = sharedQuad();
    const d = splitSharedVertices(mesh);
    expect(d.positions.length / 3).toBe(6);
    // Face 2's triangle now uses copies of vertices 2 and 0, at the same places.
    expect([...d.indices]).toEqual([0, 1, 2, 4, 3, 5]);
    expect([...d.positions.subarray(12, 18)]).toEqual([1, 1, 0, 0, 0, 0]);
    expect([...d.normals.subarray(12, 18)]).toEqual([0, 0, 1, 0, 0, 1]);
    expect([...d.vertexFaces]).toEqual([1, 1, 1, 2, 2, 2]);
    // The kernel's arrays are not modified.
    expect([...mesh.indices]).toEqual([0, 1, 2, 2, 3, 0]);
  });

  it('gives each face its own pick id and vertex list, whatever the vertex order', () => {
    const body = prepareBody({ id: 'quad', mesh: sharedQuad(), names: [] }, 1);
    const ids = pickIdAttribute(body);
    for (let t = 0; t < 2; t++) {
      for (let k = 0; k < 3; k++) {
        expect(ids[body.indices[t * 3 + k]!]).toBe(1 + t);
      }
    }
    const list = (f: number) => [
      ...body.faceVertexList.subarray(body.faceVertexOffsets[f], body.faceVertexOffsets[f + 1]),
    ];
    expect(list(0)).toEqual([0, 1, 2]);
    expect(list(1)).toEqual([3, 4, 5]);
    expect(body.faceVertexStart[1]).toBe(3);
    expect(body.faceVertexEnd[1]).toBe(6);
  });
});
