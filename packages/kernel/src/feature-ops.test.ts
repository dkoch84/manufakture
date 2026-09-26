// The `feature`, `resolve` and `pick` ops through the kernel service, and
// meshes of named bodies with their name slots filled. One service per file.

import { beforeAll, describe, expect, it } from 'vitest';
import type { ExtrudeInput, FeatureInput, FeatureOutcome } from './features';
import { XY, circle, profile, rectangle } from './fixtures/parts';
import { faceNameOfTriangle } from './names';
import { createNodeService } from './node';
import type { KernelOp } from './ops';
import type { KernelService } from './service';
import { UNNAMED, type MeshData, type ShapeId } from './types';

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
      { op: 'feature', body: null, feature: block, keep: false },
      { op: 'feature', body: { result: 0 }, feature: fillet },
      { op: 'tessellate', shape: { result: 1 } },
    ]);
    expect(reply.status).toBe('done');
    const first = value<FeatureOutcome>(reply.results[0]!);
    const second = value<FeatureOutcome>(reply.results[1]!);
    expect(first).toMatchObject({ ok: true, created: true, featureId: 'extrude#1' });
    expect(second).toMatchObject({ ok: true, created: true, errors: [], warnings: [] });
    // The failure-free chain stamps feature ids without an explicit featureId.
    expect(reply.results[1]!.featureId).toBe('fillet#2');

    const mesh = value<MeshData>(reply.results[2]!);
    const faceSlots = [...mesh.faceNames];
    expect(faceSlots.every((s) => s !== UNNAMED)).toBe(true);
    expect([...mesh.edgeNames].every((s) => s !== UNNAMED)).toBe(true);
    const faceNames = faceSlots.map((s) => reply.names[s]);
    expect(faceNames).toEqual(second.names!.faces.map((f) => f.name));
    expect(faceNames).toContain('fillet#2:round:r1');
    // Picking a triangle of the round gives its name.
    const round = faceNames.indexOf('fillet#2:round:r1') + 1;
    const triangle = [...mesh.triangleFaces].indexOf(round);
    expect(faceNameOfTriangle(mesh, reply.names, triangle)).toBe('fillet#2:round:r1');

    // keep: false released the first body; the second is kept.
    const leaks = service.leaks().map((s) => s.id);
    expect(leaks).not.toContain(first.shape);
    expect(leaks).toContain(second.shape);
    await service.release([second.shape as ShapeId]);
  });

  it('a failed feature passes its input through, and the batch does not release it', async () => {
    const made = await run([{ op: 'feature', body: null, feature: block }]);
    const body = value<FeatureOutcome>(made.results[0]!).shape!;
    const reply = await run([
      {
        op: 'feature',
        body,
        keep: false,
        feature: {
          ...fillet,
          edges: [{ id: 'r1', ref: { faces: ['extrude#1:side:e1', 'extrude#1:side:e9'] } }],
        },
      },
      { op: 'feature', body: { result: 0 }, feature: fillet, keep: false },
    ]);
    const failed = value<FeatureOutcome>(reply.results[0]!);
    expect(failed).toMatchObject({ ok: false, created: false, shape: body });
    expect(failed.errors).toMatchObject([
      { code: 'lost', ref: 'r1', missing: ['extrude#1:side:e9'] },
    ]);
    // The next feature still ran on the passed-through body.
    expect(value<FeatureOutcome>(reply.results[1]!)).toMatchObject({ ok: true, created: true });
    expect(service.leaks().map((s) => s.id)).toContain(body);
    await service.release([body]);
  });

  it('a malformed feature is that feature error, a malformed op is invalid-op', async () => {
    const reply = await run([
      { op: 'feature', body: null, feature: { ...block, mode: 'sideways' as 'new' } },
      { op: 'feature', body: null } as unknown as KernelOp,
    ]);
    expect(value<FeatureOutcome>(reply.results[0]!).errors).toMatchObject([{ code: 'invalid' }]);
    expect(reply.results[1]).toMatchObject({ ok: false, error: { code: 'invalid-op' } });
  });

  it('resolve and pick work on names', async () => {
    const reply = await run([
      { op: 'feature', body: null, feature: block, keep: false },
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
      { op: 'feature', body: null, feature: block, keep: false },
      { op: 'pick', shape: { result: 0 }, kind: 'face', index: 1 },
      { op: 'pick', shape: { result: 0 }, kind: 'edge', index: 1 },
    ]);
    const face = value<{ ref: unknown }>(again.results[1]!).ref;
    const edge = value<{ ref: { faces: string[] } }>(again.results[2]!).ref;
    expect(face).toEqual({ face: expect.stringMatching(/^extrude#1:/) });
    expect(edge.faces).toHaveLength(2);
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
