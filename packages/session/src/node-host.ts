// What a Node host gives the regen engine (ADR 0016 decision 2, T8.0a "Risks"): the bundled font
// read from disk, since Node's `fetch` refuses `file:` URLs; user fonts outlined in a text worker
// thread under the watchdog (ADR 0011's amendment); QuickJS for scripted features (ADR 0010),
// given only in a session's worker thread, which the main thread terminates when a run passes
// the hard limit (`engine.ts`); and a domain registry of its own with stock, woodworking and
// construction, as the app's regen worker registers them. Used both in this thread
// (`InProcessEngine`) and in a session's worker thread (`worker/entry.ts`).

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { registerConstruction } from '@manufakture/domain-construction';
import { registerWood } from '@manufakture/domain-wood';
import type { WasmSource } from '@manufakture/kernel';
import { STDERR_OUTPUT } from '@manufakture/kernel/node';
import {
  ExtensionRegistry,
  createRegenWorkerApi,
  createTextOutliner,
  createWatchdogOutliner,
  type FontReader,
  type RegenWorkerApi,
  type TextOutliner,
  type WorkerLike,
} from '@manufakture/regen';
import { ScriptEngine } from '@manufakture/script';
import { registerStock } from '@manufakture/stock';

/**
 * `fetch` for the bundled fonts (`@manufakture/text` finds them with `new URL(..., import.meta.url)`):
 * `file:` URLs only, so a crafted document can never make the host fetch from the network. The
 * text package checks the bytes against the font's pinned SHA-256.
 */
export async function readBundledFont(url: URL): Promise<Response> {
  if (url.protocol !== 'file:') throw new Error('Only bundled fonts are read.');
  return new Response(new Uint8Array(await readFile(fileURLToPath(url))));
}

/** A registry with the domains the app's regen worker registers. */
export function nodeExtensions(): ExtensionRegistry {
  const registry = new ExtensionRegistry();
  registerStock(registry);
  registerWood(registry);
  registerConstruction(registry);
  return registry;
}

// ---------------------------------------------------------------------------------------------
// User fonts

/** The text worker's script: `worker/text.ts` beside this file. */
export const TEXT_WORKER_ENTRY = new URL('./worker/text.ts', import.meta.url);
const TS_HOOKS = new URL('./worker/ts-hooks.ts', import.meta.url);

/**
 * The text worker's V8 heap, MiB. Past it Node ends the worker (`ERR_WORKER_OUT_OF_MEMORY`), which
 * the watchdog reports as a font that ran out of memory, instead of the whole process failing.
 */
export const TEXT_WORKER_HEAP_MB = 1024;

export interface TextWorkerOptions {
  /** The text worker's script, as a URL string (default `TEXT_WORKER_ENTRY`). */
  url?: string;
  /** Node options for it (default: the TypeScript hooks when `url` is a `.ts` file). */
  execArgv?: string[];
  /** Its V8 heap, MiB (default `TEXT_WORKER_HEAP_MB`). */
  heapMb?: number;
}

/**
 * A text worker thread as the watchdog sees a browser worker. Its stdout goes to stderr (a host's
 * stdout may carry a protocol), and a worker that exits on its own (out of memory) is a crash.
 */
export function spawnTextWorker(options: TextWorkerOptions = {}): WorkerLike {
  const url = new URL(options.url ?? TEXT_WORKER_ENTRY.href);
  const execArgv =
    options.execArgv ?? (url.pathname.endsWith('.ts') ? ['--import', TS_HOOKS.href] : []);
  const worker = new Worker(url, {
    execArgv,
    stdout: true,
    resourceLimits: { maxOldGenerationSizeMb: options.heapMb ?? TEXT_WORKER_HEAP_MB },
  });
  worker.stdout.pipe(process.stderr, { end: false });
  let ended = false;
  const like: WorkerLike = {
    onmessage: null,
    onerror: null,
    onmessageerror: null,
    postMessage(message, transfer = []) {
      worker.postMessage(message, transfer as never);
    },
    terminate() {
      ended = true;
      void worker.terminate();
    },
  };
  const crash = (message: string) => like.onerror?.({ message } as ErrorEvent);
  worker.on('message', (data: unknown) => like.onmessage?.({ data } as MessageEvent));
  worker.on('messageerror', () => like.onmessageerror?.({} as MessageEvent));
  worker.on('error', (error: Error) => crash(error.message));
  worker.on('exit', () => {
    if (!ended) crash('The text worker stopped.');
  });
  return like;
}

/**
 * The session's outliner: texts in a bundled font in this thread, as before (the font's bytes are
 * pinned by SHA-256 and every text is bounded by the text limits); texts in a user font, and
 * reading one, in a text worker under `createWatchdogOutliner`, so a font that hangs or runs out
 * of memory costs that worker and the time limit, never this thread. The text worker starts on
 * the first user font. `dispose` ends it.
 */
export function sessionTextOutliner(
  spawn: () => WorkerLike = () => spawnTextWorker(),
): TextOutliner & FontReader & { dispose(): void } {
  const bundled = createTextOutliner({ fetchImpl: readBundledFont });
  const user = createWatchdogOutliner(spawn);
  return {
    outline: (request, call) =>
      request.font.kind === 'bundled'
        ? bundled.outline(request, call)
        : user.outline(request, call),
    readFont: (fileName, bytes) => user.readFont(fileName, bytes),
    dispose: () => user.watchdog.terminate(),
  };
}

// ---------------------------------------------------------------------------------------------
// The engine

export interface SessionEngineOptions {
  /**
   * The compiled QuickJS module: scripted features run, with `@manufakture/script`'s default
   * limits. Only a session's worker thread passes it, after its watchdog is set (`watchScripts`),
   * since only a worker can be terminated when a run passes the hard limit. Absent: no script
   * runs (scripted features fail as `unsupported`).
   */
  scripts?: WebAssembly.Module;
  /** Where the text worker for user fonts comes from. */
  textWorker?: TextWorkerOptions;
}

/**
 * The regen worker API (`createRegenWorkerApi`) for a session: its own kernel service on
 * `source`, the solver, fonts (`sessionTextOutliner`), scripts when `options.scripts` is given,
 * and the domains. Which scripts run is the session's policy, sent before each regen (`engine.ts`);
 * until then none does (the API fails closed). The kernel's text output (the STEP writer's
 * statistics) goes to stderr: a host's stdout may carry a protocol (apps/mcp). `dispose` ends the
 * text worker.
 */
export function sessionEngineApi(
  source: WasmSource,
  options: SessionEngineOptions = {},
): { api: RegenWorkerApi; dispose(): void } {
  const text = sessionTextOutliner(() => spawnTextWorker(options.textWorker));
  const quickjs = options.scripts;
  const api = createRegenWorkerApi({
    source,
    loader: STDERR_OUTPUT,
    engine: {
      text,
      extensions: nodeExtensions(),
      ...(quickjs ? { scripts: { engine: () => ScriptEngine.load({ module: quickjs }) } } : {}),
    },
  });
  return { api, dispose: () => text.dispose() };
}
