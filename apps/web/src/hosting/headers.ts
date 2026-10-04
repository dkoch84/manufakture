// The response headers a host sends with the build (T7.3c, docs/hosting.md). The production server
// config, deploy/Caddyfile, writes them out for Caddy; `vite preview` (vite.config.ts) sends the
// same ones, so every end-to-end test runs under the production Content-Security-Policy.
// headers.test.ts checks the Caddyfile still says what this module says.

/**
 * The Content-Security-Policy of the app, the viewer and the source page.
 *
 * - `script-src 'self' 'wasm-unsafe-eval'`: our own scripts only, and WebAssembly compilation.
 *   No inline script and no `eval`. (zod probes `Function('')` once and falls back when it is
 *   refused; the browser reports that as a violation, which is expected.)
 * - `style-src 'self'`: our stylesheets; React sets inline styles through the CSSOM, which a
 *   policy does not block.
 * - `img-src` adds `data:` and `blob:` for small inlined assets and object URLs of thumbnails and
 *   exports.
 * - `connect-src 'self' https:`: the sync server and share hosts are other origins, always https
 *   (the viewer refuses anything else, src/viewer/load.ts).
 * - `frame-ancestors 'none'`: nobody frames the app (clickjacking); `object-src 'none'`,
 *   `base-uri 'self'` and `form-action 'self'` close the usual gaps.
 */
export const DOCUMENT_CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self' https:",
  "worker-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/**
 * The policy of the worker scripts (`assets/*worker*.js`). A dedicated worker takes its policy
 * from its own script's response, not from the page. The kernel's Emscripten glue (libcascade's
 * embind) builds its function invokers with `new Function`, which needs `'unsafe-eval'`; the
 * workers run only our code on data the page posts them, and the page's own policy stays without
 * it. `connect-src 'self'` (T7.2e): the workers fetch only the app's own `.wasm` and font assets,
 * never another origin, so the regen worker, where user scripts run in QuickJS, cannot reach the
 * network even if a script escaped the sandbox (sync and sharing talk to other origins from the
 * page).
 */
export const WORKER_CSP = DOCUMENT_CSP.replace(
  "script-src 'self' 'wasm-unsafe-eval'",
  "script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval'",
).replace("connect-src 'self' https:", "connect-src 'self'");

/**
 * The same policy for a page served from localhost (`vite preview`, the end-to-end tests): the
 * viewer opens bundles from local http servers there (src/viewer/load.ts, `allowLocalHttp`).
 */
export function localPolicy(policy: string): string {
  return policy.replace(
    "connect-src 'self' https:",
    "connect-src 'self' https: http://localhost:* http://127.0.0.1:* http://[::1]:*",
  );
}

/** Headers sent with every response. */
export const COMMON_HEADERS: Readonly<Record<string, string>> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  // Isolates the browsing context group from other origins' windows. COEP is not sent: nothing
  // needs cross-origin isolation (ADR 0002 decision 2: the kernel is single-threaded).
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
};

/** Cache-Control for content-hashed files under `assets/`. */
export const IMMUTABLE = 'public, max-age=31536000, immutable';
/** Cache-Control for everything else (pages, `sw.js`, the manifest, icons). */
export const REVALIDATE = 'no-cache';

/** A Vite asset with its content hash, directly under `assets/`. */
export const HASHED_ASSET_PATH = /^\/assets\/[^/]+-[A-Za-z0-9_-]{8}\.[A-Za-z0-9]+$/;
/** A worker script under `assets/` (Vite names them after their entry, which ends in `worker`). */
export const WORKER_SCRIPT_PATH = /^\/assets\/[^/]*worker[^/]*\.js$/;

/** The headers for a response to `path` (relative to the app's base, starting with `/`). */
export function headersFor(
  path: string,
  options: { local?: boolean } = {},
): Record<string, string> {
  const policy = WORKER_SCRIPT_PATH.test(path) ? WORKER_CSP : DOCUMENT_CSP;
  return {
    ...COMMON_HEADERS,
    'Content-Security-Policy': options.local ? localPolicy(policy) : policy,
    'Cache-Control': HASHED_ASSET_PATH.test(path) ? IMMUTABLE : REVALIDATE,
  };
}
