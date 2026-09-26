// Thin layer over planegcs's GcsWrapper, shared by the tests, the Node
// measurements, the page (main thread) and the worker.

import {
  Algorithm,
  DebugMode,
  GcsWrapper,
  SolveStatus,
  init_planegcs_module,
  type ModuleStatic,
} from '@salusoft89/planegcs';
import type { Item } from './sketch.ts';
import { withMemoryPages } from './wasm-memory.ts';

export { Algorithm, SolveStatus };
export type AlgorithmName = keyof typeof Algorithm;
export const ALGORITHMS: AlgorithmName[] = ['DogLeg', 'LevenbergMarquardt', 'BFGS'];

export type StatusName = 'Success' | 'Converged' | 'Failed' | 'SuccessfulSolutionInvalid';
const STATUS_NAMES = Object.fromEntries(
  Object.entries(SolveStatus).map(([k, v]) => [v, k as StatusName]),
) as Record<SolveStatus, StatusName>;

export function statusName(s: SolveStatus): StatusName {
  return STATUS_NAMES[s];
}

export interface LoadOptions {
  /** Where the glue fetches the wasm from (browser: the Vite `?url` asset). */
  wasmUrl?: string;
  /**
   * The wasm bytes, for loading a copy with a larger memory (see
   * wasm-memory.ts). Instantiated through Emscripten's instantiateWasm hook.
   */
  wasmBytes?: Uint8Array;
  /** Memory size in 64 KiB pages; requires wasmBytes. Stock build: 256. */
  memoryPages?: number;
}

type Instantiate = (
  imports: WebAssembly.Imports,
  receive: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void,
) => object;

/**
 * Load the wasm module. With no options the Emscripten glue finds
 * planegcs.wasm next to itself (Node); under Vite the caller passes the asset
 * URL or the fetched bytes.
 */
export async function loadModule(options: LoadOptions = {}): Promise<ModuleStatic> {
  const { wasmUrl, wasmBytes, memoryPages } = options;
  if (memoryPages !== undefined && !wasmBytes) throw new Error('memoryPages needs wasmBytes');
  if (!wasmBytes) {
    return init_planegcs_module(wasmUrl ? { locateFile: () => wasmUrl } : undefined);
  }
  const bytes = memoryPages === undefined ? wasmBytes : withMemoryPages(wasmBytes, memoryPages);
  const instantiateWasm: Instantiate = (imports, receive) => {
    void WebAssembly.instantiate(bytes as Uint8Array<ArrayBuffer>, imports).then((r) =>
      receive(r.instance, r.module),
    );
    return {};
  };
  // The published typings only declare locateFile; the glue also honours
  // Module.instantiateWasm.
  const init = init_planegcs_module as unknown as (o: {
    instantiateWasm: Instantiate;
  }) => Promise<ModuleStatic>;
  return init({ instantiateWasm });
}

export function createWrapper(mod: ModuleStatic): GcsWrapper {
  const wrapper = new GcsWrapper(new mod.GcsSystem(), mod);
  // The default (Minimal) prints a console line from inside the wasm on every
  // diagnosis; NoDebug keeps the benchmarks free of console I/O.
  wrapper.debug_mode = DebugMode.NoDebug;
  return wrapper;
}

export interface Report {
  status: StatusName;
  dof: number;
  conflicting: string[];
  redundant: string[];
  partiallyRedundant: string[];
}

/**
 * Load a sketch into an empty system, solve once and read the diagnosis.
 * dof() and the conflict lists are only valid after a solve: the diagnosis
 * runs inside solve_system (System::initSolution), and before the first
 * solve dof() returns -1.
 */
export function analyze(
  wrapper: GcsWrapper,
  items: Item[],
  algorithm: Algorithm = Algorithm.DogLeg,
): Report {
  wrapper.clear_data();
  wrapper.push_primitives_and_params(items);
  const status = wrapper.solve(algorithm);
  wrapper.apply_solution();
  return {
    status: statusName(status),
    dof: wrapper.gcs.dof(),
    conflicting: wrapper.get_gcs_conflicting_constraints(),
    redundant: wrapper.get_gcs_redundant_constraints(),
    partiallyRedundant: wrapper.get_gcs_partially_redundant_constraints(),
  };
}

/** Coordinates of a point after apply_solution(). */
export function pointXY(wrapper: GcsWrapper, id: string): [number, number] {
  const p = wrapper.sketch_index.get_sketch_point(id);
  return [p.x, p.y];
}

/**
 * Copy every solver parameter into a Float64Array. This is the "read the
 * solution back" step a renderer needs after each solve. get_p_params()
 * returns an embind vector that must be deleted; each get() is one call into
 * wasm, which is part of what the benchmark measures.
 */
export function readParams(wrapper: GcsWrapper, out?: Float64Array): Float64Array {
  const vec = wrapper.gcs.get_p_params();
  const n = vec.size();
  const result = out && out.length === n ? out : new Float64Array(n);
  for (let i = 0; i < n; i++) result[i] = vec.get(i);
  vec.delete();
  return result;
}
