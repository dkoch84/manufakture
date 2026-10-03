import { createDocument } from '@manufakture/core';
import { validateOp, type KernelStatus, type ShapeId } from '@manufakture/kernel';
import type { KernelClientOptions } from '@manufakture/kernel/client';
import type { RegenResult } from '@manufakture/regen';
import type { RegenClient } from '@manufakture/regen/client';
import { describe, expect, it, vi } from 'vitest';
import { bodyLayer } from './members';
import { createMemberStore, shownMemberView } from './memberStore';
import { isPlaceholderName } from './naming';
import {
  DEFAULT_PERF_TRIANGLES,
  framingLoader,
  kernelLoadStatus,
  kernelLoader,
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
  it('defaults to the kernel with an empty document', () => {
    expect(sceneFromSearch('')).toEqual({ scene: 'default', triangles: DEFAULT_PERF_TRIANGLES });
    expect(sceneFromSearch('?scene=nonsense').scene).toBe('default');
  });

  it('reads the demo, test and perf scenes and a triangle count', () => {
    expect(sceneFromSearch('?scene=demo').scene).toBe('demo');
    expect(sceneFromSearch('?scene=test').scene).toBe('test');
    expect(sceneFromSearch('?scene=perf&triangles=50000')).toEqual({
      scene: 'perf',
      triangles: 50_000,
    });
    expect(sceneFromSearch('?scene=perf&triangles=-4').triangles).toBe(DEFAULT_PERF_TRIANGLES);
    expect(sceneFromSearch('?scene=perf&triangles=1e12').triangles).toBe(5_000_000);
  });

  it('reads the framing scene and its fixture, the shed by default', () => {
    expect(sceneFromSearch('?scene=framing')).toMatchObject({ scene: 'framing', fixture: 'shed' });
    expect(sceneFromSearch('?scene=framing&fixture=house').fixture).toBe('house');
    expect(sceneFromSearch('?scene=demo').fixture).toBeUndefined();
  });
});

describe('framing scene', () => {
  it('resolves with the layer bodies and loads the members into the store', async () => {
    const members = createMemberStore();
    const bodies = await framingLoader('shed', members).load(() => {});
    expect(bodies.map((b) => bodyLayer(b.id))).toEqual(Array(4).fill('sheathing'));
    expect(members.getState().shown).toBe('shed');
    expect(shownMemberView(members.getState()).sets).toHaveLength(4);
  });
});

/** A stand-in for the regen worker client. */
function fakeKernel(options: KernelClientOptions, fail = false) {
  const body = boxBody({ named: false });
  const statuses: KernelStatus[] = [
    {
      type: 'loading',
      progress: { phase: 'download', loaded: 5 * 1024 * 1024, total: 10 * 1024 * 1024 },
    },
    { type: 'loading', progress: { phase: 'init' } },
  ];
  let generation = 0;
  const client = {
    ready: fail
      ? Promise.reject(new Error('no WebAssembly'))
      : Promise.resolve().then(() => {
          for (const s of statuses) options.onStatus?.(s);
          return { instance: 1, heapBytes: 0, ms: 1 };
        }),
    get latestGeneration() {
      return generation;
    },
    status: (s: KernelStatus) => options.onStatus?.(s),
    regen: vi.fn(async (): Promise<RegenResult> => {
      generation++;
      return {
        generation,
        names: body.names as string[],
        parts: [
          {
            partId: 'part#1',
            features: [],
            dirty: [],
            bodies: [
              {
                bodyId: 'extrude#1',
                creator: 'extrude#1',
                shape: 1 as ShapeId,
                bodyKey: 'k',
                solids: 1,
                meshChanged: generation === 1,
                mesh: generation === 1 ? body.mesh : null,
                topology: generation === 1 ? body.topology! : null,
              },
            ],
            consumed: [],
          },
        ],
        assemblies: [],
        sources: [],
        counters: {
          featureOps: 0,
          otherOps: 0,
          batches: 0,
          solves: 0,
          cacheHits: 0,
          cacheMisses: 0,
        },
        ms: 1,
      };
    }),
    submit: vi.fn(async () => null as never),
    terminate: vi.fn(),
  };
  return client;
}

const asClient = (fake: ReturnType<typeof fakeKernel>) => fake as unknown as RegenClient;

describe('kernel loader', () => {
  it('spawns the worker once, reports progress, and resolves with no fixed bodies', async () => {
    let fake!: ReturnType<typeof fakeKernel>;
    const spawn = vi.fn((o: KernelClientOptions) => asClient((fake = fakeKernel(o))));
    const loader = kernelLoader(spawn);
    const seen: LoadStatus[] = [];
    const first = loader.load((s) => seen.push(s));
    const second = loader.load(() => {});
    expect(second).toBe(first);
    expect(await first).toEqual([]);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(seen.map((s) => s.label)).toEqual([
      'Starting the geometry kernel',
      'Downloading the geometry kernel (5.0 of 10.0 MB)',
      'Initialising the geometry kernel',
    ]);
    expect(loader.initialDocument).toBeUndefined();
    loader.dispose();
    expect(fake.terminate).toHaveBeenCalled();
  });

  it('stops reporting to a listener whose signal aborted', async () => {
    const loader = kernelLoader((o) => asClient(fakeKernel(o)));
    const controller = new AbortController();
    const seen: LoadStatus[] = [];
    const done = loader.load((s) => seen.push(s), controller.signal);
    controller.abort();
    await done;
    expect(seen).toHaveLength(1);
  });

  it('rejects when the kernel cannot load', async () => {
    const loader = kernelLoader((o) => asClient(fakeKernel(o, true)));
    await expect(loader.load(() => {})).rejects.toThrow('no WebAssembly');
  });

  it('turns regen results into part bodies and registers them for measuring', async () => {
    let fake!: ReturnType<typeof fakeKernel>;
    const loader = kernelLoader((o) => asClient((fake = fakeKernel(o))));
    expect(await loader.regenerator!.regen(createDocument({ id: 'd', name: 'D' }))).toBeNull();
    await loader.load(() => {});
    const doc = createDocument({ id: 'd', name: 'D' });
    const first = (await loader.regenerator!.regen(doc))!;
    const view = first.parts[0]!.bodies[0]!.view;
    expect(view.id).toBe('part#1/extrude#1');
    expect(view.topology).not.toBeNull();
    // The next result carries no mesh (unchanged): the body is kept.
    const second = (await loader.regenerator!.regen(doc))!;
    expect(second.parts[0]!.bodies[0]!.view).toBe(view);
    // The part is what export writes, under the part's name (its only body).
    expect(loader.exchanger!.bodies()).toEqual([{ id: 'part#1/extrude#1', name: 'Part 1' }]);
    fake.submit.mockImplementationOnce(
      async () =>
        ({
          status: 'done',
          names: [],
          results: [{ ok: true, op: 'measure', value: { items: [], body: null } }],
        }) as never,
    );
    expect(await loader.measurer!.measure('part#1/extrude#1', [], true)).toMatchObject({
      ok: true,
    });
    const [ops, generation] = fake.submit.mock.lastCall as unknown as [unknown[], number];
    expect(ops).toEqual([{ op: 'measure', shape: 1, targets: [], body: true }]);
    expect(validateOp(ops[0])).toBeNull();
    // Never a new generation: measuring must not cancel an edit in flight.
    expect(generation).toBe(2);
  });

  it('asks for a regen after a recycle', async () => {
    let fake!: ReturnType<typeof fakeKernel>;
    const loader = kernelLoader((o) => asClient((fake = fakeKernel(o))));
    await loader.load(() => {});
    const listener = vi.fn();
    loader.regenerator!.onInvalidated(listener);
    fake.status({
      type: 'recycled',
      reason: 'heap-threshold',
      instance: 2,
      heapBytesBefore: 0,
      heapBytesAfter: 0,
      lostShapes: 3,
      ms: 1,
      hookErrors: [],
    });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('asks for a regen after the worker was restarted', async () => {
    let options!: KernelClientOptions;
    const loader = kernelLoader((o) => asClient(fakeKernel((options = o))));
    await loader.load(() => {});
    const listener = vi.fn();
    loader.regenerator!.onInvalidated(listener);
    options.onRestarted?.();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('picks the minimal reference of an edge through the kernel', async () => {
    let fake!: ReturnType<typeof fakeKernel>;
    const loader = kernelLoader((o) => asClient((fake = fakeKernel(o))));
    await loader.load(() => {});
    await loader.regenerator!.regen(createDocument({ id: 'd', name: 'D' }));
    const ref = { faces: ['a', 'b'] };
    fake.submit.mockImplementationOnce(
      async () =>
        ({
          status: 'done',
          names: [],
          results: [{ ok: true, op: 'pick', value: { ref } }],
        }) as never,
    );
    expect(await loader.referencer!.reference('part#1/extrude#1', 'edge', 4)).toEqual({
      ok: true,
      value: ref,
    });
    const [ops] = fake.submit.mock.lastCall as unknown as [unknown[]];
    expect(ops).toEqual([{ op: 'pick', shape: 1, kind: 'edge', index: 4 }]);
    expect(await loader.referencer!.reference('other', 'face', 1)).toMatchObject({ ok: false });
  });
});

describe('kernel-free scenes', () => {
  it('loads the named test box, with nothing to measure it', async () => {
    const loader = testLoader();
    expect(loader.measurer).toBeUndefined();
    const [body] = await loader.load(() => {});
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
  const spawnFake = () => vi.fn((o: KernelClientOptions) => asClient(fakeKernel(o)));

  it('opens a test scene where the test hooks are on', async () => {
    const spawn = spawnFake();
    const [body] = await loaderForLocation('?scene=test', spawn, true).load(() => {});
    expect(body!.id).toBe('test-box');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('opens the demo document in the demo scene', () => {
    const loader = loaderForLocation('?scene=demo', spawnFake(), true);
    expect(loader.initialDocument!.parts[0]!.features.map((f) => f.id)).toEqual([
      'sketch#1',
      'extrude#1',
      'fillet#1',
      'sketch#2',
      'extrude#2',
    ]);
  });

  it('ignores test scenes in a production build and starts the kernel with no document', async () => {
    for (const search of ['?scene=test', '?scene=perf&triangles=1000', '?scene=demo']) {
      const spawn = spawnFake();
      const loader = loaderForLocation(search, spawn, false);
      expect(await loader.load(() => {})).toEqual([]);
      expect(loader.initialDocument).toBeUndefined();
      expect(spawn).toHaveBeenCalledTimes(1);
    }
  });
});
