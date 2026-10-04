// The script host (ADR 0010 decision 4, measured by T7.0c): Bellard's QuickJS, sync release build
// of quickjs-emscripten 0.32.0, its .wasm compiled once (`ScriptEngine`) and instantiated per
// document (`ScriptInstance`; a source document carried by a derived feature counts as its own
// document). An instance has one QuickJS runtime and makes a fresh context for every run, so no
// JavaScript state survives from one run to the next; separate instances also have separate
// linear memories, so an interpreter memory-safety bug in one document's script cannot read
// another document's heap.
//
// After an out-of-memory, a thrown `null`, a wasm trap or a host stack overflow, the instance is
// dropped without touching it again (T7.0c: the runtime can be corrupt, and touching it trapped
// in Node and crashed a Chromium page) and the next run makes a new one (about 1 ms).

import variant from '@jitl/quickjs-wasmfile-release-sync';
import {
  DefaultIntrinsics,
  newQuickJSWASMModuleFromVariant,
  newVariant,
  type QuickJSContext,
  type QuickJSHandle,
  type QuickJSRuntime,
  type QuickJSWASMModule,
} from 'quickjs-emscripten-core';
import { CodecError, HandleTable, decodePayload, encodeValue } from './codec';
import { prepareSource, type PreparedSource, type ScriptLanguage } from './erase';
import {
  LIMIT_CODES,
  ScriptHostError,
  scriptError,
  type ScriptError,
  type ScriptErrorCode,
} from './errors';
import { flattenHostApi, type FlatHostFunction, type HostApi, type ScriptValue } from './host';
import { BASE_MEMORY_BYTES, resolveLimits, type ScriptLimits } from './limits';
import { parseParamDeclarations, type ScriptDeclarations } from './params';
import { MARK, PRELUDE_FILENAME, PRELUDE_SOURCE, TICK_WORK, type PreludeConfig } from './prelude';
import { randomSeed } from './random';
import type { SourcePosition } from './sourcemap';
import { checkApiVersion } from './version';

/**
 * The QuickJS build, for cache keys (ADR 0010 decision 5: a scripted feature's key includes the
 * build identity). Change it whenever the pinned packages change.
 */
export const QUICKJS_BUILD = 'quickjs-2025-09-13+f1139494/quickjs-emscripten-0.32.0/release-sync';

/** Where the .wasm comes from (as in `packages/kernel`'s loader). */
export type WasmSource =
  | { url: string; fetch?: typeof fetch }
  | { bytes: ArrayBuffer | Uint8Array }
  | { module: WebAssembly.Module };

const PAGE = 65536;
const INTRINSICS = { ...DefaultIntrinsics, Date: false } as const;

/** The compiled QuickJS module: one per worker. */
export class ScriptEngine {
  readonly module: WebAssembly.Module;

  private constructor(module: WebAssembly.Module) {
    this.module = module;
  }

  /** Fetches (with streaming compile) or compiles the .wasm. */
  static async load(source: WasmSource): Promise<ScriptEngine> {
    if ('module' in source) return new ScriptEngine(source.module);
    if ('bytes' in source) {
      return new ScriptEngine(await WebAssembly.compile(source.bytes as BufferSource));
    }
    const doFetch = source.fetch ?? fetch;
    const response = await doFetch(source.url, { credentials: 'same-origin' });
    if (!response.ok) throw new Error(`QuickJS wasm: HTTP ${response.status} for ${source.url}`);
    const type = response.headers.get('content-type') ?? '';
    const module = type.startsWith('application/wasm')
      ? await WebAssembly.compileStreaming(response)
      : await WebAssembly.compile(await response.arrayBuffer());
    return new ScriptEngine(module);
  }

  /** A new instance (one per document). `heapBytes` is read here and on every recycle. */
  async createInstance(options: ScriptInstanceOptions = {}): Promise<ScriptInstance> {
    const instance = new ScriptInstance(this.module, options);
    await instance.ready();
    return instance;
  }
}

export interface ScriptInstanceOptions {
  /** Defaults for every run of this instance (`DEFAULT_LIMITS` otherwise). */
  limits?: Partial<ScriptLimits>;
  /** Clock in ms; `performance.now` by default. Tests pass their own. */
  now?: () => number;
}

/** Where the source comes from: as stored in the document (T7.2a). */
export interface ScriptSource {
  source: string;
  language: ScriptLanguage;
  /** The version the script is stamped with. */
  apiVersion: number;
}

export interface ScriptRunRequest extends ScriptSource {
  /** The feature's seed (an integer, default 0). Seeds `Math.random` with the source hash. */
  seed?: number;
  /** The `params` argument of `run` (see `resolveParams`). */
  params?: Readonly<Record<string, ScriptValue>>;
  /** The `ctx` argument of `run`. */
  host?: HostApi;
  /** Overrides for this run (`heapBytes` applies only when an instance is made). */
  limits?: Partial<ScriptLimits>;
}

export interface ScriptRunStats {
  ms: number;
  hostCalls: number;
  kernelOps: number;
  /** The instance's linear memory after the run. */
  memoryBytes: number;
  /** The instance was dropped after this run; the next run makes a new one. */
  recycled: boolean;
}

export type ScriptOutcome<T> =
  | { ok: true; value: T; stats: ScriptRunStats }
  | { ok: false; error: ScriptError; stats: ScriptRunStats };

interface Live {
  module: QuickJSWASMModule;
  memory: WebAssembly.Memory;
  runtime: QuickJSRuntime;
  heapBytes: number;
}

/** Thrown inside the host to unwind a run whose instance must not be touched again. */
class FatalRun extends Error {
  readonly error: ScriptError;

  constructor(error: ScriptError) {
    super(error.message);
    this.error = error;
  }
}

/** Per-run bookkeeping shared by the raw host functions and the interrupt handler. */
class RunState {
  readonly limits: ScriptLimits;
  readonly now: () => number;
  readonly start: number;
  readonly deadline: number;
  readonly handles = new HandleTable();
  hostCalls = 0;
  kernelOps = 0;
  abort: ScriptError | null = null;

  constructor(limits: ScriptLimits, now: () => number) {
    this.limits = limits;
    this.now = now;
    this.start = now();
    this.deadline = this.start + limits.timeMs;
  }

  stop(code: ScriptErrorCode, message: string): void {
    if (this.abort === null) this.abort = scriptError(code, message);
  }

  /** True once the run must end: already stopped, or out of time. */
  expired(): boolean {
    if (this.abort !== null) return true;
    if (this.now() > this.deadline) {
      this.stop('timeout', `The script ran longer than the ${formatMs(this.limits.timeMs)} limit.`);
      return true;
    }
    return false;
  }
}

/** One document's QuickJS instance. Runs are serial: a run holds the instance until it returns. */
export class ScriptInstance {
  private readonly wasmModule: WebAssembly.Module;
  private readonly baseLimits: ScriptLimits;
  private readonly now: () => number;
  private live: Live | null = null;
  private pending: Promise<Live> | null = null;
  private running = false;
  private pendingJobs = false;
  private disposed = false;
  private generationCount = 0;
  private readonly prepared = new Map<string, PreparedSource | ScriptError>();

  constructor(wasmModule: WebAssembly.Module, options: ScriptInstanceOptions = {}) {
    this.wasmModule = wasmModule;
    this.baseLimits = resolveLimits(options.limits);
    this.now = options.now ?? (() => performance.now());
  }

  /** How many module instances this document has had (1 after the first run; +1 per recycle). */
  get generation(): number {
    return this.generationCount;
  }

  /** Current linear memory, or 0 when no module instance is live. */
  get memoryBytes(): number {
    return this.live?.memory.buffer.byteLength ?? 0;
  }

  /** The live instance's memory, for tests that check two documents do not share one. */
  get memory(): WebAssembly.Memory | null {
    return this.live?.memory ?? null;
  }

  /** Makes the module instance if there is none (runs do this themselves). */
  async ready(): Promise<void> {
    await this.ensure();
  }

  /** Drops the module instance; the next run makes a new one. */
  recycle(): void {
    this.drop(true);
  }

  dispose(): void {
    this.disposed = true;
    this.drop(true);
  }

  /**
   * The cheap first run: evaluates the module (top-level code only, no `ctx`) and reads its
   * `params` and `apiVersion` exports. Use it to build the feature dialog and to resolve
   * parameter values before `run`.
   */
  async readDeclarations(
    request: ScriptSource & { limits?: Partial<ScriptLimits> },
  ): Promise<ScriptOutcome<ScriptDeclarations>> {
    const outcome = await this.execute(request, 'read', undefined, {}, 0);
    if (!outcome.ok) return outcome;
    const raw = outcome.value;
    const fail = (error: ScriptError): ScriptOutcome<ScriptDeclarations> => ({
      ok: false,
      error,
      stats: outcome.stats,
    });
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      return fail(scriptError('internal', 'The declaration run returned nothing.'));
    }
    const record = raw as Record<string, ScriptValue>;
    if (record.run !== 'function') {
      return fail(
        scriptError('bad-declaration', 'The script must export a function run(ctx, params).'),
      );
    }
    let declared: number | null = null;
    if (record.apiVersion !== undefined) {
      const versionError = checkApiVersion(record.apiVersion);
      if (versionError !== null) return fail(versionError);
      declared = record.apiVersion as number;
      if (declared !== request.apiVersion) {
        return fail(
          scriptError(
            'api-version',
            `The script declares script API version ${declared} but is stored as version ${request.apiVersion}.`,
          ),
        );
      }
    }
    const params = parseParamDeclarations(record.params);
    if (!params.ok) return fail(params.error);
    return {
      ok: true,
      value: { declaredApiVersion: declared, params: params.value },
      stats: outcome.stats,
    };
  }

  /** Runs the script's `run(ctx, params)` and returns its result as plain data. */
  async run(request: ScriptRunRequest): Promise<ScriptOutcome<ScriptValue>> {
    const seed = request.seed ?? 0;
    if (!Number.isSafeInteger(seed)) {
      return {
        ok: false,
        error: scriptError('bad-param', 'The feature seed must be a whole number.'),
        stats: this.stats(this.now(), null, false),
      };
    }
    return this.execute(request, 'run', request.host ?? {}, request.params ?? {}, seed);
  }

  private async ensure(): Promise<Live> {
    if (this.disposed) throw new Error('script instance is disposed');
    if (this.live !== null) return this.live;
    if (this.pending === null) {
      const heapBytes = this.baseLimits.heapBytes;
      const memory = new WebAssembly.Memory({
        initial: BASE_MEMORY_BYTES / PAGE,
        maximum: Math.ceil((BASE_MEMORY_BYTES + heapBytes) / PAGE),
      });
      this.pending = newQuickJSWASMModuleFromVariant(
        newVariant(variant, { wasmModule: this.wasmModule, wasmMemory: memory }),
      ).then(
        (module) => {
          const runtime = module.newRuntime();
          runtime.setMemoryLimit(heapBytes);
          const live = { module, memory, runtime, heapBytes };
          this.live = live;
          this.pending = null;
          this.generationCount++;
          return live;
        },
        (e: unknown) => {
          this.pending = null;
          throw e;
        },
      );
    }
    return this.pending;
  }

  private drop(cleanly: boolean): void {
    const live = this.live;
    this.live = null;
    if (live !== null && cleanly) {
      try {
        live.runtime.dispose();
      } catch {
        // Leaked contexts make dispose assert; the memory goes with the instance anyway.
      }
    }
  }

  private stats(start: number, state: RunState | null, recycled: boolean): ScriptRunStats {
    return {
      ms: this.now() - start,
      hostCalls: state?.hostCalls ?? 0,
      kernelOps: state?.kernelOps ?? 0,
      memoryBytes: this.memoryBytes,
      recycled,
    };
  }

  private prepare(source: string, language: ScriptLanguage): PreparedSource | ScriptError {
    const key = `${language}\u0000${source}`;
    const cached = this.prepared.get(key);
    if (cached !== undefined) return cached;
    const result = prepareSource(source, language);
    const value = result.ok ? result.value : result.error;
    if (this.prepared.size >= 32) {
      const oldest = this.prepared.keys().next().value;
      if (oldest !== undefined) this.prepared.delete(oldest);
    }
    this.prepared.set(key, value);
    return value;
  }

  private async execute(
    request: ScriptSource & { limits?: Partial<ScriptLimits> },
    entry: 'read' | 'run',
    host: HostApi | undefined,
    params: Readonly<Record<string, ScriptValue>>,
    seed: number,
  ): Promise<ScriptOutcome<ScriptValue>> {
    const t0 = this.now();
    const early = (error: ScriptError): ScriptOutcome<ScriptValue> => ({
      ok: false,
      error,
      stats: this.stats(t0, null, false),
    });
    const versionError = checkApiVersion(request.apiVersion);
    if (versionError !== null) return early(versionError);
    if (typeof request.source !== 'string') {
      return early(scriptError('bad-declaration', 'The script source is missing.'));
    }
    const prepared = this.prepare(request.source, request.language);
    if (!('toSource' in prepared)) return early(prepared);
    let limits: ScriptLimits;
    let api: ReturnType<typeof flattenHostApi>;
    try {
      limits = resolveLimits({ ...this.baseLimits, ...request.limits });
      api = flattenHostApi(host ?? {});
    } catch (e) {
      return early(scriptError('host-error', e instanceof Error ? e.message : String(e)));
    }
    if (this.running) {
      return early(scriptError('host-error', 'A script is already running in this instance.'));
    }
    this.running = true;
    try {
      const live = await this.ensure();
      const state = new RunState(limits, this.now);
      let result: { ok: true; value: ScriptValue } | { ok: false; error: ScriptError };
      let fatal = false;
      try {
        result = this.runIn(
          live,
          state,
          prepared,
          entry,
          api,
          params,
          randomSeed(request.source, seed),
        );
      } catch (e) {
        fatal = true;
        result = { ok: false, error: e instanceof FatalRun ? e.error : hostFailure(e) };
      }
      // An instance that grew past the threshold, or that hit the heap cap even if the script
      // caught the error, is replaced: linear memory never shrinks.
      const pending = this.pendingJobs;
      this.pendingJobs = false;
      const recycled =
        fatal ||
        pending ||
        live.memory.buffer.byteLength > Math.min(limits.recycleAboveBytes, nearCap(live));
      if (recycled) this.drop(!fatal && !pending);
      const stats = this.stats(t0, state, recycled);
      return result.ok
        ? { ok: true, value: result.value, stats }
        : { ok: false, error: result.error, stats };
    } finally {
      this.running = false;
    }
  }

  /**
   * One run in a fresh context. Returns script-level failures; throws FatalRun (or anything from
   * a trap) when the instance must be dropped.
   */
  private runIn(
    live: Live,
    state: RunState,
    prepared: PreparedSource,
    entry: 'read' | 'run',
    api: ReturnType<typeof flattenHostApi>,
    params: Readonly<Record<string, ScriptValue>>,
    seed: number,
  ): { ok: true; value: ScriptValue } | { ok: false; error: ScriptError } {
    const { runtime, memory } = live;
    const limits = state.limits;
    runtime.setInterruptHandler(() => state.expired());
    const ctx = runtime.newContext({ intrinsics: INTRINSICS });
    runtime.setMaxStackSize(limits.stackBytes);
    const handles: QuickJSHandle[] = [];
    const keep = (h: QuickJSHandle): QuickJSHandle => {
      handles.push(h);
      return h;
    };
    let corrupt = false;
    try {
      const config: PreludeConfig = {
        seed,
        mark: MARK,
        tickWork: TICK_WORK,
        maxStringLength: limits.maxStringLength,
        maxElements: limits.maxElements,
        maxDepth: limits.maxDepth,
        maxPayloadLength: limits.maxPayloadLength,
        api: api.shape as PreludeConfig['api'],
      };
      const setupResult = ctx.evalCode(PRELUDE_SOURCE, PRELUDE_FILENAME, {
        type: 'global',
        strict: true,
      });
      if (setupResult.error) {
        throw new FatalRun(this.fromVm(ctx, setupResult.error, state, prepared, memory, live));
      }
      const setup = keep(setupResult.value);
      const hostCall = keep(
        ctx.newFunction('hostCall', (pathHandle, argsHandle) =>
          this.hostCall(ctx, state, api.functions, pathHandle, argsHandle),
        ),
      );
      const hostTick = keep(
        ctx.newFunction('hostTick', () => (state.expired() ? ctx.true : ctx.false)),
      );
      const hostAbort = keep(
        ctx.newFunction('hostAbort', (codeHandle, messageHandle) => {
          const code = ctx.typeof(codeHandle) === 'string' ? ctx.getString(codeHandle) : '';
          const message =
            ctx.typeof(messageHandle) === 'string' ? ctx.getString(messageHandle) : '';
          // The only limit the glue reports itself; any other code is a bug or tampering.
          state.stop(
            code === 'value-too-large' ? 'value-too-large' : 'internal',
            message.slice(0, 300),
          );
        }),
      );
      const glueResult = ctx.callFunction(
        setup,
        ctx.undefined,
        hostCall,
        hostTick,
        hostAbort,
        keep(ctx.newString(JSON.stringify(config))),
      );
      if (glueResult.error) {
        throw new FatalRun(this.fromVm(ctx, glueResult.error, state, prepared, memory, live));
      }
      const glue = keep(glueResult.value);

      const nsResult = ctx.evalCode(prepared.code, prepared.filename, {
        type: 'module',
        strict: true,
      });
      if (nsResult.error) return this.failure(ctx, nsResult.error, state, prepared, memory, live);
      const ns = keep(nsResult.value);

      let callResult;
      if (entry === 'read') {
        callResult = ctx.callMethod(glue, 'read', [ns]);
      } else {
        let paramsJson: string | undefined;
        try {
          paramsJson = encodeValue(params, state.handles, limits);
        } catch (e) {
          return { ok: false, error: codecFailure(e, 'bad-param') };
        }
        const paramsHandle = keep(
          paramsJson === undefined ? ctx.undefined : ctx.newString(paramsJson),
        );
        callResult = ctx.callMethod(glue, 'run', [ns, paramsHandle]);
      }
      if (callResult.error)
        return this.failure(ctx, callResult.error, state, prepared, memory, live);
      const out = keep(callResult.value);
      if (state.abort !== null) return { ok: false, error: state.abort };
      if (ctx.typeof(out) === 'undefined') return { ok: true, value: undefined };
      const json = ctx.getString(out);
      let value: ScriptValue;
      try {
        value = decodePayload(json, state.handles, limits);
      } catch (e) {
        return { ok: false, error: codecFailure(e, 'runtime') };
      }
      // Time spent in the last builtin before returning still counts.
      if (state.expired()) return { ok: false, error: state.abort! };
      return { ok: true, value };
    } catch (e) {
      // FatalRun, a trap or a host stack overflow: the runtime may be corrupt, so nothing in it
      // is touched again (not even to dispose); the instance is dropped by the caller.
      corrupt = true;
      throw e;
    } finally {
      // Promise jobs left by the run hold the context; they never run (no job is executed after
      // a run), so the instance is dropped instead of disposing under them.
      if (!corrupt && runtime.hasPendingJob()) {
        corrupt = true;
        this.pendingJobs = true;
      }
      if (!corrupt) {
        try {
          for (const h of handles) if (h.alive) h.dispose();
          ctx.dispose();
        } catch {
          // Disposing after a limit hit can assert on leaked values; the instance is dropped
          // with the next recycle check in that case.
        }
      }
    }
  }

  /** The raw host function behind every `ctx` member. */
  private hostCall(
    ctx: QuickJSContext,
    state: RunState,
    functions: Map<string, FlatHostFunction>,
    pathHandle: QuickJSHandle | undefined,
    argsHandle: QuickJSHandle | undefined,
  ): QuickJSHandle | { error: QuickJSHandle } {
    const stopped = () => ({ error: ctx.newError('The script was stopped') });
    if (state.expired()) return stopped();
    const limits = state.limits;
    if (++state.hostCalls > limits.hostCalls) {
      state.stop('call-limit', `The script made more than ${limits.hostCalls} API calls.`);
      return stopped();
    }
    const path =
      pathHandle !== undefined && ctx.typeof(pathHandle) === 'string'
        ? ctx.getString(pathHandle)
        : '';
    const spec = functions.get(path);
    if (spec === undefined || argsHandle === undefined || ctx.typeof(argsHandle) !== 'string') {
      state.stop('internal', 'The script glue made a malformed call.');
      return stopped();
    }
    if (spec.kernelOp && ++state.kernelOps > limits.kernelOps) {
      state.stop('op-limit', `The script made more than ${limits.kernelOps} modelling operations.`);
      return stopped();
    }
    let args: ScriptValue;
    try {
      args = decodePayload(ctx.getString(argsHandle), state.handles, limits, 1);
    } catch (e) {
      const error = codecFailure(e, 'runtime');
      if (LIMIT_CODES.has(error.code)) {
        state.stop(error.code, error.message);
        return stopped();
      }
      return { error: ctx.newError(`${path}: ${error.message}`) };
    }
    if (!Array.isArray(args)) {
      state.stop('internal', 'The script glue made a malformed call.');
      return stopped();
    }
    let result: ScriptValue | void;
    try {
      result = spec.fn(...args);
    } catch (e) {
      if (e instanceof ScriptHostError) return { error: ctx.newError(e.message) };
      state.stop('host-error', `${path} failed: ${e instanceof Error ? e.message : String(e)}`);
      return stopped();
    }
    // A slow kernel operation can use up the budget by itself.
    if (state.expired()) return stopped();
    let json: string | undefined;
    try {
      json = encodeValue(result, state.handles, limits);
    } catch (e) {
      state.stop(
        'host-error',
        `${path} returned a value that cannot cross to the script: ${e instanceof Error ? e.message : String(e)}`,
      );
      return stopped();
    }
    return json === undefined ? ctx.undefined : ctx.newString(json);
  }

  /** Maps an exception from the VM; fatal kinds throw FatalRun. */
  private failure(
    ctx: QuickJSContext,
    errorHandle: QuickJSHandle,
    state: RunState,
    prepared: PreparedSource,
    memory: WebAssembly.Memory,
    live: Live,
  ): { ok: false; error: ScriptError } {
    return { ok: false, error: this.fromVm(ctx, errorHandle, state, prepared, memory, live) };
  }

  private fromVm(
    ctx: QuickJSContext,
    errorHandle: QuickJSHandle,
    state: RunState,
    prepared: PreparedSource,
    memory: WebAssembly.Memory,
    live: Live,
  ): ScriptError {
    const atCap = memory.buffer.byteLength >= nearCap(live);
    const heapError = () =>
      scriptError(
        'heap-limit',
        `The script used more than the ${formatBytes(live.heapBytes)} memory limit.`,
      );
    let dumped: unknown;
    try {
      dumped = ctx.dump(errorHandle);
      errorHandle.dispose();
    } catch {
      // Reading the error needs memory too, so after an out-of-memory it may fail; a thrown
      // object whose getters loop or throw fails the same way. Either way the run is over.
      throw new FatalRun(
        state.abort ??
          (atCap
            ? heapError()
            : scriptError('runtime', 'The script threw a value that could not be read.')),
      );
    }
    if (dumped === null || dumped === undefined) {
      // QuickJS throws null when an allocation fails in some paths, and the runtime may be
      // corrupt afterwards (T7.0c): drop the instance. A script can also throw null itself.
      throw new FatalRun(
        state.abort ??
          (atCap
            ? heapError()
            : scriptError('runtime', 'The script threw null instead of an Error.')),
      );
    }
    if (typeof dumped !== 'object') {
      return state.abort ?? scriptError('runtime', `The script threw ${describeThrown(dumped)}.`);
    }
    const e = dumped as { name?: unknown; message?: unknown; stack?: unknown };
    const name = typeof e.name === 'string' ? e.name : 'Error';
    const message = typeof e.message === 'string' ? e.message : '';
    const located = locate(typeof e.stack === 'string' ? e.stack : '', prepared);
    const withPosition = (error: ScriptError): ScriptError => {
      const out: ScriptError = { ...error };
      if (located.position !== undefined && out.line === undefined) {
        out.line = located.position.line;
        out.column = located.position.column;
      }
      if (located.stack !== '') out.stack = located.stack;
      return out;
    };
    if (state.abort !== null) return withPosition(state.abort);
    if (name === 'InternalError' && message === 'out of memory') {
      throw new FatalRun(withPosition(heapError()));
    }
    if (atCap) throw new FatalRun(withPosition(heapError()));
    if (name === 'InternalError' && message === 'stack overflow') {
      return withPosition(
        scriptError(
          'stack-limit',
          `The script recursed too deeply (stack limit ${formatBytes(state.limits.stackBytes)}).`,
        ),
      );
    }
    if (name === 'InternalError' && message === 'interrupted') {
      return withPosition(
        scriptError(
          'timeout',
          `The script ran longer than the ${formatMs(state.limits.timeMs)} limit.`,
        ),
      );
    }
    if (name === 'InternalError' && message === 'string too long') {
      return withPosition(
        scriptError('heap-limit', 'The script built a string longer than the interpreter allows.'),
      );
    }
    if (name === 'SyntaxError') return withPosition(scriptError('syntax', message));
    if (name === 'ReferenceError' && message.startsWith('could not load module')) {
      return withPosition(scriptError('unsupported-syntax', 'Scripts cannot import modules.'));
    }
    return withPosition(scriptError('runtime', message === '' ? name : `${name}: ${message}`));
  }
}

/** The memory size at which the heap counts as exhausted (within 2 MiB of the maximum). */
function nearCap(live: Live): number {
  return BASE_MEMORY_BYTES + live.heapBytes - 2 * 1024 * 1024;
}

/** A host exception escaping the interpreter (stack overflow of the host, a trap, a bug). */
function hostFailure(e: unknown): ScriptError {
  const message = e instanceof Error ? e.message : String(e);
  if (
    (e instanceof RangeError && /call stack/i.test(message)) ||
    /too much recursion/i.test(message)
  ) {
    return scriptError('stack-limit', 'The script recursed too deeply for this browser.');
  }
  return scriptError('internal', `The script engine failed: ${message}`);
}

function codecFailure(e: unknown, fallback: ScriptErrorCode): ScriptError {
  if (e instanceof CodecError)
    return scriptError(e.tooLarge ? 'value-too-large' : fallback, e.message);
  return scriptError('internal', e instanceof Error ? e.message : String(e));
}

const FRAME = /(script\.(?:js|ts)):(\d+):(\d+)/g;

/** The first script position in a QuickJS backtrace, and the backtrace mapped to the source. */
function locate(
  stack: string,
  prepared: PreparedSource,
): { position?: SourcePosition; stack: string } {
  let position: SourcePosition | undefined;
  const lines: string[] = [];
  for (const line of stack.split('\n')) {
    if (line.trim() === '' || line.includes(PRELUDE_FILENAME) || line.endsWith('(native)'))
      continue;
    lines.push(
      line.replace(FRAME, (_m, file: string, l: string, c: string) => {
        const p = prepared.toSource({ line: Number(l), column: Number(c) });
        position ??= p;
        return `${file}:${p.line}:${p.column}`;
      }),
    );
  }
  const text = compactStack(lines);
  return position === undefined ? { stack: text } : { position, stack: text };
}

/** Repeated frames (deep recursion) folded, and at most 20 lines. */
function compactStack(lines: string[]): string {
  const out: string[] = [];
  for (let i = 0; i < lines.length;) {
    let j = i + 1;
    while (j < lines.length && lines[j] === lines[i]) j++;
    out.push(lines[i]!);
    if (j - i > 1) out.push(`    (repeated ${j - i - 1} more times)`);
    i = j;
  }
  return out.length > 20
    ? [...out.slice(0, 20), `    (${out.length - 20} more lines)`].join('\n')
    : out.join('\n');
}

function describeThrown(v: unknown): string {
  if (typeof v === 'string') return JSON.stringify(v.length > 200 ? `${v.slice(0, 200)}...` : v);
  return String(v);
}

function formatMs(ms: number): string {
  return ms % 1000 === 0 ? `${ms / 1000} s` : `${ms} ms`;
}

function formatBytes(bytes: number): string {
  const mib = bytes / (1024 * 1024);
  return mib >= 1 && Number.isInteger(mib) ? `${mib} MiB` : `${Math.round(bytes / 1024)} KiB`;
}
