// The kernel memory bench (docs/research/end-of-m1-checkpoints.md): how much wasm heap a regen of
// each acceptance model leaves behind, and how many regens fit under the recycle threshold
// (`DEFAULT_HEAP_THRESHOLD`, ADR 0002). Not part of `vitest run`: it spawns a process per
// measurement and takes a few minutes.
//
//   make bench-memory      (or: pnpm --filter @manufakture/web bench:memory)
//
// Each measurement runs in a fresh Node process (this file again, with MEMORY_BENCH_TASK set):
// n regens on a fresh kernel instance, then the heap probe once (`models.ts`). The leak per regen
// is the difference between two n over the regens between them.
//
// It fails when a model leaks more per full regen than `SWITCH_LEAK_BYTES`: the condition, set by
// the end-of-M1 checkpoint (ADR 0001), for no longer living with recycling alone.
//
// Environment: MEMORY_BENCH_MODELS (default every model), MEMORY_BENCH_N (`2,12`),
// MEMORY_BENCH_EDITS (`1`; `0` skips the edit runs).

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { DEFAULT_HEAP_THRESHOLD } from '@manufakture/kernel';
import { describe, expect, it } from 'vitest';
import { MODELS, edit, full, type Sample } from './models';

/** Above this leak per full regen of an acceptance model, recycling alone is not enough. */
export const SWITCH_LEAK_BYTES = 8 * 1024 * 1024;

const TASK = process.env.MEMORY_BENCH_TASK;
const HERE = dirname(fileURLToPath(import.meta.url));
const KiB = 1024;
const MiB = 1024 * 1024;

async function child(task: string): Promise<Sample> {
  const dir = await mkdtemp(join(tmpdir(), 'memory-bench-'));
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
        env: { ...process.env, MEMORY_BENCH_TASK: task, MEMORY_BENCH_OUT: out },
        maxBuffer: 16 * MiB,
      },
    );
    return JSON.parse(await readFile(out, 'utf8')) as Sample;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const median = (xs: readonly number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const h = s.length >> 1;
  return s.length % 2 ? s[h]! : (s[h - 1]! + s[h]!) / 2;
};

if (TASK !== undefined) {
  it(`task ${TASK}`, async () => {
    const [mode, model, n] = TASK.split(':');
    const sample = mode === 'edit' ? await edit(model!, Number(n)) : await full(model!, Number(n));
    await writeFile(process.env.MEMORY_BENCH_OUT!, JSON.stringify(sample));
  }, 1_800_000);
} else {
  describe('the kernel memory bench', () => {
    it('measures the leak per regen of every acceptance model', async () => {
      const models = (process.env.MEMORY_BENCH_MODELS ?? Object.keys(MODELS).join(','))
        .split(',')
        .filter((m) => m in MODELS);
      const ns = (process.env.MEMORY_BENCH_N ?? '2,12').split(',').map(Number);
      expect(ns.length === 2 && ns[0]! > 0 && ns[1]! > ns[0]!, 'MEMORY_BENCH_N: two n').toBe(true);
      const edits = process.env.MEMORY_BENCH_EDITS !== '0';

      const rows: string[] = [];
      const leaks: Record<string, number> = {};
      for (const model of models) {
        const modes: Sample['mode'][] = edits && MODELS[model]!.edit ? ['full', 'edit'] : ['full'];
        for (const mode of modes) {
          const [a, b] = [
            await child(`${mode}:${model}:${ns[0]}`),
            await child(`${mode}:${model}:${ns[1]}`),
          ];
          for (const s of [a, b]) {
            expect(s.instance, `${model} ${mode} n = ${s.n}: no recycle`).toBe(1);
            expect(s.liveShapes, `${model} ${mode} n = ${s.n}: every shape released`).toBe(0);
          }
          const perRegen = (b.heapInUse - a.heapInUse) / (b.n - a.n);
          if (mode === 'full') leaks[model] = perRegen;
          const toThreshold =
            perRegen > 0 ? Math.floor((DEFAULT_HEAP_THRESHOLD - a.heapInUse) / perRegen) : Infinity;
          rows.push(
            `| ${MODELS[model]!.name} | ${mode} | ${mode === 'full' ? Math.round(a.ms[0]!) : '-'} | ` +
              `${Math.round(median(b.ms))} | ${Math.round(perRegen / KiB)} | ${toThreshold} |`,
          );
          console.log(`BENCH ${JSON.stringify({ model, mode, perRegen, samples: [a, b] })}`);
        }
      }
      console.log(
        [
          `Kernel memory, threshold ${DEFAULT_HEAP_THRESHOLD / MiB} MiB, n = ${ns.join(' and ')}:`,
          '',
          '| Model | Regen | Cold ms | Median ms | Leak per regen, KiB | Regens to threshold |',
          '| ----- | ----- | ------- | --------- | ------------------- | ------------------- |',
          ...rows,
        ].join('\n'),
      );
      for (const [model, perRegen] of Object.entries(leaks)) {
        expect(perRegen, `${model}: leak per full regen`).toBeLessThan(SWITCH_LEAK_BYTES);
      }
    }, 3_600_000);
  });
}
