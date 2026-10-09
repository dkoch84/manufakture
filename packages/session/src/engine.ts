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
//
// Scripts (ADR 0016 decision 2, ADR 0010): a session runs its branch's own scripts, those the
// branch added or changed since its base version (`sessionScriptPolicy`), and no other; the
// policy is sent before every regen. They run only in a worker engine, under the script
// package's limits and the hard limit here: a run still going after `scriptTimeoutMs` ends the
// worker (`ScriptStopped`), and every later worker fails that run with a timeout instead of
// running it again. An in-process engine cannot end a run, so it runs no script.

import { MessageChannel as NodeMessageChannel, Worker } from 'node:worker_threads';
import type { ManufaktureDocument } from '@manufakture/core';
import { nodeLoader } from '@manufakture/kernel/node';
import type { KernelStats, KernelStatus } from '@manufakture/kernel';
import {
  DENY_ALL_SCRIPTS,
  sourceSha256,
  type RegenWorkerApi,
  type ScriptPolicy,
  type ScriptRunEvent,
} from '@manufakture/regen';
import { RECOMMENDED_HARD_TIMEOUT_MS } from '@manufakture/script';
import { nodeScriptModule } from '@manufakture/script/node';
import * as Comlink from 'comlink';
import { sessionEngineApi, type TextWorkerOptions } from './node-host';

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
  /**
   * The session's base document (its branch's base version): the scripts of a regenerated
   * document that are not in it as they are there are the branch's own, and run
   * (`sessionScriptPolicy`). Null or absent: no script runs. Kept across restarts.
   */
  scriptBase?: ManufaktureDocument | null;
  /** Cache keys of the script runs the hard limit stopped; later workers fail them at once. */
  readonly runawayScripts?: readonly string[];
  /** Fail these runs at once from now on too (another engine of the session stopped them). */
  addRunawayScripts?(keys: readonly string[]): Promise<void>;
}

export interface EngineOptions {
  /** Kernel heap threshold, bytes. */
  heapThresholdBytes: number;
  /** Where the text worker for user fonts comes from (default `worker/text.ts`). */
  textWorker?: TextWorkerOptions;
}

/** Thrown by a worker engine's calls when its worker died (or was terminated) under them. */
export class EngineLost extends Error {
  constructor(message = 'The geometry worker stopped.') {
    super(message);
    this.name = 'EngineLost';
  }
}

/**
 * Thrown by a worker engine's calls when the script hard limit ended its worker: a run was still
 * going after `scriptTimeoutMs`. The run is remembered, so a regen on the next worker fails that
 * scripted feature with a timeout and does not run it again.
 */
export class ScriptStopped extends EngineLost {
  readonly featureId: string;
  constructor(featureId: string, ms: number) {
    super(`A script ran longer than ${ms} ms and its worker was stopped.`);
    this.name = 'ScriptStopped';
    this.featureId = featureId;
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
// Which scripts run

/**
 * The scripts a session runs (ADR 0016 decision 2): its branch's own, those of `document` that
 * `base` does not have with the same id and source, each granted by its id and the SHA-256 of its
 * source, as the app grants a script the user wrote on this device (`ScriptPolicy.scripts`). Never
 * a whole document and never `auto`, so the scripts of a derived part's source document, and
 * scripts already in the document from someone else, do not run. Null `base`: none runs.
 */
export async function sessionScriptPolicy(
  document: ManufaktureDocument,
  base: ManufaktureDocument | null,
): Promise<ScriptPolicy> {
  if (base === null) return DENY_ALL_SCRIPTS;
  const before = new Map((base.scripts ?? []).map((s) => [s.id, s.source]));
  const scripts: { document: string; script: string; sha256: string }[] = [];
  for (const s of document.scripts ?? []) {
    if (before.get(s.id) === s.source) continue;
    scripts.push({ document: document.id, script: s.id, sha256: await sourceSha256(s.source) });
  }
  return { auto: false, documents: [], scripts };
}

const DENY_ALL_KEY = JSON.stringify(DENY_ALL_SCRIPTS);

/**
 * Sends the session's policy for `document` to `api` before its regen, when it differs from the
 * one `api` has (`sent`, which starts as the API's own: deny all).
 */
async function sendPolicy(
  api: Pick<RegenWorkerApi, 'setScriptPolicy'>,
  sent: { key: string },
  document: ManufaktureDocument,
  base: ManufaktureDocument | null,
): Promise<void> {
  const policy = await sessionScriptPolicy(document, base);
  const key = JSON.stringify(policy);
  if (key === sent.key) return;
  // Until the API confirms, assume the worst it may hold (it denies all when it refuses one).
  sent.key = DENY_ALL_KEY;
  await api.setScriptPolicy(policy);
  sent.key = key;
}

/** The hard limit on one script run, ms: the browser's (`SCRIPT_HARD_TIMEOUT_MS`). */
export const SCRIPT_HARD_TIMEOUT_MS = RECOMMENDED_HARD_TIMEOUT_MS;

/** The most stopped runs an engine remembers (the oldest is forgotten first). */
export const MAX_RUNAWAY_SCRIPTS = 1000;

function remember(runaway: Set<string>, key: string): boolean {
  if (runaway.has(key)) return false;
  runaway.add(key);
  while (runaway.size > MAX_RUNAWAY_SCRIPTS) runaway.delete(runaway.values().next().value!);
  return true;
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
  scriptBase: ManufaktureDocument | null = null;
  #api: RegenWorkerApi;
  #dispose: () => void;
  #replaced = 0;

  private constructor(api: RegenWorkerApi, dispose: () => void) {
    this.#api = api;
    this.#dispose = dispose;
    // No script engine here (a run in this thread could not be ended), so the policy only
    // decides how a scripted feature fails; it is sent all the same.
    const sent = { key: DENY_ALL_KEY };
    this.api = {
      ...pick(api),
      regen: async (document, regenOptions) => {
        await sendPolicy(api, sent, document, this.scriptBase);
        return api.regen(document, regenOptions);
      },
    };
  }

  static async start(options: EngineOptions): Promise<InProcessEngine> {
    const { api, dispose } = sessionEngineApi(
      { module: await wasmModule() },
      options.textWorker ? { textWorker: options.textWorker } : {},
    );
    const engine = new InProcessEngine(api, dispose);
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
    // The text worker, if a user font started one. Nothing else to stop: the session drops its
    // reference to the API, and with it the kernel service and its instance, which V8 frees
    // when it collects them.
    this.#dispose();
    collect();
  }
}

/** The calls of `EngineApi` from a full API, bound to it. */
function pick(api: RegenWorkerApi): EngineApi {
  return {
    regen: (document, options) => api.regen(document, options),
    run: ((request) => api.run(request)) as EngineApi['run'],
    release: (shapes) => api.release(shapes),
    cancel: (generation) => api.cancel(generation),
    stats: () => api.stats(),
    interference: (assemblyId, options, onPair) => api.interference(assemblyId, options, onPair),
    orientedSizes: (document, partId, options) => api.orientedSizes(document, partId, options),
  };
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
  /** The hard limit on one script run, ms (default `SCRIPT_HARD_TIMEOUT_MS`). */
  scriptTimeoutMs?: number;
}

interface Spawned {
  worker: Worker;
  api: Comlink.Remote<RegenWorkerApi>;
  /** Rejects when the worker exits or fails. */
  lost: Promise<never>;
  exited: boolean;
  /** The policy the worker holds. */
  policy: { key: string };
}

/** What every worker of one engine shares: QuickJS, and the runs the hard limit stopped. */
interface Scripts {
  module: WebAssembly.Module;
  runaway: Set<string>;
  timeoutMs: number;
}

export class WorkerEngine implements Engine {
  readonly kind = 'worker';
  scriptBase: ManufaktureDocument | null = null;
  readonly #options: WorkerEngineOptions;
  readonly #module: WebAssembly.Module;
  readonly #scripts: Scripts;
  #current: Spawned;
  #api: EngineApi;
  #replaced = 0;
  #closed = false;

  private constructor(
    options: WorkerEngineOptions,
    module: WebAssembly.Module,
    scripts: Scripts,
    first: Spawned,
  ) {
    this.#options = options;
    this.#module = module;
    this.#scripts = scripts;
    this.#current = first;
    this.#api = this.#guard(first);
  }

  static async start(options: WorkerEngineOptions): Promise<WorkerEngine> {
    const timeoutMs = options.scriptTimeoutMs ?? SCRIPT_HARD_TIMEOUT_MS;
    if (!(timeoutMs > 0)) throw new RangeError('scriptTimeoutMs must be above 0');
    const [module, quickjs] = await Promise.all([wasmModule(), nodeScriptModule()]);
    const scripts: Scripts = { module: quickjs, runaway: new Set(), timeoutMs };
    const first = await spawn(options, module, scripts);
    return new WorkerEngine(options, module, scripts, first);
  }

  get api(): EngineApi {
    return this.#api;
  }

  get replaced(): number {
    return this.#replaced;
  }

  get runawayScripts(): readonly string[] {
    return [...this.#scripts.runaway];
  }

  async addRunawayScripts(keys: readonly string[]): Promise<void> {
    let added = false;
    for (const key of keys) {
      if (typeof key === 'string' && key.length <= 256)
        added = remember(this.#scripts.runaway, key) || added;
    }
    // A worker gets the list when it starts, before anything else (`worker/entry.ts`).
    if (added) await this.restart();
  }

  /** The worker's API with every call racing its death, and the policy sent before a regen. */
  #guard(spawned: Spawned): EngineApi {
    const api = guard(spawned);
    return {
      ...api,
      regen: async (document, options) => {
        await race(spawned, sendPolicy(spawned.api, spawned.policy, document, this.scriptBase));
        return api.regen(document, options);
      },
    };
  }

  async restart(): Promise<void> {
    if (this.#closed) throw new EngineLost('The session is closed.');
    const old = this.#current;
    await stop(old);
    const next = await spawn(this.#options, this.#module, this.#scripts);
    // The session may have closed while the new worker started (a start takes seconds, up to
    // `startMs`): close stopped only the old one, so nothing would ever end this one.
    if (this.#closed) {
      await stop(next).catch(() => undefined);
      throw new EngineLost('The session is closed.');
    }
    this.#current = next;
    this.#api = this.#guard(next);
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

async function spawn(
  options: WorkerEngineOptions,
  module: WebAssembly.Module,
  scripts: Scripts,
): Promise<Spawned> {
  const url = options.url ?? ENTRY;
  const execArgv =
    options.execArgv ?? (url.pathname.endsWith('.ts') ? ['--import', TS_HOOKS.href] : []);
  const { port1, port2 } = new MessageChannel();
  // The script watchdog's channel: the worker reports every run's start and end on it.
  const watch = new NodeMessageChannel();
  const worker = new Worker(url, {
    execArgv,
    workerData: {
      port: port2,
      module,
      scripts: scripts.module,
      watch: watch.port2,
      runaway: [...scripts.runaway],
      ...(options.textWorker ? { textWorker: options.textWorker } : {}),
    },
    transferList: [port2, watch.port2] as never,
    // The worker's stdout is not the host's: anything it prints goes to stderr, since a host's
    // stdout may carry a protocol (apps/mcp's stdio transport).
    stdout: true,
  });
  worker.stdout.pipe(process.stderr, { end: false });
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
    policy: { key: DENY_ALL_KEY },
  };
  // The hard limit: one run at a time holds the worker, so one timer. A run that has not ended
  // when it fires is remembered and its worker terminated.
  let running: { key: string; timer: ReturnType<typeof setTimeout> } | null = null;
  let stopped: ScriptStopped | null = null;
  const endRun = () => {
    if (running !== null) clearTimeout(running.timer);
    running = null;
  };
  watch.port1.on('message', (data: unknown) => {
    const event = data as Partial<ScriptRunEvent> | null;
    if (spawned.exited || event === null || typeof event !== 'object') return;
    const { phase, key, featureId } = event;
    if (typeof key !== 'string' || key.length > 256) return;
    if (phase === 'end') {
      if (running?.key === key) endRun();
      return;
    }
    if (phase !== 'start') return;
    endRun();
    const feature = typeof featureId === 'string' ? featureId.slice(0, 200) : '';
    running = {
      key,
      timer: setTimeout(() => {
        running = null;
        if (spawned.exited) return;
        remember(scripts.runaway, key);
        stopped = new ScriptStopped(feature, scripts.timeoutMs);
        void worker.terminate();
      }, scripts.timeoutMs),
    };
  });
  worker.on('error', (error) => {
    spawned.exited = true;
    fail(stopped ?? new EngineLost(`The geometry worker failed: ${error.message}`));
  });
  worker.on('exit', () => {
    spawned.exited = true;
    endRun();
    port1.close();
    watch.port1.close();
    fail(stopped ?? new EngineLost());
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
