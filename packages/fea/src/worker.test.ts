// The worker protocol in Node worker threads: results and progress through Comlink, cancellation
// through the shared flag, the time limit enforced by the worker and, when it cannot answer, by
// the host terminating it; a worker that dies; one analysis at a time. Every run settles.

import * as Comlink from 'comlink';
import { existsSync } from 'node:fs';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { CANTILEVER, cantileverMetrics, STEEL } from './benchmarks';
import { spawnBrowserFeaWorker } from './browser';
import { createFeaRunner, type FeaRunner, type FeaWorkerHandle } from './client';
import { spawnNodeFeaWorker } from './node';
import { structuredBlock } from './structured';
import type { FeaProgress } from './types';
import { feaWorkerApi, type FeaWorkerApi } from './worker/api';

const runners: FeaRunner[] = [];
const runner = (url?: URL, graceMs?: number): FeaRunner => {
  const r = createFeaRunner(
    () => spawnNodeFeaWorker(url ? { url } : {}),
    graceMs !== undefined ? { graceMs } : {},
  );
  runners.push(r);
  return r;
};
afterEach(() => {
  for (const r of runners.splice(0)) r.dispose();
  vi.unstubAllGlobals();
});

const HANG = new URL('./test-workers/hang.ts', import.meta.url);
const CRASH = new URL('./test-workers/crash.ts', import.meta.url);

/** A runner over Node workers that records each worker it starts and each one it terminates. */
const counted = (url: URL | undefined, options: Parameters<typeof createFeaRunner>[1] = {}) => {
  const log = { spawned: 0, terminated: [] as number[] };
  const r = createFeaRunner(() => {
    const h = spawnNodeFeaWorker(url ? { url } : {});
    const id = ++log.spawned;
    return {
      ...h,
      terminate() {
        log.terminated.push(id);
        h.terminate();
      },
    };
  }, options);
  runners.push(r);
  return { r, log };
};

const beam = (cells: [number, number, number]) =>
  structuredBlock({
    cells,
    map: (u, v, w) => [CANTILEVER.L * u, CANTILEVER.b * v, CANTILEVER.h * w],
  });
const input = {
  materials: [STEEL],
  fixtures: [{ kind: 'fixed' as const, faces: [{ body: 0, face: 0 }] }],
  loads: [
    {
      kind: 'force' as const,
      faces: [{ body: 0, face: 1 }],
      force: [0, 0, -CANTILEVER.P] as [number, number, number],
    },
  ],
};

describe('FEA worker in a Node worker thread', () => {
  test('solves, streams progress and transfers the result', async () => {
    const progress: FeaProgress[] = [];
    const out = await runner().runMesh(beam([40, 4, 4]), input, {
      onProgress: (p) => progress.push(p),
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    for (const m of cantileverMetrics(out.result)) expect(Math.abs(m.error)).toBeLessThan(0.05);
    expect(out.result.displacement).toBeInstanceOf(Float64Array);
    expect(progress.some((p) => p.phase === 'solve')).toBe(true);
  });

  test('cancelling mid-run ends with cancelled, and the runner is reusable', async () => {
    const r = runner();
    const controller = new AbortController();
    const run = r.runMesh(beam([60, 8, 8]), input, {
      signal: controller.signal,
      onProgress: (p) => {
        if (p.phase === 'assemble' || p.phase === 'precondition') controller.abort();
      },
    });
    const out = await run;
    expect(out).toMatchObject({ ok: false, error: { code: 'cancelled' } });
    const again = await r.runMesh(beam([4, 1, 1]), input);
    expect(again.ok).toBe(true);
  });

  test('the worker stops itself at the time limit', async () => {
    const out = await runner().runMesh(beam([60, 8, 8]), { ...input, limits: { timeMs: 150 } });
    expect(out).toMatchObject({ ok: false, error: { code: 'time-limit', limit: 150 } });
  });

  test('a worker that cannot answer is terminated at the time limit', async () => {
    const t = performance.now();
    const out = await runner(HANG, 200).runMesh(beam([2, 1, 1]), {
      ...input,
      limits: { timeMs: 300 },
    });
    expect(out).toMatchObject({ ok: false, error: { code: 'time-limit' } });
    expect(performance.now() - t).toBeLessThan(5_000);
  });

  test('cancelling a worker that cannot answer terminates it', async () => {
    const controller = new AbortController();
    const run = runner(HANG, 100).runMesh(beam([2, 1, 1]), input, {
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 100);
    expect(await run).toMatchObject({ ok: false, error: { code: 'cancelled' } });
  });

  test('a worker that dies answers worker-failed', async () => {
    const out = await runner(CRASH).runMesh(beam([2, 1, 1]), input);
    expect(out).toMatchObject({ ok: false, error: { code: 'worker-failed' } });
  });

  test('one analysis at a time', async () => {
    const r = runner();
    const first = r.runMesh(beam([20, 4, 4]), input);
    const second = await r.runMesh(beam([2, 1, 1]), input);
    expect(second).toMatchObject({ ok: false, error: { code: 'busy' } });
    expect((await first).ok).toBe(true);
  });

  test('a run that ran out of memory ends its worker, and the next run starts a fresh one', async () => {
    const { r, log } = counted(undefined);
    const out = await r.runMesh(beam([4, 1, 1]), { ...input, limits: { memoryBytes: 1024 } });
    expect(out).toMatchObject({ ok: false, error: { code: 'memory-limit' } });
    expect(log.terminated).toEqual([1]);
    expect((await r.runMesh(beam([4, 1, 1]), input)).ok).toBe(true);
    expect(log.spawned).toBe(2);
  });

  test('limits above the hard caps are refused before the worker starts', async () => {
    const out = await runner().runMesh(beam([2, 1, 1]), { ...input, limits: { maxDof: 600_000 } });
    expect(out).toMatchObject({
      ok: false,
      error: { code: 'invalid-input', path: 'limits.maxDof' },
    });
  });

  test('requests are validated in the worker', async () => {
    const out = await runner().run({
      bodies: [{ step: new Uint8Array([1, 2, 3]), material: STEEL }],
      mesh: { size: 1 },
      fixtures: [],
      loads: [],
    });
    expect(out).toMatchObject({ ok: false, error: { code: 'invalid-input' } });
  });
});

describe('prepare', () => {
  test('a worker that dies while loading the mesher answers worker-failed', async () => {
    expect(await runner(CRASH).prepare()).toMatchObject({
      ok: false,
      error: { code: 'worker-failed' },
    });
  });

  test('a worker that hangs while loading the mesher is terminated at the timeout', async () => {
    const { r, log } = counted(HANG, { prepareTimeoutMs: 300 });
    const t = performance.now();
    const pending = r.prepare();
    // One call at a time: runs and other prepares wait their turn.
    expect(await r.runMesh(beam([2, 1, 1]), input)).toMatchObject({
      ok: false,
      error: { code: 'busy' },
    });
    expect(await r.prepare()).toMatchObject({ ok: false, error: { code: 'busy' } });
    expect(await pending).toMatchObject({ ok: false, error: { code: 'time-limit', limit: 300 } });
    expect(log.terminated).toEqual([1]);
    expect(performance.now() - t).toBeLessThan(5_000);
  });

  test('disposing the runner settles a prepare in flight', async () => {
    const { r } = counted(HANG);
    const pending = r.prepare();
    setTimeout(() => r.dispose(), 50);
    expect(await pending).toMatchObject({ ok: false, error: { code: 'worker-failed' } });
  });

  test('a worker loads the mesher, or says it is not built', async () => {
    const out = await runner().prepare();
    if (existsSync(new URL('../wasm/gmsh.wasm', import.meta.url)))
      expect(out).toEqual({ ok: true });
    else expect(out).toMatchObject({ ok: false, error: { code: 'mesher-unavailable' } });
  }, 30_000);
});

/**
 * A stand-in for a browser's dedicated `Worker` in this thread: the FEA API exposed on one end of
 * a web MessageChannel, `error` events dispatched by the test.
 */
class FakeWorker extends EventTarget {
  static made: FakeWorker[] = [];
  terminated = false;
  private readonly port: MessagePort;
  private readonly peer: MessagePort;
  constructor() {
    super();
    const { port1, port2 } = new MessageChannel();
    Comlink.expose(feaWorkerApi(), port2);
    port1.addEventListener('message', (e) =>
      this.dispatchEvent(new MessageEvent('message', { data: (e as MessageEvent).data })),
    );
    port1.start();
    this.port = port1;
    this.peer = port2;
    FakeWorker.made.push(this);
  }
  postMessage(data: unknown, transfer: Transferable[] = []) {
    if (!this.terminated) this.port.postMessage(data, transfer);
  }
  terminate() {
    this.terminated = true;
    this.port.close();
    this.peer.close();
  }
  fail(message: string) {
    this.dispatchEvent(Object.assign(new Event('error'), { message }));
  }
}

describe('browser worker handle', () => {
  const stub = () => {
    FakeWorker.made = [];
    vi.stubGlobal('Worker', FakeWorker);
  };

  test('an error event ends the worker and reaches the listener once', () => {
    stub();
    const h: FeaWorkerHandle = spawnBrowserFeaWorker();
    const heard: string[] = [];
    h.onExit((reason) => heard.push(reason.message));
    FakeWorker.made[0]!.fail('uncaught TypeError');
    FakeWorker.made[0]!.fail('uncaught TypeError again');
    expect(FakeWorker.made[0]!.terminated).toBe(true);
    expect(heard).toEqual(['uncaught TypeError']);
  });

  test('a run whose worker reports an error settles, and the next run uses a new worker', async () => {
    stub();
    const r = createFeaRunner(spawnBrowserFeaWorker);
    runners.push(r);
    expect((await r.runMesh(beam([4, 1, 1]), input)).ok).toBe(true);
    const run = r.runMesh(beam([4, 1, 1]), input);
    FakeWorker.made[0]!.fail('out of memory');
    expect(await run).toMatchObject({ ok: false, error: { code: 'memory-limit' } });
    expect(FakeWorker.made[0]!.terminated).toBe(true);
    // An error event while idle ends that worker too; no orphan keeps running.
    expect((await r.runMesh(beam([4, 1, 1]), input)).ok).toBe(true);
    FakeWorker.made[1]!.fail('uncaught error while idle');
    expect(FakeWorker.made[1]!.terminated).toBe(true);
    expect((await r.runMesh(beam([4, 1, 1]), input)).ok).toBe(true);
    expect(FakeWorker.made.map((w) => w.terminated)).toEqual([true, true, false]);
  });
});

describe('FEA worker API over a web MessageChannel', () => {
  // What a browser module worker does (Comlink.expose on a MessagePort-like endpoint), in this
  // thread: the protocol without Node's worker_threads.
  test('solves through Comlink with transferred results', async () => {
    const { port1, port2 } = new MessageChannel();
    Comlink.expose(feaWorkerApi(), port2);
    const r = createFeaRunner(() => ({
      api: Comlink.wrap<FeaWorkerApi>(port1),
      terminate: () => port1.close(),
      onExit: () => undefined,
    }));
    runners.push(r);
    const phases = new Set<string>();
    const out = await r.runMesh(beam([10, 2, 2]), input, {
      onProgress: (p) => phases.add(p.phase),
    });
    expect(out.ok).toBe(true);
    expect(phases.has('solve')).toBe(true);
    port2.close();
  });
});
