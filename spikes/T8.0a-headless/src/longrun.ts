// A thousand batches per fixture in one session each, as an agent's long session would be: every
// batch an edit whose value never repeats (so regen builds rather than serving its cache), applied,
// regenerated, measured and saved. Each fixture gets a fresh kernel service at the default recycle
// threshold (512 MiB), so its recycles are its own. Records time per batch, the kernel's wasm heap,
// resident memory, recycles, and what the library keeps on disk; then reopens the branch and checks
// that it regenerates to exactly what the session held.
//
// The bracket starts with its engraved text (the heaviest feature it has: laying the text out and
// cutting it), so every batch rebuilds the text cut too.
//
// Each `longrun-*.test.ts` runs one fixture in its own process. LONG_RUN_BATCHES (default 1000).
// Writes results/longrun-<fixture>.json.

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from 'vitest';
import { engraveBatch, longRunBatch, type FixtureName } from './fixtures';
import { nodeHost } from './host';
import { nodeSummary } from './node-summary';
import { libraryAt, openFixture } from './open';
import { MiB, memory, round, writeResult } from './results';
import { HeadlessSession, PLAN_LIMITS } from './session';
import { compareSummaries } from './summary';

const N = Number(process.env.LONG_RUN_BATCHES ?? 1000);

function du(dir: string): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) {
      const d = du(p);
      files += d.files;
      bytes += d.bytes;
    } else {
      files++;
      bytes += s.size;
    }
  }
  return { files, bytes };
}

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!);
};

export async function longRun(name: FixtureName): Promise<void> {
  const host = await nodeHost();
  const recycleEvents: { batch: number; heapBefore: number; heapAfter: number; ms: number }[] = [];
  let batch = 0;
  host.service.onStatus((s) => {
    if (s.type === 'recycled') {
      recycleEvents.push({
        batch,
        heapBefore: MiB(s.heapBytesBefore),
        heapAfter: MiB(s.heapBytesAfter),
        ms: round(s.ms),
      });
    }
  });
  const o = await openFixture(name, {
    host,
    dir: `longrun-${name}`,
    sessionId: `long-${name}`,
    limits: { ...PLAN_LIMITS, batchesPerSession: N + 10 },
  });
  const { session } = o;
  if (name === 'bracket') expect((await session.apply(engraveBatch('MFK-1'))).ok).toBe(true);
  const total: number[] = [];
  const regen: number[] = [];
  const save: number[] = [];
  const trace: { batch: number; heapMiB: number; rssMiB: number; liveShapes: number }[] = [];
  const failures: string[] = [];
  const t0 = performance.now();
  for (batch = 1; batch <= N; batch++) {
    const r = await session.apply(longRunBatch(name, session.document, batch));
    if (!r.ok) {
      failures.push(`${batch}: ${r.code}: ${r.message}`);
      continue;
    }
    if (r.errors.length > 0) failures.push(`${batch}: ${r.errors.join('; ')}`);
    total.push(r.ms.total);
    regen.push(r.ms.regen);
    save.push(r.ms.save);
    if (batch % 25 === 0 || batch === 1) {
      const s = host.service.stats();
      trace.push({
        batch,
        heapMiB: MiB(s.heapBytes),
        rssMiB: MiB(process.memoryUsage().rss),
        liveShapes: s.shapeCount,
      });
    }
  }
  const wallMs = performance.now() - t0;
  const head = session.document;
  const before = await nodeSummary({ ...host }, head);
  await session.close();
  const disk = du(o.root);

  // Reopen the branch from disk and check it regenerates to the same thing.
  const again = libraryAt(o.root);
  const t = performance.now();
  const { session: resumed } = await HeadlessSession.open(
    { library: again.library, root: o.root, ...host },
    head.id,
    { sessionId: `long2-${name}`, resume: session.branch },
  );
  const reopenMs = performance.now() - t;
  expect(resumed.document).toEqual(head);
  const after = await nodeSummary({ ...host }, resumed.document);
  const differences = compareSummaries(before.summary, after.summary);
  await resumed.close();

  writeResult(`longrun-${name}`, {
    batches: N,
    wallMs: round(wallMs),
    perBatchMs: {
      total: {
        p50: pct(total, 50),
        p90: pct(total, 90),
        p99: pct(total, 99),
        max: pct(total, 100),
      },
      regen: {
        p50: pct(regen, 50),
        p90: pct(regen, 90),
        p99: pct(regen, 99),
        max: pct(regen, 100),
      },
      save: { p50: pct(save, 50), p90: pct(save, 90), p99: pct(save, 99), max: pct(save, 100) },
    },
    recycles: recycleEvents,
    engine: session.engine.stats,
    trace,
    memoryAtEnd: memory(),
    disk: { ...disk, MiB: MiB(disk.bytes), operations: o.backend.counts },
    reopenMs: round(reopenMs),
    reopenDifferences: differences,
    failures,
  });
  expect(failures).toEqual([]);
  expect(differences).toEqual([]);
}
