import { expect, test, type BrowserContext } from '@playwright/test';
import { bracketVolume, buildBracket, editVariable } from './bracket';
import {
  docShot,
  expectVolume,
  newContext,
  outcomes,
  recordBudget,
  saved,
  variableValue,
} from './m7-fixtures';
import { installed, optIn, startHost, type Host } from './pwa-host';

// M7 acceptance, chapter 4: the installed app offline (docs/m7-acceptance.md; the M7 plan, T7.5).
// The build is served from the switchable host of pwa-host.ts (as offline.spec.ts does), with the
// service worker opted in. After one visit the worker has precached the app; the M1 bracket is
// built and saved; then the browser goes offline and the host goes down, and the app starts
// afresh, opens the bracket from storage, regenerates it, and takes an edit, which is saved. No
// request of the app reaches the host meanwhile.

let host: Host;

test.beforeAll(async () => {
  host = await startHost();
});

test.afterAll(async () => {
  await host?.close();
});

let context: BrowserContext | undefined;

// Closed and the host up again after the test, whether it passed or not.
test.afterEach(async () => {
  await context?.close();
  context = undefined;
  if (host) host.down = false;
});

test('after install the app starts, regenerates and edits the bracket offline', async ({
  browser,
}) => {
  test.setTimeout(400_000);
  context = await newContext(browser, { baseURL: host.url });
  await optIn(context);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await installed(page);
  await buildBracket(page);
  await saved(page);
  const id = await page.evaluate(() => window.__manufakture!.document.getState().document.id);

  // Offline, and the host down too (Playwright's offline mode does not cover the worker's own
  // update checks): start the app afresh.
  await context.setOffline(true);
  host.down = true;
  host.whileDown = [];
  const t0 = performance.now();
  await page.goto('/');
  await expect
    .poll(
      () => page.evaluate(() => window.__manufakture?.document?.getState().document.id ?? null),
      {
        timeout: 90_000,
      },
    )
    .toBe(id);
  const statuses = await outcomes(page);
  const startMs = performance.now() - t0;
  expect(Object.values(statuses).map((s) => s.status)).toEqual(Array(5).fill('ok'));
  await expectVolume(page, bracketVolume(6));
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
  await expect(page.getByTestId('offline-indicator')).toHaveText('Offline');

  // An edit offline: 8 mm walls, regenerated and saved.
  await editVariable(page, 'thickness', '8');
  await expect(variableValue(page, 'thickness')).toHaveText('8.00 mm');
  await expectVolume(page, bracketVolume(8));
  await saved(page);
  await docShot(page, '09-offline');

  // It is still there after another offline start.
  await page.reload();
  await expect(variableValue(page, 'thickness')).toHaveText('8.00 mm', { timeout: 90_000 });
  await expectVolume(page, bracketVolume(8));

  // Nothing the app loads reached the host while it was down; only the browser's own update
  // checks of sw.js, which fail harmlessly.
  expect(host.whileDown.filter((p) => p !== '/sw.js')).toEqual([]);
  await recordBudget('offlineStartMs', {
    what: 'installed app, offline with the host down: navigation until the stored bracket is regenerated',
    total: Math.round(startMs),
  });
  expect(errors).toEqual([]);
});
