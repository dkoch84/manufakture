// The worker engine: each session's regen engine and kernel in a worker thread of its own. A
// session runs on it as on the in-process engine; a regen that does not stop when cancelled ends
// its worker, and a kernel whose heap passed the threshold is replaced by a new worker.

import { createDocument } from '@manufakture/core';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkerEngine } from './engine';
import type { Session } from './session';
import { PART, shedDocument } from './test/fixtures';
import { ok, seeded } from './test/setup';

const open: Session[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.close()));
});

describe('the worker engine', () => {
  it('runs a session on the shed, and rolls back a regen it had to end', async () => {
    const seed = await seeded(shedDocument(), { engine: 'worker' });
    const s = ok(await seed.manager.open({ documentId: seed.documentId, clientName: 'Worker' }));
    open.push(s);
    expect(seed.manager.limits.sessionsPerProcess).toBe(4);
    const info = await s.info();
    expect([info.engine, info.kernelReplaced]).toEqual(['worker', 0]);
    const tree = ok(await s.tree());
    expect(tree.parts[0]!.features.every((f) => f.status === 'ok')).toBe(true);
    const walls = ok(await s.findGeometry({ normal: [0, -1, 0], limit: 5 }));
    expect(walls.length).toBeGreaterThan(0);

    const door = s.document.parts[0]!.features.find((f) => f.id === 'extension#7')!;
    const move = (inches: number) => ({
      type: 'editFeature',
      partId: PART,
      feature: {
        ...door,
        expressions: {
          ...(door as { expressions: Record<string, unknown> }).expressions,
          position: { source: String(inches), lengthUnit: 'in', angleUnit: 'deg' },
        },
      },
    });
    // A regen given 1 ms, and 1 ms to stop: the worker is terminated and a new one started.
    seed.manager.limits.regenMsPerBatch = 1;
    seed.manager.limits.regenStopMs = 1;
    const r = await s.apply({ label: 'Move the door', commands: [move(60)] });
    seed.manager.limits.regenMsPerBatch = 30_000;
    seed.manager.limits.regenStopMs = 5_000;
    expect(r).toEqual({ ok: false, error: expect.objectContaining({ code: 'regen-timeout' }) });
    expect((await s.info()).revision).toBe(1);
    expect((await s.info()).kernelReplaced).toBeGreaterThanOrEqual(1);
    // The new worker serves the session as before.
    const again = ok(await s.apply({ label: 'Move the door', commands: [move(60)] }));
    expect(again.revision).toBe(2);
    expect(again.errors).toEqual([]);
    const q = ok(await s.quantities());
    expect(q.takeoffs).toHaveLength(1);
    // Two workers started, two full regens of the shed and a terminate: several seconds alone,
    // far more on a loaded machine.
  }, 180_000);

  it('is replaced by a new worker once its heap passes the threshold', async () => {
    // Below the first instance's 128 MiB: replaced at the first check.
    const engine = await WorkerEngine.start({ heapThresholdBytes: 64 * 1024 * 1024 });
    try {
      expect(await engine.wantsRestart()).toBe(true);
      const old = engine.api;
      await engine.restart();
      expect(engine.replaced).toBe(1);
      expect(engine.api).not.toBe(old);
      // The terminated worker answers no more; the new one does.
      await expect(async () => old.stats()).rejects.toThrow();
      const r = await engine.api.regen(createDocument({ id: 'd', name: 'D' }), { generation: 1 });
      expect(r?.parts).toHaveLength(1);
    } finally {
      await engine.close();
    }
  }, 120_000);
});
