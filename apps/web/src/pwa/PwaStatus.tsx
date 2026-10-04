// What the service worker has to tell the user, in one corner of the window: the first precache
// ("Saving for offline use", with progress), that the app now works offline, and that a new
// version is ready (offered only once autosave has flushed; updateFlow.ts).

import { useEffect } from 'react';
import { useStore } from 'zustand';
import type { StoreApi } from 'zustand/vanilla';
import type { PwaStatus as PwaStatusState } from './register';
import type { UpdateFlow } from './updateFlow';
import './pwa.css';

/** How long "Ready to work offline" stays up. */
export const OFFLINE_READY_MS = 6000;

const mb = (bytes: number) => (bytes / 1_000_000).toFixed(1);

export function PwaStatus({
  flow,
  status,
}: {
  flow: UpdateFlow;
  status: StoreApi<PwaStatusState>;
}) {
  const update = useStore(flow.state);
  const { precache, offlineReady } = useStore(status);

  useEffect(() => {
    if (!offlineReady) return;
    const t = setTimeout(() => status.setState({ offlineReady: false }), OFFLINE_READY_MS);
    return () => clearTimeout(t);
  }, [offlineReady, status]);

  if (update.kind === 'ready' || update.kind === 'reloading') {
    return (
      <div className="pwa-status" role="status" data-testid="pwa-update">
        <span>A new version of manufakture is ready. Your changes are saved.</span>
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
