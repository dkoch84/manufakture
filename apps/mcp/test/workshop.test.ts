// The workshop's deadlines: a call over its work limit is answered with the timeout at once, but
// keeps its engine and kernel until its work has settled, and the next call waits for that. Work
// that never settles has its kernel dropped, and the next call gets a new one.

import { RegenEngine } from '@manufakture/regen';
import { bracketDocument } from '@manufakture/session/test-fixtures';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNodeService, STDERR_OUTPUT } from '@manufakture/kernel/node';
import { MAX_STUCK, Workshop, WorkshopBusy, WorkshopTimeout } from '../src/workshop';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const open: Workshop[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(open.splice(0).map((w) => w.close()));
});

describe('the workshop', () => {
  it('answers a late call at once, and holds the kernel until its work has settled', async () => {
    const workshop = new Workshop({ stopMs: 10_000 });
    open.push(workshop);
    const doc = bracketDocument();
    const marks: string[] = [];
    vi.spyOn(RegenEngine.prototype, 'dispose').mockImplementation(async function () {
      marks.push('dispose');
    });
    let late = 0;
    const first = workshop.run(
      doc,
      60_000,
      async (bench) => {
        await sleep(400);
        // The engine and kernel are still this call's: nothing disposed or recycled under it.
        marks.push(`work done, ${bench.result.parts.length} part`);
        late = bench.kernel.stats().instance;
        return 'finished';
      },
      { workMs: 50 },
    );
    const second = workshop.run(doc, 60_000, async (bench) => {
      marks.push('second');
      return bench.kernel.stats().instance;
    });
    const t0 = performance.now();
    await expect(first).rejects.toMatchObject({ name: 'WorkshopTimeout', stage: 'work', ms: 50 });
    // Answered at the deadline, not when the work ended.
    expect(marks).toEqual([]);
    const instance = await second;
    expect(performance.now() - t0).toBeGreaterThan(300);
    expect(marks).toEqual(['work done, 1 part', 'dispose', 'second', 'dispose']);
    // The work stopped in time: the kernel is kept.
    expect(instance).toBe(late);
    expect(workshop.stats().dropped).toBe(0);
  }, 120_000);

  it('drops the kernel of work that never settles, and the next call gets a new one', async () => {
    const workshop = new Workshop({ stopMs: 100 });
    open.push(workshop);
    const doc = bracketDocument();
    const kernels: unknown[] = [];
    const stuck = workshop.run(
      doc,
      60_000,
      (bench) => {
        kernels.push(bench.kernel);
        return new Promise<never>(() => undefined);
      },
      { workMs: 50 },
    );
    await expect(stuck).rejects.toBeInstanceOf(WorkshopTimeout);
    const next = await workshop.run(doc, 60_000, async (bench) => {
      kernels.push(bench.kernel);
      return bench.result.parts.length;
    });
    expect(next).toBe(1);
    expect(kernels).toHaveLength(2);
    expect(kernels[1]).not.toBe(kernels[0]);
    expect(workshop.stats().dropped).toBe(1);
  }, 120_000);

  it('caps dropped kernels still running, answering busy, and lets each go once it settles', async () => {
    const workshop = new Workshop({ stopMs: 50 });
    open.push(workshop);
    const doc = bracketDocument();
    const disposed = vi.spyOn(RegenEngine.prototype, 'dispose');
    const releases: (() => void)[] = [];
    for (let i = 0; i < MAX_STUCK; i++) {
      const stuck = workshop.run(
        doc,
        60_000,
        () => new Promise<void>((resolve) => releases.push(resolve)),
        { workMs: 20 },
      );
      await expect(stuck).rejects.toBeInstanceOf(WorkshopTimeout);
    }
    // Each is dropped `stopMs` after its answer.
    await vi.waitFor(() =>
      expect(workshop.stats()).toEqual({ dropped: MAX_STUCK, stuck: MAX_STUCK }),
    );
    const calls = disposed.mock.calls.length;
    // Beyond the cap a call is not started at all.
    await expect(workshop.run(doc, 60_000, async () => 'no')).rejects.toBeInstanceOf(WorkshopBusy);
    // One settles: its engine is disposed and it no longer counts.
    releases[0]!();
    await vi.waitFor(() => expect(workshop.stats().stuck).toBe(MAX_STUCK - 1));
    expect(disposed.mock.calls.length).toBe(calls + 1);
    expect(await workshop.run(doc, 60_000, async () => 'served')).toBe('served');
    releases[1]!();
    await vi.waitFor(() => expect(workshop.stats().stuck).toBe(0));
  }, 120_000);

  it('does not keep a kernel that failed to load: the next call loads it again', async () => {
    let attempts = 0;
    const workshop = new Workshop({
      createKernel: () => {
        attempts++;
        return attempts === 1
          ? Promise.reject(new Error('no wasm'))
          : createNodeService({ autoRecycle: false, output: STDERR_OUTPUT });
      },
    });
    open.push(workshop);
    await expect(workshop.run(bracketDocument(), 60_000, async () => 'x')).rejects.toThrow(
      'no wasm',
    );
    expect(await workshop.run(bracketDocument(), 60_000, async () => 'loaded')).toBe('loaded');
    expect(attempts).toBe(2);
  }, 120_000);

  it('answers a regen over its limit with the regen timeout', async () => {
    const workshop = new Workshop();
    open.push(workshop);
    const r = workshop.run(bracketDocument(), 0, async () => 'never');
    await expect(r).rejects.toMatchObject({ name: 'WorkshopTimeout', stage: 'regen' });
    // The workshop serves the next call.
    expect(await workshop.run(bracketDocument(), 60_000, async () => 'ok')).toBe('ok');
  }, 120_000);
});
