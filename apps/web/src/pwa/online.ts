// Whether the browser reports a network connection, kept up to date from its `online` and
// `offline` events (OfflineIndicator.tsx, PwaStatus.tsx). `navigator.onLine` is only a hint.

import { useSyncExternalStore } from 'react';

export type OnlineSource = Pick<Window, 'addEventListener' | 'removeEventListener'> & {
  navigator: Pick<Navigator, 'onLine'>;
};

/** Whether the browser reports a network connection, kept up to date. */
export function useOnline(source: OnlineSource = window): boolean {
  return useSyncExternalStore(
    (changed) => {
      source.addEventListener('online', changed);
      source.addEventListener('offline', changed);
      return () => {
        source.removeEventListener('online', changed);
        source.removeEventListener('offline', changed);
      };
    },
    () => source.navigator.onLine,
    () => true,
  );
}
