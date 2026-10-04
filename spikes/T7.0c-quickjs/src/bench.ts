// Every measurement of the spike, written once against a small environment interface so the same
// code runs in Node (vitest) and in a browser module worker (Chromium, Firefox, WebKit through
// Playwright). Each function returns plain data; the harnesses print and store it.

import type { KernelService, ShapeId } from '@manufakture/kernel';
import type { QuickJSAsyncContext, QuickJSContext, QuickJSHandle } from 'quickjs-emscripten-core';
import { DETERMINISM_SCRIPT, type DeterminismOutput } from './determinism';
import { evalPlain, installHost, newScriptContext, toHandle, type Plain } from './sandbox';
import {
  instantiateAsync,
  instantiateSync,
  newMemory,
  type AsyncVariantName,
  type SyncVariantName,
  type VariantName,
} from './variants';

export interface BenchEnv {
  /** Milliseconds, as precise as the platform allows. */
  now(): number;
  /** Fetch (or read) and compile a variant's .wasm; a fresh compile on every call. */
  compile(name: VariantName): Promise<WebAssembly.Module>;
  /** One macrotask: what KernelService yields between ops. */
  macrotask(): Promise<void>;
  /** Evaluate source on the host engine (indirect eval). */
  hostEval(code: string): unknown;
  /** Progress lines; in the browser they reach Playwright before a possible crash. */
  log?: (line: string) => void;
  /** Also run checks known to crash a browser page (Node only). */
  unsafeChecks?: boolean;
}

const MIB = 1024 * 1024;

export function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  if (s.length === 0) return NaN;
  return s.length % 2 ? s[s.length >> 1]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
}

function round(value: number, digits = 3): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

/**
 * Dispose an asyncified runtime. In 0.32.0 freeing an async runtime that ever held a host
 * function throws "QuickJSRuntime(rt = ...) not found when trying to free HostRef" (measured:
 * plain async runtimes dispose fine, sync runtimes with host functions too). The spike drops the
 * whole instance afterwards anyway; the message is returned so the results can record it.
 */
function disposeAsync(disposable: { dispose(): void }): string | null {
  try {
    disposable.dispose();
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/** The first line of an error, for results. */
function describe(e: unknown): string {
  const text = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  return text.split('\n')[0]!;
}

function timeIt(env: BenchEnv, fn: () => void): number {
  const t0 = env.now();
  fn();
  return env.now() - t0;
}

// ------------------------------------------------------------------------------------------
// Load and first run

export interface LoadResult {
  variant: VariantName;
  compileMs: number;
  instantiateMs: number;
  /** New runtime and context, prelude, and a first small script. */
  firstRunMs: number;
  /** The same small script in a second fresh context of the same runtime. */
  secondRunMs: number;
  /** Compile plus instantiate plus first run: the cost of the first scripted feature. */
  totalMs: number;
  memoryBytes: number;
}

const SMALL_SCRIPT = `
  const params = { width: 40, holes: 6 };
  const pts = [];
  for (let i = 0; i < params.holes; i++) {
    const a = (i / params.holes) * 2 * Math.PI;
    pts.push([Math.cos(a) * params.width, Math.sin(a) * params.width]);
  }
  JSON.stringify(pts.map((p) => p.map((v) => +v.toFixed(3))));
`;

export async function measureLoad(env: BenchEnv, name: VariantName): Promise<LoadResult> {
  const t0 = env.now();
  const wasmModule = await env.compile(name);
  const t1 = env.now();
  const memory = newMemory();
  let firstRunMs: number;
  let secondRunMs: number;
  let t2: number;
  if (name === 'quickjs-sync' || name === 'ng-sync') {
    const mod = await instantiateSync(name, wasmModule, memory);
    t2 = env.now();
    const rt = mod.newRuntime();
    const run = () => {
      const ctx = newScriptContext(rt);
      const out = evalPlain(ctx, SMALL_SCRIPT);
      if (!out.ok) throw new Error(out.message);
      ctx.dispose();
    };
    firstRunMs = timeIt(env, run);
    secondRunMs = timeIt(env, run);
    rt.dispose();
  } else {
    const mod = await instantiateAsync(name, wasmModule, memory);
    t2 = env.now();
    const rt = mod.newRuntime();
    const run = () => {
      const ctx = newScriptContext(rt);
      const out = evalPlain(ctx, SMALL_SCRIPT);
      if (!out.ok) throw new Error(out.message);
      ctx.dispose();
    };
    firstRunMs = timeIt(env, run);
    secondRunMs = timeIt(env, run);
    disposeAsync(rt);
  }
  return {
    variant: name,
    compileMs: round(t1 - t0, 2),
    instantiateMs: round(t2 - t1, 2),
    firstRunMs: round(firstRunMs, 2),
    secondRunMs: round(secondRunMs, 2),
    totalMs: round(t2 - t0 + firstRunMs, 2),
    memoryBytes: memory.buffer.byteLength,
  };
}

// ------------------------------------------------------------------------------------------
// Per host call overhead, sync builds

export interface HostCallResult {
  variant: VariantName;
  calls: number;
  /** Microseconds per iteration of the bare loop (no call). */
  loopUs: number;
  /** Microseconds per call, loop subtracted: two numbers in, one out. */
  numberUs: number;
  /** A [x, y, z] array in (read with dump) and a new [x, y, z] array out. */
  vec3Us: number;
  /** The same through a JSON string each way. */
  jsonUs: number;
}

function perCall(env: BenchEnv, ctx: QuickJSContext, body: string, calls: number): number {
  const code = `(() => { let acc = 0; for (let i = 0; i < ${calls}; i++) { ${body} } return acc; })()`;
  const times: number[] = [];
  for (let r = 0; r < 5; r++) {
    times.push(
      timeIt(env, () => {
        const out = evalPlain(ctx, code);
        if (!out.ok) throw new Error(out.message);
      }),
    );
  }
  return (median(times) * 1000) / calls;
}

function installCallHost(ctx: QuickJSContext): void {
  installHost(ctx, {
    add: (a, b) => ctx.newNumber(ctx.getNumber(a!) + ctx.getNumber(b!)),
    vec: (v) => {
      const [x, y, z] = ctx.dump(v!) as [number, number, number];
      return toHandle(ctx, [x + 1, y + 1, z + 1]);
    },
    json: (s) => {
      const [x, y, z] = JSON.parse(ctx.getString(s!)) as [number, number, number];
      return ctx.newString(JSON.stringify([x + 1, y + 1, z + 1]));
    },
  });
}

export async function measureHostCalls(
  env: BenchEnv,
  name: SyncVariantName,
  calls = 100_000,
): Promise<HostCallResult> {
  const mod = await instantiateSync(name, await env.compile(name));
  const rt = mod.newRuntime();
  const ctx = newScriptContext(rt);
  installCallHost(ctx);
  const loop = perCall(env, ctx, 'acc += i;', calls);
  const number = perCall(env, ctx, 'acc += host.add(i, 1);', calls) - loop;
  const vec3 = perCall(env, ctx, 'acc += host.vec([i, 2, 3])[0];', calls / 4) - loop;
  const json =
    perCall(env, ctx, 'acc += JSON.parse(host.json(JSON.stringify([i, 2, 3])))[0];', calls / 4) -
    loop;
  ctx.dispose();
  rt.dispose();
  return {
    variant: name,
    calls,
    loopUs: round(loop),
    numberUs: round(number),
    vec3Us: round(vec3),
    jsonUs: round(json),
  };
}

// ------------------------------------------------------------------------------------------
// Per host call overhead, asyncified builds

export interface AsyncCallResult {
  variant: AsyncVariantName;
  loopUs: number;
  /** A plain synchronous host function, in the asyncified build. */
  syncNumberUs: number;
  /** An asyncified host function whose promise is already resolved. */
  asyncResolvedUs: number;
  /** An asyncified host function that waits one macrotask (what a KernelService batch does). */
  asyncMacrotaskUs: number;
  /** What disposing the runtime threw (see disposeAsync). */
  disposeError: string | null;
}

async function perCallAsync(
  env: BenchEnv,
  ctx: QuickJSAsyncContext,
  body: string,
  calls: number,
  runs = 5,
): Promise<number> {
  const code = `(() => { let acc = 0; for (let i = 0; i < ${calls}; i++) { ${body} } return acc; })()`;
  const times: number[] = [];
  for (let r = 0; r < runs; r++) {
    const t0 = env.now();
    const result = await ctx.evalCodeAsync(code);
    times.push(env.now() - t0);
    ctx.unwrapResult(result).dispose();
  }
  return (median(times) * 1000) / calls;
}

export async function measureAsyncCalls(
  env: BenchEnv,
  name: AsyncVariantName,
): Promise<AsyncCallResult> {
  const mod = await instantiateAsync(name, await env.compile(name));
  const rt = mod.newRuntime();
  const ctx = rt.newContext();
  const host = ctx.newObject();
  const add = ctx.newFunction('add', (a, b) =>
    ctx.newNumber(ctx.getNumber(a!) + ctx.getNumber(b!)),
  );
  const addResolved = ctx.newAsyncifiedFunction('addResolved', async (a, b) =>
    ctx.newNumber(ctx.getNumber(a!) + ctx.getNumber(b!)),
  );
  const addLater = ctx.newAsyncifiedFunction('addLater', async (a, b) => {
    const sum = ctx.getNumber(a!) + ctx.getNumber(b!);
    await env.macrotask();
    return ctx.newNumber(sum);
  });
  for (const [n, f] of [
    ['add', add],
    ['addResolved', addResolved],
    ['addLater', addLater],
  ] as const) {
    ctx.setProp(host, n, f);
    f.dispose();
  }
  ctx.setProp(ctx.global, 'host', host);
  host.dispose();
  const calls = 100_000;
  const loop = await perCallAsync(env, ctx, 'acc += i;', calls);
  const syncNumber = (await perCallAsync(env, ctx, 'acc += host.add(i, 1);', calls)) - loop;
  const resolved = (await perCallAsync(env, ctx, 'acc += host.addResolved(i, 1);', 20_000)) - loop;
  const later = (await perCallAsync(env, ctx, 'acc += host.addLater(i, 1);', 2_000, 3)) - loop;
  ctx.dispose();
  const disposeError = disposeAsync(rt);
  return {
    variant: name,
    disposeError,
    loopUs: round(loop),
    syncNumberUs: round(syncNumber),
    asyncResolvedUs: round(resolved),
    asyncMacrotaskUs: round(later),
  };
}

// ------------------------------------------------------------------------------------------
// A script driving the kernel: synchronous session against asyncified build plus KernelService

export interface KernelSessionResult {
  workload: string;
  hostCalls: number;
  /** Plain JS calling the synchronous Kernel directly: the floor. */
  directSyncMs: number;
  /** Plain JS awaiting one KernelService.run batch per operation. */
  directServiceMs: number;
  /** QuickJS (sync build) calling the synchronous Kernel from host functions. */
  scriptSyncMs: number;
  /** QuickJS (asyncified build) awaiting one KernelService.run batch per host call. */
  scriptAsyncMs: number;
  /** Distinct results over every run of every path: one value means all paths agree. */
  results: number[];
}

interface Workload {
  name: string;
  hostCalls: number;
  script: string;
  direct(ops: KernelOps): Promise<number>;
}

const HOLES = 24;
const QUERIES = 300;

const WORKLOADS: Workload[] = [
  {
    // Heavy operations: a plate with a grid of holes, cut one boolean at a time.
    name: `${HOLES} boolean cuts`,
    hostCalls: 2 + HOLES * 4,
    script: `(() => {
      let plate = host.box(120, 80, 6);
      for (let i = 0; i < ${HOLES}; i++) {
        const x = 10 + (i % 8) * 14, y = 12 + Math.floor(i / 8) * 18;
        const tool = host.cylinder(2.5, 10, x, y, -2);
        const next = host.cut(plate, tool);
        host.release(plate);
        host.release(tool);
        plate = next;
      }
      const v = host.volume(plate);
      host.release(plate);
      return v;
    })()`,
    async direct(ops) {
      let plate = await ops.box(120, 80, 6);
      for (let i = 0; i < HOLES; i++) {
        const x = 10 + (i % 8) * 14;
        const y = 12 + Math.floor(i / 8) * 18;
        const tool = await ops.cylinder(2.5, 10, x, y, -2);
        const next = await ops.cut(plate, tool);
        await ops.release(plate);
        await ops.release(tool);
        plate = next;
      }
      const v = await ops.volume(plate);
      await ops.release(plate);
      return v;
    },
  },
  {
    // Cheap calls: many small queries of one shape, where the per-call cost shows.
    name: `${QUERIES} volume queries`,
    hostCalls: 2 + QUERIES,
    script: `(() => {
      const b = host.box(10, 20, 30);
      let sum = 0;
      for (let i = 0; i < ${QUERIES}; i++) sum += host.volume(b);
      host.release(b);
      return sum;
    })()`,
    async direct(ops) {
      const b = await ops.box(10, 20, 30);
      let sum = 0;
      for (let i = 0; i < QUERIES; i++) sum += await ops.volume(b);
      await ops.release(b);
      return sum;
    },
  },
];

interface KernelOps {
  box(dx: number, dy: number, dz: number): number | Promise<number>;
  cylinder(r: number, h: number, x: number, y: number, z: number): number | Promise<number>;
  cut(a: number, b: number): number | Promise<number>;
  volume(id: number): number | Promise<number>;
  release(id: number): number | Promise<number>;
}

/** Shape ids cross the script boundary as plain numbers. */
const id = (n: number) => n as ShapeId;

function syncOps(service: KernelService): KernelOps {
  const k = () => service.kernel;
  return {
    box: (dx, dy, dz) => k().box(dx, dy, dz),
    cylinder: (r, h, x, y, z) => k().cylinder(r, h, [x, y, z]),
    cut: (a, b) => k().boolean('cut', id(a), [id(b)], { history: false }).shape,
    volume: (n) => k().properties(id(n)).volume,
    release: (n) => (k().release(id(n)) ? 1 : 0),
  };
}

function serviceOps(service: KernelService): KernelOps {
  const generation = 1; // one generation for the whole run: nothing supersedes it
  const one = async (op: Parameters<KernelService['run']>[0]['ops'][number]) => {
    const reply = await service.run({ generation, ops: [op] });
    const result = reply.results[0]!;
    if (!result.ok) throw new Error(result.error.message);
    return result.value as unknown;
  };
  return {
    box: async (dx, dy, dz) =>
      ((await one({ op: 'box', size: [dx, dy, dz] })) as { shape: number }).shape,
    cylinder: async (r, h, x, y, z) =>
      ((await one({ op: 'cylinder', radius: r, height: h, at: [x, y, z] })) as { shape: number })
        .shape,
    cut: async (a, b) =>
      (
        (await one({
          op: 'boolean',
          kind: 'cut',
          shape: id(a),
          tools: [id(b)],
          history: false,
        })) as { shape: number }
      ).shape,
    volume: async (n) =>
      ((await one({ op: 'properties', shape: id(n) })) as { volume: number }).volume,
    release: async (n) => {
      await one({ op: 'release', shapes: [id(n)] });
      return 1;
    },
  };
}

function numbers(ctx: QuickJSContext, args: QuickJSHandle[]): number[] {
  return args.map((a) => ctx.getNumber(a));
}

export async function measureKernelSession(
  env: BenchEnv,
  service: KernelService,
  runs = 5,
): Promise<KernelSessionResult[]> {
  const sync = syncOps(service);
  const viaService = serviceOps(service);
  const syncMod = await instantiateSync('quickjs-sync', await env.compile('quickjs-sync'));
  const syncRt = syncMod.newRuntime();
  const asyncMod = await instantiateAsync(
    'quickjs-asyncify',
    await env.compile('quickjs-asyncify'),
  );
  const asyncRt = asyncMod.newRuntime();
  const out: KernelSessionResult[] = [];
  for (const w of WORKLOADS) {
    const results: number[] = [];
    const time = async (fn: () => Promise<number>) => {
      const times: number[] = [];
      for (let r = 0; r < runs + 1; r++) {
        const t0 = env.now();
        results.push(await fn());
        if (r > 0) times.push(env.now() - t0); // the first run warms up
      }
      return round(median(times), 2);
    };
    const directSyncMs = await time(() => w.direct(sync));
    const directServiceMs = await time(() => w.direct(viaService));
    const scriptSyncMs = await time(async () => {
      const ctx = newScriptContext(syncRt);
      const fns = Object.fromEntries(
        (Object.keys(sync) as (keyof KernelOps)[]).map((n) => [
          n,
          (...args: QuickJSHandle[]) =>
            ctx.newNumber((sync[n] as (...a: number[]) => number)(...numbers(ctx, args))),
        ]),
      );
      installHost(ctx, fns);
      const r = evalPlain(ctx, w.script);
      ctx.dispose();
      if (!r.ok) throw new Error(r.message);
      return r.value as number;
    });
    const scriptAsyncMs = await time(async () => {
      const ctx = asyncRt.newContext();
      const host = ctx.newObject();
      for (const n of Object.keys(viaService) as (keyof KernelOps)[]) {
        const f = ctx.newAsyncifiedFunction(n, async (...args: QuickJSHandle[]) =>
          ctx.newNumber(
            await (viaService[n] as (...a: number[]) => Promise<number>)(...numbers(ctx, args)),
          ),
        );
        ctx.setProp(host, n, f);
        f.dispose();
      }
      ctx.setProp(ctx.global, 'host', host);
      host.dispose();
      const result = await ctx.evalCodeAsync(w.script);
      const h = ctx.unwrapResult(result);
      const v = ctx.getNumber(h);
      h.dispose();
      ctx.dispose();
      return v;
    });
    out.push({
      workload: w.name,
      hostCalls: w.hostCalls,
      directSyncMs,
      directServiceMs,
      scriptSyncMs,
      scriptAsyncMs,
      results: [...new Set(results.map((v) => round(v, 6)))],
    });
  }
  syncRt.dispose();
  disposeAsync(asyncRt);
  return out;
}

// ------------------------------------------------------------------------------------------
// Interrupt handler latency

export interface InterruptCase {
  case: string;
  /** Milliseconds from the deadline to evalCode returning. */
  overshootMs: number;
  /** Handler calls per millisecond of run time. */
  callsPerMs: number;
  error: string;
}

const INTERRUPT_CASES: Record<string, string> = {
  'empty for(;;)': 'for (;;) {}',
  'arithmetic loop': 'let x = 1; while (true) { x = x * 1.0000001 + Math.sin(x); }',
  'recursion in a loop': 'function f(n) { return n ? f(n - 1) + 1 : 0; } for (;;) f(500);',
  'string building': "let s = ''; for (;;) { s += 'x'; if (s.length > 1e5) s = ''; }",
  'regex backtracking': "/^(a+)+$/.test('a'.repeat(40) + '!')",
  'sort 1e5 numbers, comparator, in a loop':
    'const a = []; for (let i = 0; i < 1e5; i++) a.push((i * 7919) % 1e5); for (;;) a.slice().sort((p, q) => p - q);',
  // One builtin call of a few ms per iteration: the loop polls the handler only every
  // thousand or so iterations (the poll counter counts bytecode branches, not time).
  'sort 2e4 numbers, default order, in a loop':
    'const a = []; for (let i = 0; i < 2e4; i++) a.push((i * 7919) % 2e4); for (;;) a.slice().sort();',
  'JSON round trip of 500 objects, in a loop':
    'const o = []; for (let i = 0; i < 500; i++) o.push({ i, v: [i, i / 3] }); for (;;) JSON.parse(JSON.stringify(o));',
};

export async function measureInterrupts(
  env: BenchEnv,
  name: SyncVariantName,
  budgetMs = 100,
  only?: readonly string[],
): Promise<InterruptCase[]> {
  const mod = await instantiateSync(name, await env.compile(name));
  const out: InterruptCase[] = [];
  for (const [label, code] of Object.entries(INTERRUPT_CASES)) {
    if (only !== undefined && !only.includes(label)) continue;
    const rt = mod.newRuntime();
    rt.setMemoryLimit(256 * MIB);
    const ctx = newScriptContext(rt);
    let calls = 0;
    const start = env.now();
    const deadline = start + budgetMs;
    rt.setInterruptHandler(() => {
      calls++;
      return env.now() > deadline;
    });
    const result = evalPlain(ctx, code);
    const end = env.now();
    out.push({
      case: label,
      overshootMs: round(end - deadline, 2),
      callsPerMs: round(calls / (end - start), 2),
      error: result.ok ? 'finished' : `${result.name}: ${result.message}`,
    });
    ctx.dispose();
    rt.dispose();
  }
  return out;
}

// ------------------------------------------------------------------------------------------
// Memory and stack limits

export interface MemoryCase {
  case: string;
  /**
   * `setMemoryLimit`: QuickJS's own limit. `memory-maximum`: a `WebAssembly.Memory` whose maximum
   * is the 16 MiB the .wasm needs plus the limit, so malloc itself fails there.
   */
  mode: 'setMemoryLimit' | 'memory-maximum';
  limitMiB: number;
  error: string;
  ms: number;
  /** The instance's linear memory after the case. */
  wasmMiB: number;
  /** A new context in the same runtime evaluates `1 + 1` afterwards (null: not checked). */
  runtimeUsable: boolean | null;
  /** A new runtime in the same instance evaluates `1 + 1` afterwards. */
  instanceUsable: boolean;
}

const MEMORY_CASES: Record<string, string> = {
  'arrays of doubles': 'const a = []; for (;;) a.push(new Array(1e5).fill(1.5));',
  'one Float64Array of 1.6 GB': 'new Float64Array(2e8).length',
  'string doubling': "let s = 'x'; for (;;) s = s + s;",
  'objects in a Map': 'const m = new Map(); for (let i = 0; ; i++) m.set(i, { i, s: String(i) });',
};

function usable(make: () => QuickJSContext): boolean {
  try {
    const ctx = make();
    const r = evalPlain(ctx, '[1 + 1, Array.from({ length: 1000 }, (_, i) => i).length]');
    ctx.dispose();
    return r.ok && JSON.stringify(r.value) === '[2,1000]';
  } catch {
    return false;
  }
}

export async function measureMemoryLimits(
  env: BenchEnv,
  name: SyncVariantName,
  mode: MemoryCase['mode'],
  limitMiB = 64,
  onCase?: (c: MemoryCase) => void,
): Promise<MemoryCase[]> {
  const wasmModule = await env.compile(name);
  const out: MemoryCase[] = [];
  for (const [label, code] of Object.entries(MEMORY_CASES)) {
    // A fresh instance per case, so wasmMiB is that case's own high-water mark.
    const memory =
      mode === 'setMemoryLimit'
        ? newMemory()
        : new WebAssembly.Memory({ initial: 256, maximum: 256 + limitMiB * 16 });
    const mod = await instantiateSync(name, wasmModule, memory);
    const rt = mod.newRuntime();
    if (mode === 'setMemoryLimit') rt.setMemoryLimit(limitMiB * MIB);
    const deadline = env.now() + 10_000;
    rt.setInterruptHandler(() => env.now() > deadline);
    const ctx = newScriptContext(rt);
    env.log?.(`memory ${mode}: ${label}`);
    const t0 = env.now();
    const result = evalPlain(ctx, code);
    const ms = env.now() - t0;
    ctx.dispose();
    // An out-of-memory that throws a non-Error (null) leaves the runtime's heap corrupt: in Node
    // its next context traps with "memory access out of bounds", and in Chromium touching it
    // crashed the whole page. Such a runtime is not touched again (null = not checked).
    const corrupt = !result.ok && result.name === 'thrown';
    const runtimeUsable =
      corrupt && env.unsafeChecks !== true ? null : usable(() => newScriptContext(rt));
    const instanceUsable = usable(() => newScriptContext(mod.newRuntime()));
    out.push({
      case: label,
      mode,
      limitMiB,
      error: result.ok
        ? `finished: ${JSON.stringify(result.value)}`
        : `${result.name}: ${result.message}`,
      ms: round(ms, 1),
      wasmMiB: round(memory.buffer.byteLength / MIB, 1),
      runtimeUsable,
      instanceUsable,
    });
    onCase?.(out[out.length - 1]!);
    if (!corrupt) rt.dispose(); // a corrupt runtime is dropped with its instance
  }
  return out;
}

/** QuickJS's own memory report: it says whether malloc_usable_size is available. */
export async function memoryReport(env: BenchEnv, name: SyncVariantName): Promise<string> {
  const mod = await instantiateSync(name, await env.compile(name));
  const rt = mod.newRuntime();
  const text = rt
    .dumpMemoryUsage()
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .slice(0, 2)
    .join(' / ');
  rt.dispose();
  return text;
}

export interface StackCase {
  maxStackKiB: number;
  depth: number;
  error: string;
  /** The instance still evaluates `1 + 1` in a fresh runtime afterwards. */
  instanceUsable: boolean;
}

export async function measureStackLimits(
  env: BenchEnv,
  name: SyncVariantName,
  sizesKiB: number[] = [64, 128, 192, 256, 384, 512, 1024, 0],
): Promise<StackCase[]> {
  const wasmModule = await env.compile(name);
  const out: StackCase[] = [];
  for (const kib of sizesKiB) {
    const mod = await instantiateSync(name, wasmModule);
    const rt = mod.newRuntime();
    rt.setMemoryLimit(256 * MIB);
    const ctx = newScriptContext(rt);
    rt.setMaxStackSize(kib * 1024);
    let depth = -1;
    let error: string;
    try {
      const r = evalPlain(
        ctx,
        `let d = 0; function f(a, b, c) { d++; return f(a + 1, b, c) + 1; }
         let msg = 'none'; try { f(0, 1, 2); } catch (e) { msg = e.name + ': ' + e.message; } [d, msg]`,
      );
      if (r.ok) {
        const [d, m] = r.value as [number, string];
        depth = d;
        error = m;
      } else error = `${r.name}: ${r.message}`;
      ctx.dispose();
      rt.dispose();
    } catch (e) {
      error = `host exception: ${describe(e)}`;
    }
    const instanceUsable = usable(() => newScriptContext(mod.newRuntime()));
    out.push({ maxStackKiB: kib, depth, error, instanceUsable });
  }
  return out;
}

// ------------------------------------------------------------------------------------------
// Values crossing the binding

export interface ValueSizeCase {
  case: string;
  ms: number;
}

export async function measureValueSizes(
  env: BenchEnv,
  name: SyncVariantName,
): Promise<ValueSizeCase[]> {
  const mod = await instantiateSync(name, await env.compile(name));
  const rt = mod.newRuntime();
  rt.setMemoryLimit(512 * MIB);
  const ctx = newScriptContext(rt);
  const out: ValueSizeCase[] = [];
  const t = (label: string, fn: () => void) =>
    out.push({ case: label, ms: round(timeIt(env, fn), 2) });
  for (const mib of [1, 16]) {
    t(`string ${mib} MiB, script to host (getString)`, () => {
      const h = ctx.unwrapResult(ctx.evalCode(`'x'.repeat(${mib * MIB})`));
      if (ctx.getString(h).length !== mib * MIB) throw new Error('length');
      h.dispose();
    });
    const big = 'y'.repeat(mib * MIB);
    t(`string ${mib} MiB, host to script (newString)`, () => ctx.newString(big).dispose());
  }
  for (const n of [1e4, 1e5]) {
    t(`array of ${n} numbers, script to host (dump)`, () => {
      const h = ctx.unwrapResult(ctx.evalCode(`Array.from({ length: ${n} }, (_, i) => i / 3)`));
      if ((ctx.dump(h) as number[]).length !== n) throw new Error('length');
      h.dispose();
    });
    const arr = Array.from({ length: n }, (_, i) => i / 3);
    t(`array of ${n} numbers, host to script (newArray + setProp)`, () =>
      toHandle(ctx, arr).dispose(),
    );
    t(`array of ${n} numbers, host to script (JSON string, parsed in script)`, () => {
      const s = ctx.newString(JSON.stringify(arr));
      ctx.setProp(ctx.global, 'payload', s);
      s.dispose();
      ctx.unwrapResult(ctx.evalCode('JSON.parse(payload).length')).dispose();
    });
  }
  ctx.dispose();
  rt.dispose();
  return out;
}

// ------------------------------------------------------------------------------------------
// One more module instance from an already compiled module (ADR 0010 decision 4)

export interface InstanceResult {
  variant: VariantName;
  instances: number;
  /** Median milliseconds to instantiate, make a runtime and a context, and run a small script. */
  perInstanceMs: number;
  firstInstanceMs: number;
  /** Linear memory per instance after that: the 16 MiB minimum the .wasm declares. */
  memoryMiBPerInstance: number;
}

export async function measureInstances(
  env: BenchEnv,
  name: SyncVariantName | AsyncVariantName,
  count = 10,
): Promise<InstanceResult> {
  const wasmModule = await env.compile(name);
  const times: number[] = [];
  const memories: WebAssembly.Memory[] = [];
  const keep: { dispose(): void }[] = [];
  for (let i = 0; i < count; i++) {
    const memory = newMemory();
    const t0 = env.now();
    const mod =
      name === 'quickjs-sync' || name === 'ng-sync'
        ? await instantiateSync(name, wasmModule, memory)
        : await instantiateAsync(name, wasmModule, memory);
    const rt = mod.newRuntime();
    const ctx = newScriptContext(rt);
    const r = evalPlain(ctx, SMALL_SCRIPT);
    if (!r.ok) throw new Error(r.message);
    ctx.dispose();
    times.push(env.now() - t0);
    memories.push(memory);
    keep.push(rt); // keep every instance alive, as open documents would
  }
  const memoryMiB = median(memories.map((m) => m.buffer.byteLength / MIB));
  for (const rt of keep) disposeAsync(rt);
  return {
    variant: name,
    instances: count,
    perInstanceMs: round(median(times.slice(1)), 2),
    firstInstanceMs: round(times[0]!, 2),
    memoryMiBPerInstance: memoryMiB,
  };
}

// ------------------------------------------------------------------------------------------
// The Asyncify exception: two runtimes in one asyncified module

export interface AsyncifyIsolationResult {
  /** Two contexts of one module each awaiting an async host call at the same time. */
  sharedModule: string;
  /** The same with each context in its own module instance. */
  separateModules: string;
  /** An asyncified host function that re-enters the context and calls another one. */
  nestedSuspend: string;
}

export async function measureAsyncifyIsolation(
  env: BenchEnv,
  name: AsyncVariantName,
): Promise<AsyncifyIsolationResult> {
  const wasmModule = await env.compile(name);
  const makeCtx = (rt: { newContext(): QuickJSAsyncContext }) => {
    const ctx = rt.newContext();
    const f = ctx.newAsyncifiedFunction('wait', async (n) => {
      const v = ctx.getNumber(n!);
      await env.macrotask();
      await env.macrotask();
      return ctx.newNumber(v * 2);
    });
    ctx.setProp(ctx.global, 'wait', f);
    f.dispose();
    return ctx;
  };
  const both = async (a: QuickJSAsyncContext, b: QuickJSAsyncContext): Promise<string> => {
    try {
      const [ra, rb] = await Promise.all([
        a.evalCodeAsync('let s = 0; for (let i = 0; i < 5; i++) s += wait(i); s'),
        b.evalCodeAsync('let t = 0; for (let i = 0; i < 5; i++) t += wait(i * 10); t'),
      ]);
      const fmt = (ctx: QuickJSAsyncContext, r: typeof ra) => {
        if (r.error) {
          const e = ctx.dump(r.error) as { name?: string; message?: string };
          r.error.dispose();
          return `error ${e.name}: ${String(e.message).split('\n')[0]}`;
        }
        const v = ctx.dump(r.value);
        r.value.dispose();
        return String(v);
      };
      return `a = ${fmt(a, ra)}, b = ${fmt(b, rb)} (expected 20 and 200)`;
    } catch (e) {
      return `host exception: ${describe(e)}`;
    }
  };

  const shared = await instantiateAsync(name, wasmModule);
  const r1 = shared.newRuntime();
  const r2 = shared.newRuntime();
  const sharedModule = await both(makeCtx(r1), makeCtx(r2));

  const m1 = await instantiateAsync(name, wasmModule);
  const m2 = await instantiateAsync(name, wasmModule);
  const separateModules = await both(makeCtx(m1.newRuntime()), makeCtx(m2.newRuntime()));

  let nestedSuspend: string;
  try {
    const m3 = await instantiateAsync(name, wasmModule);
    const ctx = makeCtx(m3.newRuntime());
    const outer = ctx.newAsyncifiedFunction('outer', async () => {
      await env.macrotask();
      // Re-enter the suspended module and suspend again: what the README says crashes.
      const inner = await ctx.evalCodeAsync('wait(21)');
      return ctx.unwrapResult(inner);
    });
    ctx.setProp(ctx.global, 'outer', outer);
    outer.dispose();
    const r = await ctx.evalCodeAsync('outer()');
    if (r.error) {
      const e = ctx.dump(r.error) as { name?: string; message?: string };
      nestedSuspend = `error ${e.name}: ${String(e.message).split('\n')[0]}`;
    } else nestedSuspend = `value ${String(ctx.dump(r.value))}`;
  } catch (e) {
    nestedSuspend = `host exception: ${describe(e)}`;
  }
  return { sharedModule, separateModules, nestedSuspend };
}

// ------------------------------------------------------------------------------------------
// The arithmetic loop against the host JIT

export interface ArithmeticResult {
  variant: SyncVariantName;
  iterations: number;
  quickjsMs: number;
  hostMs: number;
  ratio: number;
  sameResult: boolean;
}

const ARITHMETIC = (n: number) => `(() => {
  let s = 0;
  for (let i = 0; i < ${n}; i++) s += (i * 1.5 + 3) / ((i % 7) + 1) - Math.sqrt(i);
  return s;
})()`;

export async function measureArithmetic(
  env: BenchEnv,
  name: SyncVariantName,
  iterations: number,
  runs = 15,
): Promise<ArithmeticResult> {
  const mod = await instantiateSync(name, await env.compile(name));
  const rt = mod.newRuntime();
  const ctx = newScriptContext(rt);
  const code = ARITHMETIC(iterations);
  let q = NaN;
  let h = NaN;
  const qt: number[] = [];
  const ht: number[] = [];
  // Short runs are repeated inside one timing so that a 1 ms timer (WebKit) still resolves them.
  const batch = Math.max(1, Math.round(200_000 / iterations));
  for (let r = 0; r < runs; r++) {
    qt.push(
      timeIt(env, () => {
        for (let b = 0; b < batch; b++) {
          const out = evalPlain(ctx, code);
          q = out.ok ? (out.value as number) : NaN;
        }
      }) / batch,
    );
    ht.push(
      timeIt(env, () => {
        for (let b = 0; b < batch; b++) h = env.hostEval(code) as number;
      }) / batch,
    );
  }
  ctx.dispose();
  rt.dispose();
  const quickjsMs = median(qt);
  const hostMs = median(ht);
  return {
    variant: name,
    iterations,
    quickjsMs: round(quickjsMs, 3),
    hostMs: round(hostMs, 3),
    ratio: round(quickjsMs / Math.max(hostMs, 1e-3), 1),
    sameResult: Object.is(q, h),
  };
}

// ------------------------------------------------------------------------------------------
// Determinism outputs

export async function determinismOutputs(
  env: BenchEnv,
): Promise<Record<string, DeterminismOutput>> {
  const out: Record<string, DeterminismOutput> = {};
  for (const name of ['quickjs-sync', 'ng-sync'] as const) {
    const mod = await instantiateSync(name, await env.compile(name));
    const rt = mod.newRuntime();
    const ctx = newScriptContext(rt);
    const r = evalPlain(ctx, DETERMINISM_SCRIPT);
    if (!r.ok) throw new Error(`${name}: ${r.message}`);
    out[name] = JSON.parse(r.value as string) as DeterminismOutput;
    ctx.dispose();
    rt.dispose();
  }
  out.host = JSON.parse(env.hostEval(DETERMINISM_SCRIPT) as string) as DeterminismOutput;
  return out;
}

/** What the script sees as its global surface (names of own global properties). */
export async function globalSurface(env: BenchEnv, name: SyncVariantName): Promise<Plain> {
  const mod = await instantiateSync(name, await env.compile(name));
  const rt = mod.newRuntime();
  const ctx = newScriptContext(rt, 7);
  const r = evalPlain(
    ctx,
    `JSON.stringify({ globals: Object.getOwnPropertyNames(globalThis).sort(),
       date: typeof Date, random: [Math.random(), Math.random()] })`,
  );
  ctx.dispose();
  rt.dispose();
  if (!r.ok) throw new Error(r.message);
  return JSON.parse(r.value as string) as Plain;
}
