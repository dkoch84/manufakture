import { describe, expect, it, vi } from 'vitest';
import { SW_MESSAGE } from './policy';
import { applyWorkerMessage, createPwaStatus, shouldRegister } from './register';
import { flushAutosave, registerAutosave } from './saveGate';

describe('shouldRegister', () => {
  const base = { prod: true, e2e: false, optIn: false, supported: true };
  it('registers in production builds with service worker support', () => {
    expect(shouldRegister(base)).toBe(true);
    expect(shouldRegister({ ...base, supported: false })).toBe(false);
  });
  it('never registers under vite dev', () => {
    expect(shouldRegister({ ...base, prod: false })).toBe(false);
    expect(shouldRegister({ ...base, prod: false, optIn: true })).toBe(false);
  });
  it('registers in the end-to-end build only when a test opts in', () => {
    expect(shouldRegister({ ...base, e2e: true })).toBe(false);
    expect(shouldRegister({ ...base, e2e: true, optIn: true })).toBe(true);
  });
});

describe('applyWorkerMessage', () => {
  it('tracks precache progress, then says the app is ready offline', () => {
    const status = createPwaStatus();
    applyWorkerMessage(status, { type: SW_MESSAGE.progress, loaded: 10, total: 100 });
    expect(status.getState()).toEqual({
      precache: { loaded: 10, total: 100 },
      offlineReady: false,
    });
    applyWorkerMessage(status, { type: SW_MESSAGE.progress, loaded: 100, total: 100 });
    expect(status.getState()).toEqual({ precache: null, offlineReady: true });
  });
  it('ignores other and malformed messages', () => {
    const status = createPwaStatus();
    applyWorkerMessage(status, null);
    applyWorkerMessage(status, { type: 'other', loaded: 1, total: 2 });
    applyWorkerMessage(status, { type: SW_MESSAGE.progress, loaded: '1', total: 2 });
    expect(status.getState()).toEqual({ precache: null, offlineReady: false });
  });
});

describe('save gate', () => {
  it('flushes the registered autosave, and succeeds with none', async () => {
    expect(await flushAutosave()).toBe(true);
    let calls = 0;
    const unregister = registerAutosave({
      flush: () => {
        calls++;
        return Promise.resolve(false);
      },
    });
    expect(await flushAutosave()).toBe(false);
    expect(calls).toBe(1);
    unregister();
    expect(await flushAutosave()).toBe(true);
  });
  it('an old registration cannot unregister a newer one', async () => {
    const first = registerAutosave({ flush: () => Promise.resolve(true) });
    const second = registerAutosave({ flush: () => Promise.resolve(false) });
    first();
    expect(await flushAutosave()).toBe(false);
    second();
  });
});

describe('afterStartup', () => {
  it('waits for the app to start, or for the fallback', async () => {
    vi.useFakeTimers();
    try {
      const { afterStartup, markStartupDone } = await import('./startup');
      let fellBack = false;
      void afterStartup(1000).then(() => (fellBack = true));
      await vi.advanceTimersByTimeAsync(999);
      expect(fellBack).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(fellBack).toBe(true);
      markStartupDone();
      let started = false;
      void afterStartup(60_000).then(() => (started = true));
      await vi.advanceTimersByTimeAsync(0);
      expect(started).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
