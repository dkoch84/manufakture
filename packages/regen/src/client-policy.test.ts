// The script policy on the main thread's side (T7.2d): `RegenClient` sends it to every worker it
// starts, before anything else is asked of it, and sends a changed one before any later request,
// so no regen ever runs under an older policy than the one the app set. A fake worker on a
// MessageChannel records the order calls arrive in.

import type { KernelEndpoint } from '@manufakture/kernel/kernel-client';
import * as Comlink from 'comlink';
import { afterEach, describe, expect, it } from 'vitest';
import { RegenClient } from './client';
import type { ScriptPolicy } from './scripted';
import { build } from './test-helpers';

interface FakeWorker {
  /** The order calls arrived in, a policy as `policy:<documents>`. */
  calls: string[];
}

const workers: FakeWorker[] = [];
const clients: RegenClient[] = [];

function connect(): KernelEndpoint {
  const { port1, port2 } = new MessageChannel();
  const worker: FakeWorker = { calls: [] };
  workers.push(worker);
  Comlink.expose(
    {
      init: async () => ({ instance: 1, heapBytes: 0, ms: 0 }),
      watchScripts: async () => void worker.calls.push('watchScripts'),
      setScriptPolicy: async (p: ScriptPolicy | null) =>
        void worker.calls.push(`policy:${p === null ? 'none' : p.documents.join(',')}`),
      regen: async () => {
        worker.calls.push('regen');
        return null;
      },
      scriptDeclarations: async () => ({ ok: true, params: [] }),
    },
    port1,
  );
  return { endpoint: port2, terminate: () => port1.close() };
}

const until = async (cond: () => boolean, ms = 2000) => {
  const end = performance.now() + ms;
  while (!cond()) {
    if (performance.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 5));
  }
};

const policy = (...documents: string[]): ScriptPolicy => ({ auto: false, documents, scripts: [] });

afterEach(() => {
  for (const c of clients.splice(0)) c.terminate();
  workers.length = 0;
});

describe('RegenClient: the script policy', () => {
  it('is sent first, then before every request made after a change, and again after a restart', async () => {
    const client = new RegenClient(connect, { scriptPolicy: policy() });
    clients.push(client);
    void client.regen(build([]));
    void client.setScriptPolicy(policy('doc-1'));
    void client.regen(build([]));
    await until(() => workers[0]!.calls.filter((c) => c === 'regen').length === 2);
    expect(workers[0]!.calls).toEqual([
      'watchScripts',
      'policy:',
      'regen',
      'policy:doc-1',
      'regen',
    ]);
    expect(client.scriptPolicy).toEqual(policy('doc-1'));

    await client.restart();
    await until(() => workers[1]?.calls.includes('policy:doc-1') ?? false);
    expect(workers[1]!.calls.slice(0, 2)).toEqual(['watchScripts', 'policy:doc-1']);
  });

  it('sends no policy unless one is given (the worker then runs none), and reads declarations', async () => {
    const client = new RegenClient(connect);
    clients.push(client);
    expect(
      await client.scriptDeclarations(
        { id: 'script#1', source: 'x', language: 'js', apiVersion: 1 },
        'doc-1',
      ),
    ).toEqual({ ok: true, params: [] });
    expect(workers[0]!.calls).toEqual(['watchScripts']);
  });
});
