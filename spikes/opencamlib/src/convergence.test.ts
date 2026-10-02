// The evidence that OCL's ConeCutter gouges and the TypeScript V-bit is exact: at the worst V-bit
// disagreement on each mesh (read from results/compare.json, written by compare.test.ts), the
// brute-force lower bound (`sampledBound`) refined to 400, 1,000 and 2,500 steps per triangle
// side converges to the TypeScript height, and is above OCL's height from the start. Needs no
// OCL build; about 40 seconds.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { meshes, minZ, sampledBound } from './cases.ts';
import { DropCutter, type Cutter } from './dropcutter.ts';
import { round, writeResult } from './results.ts';

const COMPARE = join(dirname(fileURLToPath(import.meta.url)), '..', 'results', 'compare.json');
const STEPS = [400, 1000, 2500];
const VBIT: Cutter = { kind: 'vbit', diameter: 6.35, angle: 60 };

interface CompareRow {
  mesh: 'bracket' | 'filleted';
  cutter: string;
  worst: { x: number; y: number; ts: number; ocl: number }[];
}

describe.runIf(existsSync(COMPARE))('V-bit: brute-force bound convergence', () => {
  it('converges to the TypeScript height at the worst disagreement, above OCL', async () => {
    const rows = (JSON.parse(readFileSync(COMPARE, 'utf8')) as { rows: CompareRow[] }).rows;
    const all = await meshes();
    const out = [];
    for (const row of rows.filter((r) => r.cutter.startsWith('vbit') && r.worst.length > 0)) {
      const mesh = all[row.mesh];
      const { x, y, ocl } = row.worst[0]!;
      const ts = new DropCutter(mesh, VBIT).drop(x, y, minZ(mesh));
      const bounds = STEPS.map((n) => sampledBound(mesh, VBIT, x, y, n));
      const entry = {
        mesh: row.mesh,
        x,
        y,
        ts,
        ocl,
        bounds: STEPS.map((steps, i) => ({
          steps,
          bound: bounds[i]!,
          tsMinusBound: bounds[i]! === -Infinity ? null : round(ts - bounds[i]!, 7),
          boundMinusOcl: round(bounds[i]! - ocl, 7),
        })),
      };
      out.push(entry);
      console.log(JSON.stringify(entry));
      for (const b of bounds) {
        expect(ts).toBeGreaterThanOrEqual(b - 1e-9); // TS never below the bound
        expect(b).toBeGreaterThan(ocl); // so OCL is below the true height: a gouge
      }
      expect(ts - bounds[bounds.length - 1]!).toBeLessThan(1e-4);
    }
    expect(out.length).toBeGreaterThan(0);
    writeResult('convergence', { cutter: VBIT, steps: STEPS, points: out });
  });
});
