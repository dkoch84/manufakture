import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BLOCKED_MESSAGE, createUpdateFlow, type UpdateFlow } from './updateFlow';

/** A flush whose results the test hands out one by one. */
function controlledFlush() {
  const calls: ((saved: boolean) => void)[] = [];
  const flush = vi.fn(() => new Promise<boolean>((resolve) => calls.push(resolve)));
  return { flush, resolve: (saved: boolean) => calls.shift()!(saved) };
}

describe('update flow', () => {
  let flow: UpdateFlow;
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    flow?.stop();
    vi.useRealTimers();
  });

  it('flushes autosave before it offers Reload', async () => {
    const f = controlledFlush();
    const activate = vi.fn();
    flow = createUpdateFlow({ flush: f.flush, activate });
    expect(flow.state.getState()).toEqual({ kind: 'idle' });
    flow.updateFound();
    expect(flow.state.getState()).toEqual({ kind: 'saving' });
    expect(f.flush).toHaveBeenCalledTimes(1);
    f.resolve(true);
    await vi.waitFor(() => expect(flow.state.getState()).toEqual({ kind: 'ready' }));
    expect(activate).not.toHaveBeenCalled();
  });

  it('holds the offer back while saving fails, and retries', async () => {
    const f = controlledFlush();
    flow = createUpdateFlow({ flush: f.flush, activate: vi.fn(), retryMs: 1000 });
    flow.updateFound();
    f.resolve(false);
    await vi.waitFor(() =>
      expect(flow.state.getState()).toEqual({ kind: 'blocked', message: BLOCKED_MESSAGE }),
    );
    expect(f.flush).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.flush).toHaveBeenCalledTimes(2);
    f.resolve(true);
    await vi.waitFor(() => expect(flow.state.getState()).toEqual({ kind: 'ready' }));
  });

  it('treats a flush that throws as not saved', async () => {
    flow = createUpdateFlow({
      flush: () => Promise.reject(new Error('disk full')),
      activate: vi.fn(),
    });
    flow.updateFound();
    await vi.waitFor(() => expect(flow.state.getState().kind).toBe('blocked'));
  });

  it('Reload flushes again, then activates the waiting worker', async () => {
    const f = controlledFlush();
    const activate = vi.fn();
    flow = createUpdateFlow({ flush: f.flush, activate });
    flow.updateFound();
    f.resolve(true);
    await vi.waitFor(() => expect(flow.state.getState().kind).toBe('ready'));
    const done = flow.reload();
    expect(flow.state.getState()).toEqual({ kind: 'reloading' });
    expect(f.flush).toHaveBeenCalledTimes(2);
    expect(activate).not.toHaveBeenCalled();
    f.resolve(true);
    await done;
    expect(activate).toHaveBeenCalledTimes(1);
  });

  it('a change that cannot be saved at Reload keeps the old version', async () => {
    const f = controlledFlush();
    const activate = vi.fn();
    flow = createUpdateFlow({ flush: f.flush, activate, retryMs: 1000 });
    flow.updateFound();
    f.resolve(true);
    await vi.waitFor(() => expect(flow.state.getState().kind).toBe('ready'));
    const done = flow.reload();
    f.resolve(false);
    await done;
    expect(activate).not.toHaveBeenCalled();
    expect(flow.state.getState().kind).toBe('blocked');
    await vi.advanceTimersByTimeAsync(1000);
    f.resolve(true);
    await vi.waitFor(() => expect(flow.state.getState().kind).toBe('ready'));
  });

  it('Reload does nothing before the offer', async () => {
    const f = controlledFlush();
    const activate = vi.fn();
    flow = createUpdateFlow({ flush: f.flush, activate });
    await flow.reload();
    flow.updateFound();
    await flow.reload();
    expect(activate).not.toHaveBeenCalled();
    expect(f.flush).toHaveBeenCalledTimes(1);
  });

  it('Later puts the offer away until the next update, and a late flush changes nothing', async () => {
    const f = controlledFlush();
    flow = createUpdateFlow({ flush: f.flush, activate: vi.fn() });
    flow.updateFound();
    flow.dismiss();
    f.resolve(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(flow.state.getState()).toEqual({ kind: 'dismissed' });
    flow.updateFound();
    expect(flow.state.getState()).toEqual({ kind: 'saving' });
  });

  it('a second update found while one is in progress starts nothing new', () => {
    const f = controlledFlush();
    flow = createUpdateFlow({ flush: f.flush, activate: vi.fn() });
    flow.updateFound();
    flow.updateFound();
    expect(f.flush).toHaveBeenCalledTimes(1);
  });

  it('stop ends the retries', async () => {
    const f = controlledFlush();
    flow = createUpdateFlow({ flush: f.flush, activate: vi.fn(), retryMs: 1000 });
    flow.updateFound();
    f.resolve(false);
    await vi.waitFor(() => expect(flow.state.getState().kind).toBe('blocked'));
    flow.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.flush).toHaveBeenCalledTimes(1);
  });
});
