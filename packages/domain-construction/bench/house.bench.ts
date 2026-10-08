// The T6.5d house bench (M6 plan, Part 3 "T6.5d"): the 2,000 sq ft house of
// `src/fixtures/house.ts` regenerated with the real features, kernel and Manifold in Node, against
// the budgets the T6.5a spike set (docs/spikes/T6.5a-framing.md, "4. Budgets for T6.5d"). It fails
// when a median is over its budget.
//
//   make bench-house          (or: vitest run --config packages/domain-construction/bench/vitest.config.ts)
//
// Each cold sample and each leak probe runs in a fresh Node process (this file again, through
// Vitest, with HOUSE_BENCH_TASK set), as the spike measured them: a cold regen in a warm process
// would be faster than a page load's, and the heap probe disturbs the allocator. The warm regens
// run in this process. Results are printed as `BENCH` lines and a table, and written as JSON to
// HOUSE_BENCH_RESULTS when that is set.
//
// Environment: HOUSE_BENCH_COLD_RUNS (default 5), HOUSE_BENCH_WARM_RUNS (41),
// HOUSE_BENCH_LEAK_N (`10,60`; `0` skips the probe).

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { cpus } from 'node:os';
import { DEFAULT_HEAP_THRESHOLD } from '@manufakture/kernel';
import { describe, expect, it } from 'vitest';
import {
  HOUSE_BUDGETS,
  cold,
  leak,
  median,
  percentile,
  warm,
  type ColdSample,
  type LeakSample,
} from './measure';

const TASK = process.env.HOUSE_BENCH_TASK;
const HERE = dirname(fileURLToPath(import.meta.url));
const MiB = 1024 * 1024;
const r2 = (v: number) => Math.round(v * 100) / 100;

const count = (name: string, fallback: number) => {
  const v = Number(process.env[name] ?? fallback);
  return Number.isFinite(v) && v >= 0 ? Math.floor(v) : fallback;
};

/** Run one task in a fresh Node process: this file through Vitest, its result read from a file. */
async function child<T>(task: string): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'house-bench-'));
  const out = join(dir, 'result.json');
  try {
    const vitest = join(
      dirname(createRequire(import.meta.url).resolve('vitest/package.json')),
      'vitest.mjs',
    );
    await promisify(execFile)(
      process.execPath,
      [vitest, 'run', '--config', join(HERE, 'vitest.config.ts'), '--reporter=dot'],
      {
        env: { ...process.env, HOUSE_BENCH_TASK: task, HOUSE_BENCH_OUT: out },
        maxBuffer: 16 * MiB,
      },
    );
    return JSON.parse(await readFile(out, 'utf8')) as T;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

if (TASK !== undefined) {
  // A child: one measurement, written where the parent reads it.
  it(`task ${TASK}`, async () => {
    const [name, arg] = TASK.split(':');
    const result =
      name === 'cold' ? await cold() : name === 'leak' ? await leak(Number(arg)) : null;
    if (result === null) throw new Error(`unknown task ${TASK}`);
    await writeFile(process.env.HOUSE_BENCH_OUT!, JSON.stringify(result));
  }, 600_000);
} else {
  describe('the house bench', () => {
    it('regenerates the house within the T6.5a budgets', async () => {
      const coldRuns = Math.max(1, count('HOUSE_BENCH_COLD_RUNS', 5));
      const warmRuns = Math.max(1, count('HOUSE_BENCH_WARM_RUNS', 41));
      const leakN = (process.env.HOUSE_BENCH_LEAK_N ?? '10,60')
        .split(',')
        .map(Number)
        .filter((n) => Number.isInteger(n) && n > 0);

      const colds: ColdSample[] = [];
      for (let i = 0; i < coldRuns; i++) colds.push(await child<ColdSample>('cold'));
      const w = await warm(warmRuns);
      const leaks: LeakSample[] = [];
      for (const n of leakN) leaks.push(await child<LeakSample>(`leak:${n}`));

      const first = colds[0]!;
      const [l0, l1] = [leaks[0], leaks.at(-1)];
      const perRegenBytes =
        leaks.length >= 2 ? (l1!.heapInUse - l0!.heapInUse) / (l1!.n - l0!.n) : null;
      const m = (f: (c: ColdSample) => number) => r2(median(colds.map(f)));
      const report = {
        cpu: cpus()[0]?.model ?? 'unknown',
        node: process.version,
        fixture: {
          members: first.members,
          roles: first.roles,
          groups: first.groups,
          shapes: first.shapes,
          bodies: first.bodies,
          meshKiB: r2(first.meshBytes / 1024),
          matrixKiB: r2(first.matrixBytes / 1024),
        },
        cold: {
          runs: coldRuns,
          instanceStartMs: m((c) => c.instanceStartMs),
          regenMs: m((c) => c.regenMs),
          regenMaxMs: r2(Math.max(...colds.map((c) => c.regenMs))),
          framingMs: m((c) => c.framingMs),
          framingMaxMs: r2(Math.max(...colds.map((c) => c.framingMs))),
        },
        warm: {
          runs: warmRuns,
          regenMs: r2(median(w.regenMs)),
          regenP95Ms: r2(percentile(w.regenMs, 95)),
          framingMs: r2(median(w.framingMs)),
          framingP95Ms: r2(percentile(w.framingMs, 95)),
          movedWallMs: r2(median(w.movedGroupMs)),
          reframedGroups: median(w.reframed),
          rebuiltFeatures: median(w.rebuilt),
        },
        memory: leaks.map((l) => ({
          n: l.n,
          heapInUseMiB: r2(l.heapInUse / MiB),
          heapMiB: r2(l.heapBytes / MiB),
          instance: l.instance,
          msPerRegen: r2(l.msPerRegen),
        })),
        perRegenMiB: perRegenBytes === null ? null : r2(perRegenBytes / MiB),
        budgets: HOUSE_BUDGETS,
      };
      const perRegen = report.perRegenMiB;
      // Regens from the first probe's heap to the kernel's recycle threshold, as
      // apps/web/bench/memory.bench.ts counts them.
      const regensToRecycle =
        perRegenBytes !== null && perRegenBytes > 0
          ? Math.floor((DEFAULT_HEAP_THRESHOLD - l0!.heapInUse) / perRegenBytes)
          : null;

      console.log(`BENCH house ${JSON.stringify({ ...report, regensToRecycle })}`);
      console.log(
        [
          `House bench on ${report.cpu}, Node ${report.node}: ${first.members} members, ` +
            `${first.groups} groups, ${first.shapes} shapes, ${first.bodies} layer bodies`,
          `| Measure                        | Median   | Budget   |`,
          `| ------------------------------ | -------- | -------- |`,
          `| Framing, cold                  | ${report.cold.framingMs} ms | ${HOUSE_BUDGETS.framingCold} ms |`,
          `| Framing, warm (move a window)  | ${report.warm.framingMs} ms | ${HOUSE_BUDGETS.framingWarm} ms |`,
          `| Whole regen, cold              | ${report.cold.regenMs} ms | ${HOUSE_BUDGETS.regenCold} ms |`,
          `| Whole regen, warm              | ${report.warm.regenMs} ms | ${HOUSE_BUDGETS.regenWarm} ms |`,
          `| Kernel instance start          | ${report.cold.instanceStartMs} ms | excluded |`,
          `| Kernel heap per full regen     | ${perRegen ?? '-'} MiB | ${regensToRecycle ?? '-'} regens to ${DEFAULT_HEAP_THRESHOLD / MiB} MiB |`,
        ].join('\n'),
      );
      const out = process.env.HOUSE_BENCH_RESULTS;
      if (out) await writeFile(out, JSON.stringify({ ...report, regensToRecycle }, null, 2) + '\n');

      // The fixture is the house the budgets are for: within Part 1's 800 to 1,000 members.
      expect(first.members).toBeGreaterThanOrEqual(700);
      expect(first.members).toBeLessThanOrEqual(1_000);
      for (const c of colds) expect(c.manifoldDeleted).toBe(c.manifoldCreated);
      // A warm regen after moving a window re-frames its wall's group only.
      expect(median(w.reframed)).toBe(1);
      expect(Math.min(...w.rebuilt), 'a warm regen rebuilds the moved window').toBeGreaterThan(0);
      // The budgets, on medians; soft, so one run reports every budget it misses.
      expect.soft(report.cold.framingMs, 'framing, cold').toBeLessThan(HOUSE_BUDGETS.framingCold);
      expect.soft(report.warm.framingMs, 'framing, warm').toBeLessThan(HOUSE_BUDGETS.framingWarm);
      expect.soft(report.cold.regenMs, 'whole regen, cold').toBeLessThan(HOUSE_BUDGETS.regenCold);
      expect.soft(report.warm.regenMs, 'whole regen, warm').toBeLessThan(HOUSE_BUDGETS.regenWarm);
      // The probe is void if the instance recycled under it.
      for (const l of leaks) expect(l.instance, `leak probe N = ${l.n}`).toBe(1);
    }, 1_800_000);
  });
}
