import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { bracketVolume, buildBracket, editVariable, openEmpty } from './bracket';
import {
  docShot,
  exec,
  expectVolume,
  features,
  median,
  newContext,
  openFromServer,
  openSyncPanel,
  recordBudget,
  roundTrip,
  saved,
  serverLog,
  startServer,
  startSyncing,
  synced,
  syncHook,
  variableValue,
  type M7Server,
} from './m7-fixtures';

// M7 acceptance, chapter 1: sync (docs/m7-acceptance.md; the M7 plan, T7.5). A server started by
// the suite and two browser contexts, which are two browsers as far as storage goes. Browser 1
// builds the M1 bracket through the UI and syncs it; browser 2 opens it from the server. Edits
// travel both ways (the sync round trip is measured); browser 2 goes offline and makes the walls
// 8 mm while browser 1 renames a feature, and both converge; browser 2 queues 100 edits offline
// and rebases them over browser 1's edit when it is back (measured); and one conflict, a rename
// of a feature the other browser deleted, gives its notice and keeps the work as a branch.

test.describe.configure({ mode: 'serial' });

let server: M7Server;
let ctx1: BrowserContext;
let ctx2: BrowserContext;
let page1: Page;
let page2: Page;
let docId: string;
/** Page errors of each browser, collected as they happen. */
const errors: string[][] = [];

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

const rename = (featureId: string, name: string) => ({
  type: 'renameFeature',
  partId: 'part#1',
  featureId,
  name,
});

/** Whether the page's document has a feature called `name` (runs in the page). */
const hasFeatureNamed = (name: string) =>
  window
    .__manufakture!.document.getState()
    .document.parts[0]!.features.some((f) => f.name === name);

test('two browsers sync the M1 bracket; edits travel both ways', async () => {
  test.setTimeout(400_000);
  errors.push(await openEmpty(page1));
  await buildBracket(page1);
  await saved(page1);
  docId = await startSyncing(page1, server);
  // The upload is the document as it was: a snapshot, no entries yet.
  expect(serverLog(server, docId)).toHaveLength(0);
  await docShot(page1, '01-sync-panel');

  errors.push(await openEmpty(page2));
  await openFromServer(page2, server, docId);
  expect(await features(page2)).toEqual(await features(page1));
  await expect(variableValue(page2, 'thickness')).toHaveText('6.00 mm', { timeout: 90_000 });
  await expectVolume(page2, bracketVolume(6));

  // Round trips, each way: a rename in one browser, until the other shows it.
  const oneWay: number[] = [];
  const otherWay: number[] = [];
  for (let i = 1; i <= 5; i++) {
    oneWay.push(
      await roundTrip(
        () => exec(page1, rename('sketch#1', `Profile ${i}`), `Rename ${i}`),
        page2,
        hasFeatureNamed,
        `Profile ${i}`,
      ),
    );
    otherWay.push(
      await roundTrip(
        () => exec(page2, rename('sketch#2', `Hole centres ${i}`), `Rename back ${i}`),
        page1,
        hasFeatureNamed,
        `Hole centres ${i}`,
      ),
    );
  }
  await synced(page1);
  await synced(page2);
  expect(await features(page2)).toEqual(await features(page1));
  await recordBudget('syncRoundTripMs', {
    what: 'a rename in one browser until the other shows it (push, server, other browser)',
    median: Math.round(median([...oneWay, ...otherWay])),
    max: Math.round(Math.max(...oneWay, ...otherWay)),
    runs: [...oneWay, ...otherWay].map(Math.round),
  });
});

test('browser 2 edits offline while browser 1 edits online; both converge', async () => {
  test.setTimeout(240_000);
  await ctx2.setOffline(true);
  await expect.poll(() => syncHook(page2).status()).toBe('offline');
  // Browser 2 makes the walls 8 mm offline; browser 1 renames the extrusion meanwhile.
  await editVariable(page2, 'thickness', '8');
  await expect(variableValue(page2, 'thickness')).toHaveText('8.00 mm');
  await expectVolume(page2, bracketVolume(8));
  await exec(page1, rename('extrude#1', 'L profile'), 'Rename the extrusion');
  await synced(page1);
  expect(await syncHook(page2).pending()).toBeGreaterThan(0);
  await openSyncPanel(page2);
  await docShot(page2, '02-offline-edit');

  await ctx2.setOffline(false);
  await synced(page2);
  await synced(page1);
  await expect.poll(() => features(page1)).toEqual(await features(page2));
  expect((await features(page1)).find((f) => f.id === 'extrude#1')!.name).toBe('L profile');
  for (const page of [page1, page2]) {
    await expect(variableValue(page, 'thickness')).toHaveText('8.00 mm', { timeout: 90_000 });
    await expectVolume(page, bracketVolume(8));
  }
});

test('100 commands queued offline rebase over the other browser’s edit', async () => {
  test.setTimeout(300_000);
  const client2 = await syncHook(page2).clientId();
  const before = serverLog(server, docId).length;
  await ctx2.setOffline(true);
  await expect.poll(() => syncHook(page2).status()).toBe('offline');
  // 100 edits, each its own undo step and so its own entry.
  const queued = await page2.evaluate(() => {
    const doc = window.__manufakture!.document.getState();
    let ok = 0;
    for (let i = 1; i <= 100; i++) {
      const r = doc.execute(
        { type: 'renameFeature', partId: 'part#1', featureId: 'sketch#1', name: `Offline ${i}` },
        `Offline rename ${i}`,
      );
      if (r.ok) ok++;
    }
    return ok;
  });
  expect(queued).toBe(100);
  await expect.poll(() => syncHook(page2).pending()).toBe(100);
  // Browser 1 moves the server on, so the queue has something to rebase over.
  await exec(page1, rename('hole#1', 'M4 counterbores'), 'Rename the holes');
  await synced(page1);
  const others = serverLog(server, docId).length;
  expect(others).toBe(before + 1);

  const t0 = performance.now();
  await ctx2.setOffline(false);
  await expect.poll(() => syncHook(page2).pending(), { timeout: 120_000, intervals: [20] }).toBe(0);
  const ms = performance.now() - t0;
  await synced(page2);
  // The server's log ends with browser 2's 100 entries, in order, after browser 1's.
  const log = serverLog(server, docId);
  expect(log).toHaveLength(others + 100);
  const last = log.slice(-100);
  expect(last.map((e) => e.entry.clientId)).toEqual(Array(100).fill(client2));
  expect(last.map((e) => e.entry.label)).toEqual(
    Array.from({ length: 100 }, (_, i) => `Offline rename ${i + 1}`),
  );
  await expect.poll(() => features(page1)).toEqual(await features(page2));
  const names = Object.fromEntries((await features(page1)).map((f) => [f.id, f.name]));
  expect(names['sketch#1']).toBe('Offline 100');
  expect(names['hole#1']).toBe('M4 counterbores');
  await recordBudget('rebase100PendingMs', {
    what: 'back online with 100 queued commands until the server confirmed all of them (hello, rebase over 1 entry, push)',
    total: Math.round(ms),
  });
});

test('a conflict shows its notice and keeps the refused work as a branch', async () => {
  test.setTimeout(180_000);
  await synced(page1);
  await synced(page2);
  const client1 = await syncHook(page1).clientId();
  // Browser 1 hears nothing from the server for a while, and renames the fillet browser 2 deletes.
  server.policy = (to, m) => (to.clientId === client1 && m.type === 'push' ? 2_000 : 0);
  await exec(
    page2,
    { type: 'deleteFeature', partId: 'part#1', featureId: 'fillet#1' },
    'Delete the fillet',
  );
  await expect
    .poll(() => serverLog(server, docId).some((e) => e.entry.label === 'Delete the fillet'))
    .toBe(true);
  await exec(page1, rename('fillet#1', 'Inside round'), 'Rename the fillet');
  await expect.poll(() => syncHook(page1).notices(), { timeout: 30_000 }).toHaveLength(1);
  server.policy = () => 0;
  expect((await syncHook(page1).notices())[0]!.text).toContain('Rename the fillet');
  await expect
    .poll(async () => (await syncHook(page1).notices())[0]?.branch?.name ?? null, {
      timeout: 30_000,
    })
    .toMatch(/^Kept from sync/);
  await expect
    .poll(() => syncHook(page1).branches(docId), { timeout: 30_000 })
    .toEqual(['Main', expect.stringMatching(/^Kept from sync/)]);
  await openSyncPanel(page1);
  await expect(page1.getByTestId('sync-notice')).toContainText('Rename the fillet');
  await expect(page1.getByTestId('sync-notice-branch')).toContainText('Kept from sync');
  await expect(page1.getByTestId('branch-select').locator('option')).toHaveText([
    'Main',
    /^Kept from sync/,
  ]);
  await docShot(page1, '03-conflict-notice');

  // Both converge on the server's document: no fillet, 8 mm walls.
  await synced(page1);
  await synced(page2);
  await expect.poll(() => features(page1)).toEqual(await features(page2));
  expect((await features(page1)).some((f) => f.id === 'fillet#1')).toBe(false);
  for (const page of [page1, page2]) {
    await expectVolume(page, bracketVolume(8, 'holes'));
  }

  // The branch holds the work as browser 1 had it: the fillet, renamed.
  const branchSelect = page1.getByTestId('branch-select');
  const kept = (await branchSelect.locator('option').nth(1).textContent())!;
  await branchSelect.selectOption({ label: kept });
  await expect
    .poll(async () => (await features(page1)).find((f) => f.id === 'fillet#1')?.name ?? null, {
      timeout: 60_000,
    })
    .toBe('Inside round');
  expect(errors.flat()).toEqual([]);
});
