import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  expect,
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  type Page,
} from '@playwright/test';
import { buildApp } from '../../server/src/app';
import { DEFAULT_LIMITS } from '../../server/src/limits';
import { DEFAULT_SHARE_CONFIG, SqliteShareStore } from '../../server/src/shares';
import { SqliteStore } from '../../server/src/sqlite';
import { BRACKET, bodyVolume } from './bracket';
import { settle } from './helpers';
import { EXAMPLES } from './script-examples';

// Shared fixtures of the M7 acceptance chapters (m7-*.spec.ts, docs/m7-acceptance.md): a real
// manufakture server started by the suite (apps/server, in this process, on a free port over a
// temp SQLite file, with share links on), the sync and script helpers the chapters drive it with,
// the docs' screenshots, and the measured budgets.
//
// Budgets: every chapter records its numbers with `recordBudget`. They are printed (run with
// `--reporter=list` to see them) and merged into one JSON file, `M7_BUDGETS` or
// `<tmpdir>/mfk-m7-budgets.json`. With M7_DOCS=1 the run also refreshes the screenshots in
// docs/m7-acceptance/ and merges the numbers into docs/m7-acceptance/numbers.json. They are
// wall-clock measurements of one run in headless Chromium (SwiftShader): estimates, not
// benchmarks.

/** The one bearer token of a self-hosted single-user server (no accounts). */
export const TOKEN = 'e2e-m7-acceptance-token-0123456789abcdefghijklmnopqrstuvwxyz';

export const DOCS = !!process.env.M7_DOCS;
const DOCS_DIR = resolve(import.meta.dirname, '../../../docs/m7-acceptance');

/** What the server delays its replies by (ms), per receiving client and message. */
export type Policy = (
  to: { clientId: string | undefined },
  message: { type: string; error?: { code: string } },
) => number;

export interface M7Server {
  url: string;
  store: SqliteStore;
  /** Hold replies back as `policy` says (the default delays nothing). */
  policy: Policy;
  close(): Promise<void>;
}

/** Start a server for the app at `baseURL`: sync for its origin, and share links it may view. */
export async function startServer(baseURL: string): Promise<M7Server> {
  const dir = mkdtempSync(join(tmpdir(), 'mfk-m7-e2e-'));
  const store = new SqliteStore(join(dir, 'server.db'));
  const appOrigin = new URL(baseURL).origin;
  const handle: M7Server = {
    url: '',
    store,
    policy: () => 0,
    close: async () => undefined,
  };
  const app = await buildApp({
    token: TOKEN,
    store,
    limits: DEFAULT_LIMITS,
    origins: [appOrigin],
    shares: {
      store: new SqliteShareStore(store.database),
      config: { ...DEFAULT_SHARE_CONFIG, viewerOrigins: [appOrigin] },
    },
    testReplyDelay: (to, message) => handle.policy(to, message),
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (address === null || typeof address === 'string') throw new Error('no address');
  handle.url = `http://127.0.0.1:${address.port}`;
  handle.close = async () => {
    await app.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return handle;
}

/** Every entry of the server's log of `docId` (main), oldest first. */
export function serverLog(server: M7Server, docId: string) {
  return server.store.entries(docId, 'main', 0, 100_000);
}

// Browser contexts ------------------------------------------------------------------------------

/** A new browser context: a separate browser as far as storage goes. Wider for the docs. */
export function newContext(
  browser: Browser,
  options: BrowserContextOptions = {},
): Promise<BrowserContext> {
  return browser.newContext({
    ...(DOCS ? { viewport: { width: 1600, height: 1000 } } : {}),
    ...options,
  });
}

/** Run a document command through the store, as one undo step with `label`. */
export async function exec(page: Page, command: object, label: string): Promise<void> {
  const result = await page.evaluate(
    ([c, l]) => JSON.stringify(window.__manufakture!.document.getState().execute(c, l as string)),
    [command, label] as const,
  );
  expect((JSON.parse(result) as { ok: boolean }).ok, `${label}: ${result}`).toBe(true);
}

export interface Feature {
  id: string;
  name: string;
}

export async function features(page: Page): Promise<Feature[]> {
  return page.evaluate(() =>
    window
      .__manufakture!.document.getState()
      .document.parts[0]!.features.map((f) => ({ id: f.id, name: f.name })),
  );
}

export async function documentId(page: Page): Promise<string | null> {
  return page.evaluate(() => window.__manufakture?.document?.getState().document.id ?? null);
}

export async function saved(page: Page): Promise<void> {
  await expect(page.getByTestId('save-status')).toHaveText('Saved', { timeout: 15_000 });
}

/** The value `#name` shows in the Variables panel, e.g. "6.00 mm". */
export function variableValue(page: Page, name: string) {
  return page.getByTestId(`variable-${name}-value`);
}

// Sync ------------------------------------------------------------------------------------------

interface SyncHook {
  state(): {
    status: { kind: string };
    notices: { text: string; branch?: { name: string } }[];
  };
  clientId(): string | null;
  pending(): unknown[];
  library: { listBranches(id: string): Promise<{ ok: boolean; value?: { name: string }[] }> };
}

/** The sync test hook (`window.__manufakture.sync`, src/sync/start.ts). */
export function syncHook(page: Page) {
  return {
    status: () =>
      page.evaluate(
        () =>
          (window.__manufakture as unknown as { sync?: SyncHook } | undefined)?.sync?.state().status
            .kind ?? null,
      ),
    clientId: () =>
      page.evaluate(() => (window.__manufakture as unknown as { sync: SyncHook }).sync.clientId()),
    pending: () =>
      page.evaluate(
        () => (window.__manufakture as unknown as { sync: SyncHook }).sync.pending().length,
      ),
    notices: () =>
      page.evaluate(
        () => (window.__manufakture as unknown as { sync: SyncHook }).sync.state().notices,
      ),
    branches: (id: string) =>
      page.evaluate(async (doc) => {
        const r = await (
          window.__manufakture as unknown as { sync: SyncHook }
        ).sync.library.listBranches(doc);
        return r.ok ? r.value!.map((b) => b.name) : [];
      }, id),
  };
}

/** Wait until the page's document is synced with nothing of its own waiting. */
export async function synced(page: Page, timeout = 60_000): Promise<void> {
  await expect.poll(() => syncHook(page).status(), { timeout }).toBe('synced');
  await expect.poll(() => syncHook(page).pending(), { timeout }).toBe(0);
}

/** Open the Sync panel (a click on the button toggles it). */
export async function openSyncPanel(page: Page): Promise<void> {
  if (!(await page.getByTestId('sync-panel').isVisible())) {
    await page.getByTestId('sync-button').click();
  }
  await expect(page.getByTestId('sync-panel')).toBeVisible();
}

/** Set the server and its token in the Sync panel. */
export async function connect(page: Page, server: M7Server): Promise<void> {
  await openSyncPanel(page);
  await page.getByTestId('sync-server-url').fill(server.url);
  await page.getByTestId('sync-token').fill(TOKEN);
  await page.getByTestId('sync-save-server').click();
  await expect(page.getByTestId('sync-switch')).toBeVisible();
}

/** Sync the open document (it is uploaded as it is), and return its id. */
export async function startSyncing(page: Page, server: M7Server): Promise<string> {
  await connect(page, server);
  await page.getByTestId('sync-switch').check();
  await synced(page);
  return (await documentId(page))!;
}

/** Open document `docId` from the server, as a browser that never had it. */
export async function openFromServer(page: Page, server: M7Server, docId: string): Promise<void> {
  await connect(page, server);
  await page.getByTestId('sync-list-documents').click();
  await page.locator(`[data-testid="sync-open-document"][data-document="${docId}"]`).click();
  await page.waitForURL(new RegExp(`doc=${docId}`));
  await expect.poll(() => documentId(page), { timeout: 60_000 }).toBe(docId);
  await synced(page);
}

/**
 * Milliseconds from `act` (an edit in one browser) until `seen` holds in another: a sync round
 * trip, push to the server and on to the other browser. `seen` is polled in the page every 5 ms.
 */
export async function roundTrip(
  act: () => Promise<void>,
  other: Page,
  seen: (arg: string) => boolean,
  arg: string,
): Promise<number> {
  const t0 = performance.now();
  await act();
  await other.waitForFunction(seen, arg, { polling: 5, timeout: 30_000 });
  return performance.now() - t0;
}

// Scripts ---------------------------------------------------------------------------------------

/** The bolt-circle example of docs/user/scripting.md (the T7.2e determinism examples hold it). */
export const BOLT_CIRCLE = EXAMPLES.find((e) => e.name === 'bolt circle')!.source;

/** The bolt circle's exact volume: a 100 mm disc 10 mm thick, less `count` 6 mm holes through it. */
export const boltCircleVolume = (count: number, hole = 3) =>
  Math.PI * 10 * (50 * 50 - count * hole * hole);

export interface Outcome {
  status: string;
  cached: boolean;
  ms: number;
  key: string | null;
  errors: { code: string; scriptCode?: string; message: string }[];
}

/** Once the model shows the open document: each feature's regen result, by id. */
export async function outcomes(page: Page): Promise<Record<string, Outcome>> {
  await page.waitForFunction(
    () => {
      const hooks = window.__manufakture;
      if (!hooks?.model || !hooks.document) return false;
      const m = hooks.model.getState();
      if (m.pending || m.generation === 0 || !m.document) return false;
      // A document that arrived by sync can be an equal copy of the one the model shows.
      const doc = hooks.document.getState().document;
      return m.document === doc || JSON.stringify(m.document) === JSON.stringify(doc);
    },
    null,
    { timeout: 90_000, polling: 50 },
  );
  return page.evaluate(() =>
    Object.fromEntries(
      window.__manufakture!.model.getState().parts[0]!.features.map((f) => {
        const r = f as unknown as {
          featureId: string;
          status: string;
          cached: boolean;
          ms: number;
          key?: string;
          errors: { code: string; scriptCode?: string; message: string }[];
        };
        return [
          r.featureId,
          {
            status: r.status,
            cached: r.cached,
            ms: r.ms,
            key: r.key ?? null,
            errors: r.errors.map((e) => ({
              code: e.code,
              ...(e.scriptCode === undefined ? {} : { scriptCode: e.scriptCode }),
              message: e.message,
            })),
          },
        ];
      }),
    ),
  );
}

export interface ScriptStats {
  declarations: number;
  runs: number;
}

/** How many declaration reads and runs this page's regen worker made (null: none loaded yet). */
export function scriptStats(page: Page): Promise<ScriptStats | null> {
  return page.evaluate(async () => {
    const hooks = window.__manufakture as unknown as {
      scripts: { stats(): Promise<ScriptStats | null> };
    };
    return hooks.scripts.stats();
  });
}

/** Write `source` as a new script named `name` in the editor, save it and close the editor. */
export async function writeScript(page: Page, name: string, source: string): Promise<void> {
  await page.getByTestId('script-new').click();
  const code = page.getByTestId('script-source').locator('.cm-content');
  await expect(code).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('script-name').fill(name);
  await code.fill(source);
  await page.getByTestId('script-save').click();
  await expect(page.getByTestId('script-save')).toBeDisabled();
  await page.getByTestId('script-close').click();
  await expect(page.getByTestId('script-editor')).toBeHidden();
}

/** The body as the viewport shows it, and its exact volume: what "identical" compares. */
export async function bodySummary(page: Page) {
  await page.waitForFunction(
    () => (window.__manufakture?.viewport.info().bodies.length ?? 0) === 1,
    null,
    { timeout: 60_000 },
  );
  const info = await page.evaluate(() => window.__manufakture!.viewport.info().bodies[0]!);
  const volume = await bodyVolume(page);
  return {
    id: info.id,
    faces: info.faces,
    edges: info.edges,
    triangles: info.triangles,
    volume,
  };
}

// The viewer ------------------------------------------------------------------------------------

/** The bracket, as the viewer shows it: one body of 15 faces, 50 x 30 x 40 mm. */
export async function expectViewerBracket(page: Page): Promise<void> {
  await expect(page.getByTestId('viewer-error')).toHaveCount(0);
  await expect(page.getByTestId('viewer-bodies').locator('li')).toHaveCount(1, {
    timeout: 60_000,
  });
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

// Docs and budgets ------------------------------------------------------------------------------

/** A screenshot for the docs (M7_DOCS=1 only), the pointer out of the way. */
export async function docShot(page: Page, name: string): Promise<void> {
  if (!DOCS) return;
  await page.mouse.move(0, 0);
  await settle(page).catch(() => undefined);
  await mkdir(DOCS_DIR, { recursive: true });
  await page.screenshot({ path: join(DOCS_DIR, `${name}.png`) });
}

export const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

const BUDGETS_FILE = process.env.M7_BUDGETS ?? join(tmpdir(), 'mfk-m7-budgets.json');

async function mergeJson(path: string, key: string, value: unknown, note: string): Promise<void> {
  let current: { note?: string; budgets?: Record<string, unknown> } = {};
  try {
    current = JSON.parse(await readFile(path, 'utf8')) as typeof current;
  } catch {
    // A first run: start a new file.
  }
  const next = { note, budgets: { ...current.budgets, [key]: value } };
  await mkdir(dirname(path), { recursive: true });
  // Written whole, then renamed over the file, so a reader never sees half of it.
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`);
  await rename(temp, path);
}

/** Record a measured budget: printed, and merged into the budgets file (and the docs' numbers). */
export async function recordBudget(key: string, value: unknown): Promise<void> {
  const note =
    'Wall-clock measurements of one e2e run in headless Chromium (SwiftShader), ms: estimates, not benchmarks.';
  console.log(`M7 budget ${key}: ${JSON.stringify(value)}`);
  await mergeJson(BUDGETS_FILE, key, value, note);
  if (DOCS) await mergeJson(join(DOCS_DIR, 'numbers.json'), key, value, note);
}

/** Wait until the measured body volume is `mm3` (the model regenerates after an edit or a sync). */
export async function expectVolume(page: Page, mm3: number): Promise<void> {
  await expect
    .poll(
      async () => {
        await outcomes(page);
        return bodyVolume(page);
      },
      { timeout: 90_000 },
    )
    .toBeCloseTo(mm3, 3);
}
