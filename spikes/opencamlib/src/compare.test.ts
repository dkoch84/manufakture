// OpenCAMLib's PathDropCutter against the TypeScript drop-cutter on the same XY points: time,
// and agreement point by point (max Z difference), with independent sanity checks of both.
//
// OCL_RUNS=n sets the timed runs per cell (default 3, after one first run).

import { describe, expect, it } from 'vitest';
import { CUTTERS, RASTER, meshes, minZ, sampledBound, sanity, type Sanity } from './cases.ts';
import { DropCutter } from './dropcutter.ts';
import { bounds, rasterLines, sampleLines, triangleCount } from './geometry.ts';
import { loadOcl, makeCutter, makeSurf, oclBuilt, pathDropCutter } from './ocl.ts';
import { median, round, writeResult } from './results.ts';

const RUNS = Number(process.env.OCL_RUNS ?? 3);

interface Row {
  mesh: string;
  triangles: number;
  cutter: string;
  points: number;
  ocl: {
    surfMs: number;
    setupMs: number;
    runMs: number;
    extractMs: number;
    firstRunMs: number;
  };
  ts: { indexMs: number; dropMs: number; firstDropMs: number; trianglesTestedPerPoint: number };
  /** OCL's run() alone over TS's drop time. */
  speedRatioRun: number;
  /** OCL setup + run + extract (what a caller pays per operation) over TS index + drop. */
  speedRatioTotal: number;
  agreement: {
    maxAbsDz: number;
    /** Largest TS minus OCL: TS higher. */
    maxTsAbove: number;
    /** Largest OCL minus TS: OCL higher (so TS lower there). */
    maxOclAbove: number;
    over1um: number;
    over10um: number;
  };
  sanity: { ocl: Sanity; ts: Sanity };
  /**
   * The points where the two disagree most, each with a brute-force lower bound (`sampledBound`,
   * 400 steps per triangle side): whichever result is under the bound gouges there.
   */
  worst: { x: number; y: number; ts: number; ocl: number; bound: number }[];
}

describe.runIf(oclBuilt())('OCL PathDropCutter against the TypeScript drop-cutter', () => {
  it('agrees point by point on both meshes for flat, ball and V cutters', async () => {
    const ocl = await loadOcl();
    const all = await meshes();
    const rows: Row[] = [];
    for (const mesh of [all.bracket, all.filleted]) {
      const floor = minZ(mesh);
      const lines = rasterLines(bounds(mesh), RASTER.stepover, 4);
      const xy = sampleLines(lines, RASTER.sampling);
      const ts0 = performance.now();
      const surf = makeSurf(ocl, mesh);
      const surfMs = performance.now() - ts0;
      for (const { name, cutter } of CUTTERS) {
        const oc = makeCutter(ocl, cutter);
        const oclRuns = [];
        for (let r = 0; r <= RUNS; r++) {
          oclRuns.push(pathDropCutter(ocl, surf, oc, lines, RASTER.sampling, floor));
        }
        oc.delete();
        const o = oclRuns[0]!.points;
        const timed = oclRuns.slice(1);

        const tsRuns: { indexMs: number; dropMs: number; z: Float64Array; tested: number }[] = [];
        for (let r = 0; r <= RUNS; r++) {
          const a = performance.now();
          const dc = new DropCutter(mesh, cutter);
          const b = performance.now();
          const z = dc.dropPoints(xy, floor);
          const c = performance.now();
          tsRuns.push({ indexMs: b - a, dropMs: c - b, z, tested: dc.tested });
        }
        const z = tsRuns[0]!.z;

        // Same XY, same order.
        expect(o.length / 3).toBe(z.length);
        let xyErr = 0;
        for (let i = 0; i < z.length; i++) {
          xyErr = Math.max(
            xyErr,
            Math.abs(o[i * 3]! - xy[i * 2]!),
            Math.abs(o[i * 3 + 1]! - xy[i * 2 + 1]!),
          );
        }
        expect(xyErr).toBeLessThan(1e-9);

        let maxAbs = 0,
          tsAbove = 0,
          oclAbove = 0,
          over1 = 0,
          over10 = 0;
        for (let i = 0; i < z.length; i++) {
          const d = z[i]! - o[i * 3 + 2]!;
          maxAbs = Math.max(maxAbs, Math.abs(d));
          tsAbove = Math.max(tsAbove, d);
          oclAbove = Math.max(oclAbove, -d);
          if (Math.abs(d) > 1e-3) over1++;
          if (Math.abs(d) > 1e-2) over10++;
        }
        const tsPoints = new Float64Array(z.length * 3);
        for (let i = 0; i < z.length; i++) {
          tsPoints[i * 3] = xy[i * 2]!;
          tsPoints[i * 3 + 1] = xy[i * 2 + 1]!;
          tsPoints[i * 3 + 2] = z[i]!;
        }
        const stride = mesh.name === 'filleted' ? 5 : 1;
        const s = {
          ocl: sanity(mesh, cutter, o, floor, stride),
          ts: sanity(mesh, cutter, tsPoints, floor, stride),
        };

        const worst: Row['worst'] = [];
        if (maxAbs > 1e-6) {
          const order = [...z.keys()]
            .sort((a, b) => Math.abs(z[b]! - o[b * 3 + 2]!) - Math.abs(z[a]! - o[a * 3 + 2]!))
            .slice(0, 3);
          for (const i of order) {
            const x = xy[i * 2]!,
              y = xy[i * 2 + 1]!;
            worst.push({
              x,
              y,
              ts: z[i]!,
              ocl: o[i * 3 + 2]!,
              bound: sampledBound(mesh, cutter, x, y, 400),
            });
          }
        }

        const oclT = {
          surfMs: round(surfMs),
          setupMs: round(median(timed.map((t) => t.times.setup))),
          runMs: round(median(timed.map((t) => t.times.run))),
          extractMs: round(median(timed.map((t) => t.times.extract))),
          firstRunMs: round(oclRuns[0]!.times.run),
        };
        const tsT = {
          indexMs: round(median(tsRuns.slice(1).map((t) => t.indexMs))),
          dropMs: round(median(tsRuns.slice(1).map((t) => t.dropMs))),
          firstDropMs: round(tsRuns[0]!.dropMs),
          trianglesTestedPerPoint: round(tsRuns[0]!.tested / z.length, 1),
        };
        const row: Row = {
          mesh: mesh.name,
          triangles: triangleCount(mesh),
          cutter: name,
          points: z.length,
          ocl: oclT,
          ts: tsT,
          speedRatioRun: round(oclT.runMs / tsT.dropMs),
          speedRatioTotal: round(
            (oclT.setupMs + oclT.runMs + oclT.extractMs) / (tsT.indexMs + tsT.dropMs),
          ),
          agreement: {
            maxAbsDz: maxAbs,
            maxTsAbove: tsAbove,
            maxOclAbove: oclAbove,
            over1um: over1,
            over10um: over10,
          },
          sanity: s,
          worst,
        };
        rows.push(row);
        console.log(JSON.stringify(row));
      }
      surf.delete();
    }
    writeResult('compare', { raster: RASTER, runs: RUNS, rows });

    for (const r of rows) {
      // The TypeScript cutter never gouges, by the independent checks.
      expect(r.sanity.ts.maxVertexPenetration).toBeLessThan(1e-6);
      if (r.sanity.ts.maxBallPenetration !== null) {
        expect(r.sanity.ts.maxBallPenetration).toBeLessThan(1e-6);
        expect(r.sanity.ts.ballNotTouching).toBe(0);
      }
      // Where the two disagree, TS is never under the brute-force bound, and above it only by
      // the bound's sampling error (a few micrometres on the part's 30 mm tall wall triangles,
      // whose 400-step grid is 0.075 mm coarse).
      for (const w of r.worst) {
        expect(w.ts).toBeGreaterThan(w.bound - 1e-9);
        expect(w.ts - w.bound).toBeLessThan(0.01);
      }
    }
  });
});
