// Registering the service worker (sw/sw.ts) and wiring it to the update flow and the install
// progress shown by PwaStatus.
//
// When it registers:
// - Production builds, in browsers with service workers. Never under `vite dev`: the worker is
//   only emitted by `vite build`, and `import.meta.env.PROD` keeps this code from running there.
// - In the end-to-end build (VITE_E2E=1) only when a test opts in by defining
//   `window.__manufakturePwaOptIn = true` before the page loads (offline.spec.ts). Every other
//   spec runs in a fresh browser context, so an always-on worker would precache about 53 MB in
//   the background of every test, racing the performance budgets (perf.spec.ts, m*-budget) and
//   the kernel's own first download, and would answer requests the specs intercept with
//   `page.route`. The opt-in keeps those specs exactly as they were.

import { createStore, type StoreApi } from 'zustand/vanilla';
import { SW_MESSAGE } from './policy';

export interface PrecacheProgress {
  loaded: number;
  total: number;
}

export interface PwaStatus {
  /** Install progress of the first precache, while it runs; null otherwise. */
  precache: PrecacheProgress | null;
  /** The precache just finished: the app now opens offline. */
  offlineReady: boolean;
}

export function createPwaStatus(): StoreApi<PwaStatus> {
  return createStore<PwaStatus>()(() => ({ precache: null, offlineReady: false }));
}

declare global {
  interface Window {
    /** End-to-end builds only: register the service worker (see the comment above). */
    __manufakturePwaOptIn?: boolean;
  }
}

export interface RegisterConditions {
  prod: boolean;
  e2e: boolean;
  optIn: boolean;
  supported: boolean;
}

/** Whether to register the worker at all (see the comment at the top). */
export function shouldRegister(c: RegisterConditions): boolean {
  if (!c.prod || !c.supported) return false;
  return !c.e2e || c.optIn;
}

/** Apply a message from the worker to the status store. */
export function applyWorkerMessage(status: StoreApi<PwaStatus>, data: unknown): void {
  const m = data as { type?: unknown; loaded?: unknown; total?: unknown } | null;
  if (m?.type !== SW_MESSAGE.progress) return;
  if (typeof m.loaded !== 'number' || typeof m.total !== 'number') return;
  const done = m.total > 0 && m.loaded >= m.total;
  status.setState({
    precache: done ? null : { loaded: m.loaded, total: m.total },
    offlineReady: done || status.getState().offlineReady,
  });
}

export interface RegisterOptions {
  status: StoreApi<PwaStatus>;
  /** A new worker is installed and waits (the update flow's `updateFound`). */
  onUpdate: () => void;
  /** The worker's URL and scope, from Vite's base. */
  base: string;
  /** How often an open tab asks for a new version, besides on every navigation. */
  checkEveryMs?: number;
}

export interface Registered {
  /** Make the waiting worker take over; the page reloads once it has. */
  activate(): void;
  /** The registration, or null when registering failed. */
  registration: Promise<ServiceWorkerRegistration | null>;
}

/** Register the worker and watch for updates. */
export function registerServiceWorker(options: RegisterOptions): Registered {
  const { status, onUpdate, base, checkEveryMs = 60 * 60 * 1000 } = options;
  const container = navigator.serviceWorker;
  let waiting: ServiceWorker | null = null;
  let takingOver = false;

  container.addEventListener('message', (e) => applyWorkerMessage(status, e.data));
  container.startMessages();
  // The waiting worker took over because the user chose Reload: load the new version. (The first
  // install also changes the controller, from none, and must not reload.)
  container.addEventListener('controllerchange', () => {
    if (takingOver) window.location.reload();
  });

  const found = (worker: ServiceWorker) => {
    waiting = worker;
    onUpdate();
  };
  /** An installing worker becomes an update once installed, if a worker already controls us. */
  const watch = (worker: ServiceWorker) => {
    worker.addEventListener('statechange', () => {
      if (worker.state === 'installed' && container.controller) found(worker);
    });
  };

  const registration = (async () => {
    let reg: ServiceWorkerRegistration;
    try {
      // `updateViaCache: 'none'`: the browser always revalidates sw.js itself, so a fix (or the
      // kill switch) reaches users on their next navigation whatever the host's cache headers say.
      reg = await container.register(`${base}sw.js`, { scope: base, updateViaCache: 'none' });
    } catch (e) {
      console.warn('Service worker registration failed; the app works, but not offline.', e);
      return null;
    }
    if (reg.waiting && container.controller) found(reg.waiting);
    if (reg.installing) watch(reg.installing);
    reg.addEventListener('updatefound', () => {
      if (reg.installing) watch(reg.installing);
    });
    const check = () => void reg.update().catch(() => undefined);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') check();
    });
    setInterval(check, checkEveryMs);
    return reg;
  })();

  return {
    activate() {
      if (!waiting) return;
      takingOver = true;
      waiting.postMessage({ type: SW_MESSAGE.skipWaiting });
    },
    registration,
  };
}
