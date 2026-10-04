// The task list both harnesses run: the browser worker (scripts/browser.ts) and Node
// (scripts/measure.ts). Each task returns plain data.

import type { KernelService } from '@manufakture/kernel';
import * as bench from './bench';
import { ASYNC_VARIANTS, SYNC_VARIANTS, VARIANT_NAMES } from './variants';

export const TASKS = [
  'load',
  'hostCalls',
  'asyncCalls',
  'kernel',
  'interrupts',
  'memory',
  'memoryUnbounded',
  'stack',
  'values',
  'instances',
  'asyncify',
  'arithmetic',
  'determinism',
  'globals',
] as const;
export type Task = (typeof TASKS)[number] | 'all';

export async function runTasks(
  env: bench.BenchEnv,
  tasks: readonly Task[],
  kernel: () => Promise<KernelService>,
): Promise<Record<string, unknown>> {
  const wanted = new Set<string>(
    tasks.includes('all') ? TASKS.filter((t) => t !== 'memoryUnbounded') : tasks,
  );
  const out: Record<string, unknown> = {};
  const run = async (task: string, fn: () => Promise<unknown>) => {
    if (!wanted.has(task)) return;
    const t0 = env.now();
    try {
      out[task] = await fn();
    } catch (e) {
      out[task] = { failed: e instanceof Error ? e.message : String(e) };
    }
    out[`${task}Ms`] = Math.round(env.now() - t0);
  };
  await run('load', async () => {
    const r = [];
    for (const name of VARIANT_NAMES) r.push(await bench.measureLoad(env, name));
    return r;
  });
  await run('hostCalls', async () => {
    const r = [];
    for (const name of SYNC_VARIANTS) r.push(await bench.measureHostCalls(env, name));
    return r;
  });
  await run('asyncCalls', async () => {
    const r = [];
    for (const name of ASYNC_VARIANTS) r.push(await bench.measureAsyncCalls(env, name));
    return r;
  });
  await run('kernel', async () => {
    const t0 = env.now();
    const service = await kernel();
    const kernelLoadMs = Math.round(env.now() - t0);
    return { kernelLoadMs, sessions: await bench.measureKernelSession(env, service) };
  });
  await run('interrupts', async () => {
    const r: Record<string, unknown> = {};
    for (const name of SYNC_VARIANTS) r[name] = await bench.measureInterrupts(env, name);
    return r;
  });
  await run('memory', async () => {
    const r: Record<string, unknown> = {};
    for (const name of SYNC_VARIANTS) {
      r[name] = {
        report: await bench.memoryReport(env, name),
        memoryMaximum: await bench.measureMemoryLimits(env, name, 'memory-maximum'),
      };
    }
    return r;
  });
  // QuickJS's own limit alone, with the instance free to grow to 2 GiB: a separate task, since
  // a browser may kill the page when the worker's memory grows that far.
  await run('memoryUnbounded', async () => {
    const r: Record<string, unknown> = {};
    for (const name of SYNC_VARIANTS) {
      r[name] = await bench.measureMemoryLimits(env, name, 'setMemoryLimit', 64, (c) =>
        env.log?.(`memory case done: ${JSON.stringify(c)}`),
      );
    }
    return r;
  });
  await run('stack', async () => {
    const r: Record<string, unknown> = {};
    for (const name of SYNC_VARIANTS) r[name] = await bench.measureStackLimits(env, name);
    return r;
  });
  await run('values', () => bench.measureValueSizes(env, 'quickjs-sync'));
  await run('instances', async () => {
    const r = [];
    for (const name of VARIANT_NAMES) r.push(await bench.measureInstances(env, name));
    return r;
  });
  await run('asyncify', async () => {
    const r: Record<string, unknown> = {};
    for (const name of ASYNC_VARIANTS) r[name] = await bench.measureAsyncifyIsolation(env, name);
    return r;
  });
  await run('arithmetic', async () => {
    const r = [];
    for (const name of SYNC_VARIANTS) {
      r.push(await bench.measureArithmetic(env, name, 10_000, 31));
      r.push(await bench.measureArithmetic(env, name, 1_000_000, 5));
    }
    return r;
  });
  await run('determinism', () => bench.determinismOutputs(env));
  await run('globals', () => bench.globalSurface(env, 'quickjs-sync'));
  return out;
}
