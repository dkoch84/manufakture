// The worker protocol end to end through Comlink, in Node: the worker API is
// exposed on one end of a MessageChannel and the main-thread client talks to
// the other, so every request and reply is really structured-cloned and every
// mesh buffer really transferred. Only `new Worker()` itself is left out.

import { readFile } from 'node:fs/promises';
import * as Comlink from 'comlink';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { KernelClient, type KernelEndpoint } from './kernel-client';
import { wasmPath } from './node';
import type { KernelOp } from './ops';
import type { BatchReply, KernelStatus } from './service';
import type { Frame, MeshData } from './types';
import { createKernelWorkerApi, type KernelWorkerApi } from './worker-api';

let bytes: Uint8Array;
const fetchWasm = async () =>
  new Response(bytes.slice(), {
    headers: { 'Content-Type': 'application/wasm', 'Content-Length': String(bytes.length) },
  });

const channels: MessagePort[] = [];

/** Expose `api` on a fresh channel; returns the main-thread end. */
function connectTo(api: KernelWorkerApi): KernelEndpoint {
  const { port1, port2 } = new MessageChannel();
  channels.push(port1, port2);
  Comlink.expose(api, port1);
  return { endpoint: port2, terminate: () => port1.close() };
}

let api: ReturnType<typeof createKernelWorkerApi>;
let lastReply: BatchReply | null = null;
/** Every reply the worker sent, in order. */
const sent: BatchReply[] = [];
/** While set, replies are held back after the service has finished them. */
let replyGate: Promise<void> | null = null;
let client: KernelClient;
const statuses: KernelStatus[] = [];

beforeAll(async () => {
  bytes = new Uint8Array(await readFile(wasmPath()));
  api = createKernelWorkerApi({ source: { url: 'kernel.wasm', fetch: fetchWasm } });
  // Keep a reference to each reply the worker sends, to check the transfer.
  const run = api.run.bind(api);
  api.run = (async (request: Parameters<typeof run>[0]) => {
    const reply = await run(request);
    lastReply = reply as BatchReply;
    sent.push(reply as BatchReply);
    if (replyGate) await replyGate;
    return reply;
  }) as typeof api.run;
  client = new KernelClient(() => connectTo(api), {
    onStatus: (s) => statuses.push(s),
  });
  await client.ready;
}, 60_000);

afterAll(() => {
  client.terminate();
  for (const p of channels) p.close();
});

const XY: Frame = { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] };
const boxes = (n: number): KernelOp[] =>
  Array.from({ length: n }, () => ({ op: 'box', size: [1, 1, 1] }) as KernelOp);

/** Wait until a long batch is visibly under way in the worker (stats run between its ops). */
async function started(stats: () => Promise<{ shapeCount: number }>): Promise<void> {
  await vi.waitFor(async () => expect((await stats()).shapeCount).toBeGreaterThan(0), {
    timeout: 10_000,
    interval: 1,
  });
}

describe('start-up', () => {
  it('reports loading progress, then ready, to the subscriber', async () => {
    await vi.waitFor(() => expect(statuses.some((s) => s.type === 'ready')).toBe(true));
    const phases = statuses.flatMap((s) => (s.type === 'loading' ? [s.progress.phase] : []));
    expect(phases[0]).toBe('download');
    expect(phases.slice(-4)).toEqual(['compile', 'instantiate', 'init', 'ready']);
    const ready = statuses.find((s) => s.type === 'ready')!;
    expect(ready).toMatchObject({ type: 'ready', instance: 1 });
    const report = await client.ready;
    expect(report.instance).toBe(1);
    expect(report.ms).toBeGreaterThan(0);
    expect(report.heapBytes).toBeGreaterThanOrEqual(128 * 1024 * 1024);
  });

  it('init is idempotent', async () => {
    const again = await api.init();
    expect(again).toEqual(await client.ready);
  });

  it('eager loading starts before init, and init waits for it', async () => {
    let fetched = 0;
    const eager = createKernelWorkerApi({
      source: {
        url: 'kernel.wasm',
        fetch: async () => {
          fetched++;
          return fetchWasm();
        },
      },
      eager: true,
    });
    await vi.waitFor(() => expect(fetched).toBe(1));
    const seen: string[] = [];
    const report = await eager.init({ debug: true }, (s) => {
      seen.push(s.type);
    });
    expect(report.instance).toBe(1);
    expect(fetched).toBe(1);
    // The late subscriber still gets the latest loading state, then ready.
    await vi.waitFor(() => expect(seen).toContain('ready'));
    expect(seen[0]).toBe('loading');
    expect(eager.service).not.toBeNull();
  }, 60_000);
});

describe('round trip', () => {
  it('runs a batch and transfers the mesh buffers instead of copying them', async () => {
    const reply = await client.submit([
      {
        op: 'profile',
        frame: XY,
        loops: [{ entities: [{ kind: 'circle', center: [0, 0], radius: 5 }] }],
        keep: false,
      },
      { op: 'extrude', profile: { result: 0 }, distance: 3, keep: false },
      { op: 'tessellate', shape: { result: 1 } },
      { op: 'topology', shape: { result: 1 } },
    ]);
    expect(reply).not.toBeNull();
    const [, extrude, mesh, topology] = reply!.results;
    expect(extrude.ok && extrude.value.sides).toEqual([[expect.any(Number)]]);
    if (!mesh.ok || !topology.ok) throw new Error('batch failed');
    expect(mesh.value.positions).toBeInstanceOf(Float32Array);
    expect(mesh.value.indices).toBeInstanceOf(Uint32Array);
    expect(mesh.value.faceRanges.length / 2).toBe(topology.value.faces.length);
    expect(mesh.value.positions.length).toBeGreaterThan(0);
    // On the worker side the buffers are detached: they moved, not copied.
    const sent = lastReply!.results[2]!;
    if (!sent.ok) throw new Error('unexpected');
    const worker = sent.value as MeshData;
    expect(worker.positions.buffer.byteLength).toBe(0);
    expect(worker.edgePositions.buffer.byteLength).toBe(0);
    expect(await client.stats()).toMatchObject({ shapeCount: 0 });
  });

  it('errors come back as data; a malformed envelope rejects', async () => {
    const reply = await client.submit([
      { op: 'nope' } as unknown as KernelOp,
      { op: 'box', size: [1e-12, 1, 1], featureId: 'box#1' },
    ]);
    expect(reply!.results[0]).toMatchObject({ ok: false, error: { code: 'invalid-op' } });
    expect(reply!.results[1]).toMatchObject({
      ok: false,
      error: { code: 'kernel', occtType: 'Standard_DomainError', featureId: 'box#1' },
    });
    const remote = Comlink.wrap<KernelWorkerApi>(connectTo(api).endpoint);
    await expect(remote.run(null as never)).rejects.toThrow(/must be an object/);
  });

  it('leaks lists live shapes with their provenance', async () => {
    const reply = await client.submit([{ op: 'box', size: [1, 1, 1], featureId: 'kept#1' }]);
    expect(await client.leaks()).toMatchObject([{ operation: 'box', featureId: 'kept#1' }]);
    const id = reply!.results[0].ok ? reply!.results[0].value.shape : 0;
    await client.submit([{ op: 'release', shapes: [id as never] }]);
    expect(await client.leaks()).toEqual([]);
  });
});

describe('cancellation across the channel', () => {
  it('a newer request arriving mid-batch cancels it between ops', async () => {
    const remote = Comlink.wrap<KernelWorkerApi>(connectTo(api).endpoint);
    const g = client.nextGeneration();
    const long = remote.run({ generation: g, ops: boxes(3000) });
    await started(() => remote.stats());
    const newer = remote.run({
      generation: g + 1,
      ops: [{ op: 'box', size: [1, 1, 1], keep: false }],
    });
    const [a, b] = await Promise.all([long, newer]);
    expect(a.status).toBe('cancelled');
    expect(a.completedOps).toBeGreaterThan(0);
    expect(a.completedOps).toBeLessThan(3000);
    expect(b.status).toBe('done');
    expect((await remote.stats()).shapeCount).toBe(0);
    client.nextGeneration(); // keep the client's numbering ahead of what was used
  });

  it('the client drops a superseded reply and returns the newest', async () => {
    const stale = client.submit(boxes(3000));
    await started(() => client.stats());
    const fresh = client.submit([{ op: 'box', size: [1, 1, 1], keep: false }]);
    expect(await stale).toBeNull();
    expect((await fresh)?.status).toBe('done');
    expect((await client.stats()).shapeCount).toBe(0);
  });

  it('a done reply superseded on its way back has its kept shapes released', async () => {
    let open!: () => void;
    replyGate = new Promise((resolve) => (open = resolve));
    try {
      lastReply = null;
      const stale = client.submit([
        { op: 'box', size: [1, 1, 1] },
        { op: 'box', size: [2, 2, 2], keep: false },
        { op: 'box', size: [3, 3, 3], featureId: 'kept#2' },
      ]);
      // The worker has finished the batch; its reply is held on the way back.
      await vi.waitFor(() => expect(lastReply?.status).toBe('done'));
      expect((await client.leaks()).map((l) => l.operation)).toEqual(['box', 'box']);
      replyGate = null;
      const fresh = client.submit([{ op: 'box', size: [1, 1, 1], keep: false }]);
      open();
      expect(await stale).toBeNull();
      expect((await fresh)?.status).toBe('done');
      await vi.waitFor(async () => expect(await client.leaks()).toEqual([]));
    } finally {
      replyGate = null;
      open();
    }
  });

  it('that release survives a newer submit arriving before it runs', async () => {
    let open!: () => void;
    replyGate = new Promise((resolve) => (open = resolve));
    try {
      lastReply = null;
      const stale = client.submit([
        { op: 'box', size: [1, 1, 1] },
        { op: 'box', size: [3, 3, 3] },
      ]);
      await vi.waitFor(() => expect(lastReply?.status).toBe('done'));
      expect(await client.leaks()).toHaveLength(2);
      replyGate = null;
      // A long batch, so the release queues behind it in the worker.
      const fresh1 = client.submit(boxes(400).map((op) => ({ ...op, keep: false })));
      await vi.waitFor(async () => expect((await client.stats()).shapeCount).toBeGreaterThan(2), {
        timeout: 10_000,
        interval: 1,
      });
      open();
      // Dropped: the client has sent the release of its two shapes.
      expect(await stale).toBeNull();
      sent.length = 0;
      // The next edit, while the release still waits behind fresh1.
      const fresh2 = client.submit([{ op: 'box', size: [1, 1, 1], keep: false }]);
      expect(await fresh1).toBeNull();
      expect((await fresh2)?.status).toBe('done');
      // fresh2 did supersede fresh1 mid-run, so a batch release would have been cancelled.
      expect(sent.map((r) => r.status)).toEqual(['cancelled', 'done']);
      // The release was queued before fresh2, so it has run by now.
      expect(await client.leaks()).toEqual([]);
    } finally {
      replyGate = null;
      open();
    }
  });

  it('cancel() ends the running batch with a cancelled reply', async () => {
    const running = client.submit(boxes(3000));
    await started(() => client.stats());
    await client.cancel();
    const reply = await running;
    expect(reply).toMatchObject({ status: 'cancelled', results: [] });
    expect((await client.stats()).shapeCount).toBe(0);
  });
});

describe('recycling and restart', () => {
  it('forwards recycle status events, with the new instance loading from the cached module', async () => {
    statuses.length = 0;
    const report = await client.recycle();
    expect(report.reason).toBe('requested');
    await vi.waitFor(() => expect(statuses.at(-1)?.type).toBe('recycled'));
    // No download or compile: the module is reused.
    expect(
      statuses.map((s) => (s.type === 'loading' ? `loading:${s.progress.phase}` : s.type)),
    ).toEqual(['recycling', 'loading:instantiate', 'loading:init', 'loading:ready', 'recycled']);
    expect((await client.stats()).instance).toBe(report.instance);
  }, 30_000);

  it('restart replaces a stuck worker; pending submits resolve to null', async () => {
    // The first "worker" never answers: an operation that never returns.
    const stuck = new MessageChannel();
    channels.push(stuck.port1, stuck.port2);
    let connects = 0;
    const fresh = createKernelWorkerApi({ source: { url: 'kernel.wasm', fetch: fetchWasm } });
    const onRestarted = vi.fn();
    const c = new KernelClient(
      () =>
        ++connects === 1
          ? { endpoint: stuck.port2, terminate: () => stuck.port1.close() }
          : connectTo(fresh),
      { onRestarted },
    );
    const pending = c.submit([{ op: 'box', size: [1, 1, 1] }]);
    const report = await c.restart();
    expect(report.instance).toBe(1);
    expect(await pending).toBeNull();
    // Every shape id is gone: the owner hears of it once the new worker is ready, to replay.
    await vi.waitFor(() => expect(onRestarted).toHaveBeenCalledTimes(1));
    const reply = await c.submit([{ op: 'box', size: [1, 1, 1], keep: false }]);
    expect(reply?.status).toBe('done');
    expect(connects).toBe(2);
    c.terminate();
  }, 60_000);
});
