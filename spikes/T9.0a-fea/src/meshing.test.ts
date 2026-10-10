// gmsh meshing time at about 500k degrees of freedom on the scaling solid: one thread against all
// cores, and the default 3D Delaunay against HXT (gmsh's parallel Delaunay).

import { expect, test } from 'vitest';
import { meshStep } from './mesh.ts';
import { loadGmsh, solids, writeResult } from './node-env.ts';

test('meshing threads and algorithms', async () => {
  const steps = await solids();
  const gmsh = await loadGmsh();
  const runs: unknown[] = [];
  for (const algorithm3D of [1, 10])
    for (const threads of [1, 0]) {
      const { mesh, timing } = meshStep(gmsh, steps.bracket, {
        sizeMax: 1.75,
        threads,
        algorithm3D,
      });
      runs.push({
        algorithm3D,
        threads,
        dof: mesh.nodes.length,
        elements: mesh.tets.length / 10,
        ...timing,
      });
      console.log(
        `alg ${algorithm3D} threads ${threads}: dof ${mesh.nodes.length} generate ${timing.generateMs.toFixed(0)} ms`,
      );
    }
  gmsh.finalize();
  writeResult('meshing', { solid: 'bracket', sizeMax: 1.75, runs });
  expect(runs.length).toBe(4);
});
