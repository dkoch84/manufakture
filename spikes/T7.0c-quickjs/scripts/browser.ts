// Build the page with Vite and run tasks in Chromium, Firefox and WebKit through Playwright.
// The page is served through a Playwright route (no port), with COOP/COEP headers so the page
// is cross-origin isolated and every browser gives its finest timer.
//
// Without root, the browsers' shared libraries come from an unpacked copy: set
// BROWSER_LIBS (default /tmp/chromelibs/usr/lib) and FONTCONFIG_FILE for all three, and
// WEBKIT_EXECUTABLE to a wrapper script for WebKit, whose own launcher resets LD_LIBRARY_PATH
// (see the spike's README).

import { existsSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { chromium, firefox, webkit, type BrowserType } from 'playwright';
import { build } from 'vite';
import type { Task } from '../src/tasks';

export const BROWSERS = ['chromium', 'firefox', 'webkit'] as const;
export type BrowserName = (typeof BROWSERS)[number];

const SPIKE_DIR = new URL('..', import.meta.url).pathname;
const DIST = join(SPIKE_DIR, 'dist', 'page');
// https makes the page a secure context, so COOP/COEP take effect (the route answers before
// any TLS would happen).
const ORIGIN = 'https://spike.test';

const TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.wasm': 'application/wasm',
};

export async function buildPage(): Promise<void> {
  await build({ root: SPIKE_DIR, logLevel: 'warn', configFile: join(SPIKE_DIR, 'vite.config.ts') });
}

function launcher(name: BrowserName): BrowserType {
  return { chromium, firefox, webkit }[name];
}

export interface BrowserRun {
  browser: BrowserName;
  version: string;
  ok: boolean;
  isolated?: boolean;
  timerMs?: number;
  results?: Record<string, unknown>;
  error?: string;
  /** Progress lines the worker logged, kept when the page crashes. */
  log?: string[];
}

export async function runInBrowser(
  name: BrowserName,
  tasks: readonly Task[],
  timeoutMs = 900_000,
): Promise<BrowserRun> {
  const libs = process.env.BROWSER_LIBS ?? '/tmp/chromelibs/usr/lib';
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  if (existsSync(libs)) env.LD_LIBRARY_PATH = libs;
  const executablePath = name === 'webkit' ? process.env.WEBKIT_EXECUTABLE : undefined;
  const browser = await launcher(name).launch({
    env,
    ...(executablePath !== undefined ? { executablePath } : {}),
    timeout: 60_000,
  });
  const log: string[] = [];
  try {
    const page = await browser.newPage();
    page.on('console', (message) => log.push(message.text()));
    await page.route(`${ORIGIN}/**`, async (route) => {
      const path = new URL(route.request().url()).pathname;
      const file = join(DIST, path === '/' ? 'index.html' : path);
      if (!existsSync(file)) return route.fulfill({ status: 404, body: 'not found' });
      return route.fulfill({
        status: 200,
        body: readFileSync(file),
        headers: {
          'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
          'cross-origin-opener-policy': 'same-origin',
          'cross-origin-embedder-policy': 'require-corp',
          'cache-control': 'no-store',
        },
      });
    });
    await page.goto(`${ORIGIN}/?tasks=${tasks.join(',')}`);
    await page.waitForFunction(() => (window as unknown as { __result?: unknown }).__result, null, {
      timeout: timeoutMs,
      polling: 500,
    });
    const reply = (await page.evaluate(
      () => (window as unknown as { __result: unknown }).__result,
    )) as Omit<BrowserRun, 'browser' | 'version'>;
    return { browser: name, version: browser.version(), ...reply, log };
  } catch (e) {
    return { browser: name, version: browser.version(), ok: false, error: String(e), log };
  } finally {
    await browser.close();
  }
}
