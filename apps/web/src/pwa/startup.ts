// When the service worker may start precaching: once the app has started (the kernel worker has
// downloaded and compiled the kernel, App calls `markStartupDone`), or after `fallbackMs` if that
// never happens (the kernel failed to load, the user went straight to the home screen).
//
// Precaching earlier makes a first visit download the 42.7 MB kernel twice: the kernel worker's
// fetch is still running when the worker's precache asks for the same file, and the browser does
// not make the second request wait for the first. Measured in e2e/offline.spec.ts: two kernel
// requests on a first visit when the worker registered at the page's `load` event, one after this.

let resolve: () => void = () => undefined;
const done = new Promise<void>((r) => (resolve = r));

/** The app is up: the kernel is ready and the first model is shown. */
export function markStartupDone(): void {
  resolve();
}

/** Resolves once the app has started, or after `fallbackMs`. */
export function afterStartup(fallbackMs = 30_000): Promise<void> {
  return Promise.race([done, new Promise<void>((r) => setTimeout(r, fallbackMs))]);
}
