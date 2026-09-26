// Loading libcascade (ADR 0002, decisions 1 and 4): the single-threaded
// build, its .wasm compiled once with streaming and kept as a
// WebAssembly.Module, so that recycling makes a new instance without
// refetching. Progress is reported for the splash screen.

import { createInstance } from 'libcascade/single/init';
import type { Oc } from './occt';

/**
 * Where the .wasm comes from:
 * - `url`: fetched and compiled with streaming (the browser worker; the URL
 *   comes from Vite's `libcascade/single/wasm?url`);
 * - `bytes`: already in memory (the Node harness);
 * - `module`: already compiled.
 */
export type WasmSource =
  | { url: string; fetch?: typeof fetch }
  | { bytes: ArrayBuffer | Uint8Array }
  | { module: WebAssembly.Module };

export type LoadProgress =
  /** `total` is null when unknown. */
  | { phase: 'download'; loaded: number; total: number | null }
  | { phase: 'compile' }
  | { phase: 'instantiate' }
  /** Static constructors and embind registration: about 80 % of a warm start (T0.2). */
  | { phase: 'init' }
  | { phase: 'ready'; ms: number };

export interface LoaderOptions {
  onProgress?: (progress: LoadProgress) => void;
  /**
   * Uncompressed size of the pinned `opencascade_single.wasm`, used as the
   * download total when the response is compressed (its Content-Length is
   * then the compressed size) or has none.
   */
  expectedBytes?: number;
  /** Minimum time between two download progress reports. */
  progressIntervalMs?: number;
}

/** Size of libcascade 3.0.2's `opencascade_single.wasm` (T0.2). */
export const LIBCASCADE_WASM_BYTES = 42_691_285;

type Instantiate = (
  imports: WebAssembly.Imports,
  receive: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void,
) => object;

/** Compiles the kernel's wasm once and makes as many instances from it as needed. */
export class OcctLoader {
  private readonly source: WasmSource;
  private readonly options: LoaderOptions;
  private compiled: Promise<WebAssembly.Module> | null = null;

  constructor(source: WasmSource, options: LoaderOptions = {}) {
    this.source = source;
    this.options = options;
  }

  /** The compiled module, fetched and compiled on first use. */
  compile(): Promise<WebAssembly.Module> {
    if (this.compiled === null) {
      const compiling = this.compileOnce();
      // A failed load can be retried.
      compiling.catch(() => {
        if (this.compiled === compiling) this.compiled = null;
      });
      this.compiled = compiling;
    }
    return this.compiled;
  }

  /** A new, fully initialised libcascade instance from the cached module. */
  async instantiate(): Promise<Oc> {
    const t0 = performance.now();
    const module = await this.compile();
    this.report({ phase: 'instantiate' });
    // If instantiation fails, Emscripten never calls back and createInstance
    // would never settle, so the failure is raced against it.
    let fail!: (error: unknown) => void;
    const failed = new Promise<never>((_, reject) => {
      fail = reject;
    });
    const instantiateWasm: Instantiate = (imports, receive) => {
      WebAssembly.instantiate(module, imports).then((instance) => {
        this.report({ phase: 'init' });
        receive(instance, module);
      }, fail);
      return {};
    };
    const oc = await Promise.race([
      // instantiateWasm is an Emscripten module option libcascade does not type.
      createInstance({ instantiateWasm } as Parameters<typeof createInstance>[0]),
      failed,
    ]);
    this.report({ phase: 'ready', ms: performance.now() - t0 });
    return oc;
  }

  private report(progress: LoadProgress): void {
    try {
      this.options.onProgress?.(progress);
    } catch {
      // A broken progress listener must not break loading.
    }
  }

  private async compileOnce(): Promise<WebAssembly.Module> {
    const source = this.source;
    if ('module' in source) return source.module;
    if ('bytes' in source) {
      this.report({ phase: 'compile' });
      return WebAssembly.compile(source.bytes as BufferSource);
    }
    const doFetch = source.fetch ?? fetch;
    const response = await doFetch(source.url, { credentials: 'same-origin' });
    if (!response.ok) {
      throw new Error(`kernel wasm: HTTP ${response.status} for ${source.url}`);
    }
    const compressed = response.headers.get('content-encoding') !== null;
    const length = Number(response.headers.get('content-length'));
    const total =
      !compressed && Number.isFinite(length) && length > 0
        ? length
        : (this.options.expectedBytes ?? LIBCASCADE_WASM_BYTES);
    if (response.body === null) {
      this.report({ phase: 'compile' });
      return WebAssembly.compile(await response.arrayBuffer());
    }
    // Count the bytes on their way into the streaming compiler.
    let loaded = 0;
    let last = -Infinity;
    const interval = this.options.progressIntervalMs ?? 50;
    this.report({ phase: 'download', loaded: 0, total });
    const counter = new TransformStream<Uint8Array, Uint8Array>({
      transform: (chunk, controller) => {
        loaded += chunk.byteLength;
        const now = performance.now();
        if (now - last >= interval) {
          last = now;
          this.report({ phase: 'download', loaded, total: loaded > total ? null : total });
        }
        controller.enqueue(chunk);
      },
      flush: () => {
        this.report({ phase: 'download', loaded, total: loaded });
        this.report({ phase: 'compile' });
      },
    });
    return WebAssembly.compileStreaming(
      new Response(response.body.pipeThrough(counter), {
        headers: { 'Content-Type': 'application/wasm' },
      }),
    );
  }
}
