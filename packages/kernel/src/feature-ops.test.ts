// The `feature`, `resolve` and `pick` ops through the kernel service, body
// sets chained inside a batch, and meshes of named bodies with their name
// slots filled. One service per file.

import { beforeAll, describe, expect, it } from 'vitest';
import type { ExtrudeInput, FeatureInput, FeatureOutcome } from './features';
import { XY, circle, profile, rectangle } from './fixtures/parts';
import { faceNameOfTriangle } from './names';
import { createNodeService } from './node';
import type { KernelOp } from './ops';
import type { KernelService } from './service';
import { UNNAMED, type MeshData } from './types';

let service: KernelService;
let generation = 0;

beforeAll(async () => {
  service = await createNodeService();
}, 60_000);

const run = (ops: readonly KernelOp[]) => service.run({ generation: ++generation, ops });

const block: ExtrudeInput = {
  kind: 'extrude',
  id: 'extrude#1',
  profile: profile(XY, rectangle(0, 0, 40, 30)),
  extent: { type: 'blind', distance: 20 },
  mode: 'new',
};
const fillet: FeatureInput = {
  kind: 'fillet',
  id: 'fillet#2',
  radius: 3,
  edges: [{ id: 'r1', ref: { faces: ['extrude#1:side:e1', 'extrude#1:side:e2'] } }],
};

function value<T>(r: { ok: boolean }): T {
  expect(r.ok).toBe(true);
  return (r as unknown as { value: T }).value;
}

describe('feature ops', () => {
  it('chains features in one batch, and the mesh carries every face and edge name', async () => {
    const reply = await run([
      { op: 'feature', bodies: [], feature: block, keep: false },
      { op: 'feature', bodies: { result: 0 }, feature: fillet },
      { op: 'tessellate', shape: { result: 1 } },
    ]);
    expect(reply.status).toBe('done');
    const first = value<FeatureOutcome>(reply.results[0]!);
    const second = value<FeatureOutcome>(reply.results[1]!);
    expect(first).toMatchObject({ ok: true, created: ['extrude#1'], featureId: 'extrude#1' });
    expect(second).toMatchObject({
      ok: true,
      created: [],
      changed: ['extrude#1'],
      errors: [],
      warnings: [],
    });
    // The failure-free chain stamps feature ids without an explicit featureId.
    expect(reply.results[1]!.featureId).toBe('fillet#2');

    const mesh = value<MeshData>(reply.results[2]!);
    const faceSlots = [...mesh.faceNames];
    expect(faceSlots.every((s) => s !== UNNAMED)).toBe(true);
    expect([...mesh.edgeNames].every((s) => s !== UNNAMED)).toBe(true);
    const faceNames = faceSlots.map((s) => reply.names[s]);
    expect(faceNames).toEqual(second.bodies[0]!.names!.faces.map((f) => f.name));
    expect(faceNames).toContain('fillet#2:round:r1');
    // Picking a triangle of the round gives its name.
    const round = faceNames.indexOf('fillet#2:round:r1') + 1;
    const triangle = [...mesh.triangleFaces].indexOf(round);
    expect(faceNameOfTriangle(mesh, reply.names, triangle)).toBe('fillet#2:round:r1');

    // keep: false released the first body; the second is kept.
    const leaks = service.leaks().map((s) => s.id);
    expect(leaks).not.toContain(first.bodies[0]!.shape);
    expect(leaks).toContain(second.bodies[0]!.shape);
    await service.release([second.bodies[0]!.shape]);
  });

  it('a failed feature passes its input through, and the batch does not release it', async () => {
    const made = await run([{ op: 'feature', bodies: [], feature: block }]);
    const body = value<FeatureOutcome>(made.results[0]!).bodies[0]!.shape;
    const reply = await run([
      {
        op: 'feature',
        bodies: [{ id: 'extrude#1', shape: body }],
        keep: false,
        feature: {
          ...fillet,
          edges: [{ id: 'r1', ref: { faces: ['extrude#1:side:e1', 'extrude#1:side:e9'] } }],
        },
      },
      { op: 'feature', bodies: { result: 0 }, feature: fillet, keep: false },
    ]);
    const failed = value<FeatureOutcome>(reply.results[0]!);
    expect(failed).toMatchObject({
      ok: false,
      created: [],
      changed: [],
      bodies: [{ id: 'extrude#1', shape: body }],
    });
    expect(failed.errors).toMatchObject([
      { code: 'lost', ref: 'r1', missing: ['extrude#1:side:e9'] },
    ]);
    // The next feature still ran on the passed-through body.
    expect(value<FeatureOutcome>(reply.results[1]!)).toMatchObject({
      ok: true,
      changed: ['extrude#1'],
    });
    expect(service.leaks().map((s) => s.id)).toContain(body);
    await service.release([body]);
  });

  it('a malformed feature is that feature error, a malformed op is invalid-op', async () => {
    const reply = await run([
      { op: 'feature', bodies: [], feature: { ...block, mode: 'sideways' as 'new' } },
      { op: 'feature', bodies: [] } as unknown as KernelOp,
      { op: 'feature', bodies: null, feature: block } as unknown as KernelOp,
    ]);
    expect(value<FeatureOutcome>(reply.results[0]!).errors).toMatchObject([{ code: 'invalid' }]);
    expect(reply.results[1]).toMatchObject({ ok: false, error: { code: 'invalid-op' } });
    expect(reply.results[2]).toMatchObject({ ok: false, error: { code: 'invalid-op' } });
  });

  it('chains body sets: { result } bodies, { result, body } shapes, and keep: false', async () => {
    const beside: ExtrudeInput = {
      ...block,
      id: 'extrude#2',
      profile: profile(XY, rectangle(20, 0, 60, 30)),
    };
    const reply = await run([
      { op: 'feature', bodies: [], feature: block, keep: false },
      // Overlaps the block: a second body, not an error.
      { op: 'feature', bodies: { result: 0 }, feature: beside, keep: false },
      { op: 'properties', shape: { result: 1, body: 'extrude#2' } },
      // Two bodies: a bare { result } names no one shape.
      { op: 'properties', shape: { result: 1 } },
      { op: 'properties', shape: { result: 1, body: 'extrude#9' } },
      { op: 'feature', bodies: { result: 2 }, feature: fillet },
      { op: 'feature', bodies: { result: 1 }, feature: { ...beside, id: 'extrude#3' } },
    ]);
    const second = value<FeatureOutcome>(reply.results[1]!);
    expect(second.bodies.map((b) => b.id)).toEqual(['extrude#1', 'extrude#2']);
    expect(second.created).toEqual(['extrude#2']);
    expect(value<{ volume: number }>(reply.results[2]!).volume).toBeCloseTo(24_000, 6);
    expect(reply.results[3]).toMatchObject({ ok: false, error: { code: 'invalid-op' } });
    expect(reply.results[4]).toMatchObject({ ok: false, error: { code: 'invalid-op' } });
    // { result } bodies of an op that is not a feature.
    expect(reply.results[5]).toMatchObject({ ok: false, error: { code: 'invalid-op' } });
    const third = value<FeatureOutcome>(reply.results[6]!);
    expect(third.bodies.map((b) => b.id)).toEqual(['extrude#1', 'extrude#2', 'extrude#3']);
    expect(third).toMatchObject({ created: ['extrude#3'], changed: [], consumed: [] });
    // keep: false released both bodies of op 1; only the body op 6 made is kept.
    const made = third.bodies[2]!.shape;
    const leaks = service.leaks().map((s) => s.id);
    for (const b of second.bodies) expect(leaks).not.toContain(b.shape);
    expect(leaks).toEqual([made]);
    await service.release([made]);
  });

  it('resolve and pick work on names', async () => {
    const reply = await run([
      { op: 'feature', bodies: [], feature: block, keep: false },
      {
        op: 'resolve',
        shape: { result: 0 },
        refs: [
          { face: 'extrude#1:cap:end' },
          { faces: ['extrude#1:side:e1', 'extrude#1:side:e2'] },
          { face: 'extrude#1:side:e9' },
        ],
      },
      { op: 'topology', shape: { result: 0 } },
    ]);
    const { results } = value<{ results: unknown[] }>(reply.results[1]!);
    expect(results[0]).toMatchObject({
      ok: true,
      via: 'exact',
      geometry: { kind: 'plane', direction: [0, 0, 1] },
    });
    expect(results[1]).toMatchObject({
      ok: true,
      geometry: { kind: 'line', origin: expect.any(Array) },
    });
    expect(results[2]).toEqual({ ok: false, status: 'lost', missing: ['extrude#1:side:e9'] });

    const again = await run([
      { op: 'feature', bodies: [], feature: block, keep: false },
      { op: 'pick', shape: { result: 0 }, kind: 'face', index: 1 },
      { op: 'pick', shape: { result: 0 }, kind: 'edge', index: 1 },
      { op: 'pick', shape: { result: 0 }, kind: 'vertex', index: 1 },
    ]);
    const face = value<{ ref: unknown }>(again.results[1]!).ref;
    const edge = value<{ ref: { faces: string[] } }>(again.results[2]!).ref;
    expect(face).toEqual({ face: expect.stringMatching(/^extrude#1:/) });
    expect(edge.faces).toHaveLength(2);
    // A block corner: the three faces around it, sorted, and no ordinal (no other vertex has them).
    const vertex = value<{ ref: { faces: string[]; ordinal?: number } }>(again.results[3]!).ref;
    expect(vertex.faces).toHaveLength(3);
    expect(vertex.faces).toEqual([...vertex.faces].sort());
    expect(vertex.ordinal).toBeUndefined();
  });

  it('meshes of raw shapes stay unnamed', async () => {
    const reply = await run([
      { op: 'profile', frame: XY, loops: [{ entities: circle([0, 0], 1) }], keep: false },
      { op: 'extrude', profile: { result: 0 }, distance: 1, keep: false },
      { op: 'tessellate', shape: { result: 1 } },
    ]);
    const mesh = value<MeshData>(reply.results[2]!);
    expect([...mesh.faceNames].every((s) => s === UNNAMED)).toBe(true);
    expect(reply.names).toEqual([]);
  });
});
