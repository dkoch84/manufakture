// OpenCAMLib's other operations and its memory: AdaptivePathDropCutter and Waterline with ball
// and flat cutters on both meshes (time, output sanity), and heap growth over repeated runs for
// OCL (wasm heap) and the TypeScript cutter (JS heap). The TypeScript cutter, checked on its own
// in dropcutter.test.ts and compare.test.ts, serves as the reference for "no point below the mesh".

import { describe, expect, it } from 'vitest';
import { meshes, minZ } from './cases.ts';
import { DropCutter, type Cutter } from './dropcutter.ts';
import {
  bounds,
  pointTriangleDistance2,
  rasterLines,
  sampleLines,
  triangleCoords,
} from './geometry.ts';
import type { Mesh } from './geometry.ts';
import {
  adaptivePathDropCutter,
  heapTop,
  loadOcl,
  makeCutter,
  makeSurf,
  memoryBytes,
  oclBuilt,
  pathDropCutter,
  waterline,
} from './ocl.ts';
import { round, writeResult } from './results.ts';

const BALL: Cutter = { kind: 'ball', diameter: 6.35 };
const FLAT: Cutter = { kind: 'flat', diameter: 6.35 };

/** Waterline levels: through the bracket's base, wall and top; the block, its fillet and the boss. */
const LEVELS: Record<string, number[]> = {
  bracket: [3, 10, 25, 39],
  filleted: [5, 20, 27, 35, 43],
};

/** The most a point's Z is under the TS drop height at its XY (positive = gouge). */
function belowMesh(dc: DropCutter, pts: Float64Array, floor: number): number {
  let worst = -Infinity;
  for (let i = 0; i < pts.length; i += 3) {
    worst = Math.max(worst, dc.drop(pts[i]!, pts[i + 1]!, floor) - pts[i + 2]!);
  }
  return worst;
}

interface LoopCheck {
  loops: number;
  points: number;
  /** Largest distance from a loop's last point back to its first. */
  maxClosingGap: number;
  /** Largest distance between consecutive points. */
  maxStep: number;
  /** Largest |z - level| over all points. */
  maxZError: number;
  /**
   * Positive means the tool cuts into the part. Ball: R minus the centre's distance to the mesh.
   * Flat: the drop height of a tool 0.01 mm smaller in diameter, minus the level.
   */
  maxPenetration: number;
  /**
   * Positive means the loop stands off the part. Ball: the centre's distance minus R. Flat: the
   * level minus the drop height of a tool 0.01 mm larger (which must collide at the level).
   */
  maxGap: number;
}

function checkLoops(mesh: Mesh, c: Cutter, loops: Float64Array[], level: number): LoopCheck {
  const R = c.diameter / 2;
  const t = triangleCoords(mesh);
  const n = t.length / 9;
  // A smaller and a larger copy of the tool: the smaller must clear the mesh at the level
  // (no gouge), the larger must not (the loop hugs the part).
  const delta = 0.005;
  const small = new DropCutter(mesh, { ...c, diameter: c.diameter - 2 * delta });
  const big = new DropCutter(mesh, { ...c, diameter: c.diameter + 2 * delta });
  let maxClosingGap = 0,
    maxStep = 0,
    maxZError = 0,
    points = 0,
    maxPenetration = -Infinity,
    maxGap = -Infinity;
  for (const L of loops) {
    const m = L.length / 3;
    points += m;
    if (m === 0) continue;
    maxClosingGap = Math.max(
      maxClosingGap,
      Math.hypot(L[0]! - L[(m - 1) * 3]!, L[1]! - L[(m - 1) * 3 + 1]!, L[2]! - L[(m - 1) * 3 + 2]!),
    );
    for (let i = 0; i < m; i++) {
      const x = L[i * 3]!,
        y = L[i * 3 + 1]!,
        z = L[i * 3 + 2]!;
      maxZError = Math.max(maxZError, Math.abs(z - level));
      if (i > 0) {
        maxStep = Math.max(
          maxStep,
          Math.hypot(x - L[(i - 1) * 3]!, y - L[(i - 1) * 3 + 1]!, z - L[(i - 1) * 3 + 2]!),
        );
      }
      if (c.kind === 'ball') {
        let best = Infinity;
        for (let k = 0; k < n; k++)
          best = Math.min(best, pointTriangleDistance2(x, y, z + R, t, k * 9));
        const d = Math.sqrt(best);
        maxPenetration = Math.max(maxPenetration, R - d);
        maxGap = Math.max(maxGap, d - R);
      } else {
        maxPenetration = Math.max(maxPenetration, small.drop(x, y, level - 100) - z);
        maxGap = Math.max(maxGap, z - big.drop(x, y, level - 100));
      }
    }
  }
  return {
    loops: loops.length,
    points,
    maxClosingGap,
    maxStep,
    maxZError,
    maxPenetration,
    maxGap,
  };
}

describe.runIf(oclBuilt())('OpenCAMLib operations', () => {
  it('AdaptivePathDropCutter: fewer points, none below the mesh', async () => {
    const ocl = await loadOcl();
    const all = await meshes();
    const rows = [];
    for (const mesh of [all.bracket, all.filleted]) {
      const floor = minZ(mesh);
      const lines = rasterLines(bounds(mesh), 0.5, 4);
      const surf = makeSurf(ocl, mesh);
      for (const c of [BALL, FLAT]) {
        const oc = makeCutter(ocl, c);
        const uniform = pathDropCutter(ocl, surf, oc, lines, 0.1, floor);
        const adaptive = adaptivePathDropCutter(ocl, surf, oc, lines, 1, 0.02, 0.999, floor);
        oc.delete();
        const dc = new DropCutter(mesh, c);
        const row = {
          mesh: mesh.name,
          cutter: `${c.kind} ${c.diameter}`,
          uniform: { points: uniform.points.length / 3, runMs: round(uniform.times.run) },
          adaptive: {
            points: adaptive.points.length / 3,
            runMs: round(adaptive.times.run),
            extractMs: round(adaptive.times.extract),
            maxBelowMesh: belowMesh(dc, adaptive.points, floor),
          },
          uniformMaxBelowMesh: belowMesh(dc, uniform.points, floor),
        };
        rows.push(row);
        console.log(JSON.stringify(row));
      }
      surf.delete();
    }
    writeResult('adaptive', {
      settings: { stepover: 0.5, sampling: 1, minSampling: 0.02, cosLimit: 0.999 },
      rows,
    });
    for (const r of rows) {
      expect(r.adaptive.maxBelowMesh).toBeLessThan(1e-6);
      expect(r.uniformMaxBelowMesh).toBeLessThan(1e-6);
      expect(r.adaptive.points).toBeLessThan(r.uniform.points);
    }
  });

  it('Waterline and AdaptiveWaterline: closed loops at the level, hugging the part', async () => {
    const ocl = await loadOcl();
    const all = await meshes();
    const rows = [];
    for (const mesh of [all.bracket, all.filleted]) {
      const surf = makeSurf(ocl, mesh);
      for (const c of [BALL, FLAT]) {
        const oc = makeCutter(ocl, c);
        for (const level of LEVELS[mesh.name]!) {
          for (const adaptive of [false, true]) {
            const run = waterline(
              ocl,
              surf,
              oc,
              level,
              0.5,
              adaptive ? { minSampling: 0.05 } : undefined,
            );
            const row = {
              mesh: mesh.name,
              cutter: `${c.kind} ${c.diameter}`,
              level,
              adaptive,
              runMs: round(run.times.run),
              extractMs: round(run.times.extract),
              ...checkLoops(mesh, c, run.loops, level),
            };
            rows.push(row);
            console.log(JSON.stringify(row));
          }
        }
        oc.delete();
      }
      surf.delete();
    }
    writeResult('waterline', { settings: { sampling: 0.5, adaptiveMinSampling: 0.05 }, rows });
    for (const r of rows) {
      expect(r.loops).toBeGreaterThan(0);
      expect(r.maxZError).toBeLessThan(1e-9);
      // Closed: the step from the last point back to the first is no longer than any other step.
      expect(r.maxClosingGap).toBeLessThanOrEqual(r.maxStep + 1e-9);
      expect(r.maxPenetration).toBeLessThan(1e-6);
      expect(r.maxGap).toBeLessThan(1e-3);
    }
  });

  it('memory: heap growth over repeated runs', async () => {
    const all = await meshes();
    const RUNS = 12;
    const result: Record<string, unknown> = {};
    const mesh = all.filleted;
    const floor = minZ(mesh);
    const lines = rasterLines(bounds(mesh), 2, 4);

    // OCL: one fresh module, then every run builds and deletes everything it uses.
    const ocl = await loadOcl();
    const cycle = (kind: 'pdc' | 'adaptive' | 'waterline') => {
      const surf = makeSurf(ocl, mesh);
      const oc = makeCutter(ocl, BALL);
      if (kind === 'pdc') pathDropCutter(ocl, surf, oc, lines, 0.5, floor);
      else if (kind === 'adaptive')
        adaptivePathDropCutter(ocl, surf, oc, lines, 2, 0.1, 0.999, floor);
      else waterline(ocl, surf, oc, 20, 1);
      oc.delete();
      surf.delete();
    };
    for (const kind of ['pdc', 'adaptive', 'waterline'] as const) {
      const tops: number[] = [];
      for (let i = 0; i < RUNS; i++) {
        cycle(kind);
        tops.push(heapTop(ocl));
      }
      result[`ocl-${kind}`] = {
        heapTopMiB: tops.map((x) => round(x / 2 ** 20, 3)),
        growthAfterFirstKiB: round((tops[RUNS - 1]! - tops[0]!) / 1024, 1),
        memoryMiB: round(memoryBytes(ocl) / 2 ** 20, 1),
      };
    }

    // TS: JS heap after a forced collection, keeping nothing between runs.
    const gc = (globalThis as { gc?: () => void }).gc;
    const xy = sampleLines(lines, 0.5);
    const used: number[] = [];
    for (let i = 0; i < RUNS; i++) {
      const dc = new DropCutter(mesh, BALL);
      dc.dropPoints(xy, floor);
      gc?.();
      used.push(process.memoryUsage().heapUsed);
    }
    result.ts = {
      gcAvailable: gc !== undefined,
      heapUsedMiB: used.map((x) => round(x / 2 ** 20, 2)),
      growthAfterFirstKiB: round((used[RUNS - 1]! - used[0]!) / 1024, 1),
    };
    console.log(JSON.stringify(result));
    writeResult('memory', { mesh: mesh.name, runs: RUNS, cutter: BALL, result });
  });
});
