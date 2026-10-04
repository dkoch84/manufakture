// The Sync button in the app's header next to Share (App.tsx), once the controller is up
// (start.ts, called by main.tsx).

import { useEffect, useState } from 'react';
import type { SyncController } from './controller';
import { SyncPanel } from './SyncPanel';

/** The Sync button, once the controller is up. */
export function SyncRoot({ sync }: { sync: Promise<SyncController> }) {
  const [controller, setController] = useState<SyncController | null>(null);
  useEffect(() => {
    let live = true;
    sync.then(
      (c) => {
        if (live) setController(c);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [sync]);
  return controller ? <SyncPanel controller={controller} /> : null;
}
