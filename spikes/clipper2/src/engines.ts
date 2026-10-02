// The two candidates behind one interface: offset closed, tagged polylines (mm)
// by `delta` (mm, positive outward) with round joins, and return tagged
// polylines. Conversion in and out is part of every engine, as it would be in
// `packages/cam`, so timings include it.
//
// - `ts`: clipper2-ts 2.0.1-18, `ClipperOffset` on `Path64` objects ({ x, y, z }).
// - `wasm-64`: clipper2-wasm 0.4.0, `InflatePaths64` on `Path64` filled from a
//   `BigInt64Array` (x, y, z triples) with `assign`, read back with `view()`.
// - `wasm-d`: clipper2-wasm 0.4.0, `InflatePathsD` on `PathD` (Float64Array
//   triples); the library scales by 10^precision itself.
//
// Every embind object is deleted in a `finally`, including the copies that
// `Paths64.get(i)` returns.

import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import Clipper2Z from 'clipper2-wasm/dist/es/clipper2z.js';
import type { MainModule, Path64, PathD, Paths64, PathsD } from 'clipper2-wasm/dist/clipper2z';
import {
  ClipperOffset,
  EndType,
  JoinType,
  type Path64 as TsPath64,
  type Paths64 as TsPaths64,
  type Point64,
} from 'clipper2-ts';
import type { TaggedPath } from './geometry.ts';

export interface OffsetOptions {
  /** Integer units per millimetre. */
  scale: number;
  /** Chord error of the round joins, in millimetres. */
  arcTol: number;
  /**
   * clipper2-ts only: a Z callback for intersections the offset's own rule cannot
   * tag. It gets the two edges' end points (with their tags) and gives the new
   * point the tag of the nearest of the four that has one. Counted in `zCallbackCalls`.
   */
  zCallback?: boolean;
}

export interface Engine {
  name: 'ts' | 'wasm-64' | 'wasm-d';
  offset(paths: readonly TaggedPath[], delta: number, o: OffsetOptions): TaggedPath[];
}

export const MITER_LIMIT = 2;

// clipper2-ts ----------------------------------------------------------------------------

export let zCallbackCalls = 0;

/** The tag of the end point nearest to p among the given ones that carry a tag (0 if none). */
const nearestTag = (p: Point64, ends: readonly Point64[]): number => {
  let best = 0;
  let bestD = Infinity;
  for (const e of ends) {
    if (!e.z) continue;
    const d = Math.hypot(p.x - e.x, p.y - e.y);
    if (d < bestD) {
      bestD = d;
      best = e.z;
    }
  }
  return best;
};

export const tsEngine: Engine = {
  name: 'ts',
  offset(paths, delta, o) {
    const input: TsPaths64 = paths.map((p) => {
      const n = p.xy.length / 2;
      const out: TsPath64 = new Array(n);
      for (let i = 0; i < n; i++) {
        out[i] = {
          x: Math.round(p.xy[2 * i]! * o.scale),
          y: Math.round(p.xy[2 * i + 1]! * o.scale),
          z: p.z[i]!,
        };
      }
      return out;
    });
    const co = new ClipperOffset(MITER_LIMIT, o.arcTol * o.scale);
    if (o.zCallback) {
      co.zCallback = (bot1, top1, bot2, top2, ip) => {
        zCallbackCalls++;
        ip.z = nearestTag(ip, [bot1, top1, bot2, top2]);
      };
    }
    co.addPaths(input, JoinType.Round, EndType.Polygon);
    const solution: TsPaths64 = [];
    co.execute(delta * o.scale, solution);
    return solution.map((path) => {
      const xy = new Float64Array(path.length * 2);
      const z = new Float64Array(path.length);
      path.forEach((pt, i) => {
        xy[2 * i] = pt.x / o.scale;
        xy[2 * i + 1] = pt.y / o.scale;
        z[i] = pt.z ?? 0;
      });
      return { xy, z };
    });
  },
};

// clipper2-wasm ---------------------------------------------------------------------------

/** The ES build's .wasm file (the package has no `exports` map, so the subpath resolves). */
export const WASM_FILE = createRequire(import.meta.url).resolve(
  'clipper2-wasm/dist/es/clipper2z.wasm',
);

export type WasmModule = MainModule & { HEAPU8: Uint8Array };

export interface WasmLoad {
  module: WasmModule;
  /** The raw `malloc` and `free` exports, for heap probes. */
  malloc: (n: number) => number;
  free: (p: number) => void;
  memory: WebAssembly.Memory;
}

/** Instantiate clipper2-wasm (ES build), capturing malloc, free and the memory. */
export async function loadWasm(): Promise<WasmLoad> {
  let exports: WebAssembly.Exports | undefined;
  const module = (await Clipper2Z({
    instantiateWasm(
      imports: WebAssembly.Imports,
      done: (instance: WebAssembly.Instance, module?: WebAssembly.Module) => void,
    ) {
      void (async () => {
        const { instance, module: m } = await WebAssembly.instantiate(
          await readFile(WASM_FILE),
          imports,
        );
        exports = instance.exports;
        done(instance, m);
      })();
      return {};
    },
  } as never)) as unknown as WasmModule;
  // Minified export names of this build (see assignWasmExports in clipper2z.js).
  const e = exports as Record<string, unknown>;
  return {
    module,
    malloc: e.H as (n: number) => number,
    free: e.I as (p: number) => void,
    memory: e.D as WebAssembly.Memory,
  };
}

export function wasm64Engine(m: WasmModule): Engine {
  return {
    name: 'wasm-64',
    offset(paths, delta, o) {
      const input: Paths64 = new m.Paths64();
      let output: Paths64 | undefined;
      try {
        for (const p of paths) {
          const n = p.xy.length / 2;
          const flat = new BigInt64Array(n * 3);
          for (let i = 0; i < n; i++) {
            flat[3 * i] = BigInt(Math.round(p.xy[2 * i]! * o.scale));
            flat[3 * i + 1] = BigInt(Math.round(p.xy[2 * i + 1]! * o.scale));
            flat[3 * i + 2] = BigInt(p.z[i]!);
          }
          const path: Path64 = new m.Path64();
          path.assign(flat);
          input.push_back(path);
          path.delete();
        }
        output = m.InflatePaths64(
          input,
          delta * o.scale,
          m.JoinType.Round,
          m.EndType.Polygon,
          MITER_LIMIT,
          o.arcTol * o.scale,
        );
        const result: TaggedPath[] = [];
        for (let k = 0; k < output.size(); k++) {
          const path = output.get(k);
          try {
            const v = path.view(); // a view into the WASM heap: read it before delete()
            const n = v.length / 3;
            const xy = new Float64Array(n * 2);
            const z = new Float64Array(n);
            for (let i = 0; i < n; i++) {
              xy[2 * i] = Number(v[3 * i]) / o.scale;
              xy[2 * i + 1] = Number(v[3 * i + 1]) / o.scale;
              z[i] = Number(v[3 * i + 2]);
            }
            result.push({ xy, z });
          } finally {
            path.delete();
          }
        }
        return result;
      } finally {
        input.delete();
        output?.delete();
      }
    },
  };
}

export function wasmDEngine(m: WasmModule): Engine {
  return {
    name: 'wasm-d',
    offset(paths, delta, o) {
      const precision = Math.round(Math.log10(o.scale));
      if (10 ** precision !== o.scale) throw new Error('wasm-d needs a power-of-ten scale');
      const input: PathsD = new m.PathsD();
      let output: PathsD | undefined;
      try {
        for (const p of paths) {
          const n = p.xy.length / 2;
          const flat = new Float64Array(n * 3);
          for (let i = 0; i < n; i++) {
            flat[3 * i] = p.xy[2 * i]!;
            flat[3 * i + 1] = p.xy[2 * i + 1]!;
            flat[3 * i + 2] = p.z[i]!;
          }
          const path: PathD = new m.PathD();
          path.assign(flat);
          input.push_back(path);
          path.delete();
        }
        output = m.InflatePathsD(
          input,
          delta,
          m.JoinType.Round,
          m.EndType.Polygon,
          MITER_LIMIT,
          precision,
          o.arcTol,
        );
        const result: TaggedPath[] = [];
        for (let k = 0; k < output.size(); k++) {
          const path = output.get(k);
          try {
            const v = path.view();
            const n = v.length / 3;
            const xy = new Float64Array(n * 2);
            const z = new Float64Array(n);
            for (let i = 0; i < n; i++) {
              xy[2 * i] = v[3 * i]!;
              xy[2 * i + 1] = v[3 * i + 1]!;
              z[i] = v[3 * i + 2]!;
            }
            result.push({ xy, z });
          } finally {
            path.delete();
          }
        }
        return result;
      } finally {
        input.delete();
        output?.delete();
      }
    },
  };
}
