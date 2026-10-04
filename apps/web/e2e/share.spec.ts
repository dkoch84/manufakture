import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { buildApp } from '../../server/src/app';
import { DEFAULT_LIMITS } from '../../server/src/limits';
import { DEFAULT_SHARE_CONFIG, SqliteShareStore } from '../../server/src/shares';
import { SqliteStore } from '../../server/src/sqlite';
import { buildBracket, openEmpty } from './bracket';

// Share links (T7.3d) end to end: a real manufakture server (apps/server, on a free port over a
// temp SQLite file) next to the app. The bracket is shared through the Share panel, the link is
// opened in a fresh browser context (no storage, no token) in the viewer, then revoked, after
// which the same link fails.

test.describe.configure({ mode: 'serial' });

const TOKEN = 'e2e-share-token-0123456789abcdefghijklmnopqrstuvwxyz';

let dir: string;
let store: SqliteStore;
let server: Awaited<ReturnType<typeof buildApp>>;
let serverUrl: string;

test.beforeAll(async ({ baseURL }) => {
  dir = mkdtempSync(join(tmpdir(), 'mfk-share-e2e-'));
  store = new SqliteStore(join(dir, 'server.db'));
  const appOrigin = new URL(baseURL!).origin;
  server = await buildApp({
    token: TOKEN,
    store,
    limits: DEFAULT_LIMITS,
    origins: [appOrigin],
    shares: {
      store: new SqliteShareStore(store.database),
      config: { ...DEFAULT_SHARE_CONFIG, viewerOrigins: [appOrigin] },
    },
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

/** Opens `link` in a new browser context, as someone without the app or the token would. */
async function openFresh(
  browser: Browser,
  link: string,
): Promise<{ page: Page; close(): Promise<void> }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(link);
  await expect(page.getByTestId('viewer-canvas')).toBeVisible();
  return { page, close: () => context.close() };
}

test('shares the bracket as a link, opens it elsewhere, revokes it', async ({ page, browser }) => {
  test.setTimeout(300_000);
  await openEmpty(page);
  await buildBracket(page);

  await page.getByTestId('share-button').click();
  await page.getByTestId('share-server-url').fill(serverUrl);
  await page.getByTestId('share-token').fill(TOKEN);
  await page.getByTestId('share-save-server').click();
  await expect(page.getByText(/Active links \(0 of 100\)/)).toBeVisible();
  await expect(page.getByTestId('share-expiry')).toHaveValue('30');

  await page.getByTestId('share-create').click();
  const linkBox = page.getByTestId('share-link');
  await expect(linkBox).toBeVisible({ timeout: 60_000 });
  const link = await linkBox.inputValue();
  const id = /\/api\/shares\/([A-Za-z0-9_-]{22})$/.exec(link)?.[1];
  expect(id, link).toBeTruthy();
  expect(
    link.startsWith(`${new URL(page.url()).origin}/viewer.html#src=${serverUrl}/api/shares/`),
  ).toBe(true);
  await expect(page.getByTestId('share-item')).toHaveCount(1);

  // Someone else opens it: a new context with nothing stored, so no token.
  const other = await openFresh(browser, link);
  await expect(other.page.getByTestId('viewer-error')).toHaveCount(0);
  await expect(other.page.getByTestId('viewer-bodies').locator('li')).toHaveCount(1, {
    timeout: 60_000,
  });
  await other.close();

  // The public download is labelled safely and never cached.
  const res = await fetch(`${serverUrl}/api/shares/${id}`);
  expect(res.status).toBe(200);
  expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  expect(res.headers.get('cache-control')).toBe('no-store');

  // Revoke: the list empties, and the same link now fails in the viewer.
  await page.getByTestId('share-revoke').click();
  await expect(page.getByTestId('share-item')).toHaveCount(0);
  expect((await fetch(`${serverUrl}/api/shares/${id}`)).status).toBe(404);
  const after = await openFresh(browser, link);
  await expect(after.page.getByTestId('viewer-error')).toContainText('404');
  await expect(after.page.getByTestId('viewer-bodies')).toHaveCount(0);
  await after.close();
});
