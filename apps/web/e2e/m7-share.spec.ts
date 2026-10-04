import { expect, test, type Browser, type BrowserContext } from '@playwright/test';
import { buildBracket, openEmpty } from './bracket';
import {
  TOKEN,
  docShot,
  expectViewerBracket,
  median,
  newContext,
  recordBudget,
  saved,
  startServer,
  type M7Server,
} from './m7-fixtures';

// M7 acceptance, chapter 3: sharing (docs/m7-acceptance.md; the M7 plan, T7.5). Browser 1 builds
// the M1 bracket and publishes it as a share link on the suite's server (the defaults: 30 days,
// up to 100 links). A third browser context, with nothing stored and no token, opens the link in
// the read-only viewer; no request it makes carries credentials. The viewer's load time is
// measured over fresh contexts.

let server: M7Server;

test.beforeAll(async ({ baseURL }) => {
  server = await startServer(baseURL!);
});

test.afterAll(async () => {
  await server?.close();
});

/** Every context a test opened: closed after it, whether it passed or not. */
const contexts: BrowserContext[] = [];

test.afterEach(async () => {
  for (const c of contexts.splice(0)) await c.close();
});

async function open(browser: Browser): Promise<BrowserContext> {
  const context = await newContext(browser);
  contexts.push(context);
  return context;
}

interface Opened {
  ms: number;
  /** In-page time from navigation start to the body shown, ms. */
  shownAt: number;
  /** Headers of every request the viewer made to the server. */
  serverRequests: Record<string, string>[];
}

/** Open `link` in a new context with nothing stored, as someone without the app would. */
async function openFresh(browser: Browser, link: string, shot?: string): Promise<Opened> {
  const context = await open(browser);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // Every header the browser sent, cookies and security headers included (`headers()` hides them).
  const pendingHeaders: Promise<Record<string, string>>[] = [];
  page.on('request', (r) => {
    if (r.url().startsWith(server.url)) pendingHeaders.push(r.allHeaders());
  });
  const t0 = performance.now();
  await page.goto(link);
  await expect(page.getByTestId('viewer-canvas')).toBeVisible();
  const shownAt = (await (
    await page.waitForFunction(
      () =>
        (window.__manufakture?.viewport.info().bodies.length ?? 0) === 1 ? performance.now() : 0,
      null,
      { timeout: 60_000, polling: 10 },
    )
  ).jsonValue()) as number;
  const ms = performance.now() - t0;
  await expectViewerBracket(page);
  // Read only: the viewer has no editing tools, and this context holds no token.
  await expect(page.getByTestId('share-button')).toHaveCount(0);
  await expect(page.getByTestId('sync-button')).toHaveCount(0);
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }));
  expect(stored).not.toContain(TOKEN);
  if (shot) await docShot(page, shot);
  expect(errors).toEqual([]);
  const serverRequests = await Promise.all(pendingHeaders);
  return { ms, shownAt, serverRequests };
}

test('the bracket is published and opened by link in a third browser, read only', async ({
  browser,
}) => {
  test.setTimeout(400_000);
  const ctx1 = await open(browser);
  const page = await ctx1.newPage();
  const errors = await openEmpty(page);
  await buildBracket(page);
  await saved(page);

  // Publish it: the Share panel, on the suite's server with its one token.
  await page.getByTestId('share-button').click();
  await page.getByTestId('share-server-url').fill(server.url);
  await page.getByTestId('share-token').fill(TOKEN);
  await page.getByTestId('share-save-server').click();
  await expect(page.getByText(/Active links \(0 of 100\)/)).toBeVisible();
  await expect(page.getByTestId('share-expiry')).toHaveValue('30');
  const t0 = performance.now();
  await page.getByTestId('share-create').click();
  const linkBox = page.getByTestId('share-link');
  await expect(linkBox).toBeVisible({ timeout: 60_000 });
  const publishMs = performance.now() - t0;
  const link = await linkBox.inputValue();
  expect(link).toMatch(/\/viewer\.html#src=http:\/\/127\.0\.0\.1:\d+\/api\/shares\/[\w-]{22}$/);
  await expect(page.getByTestId('share-item')).toHaveCount(1);
  await docShot(page, '07-share-link');

  // A third browser opens the link, several times over, each in a new context.
  const runs: Opened[] = [];
  for (let i = 0; i < 3; i++) {
    const opened = await openFresh(browser, link, i === 0 ? '08-viewer' : undefined);
    runs.push(opened);
  }
  for (const r of runs) {
    expect(r.serverRequests.length).toBeGreaterThan(0);
    for (const headers of r.serverRequests) {
      expect(Object.keys(headers)).not.toContain('authorization');
      expect(Object.keys(headers)).not.toContain('cookie');
    }
  }

  await recordBudget('viewerLoadMs', {
    what: 'a share link opened in a new browser context until the bracket is shown (page load, download from the server, unpack, first render)',
    wallClockMedian: Math.round(median(runs.map((r) => r.ms))),
    inPageMedian: Math.round(median(runs.map((r) => r.shownAt))),
    runs: runs.map((r) => Math.round(r.ms)),
    publishMs: Math.round(publishMs),
  });
  expect(errors).toEqual([]);
});
