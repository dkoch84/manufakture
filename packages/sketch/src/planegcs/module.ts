// Loading planegcs (FreeCAD's PlaneGCS as WebAssembly, LGPL, loaded as a
// separate .wasm asset) and detecting when an instance dies. The published
// 1.2.0 binary has a fixed 16 MiB heap and aborts with `Aborted(OOM)` from
// about 130 entities (T0.4). An abort poisons the instance: every later call
// throws. It must be discarded and a new one loaded (ADR 0003, decision 3).
//
// This is the only module, with system.ts, that imports planegcs.

import { init_planegcs_module, type GcsSystem, type ModuleStatic } from '@salusoft89/planegcs';

export interface PlanegcsLoadOptions {
  /**
   * URL of `planegcs.wasm`. In the browser, import it with Vite's `?url`
   * suffix and pass it here. In Node the glue finds the file next to itself.
   */
  wasmUrl?: string;
  /** The wasm bytes, when the caller has fetched them already. */
  wasmBytes?: Uint8Array;
}

/** Thrown by calls into a planegcs instance that has aborted. */
export class SolverAbortedError extends Error {
  /** What Emscripten reported, for example `OOM`. */
  readonly reason: string;
  constructor(reason: string) {
    const oom = /OOM/i.test(reason);
    super(
      oom
        ? 'The sketch solver ran out of memory (planegcs Aborted(OOM)). The published solver ' +
            'holds about 125 connected entities; split the sketch or simplify it.'
        : `The sketch solver stopped (planegcs aborted: ${reason}).`,
    );
    this.name = 'SolverAbortedError';
    this.reason = reason;
  }
}

type Instantiate = (
  imports: WebAssembly.Imports,
  receive: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void,
) => object;

interface GlueOptions {
  locateFile?: () => string;
  instantiateWasm?: Instantiate;
  onAbort?: (what: unknown) => void;
  print?: (text: string) => void;
  printErr?: (text: string) => void;
}

/** One planegcs instance (one wasm heap), shared by the systems created from it. */
export class PlanegcsModule {
  private abortReason: string | null = null;
  private readonly systems = new Set<GcsSystem>();

  private constructor(private readonly mod: ModuleStatic) {}

  /**
   * Load a fresh instance. Each call instantiates its own heap, so a new
   * module is unaffected by an abort in an old one.
   */
  static async load(options: PlanegcsLoadOptions = {}): Promise<PlanegcsModule> {
    let module: PlanegcsModule | null = null;
    let early: string | null = null;
    const glue: GlueOptions = {
      onAbort: (what) => {
        const reason = String(what ?? 'unknown');
        if (module) module.abortReason ??= reason;
        else early = reason;
      },
      // The glue prints the abort (and debug output) through these; keep it
      // off the console, the abort is reported as data instead.
      print: () => {},
      printErr: () => {},
    };
    if (options.wasmBytes) {
      const bytes = options.wasmBytes;
      glue.instantiateWasm = (imports, receive) => {
        void WebAssembly.instantiate(bytes as Uint8Array<ArrayBuffer>, imports).then((r) =>
          receive(r.instance, r.module),
        );
        return {};
      };
    } else if (options.wasmUrl) {
      const url = options.wasmUrl;
      glue.locateFile = () => url;
    }
    // The published typings only declare locateFile; the glue honours the
    // other Emscripten Module options too.
    const init = init_planegcs_module as unknown as (o: GlueOptions) => Promise<ModuleStatic>;
    const mod = await init(glue);
    module = new PlanegcsModule(mod);
    if (early !== null) module.abortReason = early;
    return module;
  }

  /** Why this instance aborted, or `null` while it is usable. */
  get aborted(): string | null {
    return this.abortReason;
  }

  createSystem(): GcsSystem {
    return this.call(() => {
      const gcs = new this.mod.GcsSystem();
      gcs.set_debug_mode(0); // NoDebug: the default prints from inside the wasm on every diagnosis
      this.systems.add(gcs);
      return gcs;
    });
  }

  deleteSystem(gcs: GcsSystem): void {
    if (!this.systems.delete(gcs) || this.abortReason !== null) return;
    try {
      gcs.clear_data();
      gcs.delete();
    } catch {
      // Deleting after an abort can throw; the heap is discarded anyway.
    }
  }

  /**
   * Run `fn`, which calls into this instance. Any abort (during this call or
   * earlier) comes out as a SolverAbortedError; other errors pass through.
   */
  call<T>(fn: () => T): T {
    if (this.abortReason !== null) throw new SolverAbortedError(this.abortReason);
    try {
      return fn();
    } catch (e) {
      if (this.abortReason === null && e instanceof WebAssembly.RuntimeError) {
        this.abortReason = e.message;
      }
      if (this.abortReason !== null) throw new SolverAbortedError(this.abortReason);
      throw e;
    }
  }
}
