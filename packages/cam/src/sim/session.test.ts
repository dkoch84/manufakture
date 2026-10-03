// The simulation through the CAM worker's API and `CamClient`, over a real MessageChannel: the
// program is transferred in once, playback requests carry only move numbers, and the heightmap
// and classes come back transferred.

import * as Comlink from 'comlink';
import { afterAll, describe, expect, it } from 'vitest';
import { CamClient, type CamEndpoint } from '../client';
import type { Toolpath } from '../ir';
import type { Box3, Tool } from '../types';
import { createCamWorkerApi, createToolpathCache, type CamWorkerApi } from '../worker/api';
import { packToolpath } from '../worker/pack';
import { CamCancelled } from '../worker/registry';
import { SimulationSession, simulateHeightmap } from './session';
import { SIM_CLASS } from './simulation';
import { bracketMesh } from './test-parts';

const ports: { close(): void }[] = [];
afterAll(() => {
  for (const p of ports) p.close();
});

function connected(api: CamWorkerApi): CamClient {
  return new CamClient((): CamEndpoint => {
    const { port1, port2 } = new MessageChannel();
    ports.push(port1, port2);
    Comlink.expose(api, port1);
    return { endpoint: port2, terminate: () => port1.close() };
  });
}

const flat6: Tool = {
  id: 'tool#1',
  name: '6 mm flat',
  kind: 'flat',
  diameter: 6,
  fluteLength: 25,
  flutes: 2,
};
const stock: Box3 = { min: [-10, -10, -6], max: [50, 30, 0] };

/** Down at (-3, 10), along y = 10 through the bracket's plate to (43, 10) at -1, up. */
const throughPart: Toolpath = {
  start: [-3, 10, 5],
  entries: [
    { kind: 'toolChange', tool: flat6.id, name: flat6.name },
    { kind: 'rapid', to: [-3, 10, 1], op: 't', pass: 0 },
    { kind: 'linear', to: [-3, 10, -1], feed: 300, feedClass: 'plunge', op: 't', pass: 0 },
    { kind: 'linear', to: [43, 10, -1], feed: 1000, feedClass: 'cut', op: 't', pass: 0 },
    { kind: 'rapid', to: [43, 10, 5], op: 't', pass: 0 },
    { kind: 'rapid', to: [20, -5, -0.5], op: 't', pass: 0 },
  ],
};

describe('simulateProgram', () => {
  it('loads once, plays by move number, and transfers its buffers', async () => {
    const client = connected(createCamWorkerApi());
    const program = {
      toolpath: packToolpath(throughPart),
      tools: [flat6],
      stock,
      part: { mesh: bracketMesh() },
      options: { cell: 0.5 },
    };
    const first = await client.simulateProgram({ programId: 'p1', program, upTo: 3 });
    expect(first?.status).toBe('done');
    // The packed toolpath went to the worker: the caller's arrays are detached.
    expect(program.toolpath.values.byteLength).toBe(0);
    if (first?.status !== 'done') throw new Error('not done');
    const { frame } = first;
    expect(frame.report.done).toBe(3);
    expect(frame.report.moveCount).toBe(5);
    expect(frame.heightmap.nx).toBe(120);
    expect(frame.heightmap.heights).toHaveLength(120 * 80);
    // The cut through the plate is a gouge; nothing else.
    expect(frame.report.gougeCells).toBeGreaterThan(0);
    expect(frame.report.worstGouge?.depth).toBeCloseTo(1, 5);
    expect(frame.classes?.filter((c) => c === SIM_CLASS.gouge).length).toBe(
      frame.report.gougeCells,
    );
    expect(frame.report.collisions).toEqual([]);

    // Further on, with no program: the last rapid dives into the stock.
    const all = await client.simulateProgram({ programId: 'p1' });
    if (all?.status !== 'done') throw new Error('not done');
    expect(all.frame.report.done).toBe(5);
    expect(all.frame.report.collisions.map((c) => c.move)).toEqual([4]);
    // Back to the start: the stock is whole again.
    const start = await client.simulateProgram({ programId: 'p1', upTo: 0, classes: false });
    if (start?.status !== 'done') throw new Error('not done');
    expect(start.frame.classes).toBeUndefined();
    expect(Math.min(...start.frame.heightmap.heights)).toBe(0);

    // Another id with no program: the worker asks for it.
    expect(await client.simulateProgram({ programId: 'p2', upTo: 1 })).toMatchObject({
      status: 'needs-program',
      programId: 'p2',
    });
  });

  it('fails as a value for a program it cannot simulate', async () => {
    const client = connected(createCamWorkerApi());
    const bad = { toolpath: packToolpath(throughPart), tools: [], stock };
    expect(await client.simulateProgram({ programId: 'x', program: bad })).toMatchObject({
      status: 'failed',
      code: 'invalid-input',
    });
  });

  it('keeps the moves simulated when superseded, and carries on from them', async () => {
    const session = new SimulationSession();
    // 70 moves: checkpoints before moves 0, 32 and 64.
    const zigzag: Toolpath = {
      start: [0, 0, 5],
      entries: [
        { kind: 'toolChange', tool: flat6.id, name: flat6.name },
        ...Array.from({ length: 70 }, (_, k) => ({
          kind: 'linear' as const,
          to: [k % 2 === 0 ? 40 : 0, k * 0.25, -1] as const,
          feed: 1000,
          feedClass: 'cut' as const,
          op: 't',
          pass: 0,
        })),
      ],
    };
    const program = {
      toolpath: packToolpath(zigzag),
      tools: [flat6],
      stock,
      options: { cell: 0.5 },
    };
    let calls = 0;
    const cancelOnSecond = {
      checkpoint: async () => {
        if (++calls === 2) throw new CamCancelled();
      },
    };
    await expect(session.run({ programId: 'p', program }, cancelOnSecond)).rejects.toBeInstanceOf(
      CamCancelled,
    );
    expect(session.loaded).toBe('p');
    // 32 moves were done: the rest needs two checkpoints (before moves 32 and 64), not three.
    let more = 0;
    const done = await session.run({ programId: 'p' }, { checkpoint: async () => void more++ });
    expect(done.ok && done.frame.report.done).toBe(70);
    expect(more).toBe(2);
  });
});

describe('simulate (cached toolpaths)', () => {
  it('cuts each toolpath with its tool, linking above the stock', async () => {
    const op = (y: number): Toolpath => ({
      start: [0, y, 5],
      entries: [
        { kind: 'linear', to: [0, y, -1], feed: 300, feedClass: 'plunge', op: 'p', pass: 0 },
        { kind: 'linear', to: [40, y, -1], feed: 1000, feedClass: 'cut', op: 'p', pass: 0 },
        { kind: 'rapid', to: [40, y, 5], op: 'p', pass: 0 },
      ],
    });
    const cache = createToolpathCache();
    cache.set('a', { ok: true, toolpath: packToolpath(op(0)), warnings: [] });
    cache.set('b', { ok: true, toolpath: packToolpath(op(20)), warnings: [] });
    const client = connected(createCamWorkerApi({ simulator: simulateHeightmap, cache }));
    const small = { ...flat6, id: 'tool#2', diameter: 2 };
    const reply = await client.simulate({
      toolpaths: [
        { key: 'a', tool: flat6 },
        { key: 'b', tool: small },
      ],
      stock,
      cell: 0.5,
    });
    if (reply?.status !== 'done') throw new Error('not done');
    // The cached toolpaths are intact: read, not transferred.
    const cached = cache.peek('a');
    expect(cached?.ok && cached.toolpath.values.byteLength).toBeGreaterThan(0);
    const h = reply.heightmap;
    const at = (x: number, y: number) =>
      h.heights[
        Math.floor((y - h.origin[1]) / h.cell) * h.nx + Math.floor((x - h.origin[0]) / h.cell)
      ];
    expect(at(20, 0.2)).toBe(-1);
    expect(at(20, 2.7)).toBe(-1); // the 6 mm tool
    expect(at(20, 21.7)).toBe(0); // the 2 mm tool
    expect(at(20, 20.2)).toBe(-1);
    // The link from (40, 0) to (0, 20) went over the stock, cutting nothing.
    expect(at(20, 10)).toBe(0);
  });
});
