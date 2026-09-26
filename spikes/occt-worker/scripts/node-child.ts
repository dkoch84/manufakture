// One measurement in a fresh Node process. Invoked by measure.ts as
//   node scripts/node-child.ts <task> '<json args>'
// and prints its result as JSON on the last stdout line.

import { readFileSync } from 'node:fs';
import { CASES, type CaseName } from '../src/cases.ts';
import {
  heapBytes,
  runPipeline,
  type MemoryMode,
  type MeshData,
  type Oc,
} from '../src/pipeline.ts';
import type { Variant } from '../src/protocol.ts';
import { track } from '../src/track.ts';
import { LIBCASCADE_DIST, round, summarize } from './lib.ts';

type Args = Record<string, unknown>;
type Instantiate = (
  imports: WebAssembly.Imports,
  receive: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void,
) => object;

interface RawModule {
  wasmMemory: WebAssembly.Memory;
  _emscripten_builtin_malloc(size: number): number;
  _emscripten_builtin_free(ptr: number): void;
}

async function factory(variant: Variant) {
  return variant === 'multi'
    ? (await import('libcascade/multi/init')).createInstance
    : (await import('libcascade/single/init')).createInstance;
}

/** Create an instance, optionally from an already compiled module. */
async function create(variant: Variant, module?: WebAssembly.Module): Promise<Oc> {
  const createInstance = await factory(variant);
  if (!module) return createInstance();
  const instantiateWasm: Instantiate = (imports, receive) => {
    void WebAssembly.instantiate(module, imports).then((instance) => receive(instance, module));
    return {};
  };
  return createInstance({ instantiateWasm } as never);
}

/**
 * Bytes in use by the allocator: the heap size minus what can still be
 * allocated in 64 KiB blocks before the memory must grow. Probing disturbs the
 * allocator, so call it once, at the end of a process.
 */
function usedHeapBytes(oc: Oc): number {
  const raw = oc as unknown as RawModule;
  const block = 64 * 1024;
  const start = raw.wasmMemory.buffer.byteLength;
  const blocks: number[] = [];
  for (;;) {
    const ptr = raw._emscripten_builtin_malloc(block);
    if (ptr === 0 || raw.wasmMemory.buffer.byteLength !== start) {
      if (ptr !== 0) raw._emscripten_builtin_free(ptr);
      break;
    }
    blocks.push(ptr);
  }
  for (const ptr of blocks) raw._emscripten_builtin_free(ptr);
  return start - blocks.length * block;
}

const tasks: Record<string, (args: Args) => Promise<unknown>> = {
  /** Cold start: read, compile, instantiate, runtime init, each timed. */
  async init({ variant }) {
    const v = variant as Variant;
    const createInstance = await factory(v);
    const marks: Record<string, number> = {};
    const t0 = performance.now();
    const instantiateWasm: Instantiate = (imports, receive) => {
      marks.hook = performance.now();
      void (async () => {
        const bytes = readFileSync(`${LIBCASCADE_DIST}opencascade_${v}.wasm`);
        marks.read = performance.now();
        const module = await WebAssembly.compile(bytes);
        marks.compiled = performance.now();
        const instance = await WebAssembly.instantiate(module, imports);
        marks.instantiated = performance.now();
        receive(instance, module);
      })();
      return {};
    };
    const oc = await createInstance({ instantiateWasm } as never);
    const t1 = performance.now();
    return {
      variant: v,
      glueMs: round(marks.hook! - t0),
      readMs: round(marks.read! - marks.hook!),
      compileMs: round(marks.compiled! - marks.read!),
      instantiateMs: round(marks.instantiated! - marks.compiled!),
      runtimeInitMs: round(t1 - marks.instantiated!),
      totalMs: round(t1 - t0),
      heapBytesAfterInit: heapBytes(oc),
    };
  },

  /** Pipeline timings per case; the first run is reported separately. */
  async bench({ variant, runs }) {
    const v = variant as Variant;
    const oc = await create(v);
    const out: unknown[] = [];
    for (const parallel of v === 'multi' ? [false, true] : [false]) {
      for (const name of Object.keys(CASES) as CaseName[]) {
        const options = { ...CASES[name], parallel };
        const first = runPipeline(oc, options);
        const heapAfterFirstRun = heapBytes(oc);
        const all: MeshData[] = [];
        for (let i = 0; i < (runs as number); i++) all.push(runPipeline(oc, options));
        const phase = (k: keyof (typeof first)['timings']) =>
          summarize(all.map((r) => r.timings[k]));
        out.push({
          case: name,
          parallel,
          stats: first.stats,
          heapAfterFirstRun,
          firstRun: Object.fromEntries(
            Object.entries(first.timings).map(([k, x]) => [k, round(x)]),
          ),
          buildMs: phase('buildMs'),
          filletMs: phase('filletMs'),
          meshMs: phase('meshMs'),
          extractMs: phase('extractMs'),
          totalMs: phase('totalMs'),
        });
      }
    }
    return { variant: v, runs, results: out, heapBytesAfter: heapBytes(oc) };
  },

  /** Run N times, then probe the bytes in use once. */
  async leakprobe({ variant, caseName, memory, n }) {
    const oc = await create(variant as Variant);
    for (let i = 0; i < (n as number); i++) {
      runPipeline(oc, {
        ...CASES[caseName as CaseName],
        parallel: false,
        memory: memory as MemoryMode,
      });
    }
    return { heapBytes: heapBytes(oc), usedBytes: usedHeapBytes(oc) };
  },

  /** Heap size after every run. */
  async trace({ variant, caseName, memory, runs }) {
    const oc = await create(variant as Variant);
    const before = heapBytes(oc);
    const after: number[] = [];
    const t0 = performance.now();
    for (let i = 0; i < (runs as number); i++) {
      runPipeline(oc, {
        ...CASES[caseName as CaseName],
        parallel: false,
        memory: memory as MemoryMode,
      });
      after.push(heapBytes(oc));
    }
    return { before, after, ms: round(performance.now() - t0) };
  },

  /** Count embind handles created per run and how many are still alive after it. */
  async tracker({ variant }) {
    const t = track(await create(variant as Variant));
    const rows: unknown[] = [];
    for (const memory of ['strict', 'mitigated', 'none'] as MemoryMode[]) {
      for (const name of Object.keys(CASES) as CaseName[]) {
        t.reset();
        runPipeline(t.oc, { ...CASES[name], parallel: false, memory });
        rows.push({ case: name, memory, created: t.created(), live: t.live() });
      }
    }
    // Error paths: an impossible fillet radius (IsDone() false, JS throws), and
    // a zero mesh deflection (OCCT throws a C++ exception from the mesher).
    const failing: Array<[string, Partial<typeof CASES.box>]> = [
      ['box, fillet radius 50 (fails)', { filletRadius: 50 }],
      ['box, mesh deflection 0 (OCCT throws)', { linearDeflection: 0 }],
    ];
    for (const [label, change] of failing) {
      t.reset();
      let error = '';
      try {
        runPipeline(t.oc, { ...CASES.box, ...change, parallel: false, memory: 'mitigated' });
      } catch (e) {
        error = (e as Error).message;
      }
      rows.push({ case: label, memory: 'mitigated', created: t.created(), live: t.live(), error });
    }
    return rows;
  },

  /**
   * Recycling: run a fixed number of times, then replace the instance with a
   * new one made from the already compiled module. A FinalizationRegistry on
   * each old WebAssembly.Memory proves the old heap is garbage collected.
   */
  async recycle({ variant, cycles, runsPerCycle, caseName }) {
    const v = variant as Variant;
    const bytes = readFileSync(`${LIBCASCADE_DIST}opencascade_${v}.wasm`);
    const module = await WebAssembly.compile(bytes);
    const collected = new Set<number>();
    const registry = new FinalizationRegistry<number>((id) => collected.add(id));
    const gc = (globalThis as unknown as { gc?: () => void }).gc;
    let oc = await create(v, module);
    const rows: unknown[] = [];
    for (let c = 0; c < (cycles as number); c++) {
      const t0 = performance.now();
      for (let i = 0; i < (runsPerCycle as number); i++) {
        runPipeline(oc, { ...CASES[caseName as CaseName], parallel: false, memory: 'mitigated' });
      }
      const runMs = performance.now() - t0;
      const heapBeforeRecycle = heapBytes(oc);
      registry.register(oc.wasmMemory, c);
      const t1 = performance.now();
      oc = await create(v, module);
      const recycleMs = performance.now() - t1;
      gc?.();
      await new Promise((r) => setTimeout(r, 20));
      gc?.();
      await new Promise((r) => setTimeout(r, 20));
      rows.push({
        cycle: c,
        runMs: round(runMs),
        heapBeforeRecycle,
        recycleMs: round(recycleMs),
        heapAfterRecycle: heapBytes(oc),
        oldMemoriesCollected: collected.size,
        rssMiB: round(process.memoryUsage().rss / 1024 / 1024, 0),
      });
    }
    return rows;
  },
};

const [task, json] = process.argv.slice(2);
const fn = task ? tasks[task] : undefined;
if (!fn) {
  console.error(`unknown task ${task}; one of ${Object.keys(tasks).join(', ')}`);
  process.exit(2);
}
const result = await fn(JSON.parse(json ?? '{}') as Args);
console.log(JSON.stringify(result));
// The multi-threaded build keeps pthread workers alive; exit explicitly.
process.exit(0);
