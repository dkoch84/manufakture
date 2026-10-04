import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { buildApp } from '../../server/src/app';
import { DEFAULT_LIMITS } from '../../server/src/limits';
import { SqliteStore } from '../../server/src/sqlite';
import { openEmpty } from './bracket';
import { openScene } from './helpers';

// The production Content-Security-Policy (src/hosting/headers.ts; deploy/Caddyfile sends the same,
// `vite preview` sends it for these tests) must not break the app, the viewer or the source page
// (T7.3c). Every violation a page reports is collected; the kernel running at all proves the
// worker policy lets its Emscripten glue in. A document syncs with a real server, so the sync
// WebSocket is checked against connect-src too. The other specs bypass the policy (playwright.config.ts).

test.use({ bypassCSP: false });

interface Violation {
  directive: string;
  blocked: string;
  source: string;
}

/** Record every CSP violation the page reports, from before its first script runs. */
async function watchViolations(page: Page): Promise<() => Promise<Violation[]>> {
  await page.addInitScript(() => {
    const seen: Violation[] = [];
    (window as unknown as { __cspViolations: Violation[] }).__cspViolations = seen;
    document.addEventListener('securitypolicyviolation', (e) => {
      seen.push({ directive: e.effectiveDirective, blocked: e.blockedURI, source: e.sourceFile });
    });
  });
  return () =>
    page.evaluate(() => (window as unknown as { __cspViolations: Violation[] }).__cspViolations);
}

/**
 * zod probes `Function('')` once to learn whether it may compile validators, and falls back when
 * it may not; the browser reports the refusal. Anything else is a real violation.
 */
const isZodEvalProbe = (v: Violation) => v.directive === 'script-src' && v.blocked === 'eval';

test('the app regenerates the demo part under the policy', async ({ page }) => {
  const violations = await watchViolations(page);
  const response = await page.goto('/');
  const csp = response?.headers()['content-security-policy'] ?? '';
  expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval';");
  expect(csp).toContain("frame-ancestors 'none'");
  await openScene(page, '?scene=demo', 90_000);
  const info = await page.evaluate(() => window.__manufakture!.viewport.info());
  expect(info.bodies).toHaveLength(1);
  expect((await violations()).filter((v) => !isZodEvalProbe(v))).toEqual([]);
});

test('the Source link opens the source page, which names the build', async ({ page, context }) => {
  await page.goto('/');
  const link = page.getByTestId('source-link');
  await expect(link).toHaveAttribute('href', '/source.html');
  const [source] = await Promise.all([context.waitForEvent('page'), link.click()]);
  await source.waitForLoadState('domcontentloaded');
  await expect(source.getByRole('heading', { name: 'Source code of this build' })).toBeVisible();
  await expect(source.getByTestId('source-wasm').locator('tbody tr')).not.toHaveCount(0);
  await expect(source.getByTestId('source-wasm')).toContainText('libcascade');
  // The page's stylesheet is a file, so the strict policy lets it apply.
  const background = await source.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(background).toBe('rgb(244, 246, 248)');
});

test('the viewer starts under the policy and links the source page', async ({ page }) => {
  const violations = await watchViolations(page);
  await page.goto('/viewer.html');
  await expect(page.getByTestId('viewer-canvas')).toBeVisible();
  await expect(page.getByTestId('source-link')).toHaveAttribute('href', '/source.html');
  expect((await violations()).filter((v) => !isZodEvalProbe(v))).toEqual([]);
});

test.describe('sync under the policy', () => {
  // A real manufakture server (apps/server) in this process, as in sync.spec.ts. Locally the socket
  // is ws://127.0.0.1:<port>, which the local variant of the policy allows; in production it is
  // wss://<server>, which `connect-src ... wss:` allows (`https:` alone matches neither).
  const TOKEN = 'e2e-csp-token-0123456789abcdefghijklmnopqrstuvwxyz';
  let dir: string;
  let store: SqliteStore;
  let server: Awaited<ReturnType<typeof buildApp>>;
  let serverUrl: string;

  test.beforeAll(async ({ baseURL }) => {
    dir = mkdtempSync(join(tmpdir(), 'mfk-csp-e2e-'));
    store = new SqliteStore(join(dir, 'server.db'));
    server = await buildApp({
      token: TOKEN,
      store,
      limits: DEFAULT_LIMITS,
      origins: [new URL(baseURL!).origin],
    });
    await server.listen({ host: '127.0.0.1', port: 0 });
    const address = server.server.address();
    if (address === null || typeof address === 'string') throw new Error('no address');
    serverUrl = `http://127.0.0.1:${address.port}`;
  });

  test.afterAll(async () => {
    await server?.close();
    store?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test('a document syncs over its WebSocket under the policy', async ({ page }) => {
    test.setTimeout(180_000);
    const violations = await watchViolations(page);
    // Count the sync sockets the page opens, from before its first script runs.
    await page.addInitScript(() => {
      const opened: string[] = [];
      (window as unknown as { __socketsOpened: string[] }).__socketsOpened = opened;
      const Native = window.WebSocket;
      window.WebSocket = class extends Native {
        constructor(url: string | URL, protocols?: string | string[]) {
          super(url, protocols);
          this.addEventListener('open', () => opened.push(String(url)));
        }
      };
    });
    await openEmpty(page);
    await page.getByTestId('sync-button').click();
    await expect(page.getByTestId('sync-panel')).toBeVisible();
    await page.getByTestId('sync-server-url').fill(serverUrl);
    await page.getByTestId('sync-token').fill(TOKEN);
    await page.getByTestId('sync-save-server').click();
    await page.getByTestId('sync-switch').check();
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              (
                window.__manufakture as unknown as
                  { sync?: { state(): { status: { kind: string } } } } | undefined
              )?.sync?.state().status.kind ?? null,
          ),
        { timeout: 60_000 },
      )
      .toBe('synced');
    const opened = await page.evaluate(
      () => (window as unknown as { __socketsOpened: string[] }).__socketsOpened,
    );
    const socketBase = serverUrl.replace(/^http:/, 'ws:');
    expect(opened.some((u) => u.startsWith(`${socketBase}/api/documents/`))).toBe(true);
    expect((await violations()).filter((v) => !isZodEvalProbe(v))).toEqual([]);
  });
});
