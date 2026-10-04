import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { bodyVolume, regenerated } from './bracket';
import {
  APP_DIR,
  installed,
  optIn,
  startHost,
  V2_REVISION,
  workerBuild,
  type Host,
} from './pwa-host';
import { newSketch, rectangle } from './sketch-helpers';

// The installable, offline app (T7.4a): the service worker precaches the build, the app opens
// and regenerates with no network after one visit, an update is picked up through the Reload
// offer, and the kill switch takes the worker off again.
//
// These tests do not use the `vite preview` server Playwright starts. They serve the same build
// (dist/e2e-app, made by the webServer step) from a small server of their own, so that they can
// (a) serve it as a real host would: hashed assets `immutable`, the kernel's .wasm brotli
// compressed, COOP and COEP on every response; (b) go down while the browser is offline, so a
// request that reached the network would show; and (c) switch to a "newer" build or to the kill
// switch at the same URLs. Playwright's routing does not see a service worker's own script
// fetches (its update checks), so routing could not do (c).
//
// The host is in pwa-host.ts. The service worker registers in this end-to-end build only when a
// test opts in (src/pwa/register.ts): every other spec runs without it.
//
// Measured here (Chromium 153 headless, localhost, numbers in docs/hosting.md and printed by the
// "measures" test): what Cache Storage holds for the kernel when it was sent brotli compressed,
// and the start-up time with the build in Cache Storage against the HTTP cache.

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
  host.whileDown = [];
  host.requests.clear();
});

/** A context on our host; `sw` opts in to the service worker. */
async function newContext(browser: Browser, sw: boolean): Promise<BrowserContext> {
  const context = await browser.newContext({ baseURL: host.url });
  if (sw) await optIn(context);
  return context;
}

/** Milliseconds from navigation start until the kernel is ready and the first model shown. */
async function readyAt(page: Page): Promise<number> {
  const handle = await page.waitForFunction(
    () => {
      const hooks = window.__manufakture;
      const ready =
        !!hooks?.model &&
        hooks.model.getState().generation > 0 &&
        !hooks.model.getState().pending &&
        document.querySelector('[data-testid="splash"]') === null;
      return ready ? performance.now() : 0;
    },
    null,
    { timeout: 120_000, polling: 50 },
  );
  return (await handle.jsonValue()) as number;
}

async function saved(page: Page) {
  await expect(page.getByTestId('save-status')).toHaveText('Saved', { timeout: 15_000 });
}

test('after one visit the app opens, opens a stored document and regenerates it offline', async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const context = await newContext(browser, true);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await installed(page);

  // The navigation response came from the host with COOP/COEP, and keeps them from the cache.
  const cached = await page.evaluate(async () => {
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      for (const key of await cache.keys()) {
        if (!new URL(key.url).pathname.endsWith('/index.html')) continue;
        const r = (await cache.match(key))!;
        return {
          coop: r.headers.get('cross-origin-opener-policy'),
          coep: r.headers.get('cross-origin-embedder-policy'),
        };
      }
    }
    return null;
  });
  expect(cached).toEqual({ coop: 'same-origin', coep: 'require-corp' });

  // A 40 x 25 x 15 block, saved.
  await newSketch(page, 'Top (XY)');
  await rectangle(page, [0, 0], [40, 25]);
  await page.getByRole('button', { name: 'Finish sketch' }).click();
  await page.getByTestId('feature-sketch#1').click();
  await page
    .getByRole('toolbar', { name: 'Features' })
    .getByRole('button', { name: 'Extrude' })
    .click();
  await page.getByTestId('field-distance').fill('15');
  await page.getByTestId('dialog-ok').click();
  await regenerated(page);
  await saved(page);
  expect(await bodyVolume(page)).toBeCloseTo(40 * 25 * 15, 6);
  const id = await page.evaluate(() => window.__manufakture!.document.getState().document.id);

  // Offline, with the host down too: start the app afresh. It opens the most recent document
  // from storage and regenerates it with the kernel that came out of Cache Storage.
  await context.setOffline(true);
  host.down = true;
  await page.goto('/');
  await expect(page.getByTestId('document-name')).toHaveText('Untitled', { timeout: 90_000 });
  await regenerated(page);
  expect(await bodyVolume(page)).toBeCloseTo(40 * 25 * 15, 6);
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);

  // Switch to a new document, then open the stored one again from the home screen.
  await page.getByTestId('open-home').click();
  await page.getByRole('button', { name: 'New document' }).click();
  await expect(page.getByTestId('empty-hint')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('open-home').click();
  await page.getByTestId(`doc-${id}`).getByRole('button', { name: 'Untitled' }).click();
  await expect
    .poll(() => page.evaluate(() => window.__manufakture!.document.getState().document.id))
    .toBe(id);
  await regenerated(page);
  expect(await bodyVolume(page)).toBeCloseTo(40 * 25 * 15, 6);

  // And it can still be changed and regenerated: extrude 20 instead of 15.
  await page.getByTestId('feature-extrude#1').dblclick();
  await page.getByTestId('field-distance').fill('20');
  await page.getByTestId('dialog-ok').click();
  await regenerated(page);
  expect(await bodyVolume(page)).toBeCloseTo(40 * 25 * 20, 6);
  await saved(page);

  // Nothing the app loads reached the host while it was down. The only requests are the
  // browser's own update checks of sw.js, which Playwright's offline mode does not cover and
  // which fail harmlessly (the installed worker stays).
  expect(host.whileDown.filter((p) => p !== '/sw.js')).toEqual([]);
  expect(errors).toEqual([]);
  await context.close();
});

test('a new version is offered once saved, and Reload picks it up', async ({ browser }) => {
  test.setTimeout(240_000);
  const context = await newContext(browser, true);
  const page = await context.newPage();
  await installed(page);
  const before = await workerBuild(page);
  expect(before).toMatch(/^[0-9a-f]{32}$/);
  await expect(page.locator('meta[name="manufakture-e2e-build"]')).toHaveCount(0);

  // A newer build appears on the host; the next navigation finds it. A change is waiting for
  // autosave: the offer comes only after it is saved.
  host.variant = 'v2';
  await page.reload();
  await expect(page.getByTestId('empty-hint')).toBeVisible({ timeout: 90_000 });
  await page.evaluate(() =>
    window
      .__manufakture!.document.getState()
      .execute({ type: 'renameDocument', name: 'Before the update' }, 'Rename document'),
  );
  const offer = page.getByTestId('pwa-update');
  await expect(offer).toContainText('A new version of manufakture is ready', { timeout: 60_000 });
  await expect(page.getByTestId('save-status')).toHaveText('Saved');
  // Still the old build until the user chooses.
  expect(await workerBuild(page)).toBe(before);

  await offer.getByRole('button', { name: 'Reload' }).click();
  await expect(page.locator('meta[name="manufakture-e2e-build"]')).toHaveAttribute(
    'content',
    'v2',
    { timeout: 60_000 },
  );
  await expect(page.getByTestId('document-name')).toHaveText('Before the update', {
    timeout: 90_000,
  });
  expect(await workerBuild(page)).toBe(V2_REVISION);
  await context.close();
});

test('the kill switch removes the worker and its caches', async ({ browser }) => {
  test.setTimeout(240_000);
  const context = await newContext(browser, true);
  const page = await context.newPage();
  await installed(page);
  expect(await page.evaluate(async () => (await caches.keys()).length)).toBeGreaterThan(0);

  host.variant = 'kill';
  await page.reload();
  await expect
    .poll(() => page.evaluate(async () => (await caches.keys()).length), { timeout: 60_000 })
    .toBe(0);
  // The app still loads, from the network, and stores nothing again. (It registers sw.js on
  // every load, which now installs the kill switch, which removes itself again.)
  await page.reload();
  await expect(page.getByTestId('empty-hint')).toBeVisible({ timeout: 90_000 });
  await page.waitForTimeout(2000);
  expect(await page.evaluate(async () => (await caches.keys()).length)).toBe(0);
  // Nothing answers from a cache any more: offline, the app does not open.
  await context.setOffline(true);
  await expect(page.reload()).rejects.toThrow(/ERR_INTERNET_DISCONNECTED/);
  await context.close();
});

test('measures: Cache Storage bytes for the kernel, start-up from Cache Storage and HTTP cache', async ({
  playwright,
  launchOptions,
}, testInfo) => {
  test.setTimeout(400_000);
  // Persistent profiles: an ordinary (incognito-like) Playwright context keeps its HTTP cache in
  // memory, too small to hold the 42.7 MB kernel at all, so every reload would fetch it again and
  // the comparison would be meaningless. A profile on disk caches it as a user's browser does.
  const profiles: string[] = [];
  const persistent = async (sw: boolean): Promise<BrowserContext> => {
    const dir = await mkdtemp(join(tmpdir(), 'mfk-pwa-profile-'));
    profiles.push(dir);
    const context = await playwright.chromium.launchPersistentContext(dir, {
      ...launchOptions,
      baseURL: host.url,
      viewport: { width: 1280, height: 800 },
    });
    if (sw) await optIn(context);
    return context;
  };
  const runs = 5;
  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

  // Cache Storage: what the worker stored for the kernel, which the host sent brotli compressed.
  const swContext = await persistent(true);
  const swPage = swContext.pages()[0] ?? (await swContext.newPage());
  await installed(swPage);
  // How often the kernel was fetched from the host on that first visit: once by the kernel
  // worker; the service worker's precache then finds it in the HTTP cache (`immutable`), since it
  // registers only once the app has started (src/pwa/startup.ts).
  const kernelFetches = [...host.requests.entries()]
    .filter(([p]) => /opencascade_single-.+\.wasm$/.test(p))
    .reduce((n, [, c]) => n + c, 0);
  const storage = await swPage.evaluate(async () => {
    let kernel: { stored: number; contentLength: string | null; encoding: string | null } | null =
      null;
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      for (const key of await cache.keys()) {
        if (!/opencascade_single-[\w-]+\.wasm$/.test(key.url)) continue;
        const r = (await cache.match(key))!;
        kernel = {
          stored: (await r.arrayBuffer()).byteLength,
          contentLength: r.headers.get('content-length'),
          encoding: r.headers.get('content-encoding'),
        };
      }
    }
    const estimate = await navigator.storage.estimate();
    const details = (estimate as { usageDetails?: { caches?: number } }).usageDetails;
    return { kernel, caches: details?.caches ?? null };
  });
  const brotliBytes = [...host.compressed.entries()].find(([p]) =>
    p.includes('opencascade_single'),
  )?.[1];
  expect(kernelFetches).toBe(1);
  expect(storage.kernel).not.toBeNull();
  expect(storage.kernel!.encoding).toBe('br');
  expect(brotliBytes).toBeGreaterThan(0);

  // Start-up with the build in Cache Storage (the worker answers everything, online).
  const fromCacheStorage: number[] = [];
  for (let i = 0; i < runs; i++) {
    await swPage.reload();
    fromCacheStorage.push(await readyAt(swPage));
  }
  // The same, offline.
  await swContext.setOffline(true);
  const offline: number[] = [];
  for (let i = 0; i < runs; i++) {
    await swPage.reload();
    offline.push(await readyAt(swPage));
  }
  await swContext.close();

  // Start-up from the HTTP cache: no worker, assets `immutable`, after one visit.
  const httpContext = await persistent(false);
  const httpPage = httpContext.pages()[0] ?? (await httpContext.newPage());
  await httpPage.goto('/');
  const firstVisit = await readyAt(httpPage);
  const fromHttpCache: number[] = [];
  host.requests.clear();
  for (let i = 0; i < runs; i++) {
    await httpPage.reload();
    fromHttpCache.push(await readyAt(httpPage));
  }
  expect(await httpPage.evaluate(() => navigator.serviceWorker.controller)).toBeNull();
  // The reloads really were served from the HTTP cache: the kernel was not fetched again.
  const kernelRefetches = [...host.requests.keys()].filter((p) =>
    /opencascade_single-.+\.wasm$/.test(p),
  ).length;
  expect(kernelRefetches).toBe(0);
  await httpContext.close();
  for (const dir of profiles) await rm(dir, { recursive: true, force: true });

  const kernelFile = (await readdir(join(APP_DIR, 'assets'))).find((f) =>
    /^opencascade_single-.+\.wasm$/.test(f),
  )!;
  const raw = (await stat(join(APP_DIR, 'assets', kernelFile))).size;
  // Chromium stores the decoded body: the full raw size, not what went over the wire.
  expect(storage.kernel!.stored).toBe(raw);

  const measures = {
    kernelWasm: {
      raw,
      brotliSentQuality5: brotliBytes,
      storedInCacheStorage: storage.kernel!.stored,
      storedContentLength: storage.kernel!.contentLength,
      storedContentEncoding: storage.kernel!.encoding,
    },
    kernelFetchesOnFirstVisit: kernelFetches,
    cacheStorageTotalBytes: storage.caches,
    startupMs: {
      firstVisitNoCache: Math.round(firstVisit),
      httpCacheMedian: Math.round(median(fromHttpCache)),
      cacheStorageMedian: Math.round(median(fromCacheStorage)),
      cacheStorageOfflineMedian: Math.round(median(offline)),
      runs: {
        httpCache: fromHttpCache.map(Math.round),
        cacheStorage: fromCacheStorage.map(Math.round),
        offline: offline.map(Math.round),
      },
    },
  };
  console.log('PWA measures', JSON.stringify(measures, null, 2));
  await testInfo.attach('pwa-measures.json', {
    body: JSON.stringify(measures, null, 2),
    contentType: 'application/json',
  });
});
