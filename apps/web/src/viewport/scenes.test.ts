import { validateOp, type KernelStatus } from '@manufakture/kernel';
import type { KernelClient, KernelClientOptions } from '@manufakture/kernel/client';
import { describe, expect, it, vi } from 'vitest';
import { isPlaceholderName } from './naming';
import {
  DEFAULT_PERF_TRIANGLES,
  DEMO_BODY_ID,
  demoPartOps,
  kernelDemoLoader,
  kernelLoadStatus,
  loaderForLocation,
  perfLoader,
  sceneFromSearch,
  testLoader,
  type LoadStatus,
} from './scenes';
import { boxBody } from './testMeshes';

describe('kernel load status', () => {
  it('reports download progress in MB and as a fraction of the bar', () => {
    const s = kernelLoadStatus({
      phase: 'download',
      loaded: 21 * 1024 * 1024,
      total: 42 * 1024 * 1024,
    });
    expect(s.label).toBe('Downloading the geometry kernel (21.0 of 42.0 MB)');
    expect(s.fraction).toBeCloseTo(0.35);
  });

  it('has no fraction when the download size is unknown', () => {
    expect(kernelLoadStatus({ phase: 'download', loaded: 0, total: null }).fraction).toBeNull();
  });

  it('moves forward through the phases', () => {
    const phases = [
      kernelLoadStatus({ phase: 'download', loaded: 1, total: 1 }),
      kernelLoadStatus({ phase: 'compile' }),
      kernelLoadStatus({ phase: 'instantiate' }),
      kernelLoadStatus({ phase: 'init' }),
      kernelLoadStatus({ phase: 'ready', ms: 300 }),
    ].map((s) => s.fraction!);
    for (let i = 1; i < phases.length; i++) expect(phases[i]).toBeGreaterThan(phases[i - 1]!);
    expect(phases.at(-1)).toBeLessThan(1);
  });
});

describe('scene choice', () => {
  it('defaults to the kernel demo part', () => {
    expect(sceneFromSearch('')).toEqual({ scene: 'demo', triangles: DEFAULT_PERF_TRIANGLES });
    expect(sceneFromSearch('?scene=nonsense').scene).toBe('demo');
  });

  it('reads the test and perf scenes and a triangle count', () => {
    expect(sceneFromSearch('?scene=test').scene).toBe('test');
    expect(sceneFromSearch('?scene=perf&triangles=50000')).toEqual({
      scene: 'perf',
      triangles: 50_000,
    });
    expect(sceneFromSearch('?scene=perf&triangles=-4').triangles).toBe(DEFAULT_PERF_TRIANGLES);
    expect(sceneFromSearch('?scene=perf&triangles=1e12').triangles).toBe(5_000_000);
  });
});

describe('demo part batch', () => {
  it('is a valid op batch whose inputs refer to earlier ops', () => {
    const ops = demoPartOps();
    ops.forEach((op, i) => {
      expect(validateOp(op)).toBeNull();
      for (const ref of JSON.stringify(op).matchAll(/"result":(\d+)/g)) {
        expect(Number(ref[1])).toBeLessThan(i);
      }
    });
    expect(ops.at(-2)!.op).toBe('tessellate');
    expect(ops.at(-1)!.op).toBe('topology');
  });
});

/** A stand-in for the kernel worker client that replies with a box. */
function fakeKernel(options: KernelClientOptions, fail = false) {
  const body = boxBody({ named: false });
  const statuses: KernelStatus[] = [
    {
      type: 'loading',
      progress: { phase: 'download', loaded: 5 * 1024 * 1024, total: 10 * 1024 * 1024 },
    },
    { type: 'loading', progress: { phase: 'init' } },
  ];
  const client = {
    ready: Promise.resolve().then(() => {
      for (const s of statuses) options.onStatus?.(s);
      return { instance: 1, heapBytes: 0, ms: 1 };
    }),
    submit: vi.fn(async () => ({
      status: 'done',
      names: [],
      results: fail
        ? [
            {
              ok: false,
              op: 'fillet',
              error: { code: 'kernel', operation: 'fillet', message: 'boom' },
            },
          ]
        : [
            ...demoPartOps()
              .slice(0, 4)
              .map((o) => ({ ok: true, op: o.op, value: { shape: 1 } })),
            { ok: true, op: 'tessellate', value: body.mesh },
            { ok: true, op: 'topology', value: body.topology },
          ],
    })),
    terminate: vi.fn(),
  };
  return client;
}

describe('kernel demo loader', () => {
  it('spawns the worker once, reports progress and names the mesh with placeholders', async () => {
    let fake!: ReturnType<typeof fakeKernel>;
    const spawn = vi.fn(
      (o: KernelClientOptions) => (fake = fakeKernel(o)) as unknown as KernelClient,
    );
    const loader = kernelDemoLoader(spawn);
    const seen: LoadStatus[] = [];
    const first = loader.load((s) => seen.push(s));
    const second = loader.load(() => {});
    expect(second).toBe(first);
    const [body] = await first;
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(fake.submit).toHaveBeenCalledTimes(1);
    expect(seen.map((s) => s.label)).toEqual([
      'Starting the geometry kernel',
      'Downloading the geometry kernel (5.0 of 10.0 MB)',
      'Initialising the geometry kernel',
      'Building the demo part',
    ]);
    expect(body!.id).toBe(DEMO_BODY_ID);
    // Until #931 names faces, every name is a placeholder.
    expect(body!.names.length).toBeGreaterThan(0);
    expect(body!.names.every(isPlaceholderName)).toBe(true);
    loader.dispose();
    expect(fake.terminate).toHaveBeenCalled();
  });

  it('stops reporting to a listener whose signal aborted', async () => {
    const loader = kernelDemoLoader((o) => fakeKernel(o) as unknown as KernelClient);
    const controller = new AbortController();
    const seen: LoadStatus[] = [];
    const done = loader.load((s) => seen.push(s), controller.signal);
    controller.abort();
    await done;
    expect(seen).toHaveLength(1);
  });

  it('rejects with the kernel message when an op fails', async () => {
    const loader = kernelDemoLoader((o) => fakeKernel(o, true) as unknown as KernelClient);
    await expect(loader.load(() => {})).rejects.toThrow('Kernel fillet failed: boom');
  });
});

describe('kernel-free scenes', () => {
  it('loads the named test box', async () => {
    const [body] = await testLoader().load(() => {});
    expect(body!.names).toContain('test-box/top');
  });

  it('builds the perf mesh with placeholder names', async () => {
    const statuses: string[] = [];
    const [body] = await perfLoader(5_000).load((s) => statuses.push(s.label));
    expect(statuses[0]).toBe('Building a 5,000 triangle mesh');
    expect(body!.mesh.indices.length / 3).toBeGreaterThanOrEqual(5_000);
    expect(body!.names.every(isPlaceholderName)).toBe(true);
  });
});

describe('the scene the page URL names', () => {
  const spawnFake = () =>
    vi.fn((o: KernelClientOptions) => fakeKernel(o) as unknown as KernelClient);

  it('opens a test scene where the test hooks are on', async () => {
    const spawn = spawnFake();
    const [body] = await loaderForLocation('?scene=test', spawn, true).load(() => {});
    expect(body!.id).toBe('test-box');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('ignores test scenes in a production build and loads the demo part', async () => {
    for (const search of ['?scene=test', '?scene=perf&triangles=1000']) {
      const spawn = spawnFake();
      const [body] = await loaderForLocation(search, spawn, false).load(() => {});
      expect(body!.id).toBe(DEMO_BODY_ID);
      expect(spawn).toHaveBeenCalledTimes(1);
    }
  });
});
