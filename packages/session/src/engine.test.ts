// The worker engine's lifecycle: a close that lands while a restart is starting its new worker
// (a regen timeout's kill, say, with the session closing meanwhile) leaves no worker running.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { EngineLost, WorkerEngine } from './engine';

// Every worker the engine starts, and whether it has exited.
const workers = vi.hoisted(() => [] as { exited: boolean }[]);
vi.mock('node:worker_threads', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:worker_threads')>();
  class Tracked extends original.Worker {
    constructor(...args: ConstructorParameters<typeof original.Worker>) {
      super(...args);
      const record = { exited: false };
      workers.push(record);
      this.on('exit', () => {
        record.exited = true;
      });
    }
  }
  return { ...original, Worker: Tracked };
});

const gate = new BroadcastChannel('engine-gate');
afterEach(() => {
  gate.onmessage = null;
  workers.splice(0);
});

/** Resolves on the next worker's `started`; `answer` decides whether it is let go at once. */
function nextStart(answer: boolean): Promise<void> {
  return new Promise((resolve) => {
    gate.onmessage = (event) => {
      if ((event as MessageEvent).data !== 'started') return;
      gate.onmessage = null;
      if (answer) gate.postMessage('go');
      resolve();
    };
  });
}

describe('the worker engine', () => {
  it('stops a worker a restart started after the engine closed, and rejects', async () => {
    const options = {
      heapThresholdBytes: 1024 ** 3,
      url: new URL('./test/gated-entry.ts', import.meta.url),
    };
    const first = nextStart(true);
    const engine = await WorkerEngine.start(options);
    await first;
    expect(workers).toHaveLength(1);

    // The restart stops the first worker and starts a second, held in its `init`.
    const held = nextStart(false);
    const restart = engine.restart();
    const settled = restart.catch((e: unknown) => e);
    await held;
    expect(workers).toHaveLength(2);
    expect(workers[0]!.exited).toBe(true);

    // The session closes now, then the new worker finishes starting.
    await engine.close();
    gate.postMessage('go');
    const error = await settled;
    expect(error).toBeInstanceOf(EngineLost);
    expect((error as Error).message).toBe('The session is closed.');
    expect(workers.map((w) => w.exited)).toEqual([true, true]);
    expect(engine.replaced).toBe(0);
  }, 120_000);

  it('refuses a restart once closed', async () => {
    const first = nextStart(true);
    const engine = await WorkerEngine.start({
      heapThresholdBytes: 1024 ** 3,
      url: new URL('./test/gated-entry.ts', import.meta.url),
    });
    await first;
    await engine.close();
    await expect(engine.restart()).rejects.toThrow(EngineLost);
    expect(workers.map((w) => w.exited)).toEqual([true]);
  }, 120_000);
});
