// Goldens for what scripted features need from the kernel (ADR 0010 decision 6, T7.2c):
// `combine` (booleans between bodies), `move` (a rigid motion of bodies in place), fillets and
// chamfers named by their edges' faces, and the synchronous session on `KernelService`.

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { applyFeature, type ExtrudeInput, type FeatureBody } from './features';
import { XY, apply, build, faceNames, named, profile, rectangle } from './fixtures/parts';
import type { Kernel } from './kernel';
import { createNodeService } from './node';
import { KernelService } from './service';
import type { ShapeId } from './types';

let service: KernelService;
let k: Kernel;
let generation = 0;

beforeAll(async () => {
  service = await createNodeService();
  k = service.kernel;
}, 60_000);

afterEach(async () => {
  await service.idle();
});

const PI = Math.PI;

const blockAt = (id: string, x: number, size = 10): ExtrudeInput => ({
  kind: 'extrude',
  id,
  profile: profile(XY, rectangle(x, 0, x + size, size)),
  extent: { type: 'blind', distance: size },
  mode: 'new',
});

/** Two new bodies: a 10 mm cube at the origin and one starting at `x`. */
function twoBlocks(x: number): FeatureBody[] {
  const out = build(k, [blockAt('extrude#1', 0), blockAt('extrude#2', x)]);
  return out.bodies;
}

/** Checks the fields given: volume, face count, bounding box. */
function golden(
  shape: ShapeId,
  expected: { volume: number; faces?: number; min?: number[]; max?: number[] },
): void {
  const p = k.properties(shape);
  expect(p.valid, 'BRepCheck_Analyzer').toBe(true);
  expect(p.volume).toBeCloseTo(expected.volume, 6);
  if (expected.faces !== undefined) expect(p.faces).toBe(expected.faces);
  for (let i = 0; i < 3; i++) {
    if (expected.min) expect(p.boundingBox!.min[i]).toBeCloseTo(expected.min[i]!, 4);
    if (expected.max) expect(p.boundingBox!.max[i]).toBeCloseTo(expected.max[i]!, 4);
  }
}

const release = (bodies: readonly { shape: ShapeId }[]) => {
  for (const b of bodies) if (k.has(b.shape)) k.release(b.shape);
};

describe('combine', () => {
  it('add: overlapping tool bodies fuse into the scope body and are consumed', () => {
    const bodies = twoBlocks(5);
    const out = apply(k, bodies, {
      kind: 'combine',
      id: 'scriptop#1',
      tools: ['extrude#2'],
      mode: 'add',
    });
    expect(out.errors).toEqual([]);
    expect(out.consumed).toEqual(['extrude#2']);
    expect(out.changed).toEqual(['extrude#1']);
    expect(out.created).toEqual([]);
    golden(out.bodies[0]!.shape, {
      volume: 1500,
      // Coplanar faces of the two cubes stay apart: the fuse keeps every face's history.
      faces: 14,
      min: [0, 0, 0],
      max: [15, 10, 10],
    });
    // Faces keep the names of the bodies they came from; the feature names none.
    expect(faceNames(named(k, out.bodies[0]!.shape)).some((n) => n.startsWith('scriptop'))).toBe(
      false,
    );
    release(out.bodies);
    release(bodies);
  });

  it('subtract and intersect: the tool is consumed, the target cut down', () => {
    const bodies = twoBlocks(5);
    const cut = apply(k, bodies, {
      kind: 'combine',
      id: 'scriptop#2',
      tools: ['extrude#2'],
      mode: 'subtract',
    });
    expect(cut.errors).toEqual([]);
    expect(cut.bodies.map((b) => b.id)).toEqual(['extrude#1']);
    golden(cut.bodies[0]!.shape, { volume: 500, faces: 6 });
    const common = apply(k, bodies, {
      kind: 'combine',
      id: 'scriptop#3',
      tools: ['extrude#2'],
      mode: 'intersect',
      scope: ['extrude#1'],
    });
    expect(common.errors).toEqual([]);
    golden(common.bodies[0]!.shape, { volume: 500, faces: 6 });
    release(cut.bodies);
    release(common.bodies);
    release(bodies);
  });

  it('an added tool that touches nothing stays the body it was, unchanged and not made', () => {
    const bodies = twoBlocks(50);
    const out = apply(k, bodies, {
      kind: 'combine',
      id: 'scriptop#4',
      tools: ['extrude#2'],
      mode: 'add',
    });
    expect(out.ok).toBe(true);
    expect(out.created).toEqual([]);
    expect(out.changed).toEqual([]);
    expect(out.consumed).toEqual([]);
    expect(out.bodies.find((b) => b.id === 'extrude#2')!.shape).toBe(bodies[1]!.shape);
    expect(out.warnings.map((w) => w.code)).toEqual(['detached']);
    release(bodies);
  });

  it('refuses unknown tools, a tool in its own scope, and malformed input', () => {
    const bodies = twoBlocks(5);
    const lost = applyFeature(k, bodies, {
      kind: 'combine',
      id: 'scriptop#5',
      tools: ['extrude#9'],
      mode: 'add',
    });
    expect(lost.errors[0]).toMatchObject({ code: 'lost', ref: 'tools', missing: ['extrude#9'] });
    const both = applyFeature(k, bodies, {
      kind: 'combine',
      id: 'scriptop#5',
      tools: ['extrude#2'],
      scope: ['extrude#2'],
      mode: 'add',
    });
    expect(both.errors[0]).toMatchObject({ code: 'invalid', ref: 'scope' });
    for (const bad of [
      { tools: [], mode: 'add' },
      { tools: ['extrude#2', 'extrude#2'], mode: 'add' },
      { tools: ['extrude#2'], mode: 'new' },
      { tools: [3], mode: 'add' },
    ]) {
      const out = applyFeature(k, bodies, {
        kind: 'combine',
        id: 'scriptop#6',
        ...bad,
      } as never);
      expect(out.errors[0]?.code, JSON.stringify(bad)).toBe('invalid');
    }
    release(bodies);
  });
});

describe('move', () => {
  it('moves a body in place, every face keeping its name', () => {
    const bodies = twoBlocks(20);
    const before = faceNames(named(k, bodies[1]!.shape)).sort();
    const out = apply(k, bodies, {
      kind: 'move',
      id: 'scriptop#1',
      bodies: ['extrude#2'],
      motion: { kind: 'translate', vector: [0, 0, 5] },
    });
    expect(out.errors).toEqual([]);
    expect(out.changed).toEqual(['extrude#2']);
    const moved = out.bodies.find((b) => b.id === 'extrude#2')!;
    golden(moved.shape, { volume: 1000, faces: 6, min: [20, 0, 5], max: [30, 10, 15] });
    expect(faceNames(named(k, moved.shape)).sort()).toEqual(before);
    // The other body keeps its shape.
    expect(out.bodies[0]!.shape).toBe(bodies[0]!.shape);
    const turned = apply(k, bodies, {
      kind: 'move',
      id: 'scriptop#2',
      bodies: ['extrude#1'],
      motion: { kind: 'rotate', axis: { origin: [0, 0, 0], direction: [0, 0, 1] }, angle: PI },
    });
    golden(turned.bodies[0]!.shape, { volume: 1000, min: [-10, -10, 0], max: [0, 0, 10] });
    const mirrored = apply(k, bodies, {
      kind: 'move',
      id: 'scriptop#3',
      bodies: ['extrude#1'],
      motion: { kind: 'mirror', plane: { origin: [0, 0, 0], normal: [1, 0, 0] } },
    });
    golden(mirrored.bodies[0]!.shape, { volume: 1000, min: [-10, 0, 0], max: [0, 10, 10] });
    release([...out.bodies, ...turned.bodies, ...mirrored.bodies]);
    release(bodies);
  });

  it('refuses a body that is not there and a malformed motion', () => {
    const bodies = twoBlocks(20);
    const lost = applyFeature(k, bodies, {
      kind: 'move',
      id: 'scriptop#4',
      bodies: ['extrude#7'],
      motion: { kind: 'translate', vector: [1, 0, 0] },
    });
    expect(lost.errors[0]).toMatchObject({ code: 'lost', ref: 'bodies' });
    for (const motion of [
      { kind: 'translate', vector: [1, 0, Number.NaN] },
      { kind: 'rotate', axis: { origin: [0, 0, 0], direction: [0, 0, 1] } },
      { kind: 'scale', factor: 2 },
    ]) {
      const out = applyFeature(k, bodies, {
        kind: 'move',
        id: 'scriptop#5',
        bodies: ['extrude#1'],
        motion,
      } as never);
      expect(out.errors[0]?.code, JSON.stringify(motion)).toBe('invalid');
    }
    release(bodies);
  });
});

describe('blends named by faces', () => {
  it('a fillet with nameByFaces names each round by its edge faces, not its reference id', () => {
    const block = build(k, [blockAt('extrude#1', 0, 20)]).shape;
    const edge = { faces: ['extrude#1:cap:end', 'extrude#1:side:e1'] };
    const byId = apply(k, block, {
      kind: 'fillet',
      id: 'fillet#2',
      radius: 2,
      edges: [{ id: 'r1', ref: edge }],
    });
    expect(faceNames(named(k, byId.shape!))).toContain('fillet#2:round:r1');
    const byFaces = apply(k, block, {
      kind: 'fillet',
      id: 'fillet#2',
      radius: 2,
      edges: [{ id: 'r1', ref: edge }],
      nameByFaces: true,
    });
    expect(faceNames(named(k, byFaces.shape!))).toContain(
      'fillet#2:round:extrude#1:cap:end&extrude#1:side:e1',
    );
    const bevel = apply(k, block, {
      kind: 'chamfer',
      id: 'chamfer#2',
      size: { kind: 'distance', distance: 1 },
      edges: [{ id: 'r1', ref: edge }],
      nameByFaces: true,
    });
    expect(faceNames(named(k, bevel.shape!))).toContain(
      'chamfer#2:bevel:extrude#1:cap:end&extrude#1:side:e1',
    );
    const bad = applyFeature(k, [{ id: 'extrude#1', shape: block! }], {
      kind: 'fillet',
      id: 'fillet#3',
      radius: 2,
      edges: [{ id: 'r1', ref: edge }],
      nameByFaces: 'yes',
    } as never);
    expect(bad.errors[0]?.code).toBe('invalid');
    release([byId, byFaces, bevel].map((o) => ({ shape: o.shape! })));
    k.release(block!);
  });
});

describe('KernelService.session', () => {
  it('runs a function on the synchronous kernel, keeping only the shapes it names', async () => {
    const before = service.kernel.shapeCount;
    const reply = await service.session(
      { generation: ++generation, featureId: 'scripted#1' },
      (kernel) => {
        const a = applyFeature(kernel, [], blockAt('extrude#1', 0));
        const b = applyFeature(kernel, a.bodies, {
          kind: 'fillet',
          id: 'fillet#2',
          radius: 1,
          edges: [{ id: 'r1', ref: { faces: ['extrude#1:cap:end', 'extrude#1:side:e1'] } }],
        });
        return { value: b.bodies[0]!.shape, keep: [b.bodies[0]!.shape] };
      },
    );
    expect(reply.status).toBe('done');
    expect(reply.result).toMatchObject({ ok: true });
    const kept = (reply.result as { value: ShapeId }).value;
    // The intermediate block is gone; the fillet result stays, and is the caller's.
    expect(service.kernel.shapeCount).toBe(before + 1);
    expect(service.kernel.has(kept)).toBe(true);
    expect(service.leaks().find((r) => r.id === kept)?.featureId).toBe('scripted#1');
    await service.release([kept]);
    expect(service.kernel.shapeCount).toBe(before);
  });

  it('a function that throws is a failure as data, and keeps nothing', async () => {
    const before = service.kernel.shapeCount;
    const reply = await service.session({ generation: ++generation }, (kernel) => {
      applyFeature(kernel, [], blockAt('extrude#1', 0));
      throw new Error('script blew up');
    });
    expect(reply.status).toBe('done');
    expect(reply.result).toMatchObject({ ok: false, error: { message: 'script blew up' } });
    expect(service.kernel.shapeCount).toBe(before);
  });

  it('a session queued behind a newer request is cancelled without running', async () => {
    const stale = ++generation;
    ++generation;
    service.cancel(generation);
    let ran = false;
    const reply = await service.session({ generation: stale }, () => {
      ran = true;
      return { value: 1, keep: [] };
    });
    expect(reply.status).toBe('cancelled');
    expect(ran).toBe(false);
    expect(reply.result).toBeUndefined();
  });

  it('a session that finishes after a newer request arrived keeps nothing', async () => {
    const before = service.kernel.shapeCount;
    const g = ++generation;
    const reply = await service.session({ generation: g }, async (kernel) => {
      const a = applyFeature(kernel, [], blockAt('extrude#1', 0));
      service.cancel(g); // a newer regen came in while the script ran
      return { value: a.bodies[0]!.shape, keep: [a.bodies[0]!.shape] };
    });
    expect(reply.status).toBe('cancelled');
    expect(service.kernel.shapeCount).toBe(before);
  });

  it('rejects a malformed request', async () => {
    await expect(
      service.session({ generation: 1.5 }, () => ({ value: 0, keep: [] })),
    ).rejects.toThrow(TypeError);
    await expect(service.session({ generation: 1 }, 'nope' as never)).rejects.toThrow(TypeError);
  });
});
