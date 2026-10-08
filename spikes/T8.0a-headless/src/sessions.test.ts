// Several sessions in one process, for the "sessions per process" limit:
//
// - memory: k sessions on the bracket, each with a kernel service of its own; resident memory and
//   the wasm heaps after each one opens, and after they are closed and dropped (the kernel service
//   has no dispose: its instance goes only when nothing references the service);
// - throughput: four sessions applying batches at the same time. Node runs wasm on one thread, so
//   they take turns; how long a batch waits is what a fifth agent would feel;
// - one kernel service shared by two sessions: does one session's regen cancel the other's? The
//   service cancels by generation, and each engine numbers its own regens.
//
// Writes results/sessions.json.

import { describe, expect, it } from 'vitest';
import { longRunBatch, engraveBatch } from './fixtures';
import { nodeHost, type NodeHost } from './host';
import { openFixture, type Opened } from './open';
import { MiB, memory, round, writeResult } from './results';

const out: Record<string, unknown> = {};

describe('sessions in one process', () => {
  it('memory per session, and after closing them', async () => {
    const base = memory();
    const steps: unknown[] = [];
    let opened: Opened[] = [];
    for (let k = 1; k <= 6; k++) {
      const host = await nodeHost();
      const o = await openFixture('bracket', { host, dir: `many-${k}`, sessionId: `many-${k}` });
      expect((await o.session.apply(engraveBatch('MFK-1'))).ok).toBe(true);
      for (let i = 1; i <= 20; i++)
        await o.session.apply(longRunBatch('bracket', o.session.document, i));
      opened.push(o);
      steps.push({
        sessions: k,
        ...memory(),
        wasmMiB: opened.reduce((s, x) => s + MiB(x.host.service.stats().heapBytes), 0),
      });
    }
    for (const o of opened) await o.session.close();
    const closed = memory();
    opened = [];
    // Give V8 a few turns to collect the instances' memories.
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 200));
      memory();
    }
    const dropped = memory();
    out.memory = { base, steps, closedButReferenced: closed, dropped };
  });

  it('four sessions applying batches at once take turns', async () => {
    const opened: Opened[] = [];
    for (let k = 0; k < 4; k++) {
      opened.push(await openFixture('shed', { dir: `turns-${k}`, sessionId: `turns-${k}` }));
    }
    // Alone first, then all four together.
    const alone: number[] = [];
    for (let i = 1; i <= 10; i++) {
      const r = await opened[0]!.session.apply(
        longRunBatch('shed', opened[0]!.session.document, i),
      );
      if (r.ok) alone.push(r.ms.total);
    }
    const together: number[] = [];
    const t = performance.now();
    await Promise.all(
      opened.map(async (o, k) => {
        for (let i = 1; i <= 10; i++) {
          const ts = performance.now();
          const r = await o.session.apply(
            longRunBatch('shed', o.session.document, 100 * (k + 1) + i),
          );
          expect(r.ok).toBe(true);
          together.push(performance.now() - ts);
        }
      }),
    );
    const wall = performance.now() - t;
    for (const o of opened) await o.session.close();
    const med = (xs: number[]) => round([...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!);
    out.turns = {
      fixture: 'shed',
      aloneMedianMs: med(alone),
      togetherMedianMs: med(together),
      togetherMaxMs: round(Math.max(...together)),
      fortyBatchesWallMs: round(wall),
    };
  });

  it('two sessions on one kernel service', async () => {
    const host: NodeHost = await nodeHost();
    const a = await openFixture('shed', { host, dir: 'shared-a', sessionId: 'shared-a' });
    const b = await openFixture('shed', { host, dir: 'shared-b', sessionId: 'shared-b' });
    const outcomes: string[] = [];
    await Promise.all(
      [a, b].map(async (o, k) => {
        for (let i = 1; i <= 10; i++) {
          try {
            const r = await o.session.apply(longRunBatch('shed', o.session.document, 10 * k + i));
            outcomes.push(r.ok ? (r.errors.length ? `errors: ${r.errors[0]}` : 'ok') : r.code);
          } catch (e) {
            outcomes.push(`threw: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      }),
    );
    await a.session.close().catch(() => undefined);
    await b.session.close().catch(() => undefined);
    const counts: Record<string, number> = {};
    for (const o of outcomes) counts[o] = (counts[o] ?? 0) + 1;
    out.sharedService = counts;
    writeResult('sessions', out);
  });
});
