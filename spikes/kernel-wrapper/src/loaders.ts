// Loads each OCCT build through Emscripten's `instantiateWasm` hook, so that
// the spike gets hold of the WebAssembly instance (its memory and its
// allocator) whatever the wrapper exposes. Load phases are timed the same way
// as in the T0.2 spike.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { OpenCascadeInstance as Libcascade } from 'libcascade/single/init';
import type { OcctKernel } from 'occt-wasm';
import type { OpenCascadeInstance as ReplicadOc } from 'replicad-opencascadejs';

export type BuildName = 'libcascade' | 'replicad-opencascadejs' | 'occt-wasm';

type Imports = Record<string, Record<string, unknown>>;
type Receive = (instance: WebAssembly.Instance, module: WebAssembly.Module) => void;

export interface LoadTimings {
  /** Reading the .wasm file from disk. */
  readMs: number;
  /** WebAssembly.compile (V8 compiles lazily, so this is mostly validation). */
  compileMs: number;
  instantiateMs: number;
  /** From instantiation until the module is usable (static constructors, embind). */
  runtimeInitMs: number;
  totalMs: number;
}

/** Direct access to one wasm instance's linear memory and allocator. */
export interface Heap {
  memory: WebAssembly.Memory;
  malloc(size: number): number;
  free(ptr: number): void;
}

export interface Loaded<T> {
  build: BuildName;
  module: T;
  instance: WebAssembly.Instance;
  heap: Heap;
  timings: LoadTimings;
  wasmPath: string;
  gluePath: string;
}

function resolvePath(specifier: string): string {
  return fileURLToPath(import.meta.resolve(specifier));
}

interface Capture {
  instance: WebAssembly.Instance | null;
  marks: Record<string, number>;
}

/** An instantiateWasm hook that loads `wasmPath` itself and records the instance. */
function hook(wasmPath: string, capture: Capture, wrapImports?: (imports: Imports) => void) {
  return (imports: Imports, receive: Receive): object => {
    wrapImports?.(imports);
    void (async () => {
      capture.marks.hook = performance.now();
      const bytes = readFileSync(wasmPath);
      capture.marks.read = performance.now();
      const module = await WebAssembly.compile(bytes);
      capture.marks.compiled = performance.now();
      const instance = await WebAssembly.instantiate(module, imports as WebAssembly.Imports);
      capture.marks.instantiated = performance.now();
      capture.instance = instance;
      receive(instance, module);
    })();
    return {};
  };
}

function timings(t0: number, marks: Record<string, number>, done: number): LoadTimings {
  const m = (k: string) => marks[k] ?? t0;
  return {
    readMs: m('read') - m('hook'),
    compileMs: m('compiled') - m('read'),
    instantiateMs: m('instantiated') - m('compiled'),
    runtimeInitMs: done - m('instantiated'),
    totalMs: done - t0,
  };
}

function findMemory(instance: WebAssembly.Instance, imports?: Imports): WebAssembly.Memory {
  for (const v of Object.values(instance.exports)) if (v instanceof WebAssembly.Memory) return v;
  for (const mod of Object.values(imports ?? {})) {
    for (const v of Object.values(mod)) if (v instanceof WebAssembly.Memory) return v;
  }
  throw new Error('no WebAssembly.Memory found');
}

/** libcascade and replicad's build expose their allocator on the module. */
interface ExposedAllocator {
  _emscripten_builtin_malloc(size: number): number;
  _emscripten_builtin_free(ptr: number): void;
}

function exposedHeap(instance: WebAssembly.Instance, module: unknown): Heap {
  const m = module as ExposedAllocator;
  return {
    memory: findMemory(instance),
    malloc: (n) => m._emscripten_builtin_malloc(n),
    free: (p) => m._emscripten_builtin_free(p),
  };
}

/**
 * occt-wasm's glue is minified and keeps malloc and free private, so read their
 * export names from the glue source (`_malloc=wasmExports["fa"]`).
 */
function minifiedHeap(instance: WebAssembly.Instance, gluePath: string): Heap {
  const glue = readFileSync(gluePath, 'utf8');
  const find = (name: string) => {
    const match = new RegExp(`\\b${name}=wasmExports\\["([\\w$]+)"\\]`).exec(glue);
    if (!match) throw new Error(`${name} not found in ${gluePath}`);
    return match[1]!;
  };
  const exports = instance.exports as Record<string, unknown>;
  const malloc = exports[find('_malloc')] as (n: number) => number;
  const free = exports[find('_free')] as (p: number) => void;
  return { memory: findMemory(instance), malloc, free };
}

export async function loadLibcascade(wrapImports?: (i: Imports) => void) {
  const wasmPath = resolvePath('libcascade/single/wasm');
  const gluePath = resolvePath('libcascade/single');
  const { createInstance } = await import('libcascade/single/init');
  const capture: Capture = { instance: null, marks: {} };
  const t0 = performance.now();
  // The options type does not list instantiateWasm, but Emscripten honours it.
  const options = { instantiateWasm: hook(wasmPath, capture, wrapImports) };
  const oc = await createInstance(options as never);
  const done = performance.now();
  const loaded: Loaded<Libcascade> = {
    build: 'libcascade',
    module: oc,
    instance: capture.instance!,
    heap: exposedHeap(capture.instance!, oc),
    timings: timings(t0, capture.marks, done),
    wasmPath,
    gluePath,
  };
  return loaded;
}

export async function loadReplicadOc(wrapImports?: (i: Imports) => void) {
  const wasmPath = resolvePath('replicad-opencascadejs/wasm');
  const gluePath = resolvePath('replicad-opencascadejs');
  const init = (await import('replicad-opencascadejs')).default;
  const capture: Capture = { instance: null, marks: {} };
  const t0 = performance.now();
  const oc = await init({ instantiateWasm: hook(wasmPath, capture, wrapImports) });
  const done = performance.now();
  const loaded: Loaded<ReplicadOc> = {
    build: 'replicad-opencascadejs',
    module: oc,
    instance: capture.instance!,
    heap: exposedHeap(capture.instance!, oc),
    timings: timings(t0, capture.marks, done),
    wasmPath,
    gluePath,
  };
  return loaded;
}

type OcctModule = ReturnType<OcctKernel['getRawModule']>;

/**
 * occt-wasm through its own glue, so the hook can be installed. The wrapper's
 * constructor is private in the typings but is exactly what `init()` calls.
 */
export async function loadOcctWasm(wrapImports?: (i: Imports) => void) {
  const wasmPath = resolvePath('occt-wasm/dist/occt-wasm.wasm');
  const gluePath = resolvePath('occt-wasm/dist/occt-wasm.js');
  const { OcctKernel } = await import('occt-wasm');
  // @ts-expect-error: the glue has no type declarations
  const glue = (await import('occt-wasm/dist/occt-wasm.js')) as {
    default: (opts: object) => Promise<OcctModule>;
  };
  const capture: Capture = { instance: null, marks: {} };
  const t0 = performance.now();
  const raw = await glue.default({ instantiateWasm: hook(wasmPath, capture, wrapImports) });
  const Ctor = OcctKernel as unknown as new (m: OcctModule) => OcctKernel;
  const kernel = new Ctor(raw);
  const done = performance.now();
  const loaded: Loaded<OcctKernel> = {
    build: 'occt-wasm',
    module: kernel,
    instance: capture.instance!,
    heap: minifiedHeap(capture.instance!, gluePath),
    timings: timings(t0, capture.marks, done),
    wasmPath,
    gluePath,
  };
  return loaded;
}

/**
 * Bytes of the heap in use: the memory size minus what can still be allocated
 * in 64 KiB blocks before the memory has to grow (the T0.2 method). Probing
 * disturbs the allocator, so call it at the end of a process.
 */
export function usedHeapBytes(heap: Heap): number {
  const block = 64 * 1024;
  const start = heap.memory.buffer.byteLength;
  const blocks: number[] = [];
  for (;;) {
    const ptr = heap.malloc(block);
    if (ptr === 0 || heap.memory.buffer.byteLength !== start) {
      if (ptr !== 0) heap.free(ptr);
      break;
    }
    blocks.push(ptr);
  }
  for (const ptr of blocks) heap.free(ptr);
  return start - blocks.length * block;
}
