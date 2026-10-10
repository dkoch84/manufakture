// Accuracy: each benchmark at three mesh densities against its analytical value.

import { expect, test } from 'vitest';
import { CASES } from './cases.ts';
import { loadGmsh, solids, writeResult } from './node-env.ts';
import { analyse, summary } from './run.ts';

test('benchmarks against analytical solutions', async () => {
  const steps = await solids();
  const gmsh = await loadGmsh();
  const out: unknown[] = [];
  for (const c of CASES) {
    for (const d of c.densities) {
      const r = analyse(
        gmsh,
        steps[c.id as keyof typeof steps],
        d.options,
        c,
        'amg',
        c.evaluate.bind(c),
      );
      const s = summary(r);
      out.push({ case: c.id, title: c.title, density: d.label, options: d.options, ...s });
      console.log(
        `${c.id} ${d.label}: dof ${s.dof} it ${s.iterations} total ${s.ms.total.toFixed(0)} ms load ${s.totalLoad.map((v) => v.toFixed(2)).join(',')}`,
      );
      for (const m of s.metrics!)
        console.log(
          `   ${m.name}: fea ${m.fea.toPrecision(5)} exact ${m.analytical.toPrecision(5)} err ${(100 * m.error).toFixed(2)}%`,
        );
    }
  }
  gmsh.finalize();
  writeResult('accuracy', { runs: out });
  expect(out.length).toBe(9);
});
