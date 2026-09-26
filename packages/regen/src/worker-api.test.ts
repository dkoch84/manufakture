// The regen worker end to end through Comlink, in Node: the worker API (the real kernel and the
// real planegcs solver in-process) is exposed on one end of a MessageChannel and the main-thread
// `RegenClient` talks to the other, so the document is really structured-cloned and the mesh
// buffers really transferred. Only `new Worker()` itself is left out.

import { readFile } from 'node:fs/promises';
import type { KernelEndpoint } from '@manufakture/kernel/kernel-client';
import type { KernelStatus, MeshData } from '@manufakture/kernel';
import { wasmPath } from '@manufakture/kernel/node';
import * as Comlink from 'comlink';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { RegenClient } from './client';
import { block, statuses } from './test-helpers';
import type { RegenResult } from './types';
import { createRegenWorkerApi } from './worker-api';

let bytes: Uint8Array;
const fetchWasm = async () =>
  new Response(bytes.slice(), {
    headers: { 'Content-Type': 'application/wasm', 'Content-Length': String(bytes.length) },
  });

const channels: MessagePort[] = [];
let api: ReturnType<typeof createRegenWorkerApi>;
let client: RegenClient;
const statusLog: KernelStatus[] = [];
/** Every result the worker sent, before transfer. */
const sent: RegenResult[] = [];

beforeAll(async () => {
  bytes = new Uint8Array(await readFile(wasmPath()));
  api = createRegenWorkerApi({ source: { url: 'kernel.wasm', fetch: fetchWasm } });
  const regen = api.regen.bind(api);
  api.regen = async (document, options) => {
    const result = await regen(document, options);
    if (result) sent.push(result);
    return result;
  };
  client = new RegenClient(
    (): KernelEndpoint => {
      const { port1, port2 } = new MessageChannel();
      channels.push(port1, port2);
      Comlink.expose(api, port1);
      return { endpoint: port2, terminate: () => port1.close() };
    },
    { onStatus: (s) => statusLog.push(s) },
  );
  await client.ready;
}, 60_000);

afterAll(() => {
  client.terminate();
  for (const p of channels) p.close();
});

const faceCount = (mesh: MeshData) => mesh.faceRanges.length / 2;

/** The block with another width, so a regen has kernel work to do. */
function widened(width: number) {
  const doc = block();
  return {
    ...doc,
    variables: doc.variables.map((v) =>
      v.name === 'width' ? { ...v, expression: { ...v.expression, source: String(width) } } : v,
    ),
  };
}

describe('the regen worker', () => {
  it('regenerates a document into a named mesh with its topology, transferring the buffers', async () => {
    const result = (await client.regen(block()))!;
    expect(result).not.toBeNull();
    expect(result.generation).toBe(client.latestGeneration);
    expect(statuses(result)).toEqual({ 'sketch#1': 'ok', 'extrude#1': 'ok', 'fillet#1': 'ok' });
    const part = result.parts[0]!;
    expect(part.meshChanged).toBe(true);
    const mesh = part.mesh!;
    expect(faceCount(mesh)).toBe(7);
    // Every face slot holds a name from the naming layer.
    const names = Array.from(mesh.faceNames, (i) => result.names[i]);
    expect(names).toContain('fillet#1:round:r1');
    expect(names).toContain('extrude#1:cap:end');
    // Topology numbers faces and edges like the mesh.
    expect(part.topology!.faces).toHaveLength(7);
    expect(part.topology!.edges).toHaveLength(mesh.edgeRanges.length / 2);
    // The sketch result says where it was solved.
    expect(part.features[0]!.placement).toEqual({
      origin: [0, 0, 0],
      normal: [0, 0, 1],
      xDir: [1, 0, 0],
    });
    // Transferred, not copied: the worker's buffers are detached.
    expect(sent.at(-1)!.parts[0]!.mesh!.positions.byteLength).toBe(0);
  });

  it('lets a measure at the current generation run next to regens, on the body it returned', async () => {
    const result = (await client.regen(block()))!;
    // The same document again: nothing changed, so no mesh, but the body is the same shape.
    expect(result.parts[0]!.meshChanged).toBe(false);
    const shape = result.parts[0]!.shape!;
    const reply = await client.submit(
      [{ op: 'measure', shape, targets: [], body: true }] as const,
      client.latestGeneration,
    );
    expect(reply?.status).toBe('done');
    const [r] = reply!.results;
    expect(r.ok && r.value.body!.volume).toBeCloseTo(
      40 * 30 * 20 - (9 - (Math.PI * 9) / 4) * 20,
      3,
    );
  });

  it('supersedes an older regen with a newer one', async () => {
    const doc = block();
    const wide = {
      ...doc,
      variables: doc.variables.map((v) =>
        v.name === 'width' ? { ...v, expression: { ...v.expression, source: '50' } } : v,
      ),
    };
    const [older, newer] = await Promise.all([client.regen(wide), client.regen(doc)]);
    expect(newer).not.toBeNull();
    expect(newer!.generation).toBeGreaterThan(older?.generation ?? 0);
    expect(statuses(newer!)).toEqual({ 'sketch#1': 'ok', 'extrude#1': 'ok', 'fillet#1': 'ok' });
  });

  it('lets a batch at a newer generation supersede a running regen, but not one at the current', async () => {
    // Only a regen may take a new generation: any other batch that does cancels the regen in
    // flight (the service treats its batches as stale), and nothing reports in its place.
    const running = client.regen(widened(61));
    const newer = client.submit([{ op: 'box', size: [1, 1, 1], keep: false }] as const);
    expect(await running).toBeNull();
    expect((await newer)?.status).toBe('done');
    // At the client's current generation it runs next to the regen, which completes.
    const regen = client.regen(widened(62));
    const beside = client.submit(
      [{ op: 'box', size: [1, 1, 1], keep: false }] as const,
      client.latestGeneration,
    );
    expect((await beside)?.status).toBe('done');
    expect(statuses((await regen)!)).toEqual({
      'sketch#1': 'ok',
      'extrude#1': 'ok',
      'fillet#1': 'ok',
    });
  });

  it('releases shapes outside the batch queue, so a regen cancelling older batches cannot drop it', async () => {
    const made = await client.submit(
      [{ op: 'box', size: [2, 2, 2] }] as const,
      client.latestGeneration,
    );
    const shape = (made!.results[0] as { ok: true; value: { shape: number } }).value.shape;
    // A regen is running, the release starts, and a newer regen cancels every batch up to the
    // running one's generation (the release's, had it been a batch).
    const first = client.regen(widened(63));
    const release = client.release([shape as never]);
    const second = client.regen(widened(64));
    expect(await release).toEqual({ released: [shape], unknown: [] });
    await Promise.all([first, second]);
    expect((await client.leaks()).map((r) => r.id)).not.toContain(shape);
  });

  it('resolves a pending regen to null when the worker is stopped', async () => {
    // A worker that never answers.
    const stuck = new MessageChannel();
    channels.push(stuck.port1, stuck.port2);
    const c = new RegenClient(() => ({ endpoint: stuck.port2, terminate: () => {} }));
    const pending = c.regen(block());
    c.terminate();
    expect(await pending).toBeNull();
  });

  it('reports a recycle, after which a regen rebuilds on the new instance', async () => {
    const before = (await client.regen(block()))!;
    const report = await client.recycle();
    await vi.waitFor(() => expect(statusLog.some((s) => s.type === 'recycled')).toBe(true));
    expect(report.lostShapes).toBeGreaterThan(0);
    const after = (await client.regen(block()))!;
    expect(statuses(after)).toEqual({ 'sketch#1': 'ok', 'extrude#1': 'ok', 'fillet#1': 'ok' });
    expect(after.parts[0]!.shape).not.toBe(before.parts[0]!.shape);
    expect(after.counters.featureOps).toBe(2);
    const stats = await client.regenStats();
    expect(stats.regens).toBeGreaterThanOrEqual(4);
  });
});
