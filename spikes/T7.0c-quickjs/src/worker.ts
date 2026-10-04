// The browser side: a module worker that loads QuickJS (and, for the session comparison, the
// kernel) the way the regen worker would, runs the requested measurements and posts the results.
// Started by main.ts; driven by scripts/browser.ts through Playwright.

import { KernelService, OcctLoader } from '@manufakture/kernel';
import ngAsyncifyUrl from '@jitl/quickjs-ng-wasmfile-release-asyncify/wasm?url';
import ngSyncUrl from '@jitl/quickjs-ng-wasmfile-release-sync/wasm?url';
import quickjsAsyncifyUrl from '@jitl/quickjs-wasmfile-release-asyncify/wasm?url';
import quickjsSyncUrl from '@jitl/quickjs-wasmfile-release-sync/wasm?url';
import kernelWasmUrl from 'libcascade/single/wasm?url';
import { runTasks, type Task } from './tasks';
import type { BenchEnv } from './bench';
import type { VariantName } from './variants';

const urls: Record<VariantName, string> = {
  'quickjs-sync': quickjsSyncUrl,
  'ng-sync': ngSyncUrl,
  'quickjs-asyncify': quickjsAsyncifyUrl,
  'ng-asyncify': ngAsyncifyUrl,
};

const env: BenchEnv = {
  now: () => performance.now(),
  // Streaming compile, as ADR 0002 decision 4 does for the kernel; the HTTP cache is bypassed
  // so every load measurement fetches.
  compile: (name) => WebAssembly.compileStreaming(fetch(urls[name], { cache: 'no-store' })),
  macrotask: () =>
    new Promise((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => {
        channel.port1.close();
        resolve();
      };
      channel.port2.postMessage(null);
    }),
  hostEval: (code) => (0, eval)(code) as unknown,
  log: (line) => self.postMessage({ log: line }),
};

async function kernel(): Promise<KernelService> {
  const loader = new OcctLoader({ url: kernelWasmUrl });
  return KernelService.create({ createInstance: () => loader.instantiate() });
}

/** The smallest step performance.now() takes, over a short busy loop. */
function timerResolution(): number {
  let min = Infinity;
  let last = performance.now();
  const end = last + 20;
  while (last < end) {
    const t = performance.now();
    if (t > last) {
      min = Math.min(min, t - last);
      last = t;
    }
  }
  return min;
}

self.onmessage = async (event: MessageEvent<{ tasks: Task[] }>) => {
  try {
    const results = await runTasks(env, event.data.tasks, kernel);
    self.postMessage({
      ok: true,
      isolated: self.crossOriginIsolated,
      timerMs: timerResolution(),
      results,
    });
  } catch (e) {
    self.postMessage({
      ok: false,
      error: e instanceof Error ? `${e.message}\n${e.stack}` : String(e),
    });
  }
};
