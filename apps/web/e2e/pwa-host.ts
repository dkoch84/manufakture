// The small host the service worker specs serve the end-to-end build from (offline.spec.ts,
// offline-skew.spec.ts), and the helpers they share. It serves dist/e2e-app (made by the
// webServer step) as a real host would: hashed assets `immutable`, the kernel's .wasm brotli
// compressed, COOP and COEP on every response. It can go down (every request refused and
// recorded) and switch to a "newer" build or to the kill switch at the same URLs. Playwright's
// routing does not see a service worker's own script fetches (its update checks), so routing
// could not switch builds.

import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { brotliCompressSync, constants as zlib } from 'node:zlib';
import { expect, type BrowserContext, type Page } from '@playwright/test';

export const APP_DIR = resolve(import.meta.dirname, '../dist/e2e-app');
const KILL_SWITCH = resolve(import.meta.dirname, '../src/pwa/kill-switch/sw.js');

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ttf': 'font/ttf',
};

export interface Host {
  url: string;
  /** Which build `sw.js` and `index.html` are: the real one, a newer one, or the kill switch. */
  variant: 'v1' | 'v2' | 'kill';
  /** While true, every request is refused (503) and recorded in `whileDown`. */
  down: boolean;
  whileDown: string[];
  /** How many times each path was requested (while up). */
  requests: Map<string, number>;
  /** Brotli size of each compressed file served, by path. */
  compressed: Map<string, number>;
  close(): Promise<void>;
}

/** The build revision `v2` serves: index.html gets a marker, sw.js a new index.html revision. */
export const V2_REVISION = 'e2e-v2';

export async function startHost(): Promise<Host> {
  const brotli = new Map<string, Buffer>();
  const host: Host = {
    url: '',
    variant: 'v1',
    down: false,
    whileDown: [],
    requests: new Map(),
    compressed: new Map(),
    close: async () => undefined,
  };
  const server: Server = createServer((req, res) => {
    void (async () => {
      const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
      if (host.down) {
        host.whileDown.push(path);
        res.writeHead(503).end();
        return;
      }
      host.requests.set(path, (host.requests.get(path) ?? 0) + 1);
      const rel = path === '/' ? 'index.html' : path.slice(1);
      const file = normalize(join(APP_DIR, rel));
      if (!file.startsWith(APP_DIR + sep)) {
        res.writeHead(404).end();
        return;
      }
      let body: Buffer;
      try {
        body =
          rel === 'sw.js' && host.variant === 'kill'
            ? await readFile(KILL_SWITCH)
            : await readFile(file);
      } catch {
        res.writeHead(404).end();
        return;
      }
      if (host.variant === 'v2' && rel === 'index.html') {
        body = Buffer.from(
          body
            .toString()
            .replace('<head>', `<head>\n<meta name="manufakture-e2e-build" content="v2" />`),
        );
      }
      if (host.variant === 'v2' && rel === 'sw.js') {
        const text = body.toString();
        const next = text.replace(
          /"revision":"[0-9a-f]+","url":"index\.html"/,
          `"revision":"${V2_REVISION}","url":"index.html"`,
        );
        if (next === text) throw new Error('sw.js has no index.html revision to change');
        body = Buffer.from(next);
      }
      const headers: Record<string, string> = {
        'Content-Type': TYPES[extname(rel)] ?? 'application/octet-stream',
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
        'Cache-Control': rel.startsWith('assets/')
          ? 'public, max-age=31536000, immutable'
          : 'no-cache',
      };
      const acceptsBr = /\bbr\b/.test(String(req.headers['accept-encoding'] ?? ''));
      if (rel.endsWith('.wasm') && acceptsBr) {
        let packed = brotli.get(rel);
        if (!packed) {
          // Quality 5 keeps the test fast; hosting precompresses at 11 (ADR 0002: 7.8 MiB).
          packed = brotliCompressSync(body, { params: { [zlib.BROTLI_PARAM_QUALITY]: 5 } });
          brotli.set(rel, packed);
          host.compressed.set(rel, packed.byteLength);
        }
        body = packed;
        headers['Content-Encoding'] = 'br';
        headers['Vary'] = 'Accept-Encoding';
      }
      headers['Content-Length'] = String(body.byteLength);
      res.writeHead(200, headers).end(req.method === 'HEAD' ? undefined : body);
    })().catch((e: unknown) => {
      res.writeHead(500).end(String(e));
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  host.url = `http://localhost:${(server.address() as AddressInfo).port}`;
  host.close = () =>
    new Promise<void>((done) => {
      server.closeAllConnections();
      server.close(() => done());
    });
  return host;
}

/** Make the end-to-end build register its service worker in `context`. */
export async function optIn(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    (window as unknown as { __manufakturePwaOptIn: boolean }).__manufakturePwaOptIn = true;
  });
}

/** Open the app and wait until the worker controls it and has precached the build. */
export async function installed(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByTestId('empty-hint')).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId('pwa-offline-ready')).toBeVisible({ timeout: 90_000 });
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
}

/** The build id of the worker controlling the page. */
export function workerBuild(page: Page): Promise<string> {
  return page.evaluate(
    () =>
      new Promise<string>((done) => {
        const channel = new MessageChannel();
        channel.port1.onmessage = (e) => done(e.data as string);
        navigator.serviceWorker.controller!.postMessage({ type: 'mfk-sw-version' }, [
          channel.port2,
        ]);
      }),
  );
}
