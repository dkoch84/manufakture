// One measurement in a fresh Node process. Prints JSON on its last line.
//
//   node scripts/node-child.ts <task> '<json args>'
//
// Tasks:
//   init      load one build, timed by phase
//   timing    run the scenario: a first run, then `runs` more; per-phase times
//   calls     the per-call probe (box, volume, release) n times, repeated
//   leak      run the scenario n times, then measure bytes in use
//   replicadBoxes  replicad's two box idioms: makeBaseBox (a sketched rectangle,
//             extruded) against makeBox (BRepPrimAPI_MakeBox), alone and filleted
//
// Run with --expose-gc so the leak task can force collection in `gc` mode.

import { FACTORIES } from '../src/candidates/index.ts';
import type { CandidateName, RunOptions, RunResult } from '../src/candidates/types.ts';
import {
  loadLibcascade,
  loadOcctWasm,
  loadReplicadOc,
  type BuildName,
  type LoadTimings,
} from '../src/loaders.ts';
import type { ScenarioTimings } from '../src/scenario.ts';
import { round, summarize } from './lib.ts';

type Args = Record<string, unknown>;

const LOADERS: Record<
  BuildName,
  () => Promise<{ timings: LoadTimings; heap: { memory: WebAssembly.Memory } }>
> = {
  libcascade: loadLibcascade,
  'replicad-opencascadejs': loadReplicadOc,
  'occt-wasm': loadOcctWasm,
};

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Force a full GC and give FinalizationRegistry callbacks a chance to run. */
async function collect(): Promise<void> {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (!gc) throw new Error('run with --expose-gc');
  for (let i = 0; i < 3; i++) {
    gc();
    await tick();
  }
}

const tasks: Record<string, (args: Args) => Promise<unknown>> = {
  async replicadBoxes({ n, runs }) {
    const replicad = await import('replicad');
    replicad.setOC((await loadReplicadOc()).module);
    const variants = {
      makeBaseBox: (x: number, y: number, z: number) => replicad.makeBaseBox(x, y, z),
      makeBox: (x: number, y: number, z: number) => replicad.makeBox([0, 0, 0], [x, y, z]),
    };
    const out: Record<string, unknown> = {};
    for (const [name, make] of Object.entries(variants)) {
      const loop = () => {
        for (let i = 0; i < (n as number); i++) {
          const b = make(10, 10, 10);
          replicad.measureVolume(b);
          b.delete();
        }
      };
      loop();
      const perIterationUs: number[] = [];
      for (let r = 0; r < 5; r++) {
        const t0 = performance.now();
        loop();
        perIterationUs.push(((performance.now() - t0) * 1000) / (n as number));
      }
      const filletMs: number[] = [];
      for (let r = 0; r <= (runs as number); r++) {
        const b = make(40, 30, 20);
        const t0 = performance.now();
        const f = b.fillet(2);
        if (r > 0) filletMs.push(performance.now() - t0);
        f.delete();
        b.delete();
      }
      out[name] = {
        boxVolumeDeleteUs: summarize(perIterationUs),
        filletAll12EdgesMs: summarize(filletMs),
      };
    }
    return out;
  },

  async init({ build }) {
    const loaded = await LOADERS[build as BuildName]();
    const t = loaded.timings;
    return {
      ...Object.fromEntries(Object.entries(t).map(([k, v]) => [k, round(v)])),
      heapBytesAfterInit: loaded.heap.memory.buffer.byteLength,
    };
  },

  async timing({ candidate, options, runs }) {
    const c = await FACTORIES[candidate as CandidateName]();
    const opts = options as RunOptions;
    const first = c.run(opts);
    const results: RunResult[] = [];
    for (let i = 0; i < (runs as number); i++) results.push(c.run(opts));
    const phase = (k: keyof ScenarioTimings) => summarize(results.map((r) => r.timings[k]));
    return {
      candidate,
      options: opts,
      firstRunMs: round(first.timings.totalMs),
      filletMs: phase('filletMs'),
      cutMs: phase('cutMs'),
      meshMs: phase('meshMs'),
      queryMs: phase('queryMs'),
      totalMs: phase('totalMs'),
      report: first.report,
    };
  },

  async calls({ candidate, n, repeats }) {
    const c = await FACTORIES[candidate as CandidateName]();
    c.boxLoop(n as number); // warm-up
    const perCallUs: number[] = [];
    for (let i = 0; i < (repeats as number); i++) {
      const t0 = performance.now();
      c.boxLoop(n as number);
      perCallUs.push(((performance.now() - t0) * 1000) / (n as number));
    }
    return { candidate, n, perIterationUs: summarize(perCallUs) };
  },

  async leak({ candidate, options, n, mode }) {
    const c = await FACTORIES[candidate as CandidateName]();
    const opts = options as RunOptions;
    for (let i = 0; i < (n as number); i++) {
      c.run(opts);
      if (mode === 'gc') await collect();
    }
    // In `sync` mode nothing yields until here, as in a tight regen loop in a
    // worker: FinalizationRegistry callbacks cannot have run.
    return {
      candidate,
      mode,
      n,
      heapBytes: c.heapBytes(),
      liveHandles: c.liveHandles(),
      usedBytes: c.usedHeapBytes(),
    };
  },
};

const [task, json] = process.argv.slice(2);
const fn = tasks[task ?? ''];
if (!fn) throw new Error(`unknown task ${task}`);
console.log(JSON.stringify(await fn(JSON.parse(json ?? '{}') as Args)));
process.exit(0);
