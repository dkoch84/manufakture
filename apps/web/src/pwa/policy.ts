// What the service worker may cache and serve, as pure functions so they are unit tested
// (policy.test.ts) and shared by the worker (sw/sw.ts) and the build (precache.ts).
//
// The rule is an allowlist: the worker answers only same-origin GET requests for the build's own
// files. Everything else (other origins, the sync server and any other API, uploads, range
// requests, paths it does not know) is never matched, so the browser fetches it from the network
// as if there were no worker. docs/hosting.md, "Service worker", says the same for hosts.

/** The cache for hashed build assets that are loaded lazily and fetched on first use. */
export const RUNTIME_CACHE = 'manufakture-runtime-assets';

/** Messages between the page and the worker. */
export const SW_MESSAGE = {
  /** Page to waiting worker: take over now (the user chose Reload). */
  skipWaiting: 'mfk-sw-skip-waiting',
  /** Page to worker: reply on the given port with the build id. */
  version: 'mfk-sw-version',
  /** Worker to pages: precache progress while installing (`loaded`, `total` in bytes). */
  progress: 'mfk-sw-progress',
} as const;

/** A Vite asset file name with its content hash: `name-XXXXXXXX.ext`. */
const HASHED_ASSET = /-[A-Za-z0-9_-]{8}\.[A-Za-z0-9]+$/;

interface RequestLike {
  method: string;
  headers?: { has(name: string): boolean };
}

/**
 * Whether the worker may answer `request` for `url` from its runtime cache (fetching and storing
 * it on first use): a same-origin GET, not a range request, for a content-hashed file under the
 * build's `assets/` directory. `scopeUrl` is the worker's scope (`registration.scope`).
 */
export function isRuntimeCacheable(url: URL, request: RequestLike, scopeUrl: string): boolean {
  const scope = new URL(scopeUrl);
  if (url.origin !== scope.origin) return false;
  if (request.method !== 'GET') return false;
  if (request.headers?.has('range')) return false;
  if (url.search !== '') return false;
  const assets = `${scope.pathname}assets/`;
  if (!url.pathname.startsWith(assets)) return false;
  const name = url.pathname.slice(assets.length);
  return !name.includes('/') && HASHED_ASSET.test(name);
}

/**
 * Whether a navigation to `url` is the app (answered with the cached `index.html`): same origin,
 * inside the scope, and a path without a file extension. Precached pages (`index.html`, and any
 * other HTML entry the build emits) are answered by the precache route before this one; any other
 * file goes to the network. Paths under `api/` are never the app, whatever server later lives
 * there. Nor is `source`, the source offer (T7.3c, `source.html`): it must reach the page that
 * names the build's source even when the precache does not hold it, never the app.
 */
export function isAppNavigation(url: URL, scopeUrl: string): boolean {
  const scope = new URL(scopeUrl);
  if (url.origin !== scope.origin) return false;
  if (!url.pathname.startsWith(scope.pathname)) return false;
  const rest = url.pathname.slice(scope.pathname.length);
  if (rest === 'api' || rest.startsWith('api/')) return false;
  if (rest === 'source' || rest === 'source/') return false;
  const last = rest.split('/').pop() ?? '';
  return !last.includes('.');
}
