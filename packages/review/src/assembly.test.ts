// An assembly view on a hand-made document and regen result (no kernel): the scene at the solved
// poses, with a slider held at a value (in mm) and past its limit, an instance placed by hand off
// its mate, what is refused, and a bundle view's request checked.

import type { ManufaktureDocument, Pose } from '@manufakture/core';
import type { AssemblyResult, BodyResult, RegenResult } from '@manufakture/regen';
import { describe, expect, it } from 'vitest';
import { assemblyScene } from './assembly';
import { renderPairs, reviewViews } from './renders';

type MeshData = NonNullable<BodyResult['mesh']>;

const I: Pose = { translation: [0, 0, 0], rotation: [0, 0, 0, 1] };
const mm = (source: string) => ({ source, lengthUnit: 'mm', angleUnit: 'deg' });

/** A unit triangle as a body mesh: enough for a scene and its box. */
const mesh = (): MeshData => ({
  positions: new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 0]),
  normals: new Float32Array(9),
  indices: new Uint32Array([0, 1, 2]),
  faceRanges: new Uint32Array([0, 3]),
  triangleFaces: new Uint32Array([1]),
  edgePositions: new Float32Array(0),
  edgeRanges: new Uint32Array(0),
  faceNames: new Uint32Array([0xffffffff]),
  faceFragile: new Uint8Array(1),
  edgeNames: new Uint32Array(0),
  edgeFragile: new Uint8Array(0),
});

const connector = (id: string, instance: string) => ({
  id,
  instance,
  inference: 'centroid',
  origin: { id: `r${id}`, ref: { face: 'f' } },
});

function fixture(): { document: ManufaktureDocument; result: RegenResult } {
  const document = {
    variables: [],
    parts: [{ id: 'p', bodies: [], features: [] }],
    assemblies: [
      {
        id: 'assembly#1',
        name: 'Drawer',
        instances: [
          { id: 'cab', source: { part: 'p' }, fixed: true, suppressed: false, pose: I },
          { id: 'drawer', source: { part: 'p' }, fixed: false, suppressed: false, pose: I },
          { id: 'bad', source: { part: 'p' }, fixed: false, suppressed: false, pose: I },
        ],
        mates: [
          {
            id: 'mate#1',
            name: 'Slides',
            kind: 'slider',
            suppressed: false,
            a: connector('ca', 'cab'),
            b: connector('cb', 'drawer'),
            limits: { min: mm('0'), max: mm('400') },
          },
        ],
      },
    ],
  } as unknown as ManufaktureDocument;
  const solved: AssemblyResult = {
    assemblyId: 'assembly#1',
    outcome: 'solved',
    dof: 1,
    instances: [],
    mates: [],
    redundant: [],
    conflicting: [],
    issues: [],
    warnings: [],
    ms: 0,
  };
  const inst = (
    id: string,
    status: 'ok' | 'error' = 'ok',
  ): AssemblyResult['instances'][number] => ({
    instanceId: id,
    status,
    source: { part: 'p' },
    bodies: ['b1'],
    transform: I,
    moved: false,
    errors: [],
    warnings: [],
  });
  solved.instances.push(inst('cab'), inst('drawer'), inst('bad', 'error'));
  solved.mates.push({
    mateId: 'mate#1',
    status: 'ok',
    coordinates: [0],
    residual: null,
    connectors: [
      { connectorId: 'ca', instanceId: 'cab', frame: I, reference: null },
      { connectorId: 'cb', instanceId: 'drawer', frame: I, reference: null },
    ],
    errors: [],
    warnings: [],
  });
  const result = {
    names: [],
    parts: [{ partId: 'p', bodies: [{ bodyId: 'b1', bodyKey: 'k1', mesh: mesh() }] }],
    sources: [],
    assemblies: [solved],
  } as unknown as RegenResult;
  return { document, result };
}

const z = (r: ReturnType<typeof assemblyScene>, instance: string) => {
  if (!r.ok) throw new Error(r.message);
  return r.scene.meshes.find((m) => m.instanceId === instance)!.matrices![14];
};

describe('assemblyScene', () => {
  it('draws the solved poses, a slider held at a value, and warns past its limit', () => {
    const { document, result } = fixture();
    const rest = assemblyScene(document, result, { assemblyId: 'assembly#1' });
    if (!rest.ok) throw new Error(rest.message);
    // The failed instance is left out and named.
    expect(rest.scene.meshes.map((m) => m.instanceId)).toEqual(['cab', 'drawer']);
    expect(rest.posed).toEqual({
      assemblyId: 'assembly#1',
      mates: [
        {
          mateId: 'mate#1',
          kind: 'slider',
          coordinates: [{ name: 'distance', value: 0, unit: 'mm' }],
        },
      ],
      warnings: [],
      skipped: ['bad'],
    });
    // The slider runs along its connectors' z: held at 250 mm the drawer is there.
    const open = assemblyScene(document, result, {
      assemblyId: 'assembly#1',
      mates: { 'mate#1': 250 },
    });
    expect(z(open, 'drawer')).toBeCloseTo(250, 4);
    expect(z(open, 'cab')).toBe(0);
    if (!open.ok) return;
    expect(open.posed.warnings).toEqual([]);
    const past = assemblyScene(document, result, {
      assemblyId: 'assembly#1',
      mates: { 'mate#1': 500 },
    });
    expect(z(past, 'drawer')).toBeCloseTo(500, 4);
    if (!past.ok) return;
    expect(past.posed.warnings).toEqual([
      expect.objectContaining({ code: 'outside-limits', bound: 'max', limit: 400, unit: 'mm' }),
    ]);
  });

  it('places an instance by hand and says when it leaves its mate', () => {
    const { document, result } = fixture();
    const r = assemblyScene(document, result, {
      assemblyId: 'assembly#1',
      poses: { drawer: { translation: [5, 0, 100], rotation: [0, 0, 0, 1] } },
    });
    expect(z(r, 'drawer')).toBe(100);
    if (!r.ok) return;
    expect(r.posed.warnings).toEqual([
      expect.objectContaining({
        code: 'off-mate',
        mateId: 'mate#1',
        position: expect.closeTo(5, 9) as number,
      }),
    ]);
  });

  it('refuses an unknown assembly, an unknown mate, and a mate value while the solve conflicts', () => {
    const { document, result } = fixture();
    expect(assemblyScene(document, result, { assemblyId: 'assembly#9' })).toMatchObject({
      ok: false,
      code: 'not-found',
    });
    expect(
      assemblyScene(document, result, { assemblyId: 'assembly#1', mates: { 'mate#9': 1 } }),
    ).toMatchObject({ ok: false, code: 'invalid-input' });
    result.assemblies[0]!.outcome = 'conflicting';
    expect(
      assemblyScene(document, result, { assemblyId: 'assembly#1', mates: { 'mate#1': 1 } }),
    ).toMatchObject({ ok: false, code: 'invalid-input', message: /conflicting/ });
  });
});

describe('review views of an assembly', () => {
  it('checks the request, and frames each view on what its own scenes draw', () => {
    expect(() =>
      reviewViews([{ name: 'Open', assembly: { assemblyId: 'assembly#1', mates: { m: NaN } } }]),
    ).toThrow(/finite number/);
    expect(() =>
      reviewViews([
        {
          name: 'Open',
          assembly: {
            assemblyId: 'assembly#1',
            poses: { a: { translation: [0, 0], rotation: [0, 0, 0, 1] } as unknown as Pose },
          },
        },
      ]),
    ).toThrow(/A pose, by instance id/);
    // Core's pose bounds: a translation past MAX_POSE_TRANSLATION, a quaternion that is not unit.
    for (const pose of [
      { translation: [2e9, 0, 0], rotation: [0, 0, 0, 1] },
      { translation: [0, 0, 0], rotation: [0, 0, 0, 1.01] },
    ]) {
      expect(() =>
        reviewViews([
          {
            name: 'Open',
            assembly: { assemblyId: 'assembly#1', poses: { a: pose as unknown as Pose } },
          },
        ]),
      ).toThrow(/unit quaternion/);
    }
    expect(() =>
      reviewViews([
        { name: 'Open', assembly: { assemblyId: 'assembly#1', mates: { ['m'.repeat(121)]: 1 } } },
      ]),
    ).toThrow(/1 to 120 characters/);
    expect(() =>
      reviewViews([
        {
          name: 'Open',
          assembly: {
            assemblyId: 'assembly#1',
            mates: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`m${i}`, 1])),
          },
        },
      ]),
    ).toThrow(/at most 64/);
    const views = reviewViews([
      { name: 'Open', camera: 'front', assembly: { assemblyId: 'assembly#1', mates: { m: 1 } } },
    ]);
    expect(views.at(-1)!.assembly).toEqual({ assemblyId: 'assembly#1', mates: { m: 1 } });
    const { document, result } = fixture();
    const closed = assemblyScene(document, result, { assemblyId: 'assembly#1' });
    const open = assemblyScene(document, result, {
      assemblyId: 'assembly#1',
      mates: { 'mate#1': 250 },
    });
    if (!closed.ok || !open.ok) throw new Error('not posed');
    const pairs = renderPairs(
      (v) => (v.assembly ? { ok: true, value: closed.scene } : { ok: false, message: 'none' }),
      (v) => (v.assembly ? { ok: true, value: open.scene } : { ok: false, message: 'none' }),
      views,
      { width: 160, height: 120 },
    );
    expect(pairs.slice(0, 4).every((p) => p.head && 'error' in p.head)).toBe(true);
    const last = pairs.at(-1)!;
    expect(last.base && 'png' in last.base).toBe(true);
    expect(last.head && 'png' in last.head).toBe(true);
    // Framed on both sides: the head's drawer at z 250 is inside the shared camera's extent.
    expect((last.camera as { extent: number }).extent).toBeGreaterThan(250);
  });
});
