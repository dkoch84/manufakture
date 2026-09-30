import { describe, expect, it, vi } from 'vitest';
import { twoFaces } from '../measure/fixtures';
import type { MeasureOutcome, Measurer } from '../measure/measurer';
import { createMeasureStore, type MeasureRequest } from './measure';

const request = (targets = 2, revision = 1): MeasureRequest => ({
  bodyId: 'b',
  targets: Array.from({ length: targets }, (_, i) => ({ kind: 'face' as const, index: i + 1 })),
  revision,
});

/** A measurer whose replies the test releases by hand. */
function manualMeasurer() {
  const pending: ((o: MeasureOutcome | null) => void)[] = [];
  const measurer: Measurer = {
    measure: vi.fn(() => new Promise<MeasureOutcome | null>((resolve) => pending.push(resolve))),
  };
  return { measurer, pending };
}

describe('the measure store', () => {
  it('measures a request, always with the body, and keeps the result', async () => {
    const store = createMeasureStore();
    const m = manualMeasurer();
    const done = store.getState().measure(m.measurer, request());
    expect(store.getState().status).toBe('measuring');
    expect(m.measurer.measure).toHaveBeenCalledWith('b', request().targets, true);
    m.pending[0]!({ ok: true, result: twoFaces() });
    await done;
    expect(store.getState()).toMatchObject({ status: 'ready', error: null });
    expect(store.getState().result?.distance?.value).toBe(20);
  });

  it('does not measure the same request twice, but does after the bodies change', async () => {
    const store = createMeasureStore();
    const measurer: Measurer = {
      measure: vi.fn(async () => ({ ok: true as const, result: twoFaces() })),
    };
    await store.getState().measure(measurer, request());
    await store.getState().measure(measurer, request());
    expect(measurer.measure).toHaveBeenCalledTimes(1);
    await store.getState().measure(measurer, request(2, 2));
    expect(measurer.measure).toHaveBeenCalledTimes(2);
  });

  it('drops a reply that arrives after a newer request', async () => {
    const store = createMeasureStore();
    const m = manualMeasurer();
    const first = store.getState().measure(m.measurer, request(1));
    const second = store.getState().measure(m.measurer, request(2));
    m.pending[1]!({ ok: true, result: twoFaces() });
    await second;
    const late = { ...twoFaces(), distance: null };
    m.pending[0]!({ ok: true, result: late });
    await first;
    expect(store.getState().result?.distance?.value).toBe(20);
    expect(store.getState().request).toEqual(request(2));
  });

  it('reports errors, both returned and thrown', async () => {
    const store = createMeasureStore();
    await store
      .getState()
      .measure({ measure: async () => ({ ok: false, message: 'unknown shape id 4' }) }, request());
    expect(store.getState()).toMatchObject({ status: 'error', error: 'unknown shape id 4' });
    await store.getState().measure(
      {
        measure: async () => {
          throw new Error('worker gone');
        },
      },
      request(),
    );
    expect(store.getState()).toMatchObject({ status: 'error', error: 'worker gone', result: null });
  });

  it('is unavailable without a measurer, idle for no request, and idle again when superseded', async () => {
    const store = createMeasureStore();
    await store.getState().measure(null, request());
    expect(store.getState().status).toBe('unavailable');
    await store.getState().measure(null, null);
    expect(store.getState()).toMatchObject({ status: 'idle', request: null, result: null });
    await store.getState().measure({ measure: async () => null }, request());
    // Superseded by an edit: nothing is kept, so the same request is measured again later.
    expect(store.getState()).toMatchObject({ status: 'idle', request: null });
  });

  it('measures every body of a request as a whole, reusing the main body', async () => {
    const store = createMeasureStore();
    const volumes: Record<string, number> = { a: 10, b: 20, c: 30 };
    const measurer: Measurer = {
      measure: vi.fn(async (bodyId: string) => {
        if (bodyId === 'c') return { ok: false as const, message: 'no such body' };
        const result = twoFaces();
        return {
          ok: true as const,
          result: { ...result, body: { ...result.body!, volume: volumes[bodyId]! } },
        };
      }),
    };
    await store
      .getState()
      .measure(measurer, { ...request(0), bodyId: 'a', bodies: ['a', 'b', 'c'] });
    expect(measurer.measure).toHaveBeenCalledTimes(3);
    expect(measurer.measure).toHaveBeenCalledWith('b', [], true);
    const s = store.getState();
    expect(s.status).toBe('ready');
    expect(s.bodies.map((b) => [b.bodyId, b.body?.volume ?? null, b.error ?? null])).toEqual([
      ['a', 10, null],
      ['b', 20, null],
      ['c', null, 'no such body'],
    ]);
    await store.getState().measure(measurer, null);
    expect(store.getState().bodies).toEqual([]);
  });
});
