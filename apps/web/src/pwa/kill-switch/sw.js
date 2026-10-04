/* global self, caches */
// manufakture service worker kill switch (docs/hosting.md, "Service worker").
//
// Serve this file in place of the build's `sw.js`, at the same URL, when a broken service worker
// must be taken off users' machines. Browsers check `sw.js` for changes on every navigation (and
// never take it from the HTTP cache for longer than 24 hours), find this one, install it at once,
// and it then:
// - deletes every Cache Storage cache the app's worker made (documents are in OPFS or IndexedDB
//   and are never touched),
// - unregisters itself, so the next load goes straight to the network,
// - reloads the windows the old worker controlled, so they stop using its cached files. Only
//   those: a page loaded afterwards is not controlled, so it is never reloaded, and there is no
//   reload loop.
// It has no fetch handler: while it is active every request goes to the network.
//
// The app registers sw.js on every load, so while this file is served each visit installs it and
// it removes itself again at once; that costs a few milliseconds and stores nothing.

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((n) => n.startsWith('workbox-') || n.startsWith('manufakture-'))
          .map((n) => caches.delete(n)),
      );
      await self.registration.unregister();
      // Without includeUncontrolled: only the windows this worker took over from the old one.
      const windows = await self.clients.matchAll({ type: 'window' });
      for (const w of windows) w.navigate(w.url);
    })(),
  );
});
