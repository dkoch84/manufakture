import { afterEach, describe, expect, it, vi } from 'vitest';
import { SW_MESSAGE } from './policy';
import {
  applyWorkerMessage,
  createPwaStatus,
  registerServiceWorker,
  shouldRegister,
} from './register';
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

// A service worker container, registration and workers, as far as register.ts uses them.
class FakeWorker extends EventTarget {
  state: ServiceWorkerState = 'installing';
  postMessage = vi.fn();
  to(state: ServiceWorkerState) {
    this.state = state;
    this.dispatchEvent(new Event('statechange'));
  }
}
class FakeRegistration extends EventTarget {
  installing: FakeWorker | null = null;
  waiting: FakeWorker | null = null;
  update = vi.fn(async () => undefined);
}
class FakeContainer extends EventTarget {
  controller: object | null;
  registration = new FakeRegistration();
  register = vi.fn(async () => this.registration);
  startMessages() {}
  constructor(controlled: boolean) {
    super();
    this.controller = controlled ? {} : null;
  }
  /** A worker takes control (another tab's Reload, or the first install's clientsClaim). */
  claim() {
    this.controller = {};
    this.dispatchEvent(new Event('controllerchange'));
  }
}

function withContainer(controlled: boolean) {
  const container = new FakeContainer(controlled);
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: container });
  const onUpdate = vi.fn();
  const onTakeover = vi.fn();
  const reloadPage = vi.fn();
  const registered = registerServiceWorker({
    status: createPwaStatus(),
    base: '/',
    onUpdate,
    onTakeover,
    reloadPage,
  });
  return { container, registered, onUpdate, onTakeover, reloadPage };
}

describe('registerServiceWorker: version skew', () => {
  afterEach(() => {
    Reflect.deleteProperty(navigator, 'serviceWorker');
  });

  it('a new worker taking over a controlled page it did not ask for offers Reload', async () => {
    const { container, registered, onTakeover } = withContainer(true);
    await registered.registration;
    container.claim();
    expect(onTakeover).toHaveBeenCalledTimes(1);
  });

  it("the tab's own Reload reloads it and is not a takeover", async () => {
    const { container, registered, onTakeover, reloadPage } = withContainer(true);
    const reg = container.registration;
    const next = new FakeWorker();
    next.state = 'installed';
    reg.waiting = next;
    await registered.registration;
    registered.activate();
    expect(next.postMessage).toHaveBeenCalledWith({ type: SW_MESSAGE.skipWaiting });
    container.claim();
    expect(reloadPage).toHaveBeenCalledTimes(1);
    expect(onTakeover).not.toHaveBeenCalled();
  });

  it('the first install taking control of the page is not a takeover', async () => {
    const { container, registered, onTakeover } = withContainer(false);
    await registered.registration;
    container.claim();
    expect(onTakeover).not.toHaveBeenCalled();
    // A later update from another tab is.
    container.claim();
    expect(onTakeover).toHaveBeenCalledTimes(1);
  });

  it('checkForUpdate: asks the host, waits for the install, and reports a waiting worker', async () => {
    const { container, registered, onUpdate } = withContainer(true);
    const reg = container.registration;
    const next = new FakeWorker();
    reg.update.mockImplementation(async () => {
      reg.installing = next;
    });
    const checked = registered.checkForUpdate();
    await vi.waitFor(() => expect(reg.update).toHaveBeenCalled());
    reg.installing = null;
    reg.waiting = next;
    next.to('installed');
    expect(await checked).toBe('ready');
    expect(onUpdate).toHaveBeenCalled();
    // Asked again (after Later, say): offered again, without another download.
    onUpdate.mockClear();
    expect(await registered.checkForUpdate()).toBe('ready');
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(reg.update).toHaveBeenCalledTimes(1);
  });

  it('checkForUpdate: nothing newer, or the host out of reach', async () => {
    const { container, registered } = withContainer(true);
    expect(await registered.checkForUpdate()).toBe('none');
    container.registration.update.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    expect(await registered.checkForUpdate()).toBe('offline');
    // A browser that says it is offline is not even asked to try.
    const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    expect(await registered.checkForUpdate()).toBe('offline');
    expect(container.registration.update).toHaveBeenCalledTimes(2);
    onLine.mockRestore();
  });

  it('checkForUpdate: no worker when registering failed', async () => {
    const container = new FakeContainer(false);
    container.register.mockRejectedValueOnce(new Error('denied'));
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: container });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const registered = registerServiceWorker({
      status: createPwaStatus(),
      base: '/',
      onUpdate: vi.fn(),
    });
    expect(await registered.checkForUpdate()).toBe('no-worker');
    warn.mockRestore();
  });
});
