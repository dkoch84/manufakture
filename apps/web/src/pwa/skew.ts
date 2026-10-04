// Version skew (T7.4b): noticing that a chunk of the app failed to load.
//
// The app loads much of itself lazily (dialogs, exporters, the drawing and CAM workspaces). A tab
// that runs an old build after the files of that build are gone (another tab updated the app and
// the new service worker deleted the old precache, or the host deployed a new build and no worker
// runs) gets a failed dynamic import the next time it needs such a chunk. The caller still sees
// its import fail and reports it as it does today; this only tells the update flow, which offers
// Reload (once autosave has flushed) instead of leaving the user with a feature that will never
// load.
//
// Two ways a failure shows: Vite wraps the app's dynamic imports in its preload helper, which
// dispatches `vite:preloadError` on window when the import (or a CSS or chunk it preloads) fails;
// an import outside the helper that nobody catches reaches `unhandledrejection`, recognised by the
// browsers' messages.

/** The messages browsers give a failed dynamic import of a module script. */
const CHUNK_ERROR =
  /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS/i;

/** Whether `reason` (an error or rejection reason) is a failed load of a chunk of the app. */
export function isChunkLoadError(reason: unknown): boolean {
  if (reason === null || reason === undefined) return false;
  const message = reason instanceof Error ? reason.message : String(reason);
  return CHUNK_ERROR.test(message);
}

/** Call `onFail` when loading a chunk fails; returns the function that stops watching. */
export function watchChunkErrors(target: Window, onFail: () => void): () => void {
  const preload = () => onFail();
  const rejection = (e: PromiseRejectionEvent) => {
    if (isChunkLoadError(e.reason)) onFail();
  };
  target.addEventListener('vite:preloadError', preload);
  target.addEventListener('unhandledrejection', rejection);
  return () => {
    target.removeEventListener('vite:preloadError', preload);
    target.removeEventListener('unhandledrejection', rejection);
  };
}
