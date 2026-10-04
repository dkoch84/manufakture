import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { buildApp } from '../../server/src/app';
import { DEFAULT_LIMITS } from '../../server/src/limits';
import { SqliteStore } from '../../server/src/sqlite';
import { openEmpty } from './bracket';

// Versions and branches on the server (T7.1e) end to end: a real manufakture server (apps/server,
// in this process, on a free port over a temp SQLite file) and two browser contexts, which are
// two browsers as far as storage goes. A version made in browser 1 is listed and viewed in browser
// 2; a branch made there from it shows up in browser 1, holding what the version holds.

const TOKEN = 'e2e-sync-history-token-0123456789abcdefghijklmnopqrstuvwxyz';

let dir: string;
let store: SqliteStore;
let server: Awaited<ReturnType<typeof buildApp>>;
let serverUrl: string;
let ctx1: BrowserContext | undefined;
let ctx2: BrowserContext | undefined;

test.beforeAll(async ({ baseURL }) => {
  dir = mkdtempSync(join(tmpdir(), 'mfk-sync-history-e2e-'));
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
  await ctx1?.close();
  await ctx2?.close();
  await server?.close();
  store?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

interface SyncHook {
  state(): { status: { kind: string } };
  library: { listBranches(id: string): Promise<{ ok: boolean; value?: { name: string }[] }> };
}

const mm = (source: string) => ({ source, lengthUnit: 'mm', angleUnit: 'deg' });

function rectangle(id: string) {
  const pts: [number, number][] = [
    [0, 0],
    [40, 0],
    [40, 20],
    [0, 20],
  ];
  return {
    id,
    kind: 'sketch',
    name: 'Sketch 1',
    suppressed: false,
    plane: { type: 'plane', origin: [0, 0, 0], normal: [0, 0, 1], xDir: [1, 0, 0] },
    entities: pts.map((p, i) => ({
      id: `e${i + 1}`,
      kind: 'line',
      construction: false,
      start: p,
      end: pts[(i + 1) % 4],
    })),
    constraints: [],
  };
}

async function exec(page: Page, command: object, label: string): Promise<boolean> {
  return page.evaluate(
    ([c, l]) => window.__manufakture!.document.getState().execute(c, l as string).ok,
    [command, label] as const,
  );
}

async function addExtrude(page: Page, name: string): Promise<void> {
  const id = await page.evaluate(() => {
    const doc = window.__manufakture!.document.getState().document as unknown as {
      parts: { nextIds: Record<string, number> }[];
    };
    return `extrude#${doc.parts[0]!.nextIds.extrude ?? 1}`;
  });
  const feature = {
    id,
    kind: 'extrude',
    name,
    suppressed: false,
    profile: { sketch: 'sketch#1' },
    operation: 'new',
    extent: { type: 'blind', distance: mm('6mm') },
    reverse: false,
  };
  expect(await exec(page, { type: 'addFeature', partId: 'part#1', feature }, name)).toBe(true);
}

async function featureNames(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    window.__manufakture!.document.getState().document.parts[0]!.features.map((f) => f.name),
  );
}

async function status(page: Page): Promise<string | null> {
  return page.evaluate(
    () =>
      (window.__manufakture as unknown as { sync?: SyncHook } | undefined)?.sync?.state().status
        .kind ?? null,
  );
}

async function synced(page: Page): Promise<void> {
  await expect.poll(() => status(page), { timeout: 30_000 }).toBe('synced');
}

async function localBranches(page: Page, id: string): Promise<string[]> {
  return page.evaluate(async (doc) => {
    const r = await (
      window.__manufakture as unknown as { sync: SyncHook }
    ).sync.library.listBranches(doc);
    return r.ok ? r.value!.map((b) => b.name) : [];
  }, id);
}

async function setServer(page: Page): Promise<void> {
  if (!(await page.getByTestId('sync-panel').isVisible())) {
    await page.getByTestId('sync-button').click();
  }
  await page.getByTestId('sync-server-url').fill(serverUrl);
  await page.getByTestId('sync-token').fill(TOKEN);
  await page.getByTestId('sync-save-server').click();
  await expect(page.getByTestId('sync-switch')).toBeVisible();
}

async function documentId(page: Page): Promise<string | null> {
  return page.evaluate(() => window.__manufakture?.document?.getState().document.id ?? null);
}

test('a version made in one browser is viewed in another, and a branch made there comes back', async ({
  browser,
}) => {
  test.setTimeout(300_000);
  ctx1 = await browser.newContext();
  ctx2 = await browser.newContext();
  const page1 = await ctx1.newPage();
  const page2 = await ctx2.newPage();

  // Browser 1: a synced document with a sketch and one extrude.
  await openEmpty(page1);
  expect(
    await exec(
      page1,
      { type: 'addFeature', partId: 'part#1', feature: rectangle('sketch#1') },
      'Sketch 1',
    ),
  ).toBe(true);
  await setServer(page1);
  await page1.getByTestId('sync-switch').check();
  await synced(page1);
  const docId = (await documentId(page1))!;
  await addExtrude(page1, 'Extrude 1');
  await synced(page1);

  // Browser 2 opens it from the server.
  await openEmpty(page2);
  await setServer(page2);
  await page2.getByTestId('sync-list-documents').click();
  await page2.locator(`[data-testid="sync-open-document"][data-document="${docId}"]`).click();
  await page2.waitForURL(new RegExp(`doc=${docId}`));
  await expect.poll(() => documentId(page2), { timeout: 60_000 }).toBe(docId);
  await synced(page2);
  await expect.poll(() => featureNames(page2)).toEqual(['Sketch 1', 'Extrude 1']);

  // Browser 1 names this state; the server stores it at revision 1, the one holding Extrude 1.
  await expect(page1.getByTestId('save-status')).toHaveText('Saved', { timeout: 15_000 });
  await page1.getByTestId('open-history').click();
  const history1 = page1.getByRole('complementary', { name: 'History' });
  await history1.getByTestId('version-create').click();
  await history1.getByTestId('version-name').fill('One extrude');
  await history1.getByTestId('version-save').click();
  await expect(history1.getByTestId('version-One extrude')).toBeVisible();
  await expect
    .poll(() => store.listVersions(docId).map((v) => [v.name, v.branch, v.rev]), {
      timeout: 30_000,
    })
    .toEqual([['One extrude', 'main', 1]]);

  // Browser 1 goes on; browser 2 gets that too.
  await addExtrude(page1, 'Extrude 2');
  await expect.poll(() => featureNames(page2)).toEqual(['Sketch 1', 'Extrude 1', 'Extrude 2']);

  // Browser 2 lists the version (from the server) and views it.
  await page2.getByTestId('open-history').click();
  const history2 = page2.getByRole('complementary', { name: 'History' });
  await expect(history2.getByTestId('version-One extrude')).toBeVisible({ timeout: 30_000 });
  await expect(history2.getByTestId('version-from-server-One extrude')).toHaveText(
    'from the server',
  );
  await history2.getByRole('button', { name: 'View version One extrude' }).click();
  const viewer = page2.getByTestId('history-viewer');
  await expect(viewer.getByTestId('history-viewer-label')).toHaveText(
    'Viewing Version "One extrude"',
  );
  await expect(viewer.getByTestId('history-compare')).toContainText('Extrude 2');

  // Browser 2 branches from it: the branch opens holding what the version holds.
  await viewer.getByTestId('history-branch').click();
  await viewer.getByTestId('branch-name').fill('Tried in browser 2');
  await viewer.getByTestId('branch-create').click();
  await expect(viewer).toBeHidden();
  await expect(page2.getByTestId('branch-select').locator('option:checked')).toHaveText(
    'Tried in browser 2',
  );
  await expect.poll(() => featureNames(page2)).toEqual(['Sketch 1', 'Extrude 1']);
  await expect
    .poll(() => store.listBranches(docId).map((b) => b.name), { timeout: 30_000 })
    .toEqual(['Tried in browser 2']);

  // Browser 1 has the branch, from the version it was made from.
  await expect
    .poll(() => localBranches(page1, docId), { timeout: 30_000 })
    .toEqual(['Main', 'Tried in browser 2']);
  // The branch list shows it live, without reopening the document.
  const select1 = page1.getByTestId('branch-select');
  await expect(select1.locator('option')).toHaveText(['Main', 'Tried in browser 2']);
  await select1.selectOption({ label: 'Tried in browser 2' });
  await expect.poll(() => featureNames(page1)).toEqual(['Sketch 1', 'Extrude 1']);
  await select1.selectOption({ label: 'Main' });
  await expect.poll(() => featureNames(page1)).toEqual(['Sketch 1', 'Extrude 1', 'Extrude 2']);
  await synced(page1);
});
