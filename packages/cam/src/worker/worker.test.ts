// The CAM worker end to end through Comlink, in Node: the worker API is exposed on one end of a
// MessageChannel and `CamClient` talks to the other, so every request is really structured-cloned
// and every reply buffer really transferred. Only `new Worker()` itself is left out. Operations do
// not exist yet (T5.2b on), so stub generators stand in for them.

import * as Comlink from 'comlink';
import { afterAll, describe, expect, it } from 'vitest';
import { toolpathKey } from '../cache/key';
import { CamClient, type CamEndpoint } from '../client';
import type { IrEntry, Toolpath } from '../ir';
import { err, ok, type PocketInput, type Setup, type Surface3dInput } from '../types';
import {
  createCamWorkerApi,
  createToolpathCache,
  type CamGenerateReply,
  type CamSimulateReply,
  type CamWorkerApi,
  type CamWorkerApiOptions,
  type Simulator,
} from './api';
import { unpackToolpath } from './pack';
import { CamCancelled, OperationRegistry, type OperationGenerator } from './registry';

const channels: { close(): void }[] = [];
afterAll(() => {
  for (const p of channels) p.close();
});

/** A client whose "worker" is `api` on a fresh channel, started on the first call. */
function connected(api: CamWorkerApi): { client: CamClient; connects: () => number } {
  let count = 0;
  const client = new CamClient((): CamEndpoint => {
    count++;
    const { port1, port2 } = new MessageChannel();
    channels.push(port1, port2);
    Comlink.expose(api, port1);
    return { endpoint: port2, terminate: () => port1.close() };
  });
  return { client, connects: () => count };
}

/** The API, keeping every reply it sends so a test can see its buffers after the transfer. */
function recording(options: CamWorkerApiOptions) {
  const api = createCamWorkerApi(options);
  const sent: CamGenerateReply[] = [];
  const simulated: CamSimulateReply[] = [];
  const generate = api.generate.bind(api);
  api.generate = async (request) => {
    const reply = await generate(request);
    sent.push(reply);
    return reply;
  };
  const simulate = api.simulate.bind(api);
  api.simulate = async (request) => {
    const reply = await simulate(request);
    simulated.push(reply);
    return reply;
  };
  return { api, sent, simulated };
}

const tool = {
  id: 'tool#1',
  name: '1/4in flat',
  kind: 'flat',
  diameter: 6.35,
  fluteLength: 20,
  flutes: 2,
} as const;

function pocket(id: string, stepdown = 1): PocketInput {
  return {
    kind: 'pocket',
    id,
    name: id,
    tool,
    feeds: { spindle: 18000, cut: 1000, plunge: 300 },
    loops: [],
    depth: { top: 0, bottom: -3 },
    stepdown,
    stepover: 0.4,
    finishAllowance: 0,
    entry: { kind: 'plunge' },
    climb: true,
  };
}

function setupWith(...operations: Setup['operations'][number][]): Setup {
  return {
    id: 'setup#1',
    name: 'Top',
    stock: { min: [0, 0, 0], max: [100, 100, 12] },
    wcs: { up: { kind: 'axis', axis: '+z' }, origin: { xy: 'front-left', z: 'top' } },
    frame: { origin: [0, 0, 12], xAxis: [1, 0, 0], yAxis: [0, 1, 0], zAxis: [0, 0, 1] },
    heights: { clearance: 10, retract: 3 },
    machine: 'shapeoko-5-pro-4x4',
    post: 'grbl',
    operations,
  };
}

/** A square at each depth step, as a stand-in pocket: `passes` passes of four cuts each. */
function squares(op: string, passes: number, feed: number): Toolpath {
  const entries: IrEntry[] = [{ kind: 'rapid', to: [0, 0, 3], op, pass: 0 }];
  for (let pass = 0; pass < passes; pass++) {
    const z = -(pass + 1) * 0.1;
    entries.push({ kind: 'linear', to: [0, 0, z], feed: 300, feedClass: 'plunge', op, pass });
    for (const [x, y] of [
      [10, 0],
      [10, 10],
      [0, 10],
      [0, 0],
    ] as const) {
      entries.push({ kind: 'linear', to: [x, y, z], feed, feedClass: 'cut', op, pass });
    }
  }
  entries.push({ kind: 'rapid', to: [0, 0, 10], op, pass: Math.max(0, passes - 1) });
  return { start: [0, 0, 10], entries };
}

/** A stub pocket generator: one square per `stepdown` mm of depth, counting its calls. */
function stubPocket() {
  const calls: string[] = [];
  /** Checkpoints passed, over every call. */
  const progress = { passes: 0 };
  const generator: OperationGenerator<PocketInput> = async (input, context) => {
    calls.push(input.id);
    const passes = Math.ceil((input.depth.top - input.depth.bottom) / input.stepdown);
    for (let pass = 0; pass < passes; pass++) {
      await context.checkpoint();
      progress.passes++;
    }
    return ok({ toolpath: squares(input.id, passes, input.feeds.cut) });
  };
  return { generator, calls, progress };
}

/** Wait until `done()` holds, polling on timers. */
async function until(done: () => boolean): Promise<void> {
  while (!done()) await new Promise((r) => setTimeout(r, 1));
}

function registryWith(generator: OperationGenerator<PocketInput>): OperationRegistry {
  return new OperationRegistry().register('pocket', generator);
}

describe('the CAM worker', () => {
  it('starts lazily and returns each toolpath with its buffers transferred', async () => {
    const { generator } = stubPocket();
    const { api, sent } = recording({ operations: registryWith(generator) });
    const { client, connects } = connected(api);
    expect(client.started).toBe(false);
    const setup = setupWith(pocket('pocket#1'));
    const reply = await client.generate(setup);
    expect(connects()).toBe(1);
    expect(reply?.status).toBe('done');
    if (reply?.status !== 'done') return;
    expect(reply.setup).toBe('setup#1');
    const [result] = reply.operations;
    expect(result).toMatchObject({ id: 'pocket#1', kind: 'pocket', ok: true, cached: false });
    expect(result!.key).toBe(toolpathKey({ operation: setup.operations[0]!, setup }));
    if (!result?.ok) return;
    expect(result.toolpath.values).toBeInstanceOf(Float64Array);
    expect(unpackToolpath(result.toolpath)).toEqual(squares('pocket#1', 3, 1000));
    // The worker's copies were transferred, not copied: detached on its side.
    const own = sent[0]!;
    if (own.status !== 'done' || !own.operations[0]!.ok) throw new Error('expected a toolpath');
    expect(own.operations[0]!.toolpath.values.byteLength).toBe(0);
    expect(own.operations[0]!.toolpath.ints.byteLength).toBe(0);
    expect(own.operations[0]!.toolpath.kinds.byteLength).toBe(0);
    client.terminate();
  });

  it('a newer request cancels an older long one at its next checkpoint', async () => {
    const { generator, calls, progress } = stubPocket();
    const long = pocket('pocket#1', 0.0005); // 6,000 passes, a checkpoint each
    const { api, sent } = recording({ operations: registryWith(generator), slice: 0 });
    const { client } = connected(api);
    const first = client.generate(setupWith(long));
    // Supersede it while its generator runs.
    await until(() => progress.passes > 10);
    const second = client.generate(setupWith(pocket('pocket#2')));
    expect(await first).toBeNull();
    const reply = await second;
    expect(reply?.status).toBe('done');
    // The worker abandoned the stale request rather than finishing it.
    expect(sent.map((r) => `${r.generation} ${r.status}`)).toEqual(['1 cancelled', '2 done']);
    expect(calls).toEqual(['pocket#1', 'pocket#2']);
    expect(progress.passes).toBeLessThan(1000);
    // Nothing was cached for the cancelled operation: asking again generates it.
    const again = await client.generate(setupWith(long));
    expect(again?.status === 'done' && again.operations[0]!.cached).toBe(false);
    client.terminate();
  });

  it('cancel stops the running request, and the next one runs normally', async () => {
    const { generator } = stubPocket();
    const { api, sent } = recording({ operations: registryWith(generator), slice: 0 });
    const { client } = connected(api);
    const running = client.generate(setupWith(pocket('pocket#1', 0.0005)));
    await new Promise((r) => setTimeout(r, 5));
    await client.cancel();
    expect(await running).toBeNull();
    expect(sent.map((r) => r.status)).toEqual(['cancelled']);
    const later = await client.generate(setupWith(pocket('pocket#2')));
    expect(later?.status).toBe('done');
    client.terminate();
  });

  it('a cache hit sends nothing to the generator, and the cached buffers survive transfer', async () => {
    const { generator, calls } = stubPocket();
    const { api } = recording({ operations: registryWith(generator) });
    const { client } = connected(api);
    const setup = setupWith(pocket('pocket#1'), pocket('pocket#2', 0.5));
    const first = await client.generate(setup);
    expect(calls).toEqual(['pocket#1', 'pocket#2']);
    const second = await client.generate(setup);
    expect(calls).toEqual(['pocket#1', 'pocket#2']);
    if (first?.status !== 'done' || second?.status !== 'done') throw new Error('expected done');
    expect(second.operations.map((o) => o.cached)).toEqual([true, true]);
    expect(second.operations.map((o) => o.key)).toEqual(first.operations.map((o) => o.key));
    for (const [i, o] of second.operations.entries()) {
      const before = first.operations[i]!;
      if (!o.ok || !before.ok) throw new Error('expected toolpaths');
      expect(unpackToolpath(o.toolpath)).toEqual(unpackToolpath(before.toolpath));
    }
    // An edit to one operation regenerates that one only.
    const edited = await client.generate(setupWith(pocket('pocket#1'), pocket('pocket#2', 1)));
    expect(calls).toEqual(['pocket#1', 'pocket#2', 'pocket#2']);
    expect(edited?.status === 'done' && edited.operations.map((o) => o.cached)).toEqual([
      true,
      false,
    ]);
    expect(await client.cacheInfo()).toMatchObject({ entries: 3, hits: 3 });
    client.terminate();
  });

  it('serves the keys the app sends, and generates only the operations asked for', async () => {
    const { generator, calls } = stubPocket();
    const { client } = connected(createCamWorkerApi({ operations: registryWith(generator) }));
    const setup = setupWith(pocket('pocket#1'), pocket('pocket#2'));
    const keys = { 'pocket#1': 'app-key-1', 'pocket#2': 'app-key-2' };
    const reply = await client.generate(setup, { keys, only: ['pocket#2'] });
    expect(calls).toEqual(['pocket#2']);
    expect(reply?.status === 'done' && reply.operations.map((o) => [o.id, o.key])).toEqual([
      ['pocket#2', 'app-key-2'],
    ]);
    // Same key, different input: the key is what the cache trusts.
    const hit = await client.generate(setupWith(pocket('pocket#2', 0.5)), { keys });
    expect(calls).toEqual(['pocket#2']);
    expect(hit?.status === 'done' && hit.operations[0]!.cached).toBe(true);
    client.terminate();
  });

  it('keeps operations finished before a request was superseded', async () => {
    const { generator, calls } = stubPocket();
    const { client } = connected(
      createCamWorkerApi({ operations: registryWith(generator), slice: 0 }),
    );
    const first = client.generate(setupWith(pocket('pocket#1'), pocket('pocket#2', 0.0005)));
    // Let the first operation finish and the second start before superseding.
    await until(() => calls.length === 2);
    const second = client.generate(setupWith(pocket('pocket#1')));
    expect(await first).toBeNull();
    const reply = await second;
    expect(reply?.status === 'done' && reply.operations[0]!.cached).toBe(true);
    expect(calls).toEqual(['pocket#1', 'pocket#2']);
    client.terminate();
  });

  it('a thrown generator bug becomes an error value and is not cached', async () => {
    let calls = 0;
    const { client } = connected(
      createCamWorkerApi({
        operations: registryWith(() => {
          calls++;
          throw new TypeError('cannot read properties of undefined');
        }),
      }),
    );
    const setup = setupWith(pocket('pocket#1'));
    const reply = await client.generate(setup);
    expect(reply).toMatchObject({
      status: 'done',
      operations: [
        {
          id: 'pocket#1',
          ok: false,
          cached: false,
          error: {
            code: 'internal',
            message: 'The pocket generator failed: cannot read properties of undefined',
            stack: expect.stringContaining('TypeError'),
          },
        },
      ],
    });
    await client.generate(setup);
    expect(calls).toBe(2);
    client.terminate();
  });

  it('returns expected failures as values and caches them', async () => {
    let calls = 0;
    const { client } = connected(
      createCamWorkerApi({
        operations: registryWith(() => {
          calls++;
          return err('invalid-input', 'The tool is too large for the region.');
        }),
      }),
    );
    const setup = setupWith(pocket('pocket#1'));
    const reply = await client.generate(setup);
    expect(reply).toMatchObject({
      status: 'done',
      operations: [{ ok: false, error: { code: 'invalid-input', message: /too large/ } }],
    });
    const again = await client.generate(setup);
    expect(again?.status === 'done' && again.operations[0]!.cached).toBe(true);
    expect(calls).toBe(1);
    client.terminate();
  });

  it('refuses an invalid toolpath and a malformed result as error values', async () => {
    const zeroFeed: OperationGenerator<PocketInput> = (input) =>
      ok({ toolpath: squares(input.id, 1, 0) });
    const { client } = connected(createCamWorkerApi({ operations: registryWith(zeroFeed) }));
    const reply = await client.generate(setupWith(pocket('pocket#1')));
    expect(reply).toMatchObject({
      status: 'done',
      operations: [{ ok: false, error: { code: 'invalid-toolpath' } }],
    });
    if (reply?.status !== 'done' || reply.operations[0]!.ok) throw new Error('expected an error');
    expect(reply.operations[0]!.error.issues!.every((i) => i.code === 'zero-feed')).toBe(true);
    client.terminate();

    const nothing = connected(
      createCamWorkerApi({
        operations: registryWith((() => undefined) as unknown as OperationGenerator<PocketInput>),
      }),
    ).client;
    expect(await nothing.generate(setupWith(pocket('pocket#1')))).toMatchObject({
      operations: [{ ok: false, error: { code: 'internal', message: /no result/ } }],
    });
    nothing.terminate();
  });

  it('answers an operation kind with no generator with an error value', async () => {
    const { client } = connected(createCamWorkerApi({ operations: new OperationRegistry() }));
    const reply = await client.generate(setupWith(pocket('pocket#1')));
    expect(reply).toMatchObject({
      status: 'done',
      operations: [{ ok: false, error: { code: 'no-generator' } }],
    });
    client.terminate();
  });

  it('a generator that swallows CamCancelled is still a cancelled request', async () => {
    const swallowing: OperationGenerator<PocketInput> = async (input, context) => {
      for (let i = 0; i < 5000 && !context.cancelled; i++) {
        try {
          await context.checkpoint();
        } catch (error) {
          if (!(error instanceof CamCancelled)) throw error;
        }
      }
      return ok({ toolpath: squares(input.id, 1, 1000) });
    };
    const { api, sent } = recording({ operations: registryWith(swallowing), slice: 0 });
    const { client } = connected(api);
    const first = client.generate(setupWith(pocket('pocket#1')));
    const second = client.generate(setupWith(pocket('pocket#2')));
    expect(await first).toBeNull();
    expect((await second)?.status).toBe('done');
    expect(sent.map((r) => r.status)).toEqual(['cancelled', 'done']);
    client.terminate();
  });

  it('caches nothing a generator returns after catching CamCancelled', async () => {
    let calls = 0;
    const operations = registryWith(async (input, context) => {
      calls++;
      try {
        for (let i = 0; i < (calls === 1 ? 5000 : 1); i++) await context.checkpoint();
      } catch (error) {
        if (!(error instanceof CamCancelled)) throw error;
        return err('invalid-input', 'gave up');
      }
      return ok({ toolpath: squares(input.id, 1, 1000) });
    });
    const { client } = connected(createCamWorkerApi({ operations, slice: 0 }));
    const keys = { 'pocket#1': 'same-key' };
    const first = client.generate(setupWith(pocket('pocket#1')), { keys });
    await until(() => calls === 1);
    // Supersede it with the same key: had its `err` been cached, this would be a cached failure.
    const second = await client.generate(setupWith(pocket('pocket#1')), { keys });
    expect(await first).toBeNull();
    expect(second?.status === 'done' && second.operations[0]).toMatchObject({
      key: 'same-key',
      cached: false,
      ok: true,
    });
    expect(calls).toBe(2);
    client.terminate();
  });

  it('passes the machine row to generators', async () => {
    let seen: unknown;
    const operations = registryWith((input, context) => {
      seen = context.machine;
      return ok({ toolpath: squares(input.id, 1, 1000) });
    });
    const { client } = connected(createCamWorkerApi({ operations }));
    await client.generate(setupWith(pocket('pocket#1')), { machine: { rapidRate: 5000 } });
    expect(seen).toEqual({ rapidRate: 5000 });
    client.terminate();
  });

  it('transfers surface3d meshes into the worker when asked', async () => {
    const surface: Surface3dInput = {
      kind: 'surface3d',
      id: 'surface3d#1',
      name: 'Finish',
      tool: { ...tool, kind: 'ball' },
      feeds: { spindle: 18000, cut: 1000, plunge: 300 },
      mesh: {
        positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
        indices: new Uint32Array([0, 1, 2]),
      },
      stepover: 0.5,
      angle: 0,
      allowance: 0,
    };
    let seen = 0;
    const operations = new OperationRegistry().register('surface3d', (input) => {
      seen = input.mesh.indices.length;
      return ok({ toolpath: squares(input.id, 1, 1000) });
    });
    const { client } = connected(createCamWorkerApi({ operations }));
    const reply = await client.generate(setupWith(surface), { transferMeshes: true });
    expect(reply?.status).toBe('done');
    expect(seen).toBe(3);
    expect(surface.mesh.positions.byteLength).toBe(0);
    expect(surface.mesh.indices.byteLength).toBe(0);
    client.terminate();
  });

  it('reports statistics of cached toolpaths, without starting a worker before', async () => {
    const { generator } = stubPocket();
    const { client, connects } = connected(
      createCamWorkerApi({ operations: registryWith(generator) }),
    );
    expect(await client.stats(['nothing'], { rapidRate: 5000 })).toEqual([null]);
    expect(await client.cacheInfo()).toBeNull();
    expect(connects()).toBe(0);
    const reply = await client.generate(setupWith(pocket('pocket#1')));
    if (reply?.status !== 'done') throw new Error('expected done');
    const key = reply.operations[0]!.key;
    const [stats, missing] = await client.stats([key, 'nothing'], { rapidRate: 5000 });
    expect(missing).toBeNull();
    // Three squares of 40 mm, a plunge from 3 mm to -0.1 mm and two of 0.1 mm.
    expect(stats!.stats.cutLength).toBeCloseTo(120 + 3.1 + 0.2, 9);
    expect(stats!.bounds.feed!.min[2]).toBeCloseTo(-0.3, 12);
    expect(stats!.bounds.feed!.max).toEqual([10, 10, 3]);
    await client.clearCache();
    expect(await client.stats([key], { rapidRate: 5000 })).toEqual([null]);
    client.terminate();
  });

  it('a malformed request fails as a value', async () => {
    const { client } = connected(createCamWorkerApi({ operations: new OperationRegistry() }));
    const reply = await client.generate({ id: 'setup#1' } as unknown as Setup);
    expect(reply).toMatchObject({ status: 'failed', message: /no setup operations/ });
    client.terminate();
  });

  it('terminate drops the pending reply and a later call starts a new worker', async () => {
    const { generator } = stubPocket();
    const { client, connects } = connected(
      createCamWorkerApi({ operations: registryWith(generator), slice: 0 }),
    );
    const pending = client.generate(setupWith(pocket('pocket#1', 0.001)));
    client.terminate();
    expect(client.started).toBe(false);
    expect(await pending).toBeNull();
    const again = await client.generate(setupWith(pocket('pocket#2')));
    expect(again?.status).toBe('done');
    expect(connects()).toBe(2);
    client.terminate();
  });

  it('evicts toolpaths past the cache limit, least recently used first', async () => {
    const { generator, calls } = stubPocket();
    const { client } = connected(
      createCamWorkerApi({
        operations: registryWith(generator),
        cache: createToolpathCache({ maxEntries: 2 }),
      }),
    );
    for (const id of ['pocket#1', 'pocket#2', 'pocket#1', 'pocket#3', 'pocket#2']) {
      await client.generate(setupWith(pocket(id)));
    }
    // pocket#1 was used again before pocket#3 came in, so pocket#2 was the one evicted.
    expect(calls).toEqual(['pocket#1', 'pocket#2', 'pocket#3', 'pocket#2']);
    client.terminate();
  });
});

describe('the simulation call', () => {
  const heightmapOf: Simulator = async (input, context) => {
    const nx = Math.round((input.stock.max[0] - input.stock.min[0]) / input.cell);
    const ny = Math.round((input.stock.max[1] - input.stock.min[1]) / input.cell);
    const heights = new Float32Array(nx * ny).fill(input.stock.max[2]);
    for (const { toolpath } of input.toolpaths) {
      await context.checkpoint();
      heights[0] = Math.min(heights[0]!, toolpath.values[2]!);
    }
    return { ok: true, heightmap: { origin: [0, 0], cell: input.cell, nx, ny, heights } };
  };
  const stock = { min: [0, 0, -12], max: [100, 50, 0] } as const;

  it('runs on cached toolpaths and transfers the heightmap', async () => {
    const { generator } = stubPocket();
    const { api, simulated } = recording({
      operations: registryWith(generator),
      simulator: heightmapOf,
    });
    const { client } = connected(api);
    const generated = await client.generate(setupWith(pocket('pocket#1')));
    if (generated?.status !== 'done') throw new Error('expected done');
    const key = generated.operations[0]!.key;
    const reply = await client.simulate({ toolpaths: [{ key, tool }], stock, cell: 1 });
    expect(reply?.status).toBe('done');
    if (reply?.status !== 'done') return;
    expect([reply.heightmap.nx, reply.heightmap.ny]).toEqual([100, 50]);
    expect(reply.heightmap.heights).toHaveLength(5000);
    const own = simulated[0]!;
    if (own.status !== 'done') throw new Error('expected done');
    expect(own.heightmap.heights.byteLength).toBe(0);
    // A simulation does not cancel generation: the two are separate streams.
    expect(client.latestGeneration('generate')).toBe(1);
    expect(client.latestGeneration('simulate')).toBe(1);
    client.terminate();
  });

  it('a simulation arriving during a long generation leaves both to finish', async () => {
    const { generator, calls, progress } = stubPocket();
    const { api, sent, simulated } = recording({
      operations: registryWith(generator),
      simulator: heightmapOf,
      slice: 0,
    });
    const { client } = connected(api);
    const generated = await client.generate(setupWith(pocket('pocket#1')));
    if (generated?.status !== 'done') throw new Error('expected done');
    const key = generated.operations[0]!.key;
    const long = client.generate(setupWith(pocket('pocket#2', 0.005))); // 600 passes
    await until(() => calls.length === 2 && progress.passes > 10);
    const simulation = await client.simulate({ toolpaths: [{ key, tool }], stock, cell: 1 });
    expect(simulation?.status).toBe('done');
    const reply = await long;
    expect(reply?.status).toBe('done');
    expect(progress.passes).toBe(3 + 600);
    expect(sent.map((r) => r.status)).toEqual(['done', 'done']);
    expect(simulated.map((r) => r.status)).toEqual(['done']);
    client.terminate();
  });

  it('fails as a value for a toolpath not in the cache, or with no simulator', async () => {
    const { client } = connected(createCamWorkerApi({ simulator: heightmapOf }));
    const reply = await client.simulate({ toolpaths: [{ key: 'nope', tool }], stock, cell: 1 });
    expect(reply).toMatchObject({ status: 'failed', code: 'missing-toolpath', missing: ['nope'] });
    client.terminate();
    const none = connected(createCamWorkerApi()).client;
    expect(await none.simulate({ toolpaths: [], stock, cell: 1 })).toMatchObject({
      status: 'failed',
      code: 'no-simulator',
    });
    none.terminate();
  });

  it('a newer simulation supersedes an older one; a simulator bug is an error value', async () => {
    const slow: Simulator = async (input, context) => {
      for (let i = 0; i < 5000; i++) await context.checkpoint();
      return heightmapOf(input, context);
    };
    const { api, simulated } = recording({ simulator: slow, slice: 0 });
    const { client } = connected(api);
    const first = client.simulate({ toolpaths: [], stock, cell: 10 });
    const second = client.simulate({ toolpaths: [], stock, cell: 10 });
    expect(await first).toBeNull();
    expect((await second)?.status).toBe('done');
    expect(simulated.map((r) => r.status)).toEqual(['cancelled', 'done']);
    client.terminate();

    const buggy = connected(
      createCamWorkerApi({
        simulator: () => {
          throw new Error('boom');
        },
      }),
    ).client;
    expect(await buggy.simulate({ toolpaths: [], stock, cell: 1 })).toMatchObject({
      status: 'failed',
      code: 'internal',
      message: 'boom',
    });
    buggy.terminate();
  });
});
