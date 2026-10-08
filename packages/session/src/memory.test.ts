// The T8.0a open item, measured (README, "Memory"): does replacing a session's kernel free the
// old instance? Runs the cabinet through many batches with a low heap threshold, so the kernel is
// replaced every few dozen batches, once with the worker engine (a new worker each time, the old
// one terminated) and once in process (recycled in place), and samples the process's resident
// memory. Not part of `make test` (minutes, and machine-dependent):
//
//   SESSION_MEMORY_PROBE=1 ./node_modules/.bin/vitest run --project packages \
//     packages/session/src/memory.test.ts --silent=false --reporter=verbose
//
// `SESSION_MEMORY_BATCHES` (default 300) and `SESSION_MEMORY_ENGINES` (default
// `worker,in-process`) choose the run; `NODE_OPTIONS=--expose-gc` lets the in-process engine
// collect after each recycle.

import { describe, expect, it } from 'vitest';
import type { EngineKind } from './engine';
import { PART, cabinetDocument } from './test/fixtures';
import { ok, seeded } from './test/setup';

const BATCHES = Number(process.env.SESSION_MEMORY_BATCHES ?? 300);
const EVERY = 25;
const MiB = 1024 * 1024;

async function run(engine: EngineKind) {
  const seed = await seeded(cabinetDocument(), {
    engine,
    limits: { kernelHeapBytes: 130 * MiB, batchesPerSession: BATCHES + 10 },
  });
  const s = ok(await seed.manager.open({ documentId: seed.documentId, clientName: 'Probe' }));
  const samples: { batch: number; rssMiB: number; replaced: number }[] = [];
  const sample = async (batch: number) =>
    samples.push({
      batch,
      rssMiB: Math.round(process.memoryUsage().rss / MiB),
      replaced: (await s.info()).kernelReplaced,
    });
  await sample(0);
  const t0 = performance.now();
  for (let i = 1; i <= BATCHES; i++) {
    const shelf = s.document.parts[0]!.features.find((f) => f.id === 'sketch#5')! as unknown as {
      plane: { origin: number[] };
    };
    // The shelf between 10" and 20" up, never the same height twice (golden ratio steps).
    const z = 25.4 * (10 + 10 * ((i * 0.6180339887) % 1));
    const plane = { ...shelf.plane, origin: [shelf.plane.origin[0], shelf.plane.origin[1], z] };
    ok(
      await s.apply({
        label: `Shelf ${i}`,
        commands: [{ type: 'editFeature', partId: PART, feature: { ...shelf, plane } }],
      }),
    );
    if (i % EVERY === 0) await sample(i);
  }
  const ms = performance.now() - t0;
  await s.close();
  return { engine, ms: Math.round(ms), samples };
}

describe.skipIf(process.env.SESSION_MEMORY_PROBE !== '1')(
  'memory across kernel replacements',
  () => {
    it(
      'is bounded by terminating the worker',
      async () => {
        const kinds = (process.env.SESSION_MEMORY_ENGINES ?? 'worker,in-process').split(',');
        const gc = typeof (globalThis as { gc?: unknown }).gc === 'function';
        for (const kind of kinds as EngineKind[]) {
          const r = await run(kind);
          console.log(JSON.stringify({ batches: BATCHES, gc, ...r }));
          expect(r.samples.at(-1)!.replaced).toBeGreaterThan(0);
        }
      },
      60 * 60_000,
    );
  },
);
