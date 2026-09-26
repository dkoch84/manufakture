// Geometry worker: owns the OCCT instance. The main thread talks to it through
// Comlink and receives meshes as transferred (zero-copy) typed arrays.

import * as Comlink from 'comlink';
import { createInstance as createSingle } from 'libcascade/single/init';
import { createInstance as createMulti } from 'libcascade/multi/init';
// ?url keeps each .wasm a separately fetched asset (never inlined into JS).
import singleWasmUrl from 'libcascade/single/wasm?url';
import multiWasmUrl from 'libcascade/multi/wasm?url';
import {
  heapBytes,
  runPipeline,
  type MeshData,
  type Oc,
  type PipelineOptions,
} from './pipeline.ts';
import type { HeapTrace, InitOptions, InitReport } from './protocol.ts';

let oc: Oc | null = null;

function instance(): Oc {
  if (!oc) throw new Error('init() first');
  return oc;
}

/**
 * Emscripten's instantiateWasm hook lets us own fetch + compile + instantiate
 * and time each phase. Everything after the callback (static constructors,
 * embind class registration, pthread pool start-up) is "runtime init".
 */
function timedInstantiate(url: string, load: InitOptions['load'], marks: Map<string, number>) {
  return (
    imports: WebAssembly.Imports,
    receive: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void,
  ) => {
    marks.set('hook', performance.now());
    void (async () => {
      let module: WebAssembly.Module;
      if (load === 'streaming') {
        module = await WebAssembly.compileStreaming(fetch(url, { credentials: 'same-origin' }));
      } else {
        const bytes = await (await fetch(url, { credentials: 'same-origin' })).arrayBuffer();
        marks.set('fetched', performance.now());
        marks.set('wasmBytes', bytes.byteLength);
        module = await WebAssembly.compile(bytes);
      }
      marks.set('compiled', performance.now());
      const inst = await WebAssembly.instantiate(module, imports);
      marks.set('instantiated', performance.now());
      receive(inst, module);
    })();
    return {};
  };
}

const api = {
  env() {
    return {
      crossOriginIsolated: globalThis.crossOriginIsolated,
      hardwareConcurrency: navigator.hardwareConcurrency,
      userAgent: navigator.userAgent,
    };
  },

  async init(options: InitOptions): Promise<InitReport> {
    if (oc) throw new Error('already initialised');
    const url = options.variant === 'single' ? singleWasmUrl : multiWasmUrl;
    const create = options.variant === 'single' ? createSingle : createMulti;
    const marks = new Map<string, number>();
    const t0 = performance.now();
    const moduleOptions =
      options.load === 'glue'
        ? // The glue's own path: WebAssembly.instantiateStreaming on locateFile's URL.
          { locateFile: () => url }
        : { instantiateWasm: timedInstantiate(url, options.load, marks) };
    oc = await create(moduleOptions as Parameters<typeof create>[0]);
    const t1 = performance.now();

    const since = (a: string | number, b: string) => {
      const start = typeof a === 'number' ? a : marks.get(a);
      const end = marks.get(b);
      return start === undefined || end === undefined ? null : end - start;
    };
    return {
      variant: options.variant,
      load: options.load,
      workerTimeOriginToInitStartMs: t0,
      glueMs: since(t0, 'hook'),
      fetchMs: since('hook', 'fetched'),
      compileMs: options.load === 'arraybuffer' ? since('fetched', 'compiled') : null,
      fetchAndCompileMs: since('hook', 'compiled'),
      instantiateMs: since('compiled', 'instantiated'),
      runtimeInitMs: marks.has('instantiated') ? t1 - marks.get('instantiated')! : null,
      totalMs: t1 - t0,
      heapBytesAfterInit: heapBytes(oc),
      wasmBytes: marks.get('wasmBytes') ?? null,
    };
  },

  run(options: PipelineOptions): MeshData {
    const mesh = runPipeline(instance(), options);
    return Comlink.transfer(mesh, [
      mesh.positions.buffer,
      mesh.normals.buffer,
      mesh.indices.buffer,
      mesh.faceRanges.buffer,
    ]);
  },

  /** Run the pipeline repeatedly and record the heap size after each run. */
  heapTrace(options: PipelineOptions, runs: number): HeapTrace {
    const o = instance();
    const before = heapBytes(o);
    const after: number[] = [];
    const t0 = performance.now();
    for (let i = 0; i < runs; i++) {
      runPipeline(o, options);
      after.push(heapBytes(o));
    }
    return {
      runs,
      memory: options.memory ?? 'mitigated',
      before,
      after,
      ms: performance.now() - t0,
    };
  },

  heap(): number {
    return heapBytes(instance());
  },
};

export type WorkerApi = typeof api;

Comlink.expose(api);
