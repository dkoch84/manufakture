// The main thread's hard bound on a script run (ADR 0010 amendment, item 4; T7.2c), against a
// fake worker on a MessageChannel: a run that starts and does not end within the limit gets the
// worker terminated and a new one started, which is handed the runaway run's cache key before
// anything else. The same bound against a real worker thread and a script that defeats the soft
// limits is in `script-watchdog.test.ts`.

import { RECOMMENDED_HARD_TIMEOUT_MS } from '@manufakture/script';
import type { KernelEndpoint } from '@manufakture/kernel/kernel-client';
import * as Comlink from 'comlink';
import { afterEach, describe, expect, it } from 'vitest';
import { RegenClient, SCRIPT_HARD_TIMEOUT_MS } from './client';
import type { ScriptRunEvent } from './scripted';
import { build } from './test-helpers';

interface FakeWorker {
  onRun: ((event: ScriptRunEvent) => unknown) | null;
  runaway: readonly string[] | null;
  terminated: boolean;
  /** The order calls arrived in. */
  calls: string[];
}

const workers: FakeWorker[] = [];
const clients: RegenClient[] = [];

function connect(): KernelEndpoint {
  const { port1, port2 } = new MessageChannel();
  const worker: FakeWorker = { onRun: null, runaway: null, terminated: false, calls: [] };
  workers.push(worker);
  Comlink.expose(
    {
      init: async () => {
        worker.calls.push('init');
        return { instance: 1, heapBytes: 0, ms: 0 };
      },
      watchScripts: async (onRun: (event: ScriptRunEvent) => unknown, runaway: string[]) => {
        worker.calls.push('watchScripts');
        worker.onRun = onRun;
        worker.runaway = runaway;
      },
      // A regen that never answers: the script holds the worker.
      regen: () => {
        worker.calls.push('regen');
        return new Promise(() => undefined);
      },
    },
    port1,
  );
  return {
    endpoint: port2,
    terminate: () => {
      worker.terminated = true;
      port1.close();
    },
  };
}

const until = async (cond: () => boolean, ms = 2000) => {
  const end = performance.now() + ms;
  while (!cond()) {
    if (performance.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 5));
  }
};

afterEach(() => {
  for (const c of clients.splice(0)) c.terminate();
  workers.length = 0;
});

describe('RegenClient: the hard bound on a script run', () => {
  it('uses the limit the sandbox recommends', () => {
    expect(SCRIPT_HARD_TIMEOUT_MS).toBe(RECOMMENDED_HARD_TIMEOUT_MS);
  });

  it('terminates and restarts the worker when a run does not end, and passes on its key', async () => {
    const timeouts: { featureId: string; key: string }[] = [];
    let restarted = 0;
    const client = new RegenClient(connect, {
      scriptTimeoutMs: 60,
      onScriptTimeout: (e) => timeouts.push(e),
      onRestarted: () => restarted++,
    });
    clients.push(client);
    await until(() => workers[0]?.onRun !== null);
    // The watchdog channel is set up before anything else is asked of the worker.
    expect(workers[0]!.calls[0]).toBe('init');
    expect(workers[0]!.calls).toContain('watchScripts');
    expect(workers[0]!.runaway).toEqual([]);
    const pending = client.regen(build([]));
    void workers[0]!.onRun!({ phase: 'start', featureId: 'scripted#1', key: 'K1' });
    // The pending regen is dropped by the restart.
    expect(await pending).toBeNull();
    await until(() => workers.length === 2 && workers[1]!.runaway !== null);
    expect(workers[0]!.terminated).toBe(true);
    expect(workers[1]!.runaway).toEqual(['K1']);
    expect(timeouts).toEqual([{ featureId: 'scripted#1', key: 'K1' }]);
    expect(client.runawayScripts).toEqual(['K1']);
    await until(() => restarted === 1);
  });

  it('leaves a run alone that ends in time, and ignores events of a worker it replaced', async () => {
    const client = new RegenClient(connect, { scriptTimeoutMs: 80 });
    clients.push(client);
    await until(() => workers[0]?.onRun !== null);
    const first = workers[0]!;
    void first.onRun!({ phase: 'start', featureId: 'scripted#1', key: 'A' });
    await new Promise((r) => setTimeout(r, 20));
    void first.onRun!({ phase: 'end', featureId: 'scripted#1', key: 'A' });
    await new Promise((r) => setTimeout(r, 150));
    expect(workers).toHaveLength(1);
    expect(first.terminated).toBe(false);
    // A restart for another reason; the old worker's late start no longer counts.
    void client.restart();
    await until(() => workers.length === 2 && workers[1]!.onRun !== null);
    void first.onRun!({ phase: 'start', featureId: 'scripted#1', key: 'B' });
    await new Promise((r) => setTimeout(r, 150));
    expect(workers).toHaveLength(2);
    expect(client.runawayScripts).toEqual([]);
  });

  it('refuses a limit that is not above zero', () => {
    expect(() => new RegenClient(connect, { scriptTimeoutMs: 0 })).toThrow(RangeError);
    expect(workers).toHaveLength(0);
  });
});
