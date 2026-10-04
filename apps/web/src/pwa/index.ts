// The installable, offline app (T7.4a): starts the service worker in production builds and
// returns the stores PwaStatus shows. See register.ts for when it registers, updateFlow.ts for
// the update flow and sw/sw.ts for the worker itself; docs/hosting.md for hosting and the kill
// switch, docs/user/install.md for users.

import type { StoreApi } from 'zustand/vanilla';
import { createPwaStatus, registerServiceWorker, shouldRegister, type PwaStatus } from './register';
import { flushAutosave } from './saveGate';
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
  let activate = () => undefined as void;
  const flow = createUpdateFlow({ flush: flushAutosave, activate: () => activate() });
  // Once the app has started (startup.ts), so the precache never downloads the kernel a second
  // time while the kernel worker is still fetching it; that download shows its progress on the
  // splash, and the precache that follows reads it from the HTTP cache.
  void afterStartup().then(() => {
    const registered = registerServiceWorker({
      status,
      base: import.meta.env.BASE_URL,
      onUpdate: () => flow.updateFound(),
    });
    activate = () => registered.activate();
  });
  return { flow, status };
}
