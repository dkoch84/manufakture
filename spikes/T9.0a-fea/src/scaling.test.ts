// Time and memory at about 50k, 200k and 500k degrees of freedom, AMG against IC(0), in Node.
// Each size runs in this one process, largest last; the mesh size for each target is found by
// meshing only (cheap) before the timed run.

import { expect, test } from 'vitest';
import { bracket, cantilever } from './cases.ts';
import { meshStep } from './mesh.ts';
import { loadGmsh, rssMiB, solids, writeResult } from './node-env.ts';
import { analyse, type PreconditionerName, summary } from './run.ts';
import { vonMises } from './tet10.ts';

const TARGETS = (process.env.TARGETS ?? '50000,200000,500000').split(',').map(Number);
const PRECONDITIONERS = (process.env.PRECONDITIONERS ?? 'amg,ic0').split(
  ',',
) as PreconditionerName[];
const SOLIDS = (process.env.SOLIDS ?? 'bracket,cantilever').split(',');

test('scaling', async () => {
  const steps = await solids();
  const gmsh = await loadGmsh();
  const runs: unknown[] = [];
  for (const solid of SOLIDS) {
    const problem = solid === 'bracket' ? bracket : cantilever;
    const step = steps[solid as keyof typeof steps];
    for (const target of TARGETS) {
      // Find the mesh size: DOF scales as 1/h^3.
      let h = solid === 'bracket' ? 3.8 : 3;
      let dof = 0;
      for (let k = 0; k < 4; k++) {
        const { mesh } = meshStep(gmsh, step, { sizeMax: h });
        dof = mesh.nodes.length;
        if (Math.abs(dof / target - 1) < 0.06) break;
        h *= Math.cbrt(dof / target);
      }
      for (const p of PRECONDITIONERS) {
        const before = rssMiB();
        const r = analyse(gmsh, step, { sizeMax: h }, problem, p);
        let peak = 0;
        for (let i = 0; i < r.stress.length / 6; i++)
          peak = Math.max(peak, vonMises(r.stress, 6 * i));
        const s = summary(r);
        const after = rssMiB();
        runs.push({
          solid,
          target,
          sizeMax: h,
          ...s,
          peakVonMises: peak,
          rssBeforeMiB: before,
          rssAfterMiB: after,
        });
        console.log(
          `${solid} ${target} ${p}: dof ${s.dof} it ${s.iterations} total ${(s.ms.total / 1000).toFixed(1)} s ` +
            `(mesh ${(s.ms.mesh / 1000).toFixed(1)}, setup ${(s.ms.precondition / 1000).toFixed(1)}, solve ${(s.ms.solve / 1000).toFixed(1)}) ` +
            `solver ${(s.solverBytes / 2 ** 20).toFixed(0)} MiB gmsh ${(s.gmshBytes / 2 ** 20).toFixed(0)} MiB rss ${after} MiB vm ${peak.toFixed(1)}`,
        );
      }
    }
  }
  gmsh.finalize();
  writeResult(process.env.OUT ?? 'scaling-node', {
    loadAverage: (await import('node:os')).loadavg(),
    runs,
  });
  expect(runs.length).toBeGreaterThan(0);
});
