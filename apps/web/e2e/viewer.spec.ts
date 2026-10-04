import { readFile, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { expect, test, type Page } from '@playwright/test';
import { VIEWER_JS_BUDGET_GZIP } from '../src/viewer/bundleCheck';
import { BRACKET, buildBracket, openEmpty } from './bracket';
import { settle } from './helpers';

// The read-only viewer (viewer.html, T7.3b) against the M1 bracket's published view: built through
// the UI once, published with Include source, then opened from a file and from a link, handed back
// to the app, and fed a damaged and an oversized bundle. Also measures the JavaScript the viewer
// page loads against the budget the build enforces (src/viewer/bundleCheck.ts).

test.describe.configure({ mode: 'serial' });

const MIME = 'application/vnd.manufakture.view+zip';
/** Bundles served through `page.route`: any origin works, and nothing listens on it. */
const BUNDLE_ORIGIN = 'http://localhost:9';

let bracket: Buffer;

test.beforeAll(async ({ browser }) => {
  test.setTimeout(300_000);
  const page = await browser.newPage();
  await openEmpty(page);
  await buildBracket(page);
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await page.getByTestId('export-include-source').check();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('export-publish').click(),
  ]);
  bracket = await readFile(await download.path());
  await page.close();
});

/** Open the viewer and collect page errors. */
async function openViewer(page: Page, hash = ''): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`/viewer.html${hash}`);
  await expect(page.getByTestId('viewer-canvas')).toBeVisible();
  return errors;
}

/** Serve `body` at `path` on the bundle origin, with CORS for the viewer. */
async function serveBundle(page: Page, path: string, body: Buffer, seen?: string[][]) {
  await page.route(`${BUNDLE_ORIGIN}${path}`, async (route) => {
    seen?.push(Object.keys(route.request().headers()).map((h) => h.toLowerCase()));
    await route.fulfill({
      status: 200,
      body,
      headers: { 'content-type': MIME, 'access-control-allow-origin': '*' },
    });
  });
}

async function expectBracket(page: Page) {
  await expect(page.getByTestId('viewer-error')).toHaveCount(0);
  await expect(page.getByTestId('viewer-bodies').locator('li')).toHaveCount(1);
  await page.waitForFunction(
    () => (window.__manufakture?.viewport.info().bodies.length ?? 0) === 1,
  );
  const info = await page.evaluate(() => window.__manufakture!.viewport.info().bodies[0]!);
  expect(info.faces).toBe(15);
  expect(info.triangles).toBeGreaterThan(100);
  await expect(page.getByTestId('viewer-size')).toHaveText(
    new RegExp(
      `^X ${BRACKET.length}\\.0+ mm, Y ${BRACKET.width}\\.0+ mm, Z ${BRACKET.height}\\.0+ mm$`,
    ),
  );
}

test('opens the bracket from a file, toggles it and measures on it', async ({ page }) => {
  const errors = await openViewer(page);
  await page
    .getByTestId('viewer-file')
    .setInputFiles({ name: 'Bracket.mfkview', mimeType: MIME, buffer: bracket });
  await expectBracket(page);
  await expect(page.getByTestId('viewer-open-app')).toBeVisible();

  // Hide and show the one body.
  const toggle = page.getByTestId('viewer-bodies').getByRole('checkbox');
  await toggle.uncheck();
  await page.waitForFunction(() => window.__manufakture!.viewport.info().bodies.length === 0);
  await expect(page.getByTestId('viewer-size')).toHaveText('Nothing shown');
  await toggle.check();
  await page.waitForFunction(() => window.__manufakture!.viewport.info().bodies.length === 1);
  await settle(page);

  // Two points 20 mm apart across the foot's top face (z = 6, clear of the holes and the fillet).
  await page.getByTestId('viewer-measure').click();
  for (const p of [
    [15, -10, 6],
    [15, 10, 6],
  ] as const) {
    const { x, y } = await page.evaluate(
      (q) => window.__manufakture!.viewport.projectToClient(q),
      p as unknown as [number, number, number],
    );
    await page.mouse.click(x, y);
  }
  await expect(page.getByTestId('viewer-distance')).toHaveText(
    /^20\.00 mm \(X 0\.00 mm, Y 20\.00 mm/,
  );
  expect(errors).toEqual([]);
});

test('opens the bracket from a link, sending no cookies', async ({ page }) => {
  const seen: string[][] = [];
  await serveBundle(page, '/shares/bracket.mfkview', bracket, seen);
  const errors = await openViewer(page, `#src=${BUNDLE_ORIGIN}/shares/bracket.mfkview`);
  await expectBracket(page);
  expect(seen).toHaveLength(1);
  expect(seen[0]).not.toContain('cookie');
  expect(seen[0]).not.toContain('referer');
  expect(errors).toEqual([]);
});

test('Open in manufakture imports the source in a new app tab', async ({ page, context }) => {
  test.setTimeout(180_000);
  await openViewer(page);
  await page
    .getByTestId('viewer-file')
    .setInputFiles({ name: 'Bracket.mfkview', mimeType: MIME, buffer: bracket });
  await expectBracket(page);
  const [app] = await Promise.all([
    context.waitForEvent('page'),
    page.getByTestId('viewer-open-app').click(),
  ]);
  await expect(app.getByTestId('io-status')).toHaveText(/^Imported .+\.mfk as /, {
    timeout: 120_000,
  });
  // The token is gone from the address bar once used.
  expect(new URL(app.url()).hash).toBe('');
});

test('a damaged bundle shows an error', async ({ page }) => {
  const errors = await openViewer(page);
  const damaged = Buffer.from(bracket);
  // Keep the zip's directory but break the manifest's compressed bytes.
  damaged.fill(0x55, 40, 200);
  await page
    .getByTestId('viewer-file')
    .setInputFiles({ name: 'damaged.mfkview', mimeType: MIME, buffer: damaged });
  await expect(page.getByTestId('viewer-error')).toBeVisible();
  await page
    .getByTestId('viewer-file')
    .setInputFiles({ name: 'not-a-view.mfkview', mimeType: MIME, buffer: Buffer.from('hello') });
  await expect(page.getByTestId('viewer-error')).toHaveText(/manufakture view|damaged|zip/i);
  await expect(page.getByTestId('viewer-bodies')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('an oversized bundle shows an error, from a link and from a file', async ({ page }, info) => {
  const big = Buffer.alloc(65 * 1024 * 1024);
  await serveBundle(page, '/big.mfkview', big);
  const errors = await openViewer(page, `#src=${BUNDLE_ORIGIN}/big.mfkview`);
  await expect(page.getByTestId('viewer-error')).toHaveText(/larger than 64 MB/);
  const path = info.outputPath('big.mfkview');
  await writeFile(path, big);
  await page.getByTestId('viewer-file').setInputFiles(path);
  await expect(page.getByTestId('viewer-error')).toHaveText(/larger than 64 MB/);
  expect(errors).toEqual([]);
});

test('a plain http link to another host is refused', async ({ page }) => {
  await openViewer(page, '#src=http://example.com/a.mfkview');
  await expect(page.getByTestId('viewer-error')).toHaveText(/must start with https/);
});

test('the viewer loads no kernel, solver or editor code and stays under its budget', async ({
  page,
}) => {
  const scripts: { url: string; body: Buffer }[] = [];
  page.on('response', async (r) => {
    if (r.request().resourceType() !== 'script') return;
    scripts.push({ url: r.url(), body: await r.body() });
  });
  await openViewer(page);
  await page.waitForLoadState('networkidle');
  const names = scripts.map((s) => new URL(s.url).pathname);
  expect(names.length).toBeGreaterThan(0);
  for (const n of names) {
    expect(n).not.toMatch(/opencascade|planegcs|manifold|regen|worker|main-|kernel|sketch/);
  }
  const gzip = scripts.reduce((sum, s) => sum + gzipSync(s.body, { level: 9 }).length, 0);
  console.log(`viewer JavaScript: ${names.length} files, ${(gzip / 1024).toFixed(1)} KiB gzip`);
  expect(gzip).toBeLessThanOrEqual(VIEWER_JS_BUDGET_GZIP);
});
