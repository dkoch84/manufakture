import { describe, expect, it } from 'vitest';
import { NameTable, applyNames, faceNameOfTriangle } from './names';
import { UNNAMED, type MeshData } from './types';

/** A two-face, three-edge mesh stub: face 1 has two triangles, face 2 one. */
function stub(): MeshData {
  return {
    positions: new Float32Array(),
    normals: new Float32Array(),
    indices: new Uint32Array(9),
    faceRanges: new Uint32Array([0, 6, 6, 3]),
    triangleFaces: new Uint32Array([1, 1, 2]),
    edgePositions: new Float32Array(),
    edgeRanges: new Uint32Array(6),
    faceNames: new Uint32Array(2).fill(UNNAMED),
    faceFragile: new Uint8Array(2),
    edgeNames: new Uint32Array(3).fill(UNNAMED),
    edgeFragile: new Uint8Array(3),
  };
}

describe('NameTable', () => {
  it('interns each string once, in first-seen order', () => {
    const t = new NameTable();
    expect(t.intern('extrude#1:cap:end')).toBe(0);
    expect(t.intern('extrude#1:side:l1')).toBe(1);
    expect(t.intern('extrude#1:cap:end')).toBe(0);
    expect(t.names).toEqual(['extrude#1:cap:end', 'extrude#1:side:l1']);
    expect(t.lookup(1)).toBe('extrude#1:side:l1');
    expect(t.lookup(UNNAMED)).toBeUndefined();
  });
});

describe('applyNames', () => {
  it('fills face and edge slots with 1-based indices, fragile flags and gaps', () => {
    const mesh = stub();
    const t = new NameTable();
    const faces: number[] = [];
    applyNames(
      mesh,
      t,
      (f) => (faces.push(f), f === 1 ? { name: 'a' } : { name: 'b#2', fragile: true }),
      (e) => (e === 2 ? null : { name: e === 1 ? 'a' : 'c' }),
    );
    expect(faces).toEqual([1, 2]);
    expect([...mesh.faceNames]).toEqual([0, 1]);
    expect([...mesh.faceFragile]).toEqual([0, 1]);
    expect([...mesh.edgeNames]).toEqual([0, UNNAMED, 2]);
    expect([...mesh.edgeFragile]).toEqual([0, 0, 0]);
    expect(t.names).toEqual(['a', 'b#2', 'c']);
  });

  it('edges stay unnamed without an edge callback', () => {
    const mesh = stub();
    applyNames(mesh, new NameTable(), () => ({ name: 'f' }));
    expect([...mesh.edgeNames]).toEqual([UNNAMED, UNNAMED, UNNAMED]);
  });
});

describe('faceNameOfTriangle', () => {
  it('maps a picked triangle to its face name', () => {
    const mesh = stub();
    const t = new NameTable();
    applyNames(mesh, t, (f) => (f === 2 ? { name: 'top' } : null));
    expect(faceNameOfTriangle(mesh, t.names, 0)).toBeUndefined();
    expect(faceNameOfTriangle(mesh, t.names, 2)).toBe('top');
    expect(faceNameOfTriangle(mesh, t.names, 99)).toBeUndefined();
  });
});
