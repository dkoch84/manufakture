// The installable, offline app (T7.4a): starts the service worker in production builds and
// returns the stores PwaStatus shows. See register.ts for when it registers, updateFlow.ts for
// the update flow and sw/sw.ts for the worker itself; docs/hosting.md for hosting and the kill
// switch, docs/user/install.md for users.
//
// Offline behaviour (T7.4b): persistent storage is asked for at install (persistence.ts); a tab
// that another tab's update took over, or whose chunk failed to load, is offered Reload (skew.ts,
// updateFlow.ts); and "update the app" is available to whatever finds this version too old
// (appUpdate.ts, UpdateNeeded.tsx).

import type { StoreApi } from 'zustand/vanilla';
import { setAppUpdater } from './appUpdate';
import { askPersistenceAtInstall } from './persistence';
import {
  createPwaStatus,
  registerServiceWorker,
  shouldRegister,
  type PwaStatus,
  type Registered,
} from './register';
import { flushAutosave } from './saveGate';
import { watchChunkErrors } from './skew';
import { afterStartup } from './startup';
import { createUpdateFlow, type UpdateFlow } from './updateFlow';

export interface Pwa {
  flow: UpdateFlow;
  status: StoreApi<PwaStatus>;
}

/** Start the service worker if this build and browser should have one; null otherwise. */
export function startPwa(): Pwa | null {
  const register = shouldRegister({
    prod: import.meta.env.PROD,
    e2e: import.meta.env.VITE_E2E === '1',
    optIn: window.__manufakturePwaOptIn === true,
    supported: 'serviceWorker' in navigator,
  });
  if (!register) return null;
  const status = createPwaStatus();
  let registered: Registered | null = null;
  const flow = createUpdateFlow({
    flush: flushAutosave,
    activate: () => registered?.activate(),
  });
  /** Register the worker (once). */
  const start = (): Registered =>
    (registered ??= registerServiceWorker({
      status,
      base: import.meta.env.BASE_URL,
      onUpdate: () => flow.updateFound(),
      onTakeover: () => flow.tookOver(),
    }));
  // Asking for an update registers at once if the app has not started yet (a refused document
  // can send the user to the home screen before the kernel is up).
  setAppUpdater({ flow, check: () => start().checkForUpdate() });
  watchChunkErrors(window, () => flow.chunkFailed());
  askPersistenceAtInstall();
  // Once the app has started (startup.ts), so the precache never downloads the kernel a second
  // time while the kernel worker is still fetching it; that download shows its progress on the
  // splash, and the precache that follows reads it from the HTTP cache.
  void afterStartup().then(start);
  return { flow, status };
}
