import { describe, expect, it } from 'vitest';
import { checkManifold } from './manifold';
import { meshProperties } from './mesh';
import { StlParseError, parseStl, writeBinaryStl } from './stl';
import { boxMesh } from './test-helpers';

describe('writeBinaryStl', () => {
  it('writes the 80-byte header, the count and 50 bytes per triangle with unit normals', () => {
    const bytes = writeBinaryStl(boxMesh([0, 0, 0], [2, 3, 4]), { header: 'Bracket' });
    expect(bytes.length).toBe(80 + 4 + 12 * 50);
    const view = new DataView(bytes.buffer);
    expect(view.getUint32(80, true)).toBe(12);
    expect(new TextDecoder().decode(bytes.subarray(0, 7))).toBe('Bracket');
    // The first triangle is on the bottom face: normal -z.
    expect([0, 4, 8].map((o) => view.getFloat32(84 + o, true))).toEqual([0, 0, -1]);
    for (let t = 0; t < 12; t++) {
      const n = [0, 4, 8].map((o) => view.getFloat32(84 + t * 50 + o, true));
      expect(Math.hypot(...n)).toBeCloseTo(1, 6);
      expect(view.getUint16(84 + t * 50 + 48, true)).toBe(0);
    }
  });

  it('never writes a header that starts with "solid", and keeps it ASCII', () => {
    const bytes = writeBinaryStl(boxMesh(), { header: 'solid part äö' });
    const head = new TextDecoder().decode(bytes.subarray(0, 80));
    expect(head.startsWith('solid')).toBe(false);
    expect(head).toMatch(/^STL solid part \?\?/);
  });
});

describe('parseStl', () => {
  it('reads binary back, welded, with the header as its name', () => {
    const box = boxMesh([0, 0, 0], [2, 3, 4]);
    const parsed = parseStl(writeBinaryStl(box, { header: 'Bracket' }));
    expect(parsed).toMatchObject({ name: 'Bracket', format: 'binary', fileTriangles: 12 });
    expect(parsed.mesh.positions.length / 3).toBe(8);
    expect(checkManifold(parsed.mesh).ok).toBe(true);
    expect(meshProperties(parsed.mesh).volume).toBeCloseTo(24, 5);
  });

  it('reads binary files whose header starts with "solid" as binary', () => {
    const bytes = writeBinaryStl(boxMesh());
    bytes.set(new TextEncoder().encode('solid by another program'));
    expect(parseStl(bytes).format).toBe('binary');
  });

  it('reads ASCII STL', () => {
    const facet = (a: number[], b: number[], c: number[]) =>
      `facet normal 0 0 0\n outer loop\n  vertex ${a.join(' ')}\n  vertex ${b.join(' ')}\n  vertex ${c.join(' ')}\n endloop\nendfacet\n`;
    const text =
      'solid tetra\n' +
      facet([0, 0, 0], [0, 1, 0], [1, 0, 0]) +
      facet([0, 0, 0], [1, 0, 0], [0, 0, 1]) +
      facet([0, 0, 0], [0, 0, 1], [0, 1, 0]) +
      facet([1, 0, 0], [0, 1, 0], [0, 0, 1]) +
      'endsolid tetra\n';
    const parsed = parseStl(new TextEncoder().encode(text));
    expect(parsed).toMatchObject({ name: 'tetra', format: 'ascii', fileTriangles: 4 });
    expect(checkManifold(parsed.mesh).ok).toBe(true);
    expect(meshProperties(parsed.mesh).volume).toBeCloseTo(1 / 6, 6);
  });

  it('refuses what is not STL', () => {
    expect(() => parseStl(new TextEncoder().encode('ISO-10303-21;'))).toThrow(StlParseError);
    expect(() => parseStl(new TextEncoder().encode('solid x\nendsolid x\n'))).toThrow(
      /no triangles/,
    );
    expect(() =>
      parseStl(new TextEncoder().encode('solid x\nvertex 1 2 3\nvertex 1 2 3\nendsolid\n')),
    ).toThrow(/three vertices/);
    expect(() =>
      parseStl(new TextEncoder().encode('solid x\nvertex a b c\nvertex 1 2 3\nvertex 1 2 4\n')),
    ).toThrow(/not a number/);
  });
});
