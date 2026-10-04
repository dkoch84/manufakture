// A small "Offline" note in the bottom left corner while the browser reports no network (T7.4b).
// The app works the same offline (it is all local), so the note is only there to explain what
// does not: checking for a new version, and later sync and share links. It follows the browser's
// `online` and `offline` events; `navigator.onLine` is only a hint (a captive portal reads as
// online), which is fine for a note that changes nothing.

import { useOnline, type OnlineSource } from './online';
import './pwa.css';

export function OfflineIndicator({ source }: { source?: OnlineSource }) {
  const online = useOnline(source);
  if (online) return null;
  return (
    <div
      className="pwa-offline"
      role="status"
      data-testid="offline-indicator"
      title="manufakture works offline: your documents open, change and save in this browser as usual. New versions are looked for once you are back online."
    >
      Offline
    </div>
  );
}
