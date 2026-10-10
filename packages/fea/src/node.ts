// Starts the FEA worker in a Node worker thread: for an agent's session (ADR 0016, ADR 0017
// question 2: the user's own machine counts as a client) and for tests. The thread's stdout goes
// to stderr, since a host's stdout may carry a protocol (the MCP server's stdio transport).

import { Worker } from 'node:worker_threads';
import * as Comlink from 'comlink';
import type { FeaWorkerHandle } from './client';
import type { FeaWorkerApi } from './worker/api';

/** The worker's script: `worker/node.ts` beside this file. */
export const NODE_WORKER_ENTRY = new URL('./worker/node.ts', import.meta.url);
const HOOKS = new URL('./worker/node-hooks.ts', import.meta.url);

/** The worker's V8 heap, MiB (typed arrays are outside it and bounded by the memory account). */
export const NODE_WORKER_HEAP_MB = 512;

export interface NodeFeaWorkerOptions {
  /** The worker's script (default `NODE_WORKER_ENTRY`); a bundled host passes its built entry. */
  url?: URL;
  /** Node options for it (default: the resolve hooks when `url` is a `.ts` file). */
  execArgv?: string[];
  heapMb?: number;
}

export function spawnNodeFeaWorker(options: NodeFeaWorkerOptions = {}): FeaWorkerHandle {
  const url = options.url ?? NODE_WORKER_ENTRY;
  const execArgv =
    options.execArgv ?? (url.pathname.endsWith('.ts') ? ['--import', HOOKS.href] : []);
  const { port1, port2 } = new MessageChannel();
  const worker = new Worker(url, {
    execArgv,
    workerData: { port: port2 },
    transferList: [port2] as never,
    stdout: true,
    resourceLimits: { maxOldGenerationSizeMb: options.heapMb ?? NODE_WORKER_HEAP_MB },
  });
  worker.stdout.pipe(process.stderr, { end: false });
  let terminated = false;
  let lastError: Error | null = null;
  worker.on('error', (error: Error) => (lastError = error));
  const api = Comlink.wrap<FeaWorkerApi>(port1 as unknown as Comlink.Endpoint);
  return {
    api,
    terminate() {
      terminated = true;
      port1.close();
      void worker.terminate();
    },
    onExit(listener) {
      worker.on('exit', (code) => {
        if (terminated) return;
        port1.close();
        const error = lastError as (Error & { code?: string }) | null;
        listener({
          message: error?.message ?? `the worker exited with code ${code}`,
          outOfMemory: error?.code === 'ERR_WORKER_OUT_OF_MEMORY',
        });
      });
    },
  };
}
