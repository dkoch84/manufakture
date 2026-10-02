// Loads the OpenCAMLib build (build/dist/ocl.mjs + ocl.wasm, made by build/build-ocl.sh) and wraps
// the upstream embind API the spike uses. Every embind object made here is deleted here; the
// memory probe checks that this is enough.

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Mesh } from './geometry.ts';

export const OCL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'build', 'dist');
export const OCL_MJS = join(OCL_DIR, 'ocl.mjs');

export const oclBuilt = (): boolean => existsSync(OCL_MJS) && existsSync(join(OCL_DIR, 'ocl.wasm'));

interface Deletable {
  delete(): void;
}
interface EmPoint extends Deletable {
  x: number;
  y: number;
  z: number;
}
interface EmVector<T> extends Deletable {
  size(): number;
  get(i: number): T;
}
interface EmSurf extends Deletable {
  addTriangle(t: Deletable): void;
  size(): number;
}
interface EmOp extends Deletable {
  setSTL(s: EmSurf): void;
  setCutter(c: Deletable): void;
  setSampling(s: number): void;
  setZ(z: number): void;
  run(): void;
}
interface EmPathOp extends EmOp {
  setPath(p: EmPath): void;
  getPoints(): EmVector<EmPoint>;
}
interface EmAdaptive extends EmPathOp {
  setMinSampling(s: number): void;
  setCosLimit(c: number): void;
}
interface EmBatch extends EmOp {
  appendPoint(p: EmPoint): void;
  getCLPoints(): EmVector<EmPoint>;
}
interface EmWaterline extends EmOp {
  getLoops(): EmVector<EmVector<EmPoint>>;
}
interface EmAdaptiveWaterline extends EmWaterline {
  setMinSampling(s: number): void;
}
interface EmPath extends Deletable {
  appendLine(l: Deletable): void;
}
type Ctor<T, A extends unknown[]> = new (...args: A) => T;

/** The parts of the module the spike uses. */
export interface OclModule {
  Point: Ctor<EmPoint, [number, number, number]>;
  CLPoint: Ctor<EmPoint, [number, number, number]>;
  Triangle: Ctor<Deletable, [EmPoint, EmPoint, EmPoint]>;
  STLSurf: Ctor<EmSurf, []>;
  Line: Ctor<Deletable, [EmPoint, EmPoint]>;
  Path: Ctor<EmPath, []>;
  CylCutter: Ctor<Deletable, [number, number]>;
  BallCutter: Ctor<Deletable, [number, number]>;
  ConeCutter: Ctor<Deletable, [number, number, number]>;
  PathDropCutter: Ctor<EmPathOp, []>;
  AdaptivePathDropCutter: Ctor<EmAdaptive, []>;
  BatchDropCutter: Ctor<EmBatch, []>;
  Waterline: Ctor<EmWaterline, []>;
  AdaptiveWaterline: Ctor<EmAdaptiveWaterline, []>;
  HEAPU8: Uint8Array;
  _sbrk(n: number): number;
}

export async function loadOcl(): Promise<OclModule> {
  const mod = (await import(pathToFileURL(OCL_MJS).href)) as {
    default: () => Promise<OclModule>;
  };
  return mod.default();
}

/** The wasm heap top (sbrk(0)): only moves up, and stays put when freed memory is reused. */
export const heapTop = (ocl: OclModule): number => ocl._sbrk(0);
export const memoryBytes = (ocl: OclModule): number => ocl.HEAPU8.buffer.byteLength;

/** An STLSurf filled one triangle at a time, as the upstream bindings allow. */
export function makeSurf(ocl: OclModule, mesh: Mesh): EmSurf {
  const surf = new ocl.STLSurf();
  const { positions: p, indices: ix } = mesh;
  for (let i = 0; i < ix.length; i += 3) {
    const pts = [0, 1, 2].map((c) => {
      const v = ix[i + c]! * 3;
      return new ocl.Point(p[v]!, p[v + 1]!, p[v + 2]!);
    }) as [EmPoint, EmPoint, EmPoint];
    const tri = new ocl.Triangle(...pts);
    surf.addTriangle(tri);
    tri.delete();
    for (const q of pts) q.delete();
  }
  return surf;
}

export type OclCutterSpec =
  | { kind: 'flat'; diameter: number }
  | { kind: 'ball'; diameter: number }
  | { kind: 'vbit'; diameter: number; angle: number };

/** Tool length for every cutter: longer than any mesh here, so the shaft never matters. */
const LENGTH = 100;

export function makeCutter(ocl: OclModule, c: OclCutterSpec): Deletable {
  switch (c.kind) {
    case 'flat':
      return new ocl.CylCutter(c.diameter, LENGTH);
    case 'ball':
      return new ocl.BallCutter(c.diameter, LENGTH);
    case 'vbit':
      // OCL's ConeCutter angle is the half angle, in radians.
      return new ocl.ConeCutter(c.diameter, ((c.angle / 2) * Math.PI) / 180, LENGTH);
  }
}

function makePath(ocl: OclModule, lines: ReadonlyArray<readonly number[]>): EmPath {
  const path = new ocl.Path();
  for (const [ax, ay, bx, by] of lines) {
    const a = new ocl.Point(ax!, ay!, 0);
    const b = new ocl.Point(bx!, by!, 0);
    const l = new ocl.Line(a, b);
    path.appendLine(l);
    l.delete();
    a.delete();
    b.delete();
  }
  return path;
}

/** Copy an embind vector of points into x, y, z triples, deleting every element and the vector. */
function drain(v: EmVector<EmPoint>): Float64Array {
  const n = v.size();
  const out = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) {
    const p = v.get(i);
    out[i * 3] = p.x;
    out[i * 3 + 1] = p.y;
    out[i * 3 + 2] = p.z;
    p.delete();
  }
  v.delete();
  return out;
}

export interface OclTimes {
  /** Building the path or appending points, in ms. */
  setup: number;
  /** run(), in ms. */
  run: number;
  /** Copying results out of the module, in ms. */
  extract: number;
}

export interface PathRun {
  points: Float64Array;
  times: OclTimes;
}

export function pathDropCutter(
  ocl: OclModule,
  surf: EmSurf,
  cutter: Deletable,
  lines: ReadonlyArray<readonly number[]>,
  sampling: number,
  minZ: number,
): PathRun {
  const t0 = performance.now();
  const op = new ocl.PathDropCutter();
  op.setSTL(surf);
  op.setCutter(cutter);
  op.setSampling(sampling);
  op.setZ(minZ);
  const path = makePath(ocl, lines);
  op.setPath(path);
  const t1 = performance.now();
  op.run();
  const t2 = performance.now();
  const points = drain(op.getPoints());
  const t3 = performance.now();
  op.delete();
  path.delete();
  return { points, times: { setup: t1 - t0, run: t2 - t1, extract: t3 - t2 } };
}

export function adaptivePathDropCutter(
  ocl: OclModule,
  surf: EmSurf,
  cutter: Deletable,
  lines: ReadonlyArray<readonly number[]>,
  sampling: number,
  minSampling: number,
  cosLimit: number,
  minZ: number,
): PathRun {
  const t0 = performance.now();
  const op = new ocl.AdaptivePathDropCutter();
  op.setSTL(surf);
  op.setCutter(cutter);
  op.setSampling(sampling);
  op.setMinSampling(minSampling);
  op.setCosLimit(cosLimit);
  op.setZ(minZ);
  const path = makePath(ocl, lines);
  op.setPath(path);
  const t1 = performance.now();
  op.run();
  const t2 = performance.now();
  const points = drain(op.getPoints());
  const t3 = performance.now();
  op.delete();
  path.delete();
  return { points, times: { setup: t1 - t0, run: t2 - t1, extract: t3 - t2 } };
}

/** Drop at exactly the given XY pairs (BatchDropCutter), for point-by-point comparison. */
export function batchDropCutter(
  ocl: OclModule,
  surf: EmSurf,
  cutter: Deletable,
  xy: Float64Array,
  minZ: number,
): PathRun {
  const t0 = performance.now();
  const op = new ocl.BatchDropCutter();
  op.setSTL(surf);
  op.setCutter(cutter);
  for (let i = 0; i < xy.length; i += 2) {
    const p = new ocl.CLPoint(xy[i]!, xy[i + 1]!, minZ);
    op.appendPoint(p);
    p.delete();
  }
  const t1 = performance.now();
  op.run();
  const t2 = performance.now();
  const points = drain(op.getCLPoints());
  const t3 = performance.now();
  op.delete();
  return { points, times: { setup: t1 - t0, run: t2 - t1, extract: t3 - t2 } };
}

export interface WaterlineRun {
  loops: Float64Array[];
  times: OclTimes;
}

export function waterline(
  ocl: OclModule,
  surf: EmSurf,
  cutter: Deletable,
  z: number,
  sampling: number,
  adaptive?: { minSampling: number },
): WaterlineRun {
  const t0 = performance.now();
  const op = adaptive ? new ocl.AdaptiveWaterline() : new ocl.Waterline();
  op.setSTL(surf);
  op.setCutter(cutter);
  op.setZ(z);
  op.setSampling(sampling);
  if (adaptive) (op as EmAdaptiveWaterline).setMinSampling(adaptive.minSampling);
  const t1 = performance.now();
  op.run();
  const t2 = performance.now();
  const v = op.getLoops();
  const loops: Float64Array[] = [];
  for (let i = 0, n = v.size(); i < n; i++) loops.push(drain(v.get(i)));
  v.delete();
  const t3 = performance.now();
  op.delete();
  return { loops, times: { setup: t1 - t0, run: t2 - t1, extract: t3 - t2 } };
}
