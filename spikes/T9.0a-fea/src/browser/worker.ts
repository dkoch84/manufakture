// The FEA worker: loads gmsh-wasm (served as it is from /gmsh/, not bundled), reads the kernel's
// STEP files, and runs the same pipeline as the Node probes (../run.ts).

import { CASES, bracket, cantilever } from '../cases.ts';
import { analyse, type PreconditionerName, summary } from '../run.ts';
import { vonMises } from '../tet10.ts';

interface Plan {
  accuracy: boolean;
  threads: number;
  scaling: {
    solid: 'bracket' | 'cantilever';
    target: number;
    sizeMax: number;
    preconditioner: PreconditionerName;
  }[];
}

/** Tell the page (and through its console, the test sampling memory) which run is in progress. */
function progress(label: string, phase: 'start' | 'end'): void {
  (self as unknown as Worker).postMessage({ progress: label, phase });
}

async function step(id: string): Promise<Uint8Array> {
  return new Uint8Array(await (await fetch(`/step/${id}.step`)).arrayBuffer());
}

self.onmessage = async (e: MessageEvent<Plan>) => {
  const plan = e.data;
  const out: Record<string, unknown> = {};
  try {
    let t = performance.now();
    const url = '/gmsh/gmsh.mjs';
    const { default: initialize } = await import(/* @vite-ignore */ url);
    const gmsh = await initialize({ print: () => {}, printErr: () => {} });
    gmsh.initialize();
    gmsh.option.setNumber('General.Terminal', 0);
    out.gmshLoadMs = performance.now() - t;

    if (plan.accuracy) {
      const runs: unknown[] = [];
      for (const c of CASES) {
        const s = await step(c.id);
        for (const d of c.densities) {
          progress(`${c.id}-${d.label}`, 'start');
          const r = summary(
            analyse(gmsh, s, { ...d.options, threads: plan.threads }, c, 'amg', c.evaluate.bind(c)),
          );
          progress(`${c.id}-${d.label}`, 'end');
          runs.push({ case: c.id, density: d.label, ...r });
        }
      }
      out.accuracy = runs;
    }

    const scaling: unknown[] = [];
    for (const job of plan.scaling) {
      const problem = job.solid === 'bracket' ? bracket : cantilever;
      const bytes = await step(job.solid);
      const label = `${job.solid}-${job.target}-${job.preconditioner}`;
      progress(label, 'start');
      const r = analyse(
        gmsh,
        bytes,
        { sizeMax: job.sizeMax, threads: plan.threads },
        problem,
        job.preconditioner,
      );
      progress(label, 'end');
      let peak = 0;
      for (let i = 0; i < r.stress.length / 6; i++)
        peak = Math.max(peak, vonMises(r.stress, 6 * i));
      scaling.push({ ...job, ...summary(r), peakVonMises: peak });
    }
    out.scaling = scaling;
    gmsh.finalize();
  } catch (err) {
    out.error = err instanceof Error ? `${err.message}\n${err.stack}` : String(err);
  }
  (self as unknown as Worker).postMessage(out);
};
