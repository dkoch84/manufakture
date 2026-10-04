import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { installed, optIn, startHost, V2_REVISION, workerBuild, type Host } from './pwa-host';

// Offline behaviour over time (T7.4b): an old app meeting a newer document, and two tabs on
// different builds. Served from the switchable host of pwa-host.ts (as offline.spec.ts is), with
// the service worker opted in.
//
// - A document saved by a newer version is refused (ADR 0004 decision 2), and the home screen
//   offers to update the app: "Update the app" finds nothing while the host has nothing newer,
//   then, once it has, offers Reload, which loads the new build.
// - Tab A picks up a new version with Reload; the new worker then controls tab B too, which still
//   runs the old build. B does not reload by itself, and offers Reload ("updated in another tab"),
//   which loads the new build in B.

let host: Host;
test.beforeAll(async () => {
  host = await startHost();
});
test.afterAll(async () => {
  await host.close();
});
test.beforeEach(() => {
  host.variant = 'v1';
  host.down = false;
});

async function newContext(browser: Browser): Promise<BrowserContext> {
  const context = await browser.newContext({ baseURL: host.url });
  await optIn(context);
  return context;
}

async function saved(page: Page) {
  await expect(page.getByTestId('save-status')).toHaveText('Saved', { timeout: 15_000 });
}

/** Whether the page runs the newer build (`v2` marks its index.html). */
const isV2 = (page: Page) => page.locator('meta[name="manufakture-e2e-build"]');

/**
 * Make the stored document `id` look saved by a far newer version: every snapshot of it gets
 * file format 999. Its head stays, so it is listed (and opened at start-up) as before.
 */
async function makeNewer(page: Page, id: string): Promise<number> {
  return page.evaluate(async (docId) => {
    const root = await navigator.storage.getDirectory();
    const dir = await (await root.getDirectoryHandle('documents')).getDirectoryHandle(docId);
    let changed = 0;
    for await (const [name, handle] of dir as unknown as AsyncIterable<
      [string, FileSystemHandle]
    >) {
      if (!/^snapshot-\d+\.json$/.test(name) || handle.kind !== 'file') continue;
      const file = handle as FileSystemFileHandle;
      const json = JSON.parse(await (await file.getFile()).text()) as { version: number };
      json.version = 999;
      const w = await file.createWritable();
      await w.write(JSON.stringify(json));
      await w.close();
      changed++;
    }
    return changed;
  }, id);
}

test('an old app meets a document saved by a newer one, and offers the update', async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const context = await newContext(browser);
  const page = await context.newPage();
  await installed(page);
  await page.evaluate(() =>
    window
      .__manufakture!.document.getState()
      .execute({ type: 'renameDocument', name: 'From the future' }, 'Rename document'),
  );
  await saved(page);
  const id = await page.evaluate(() => window.__manufakture!.document.getState().document.id);
  expect(await makeNewer(page, id)).toBeGreaterThan(0);

  // Start the app again: it opens the document from the URL, which it refuses, never changing
  // it, and the home screen says why and offers to update.
  await page.reload();
  const status = page.getByTestId('home-status');
  await expect(status).toContainText('saved by a newer version of manufakture (file format 999', {
    timeout: 90_000,
  });
  const notice = status.getByTestId('update-needed');
  await expect(notice).toContainText('This document needs a newer version of manufakture');

  // The host has nothing newer yet.
  await notice.getByRole('button', { name: 'Update the app' }).click();
  await expect(notice.getByTestId('update-needed-result')).toContainText(
    'There is no newer version on this site yet',
    { timeout: 30_000 },
  );

  // Offline, the note in the corner says so, and the check cannot reach the host. (Playwright's
  // offline mode does not cover a worker's own update fetches, so the host goes down too.)
  await context.setOffline(true);
  host.down = true;
  await expect(page.getByTestId('offline-indicator')).toHaveText('Offline');
  await notice.getByRole('button', { name: 'Try again' }).click();
  await expect(notice.getByTestId('update-needed-result')).toContainText('cannot reach its site', {
    timeout: 30_000,
  });
  await context.setOffline(false);
  host.down = false;
  await expect(page.getByTestId('offline-indicator')).toHaveCount(0);

  // A newer build is published: found, installed, then Reload loads it.
  host.variant = 'v2';
  await notice.getByRole('button', { name: 'Try again' }).click();
  await expect(notice.getByTestId('update-needed-result')).toContainText(
    'A new version is ready. Your changes are saved.',
    { timeout: 60_000 },
  );
  await expect(isV2(page)).toHaveCount(0);
  await notice.getByRole('button', { name: 'Reload' }).click();
  await expect(isV2(page)).toHaveAttribute('content', 'v2', { timeout: 60_000 });
  expect(await workerBuild(page)).toBe(V2_REVISION);
  await context.close();
});

test('after another tab updates, this tab is offered Reload instead of running on', async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const context = await newContext(browser);
  const a = await context.newPage();
  await installed(a);
  const b = await context.newPage();
  await b.goto('/');
  await expect(b.getByTestId('empty-hint')).toBeVisible({ timeout: 90_000 });
  await b.waitForFunction(() => navigator.serviceWorker.controller !== null);
  const before = await workerBuild(b);
  // A marker that survives only as long as B is not reloaded.
  await b.evaluate(() => {
    (window as unknown as { __notReloaded: boolean }).__notReloaded = true;
  });

  // A newer build appears; tab A finds it and picks it up with Reload.
  host.variant = 'v2';
  await a.reload();
  const offerA = a.getByTestId('pwa-update');
  await expect(offerA).toContainText('A new version of manufakture is ready', { timeout: 60_000 });
  await offerA.getByRole('button', { name: 'Reload' }).click();
  await expect(isV2(a)).toHaveAttribute('content', 'v2', { timeout: 60_000 });

  // The new worker now controls B, which still runs the old build: B offers Reload, saying why.
  const offerB = b.getByTestId('pwa-update');
  await expect(offerB).toHaveAttribute('data-reason', 'other-tab', { timeout: 30_000 });
  await expect(offerB).toContainText('manufakture was updated in another tab.');
  expect(await workerBuild(b)).toBe(V2_REVISION);
  expect(before).not.toBe(V2_REVISION);
  expect(
    await b.evaluate(() => (window as unknown as { __notReloaded?: boolean }).__notReloaded),
  ).toBe(true);
  await expect(isV2(b)).toHaveCount(0);

  await offerB.getByRole('button', { name: 'Reload' }).click();
  await expect(isV2(b)).toHaveAttribute('content', 'v2', { timeout: 60_000 });
  await expect(b.getByTestId('empty-hint')).toBeVisible({ timeout: 90_000 });
  await context.close();
});
