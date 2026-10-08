// Cold start of a session in a fresh process (each `cold-*.test.ts` is its own Vitest file, so its
// own child process): load the code, compile and instantiate the kernel, open the fixture on a new
// agent branch with its first full regen, then the first batch and ten more. Resident memory is
// read at each step. Writes results/cold-<fixture>.json.

import { expect } from 'vitest';
import type { FixtureName } from './fixtures';
import { memory, round, writeResult } from './results';

export async function coldStart(name: FixtureName): Promise<void> {
  const processMs = performance.now();
  const base = memory();
  let t = performance.now();
  // Dynamic imports, so loading the code (core, regen, the domains, the kernel's glue) is timed.
  const [{ nodeHost }, { openFixture }, fixtures] = await Promise.all([
    import('./host'),
    import('./open'),
    import('./fixtures'),
  ]);
  const importMs = performance.now() - t;
  const afterImport = memory();
  t = performance.now();
  const host = await nodeHost();
  const kernelMs = performance.now() - t;
  const afterKernel = memory();
  t = performance.now();
  const o = await openFixture(name, { host, dir: `cold-${name}` });
  const openMs = performance.now() - t;
  const afterOpen = memory();
  const first = await o.session.apply(
    name === 'bracket'
      ? fixtures.engraveBatch('MFK-1')
      : fixtures.longRunBatch(name, o.session.document, 0),
  );
  expect(first.ok).toBe(true);
  const next: number[] = [];
  for (let i = 1; i <= 10; i++) {
    const r = await o.session.apply(fixtures.longRunBatch(name, o.session.document, i));
    expect(r.ok).toBe(true);
    if (r.ok) next.push(r.ms.total);
  }
  const afterBatches = memory();
  await o.session.close();
  writeResult(`cold-${name}`, {
    note: 'ms; memory in MiB (rss, V8 heap used, external, array buffers) after a full GC',
    sinceProcessStartMs: round(processMs),
    importMs: round(importMs),
    kernelServiceMs: round(kernelMs),
    open: {
      totalMs: round(openMs),
      steps: Object.fromEntries(Object.entries(o.ms).map(([k, v]) => [k, round(v)])),
    },
    firstBatch: first.ok
      ? Object.fromEntries(Object.entries(first.ms).map(([k, v]) => [k, round(v)]))
      : first,
    nextTenBatchesMs: next.map((x) => round(x)),
    coldToFirstRegenMs: round(importMs + kernelMs + openMs),
    kernelHeapMiB: round(host.service.stats().heapBytes / 2 ** 20),
    memory: { base, afterImport, afterKernel, afterOpen, afterBatches },
  });
}
