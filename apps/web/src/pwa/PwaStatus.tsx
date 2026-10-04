// What the service worker has to tell the user, in one corner of the window: the first precache
// ("Saving for offline use", with progress), that the app now works offline, and that a new
// version is ready (offered only once autosave has flushed; updateFlow.ts), or that this tab
// should reload because another tab updated the app or a chunk failed to load (T7.4b). In the
// other corner, while the browser is offline, a small "Offline" note (OfflineIndicator.tsx).

import { useEffect } from 'react';
import { useStore } from 'zustand';
import type { StoreApi } from 'zustand/vanilla';
import { OfflineIndicator } from './OfflineIndicator';
import { useOnline } from './online';
import type { PwaStatus as PwaStatusState } from './register';
import type { UpdateFlow, UpdateReason } from './updateFlow';
import './pwa.css';

/** How long "Ready to work offline" stays up. */
export const OFFLINE_READY_MS = 6000;

const mb = (bytes: number) => (bytes / 1_000_000).toFixed(1);

/** What the Reload offer says, by why it is made. */
const READY_MESSAGES: Record<UpdateReason | 'waiting' | 'chunk-offline', string> = {
  waiting: 'A new version of manufakture is ready. Your changes are saved.',
  'other-tab':
    'manufakture was updated in another tab. Reload to use the new version here too; your changes are saved.',
  chunk:
    'Part of manufakture could not be loaded, most likely because the app was updated. Reload to continue; your changes are saved.',
  'chunk-offline':
    'Part of manufakture could not be loaded because you are offline. Reload once you are back online; your changes are saved.',
};

export function PwaStatus({
  flow,
  status,
}: {
  flow: UpdateFlow;
  status: StoreApi<PwaStatusState>;
}) {
  return (
    <>
      <OfflineIndicator />
      <StatusNote flow={flow} status={status} />
    </>
  );
}

function StatusNote({ flow, status }: { flow: UpdateFlow; status: StoreApi<PwaStatusState> }) {
  const update = useStore(flow.state);
  // A chunk that fails to load while offline is not a sign of an update.
  const online = useOnline();
  const { precache, offlineReady } = useStore(status);

  useEffect(() => {
    if (!offlineReady) return;
    const t = setTimeout(() => status.setState({ offlineReady: false }), OFFLINE_READY_MS);
    return () => clearTimeout(t);
  }, [offlineReady, status]);

  if (update.kind === 'ready' || update.kind === 'reloading') {
    return (
      <div
        className="pwa-status"
        role="status"
        data-testid="pwa-update"
        data-reason={update.reason ?? 'waiting'}
      >
        <span>
          {
            READY_MESSAGES[
              update.reason === 'chunk' && !online ? 'chunk-offline' : (update.reason ?? 'waiting')
            ]
          }
        </span>
        <button
          type="button"
          className="pwa-primary"
          disabled={update.kind === 'reloading'}
          onClick={() => void flow.reload()}
        >
          Reload
        </button>
        <button type="button" disabled={update.kind === 'reloading'} onClick={flow.dismiss}>
          Later
        </button>
      </div>
    );
  }
  if (update.kind === 'blocked') {
    return (
      <div className="pwa-status" role="status" data-testid="pwa-update">
        <span>{update.message}</span>
      </div>
    );
  }
  if (precache) {
    const percent = Math.min(100, Math.round((precache.loaded / precache.total) * 100));
    return (
      <div className="pwa-status" role="status" data-testid="pwa-precache">
        <span>
          Saving for offline use: {mb(precache.loaded)} of {mb(precache.total)} MB
        </span>
        <div
          className="pwa-bar"
          role="progressbar"
          aria-label="Saving for offline use"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
        >
          <div className="pwa-fill" style={{ width: `${percent}%` }} />
        </div>
      </div>
    );
  }
  if (offlineReady) {
    return (
      <div className="pwa-status" role="status" data-testid="pwa-offline-ready">
        <span>Ready to work offline.</span>
      </div>
    );
  }
  return null;
}
