# Hosting manufakture

manufakture is a static web app: `pnpm build` writes it to `apps/web/dist`, and any static host can serve that directory. This file says what a host needs to know. It covers the service worker for now; the headers file, the deploy workflow and the source offer come with T7.3c.

## Service worker

The build includes a service worker, `sw.js`, at the root of the app (next to `index.html`). It makes the app installable and lets it open with no network after one visit. Its source is `apps/web/src/pwa/sw/sw.ts`; it is built by vite-plugin-pwa with Workbox (both MIT, [ADR 0006](adr/0006-licensing.md)).

### What it caches

On the first visit, once the app has started, it precaches the build: `index.html`, every JavaScript and CSS chunk, the worker scripts, the kernel's `.wasm` (42.7 MB raw), planegcs and Manifold's `.wasm`, the bundled font, the icons and the manifest. The list is fixed at build time (`apps/web/src/pwa/precache.ts`): files up to 2 MiB, plus the kernel by name. IFC export's web-ifc (about 5 MB, used rarely) is left out and cached the first time it is used, as QuickJS will be. A build adds about 50 MB to the origin's Cache Storage.

Responses are stored as the host sent them, headers included:

- the `.wasm` files keep `Content-Type: application/wasm`, which `WebAssembly.compileStreaming` needs;
- `index.html` keeps `Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy` when the host sends them, so a page opened offline is isolated exactly when it was online;
- a body sent compressed is stored decoded (see the measurements below), so compression saves transfer, not disk.

### What it never touches

The worker answers only what it is told about: the precached files, navigations to the app (same origin, inside its scope, a path without a file extension, never under `api/`), and same-origin `GET` requests for content-hashed files under `assets/`. Everything else goes to the network as if there were no worker: other origins (the sync server and any share host among them), anything under `api/`, non-`GET` requests, range requests, URLs with a query string, and paths it does not know. The rules are in `apps/web/src/pwa/policy.ts`, with tests.

### What the host should send

- `sw.js` and `index.html`: `Cache-Control: no-cache` (or a short `max-age`). The app registers the worker with `updateViaCache: 'none'`, so browsers revalidate `sw.js` on every navigation anyway, but a CDN in between must not hold it either.
- Hashed files under `assets/`: `Cache-Control: public, max-age=31536000, immutable`. The precache runs after the kernel worker has downloaded the kernel and reads it from the HTTP cache; a host that forbids caching makes a first visit download the kernel twice.
- `.wasm` as `application/wasm`, precompressed with brotli where the host can (ADR 0002).
- The app may live under a sub-path: the worker's scope is Vite's `base`.

### Updates and rollback

A new build has a new `sw.js` (its file list changes). Browsers find it on the next navigation, or when an open tab comes back to the foreground, or hourly. The new worker installs in the background and waits; it never takes over on its own. The app first flushes autosave, and only once every change is saved shows "A new version of manufakture is ready" with **Reload** and **Later**. Reload saves once more, lets the new worker take over and reloads the page. **Later** leaves the old version running until every tab of the app is closed. The logic is `apps/web/src/pwa/updateFlow.ts`.

When one tab chooses Reload, the new worker takes control of every other open tab of the app as well, but those keep running the old build, and the old build's precache is gone. Each such tab notices the change of controller and offers Reload ("manufakture was updated in another tab"), again only once its autosave has flushed; a lazily loaded chunk that fails to load in the meantime (a dynamic import Vite reports as `vite:preloadError`, or an unhandled rejection with a browser's "dynamically imported module" message) leads to the same offer. The logic is in `apps/web/src/pwa/register.ts` and `skew.ts`.

Rolling back is deploying the older build again: its `sw.js` differs from the current one, so it arrives as an update like any other.

### Kill switch

If a worker is broken in a way an update cannot fix (it pins users to a bad build, or caches what it should not), serve the kill switch at the same URL: copy `apps/web/src/pwa/kill-switch/sw.js` over `dist/sw.js` and deploy. On each user's next navigation the browser installs it, and it:

1. deletes the caches the app's worker made (documents live in OPFS or IndexedDB and are not touched),
2. unregisters itself, so later loads go straight to the network,
3. reloads the windows the old worker controlled.

It has no fetch handler, so while it is active every request goes to the network. The app registers `sw.js` on every load, so while the kill switch is served each visit installs it and it removes itself again at once; that costs a few milliseconds and stores nothing. To bring offline support back, deploy a normal build. The end-to-end test `apps/web/e2e/offline.spec.ts` checks the kill switch: caches gone, and the app no longer opens offline.

### Development and tests

`vite dev` has no service worker: the plugin builds it only in `vite build`, and the app registers it only in production builds. To try it locally, `pnpm build` and `pnpm --filter @manufakture/web preview`. The end-to-end build (`VITE_E2E=1`) registers it only when a test opts in (`window.__manufakturePwaOptIn`): every other spec runs in a fresh browser context, where a worker would precache about 50 MB in the background of each test, racing the performance budgets, and would answer requests the specs intercept. `offline.spec.ts` opts in and serves the build from a server of its own, which can go down, compress and switch builds.

### Measurements

From the "measures" test in `apps/web/e2e/offline.spec.ts` (headless Chromium 153, the build served from localhost with brotli for `.wasm` and `immutable` assets, persistent browser profiles so the HTTP cache is on disk; 2026-10-04):

| Measure                                                             | Value                                              |
| ------------------------------------------------------------------- | -------------------------------------------------- |
| Kernel `.wasm`, raw                                                 | 42,691,285 bytes                                   |
| Kernel `.wasm`, as sent (brotli quality 5 in the test)              | 10,196,544 bytes                                   |
| Kernel body as stored in Cache Storage                              | 42,691,285 bytes (decoded)                         |
| Headers stored with it                                              | `Content-Encoding: br`, `Content-Length: 10196544` |
| Cache Storage for the whole precache (`navigator.storage.estimate`) | 49.7 MB                                            |
| Kernel downloads on a first visit (kernel worker and precache)      | 1                                                  |
| Start-up, first visit, nothing cached                               | 726 ms                                             |
| Start-up from the HTTP cache (no worker), median of 5               | 657 ms                                             |
| Start-up from Cache Storage (worker, online), median of 5           | 628 ms                                             |
| Start-up from Cache Storage, offline, median of 5                   | 644 ms                                             |

Start-up is navigation start to the kernel ready and the first model shown. Chromium stores the decoded body but keeps the original `Content-Encoding` and `Content-Length` headers, so a cached response's `Content-Length` is the compressed size; the kernel loader already ignores `Content-Length` when a `Content-Encoding` is present and shows progress against the known size. Cache Storage and the HTTP cache start the app equally fast: on localhost the download costs next to nothing and most of the time is the kernel's runtime init, which no cache saves (ADR 0002). The worker's value is that the app opens at all with no network, and that a slow network no longer delays a returning visit. Numbers on a loaded machine were about twice these, with the same ordering and gaps of tens of milliseconds.

A private (incognito) window keeps its HTTP cache in memory, too small for the 42.7 MB kernel, so there the precache downloads the kernel a second time on the first visit.
