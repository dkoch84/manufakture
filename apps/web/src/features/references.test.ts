import { describe, expect, it, vi } from 'vitest';
import type { Referencer } from '../io/exchange';
import { geometryRef } from '../state/selection';
import { boxBody } from '../viewport/testMeshes';
import { referenceFor, subShapeIndex } from './references';

const body = boxBody({ id: 'part#1' });
const context = (referencer?: Referencer) => ({
  bodies: [body, boxBody({ id: 'import#1' })],
  partBodies: new Set(['part#1']),
  referencer,
});

describe('picked faces and edges as references', () => {
  it('finds a named face or edge on its body by name', () => {
    expect(subShapeIndex(body, 'face', 'part#1/top')).toBe(6);
    expect(subShapeIndex(body, 'edge', 'nothing')).toBeNull();
    const edgeName = body.names[body.mesh.edgeNames[2]!]!;
    expect(subShapeIndex(body, 'edge', edgeName)).toBe(3);
  });

  it('stores a face by its name and asks the kernel for an edge', async () => {
    const reference = vi.fn(async () => ({ ok: true as const, value: { faces: ['a', 'b'] } }));
    const top = geometryRef('face', 'part#1', 'part#1/top');
    expect(await referenceFor(top, ['face'], context({ reference }))).toEqual({
      ok: true,
      item: { id: null, ref: { face: 'part#1/top' }, label: 'part#1/top' },
    });
    const edgeName = body.names[body.mesh.edgeNames[2]!]!;
    const edge = geometryRef('edge', 'part#1', edgeName);
    expect(await referenceFor(edge, ['edge'], context({ reference }))).toEqual({
      ok: true,
      item: { id: null, ref: { faces: ['a', 'b'] }, label: 'a | b' },
    });
    expect(reference).toHaveBeenCalledWith('part#1', 'edge', 3);
  });

  it('refuses what cannot be stored, saying why', async () => {
    const face = geometryRef('face', 'part#1', 'part#1/top');
    expect(await referenceFor(face, ['edge'], context())).toMatchObject({
      ok: false,
      message: 'This takes edges, not a face.',
    });
    const placeholder = geometryRef('face', 'part#1', 'placeholder:face:1', { placeholder: true });
    expect(await referenceFor(placeholder, ['face'], context())).toMatchObject({ ok: false });
    const other = geometryRef('face', 'import#1', 'import#1/top');
    expect(await referenceFor(other, ['face'], context())).toMatchObject({
      ok: false,
      message: 'Pick faces of the part.',
    });
    const vertex = geometryRef('vertex', 'part#1', 'placeholder:vertex:1', { placeholder: true });
    expect(await referenceFor(vertex, ['edge', 'face'], context())).toMatchObject({ ok: false });
  });
});
