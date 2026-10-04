// The service worker (T7.4a). Built by vite-plugin-pwa's `injectManifest` strategy, which bundles
// this file with the Workbox modules it imports and replaces `self.__WB_MANIFEST` with the list of
// build files chosen by ../precache.ts. Served as `sw.js` at the root of the app's scope.
//
// What it does, and nothing more:
// - Precaches the build: the app shell, every JavaScript and CSS chunk, the worker scripts, the
//   kernel's .wasm, planegcs and Manifold. Responses are stored as the host sent them, headers
//   included, so `Content-Type: application/wasm` (needed by `WebAssembly.compileStreaming`) and
//   COOP/COEP on `index.html` (when the host sends them) come back from the cache unchanged.
// - Answers navigations inside the scope with the cached `index.html`, so the app opens offline.
// - Caches the remaining hashed build assets (IFC export's web-ifc, later QuickJS) on first use.
// - Never touches anything else: other origins, the sync server, any API, non-GET requests and
//   range requests are not matched and go to the network (../policy.ts).
//
// Updates never take over on their own: a new worker installs, then waits until the page has
// flushed autosave and the user chose Reload (../updateFlow.ts), which sends `skipWaiting`.
//
// Kill switch: ../kill-switch/sw.js, served at this same URL, replaces this worker with one that
// deletes the caches and unregisters (docs/hosting.md, "Service worker").

/// <reference lib="webworker" />

import { clientsClaim } from 'workbox-core';
import {
  addPlugins,
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
  precacheAndRoute,
} from 'workbox-precaching';
import { registerRoute } from 'workbox-routing';
import { CacheFirst } from 'workbox-strategies';
import { isAppNavigation, isRuntimeCacheable, RUNTIME_CACHE, SW_MESSAGE } from '../policy';
import type { PrecacheEntryWithBytes } from '../precache';

declare const self: ServiceWorkerGlobalScope;

// Replaced at build time by the list ../precache.ts chose, with each file's size as `bytes`.
const manifest = self.__WB_MANIFEST as unknown as PrecacheEntryWithBytes[];
const scope = self.registration.scope;

/** The build this worker belongs to: the revision Workbox computed for `index.html`. */
const BUILD = manifest.find((e) => e.url === 'index.html')?.revision ?? 'unknown';

// Progress of the first install, reported to every window of the origin (the first visit's page
// is not controlled yet, so `includeUncontrolled`). Counted in bytes, so the kernel weighs what it
// is. An update is not reported: Workbox copies unchanged files without fetching them, so the
// count would never reach the total, and the update flow has its own message.
const bytesByUrl = new Map(manifest.map((e) => [new URL(e.url, scope).href, e.bytes]));
const total = manifest.reduce((sum, e) => sum + e.bytes, 0);
let loaded = 0;
const reported = new Set<string>();

async function broadcast(message: unknown): Promise<void> {
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const w of windows) w.postMessage(message);
}

addPlugins([
  {
    cacheDidUpdate: async ({ request }) => {
      if (self.registration.active) return;
      const url = new URL(request.url);
      url.searchParams.delete('__WB_REVISION__');
      const key = url.href;
      if (reported.has(key)) return;
      reported.add(key);
      loaded += bytesByUrl.get(key) ?? 0;
      await broadcast({ type: SW_MESSAGE.progress, loaded, total });
    },
  },
]);

precacheAndRoute(manifest);
cleanupOutdatedCaches();

registerRoute(
  ({ request, url }) => request.mode === 'navigate' && isAppNavigation(url, scope),
  createHandlerBoundToURL('index.html'),
);

registerRoute(
  ({ request, url }) => isRuntimeCacheable(url, request, scope),
  new CacheFirst({ cacheName: RUNTIME_CACHE }),
);

self.addEventListener('activate', (event) => {
  const first = loaded > 0;
  event.waitUntil(
    (async () => {
      // Lazily loaded assets of the previous build are not needed by this one.
      await caches.delete(RUNTIME_CACHE);
      // The first install is complete whatever the byte count said.
      if (first) await broadcast({ type: SW_MESSAGE.progress, loaded: total, total });
    })(),
  );
});
// The first install takes control of the page that installed it, so it works offline without a
// reload. An update only reaches here after `skipWaiting`, which the user asked for.
clientsClaim();

self.addEventListener('message', (event) => {
  const data = event.data as { type?: string } | null;
  if (data?.type === SW_MESSAGE.skipWaiting) {
    void self.skipWaiting();
  } else if (data?.type === SW_MESSAGE.version) {
    event.ports[0]?.postMessage(BUILD);
  }
});
