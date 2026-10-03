// Representation A, one measurement per fresh Node process. The kernel's sources need Vite's
// resolver, so measure.ts bundles this file (dist/node/kernel-child.js) and runs
//   node dist/node/kernel-child.js <task> '<json args>'
// which prints its result as JSON on the last stdout line.

import { KernelService, type ShapeId } from '@manufakture/kernel';
import { nodeLoader } from '@manufakture/kernel/node';
import { heapInUse, occtAllocator } from '@manufakture/kernel/testing';
import { buildGroup } from '../src/brep.ts';
import { fixture, type FixtureName } from '../src/fixtures.ts';

type Args = Record<string, unknown>;
type Oc = Parameters<typeof occtAllocator>[0];
const round = (v: number, d = 1) => Math.round(v * 10 ** d) / 10 ** d;
const median = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  return s.length % 2 ? s[s.length >> 1]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};

async function service(config: { autoRecycle?: boolean } = {}) {
  const t0 = performance.now();
  const loader = await nodeLoader();
  let oc: Oc | null = null;
  const s = await KernelService.create({
    ...config,
    createInstance: async () => (oc = await loader.instantiate()),
  });
  return { service: s, oc: () => oc!, initMs: performance.now() - t0 };
}

/** Build every group once; returns the shapes per group. */
async function regenAll(s: KernelService, name: FixtureName, mesh = true) {
  const f = fixture(name);
  const shapes = new Map<string, ShapeId[]>();
  let triangles = 0;
  let transferBytes = 0;
  let transferMs = 0;
  let failed = 0;
  let ops = 0;
  const errors: string[] = [];
  const t0 = performance.now();
  for (const [group, members] of f.groups) {
    const g = await buildGroup(s, members, { mesh });
    shapes.set(group, g.shapes);
    triangles += g.triangles;
    transferBytes += g.transferBytes;
    transferMs += g.transferMs;
    failed += g.failed;
    errors.push(...g.errors);
    ops += g.ops;
  }
  const ms = performance.now() - t0;
  return {
    f,
    shapes,
    ms,
    triangles,
    transferBytes,
    transferMs,
    failed,
    ops,
    errors: errors.slice(0, 5),
  };
}

async function releaseAll(s: KernelService, shapes: Map<string, ShapeId[]>) {
  await s.release([...shapes.values()].flat());
}

const tasks: Record<string, (args: Args) => Promise<unknown>> = {
  /** Cold regen: module compile and instance in this fresh process, then every group. */
  async cold({ fixture: name }) {
    const { service: s, initMs } = await service({ autoRecycle: false });
    const r = await regenAll(s, name as FixtureName);
    const stats = s.stats();
    return {
      initMs: round(initMs),
      regenMs: round(r.ms),
      members: [...r.f.groups.values()].flat().length,
      ops: r.ops,
      failed: r.failed,
      errors: r.errors,
      triangles: r.triangles,
      transferMiB: round(r.transferBytes / 2 ** 20, 2),
      transferMs: round(r.transferMs),
      heapMiB: round(stats.heapBytes / 2 ** 20),
      liveShapes: stats.shapeCount,
    };
  },

  /** Warm regen: re-frame the wall whose opening moves, release its old bodies, mesh the new ones. */
  async warm({ fixture: name, runs }) {
    const { service: s } = await service({ autoRecycle: false });
    const r = await regenAll(s, name as FixtureName);
    const wall = r.f.dirty.wall;
    let current = r.shapes.get(wall)!;
    const times: number[] = [];
    let members = 0;
    for (let i = 0; i < (runs as number); i++) {
      const next = i % 2 === 0 ? r.f.regenDirty() : r.f.groups.get(wall)!;
      members = next.length;
      const t0 = performance.now();
      await s.release(current);
      const g = await buildGroup(s, next);
      times.push(performance.now() - t0);
      current = g.shapes;
    }
    return { wall, members, firstMs: round(times[0]!), medianMs: round(median(times)), runs };
  },

  /** T0.2 leak probe: N full regens (build, mesh, release) on a fresh instance, then probe once. */
  async leak({ fixture: name, n }) {
    const { service: s, oc } = await service({ autoRecycle: false });
    const t0 = performance.now();
    for (let i = 0; i < (n as number); i++) {
      const r = await regenAll(s, name as FixtureName);
      await releaseAll(s, r.shapes);
    }
    const ms = performance.now() - t0;
    const heapBytes = s.stats().heapBytes;
    return { n, ms: round(ms), heapBytes, usedBytes: heapInUse(occtAllocator(oc())) };
  },

  /** Full regens with the service's own recycling (1 GiB): how many fit, and what a recycle costs. */
  async recycle({ fixture: name, max }) {
    const { service: s } = await service();
    const events: Array<{ type: string; at: number; heapBytes?: number; ms?: number }> = [];
    s.onStatus((st) => {
      if (st.type === 'recycling')
        events.push({ type: st.type, at: performance.now(), heapBytes: st.heapBytes });
      if (st.type === 'recycled') events.push({ type: st.type, at: performance.now() });
    });
    const heap: number[] = [];
    const times: number[] = [];
    let regens = 0;
    for (; regens < (max as number); regens++) {
      const r = await regenAll(s, name as FixtureName);
      await releaseAll(s, r.shapes);
      times.push(r.ms);
      heap.push(round(s.stats().heapBytes / 2 ** 20));
      if (events.some((e) => e.type === 'recycled')) break;
      // Release does not wait for the next batch, so give the service an idle point.
      await s.idle();
      if (events.some((e) => e.type === 'recycled')) break;
    }
    const start = events.find((e) => e.type === 'recycling');
    const end = events.find((e) => e.type === 'recycled');
    return {
      regensBeforeRecycle: start ? regens + 1 : null,
      recycleMs: start && end ? round(end.at - start.at) : null,
      heapAtRecycleMiB: start?.heapBytes ? round(start.heapBytes / 2 ** 20) : null,
      heapTraceMiB: heap,
      medianRegenMs: round(median(times)),
    };
  },

  /** On demand: build every member's B-rep (no mesh), export one STEP file, release. */
  async ondemand({ fixture: name }) {
    const { service: s } = await service({ autoRecycle: false });
    const heap0 = s.stats().heapBytes;
    const r = await regenAll(s, name as FixtureName, false);
    const all = [...r.f.groups].flatMap(([g, ms]) => {
      const shapes = r.shapes.get(g)!;
      return shapes.map((shape, i) => ({ shape, name: `${g}:${ms[i]?.id ?? i}` }));
    });
    const t0 = performance.now();
    const reply = await s.run({ generation: 1e6, ops: [{ op: 'exportStep', bodies: all }] });
    const exportMs = performance.now() - t0;
    const res = reply.results[0]!;
    const bytes = res.ok ? (res.value as { data: Uint8Array }).data.byteLength : 0;
    const heap1 = s.stats().heapBytes;
    await releaseAll(s, r.shapes);
    return {
      bodies: all.length,
      buildMs: round(r.ms),
      exportMs: round(exportMs),
      stepMiB: round(bytes / 2 ** 20, 2),
      exportOk: res.ok,
      heapGrowthMiB: round((heap1 - heap0) / 2 ** 20),
      failed: r.failed,
    };
  },
};

const [task, json] = process.argv.slice(2);
const fn = task ? tasks[task] : undefined;
if (!fn) {
  console.error(`unknown task ${task}; one of ${Object.keys(tasks).join(', ')}`);
  process.exit(2);
}
const result = await fn(JSON.parse(json ?? '{}') as Args);
// Exit only once stdout is flushed: a pipe takes large results in several writes.
process.stdout.write(`${JSON.stringify(result)}\n`, () => process.exit(0));
