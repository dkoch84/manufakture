// Types shared by the worker, the page and the measurement script.

import type { MemoryMode } from './pipeline.ts';

export type Variant = 'single' | 'multi';

/**
 * How the .wasm is loaded:
 * - streaming: WebAssembly.compileStreaming(fetch()), compile overlaps download
 * - arraybuffer: fetch().arrayBuffer() then WebAssembly.compile(bytes)
 * - glue: let the Emscripten glue do it (instantiateStreaming), total time only
 */
export type LoadMode = 'streaming' | 'arraybuffer' | 'glue';

export interface InitOptions {
  variant: Variant;
  load: LoadMode;
}

export interface InitReport {
  variant: Variant;
  load: LoadMode;
  /** Worker start-up before init() was called (module script load and parse). */
  workerTimeOriginToInitStartMs: number;
  /** Import of the Emscripten glue JS until it asked for the wasm. */
  glueMs: number | null;
  /** Download only (arraybuffer mode). */
  fetchMs: number | null;
  /** Compile only (arraybuffer mode). */
  compileMs: number | null;
  /** Download plus compile; overlapped in streaming mode. */
  fetchAndCompileMs: number | null;
  instantiateMs: number | null;
  /** Static constructors, embind registration, pthread pool start-up. */
  runtimeInitMs: number | null;
  /** init() call to a usable instance, measured inside the worker. */
  totalMs: number;
  heapBytesAfterInit: number;
  wasmBytes: number | null;
}

export interface HeapTrace {
  runs: number;
  memory: MemoryMode;
  before: number;
  /** Heap size after each run. */
  after: number[];
  ms: number;
}
