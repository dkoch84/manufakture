// Where a session's regen engine and kernel run (ADR 0016 decision 3). One kernel service per
// session, never shared: a recycle drops every shape of every engine on a service.
//
// - `WorkerEngine` (the default): the regen worker API (`createRegenWorkerApi`: engine, kernel,
//   solver, text) in a worker thread of the session's own, over Comlink. The kernel never recycles
//   in place: when its heap passes the threshold the session's worker is terminated and a new one
//   started, which frees the old instance at once (the T8.0a open item; README "Memory"). A regen
//   that does not stop when cancelled is ended the same way.
// - `InProcessEngine`: the same API in this thread, the kernel recycling in place as in the app.
//   Cheaper to start (tests use it); a recycled instance is freed only when V8 collects it, and a
//   regen that does not stop cannot be ended.

import { Worker } from 'node:worker_threads';
import { nodeLoader } from '@manufakture/kernel/node';
import type { KernelStats, KernelStatus } from '@manufakture/kernel';
import type { RegenWorkerApi } from '@manufakture/regen';
import * as Comlink from 'comlink';
import { sessionEngineApi } from './node-host';

/** What the session calls on its engine. */
export type EngineApi = Pick<
  RegenWorkerApi,
  'regen' | 'run' | 'release' | 'cancel' | 'stats' | 'interference' | 'orientedSizes'
>;

export interface Engine {
  readonly kind: 'worker' | 'in-process';
  /** The engine to call now; a restart replaces it (every shape and cached body is then gone). */
  readonly api: EngineApi;
  /** How many times the kernel was replaced (restarts and in-place recycles). */
  readonly replaced: number;
  /**
   * Replace the kernel with a fresh one, freeing the old (a worker: terminated). Every shape is
   * gone afterwards; the caller regenerates.
   */
  restart(): Promise<void>;
  /**
   * End a regen that did not stop when cancelled. A worker engine terminates and restarts
   * (true); an in-process one cannot (false).
   */
  kill(): Promise<boolean>;
  /** Whether the kernel should be replaced now (its heap is past the threshold). */
  wantsRestart(): Promise<boolean>;
  close(): Promise<void>;
}

export interface EngineOptions {
  /** Kernel heap threshold, bytes. */
  heapThresholdBytes: number;
}

/** Thrown by a worker engine's calls when its worker died (or was terminated) under them. */
export class EngineLost extends Error {
  constructor(message = 'The geometry worker stopped.') {
    super(message);
    this.name = 'EngineLost';
  }
}

/** Thrown by a session's kernel call that ran over its deadline (the kernel was ended). */
export class KernelTimeout extends Error {
  readonly ms: number;
  constructor(ms: number) {
    super(`The kernel call took longer than ${ms} ms.`);
    this.name = 'KernelTimeout';
    this.ms = ms;
  }
}

/** How long a new worker may take to load its kernel before it is terminated. */
export const WORKER_START_MS = 120_000;

async function wasmModule(): Promise<WebAssembly.Module> {
  return (await nodeLoader()).compile();
}

// ---------------------------------------------------------------------------------------------
// In this thread

/** Ask V8 for a full collection when the host runs with `--expose-gc` (README, "Memory"). */
function collect(): void {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (typeof gc === 'function') gc();
}

export class InProcessEngine implements Engine {
  readonly kind = 'in-process';
  readonly api: EngineApi;
  #api: RegenWorkerApi;
  #replaced = 0;

  private constructor(api: RegenWorkerApi) {
    this.#api = api;
    this.api = api;
  }

  static async start(options: EngineOptions): Promise<InProcessEngine> {
    const api = sessionEngineApi({ module: await wasmModule() });
    const engine = new InProcessEngine(api);
    await api.init({ heapThresholdBytes: options.heapThresholdBytes }, (status: KernelStatus) => {
      if (status.type !== 'recycled') return;
      engine.#replaced++;
      // The old instance is unreachable now; it is freed only when V8 collects it. One
      // collection right after the recycle may still find it referenced from the recycle's own
      // frames (T8.0a), so ask once more on the next turn.
      setTimeout(collect, 0).unref();
    });
    return engine;
  }

  get replaced(): number {
    return this.#replaced;
  }

  async restart(): Promise<void> {
    await this.#api.recycle();
  }

  async kill(): Promise<boolean> {
    return false;
  }

  async wantsRestart(): Promise<boolean> {
    // The service recycles by itself at its threshold.
    return false;
  }

  async close(): Promise<void> {
    // Nothing to stop: the session drops its reference to the API, and with it the kernel
    // service and its instance, which V8 frees when it collects them.
    collect();
  }
}

// ---------------------------------------------------------------------------------------------
// In a worker thread

export interface WorkerEngineOptions extends EngineOptions {
  /**
   * The worker's script. Default: `worker/entry.ts` beside this file, loaded through
   * `worker/ts-hooks.ts` (development and tests). A bundled host passes its built entry.
   */
  url?: URL;
  /** Node options for the worker (default: the TypeScript hooks when `url` is a `.ts` file). */
  execArgv?: string[];
  /** How long a new worker may take to load its kernel, ms (default `WORKER_START_MS`). */
  startMs?: number;
}

interface Spawned {
  worker: Worker;
  api: Comlink.Remote<RegenWorkerApi>;
  /** Rejects when the worker exits or fails. */
  lost: Promise<never>;
  exited: boolean;
}

export class WorkerEngine implements Engine {
  readonly kind = 'worker';
  readonly #options: WorkerEngineOptions;
  readonly #module: WebAssembly.Module;
  #current: Spawned;
  #api: EngineApi;
  #replaced = 0;
  #closed = false;

  private constructor(options: WorkerEngineOptions, module: WebAssembly.Module, first: Spawned) {
    this.#options = options;
    this.#module = module;
    this.#current = first;
    this.#api = guard(first);
  }

  static async start(options: WorkerEngineOptions): Promise<WorkerEngine> {
    const module = await wasmModule();
    const first = await spawn(options, module);
    return new WorkerEngine(options, module, first);
  }

  get api(): EngineApi {
    return this.#api;
  }

  get replaced(): number {
    return this.#replaced;
  }

  async restart(): Promise<void> {
    if (this.#closed) throw new EngineLost('The session is closed.');
    const old = this.#current;
    await stop(old);
    this.#current = await spawn(this.#options, this.#module);
    this.#api = guard(this.#current);
    this.#replaced++;
  }

  async kill(): Promise<boolean> {
    await this.restart();
    return true;
  }

  async wantsRestart(): Promise<boolean> {
    if (this.#current.exited) return true;
    const stats: KernelStats = await this.#api.stats();
    return stats.heapBytes > this.#options.heapThresholdBytes;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await stop(this.#current);
  }
}

const TS_HOOKS = new URL('./worker/ts-hooks.ts', import.meta.url);
const ENTRY = new URL('./worker/entry.ts', import.meta.url);

async function spawn(options: WorkerEngineOptions, module: WebAssembly.Module): Promise<Spawned> {
  const url = options.url ?? ENTRY;
  const execArgv =
    options.execArgv ?? (url.pathname.endsWith('.ts') ? ['--import', TS_HOOKS.href] : []);
  const { port1, port2 } = new MessageChannel();
  const worker = new Worker(url, {
    execArgv,
    workerData: { port: port2, module },
    transferList: [port2 as unknown as Transferable] as never,
  });
  let fail: (error: Error) => void = () => undefined;
  const lost = new Promise<never>((_, reject) => {
    fail = reject;
  });
  // Nobody may be waiting when it dies; a rejection nobody awaits must not surface.
  lost.catch(() => undefined);
  const spawned: Spawned = {
    worker,
    api: Comlink.wrap<RegenWorkerApi>(port1 as unknown as Comlink.Endpoint),
    lost,
    exited: false,
  };
  worker.on('error', (error) => {
    spawned.exited = true;
    fail(new EngineLost(`The geometry worker failed: ${error.message}`));
  });
  worker.on('exit', () => {
    spawned.exited = true;
    port1.close();
    fail(new EngineLost());
  });
  // Load the kernel now (the worker compiles nothing: the module is shared), within a deadline.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new EngineLost('The geometry worker did not start in time.')),
      options.startMs ?? WORKER_START_MS,
    );
  });
  try {
    await race(spawned, Promise.race([spawned.api.init({ autoRecycle: false }), late]));
  } catch (e) {
    await stop(spawned).catch(() => undefined);
    throw e;
  } finally {
    clearTimeout(timer);
  }
  return spawned;
}

async function stop(spawned: Spawned): Promise<void> {
  if (spawned.exited) return;
  spawned.api[Comlink.releaseProxy]();
  await spawned.worker.terminate();
}

/** `call`, or the worker's death, whichever comes first. */
function race<T>(spawned: Spawned, call: Promise<T>): Promise<T> {
  return Promise.race([call, spawned.lost]);
}

/** The worker's API with every call racing the worker's death (Comlink would wait for ever). */
function guard(spawned: Spawned): EngineApi {
  const api = spawned.api;
  return {
    regen: (document, options) => race(spawned, api.regen(document, options)),
    run: ((request) => race(spawned, api.run(request))) as EngineApi['run'],
    release: (shapes) => race(spawned, api.release(shapes)),
    cancel: (generation) => race(spawned, api.cancel(generation)),
    stats: () => race(spawned, api.stats()),
    interference: (assemblyId, options) => race(spawned, api.interference(assemblyId, options)),
    orientedSizes: (document, partId, options) =>
      race(spawned, api.orientedSizes(document, partId, options)),
  };
}

export type EngineKind = Engine['kind'];

/** Start an engine of `kind`. */
export function startEngine(
  kind: EngineKind,
  options: EngineOptions & Omit<WorkerEngineOptions, keyof EngineOptions>,
): Promise<Engine> {
  return kind === 'worker' ? WorkerEngine.start(options) : InProcessEngine.start(options);
}
