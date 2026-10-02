// Runs in a Node worker thread (worker.test.ts): loads the OCL module and the TypeScript cutter in
// the worker, drops a ball on the cached bracket mesh with both, and posts the results back.
// Plain Node with type stripping: only erasable TypeScript, and only node builtins and `.ts`
// files that themselves import nothing else at run time.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import { DropCutter } from './dropcutter.ts';
import { loadOcl, makeCutter, makeSurf, pathDropCutter } from './ocl.ts';

interface Input {
  cache: string;
  lines: number[][];
  sampling: number;
  floor: number;
}

const input = workerData as Input;
const bytes = readFileSync(join(input.cache, 'bracket.mesh'));
const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
const [np, ni] = new Uint32Array(buf, 0, 2);
const mesh = {
  name: 'bracket',
  positions: new Float32Array(buf, 8, np),
  indices: new Uint32Array(buf, 8 + np! * 4, ni),
};

const t0 = performance.now();
const ocl = await loadOcl();
const loadMs = performance.now() - t0;
const surf = makeSurf(ocl, mesh);
const cutter = makeCutter(ocl, { kind: 'ball', diameter: 6.35 });
const run = pathDropCutter(ocl, surf, cutter, input.lines, input.sampling, input.floor);
cutter.delete();
surf.delete();

const dc = new DropCutter(mesh, { kind: 'ball', diameter: 6.35 });
const ts = new Float64Array(run.points.length / 3);
for (let i = 0; i < ts.length; i++) {
  ts[i] = dc.drop(run.points[i * 3]!, run.points[i * 3 + 1]!, input.floor);
}

parentPort!.postMessage({ loadMs, points: run.points, ts }, [
  run.points.buffer as ArrayBuffer,
  ts.buffer as ArrayBuffer,
]);
