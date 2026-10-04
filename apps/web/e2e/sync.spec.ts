import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { buildApp } from '../../server/src/app';
import { DEFAULT_LIMITS } from '../../server/src/limits';
import { SqliteStore } from '../../server/src/sqlite';
import { openEmpty } from './bracket';

// Sync (T7.1d) end to end: a real manufakture server (apps/server, in this process, on a free port
// over a temp SQLite file) and two browser contexts, which are two browsers as far as storage
// goes. The server's test-only reply delay (`testReplyDelay`) holds pushes and verdicts back, so
// the test decides which edit the server sees first.

test.describe.configure({ mode: 'serial' });

const TOKEN = 'e2e-sync-token-0123456789abcdefghijklmnopqrstuvwxyz';

type Policy = (
  to: { clientId: string | undefined },
  message: { type: string; error?: { code: string } },
) => number;

let dir: string;
let store: SqliteStore;
let server: Awaited<ReturnType<typeof buildApp>>;
let serverUrl: string;
/** What the server holds back, and for how long (ms); the tests set it as they go. */
let policy: Policy = () => 0;

test.beforeAll(async ({ baseURL }) => {
  dir = mkdtempSync(join(tmpdir(), 'mfk-sync-e2e-'));
  store = new SqliteStore(join(dir, 'server.db'));
  server = await buildApp({
    token: TOKEN,
    store,
    limits: DEFAULT_LIMITS,
    origins: [new URL(baseURL!).origin],
    testReplyDelay: (to, message) => policy(to, message),
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

interface Feature {
  id: string;
  name: string;
}

interface SyncHook {
  state(): {
    status: { kind: string };
    enabled: boolean;
    notices: { text: string; branch?: { name: string } }[];
  };
  clientId(): string | null;
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

function extrude(id: string, name: string, distance = '6mm') {
  return {
    id,
    kind: 'extrude',
    name,
    suppressed: false,
    profile: { sketch: 'sketch#1' },
    operation: 'new',
    extent: { type: 'blind', distance: mm(distance) },
    reverse: false,
  };
}

async function exec(page: Page, command: object, label: string): Promise<boolean> {
  return page.evaluate(
    ([c, l]) => window.__manufakture!.document.getState().execute(c, l as string).ok,
    [command, label] as const,
  );
}

/** The next free id of `counter` in part#1, as the app would take it. */
async function nextId(page: Page, counter: string): Promise<string> {
  return page.evaluate((c) => {
    const doc = window.__manufakture!.document.getState().document as unknown as {
      parts: { nextIds: Record<string, number> }[];
    };
    return `${c}#${doc.parts[0]!.nextIds[c] ?? 1}`;
  }, counter);
}

async function addExtrude(page: Page, name: string, distance?: string): Promise<string> {
  const id = await nextId(page, 'extrude');
  expect(
    await exec(
      page,
      { type: 'addFeature', partId: 'part#1', feature: extrude(id, name, distance) },
      name,
    ),
  ).toBe(true);
  return id;
}

async function features(page: Page): Promise<Feature[]> {
  return page.evaluate(() =>
    window
      .__manufakture!.document.getState()
      .document.parts[0]!.features.map((f) => ({ id: f.id, name: f.name })),
  );
}

function hook(page: Page) {
  return {
    status: () =>
      page.evaluate(
        () =>
          (window.__manufakture as unknown as { sync?: SyncHook } | undefined)?.sync?.state().status
            .kind ?? null,
      ),
    clientId: () =>
      page.evaluate(() => (window.__manufakture as unknown as { sync: SyncHook }).sync.clientId()),
    notices: () =>
      page.evaluate(
        () => (window.__manufakture as unknown as { sync: SyncHook }).sync.state().notices,
      ),
    branches: (id: string) =>
      page.evaluate(
        async (doc) =>
          (window.__manufakture as unknown as { sync: SyncHook }).sync.library.listBranches(doc),
        id,
      ),
  };
}

async function synced(page: Page): Promise<void> {
  await expect.poll(() => hook(page).status(), { timeout: 30_000 }).toBe('synced');
}

/** Opens the Sync panel (a click on the button toggles it). */
async function openPanel(page: Page): Promise<void> {
  if (!(await page.getByTestId('sync-panel').isVisible())) {
    await page.getByTestId('sync-button').click();
  }
  await expect(page.getByTestId('sync-panel')).toBeVisible();
}

async function setServer(page: Page): Promise<void> {
  await openPanel(page);
  await page.getByTestId('sync-server-url').fill(serverUrl);
  await page.getByTestId('sync-token').fill(TOKEN);
  await page.getByTestId('sync-save-server').click();
  await expect(page.getByTestId('sync-switch')).toBeVisible();
}

async function documentId(page: Page): Promise<string | null> {
  return page.evaluate(() => window.__manufakture?.document?.getState().document.id ?? null);
}

/** Every entry of the server's log, oldest first. */
function serverLog(id: string) {
  return store.entries(id, 'main', 0, 100_000);
}

let ctx1: BrowserContext;
let ctx2: BrowserContext;
let page1: Page;
let page2: Page;
let docId: string;

test('two browsers sync one document; offline edits and concurrent adds converge', async ({
  browser,
}) => {
  test.setTimeout(300_000);
  ctx1 = await browser.newContext();
  ctx2 = await browser.newContext();
  page1 = await ctx1.newPage();
  page2 = await ctx2.newPage();

  // Browser 1: a document with a sketch, synced.
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
  docId = (await documentId(page1))!;
  expect(serverLog(docId)).toHaveLength(0);

  // Browser 2 opens it from the server.
  await openEmpty(page2);
  await setServer(page2);
  await page2.getByTestId('sync-list-documents').click();
  await page2.locator(`[data-testid="sync-open-document"][data-document="${docId}"]`).click();
  await page2.waitForURL(new RegExp(`doc=${docId}`));
  await expect.poll(() => documentId(page2), { timeout: 60_000 }).toBe(docId);
  await synced(page2);
  expect((await features(page2)).map((f) => f.id)).toEqual(['sketch#1']);

  // An edit in one appears in the other.
  await addExtrude(page1, 'Extrude 1');
  await expect
    .poll(() => features(page2))
    .toEqual([
      { id: 'sketch#1', name: 'Sketch 1' },
      { id: 'extrude#1', name: 'Extrude 1' },
    ]);

  // Browser 2 goes offline and adds an extrude; browser 1 adds one meanwhile: both take
  // extrude#2. Back online, browser 2's is renamed, and both end with two distinct extrudes.
  await ctx2.setOffline(true);
  await expect.poll(() => hook(page2).status()).toBe('offline');
  const offlineId = await addExtrude(page2, 'Offline extrude');
  const onlineId = await addExtrude(page1, 'Online extrude');
  expect(offlineId).toBe('extrude#2');
  expect(onlineId).toBe('extrude#2');
  await synced(page1);
  await ctx2.setOffline(false);
  await synced(page2);
  await expect.poll(() => features(page1)).toEqual(await features(page2));
  const all = await features(page1);
  const extrudes = all.filter((f) => f.id.startsWith('extrude#'));
  expect(extrudes.map((f) => f.name).sort()).toEqual(
    ['Extrude 1', 'Offline extrude', 'Online extrude'].sort(),
  );
  expect(new Set(extrudes.map((f) => f.id)).size).toBe(3);
  expect(all.find((f) => f.name === 'Online extrude')!.id).toBe('extrude#2');
  expect(all.find((f) => f.name === 'Offline extrude')!.id).toBe('extrude#3');
});

test('a change refused after a rebase shows a notice, and the work is kept as a branch', async () => {
  test.setTimeout(120_000);
  const client1 = await hook(page1).clientId();
  // Browser 1 hears nothing from the server for a while: it edits a feature browser 2 deletes.
  policy = (to, m) => (to.clientId === client1 && m.type === 'push' ? 2_000 : 0);
  expect(
    await exec(
      page2,
      { type: 'deleteFeature', partId: 'part#1', featureId: 'extrude#3' },
      'Delete offline extrude',
    ),
  ).toBe(true);
  await expect.poll(() => serverLog(docId).length).toBeGreaterThan(0);
  const before = serverLog(docId).length;
  await expect.poll(() => serverLog(docId).length).toBe(before);
  expect(
    await exec(
      page1,
      { type: 'renameFeature', partId: 'part#1', featureId: 'extrude#3', name: 'Lost rename' },
      'Rename the offline extrude',
    ),
  ).toBe(true);
  await expect.poll(() => hook(page1).notices(), { timeout: 30_000 }).toHaveLength(1);
  policy = () => 0;
  const notices = await hook(page1).notices();
  expect(notices[0]!.text).toContain('Rename the offline extrude');
  await expect
    .poll(async () => (await hook(page1).notices())[0]?.branch?.name ?? null, { timeout: 30_000 })
    .toMatch(/^Kept from sync/);
  const branches = await hook(page1).branches(docId);
  expect(branches.ok && branches.value!.length).toBe(2);
  await openPanel(page1);
  await expect(page1.getByTestId('sync-notice')).toContainText('Rename the offline extrude');
  await expect(page1.getByTestId('sync-notice-branch')).toContainText('Kept from sync');
  await synced(page1);
  expect((await features(page1)).some((f) => f.id === 'extrude#3')).toBe(false);
});

test('a reload in the middle of a rebase never applies an edit to the other browser’s feature', async () => {
  test.setTimeout(180_000);
  await synced(page1);
  await synced(page2);
  const client1 = await hook(page1).clientId();
  // Both take extrude#4 (extrude#3 was deleted, but ids are never reused).
  expect(await nextId(page1, 'extrude')).toBe('extrude#4');
  expect(await nextId(page2, 'extrude')).toBe('extrude#4');

  // Browser 1 hears pushes late, and the verdict on its second entry (B) not at all until it
  // reloads.
  let holdB = true;
  policy = (to, m) => {
    if (to.clientId !== client1) return 0;
    if (m.type === 'refuse' && m.error?.code === 'predecessor-refused' && holdB) return 600_000;
    return m.type === 'push' ? 3_000 : 0;
  };
  // Browser 2's extrude#4 (7 mm deep, which tells it apart) lands first.
  await addExtrude(page2, 'Extrude of browser 2', '7mm');
  await synced(page2);
  // From now on, browser 1 records whether B ever shows on browser 2's extrude.
  const watch = () =>
    page1.evaluate(() => {
      const w = window as unknown as { __bOnOther?: boolean };
      w.__bOnOther ??= false;
      const check = () => {
        const doc = window.__manufakture!.document.getState().document as unknown as {
          parts: { features: { name: string; extent?: { distance?: { source: string } } }[] }[];
        };
        for (const f of doc.parts[0]!.features) {
          if (f.extent?.distance?.source === '7mm' && f.name !== 'Extrude of browser 2') {
            w.__bOnOther = true;
          }
        }
      };
      check();
      (
        window.__manufakture!.document as unknown as { subscribe(f: () => void): () => void }
      ).subscribe(check);
    });
  await watch();
  // Browser 1 adds its extrude#4 (A) and edits it (B), before it hears of browser 2's.
  const aId = await addExtrude(page1, 'Extrude A');
  expect(aId).toBe('extrude#4');
  expect(
    await exec(
      page1,
      { type: 'renameFeature', partId: 'part#1', featureId: 'extrude#4', name: 'Edited by B' },
      'Edit A',
    ),
  ).toBe(true);
  // A is refused (id-reused), renamed to extrude#5 and lands; B waits for its verdict.
  await expect
    .poll(
      () =>
        serverLog(docId).some((e) => e.entry.clientId === client1 && e.entry.label === 'Extrude A'),
      {
        timeout: 30_000,
      },
    )
    .toBe(true);
  expect(serverLog(docId).some((e) => e.entry.label === 'Edit A')).toBe(false);

  // Reload before B's verdict; after it, the verdict arrives (B is resent unchanged).
  await expect(page1.getByTestId('save-status')).toHaveText('Saved', { timeout: 15_000 });
  holdB = false;
  await page1.reload();
  await expect.poll(() => documentId(page1), { timeout: 60_000 }).toBe(docId);
  await watch();
  await synced(page1);
  await synced(page2);

  const final1 = await features(page1);
  expect(final1.find((f) => f.id === 'extrude#4')!.name).toBe('Extrude of browser 2');
  expect(final1.find((f) => f.id === 'extrude#5')!.name).toBe('Edited by B');
  await expect.poll(() => features(page2)).toEqual(final1);
  expect(
    await page1.evaluate(() => (window as unknown as { __bOnOther?: boolean }).__bOnOther),
  ).toBe(false);
  // The server's log never has an entry of browser 1 that edits browser 2's extrude#4.
  const edits = serverLog(docId).filter(
    (e) =>
      e.entry.clientId === client1 &&
      (e.entry.command as { type: string; featureId?: string }).type === 'renameFeature',
  );
  // (Its rename of the deleted extrude#3 was refused in the test before, so it is not there.)
  expect(edits.map((e) => (e.entry.command as { featureId?: string }).featureId)).toEqual([
    'extrude#5',
  ]);
  policy = () => 0;
  await ctx1.close();
  await ctx2.close();
});
