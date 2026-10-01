// The kernel service in Node: batches, errors as data, generation
// cancellation, recycling and leak warnings. One service for the file; the
// recycle tests replace its instance, which is what recycling is for.

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Kernel } from './kernel';
import { createNodeService, nodeLoader } from './node';
import type { KernelOp, ShapeRef } from './ops';
import {
  collectTransferables,
  KernelService,
  yieldToEventLoop,
  type BatchReply,
  type KernelStatus,
  type RecycleReport,
} from './service';
import type { Frame, MeshData, ShapeId } from './types';

let service: KernelService;
let generation = 0;
const statuses: KernelStatus[] = [];
let yieldHook: (() => void) | null = null;
/** Unregister functions of replay hooks, run after each test even when it fails. */
const unhook: Array<() => void> = [];

beforeAll(async () => {
  service = await createNodeService({
    // Lets a test act between two ops of a running batch, deterministically.
    yieldToEventLoop: async () => {
      const hook = yieldHook;
      if (hook) hook();
      await yieldToEventLoop();
    },
  });
  service.onStatus((s) => statuses.push(s));
}, 60_000);

afterEach(async () => {
  yieldHook = null;
  for (const off of unhook.splice(0)) off();
  await service.idle();
  service.configure({ heapThresholdBytes: 1024 ** 3, autoRecycle: true, debug: false });
  statuses.length = 0;
});

const XY: Frame = { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] };
const square = {
  entities: [
    { kind: 'line', start: [0, 0], end: [10, 0] },
    { kind: 'line', start: [10, 0], end: [10, 10] },
    { kind: 'line', start: [10, 10], end: [0, 10] },
    { kind: 'line', start: [0, 10], end: [0, 0] },
  ],
} as const;

function run<const T extends readonly KernelOp[]>(ops: T, g = ++generation) {
  return service.run({ generation: g, ops });
}

/** Release every shape the batch kept, so each test starts from an empty arena. */
async function cleanup(reply: BatchReply): Promise<void> {
  const shapes: ShapeRef[] = [];
  for (const r of reply.results as readonly { ok: boolean; value?: unknown }[]) {
    const s = (r.value as { shape?: ShapeId } | undefined)?.shape;
    if (r.ok && typeof s === 'number' && service.kernel.has(s)) shapes.push(s);
  }
  if (shapes.length > 0) await run([{ op: 'release', shapes }]);
}

describe('batches', () => {
  it('runs a whole chain in one round trip, results typed per op', async () => {
    const before = service.kernel.shapeCount;
    const reply = await run([
      { op: 'profile', frame: XY, loops: [square], featureId: 'sketch#1', keep: false },
      { op: 'extrude', profile: { result: 0 }, distance: 10, featureId: 'extrude#1', keep: false },
      { op: 'cylinder', radius: 2, height: 20, at: [5, 5, -5], keep: false },
      { op: 'boolean', kind: 'cut', shape: { result: 1 }, tools: [{ result: 2 }], keep: false },
      { op: 'fillet', shape: { result: 3 }, edges: [1], radius: 1, featureId: 'fillet#1' },
      { op: 'tessellate', shape: { result: 4 }, deflection: { linear: 0.2 } },
      { op: 'topology', shape: { result: 4 } },
      { op: 'properties', shape: { result: 4 } },
    ]);
    expect(reply.status).toBe('done');
    expect(reply.generation).toBe(generation);
    expect(reply.instance).toBe(service.instance);
    expect(reply.completedOps).toBe(8);
    expect(reply.names).toEqual([]);
    const [profile, extrude, , cut, fillet, mesh, topology, props] = reply.results;
    expect(reply.results.every((r) => r.ok)).toBe(true);
    if (!extrude.ok || !cut.ok || !fillet.ok || !mesh.ok || !topology.ok || !props.ok) return;
    expect(profile.featureId).toBe('sketch#1');
    expect(extrude.value.sides[0]).toHaveLength(4);
    expect(cut.value.history.length).toBeGreaterThan(0);
    expect(fillet.featureId).toBe('fillet#1');
    expect(mesh.value.faceRanges.length / 2).toBe(topology.value.faces.length);
    expect(mesh.value.edgeRanges.length / 2).toBe(topology.value.edges.length);
    expect(props.value.volume).toBeLessThan(1000 - Math.PI * 4 * 10);
    expect(props.value.valid).toBe(true);
    expect(reply.results.every((r) => r.ms >= 0)).toBe(true);
    // keep: false shapes are released at the end; only the fillet stays.
    expect(service.kernel.shapeCount).toBe(before + 1);
    expect(service.kernel.has(fillet.value.shape)).toBe(true);
    expect(service.kernel.liveShapes().at(-1)).toMatchObject({
      id: fillet.value.shape,
      operation: 'fillet',
      featureId: 'fillet#1',
      generation,
    });
    await cleanup(reply);
    expect(service.kernel.shapeCount).toBe(before);
  });

  it('an empty batch is done at once', async () => {
    const reply = await run([]);
    expect(reply).toMatchObject({ status: 'done', results: [], completedOps: 0 });
  });

  it('release reports released and unknown ids', async () => {
    const made = await run([{ op: 'box', size: [1, 1, 1] }]);
    const id = made.results[0].ok ? made.results[0].value.shape : (0 as ShapeId);
    const reply = await run([{ op: 'release', shapes: [id, id, 424242 as ShapeId] }]);
    expect(reply.results[0]).toMatchObject({
      ok: true,
      value: { released: [id], unknown: [id, 424242] },
    });
  });

  it('release() outside a batch is never cancelled and leaves the generations alone', async () => {
    const made = await run([
      { op: 'box', size: [1, 1, 1] },
      { op: 'box', size: [2, 2, 2] },
    ]);
    const ids = made.results.map((r) => (r.ok ? r.value.shape : (0 as ShapeId)));
    service.cancel();
    const released = service.release([ids[0]!, ids[1]!, 424242 as ShapeId]);
    // A newer request queued behind it does not cancel it either.
    const newer = run([{ op: 'box', size: [1, 1, 1], keep: false }]);
    expect(await released).toEqual({ released: ids, unknown: [424242] });
    expect((await newer).status).toBe('done');
    // The release took no generation: the newest is still the batch's.
    expect(service.stats().generation).toBe(made.generation + 1);
    expect(service.kernel.shapeCount).toBe(0);
    await expect(service.release(['1'] as never)).rejects.toThrow(/integer shape ids/);
    await expect(service.release(null as never)).rejects.toThrow(/integer shape ids/);
  });

  it('collects every mesh buffer for transfer, nothing else', async () => {
    const reply = await run([
      { op: 'box', size: [1, 1, 1], keep: false },
      { op: 'tessellate', shape: { result: 0 } },
      { op: 'tessellate', shape: { result: 0 } },
      { op: 'topology', shape: { result: 0 } },
    ]);
    const buffers = collectTransferables(reply);
    expect(buffers).toHaveLength(22);
    expect(new Set(buffers).size).toBe(22);
    const mesh = reply.results[1].ok ? (reply.results[1].value as MeshData) : null;
    expect(buffers).toContain(mesh!.positions.buffer);
    expect(buffers).toContain(mesh!.edgeFragile.buffer);
  });
});

describe('errors are data', () => {
  it('invalid ops fail alone; the rest of the batch runs', async () => {
    const before = service.kernel.shapeCount;
    const reply = await run([
      { op: 'teleport' } as unknown as KernelOp,
      null as unknown as KernelOp,
      { op: 'box', size: [1, 1] } as unknown as KernelOp,
      { op: 'box', size: [1, 1, 1], featureId: 7 } as unknown as KernelOp,
      { op: 'fillet', shape: { result: 'x' }, edges: [1], radius: 1 } as unknown as KernelOp,
      {
        op: 'profile',
        frame: XY,
        loops: [{ entities: [{ kind: 'spline' }] }],
      } as unknown as KernelOp,
      { op: 'box', size: [1, 1, 1], featureId: 'box#1', keep: false },
    ]);
    expect(reply.status).toBe('done');
    const failures = reply.results.slice(0, 6);
    for (const r of failures) {
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('invalid-op');
    }
    const messages = failures.map((r) => (r.ok ? '' : r.error.message));
    expect(messages[0]).toMatch(/unknown op "teleport"/);
    expect(messages[1]).toMatch(/must be an object/);
    expect(messages[2]).toMatch(/op\.size must be \[number, number, number\]/);
    expect(messages[3]).toMatch(/op\.featureId must be a string/);
    expect(messages[4]).toMatch(/op\.shape must be a shape id/);
    expect(messages[5]).toMatch(/kind must be line, arc, circle or bezier/);
    expect(reply.results[6]).toMatchObject({ ok: true, op: 'box', featureId: 'box#1' });
    expect(service.kernel.shapeCount).toBe(before);
  });

  it('kernel failures carry the operation, the OCCT exception and the feature id', async () => {
    const reply = await run([
      { op: 'box', size: [1e-12, 1, 1], featureId: 'box#2' },
      { op: 'cylinder', radius: 5, height: 10, keep: false },
      { op: 'fillet', shape: { result: 1 }, edges: [2], radius: 1, featureId: 'fillet#2' },
      { op: 'box', size: [10, 10, 10], keep: false },
      { op: 'fillet', shape: { result: 3 }, edges: [1], radius: 50 },
      { op: 'fillet', shape: { result: 3 }, edges: [99], radius: 1 },
    ]);
    const [box, , seam, , big, badEdge] = reply.results;
    expect(box).toMatchObject({
      ok: false,
      op: 'box',
      featureId: 'box#2',
      error: {
        code: 'kernel',
        operation: 'box',
        occtType: 'Standard_DomainError',
        featureId: 'box#2',
      },
    });
    expect(seam).toMatchObject({
      ok: false,
      error: {
        code: 'kernel',
        operation: 'fillet',
        occtType: 'Standard_Failure',
        occtMessage: expect.stringMatching(/no suitable edges/),
        featureId: 'fillet#2',
      },
    });
    expect(big).toMatchObject({
      ok: false,
      error: { code: 'kernel', message: expect.stringMatching(/fillet failed/) },
    });
    expect(badEdge).toMatchObject({ ok: false, error: { code: 'invalid-argument' } });
    expect(service.kernel.shapeCount).toBe(0);
  });

  it('references: unknown shapes, failed dependencies, bad and shapeless results', async () => {
    const reply = await run([
      { op: 'topology', shape: 987654 as ShapeId },
      { op: 'box', size: [0, 1, 1] },
      { op: 'fillet', shape: { result: 1 }, edges: [1], radius: 1 },
      { op: 'extrude', profile: { result: 2 }, distance: 1 },
      { op: 'topology', shape: { result: 9 } },
      { op: 'topology', shape: { result: 5 } },
      { op: 'topology', shape: { result: 0 } },
      { op: 'box', size: [1, 1, 1], keep: false },
      { op: 'release', shapes: [{ result: 7 }] },
      { op: 'topology', shape: { result: 7 } },
      { op: 'properties', shape: { result: 8 } },
    ]);
    const code = (i: number) => {
      const r = reply.results[i]!;
      return r.ok ? 'ok' : r.error.code;
    };
    expect(code(0)).toBe('unknown-shape');
    expect(code(1)).toBe('invalid-argument');
    expect(code(2)).toBe('dependency');
    expect(code(3)).toBe('dependency'); // a chain of failures
    expect(code(4)).toBe('invalid-op'); // not an earlier op
    expect(code(5)).toBe('invalid-op'); // itself
    expect(code(6)).toBe('dependency');
    expect(code(8)).toBe('ok');
    expect(code(9)).toBe('unknown-shape'); // released within the batch
    expect(code(10)).toBe('invalid-op'); // a release makes no shape
    const r10 = reply.results[10]!;
    expect(r10.ok ? '' : r10.error.message).toMatch(/op 8 \(release\) made no shape/);
    expect(service.kernel.shapeCount).toBe(0);
  });

  it('a malformed envelope is a programming error and rejects', async () => {
    expect(() => service.run(null as never)).toThrow(TypeError);
    expect(() => service.run({ generation: 1.5, ops: [] })).toThrow(/integer generation/);
    expect(() => service.run({ generation: 1, ops: {} as never })).toThrow(/ops array/);
  });
});

describe('cancellation by generation', () => {
  const boxes = (n: number): KernelOp[] =>
    Array.from({ length: n }, () => ({ op: 'box', size: [1, 1, 1] }) as KernelOp);

  it('a newer request supersedes a running batch between two ops', async () => {
    const before = service.kernel.shapeCount;
    let yields = 0;
    let newer: Promise<BatchReply> | null = null;
    yieldHook = () => {
      if (++yields === 4) newer = run([{ op: 'box', size: [2, 2, 2], keep: false }]);
    };
    const old = await run(boxes(20));
    expect(old.status).toBe('cancelled');
    expect(old.completedOps).toBe(3);
    expect(old.results).toEqual([]);
    // Everything the cancelled batch made is released.
    expect(service.kernel.shapeCount).toBe(before);
    const next = await newer!;
    expect(next.status).toBe('done');
    expect(next.generation).toBe(old.generation + 1);
  });

  it('cancel() stops the running batch; a later generation runs normally', async () => {
    let yields = 0;
    yieldHook = () => {
      if (++yields === 2) service.cancel();
    };
    const reply = await run(boxes(10));
    expect(reply).toMatchObject({ status: 'cancelled', completedOps: 1 });
    expect(service.stats().cancelledThrough).toBe(reply.generation);
    expect(service.kernel.shapeCount).toBe(0);
    const after = await run([{ op: 'box', size: [1, 1, 1], keep: false }]);
    expect(after.status).toBe('done');
    // Re-using a cancelled generation is cancelled at once.
    const reused = await run([{ op: 'box', size: [1, 1, 1] }], reply.generation);
    expect(reused).toMatchObject({ status: 'cancelled', completedOps: 0 });
    // An empty batch at a stale generation is cancelled too.
    const empty = await run([], reply.generation);
    expect(empty).toMatchObject({ status: 'cancelled', completedOps: 0, results: [] });
  });

  it('queued batches that went stale are abandoned without running', async () => {
    const g = ++generation;
    const a = run(boxes(3), g);
    const b = run(boxes(3), g);
    const c = run([{ op: 'box', size: [1, 1, 1], keep: false }], g + 1);
    generation = g + 1;
    const [ra, rb, rc] = await Promise.all([a, b, c]);
    expect(ra).toMatchObject({ status: 'cancelled', completedOps: 0 });
    expect(rb).toMatchObject({ status: 'cancelled', completedOps: 0 });
    expect(rc.status).toBe('done');
    expect(service.kernel.shapeCount).toBe(0);
  });

  it('a newer request arriving during the last op cancels the batch and releases its shapes', async () => {
    const before = service.kernel.shapeCount;
    let yields = 0;
    let newer: Promise<BatchReply> | null = null;
    // Yields 1 to 3 come before the three ops; yield 4 follows the last one.
    yieldHook = () => {
      if (++yields === 4) newer = run([{ op: 'box', size: [2, 2, 2], keep: false }]);
    };
    const old = await run(boxes(3));
    expect(old).toMatchObject({ status: 'cancelled', completedOps: 3, results: [] });
    expect(service.kernel.shapeCount).toBe(before);
    expect((await newer!).status).toBe('done');
  });

  it('batches with the same generation do not cancel each other, and run in order', async () => {
    const g = ++generation;
    const order: number[] = [];
    const a = run(boxes(3), g).then((r) => (order.push(1), r));
    const b = run(boxes(2), g).then((r) => (order.push(2), r));
    const [ra, rb] = await Promise.all([a, b]);
    expect([ra.status, rb.status]).toEqual(['done', 'done']);
    expect(order).toEqual([1, 2]);
    expect(service.stats()).toMatchObject({ generation: g, shapeCount: 5, queued: 0 });
    await cleanup(ra);
    await cleanup(rb);
    expect(service.kernel.shapeCount).toBe(0);
  });
});

describe('recycling', () => {
  it('recycles at the heap threshold at an idle point, then runs replay hooks', async () => {
    const box = await run([{ op: 'box', size: [1, 1, 1] }]);
    const oldId = box.results[0].ok ? box.results[0].value.shape : (0 as ShapeId);
    const instance = service.instance;
    const replays: Array<[Kernel, RecycleReport]> = [];
    unhook.push(
      service.onRecycle((kernel, report) => {
        replays.push([kernel, report]);
        kernel.box(1, 1, 1); // a replay rebuilds shapes in the new kernel
      }),
    );
    service.configure({ heapThresholdBytes: 1 });
    // Two batches submitted together: only the last one is an idle point.
    const g = ++generation;
    const [first, second] = await Promise.all([
      run([{ op: 'properties', shape: oldId }], g),
      run([{ op: 'properties', shape: oldId }], g),
    ]);
    expect(first.recycle).toBeNull();
    expect(second.recycle).toBe('heap-threshold');
    expect(first.results[0].ok && second.results[0].ok).toBe(true);
    await service.idle();

    expect(service.instance).toBe(instance + 1);
    expect(replays).toHaveLength(1);
    const [kernel, report] = replays[0]!;
    expect(kernel).toBe(service.kernel);
    expect(report).toMatchObject({
      reason: 'heap-threshold',
      instance: instance + 1,
      lostShapes: 1,
    });
    expect(report.hookErrors).toEqual([]);
    expect(report.heapBytesAfter).toBeLessThanOrEqual(report.heapBytesBefore);
    expect(statuses.map((s) => s.type)).toEqual(['recycling', 'recycled']);
    expect(statuses[1]).toMatchObject({
      type: 'recycled',
      reason: 'heap-threshold',
      lostShapes: 1,
    });
    expect(report.ms).toBeGreaterThan(0);

    // Old ids are unknown in the new instance; new ids never collide with them.
    service.configure({ heapThresholdBytes: 1024 ** 3 });
    const after = await run([
      { op: 'properties', shape: oldId },
      { op: 'box', size: [1, 1, 1] },
    ]);
    expect(after.instance).toBe(instance + 1);
    expect(after.results[0]).toMatchObject({ ok: false, error: { code: 'unknown-shape' } });
    const newId = after.results[1].ok ? after.results[1].value.shape : 0;
    expect(newId).toBeGreaterThan(oldId);
    await cleanup(after);
    service.kernel.releaseSince(0);
  }, 30_000);

  it('does not recycle when automatic recycling is off', async () => {
    service.configure({ heapThresholdBytes: 1, autoRecycle: false });
    const instance = service.instance;
    const reply = await run([{ op: 'box', size: [1, 1, 1], keep: false }]);
    expect(reply.recycle).toBeNull();
    await service.idle();
    expect(service.instance).toBe(instance);
    expect(statuses).toEqual([]);
  });

  it('recycles on request and reports hook failures', async () => {
    const instance = service.instance;
    unhook.push(
      service.onRecycle(() => {
        throw new Error('replay broke');
      }),
    );
    const report = await service.recycle();
    expect(report).toMatchObject({
      reason: 'requested',
      instance: instance + 1,
      hookErrors: ['replay broke'],
    });
    expect(service.instance).toBe(instance + 1);
  }, 30_000);

  it('a wasm trap fails the op as fatal, fails the rest of the batch, and recycles', async () => {
    const instance = service.instance;
    // Simulate an abort inside OCCT: the binding the kernel calls traps.
    const oc = service.kernel.oc as unknown as Record<string, unknown>;
    const real = oc.BRepPrimAPI_MakeCylinder;
    oc.BRepPrimAPI_MakeCylinder = function () {
      throw new WebAssembly.RuntimeError('unreachable');
    };
    try {
      const reply = await run([
        { op: 'box', size: [1, 1, 1] },
        { op: 'cylinder', radius: 1, height: 1, featureId: 'cyl#1' },
        { op: 'box', size: [1, 1, 1] },
      ]);
      expect(reply.results[0].ok).toBe(true);
      expect(reply.results[1]).toMatchObject({
        ok: false,
        error: { code: 'fatal', operation: 'cylinder', featureId: 'cyl#1' },
      });
      expect(reply.results[2]).toMatchObject({ ok: false, error: { code: 'fatal' } });
      expect(reply.recycle).toBe('fatal');
    } finally {
      oc.BRepPrimAPI_MakeCylinder = real;
    }
    await service.idle();
    expect(service.instance).toBe(instance + 1);
    expect(statuses.find((s) => s.type === 'recycled')).toMatchObject({
      reason: 'fatal',
      lostShapes: 1,
    });
    const after = await run([{ op: 'cylinder', radius: 1, height: 1, keep: false }]);
    expect(after.results[0].ok).toBe(true);
  }, 30_000);

  it('a batch queued behind a trap runs on the new instance', async () => {
    const instance = service.instance;
    const oc = service.kernel.oc as unknown as Record<string, unknown>;
    const real = oc.BRepPrimAPI_MakeCylinder;
    oc.BRepPrimAPI_MakeCylinder = function () {
      throw new WebAssembly.RuntimeError('unreachable');
    };
    const g = ++generation;
    try {
      // Same generation, so the second batch is not stale: it waits behind the first.
      const [trapped, next] = await Promise.all([
        run([{ op: 'cylinder', radius: 1, height: 1 }], g),
        run([{ op: 'box', size: [1, 1, 1], keep: false }], g),
      ]);
      expect(trapped).toMatchObject({ instance, recycle: 'fatal' });
      expect(trapped.results[0]).toMatchObject({ ok: false, error: { code: 'fatal' } });
      expect(next).toMatchObject({ status: 'done', instance: instance + 1, recycle: null });
      expect(next.results[0].ok).toBe(true);
    } finally {
      oc.BRepPrimAPI_MakeCylinder = real;
    }
    await service.idle();
    // One recycle, not a second one from the task queued at the trap.
    expect(service.instance).toBe(instance + 1);
    expect(statuses.filter((s) => s.type === 'recycled')).toHaveLength(1);
  }, 30_000);

  it('a failed recycle fails the next batch as fatal, and the one after recycles again', async () => {
    // A service of its own, whose second instance cannot be made.
    const loader = await nodeLoader();
    let creations = 0;
    const own = await KernelService.create({
      createInstance: async () => {
        if (++creations === 2) throw new Error('out of memory');
        return loader.instantiate();
      },
    });
    const seen: KernelStatus[] = [];
    own.onStatus((s) => seen.push(s));
    const oc = own.kernel.oc as unknown as Record<string, unknown>;
    oc.BRepPrimAPI_MakeCylinder = function () {
      throw new WebAssembly.RuntimeError('unreachable');
    };
    const g = 1;
    const [trapped, failed, recovered] = await Promise.all([
      own.run({ generation: g, ops: [{ op: 'cylinder', radius: 1, height: 1 }] }),
      own.run({
        generation: g,
        ops: [
          { op: 'box', size: [1, 1, 1] },
          { op: 'release', shapes: [1 as ShapeId] },
        ],
      }),
      own.run({ generation: g, ops: [{ op: 'box', size: [1, 1, 1], keep: false }] }),
    ]);
    expect(trapped).toMatchObject({ instance: 1, recycle: 'fatal' });
    expect(trapped.results[0]).toMatchObject({ ok: false, error: { code: 'fatal' } });
    // The recycle before it failed: it ran on the abandoned instance, and every
    // op, a release included, is fatal.
    expect(failed).toMatchObject({ status: 'done', instance: 1, recycle: 'fatal' });
    expect(failed.results[0]).toMatchObject({ ok: false, error: { code: 'fatal' } });
    expect(failed.results[1]).toMatchObject({ ok: false, error: { code: 'fatal' } });
    expect(recovered).toMatchObject({ status: 'done', instance: 2, recycle: null });
    expect(recovered.results[0].ok).toBe(true);
    await own.idle();
    expect(seen.map((s) => s.type)).toEqual(['recycling', 'error', 'recycling', 'recycled']);
    expect(seen[1]).toMatchObject({ type: 'error', message: 'recycle failed: out of memory' });
    expect(own.instance).toBe(2);
    expect(creations).toBe(3);
  }, 30_000);
});

describe('leak detection', () => {
  it('warns once in debug mode when too many shapes are live, with provenance', async () => {
    // Applies to the running kernel at once, and to kernels made by recycles.
    service.configure({ debug: true, maxLiveShapes: 2 });
    const reply = await run([
      { op: 'box', size: [1, 1, 1], featureId: 'a' },
      { op: 'box', size: [1, 1, 1], featureId: 'b' },
      { op: 'box', size: [1, 1, 1], featureId: 'c' },
    ]);
    await run([{ op: 'box', size: [1, 1, 1], keep: false }]);
    const warnings = statuses.filter((s) => s.type === 'leak-warning');
    expect(warnings).toHaveLength(1);
    const w = warnings[0]!;
    if (w.type !== 'leak-warning') return;
    expect(w.liveShapes).toBe(3);
    expect(w.oldest.map((r) => r.featureId)).toEqual(['a', 'b', 'c']);
    expect(w.oldest[0]!.stack).toContain('shape created');
    expect(service.leaks().map((r) => r.featureId)).toEqual(['a', 'b', 'c']);

    // Back under the limit re-arms the warning.
    await cleanup(reply);
    expect(service.leaks()).toEqual([]);
    await run([
      { op: 'box', size: [1, 1, 1] },
      { op: 'box', size: [1, 1, 1] },
      { op: 'box', size: [1, 1, 1] },
    ]).then(cleanup);
    expect(statuses.filter((s) => s.type === 'leak-warning')).toHaveLength(2);

    // A recycled kernel keeps the debug setting.
    await service.recycle();
    await run([{ op: 'box', size: [1, 1, 1], featureId: 'd' }]).then(async (r) => {
      expect(service.leaks()[0]!.stack).toContain('shape created');
      await cleanup(r);
    });
  }, 30_000);

  it('stats report the service state', async () => {
    const s = service.stats();
    expect(s).toMatchObject({ instance: service.instance, queued: 0, shapeCount: 0 });
    expect(s.heapBytes).toBeGreaterThanOrEqual(128 * 1024 * 1024);
    expect(s.heapThresholdBytes).toBe(1024 ** 3);
  });
});
