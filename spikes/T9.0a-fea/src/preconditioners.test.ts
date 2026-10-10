// Preconditioners for conjugate gradients on the cantilever (the slender case, the hardest for
// one-level methods), at the medium and fine meshes: Jacobi, 3x3 block Jacobi, IC(0) in gmsh's node
// order and after reverse Cuthill-McKee, and smoothed-aggregation AMG.

import { expect, test } from 'vitest';
import { cantilever } from './cases.ts';
import { loadGmsh, solids, writeResult } from './node-env.ts';
import { analyse, type PreconditionerName, summary } from './run.ts';

test('preconditioners', async () => {
  const steps = await solids();
  const gmsh = await loadGmsh();
  const runs: unknown[] = [];
  const variants: [PreconditionerName, boolean][] = [
    ['jacobi', true],
    ['block-jacobi', true],
    ['ic0', false],
    ['ic0', true],
    ['amg', true],
  ];
  for (const d of cantilever.densities.slice(1)) {
    for (const [p, reorder] of variants) {
      const s = summary(
        analyse(
          gmsh,
          steps.cantilever,
          d.options,
          cantilever,
          p,
          cantilever.evaluate.bind(cantilever),
          1e-8,
          reorder,
        ),
      );
      runs.push({ density: d.label, order: reorder ? 'rcm' : 'gmsh', ...s });
      console.log(
        `${d.label} ${p} ${reorder ? 'rcm' : 'gmsh'}: dof ${s.dof} it ${s.iterations} setup ${s.ms.precondition.toFixed(0)} ms solve ${s.ms.solve.toFixed(0)} ms ` +
          `tip err ${(100 * s.metrics![0]!.error).toFixed(3)}%`,
      );
    }
  }
  gmsh.finalize();
  writeResult('preconditioners', { tolerance: 1e-8, runs });
  expect(runs.length).toBe(10);
});
