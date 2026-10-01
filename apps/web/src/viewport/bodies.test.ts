import { describe, expect, it } from 'vitest';
import type { MeshData } from '@manufakture/kernel';
import {
  boundsOf,
  pickIdAttribute,
  prepareBodies,
  prepareBody,
  splitSharedVertices,
  transformBounds,
  transformPoint,
  unionBounds,
  untransformPoint,
  type BodyTransform,
} from './bodies';
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

describe('bodies with transforms (assembly instances)', () => {
  // A quarter turn about Z, then up 10.
  const turn: BodyTransform = {
    translation: [0, 0, 10],
    rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2],
  };
  const near = (a: readonly number[], b: readonly number[]) =>
    a.forEach((v, i) => expect(v).toBeCloseTo(b[i]!, 9));

  it('places points, and takes them back', () => {
    near(transformPoint(turn, [1, 0, 0]), [0, 1, 10]);
    near(transformPoint(turn, [0, 2, 3]), [-2, 0, 13]);
    near(untransformPoint(turn, [0, 1, 10]), [1, 0, 0]);
    expect(transformPoint(undefined, [1, 2, 3])).toEqual([1, 2, 3]);
  });

  it('bounds a placed body where it is', () => {
    const b = transformBounds({ min: [0, 0, 0], max: [4, 2, 1] }, turn);
    near(b.min, [-2, 0, 10]);
    near(b.max, [0, 4, 11]);
  });

  it('shares the tables of one mesh between its instances, each with its pick ids and bounds', () => {
    const box = boxBody({ size: [4, 2, 1] });
    const [a, b] = prepareBodies([
      { ...box, id: 'assembly#1/inst#1/box' },
      { ...box, id: 'assembly#1/inst#2/box', transform: turn },
    ]);
    expect(b!.positions).toBe(a!.positions);
    expect(b!.faceVertexList).toBe(a!.faceVertexList);
    expect(b!.segments).toBe(a!.segments);
    expect(b!.pickBase).toBe(a!.pickBase + a!.pickCount);
    near(a!.bounds!.max, [4, 2, 1]);
    near(b!.bounds!.min, [-2, 0, 10]);
    // Picks stay in the body's own mesh: a pick id names the same face on either instance.
    expect(pickIdAttribute(b!)[0]! - b!.pickBase).toBe(pickIdAttribute(a!)[0]! - a!.pickBase);
  });
});
