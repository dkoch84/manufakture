// Starting sync with the app (main.tsx): one controller for the app's document store and
// library, and (only where the test hooks are on) the hook the end-to-end test reads:
// `window.__manufakture.sync`.

import type { DocumentLibrary } from '../persistence/library';
import type { DocumentStoreApi } from '../state/document';
import { testHooksEnabled } from '../testHooks';
import { SyncController } from './controller';

/** Starts syncing the documents `documents` shows, once the library is open. */
export function startSync(
  documents: DocumentStoreApi,
  library: Promise<DocumentLibrary>,
): Promise<SyncController> {
  return library.then((lib) => {
    const controller = new SyncController({ documents, library: lib });
    controller.start();
    if (testHooksEnabled && typeof window !== 'undefined') {
      window.__manufakture = {
        ...window.__manufakture,
        sync: {
          state: () => controller.state.getState(),
          clientId: () => controller.loop?.client.clientId ?? null,
          pending: () => controller.loop?.client.pending ?? [],
          confirmedRevision: () => controller.loop?.client.confirmedRevision ?? null,
          enable: () => controller.enable(),
          openFromServer: (id: string) => controller.openFromServer(id),
          library: lib,
        },
      };
    }
    return controller;
  });
}
