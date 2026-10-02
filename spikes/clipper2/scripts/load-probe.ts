// Runs in a fresh worker thread (one per sample) and reports how long a cold
// load of one library takes there: `ts` imports clipper2-ts and runs a first
// offset; `wasm` imports the ES glue, compiles and instantiates the .wasm, and
// runs a first offset. Plain Node (type stripping), no Vite.

import { parentPort, workerData } from 'node:worker_threads';

const which = (workerData as { which: 'ts' | 'wasm' }).which;
const square = [0, 0, 100_000, 0, 100_000, 100_000, 0, 100_000];
const t0 = performance.now();
let loaded: number;
let compiled: number;
if (which === 'ts') {
  const c = await import('clipper2-ts');
  loaded = performance.now();
  compiled = loaded;
  const path = [];
  for (let i = 0; i < square.length; i += 2) path.push({ x: square[i]!, y: square[i + 1]! });
  c.inflatePaths([path], 10_000, c.JoinType.Round, c.EndType.Polygon);
} else {
  const { readFile } = await import('node:fs/promises');
  const { createRequire } = await import('node:module');
  const glue = await import('clipper2-wasm/dist/es/clipper2z.js');
  const bytes = await readFile(
    createRequire(import.meta.url).resolve('clipper2-wasm/dist/es/clipper2z.wasm'),
  );
  loaded = performance.now();
  const wasmModule = await WebAssembly.compile(bytes);
  compiled = performance.now();
  const m = await glue.default({
    instantiateWasm(
      imports: WebAssembly.Imports,
      done: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void,
    ) {
      void WebAssembly.instantiate(wasmModule, imports).then((i) => done(i, wasmModule));
      return {};
    },
  } as never);
  const paths = new m.Paths64();
  const path = m.MakePath64(square);
  paths.push_back(path);
  const out = m.InflatePaths64(paths, 10_000, m.JoinType.Round, m.EndType.Polygon, 2, 0);
  out.delete();
  path.delete();
  paths.delete();
}
const done = performance.now();
parentPort!.postMessage({
  load: loaded - t0,
  compile: compiled - loaded,
  instantiateAndFirstCall: done - compiled,
  total: done - t0,
});
