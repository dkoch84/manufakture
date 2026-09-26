import { UNNAMED, faceNameOfTriangle, type MeshData } from '@manufakture/kernel';
import { describe, expect, it } from 'vitest';
import { BOX_FACE_NAMES, boxBody, denseSphereBody } from './testMeshes';

/** Every triangle's geometric normal agrees with its vertex normals: counter-clockwise from outside. */
function expectOutwardWinding(mesh: MeshData) {
  const p = mesh.positions;
  for (let t = 0; t < mesh.indices.length / 3; t++) {
    const [a, b, c] = [0, 1, 2].map((k) => mesh.indices[t * 3 + k]!);
    const e1 = [0, 1, 2].map((k) => p[b! * 3 + k]! - p[a! * 3 + k]!);
    const e2 = [0, 1, 2].map((k) => p[c! * 3 + k]! - p[a! * 3 + k]!);
    const n = [
      e1[1]! * e2[2]! - e1[2]! * e2[1]!,
      e1[2]! * e2[0]! - e1[0]! * e2[2]!,
      e1[0]! * e2[1]! - e1[1]! * e2[0]!,
    ];
    const dot =
      n[0]! * mesh.normals[a! * 3]! +
      n[1]! * mesh.normals[a! * 3 + 1]! +
      n[2]! * mesh.normals[a! * 3 + 2]!;
    expect(dot).toBeGreaterThanOrEqual(0);
  }
}

describe('boxBody', () => {
  const box = boxBody({ min: [0, 0, 0], size: [10, 20, 30] });

  it('has 6 faces of 2 triangles and 12 two-point edges', () => {
    expect(box.mesh.faceRanges.length / 2).toBe(6);
    expect(box.mesh.triangleFaces).toHaveLength(12);
    expect(box.mesh.edgeRanges.length / 2).toBe(12);
    expect(box.topology?.vertices).toHaveLength(8);
  });

  it('winds every triangle outwards', () => {
    expectOutwardWinding(box.mesh);
  });

  it('names faces as the naming layer would, so picking a triangle yields its name', () => {
    expect(box.names).toContain('box/top');
    // Triangles 10 and 11 belong to face 6, +Z.
    expect(faceNameOfTriangle(box.mesh, box.names, 10)).toBe('box/top');
    expect(faceNameOfTriangle(box.mesh, box.names, 0)).toBe('box/left');
    expect(box.mesh.faceNames.every((s) => s !== UNNAMED)).toBe(true);
    expect(box.mesh.edgeNames.every((s) => s !== UNNAMED)).toBe(true);
  });

  it('puts each face on its side of the box', () => {
    const top = box.topology!.faces[BOX_FACE_NAMES.indexOf('top')]!;
    expect(top.centroid).toEqual([5, 10, 30]);
    expect(top.normal).toEqual([0, 0, 1]);
    const front = box.topology!.faces[BOX_FACE_NAMES.indexOf('front')]!;
    expect(front.normal).toEqual([0, -1, 0]);
  });

  it('gives every edge the two faces that meet there, and endpoints on the box corners', () => {
    for (const e of box.topology!.edges) {
      expect(e.faces).toHaveLength(2);
      const [a, b] = e.faces;
      // The two faces are on different axes.
      expect(Math.floor((a! - 1) / 2)).not.toBe(Math.floor((b! - 1) / 2));
      expect(e.vertices).toHaveLength(2);
    }
  });

  it('leaves slots unnamed on request', () => {
    const plain = boxBody({ named: false });
    expect(plain.names).toEqual([]);
    expect(plain.mesh.faceNames.every((s) => s === UNNAMED)).toBe(true);
  });
});

describe('denseSphereBody', () => {
  it('reaches the requested triangle count with patch faces and border edges', () => {
    const body = denseSphereBody(200_000);
    const tris = body.mesh.indices.length / 3;
    expect(tris).toBeGreaterThanOrEqual(200_000);
    expect(tris).toBeLessThan(260_000);
    expect(body.mesh.faceRanges.length / 2).toBe(24 * 12);
    // 24 meridians of 12 patch segments, 11 parallels of 24 segments.
    expect(body.mesh.edgeRanges.length / 2).toBe(24 * 12 + 11 * 24);
  });

  it('winds a small sphere outwards and keeps face ranges consistent', () => {
    const body = denseSphereBody(2_000);
    expectOutwardWinding(body.mesh);
    const m = body.mesh;
    for (let f = 0; f < m.faceRanges.length / 2; f++) {
      const first = m.faceRanges[f * 2]! / 3;
      const count = m.faceRanges[f * 2 + 1]! / 3;
      for (let t = first; t < first + count; t++) expect(m.triangleFaces[t]).toBe(f + 1);
    }
  });
});
