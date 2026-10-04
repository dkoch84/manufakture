// The hard bound on a script run, for real (ADR 0010 amendment, item 4; T7.2c): the regen
// worker on a Node worker thread, a script whose loop the soft limits cannot stop (unary `+` on a
// 1 MB string: QuickJS polls its interrupt handler every 10,000 branches, and each conversion
// takes about a millisecond, so the soft limit fires seconds late; one of the residual cases in
// `@manufakture/script`'s README), and `RegenClient` terminating the thread when the run has not
// ended in time. The worker entry is TypeScript with extensionless imports, so the test bundles
// it with Vite into a temporary directory first.

import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { wasmPath } from '@manufakture/kernel/node';
import type { KernelEndpoint } from '@manufakture/kernel/kernel-client';
import { quickjsWasmPath } from '@manufakture/script/node';
import type * as Comlink from 'comlink';
import { build as viteBuild } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RegenClient } from './client';
import { add, build } from './test-helpers';
import type { RegenResult } from './types';

const requireHere = createRequire(import.meta.url);
let dir: string;
let entry: string;
let kernel: Uint8Array;
let quickjs: Uint8Array;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'regen-script-watchdog-'));
  const source = fileURLToPath(new URL('./script-watchdog.worker.ts', import.meta.url));
  await viteBuild({
    configFile: false,
    logLevel: 'silent',
    root: fileURLToPath(new URL('..', import.meta.url)),
    ssr: { noExternal: true, target: 'node' },
    build: {
      ssr: source,
      outDir: dir,
      emptyOutDir: true,
      minify: false,
      target: 'node22',
      rollupOptions: {
        // libcascade finds its glue next to itself (`new URL(..., import.meta.url)`), so it stays
        // outside the bundle, imported from where it is installed.
        external: ['libcascade/single/init'],
        output: {
          format: 'es',
          entryFileNames: 'worker.mjs',
          paths: {
            'libcascade/single/init': pathToFileURL(requireHere.resolve('libcascade/single/init'))
              .href,
          },
        },
      },
    },
  });
  entry = join(dir, 'worker.mjs');
  kernel = new Uint8Array(await readFile(wasmPath()));
  quickjs = new Uint8Array(await readFile(quickjsWasmPath()));
}, 120_000);

afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

/** A worker thread as a Comlink endpoint. */
function spawn(timeMs: number): KernelEndpoint {
  const worker = new Worker(entry, { workerData: { kernel, quickjs, timeMs } });
  const listeners = new Map<unknown, (data: unknown) => void>();
  const endpoint: Comlink.Endpoint = {
    postMessage: (message: unknown, transfer?: Transferable[]) =>
      worker.postMessage(message, transfer as never),
    addEventListener: (_type: string, listener: unknown) => {
      const on = (data: unknown) => (listener as (e: { data: unknown }) => void)({ data });
      listeners.set(listener, on);
      worker.on('message', on);
    },
    removeEventListener: (_type: string, listener: unknown) => {
      const on = listeners.get(listener);
      if (on) worker.off('message', on);
      listeners.delete(listener);
    },
  };
  return { endpoint, terminate: () => void worker.terminate() };
}

const RUNAWAY = `
export function run(ctx) {
  const s = '1'.repeat(1 << 20);
  let x = 0;
  for (;;) x += +s;
}
`;

function scriptDoc(source: string) {
  return build([
    {
      type: 'setScript',
      script: { id: 'script#1', name: 'Runaway', language: 'js', apiVersion: 1, source },
    },
    add({
      id: 'scripted#1',
      kind: 'scripted',
      name: 'Runaway',
      suppressed: false,
      script: 'script#1',
      params: {},
      seed: 0,
      dependsOn: [],
    }),
  ]);
}

describe('the regen worker watchdog on a real thread', () => {
  it('terminates a worker whose script defeats the soft limits, and the feature fails with timeout', async () => {
    const timeouts: string[] = [];
    let restarted!: () => void;
    const restart = new Promise<void>((resolve) => {
      restarted = resolve;
    });
    const client = new RegenClient(() => spawn(300), {
      scriptTimeoutMs: 1500,
      onScriptTimeout: (e) => timeouts.push(e.featureId),
      onRestarted: () => restarted(),
    });
    try {
      await client.ready;
      const doc = scriptDoc(RUNAWAY);
      const t0 = performance.now();
      // The run holds the worker; the 300 ms soft limit does not stop it, the 1.5 s hard one does.
      expect(await client.regen(doc)).toBeNull();
      const stopped = performance.now() - t0;
      expect(timeouts).toEqual(['scripted#1']);
      expect(stopped).toBeGreaterThanOrEqual(1400);
      expect(stopped).toBeLessThan(8000);
      await restart;
      // The new worker knows the runaway key: the feature fails without running again.
      const again = (await client.regen(doc)) as RegenResult;
      const f = again.parts[0]!.features[0]!;
      expect(f.status).toBe('error');
      expect(f.errors[0]).toMatchObject({ code: 'script', scriptCode: 'timeout' });
      expect(client.runawayScripts).toEqual([f.key]);
      // An ordinary infinite loop on the new worker is stopped by the soft limit, no restart.
      const loop = (await client.regen(
        scriptDoc('export function run(ctx) { for (;;) {} }'),
      )) as RegenResult;
      expect(loop.parts[0]!.features[0]!.errors[0]).toMatchObject({ scriptCode: 'timeout' });
      expect(timeouts).toHaveLength(1);
    } finally {
      client.terminate();
    }
  }, 120_000);
});
