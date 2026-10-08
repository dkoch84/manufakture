// The long run's resident memory climbs to several GiB (longrun-*.json, `trace`) although the
// kernel recycles at 512 MiB. This probe asks why: the same bracket session for 1,000 batches,
// with a full collection forced every 100 batches, reading memory before and after it and whether
// each recycled kernel instance is still reachable (a WeakRef per instance). Writes
// results/gc.json.

import { expect, it } from 'vitest';
import { engraveBatch, longRunBatch } from './fixtures';
import { nodeHost } from './host';
import { openFixture } from './open';
import { MiB, memory, writeResult } from './results';

const N = Number(process.env.LONG_RUN_BATCHES ?? 1000);

it('a recycled kernel instance is collectable, but only a full collection returns it', async () => {
  const host = await nodeHost();
  const kernels: WeakRef<object>[] = [];
  // The service's current kernel (a private field), so the probe can tell when an old one is gone.
  const service = host.service as unknown as { current: object };
  kernels.push(new WeakRef(service.current));
  host.service.onStatus((s) => {
    if (s.type === 'recycled') kernels.push(new WeakRef(service.current));
  });
  const o = await openFixture('bracket', { host, dir: 'gc' });
  expect((await o.session.apply(engraveBatch('MFK-1'))).ok).toBe(true);
  const rows: unknown[] = [];
  for (let i = 1; i <= N; i++) {
    expect((await o.session.apply(longRunBatch('bracket', o.session.document, i))).ok).toBe(true);
    if (i % 100 === 0) {
      const raw = process.memoryUsage();
      const after = memory();
      rows.push({
        batch: i,
        wasmHeapMiB: MiB(host.service.stats().heapBytes),
        beforeGc: { rss: MiB(raw.rss), heapUsed: MiB(raw.heapUsed) },
        afterGc: { rss: after.rss, heapUsed: after.heapUsed },
        recycles: o.session.recycles,
        // One digit per kernel instance so far, oldest first: 1 still reachable, 0 collected.
        instancesAlive: kernels.map((k) => (k.deref() ? 1 : 0)).join(''),
      });
    }
  }
  await o.session.close();
  writeResult('gc', { batches: N, fixture: 'bracket (engraved)', rows });
});
