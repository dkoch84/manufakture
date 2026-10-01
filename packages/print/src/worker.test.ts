// The print-analysis worker end to end through Comlink, in Node: the worker API is exposed on one
// end of a MessageChannel and the main-thread client talks to the other, so every request is
// really structured-cloned (the input meshes copied) and every reply buffer really transferred.
// Only `new Worker()` itself is left out.

import * as Comlink from 'comlink';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { PrintAnalysisClient, type PrintEndpoint } from './analysis-client';
import { boxFaces, meshFromFaces, type TestMesh } from './test-helpers';
import type { Vec3 } from './geometry';
import { printThresholds } from './thresholds';
import {
  createPrintWorkerApi,
  createYield,
  type PrintAnalysisReply,
  type PrintWorkerApi,
  type PrintWorkerApiOptions,
} from './worker-api';

const channels: MessagePort[] = [];
afterAll(() => {
  for (const p of channels) p.close();
});

/** A client whose "worker" is `api` on a fresh channel, started on the first analysis. */
function connected(api: PrintWorkerApi): { client: PrintAnalysisClient; connects: () => number } {
  let count = 0;
  const client = new PrintAnalysisClient((): PrintEndpoint => {
    count++;
    const { port1, port2 } = new MessageChannel();
    channels.push(port1, port2);
    Comlink.expose(api, port1);
    return { endpoint: port2, terminate: () => port1.close() };
  });
  return { client, connects: () => count };
}

/** The API, keeping every reply it sends so a test can see its buffers after the transfer. */
function recording(options: PrintWorkerApiOptions = {}) {
  const api = createPrintWorkerApi(options);
  const sent: PrintAnalysisReply[] = [];
  const analyze = api.analyze.bind(api);
  api.analyze = async (request) => {
    const reply = await analyze(request);
    sent.push(reply);
    return reply;
  };
  return { api, sent };
}

const thresholds = printThresholds(0.4);

/**
 * A box whose every face is an n x n grid of quads (2 n^2 triangles a face, vertices shared within
 * a face only, as in the kernel's meshes): 12 n^2 triangles.
 */
function gridBox(min: Vec3, max: Vec3, n: number): TestMesh {
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const triangleFaces: number[] = [];
  const faceRanges: number[] = [];
  boxFaces(min, max).forEach((f, fi) => {
    const [a, b, , d] = f.points as [Vec3, Vec3, Vec3, Vec3];
    const u = b.map((v, i) => v - a[i]!);
    const v = d.map((w, i) => w - a[i]!);
    const base = positions.length / 3;
    for (let j = 0; j <= n; j++) {
      for (let i = 0; i <= n; i++) {
        positions.push(...a.map((p, k) => p + (u[k]! * i) / n + (v[k]! * j) / n));
        normals.push(...f.normal);
      }
    }
    const first = indices.length;
    const at = (i: number, j: number) => base + j * (n + 1) + i;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        indices.push(
          at(i, j),
          at(i + 1, j),
          at(i + 1, j + 1),
          at(i, j),
          at(i + 1, j + 1),
          at(i, j + 1),
        );
        triangleFaces.push(fi + 1, fi + 1);
      }
    }
    faceRanges.push(first, indices.length - first);
  });
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    indices: new Uint32Array(indices),
    faceRanges: new Uint32Array(faceRanges),
    triangleFaces: new Uint32Array(triangleFaces),
  };
}

describe('the yield between chunks', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('is a macrotask: microtasks run first, a message already queued within two yields', async () => {
    // Not strictly first: a Node immediate can run before a message posted in the same turn.
    const yieldNow = createYield();
    const { port1, port2 } = new MessageChannel();
    channels.push(port1, port2);
    const order: string[] = [];
    port1.onmessage = () => order.push('message');
    port2.postMessage('newer request');
    void Promise.resolve().then(() => order.push('microtask'));
    await yieldNow();
    order.push('yielded');
    await yieldNow();
    order.push('yielded');
    expect(order[0]).toBe('microtask');
    expect(order.slice(0, 3)).toContain('message');
  });

  it('resolves many yields in order, also when several are pending at once', async () => {
    const yieldNow = createYield();
    const order: number[] = [];
    await Promise.all([0, 1, 2].map((i) => yieldNow().then(() => order.push(i))));
    for (let i = 3; i < 100; i++) {
      await yieldNow();
      order.push(i);
    }
    expect(order).toEqual(Array.from({ length: 100 }, (_, i) => i));
  });

  it('does not starve other ports: a message posted after many yields runs within two', async () => {
    // In Node a woken MessagePort drains up to 1000 messages in one go, so a yield that posts to
    // a private channel would hold off this message for about 1000 yields.
    const yieldNow = createYield();
    const { port1, port2 } = new MessageChannel();
    channels.push(port1, port2);
    let yields = 0;
    let handledAt = -1;
    port1.onmessage = () => (handledAt = yields);
    for (; yields < 60; yields++) await yieldNow();
    port2.postMessage('cancel');
    for (let i = 0; i < 1100 && handledAt < 0; i++, yields++) await yieldNow();
    expect(handledAt - 60).toBeGreaterThanOrEqual(0);
    expect(handledAt - 60).toBeLessThanOrEqual(2);
  });

  /** `createYield()` built while the given globals are hidden, as in a browser worker. */
  function yieldWithout(...names: string[]) {
    for (const name of names) vi.stubGlobal(name, undefined);
    const yieldNow = createYield();
    vi.unstubAllGlobals();
    return yieldNow;
  }

  it('uses a MessageChannel where setImmediate is missing (browsers)', async () => {
    const yieldNow = yieldWithout('setImmediate');
    const order: number[] = [];
    await Promise.all([0, 1, 2].map((i) => yieldNow().then(() => order.push(i))));
    for (let i = 3; i < 50; i++) {
      await yieldNow();
      order.push(i);
    }
    expect(order).toEqual(Array.from({ length: 50 }, (_, i) => i));
  });

  it('falls back to a timer where setImmediate and MessageChannel are missing', async () => {
    const yieldNow = yieldWithout('setImmediate', 'MessageChannel');
    const order: string[] = [];
    setTimeout(() => order.push('timer'), 0);
    await yieldNow();
    order.push('yielded');
    expect(order).toEqual(['timer', 'yielded']);
  });
});

describe('the print-analysis worker', () => {
  it('starts lazily, copies the mesh in and transfers the per-triangle arrays out', async () => {
    const { api, sent } = recording();
    const { client, connects } = connected(api);
    expect(client.started).toBe(false);
    expect(connects()).toBe(0);
    const mesh = meshFromFaces(boxFaces([0, 0, 0], [10, 10, 0.5]));
    const reply = await client.analyze([{ id: 'part#1/body#1', mesh }], thresholds);
    expect(connects()).toBe(1);
    expect(reply?.status).toBe('done');
    if (reply?.status !== 'done') return;
    expect(reply.bodies[0]!.id).toBe('part#1/body#1');
    expect(reply.bodies[0]!.thickness).toBeInstanceOf(Float32Array);
    expect(reply.bodies[0]!.thickness).toHaveLength(12);
    expect(reply.issues.map((i) => `${i.kind} ${i.face}`).sort()).toEqual([
      'thinWall 1',
      'thinWall 2',
    ]);
    // The worker's copies of the arrays were transferred, not copied: detached on its side.
    const own = sent[0]!;
    if (own.status !== 'done') throw new Error('expected done');
    expect(own.bodies[0]!.thickness.byteLength).toBe(0);
    expect(own.bodies[0]!.flags.byteLength).toBe(0);
    // The main thread keeps its mesh: the request was copied.
    expect(mesh.positions.byteLength).toBeGreaterThan(0);
    expect(mesh.indices).toHaveLength(36);
    client.terminate();
  });

  it('a newer request supersedes an older one still running', async () => {
    const { api, sent } = recording({ chunk: 64, slice: 0 });
    const { client } = connected(api);
    const big = gridBox([0, 0, 0], [20, 20, 3], 40);
    const first = client.analyze([{ id: 'a', mesh: big }], thresholds);
    const second = client.analyze(
      [{ id: 'b', mesh: meshFromFaces(boxFaces([0, 0, 0], [1, 1, 1])) }],
      thresholds,
    );
    expect(await first).toBeNull();
    const reply = await second;
    expect(reply?.status).toBe('done');
    // The worker itself abandoned the stale analysis rather than finishing it.
    expect(sent.map((r) => `${r.generation} ${r.status}`)).toEqual(['1 cancelled', '2 done']);
    client.terminate();
  });

  it('cancel stops the running analysis', async () => {
    const { api, sent } = recording({ chunk: 64, slice: 0 });
    const { client } = connected(api);
    const running = client.analyze(
      [{ id: 'a', mesh: gridBox([0, 0, 0], [20, 20, 3], 40) }],
      thresholds,
    );
    await new Promise((r) => setTimeout(r, 5));
    await client.cancel();
    expect(await running).toBeNull();
    expect(sent.map((r) => r.status)).toEqual(['cancelled']);
    // A later request runs normally.
    const later = await client.analyze(
      [{ id: 'b', mesh: meshFromFaces(boxFaces([0, 0, 0], [1, 1, 1])) }],
      thresholds,
    );
    expect(later?.status).toBe('done');
    client.terminate();
  });

  it('a cancel sent mid-run, after about 100 yields, is seen within a few yields', async () => {
    const base = createYield();
    let yields = 0;
    let cancelSeenAt = -1;
    const CANCEL_AT = 100;
    let client: PrintAnalysisClient | undefined;
    const { api, sent } = recording({
      chunk: 8,
      slice: 0,
      yieldNow: async () => {
        yields++;
        if (yields === CANCEL_AT) void client!.cancel();
        await base();
      },
    });
    const cancel = api.cancel.bind(api);
    api.cancel = async (generation) => {
      cancelSeenAt = yields;
      await cancel(generation);
    };
    client = connected(api).client;
    // 19,200 triangles in chunks of 8: 2400 yields, well past the 1000 a starved port would wait.
    const reply = await client.analyze(
      [{ id: 'a', mesh: gridBox([0, 0, 0], [20, 20, 3], 40) }],
      thresholds,
    );
    expect(reply).toBeNull();
    expect(sent.map((r) => r.status)).toEqual(['cancelled']);
    expect(cancelSeenAt).toBeGreaterThanOrEqual(CANCEL_AT);
    expect(cancelSeenAt - CANCEL_AT).toBeLessThanOrEqual(3);
    expect(yields - CANCEL_AT).toBeLessThanOrEqual(4);
    client.terminate();
  });

  it('a malformed mesh fails as a value, not an exception', async () => {
    const { client } = connected(createPrintWorkerApi());
    const mesh = meshFromFaces(boxFaces([0, 0, 0], [1, 1, 1]));
    const reply = await client.analyze(
      [{ id: 'bad', mesh: { ...mesh, indices: Uint32Array.from([0, 1, 99]) } }],
      thresholds,
    );
    expect(reply).toMatchObject({ status: 'failed', message: expect.stringMatching(/vertex 99/) });
    client.terminate();
  });

  it('terminate drops the pending reply and a later analysis starts a new worker', async () => {
    const { client, connects } = connected(createPrintWorkerApi({ chunk: 64, slice: 0 }));
    const pending = client.analyze(
      [{ id: 'a', mesh: meshFromFaces(boxFaces([0, 0, 0], [1, 1, 1])) }],
      thresholds,
    );
    client.terminate();
    expect(client.started).toBe(false);
    expect(await pending).toBeNull();
    const again = await client.analyze(
      [{ id: 'b', mesh: meshFromFaces(boxFaces([0, 0, 0], [1, 1, 1])) }],
      thresholds,
    );
    expect(again?.status).toBe('done');
    expect(connects()).toBe(2);
    client.terminate();
  });

  // Performance target (plan T3.1c, an estimate to measure, not a promise): a 200,000-triangle
  // body analysed in under a second in the worker. Measured through the channel, request copy
  // and reply transfer included, on a 3 mm plate (every inward ray finds the opposite wall).
  // About 440 ms alone in a development container, up to about 1050 ms with the rest of the
  // suite running in parallel; the test logs the time against the target and fails only above
  // BUDGET_MS, which leaves room for loaded CI runners (as the kernel's thread timing test does).
  const TARGET_MS = 1000;
  const BUDGET_MS = 4000;

  it(`analyses a 200,000-triangle body within ${BUDGET_MS} ms`, async () => {
    const { client } = connected(createPrintWorkerApi());
    const mesh = gridBox([0, 0, 0], [60, 60, 3], 130);
    expect(mesh.indices.length / 3).toBe(202_800);
    const started = performance.now();
    const reply = await client.analyze([{ id: 'plate', mesh }], thresholds);
    const ms = performance.now() - started;
    expect(reply?.status).toBe('done');
    if (reply?.status !== 'done') return;
    console.log(
      `print analysis of 202,800 triangles: ${ms.toFixed(0)} ms (${reply.ms.toFixed(0)} ms in the ` +
        `worker), target ${TARGET_MS} ms`,
    );
    for (const v of reply.bodies[0]!.thickness.subarray(0, 1000)) expect(v).toBeCloseTo(3, 3);
    expect(ms).toBeLessThan(BUDGET_MS);
    client.terminate();
  }, 30_000);
});
