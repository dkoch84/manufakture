// Time and edge counts of exact and poly HLR, per fixture and standard view, in Node. One fresh
// kernel per fixture; the first call of each (fixture, view, algorithm) is reported apart from
// the median of the following runs. Writes results/timing.json.

import { expect, it } from 'vitest';
import { createNodeKernel } from '../../../packages/kernel/src/node';
import { FIXTURES } from './fixtures';
import { uncovered } from './compare';
import { projectExact, projectPoly, shapeOf, summarize, type ProjectedEdge } from './hlr';
import { median, round, writeResult } from './results';
import { VIEWS } from './views';

const RUNS = Number(process.env.HLR_RUNS ?? 5);

it('times exact and poly HLR on every fixture and view', async () => {
  const rows: unknown[] = [];
  for (const [name, make] of Object.entries(FIXTURES)) {
    const k = await createNodeKernel();
    const fixture = make(k);
    const shapes = fixture.bodies.map((b) => shapeOf(k, b));
    const topo = fixture.bodies.map((b) => k.topology(b));
    const faces = topo.reduce((n, t) => n + t.faces.length, 0);
    const edges = topo.reduce((n, t) => n + t.edges.length, 0);
    for (const view of Object.values(VIEWS)) {
      const results: Partial<Record<'exact' | 'poly', ProjectedEdge[]>> = {};
      for (const algorithm of ['exact', 'poly'] as const) {
        const run = () =>
          algorithm === 'exact'
            ? projectExact(k.oc, shapes, view)
            : projectPoly(k.oc, shapes, view);
        const runs = name.startsWith('cabinet') ? Math.min(RUNS, 2) : RUNS;
        const first = run();
        const times: number[] = [];
        const hide: number[] = [];
        let last = first;
        for (let i = 0; i < runs; i++) {
          last = run();
          times.push(last.ms.total);
          hide.push(last.ms.hide);
        }
        expect(summarize(last.edges)).toEqual(summarize(first.edges));
        results[algorithm] = last.edges;
        const row: Record<string, unknown> = {
          fixture: name,
          bodies: fixture.bodies.length,
          faces,
          modelEdges: edges,
          view: view.name,
          algorithm,
          firstMs: round(first.ms.total),
          medianMs: round(median(times)),
          medianHideMs: round(median(hide)),
          ...summarize(last.edges),
        };
        rows.push(row);
        if (algorithm === 'poly') {
          // Do the two algorithms draw the same thing? Length (mm) drawn by one and not the other,
          // per visibility, sharp and outline edges together (smooth and sewn are options).
          const e = results.exact!;
          const p = results.poly!;
          const lines = (x: ProjectedEdge[], visible: boolean) =>
            x.filter((y) => y.visible === visible && (y.cls === 'sharp' || y.cls === 'outline'));
          const tol = 0.15;
          Object.assign(row, {
            disagreement: {
              visibleExactNotPoly: uncovered(lines(e, true), lines(p, true), tol),
              visiblePolyNotExact: uncovered(lines(p, true), lines(e, true), tol),
              hiddenExactNotPoly: uncovered(lines(e, false), lines(p, false), tol),
              hiddenPolyNotExact: uncovered(lines(p, false), lines(e, false), tol),
            },
          });
        }
        console.log(
          `${name.padEnd(16)} ${view.name.padEnd(5)} ${algorithm.padEnd(5)} first ${row.firstMs} ms, median ${row.medianMs} ms (hide ${row.medianHideMs}), ${row.edges} edges`,
          JSON.stringify(row.byClass),
          JSON.stringify(row.byType),
          'disagreement' in row ? JSON.stringify(row.disagreement) : '',
        );
      }
    }
  }
  writeResult('timing', { runs: RUNS, rows });
});
