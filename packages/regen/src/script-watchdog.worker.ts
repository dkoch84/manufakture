// Test-only worker entry for `script-watchdog.test.ts`: the regen worker API on a Node worker
// thread, with the kernel's and QuickJS's `.wasm` bytes passed in (the test bundles this file, so
// nothing here may find files relative to itself). Not part of the package's exports.

import { parentPort, workerData } from 'node:worker_threads';
import { ScriptEngine } from '@manufakture/script';
import * as Comlink from 'comlink';
import { createRegenWorkerApi } from './worker-api';

const { kernel, quickjs, timeMs } = workerData as {
  kernel: Uint8Array;
  quickjs: Uint8Array;
  timeMs: number;
};
const port = parentPort!;
const listeners = new Map<unknown, (data: unknown) => void>();

Comlink.expose(
  createRegenWorkerApi({
    source: { bytes: kernel },
    engine: {
      scripts: { engine: () => ScriptEngine.load({ bytes: quickjs }), limits: { timeMs } },
    },
  }),
  {
    postMessage: (message: unknown, transfer?: Transferable[]) =>
      port.postMessage(message, transfer as never),
    addEventListener: (_type: string, listener: unknown) => {
      const on = (data: unknown) => (listener as (e: { data: unknown }) => void)({ data });
      listeners.set(listener, on);
      port.on('message', on);
    },
    removeEventListener: (_type: string, listener: unknown) => {
      const on = listeners.get(listener);
      if (on) port.off('message', on);
      listeners.delete(listener);
    },
  },
);
