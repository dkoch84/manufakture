import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { openEmpty } from './bracket';
import {
  BOLT_CIRCLE,
  bodySummary,
  boltCircleVolume,
  docShot,
  expectVolume,
  newContext,
  openFromServer,
  outcomes,
  recordBudget,
  saved,
  scriptStats,
  startServer,
  startSyncing,
  synced,
  writeScript,
  type M7Server,
} from './m7-fixtures';

// M7 acceptance, chapter 2: a scripted feature across two browsers (docs/m7-acceptance.md; the
// M7 plan, T7.5). Browser 1 writes the bolt-circle example of docs/user/scripting.md in the script
// editor (so it is allowed there, as saved) and inserts it with 8 holes, in a synced document.
// Browser 2 opens the document from the server: its scripts arrived by sync, so they do not run
// there (T7.2d) and the feature reports "Scripts not run", with the worker running nothing, until
// browser 2 chooses Run scripts. Then both browsers have the same body, and a change of the hole
// count in browser 1 regenerates identically in both. Running scripts automatically stays locked
// off until the security sign-off (SCRIPTS_SECURITY_SIGNED_OFF in src/scripts/policy.ts).

test.describe.configure({ mode: 'serial' });

const FEATURE = 'scripted#1';

let server: M7Server;
let ctx1: BrowserContext;
let ctx2: BrowserContext;
let page1: Page;
let page2: Page;

test.beforeAll(async ({ baseURL, browser }) => {
  server = await startServer(baseURL!);
  ctx1 = await newContext(browser);
  ctx2 = await newContext(browser);
  page1 = await ctx1.newPage();
  page2 = await ctx2.newPage();
});

test.afterAll(async () => {
  await ctx1?.close();
  await ctx2?.close();
  await server?.close();
});

/** Wait until `page` built the scripted feature, and return its result. */
async function built(page: Page) {
  await expect
    .poll(async () => (await outcomes(page))[FEATURE]?.status ?? null, { timeout: 90_000 })
    .toBe('ok');
  return (await outcomes(page))[FEATURE]!;
}

test('a scripted bolt circle runs in one browser, and in the other only after Run scripts', async () => {
  test.setTimeout(400_000);
  const errors1 = await openEmpty(page1);
  const errors2 = await openEmpty(page2);
  // Until the security sign-off, running scripts automatically cannot be turned on.
  for (const page of [page1, page2]) {
    await expect(page.getByTestId('scripts-auto')).toBeDisabled();
    await expect(page.getByTestId('scripts-auto')).not.toBeChecked();
  }

  // Browser 1: a synced document, the script written in the editor, inserted with 8 holes.
  const docId = await startSyncing(page1, server);
  await writeScript(page1, 'Bolt circle', BOLT_CIRCLE);
  await page1
    .getByRole('toolbar', { name: 'Features' })
    .getByRole('button', { name: 'Scripted', exact: true })
    .click();
  await expect(page1.getByTestId('feature-dialog')).toBeVisible();
  await expect(page1.getByTestId('field-param-count')).toHaveValue('6', { timeout: 30_000 });
  await page1.getByTestId('field-param-count').fill('8');
  const t0 = performance.now();
  await page1.getByTestId('dialog-ok').click();
  await expect(page1.getByTestId('feature-dialog')).toBeHidden();
  const first1 = await built(page1);
  const insertMs = performance.now() - t0;
  await expect(page1.getByTestId('scripts-banner')).toBeHidden();
  await expectVolume(page1, boltCircleVolume(8));
  const body1 = await bodySummary(page1);
  await saved(page1);
  await synced(page1);
  await docShot(page1, '04-script-inserted');

  // Browser 2 opens it from the server: the scripts do not run there.
  await openFromServer(page2, server, docId);
  const statsBefore = await scriptStats(page2);
  const banner = page2.getByTestId('scripts-banner');
  await expect(banner).toBeVisible({ timeout: 60_000 });
  await expect(banner).toContainText('Scripted 1: script Bolt circle');
  await expect(page2.getByTestId(`script-mark-${FEATURE}`)).toHaveText('Script: Bolt circle');
  const blocked = (await outcomes(page2))[FEATURE]!;
  expect(blocked.status).toBe('error');
  expect(blocked.errors[0]).toMatchObject({ scriptCode: 'not-allowed' });
  expect(blocked.errors[0]!.message).toMatch(/^Scripts not run/);
  expect(statsBefore?.runs ?? 0).toBe(0);
  expect((await scriptStats(page2))?.runs ?? 0).toBe(0);
  await docShot(page2, '05-scripts-not-run');

  // Run scripts: browser 2 builds the same body as browser 1.
  const t1 = performance.now();
  await page2.getByTestId('run-scripts').click();
  await expect(banner).toBeHidden();
  const first2 = await built(page2);
  const allowMs = performance.now() - t1;
  expect((await scriptStats(page2))!.runs).toBeGreaterThan(0);
  await expectVolume(page2, boltCircleVolume(8));
  const body2 = await bodySummary(page2);
  expect(body2).toEqual(body1);
  expect(first2.key).toBe(first1.key);
  await docShot(page2, '06-scripts-run');

  // Browser 1 makes it 12 holes; browser 2 follows and builds it identically, without asking.
  await page1.getByTestId(`feature-${FEATURE}`).dblclick();
  await page1.getByTestId('field-param-count').fill('12');
  const t2 = performance.now();
  await page1.getByTestId('dialog-ok').click();
  await expect(page1.getByTestId('feature-dialog')).toBeHidden();
  await expectVolume(page1, boltCircleVolume(12));
  const rerunMs = performance.now() - t2;
  const again1 = (await outcomes(page1))[FEATURE]!;
  expect(again1.status).toBe('ok');
  await synced(page1);
  await expectVolume(page2, boltCircleVolume(12));
  const again2 = (await outcomes(page2))[FEATURE]!;
  expect(again2.status).toBe('ok');
  expect(again2.key).toBe(again1.key);
  await expect(banner).toBeHidden();
  expect(await bodySummary(page2)).toEqual(await bodySummary(page1));
  await synced(page2);

  await recordBudget('scriptRunMs', {
    what: 'the bolt-circle script (8, then 12 holes): regen time of the scripted feature, and wall clock from OK or Run scripts to the built body',
    regenFeatureMs: {
      browser1FirstRun: Math.round(first1.ms),
      browser2AfterRunScripts: Math.round(first2.ms),
      browser1TwelveHoles: Math.round(again1.ms),
      browser2TwelveHoles: Math.round(again2.ms),
    },
    wallClockMs: {
      insertToBuilt: Math.round(insertMs),
      runScriptsToBuilt: Math.round(allowMs),
      editToVolume: Math.round(rerunMs),
    },
  });
  expect([...errors1, ...errors2]).toEqual([]);
});
