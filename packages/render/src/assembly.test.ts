// Assembly scenes on a hand-made regen result: instances of one part and of a source placed at
// their poses, names matched qualified with the instance, and what is missing reported.

import type { MeshData } from '@manufakture/kernel/types';
import type { RegenResult } from '@manufakture/regen';
import { describe, expect, it } from 'vitest';
import { render } from './render';
import { buildAssemblyScene, poseMatrix } from './scene';
import { boxMesh } from './test/shapes';

/** A 10 mm cube at the origin as a regen body mesh, its face and edge names in `names`. */
function cubeMesh(names: string[], body: string): MeshData {
  const m = boxMesh(body, [0, 0, 0], [10, 10, 10]);
  const slot = (n: string | null) => {
    names.push(n!);
    return names.length - 1;
  };
  const faceNames = Uint32Array.from(m.faceNames, slot);
  const edgeNames = Uint32Array.from(m.edgeNames, slot);
  return {
    positions: m.positions,
    normals: new Float32Array(m.positions.length),
    indices: m.indices,
    faceRanges: new Uint32Array(0),
    triangleFaces: m.triangleFaces!,
    edgePositions: m.edgePositions,
    edgeRanges: m.edgeRanges,
    faceNames,
    faceFragile: new Uint8Array(faceNames.length),
    edgeNames,
    edgeFragile: new Uint8Array(edgeNames.length),
  };
}

function result(): Pick<RegenResult, 'names' | 'parts' | 'sources'> {
  const names: string[] = [];
  const body = (bodyId: string, mesh: MeshData | null) => ({ bodyId, mesh }) as never;
  return {
    names,
    parts: [
      {
        partId: 'part#1',
        bodies: [body('extrude#1', cubeMesh(names, 'extrude#1')), body('extrude#2', null)],
      } as never,
    ],
    sources: [
      {
        key: 'source:abc:part#9',
        partId: 'part#9',
        bodies: [body('extrude#5', cubeMesh(names, 'extrude#5'))],
      } as never,
    ],
  };
}

const at = (x: number) => ({ translation: [x, 0, 0] as const, rotation: [0, 0, 0, 1] as const });

describe('buildAssemblyScene', () => {
  it('turns a pose into a column-major matrix', () => {
    // A quarter turn about Z, then 5 along X: (1, 0, 0) goes to (5, 1, 0).
    const s = Math.SQRT1_2;
    const m = poseMatrix({ translation: [5, 0, 0], rotation: [0, 0, s, s] });
    const p = [1, 0, 0];
    const out = [0, 1, 2].map(
      (r) => m[r]! * p[0]! + m[4 + r]! * p[1]! + m[8 + r]! * p[2]! + m[12 + r]!,
    );
    expect(out.map((v) => Math.round(v * 1e6) / 1e6)).toEqual([5, 1, 0]);
  });

  it('places each instance at its pose and matches names qualified with the instance', () => {
    const r = buildAssemblyScene({
      result: result(),
      instances: [
        { instanceId: 'inst#1', source: { part: 'part#1' }, bodies: ['extrude#1'], pose: at(0) },
        { instanceId: 'inst#2', source: { part: 'part#1' }, bodies: ['extrude#1'], pose: at(30) },
        {
          instanceId: 'inst#3',
          source: { source: 'source:abc:part#9' },
          bodies: ['extrude#5'],
          pose: at(60),
        },
      ],
    });
    if (!r.ok) throw new Error(r.error.message);
    expect(
      r.value.meshes.map((m) => [m.instanceId, m.partId, m.names[0], m.matrices![12]]),
    ).toEqual([
      ['inst#1', 'part#1', 'extrude#1', 0],
      ['inst#2', 'part#1', 'extrude#1', 30],
      ['inst#3', 'part#9', 'extrude#5', 60],
    ]);
    expect(r.value.meshes[0]!.faceNames).toContain('extrude#1:z+');
    // The front view spans all three: 70 mm wide.
    const all = render(r.value, { camera: 'front', width: 280, height: 120, supersample: 1 });
    if (!all.ok) throw new Error(all.error.message);
    // Fitting one instance by its qualified name frames 10 mm; hiding one leaves two.
    const one = render(r.value, {
      camera: { view: 'front', fit: ['inst#2/extrude#1'] },
      width: 280,
      height: 120,
      highlight: ['inst#3/extrude#5:z+', 'inst#9/*'],
    });
    if (!one.ok) throw new Error(one.error.message);
    // 10 mm over 120 - 2 x 24 px, against 70 mm over 280 - 2 x 24 px.
    expect(one.value.mmPerPixel).toBeCloseTo(10 / 72, 9);
    expect(all.value.mmPerPixel).toBeCloseTo(70 / 232, 9);
    expect(one.value.unmatched).toEqual(['inst#9/*']);
    const hidden = render(r.value, {
      camera: 'front',
      width: 280,
      height: 120,
      hide: ['inst#3/*'],
    });
    if (!hidden.ok) throw new Error(hidden.error.message);
    expect(hidden.value.mmPerPixel).toBeLessThan(all.value.mmPerPixel);
  });

  it('reports a body with no mesh, an unknown part and an unknown source', () => {
    const r = buildAssemblyScene({
      result: result(),
      instances: [
        { instanceId: 'inst#1', source: { part: 'part#1' }, bodies: ['extrude#2'], pose: at(0) },
        { instanceId: 'inst#2', source: { part: 'part#4' }, bodies: [], pose: at(0) },
        { instanceId: 'inst#3', source: { source: 'nope' }, bodies: [], pose: at(0) },
      ],
    });
    expect(r).toMatchObject({ ok: false, error: { code: 'missing-mesh' } });
    if (r.ok) return;
    expect(r.error.message).toContain('inst#1 (part#1/extrude#2)');
    expect(r.error.message).toContain('inst#2 (part part#4)');
    expect(r.error.message).toContain('inst#3 (source nope)');
  });

  it('counts a bare pattern and its part- and instance-qualified forms as matched', () => {
    const r = buildAssemblyScene({
      result: result(),
      instances: [
        { instanceId: 'inst#1', source: { part: 'part#1' }, bodies: ['extrude#1'], pose: at(0) },
      ],
    });
    if (!r.ok) throw new Error(r.error.message);
    const drawn = render(r.value, {
      width: 160,
      height: 120,
      highlight: ['extrude#1:z+', 'part#1/extrude#1:z+', 'inst#1/extrude#1:z+'],
    });
    if (!drawn.ok) throw new Error(drawn.error.message);
    expect(drawn.value.unmatched).toEqual([]);
    const whole = render(r.value, {
      width: 160,
      height: 120,
      highlight: ['extrude#1', 'part#1/extrude#1', 'inst#1/extrude#1'],
    });
    if (!whole.ok) throw new Error(whole.error.message);
    expect(whole.value.unmatched).toEqual([]);
    // The same in a part studio scene: no instance, so only the bare and part forms.
    const cube = { meshes: [boxMesh('extrude#1', [0, 0, 0], [10, 10, 10])] };
    const part = render(cube, {
      width: 160,
      height: 120,
      highlight: ['extrude#1:x+', 'part#1/extrude#1:x+', 'inst#1/extrude#1:x+'],
    });
    if (!part.ok) throw new Error(part.error.message);
    expect(part.value.unmatched).toEqual(['inst#1/extrude#1:x+']);
  });
});
