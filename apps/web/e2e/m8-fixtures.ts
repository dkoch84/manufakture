import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { cpus, totalmem, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { expect, type Page } from '@playwright/test';
import { bracketDocument } from '@manufakture/session/test-fixtures';
// The MCP SDK is a dependency of apps/mcp, not of this app: the suite drives the server as a
// client would, with the SDK's own client, from apps/mcp's install.
import { Client } from '../../mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../../mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';
import { buildApp } from '../../server/src/app';
import { DEFAULT_LIMITS } from '../../server/src/limits';
import { SqliteStore } from '../../server/src/sqlite';
import { AgentTokenStore } from '../../server/src/tokens';
import { settle } from './helpers';

// Shared fixtures of the M8 acceptance suite (m8-*.spec.ts, docs/m8-acceptance.md): a real
// manufakture sync server started by the suite (apps/server, in this process, on a free port of
// 127.0.0.1 over a temp SQLite file, with agent tokens and CORS for the app's origin), the M1
// bracket on it, an agent token its owner issues, and the MCP server (apps/mcp) started over stdio
// the way an MCP client starts it, driven with the MCP SDK's client.
//
// Budgets: the suite records its numbers with `recordBudget`. They are printed and merged into
// `M8_BUDGETS` or `<tmpdir>/mfk-m8-budgets.json`; with M8_DOCS=1 the run also refreshes the
// screenshots in docs/m8-acceptance/ and merges the numbers into docs/m8-acceptance/numbers.json.
// They are wall-clock measurements of one run: estimates, not benchmarks.

/** The instance's own token: the owner's, who reviews in the browser. Never given to the agent. */
export const OWNER_TOKEN = 'e2e-m8-acceptance-owner-token-0123456789abcdefghijklmnopqrstuvwxyz';
/** What the agent's MCP client calls itself; shown with the branch in History. */
export const CLIENT_NAME = 'Acceptance agent';

export const DOCS = !!process.env.M8_DOCS;
const DOCS_DIR = resolve(import.meta.dirname, '../../../docs/m8-acceptance');
const REPO = resolve(import.meta.dirname, '../../..');

/** The M1 bracket (packages/session's fixture, the document every M8 test starts from). */
export const BRACKET_DOC = bracketDocument();

export interface M8Server {
  url: string;
  store: SqliteStore;
  /** An owner's request to the server's API (`path` after `/api`). */
  owner(method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }>;
  close(): Promise<void>;
}

/** Start a sync server with agent tokens, for the app at `baseURL`, holding the M1 bracket. */
export async function startServer(baseURL: string): Promise<M8Server> {
  const dir = mkdtempSync(join(tmpdir(), 'mfk-m8-e2e-'));
  const store = new SqliteStore(join(dir, 'server.db'));
  const app = await buildApp({
    token: OWNER_TOKEN,
    agentTokens: new AgentTokenStore(store.database),
    store,
    limits: DEFAULT_LIMITS,
    origins: [new URL(baseURL).origin],
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (address === null || typeof address === 'string') throw new Error('no address');
  const url = `http://127.0.0.1:${address.port}`;
  const owner: M8Server['owner'] = async (method, path, body) => {
    const res = await fetch(`${url}/api${path}`, {
      method,
      headers: {
        authorization: `Bearer ${OWNER_TOKEN}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return { status: res.status, body: text.length > 0 ? (JSON.parse(text) as unknown) : null };
  };
  const created = await owner('POST', '/documents', { document: BRACKET_DOC });
  if (created.status !== 201) throw new Error(`create: ${created.status}`);
  return {
    url,
    store,
    owner,
    close: async () => {
      await app.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** The owner issues an agent token scoped to `documents`, as the server's API does. */
export async function issueAgentToken(server: M8Server, documents: string[]): Promise<string> {
  const r = await server.owner('POST', '/agent-tokens', { name: CLIENT_NAME, documents });
  if (r.status !== 201) throw new Error(`issue: ${r.status} ${JSON.stringify(r.body)}`);
  return (r.body as { token: string }).token;
}

// The MCP server -------------------------------------------------------------------------------

/** Result data as the suite reads it: JSON whose shape each assertion states. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- assertions walk result JSON freely
export type Data = Record<string, any>;

export interface Agent {
  /** Call a tool: its structured result and how long the call took, ms. */
  call(name: string, args?: Record<string, unknown>): Promise<{ result: Data; ms: number }>;
  /** What the server wrote on stderr so far (its log; never the protocol). */
  stderr(): string;
  close(): Promise<void>;
}

/**
 * Start the MCP server as an MCP client would (`node --import <the TypeScript hooks>
 * src/main.ts`, apps/mcp's start script) over sync with the agent's token, exports going to
 * `outputDir`, and connect the SDK's client. Resolves once the client is initialized; `ms` is
 * from the spawn until then.
 */
export async function startAgent(
  server: M8Server,
  token: string,
  outputDir: string,
): Promise<{ agent: Agent; ms: number }> {
  const t0 = performance.now();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      '--expose-gc',
      '--import',
      join(REPO, 'packages/session/src/worker/ts-hooks.ts'),
      'src/main.ts',
    ],
    cwd: join(REPO, 'apps/mcp'),
    env: {
      PATH: process.env.PATH ?? '',
      MANUFAKTURE_SYNC_URL: server.url,
      MANUFAKTURE_SYNC_TOKEN: token,
      MANUFAKTURE_OUTPUT: outputDir,
    },
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const client = new Client({ name: CLIENT_NAME, version: '1.0.0' });
  try {
    await client.connect(transport);
  } catch (e) {
    // The process may be running; never leave it behind.
    await transport.close().catch(() => undefined);
    throw e;
  }
  const ms = performance.now() - t0;
  return {
    ms,
    agent: {
      async call(name, args = {}) {
        const s = performance.now();
        const r = (await client.callTool({ name, arguments: args })) as {
          structuredContent?: Data;
          content: { type: string; text?: string }[];
        };
        const elapsed = performance.now() - s;
        const result = r.structuredContent ?? {
          ok: false,
          error: { kind: 'input', message: r.content.map((c) => c.text ?? '').join('') },
        };
        return { result, ms: elapsed };
      },
      stderr: () => stderr,
      close: () => client.close(),
    },
  };
}

/** The structured result's fields, failing the test when it is a refusal. */
export function ok(r: { result: Data }): Data {
  expect(r.result.ok, JSON.stringify(r.result.error)).toBe(true);
  return r.result;
}

// The agent's work ------------------------------------------------------------------------------

const expr = (source: string) => ({ source, lengthUnit: 'mm', angleUnit: 'deg' });

/** Batch 1: a boss on the bracket's upright, 4 mm across and 5 mm tall, by symbolic ids. */
export const BOSS_BATCH = [
  {
    type: 'addFeature',
    partId: 'part#1',
    feature: {
      id: 'sketch#$bossSketch',
      kind: 'sketch',
      name: 'Boss sketch',
      suppressed: false,
      plane: { type: 'plane', origin: [0, 0, 40], normal: [0, 0, 1], xDir: [1, 0, 0] },
      entities: [
        { id: 'e$circle', kind: 'circle', construction: false, center: [3, 0], radius: 2 },
      ],
      constraints: [],
    },
  },
  {
    type: 'addFeature',
    partId: 'part#1',
    feature: {
      id: 'extrude#$boss',
      kind: 'extrude',
      name: 'Boss',
      suppressed: false,
      profile: { sketch: 'sketch#$bossSketch' },
      operation: 'add',
      extent: { type: 'blind', distance: expr('5 mm') },
      reverse: false,
    },
  },
];

/** A 1/4" flat end mill (#201) with a plywood preset. */
const MILL = {
  id: 'tool#$mill',
  name: '1/4" flat end mill',
  kind: 'flat',
  number: 201,
  diameter: expr('6.35 mm'),
  fluteLength: expr('22 mm'),
  flutes: 2,
  presets: [
    {
      material: 'plywood',
      spindle: expr('18000rpm'),
      feed: expr('1500mm/min'),
      plunge: expr('500mm/min'),
      stepdown: expr('3 mm'),
      stepover: expr('0.4'),
    },
  ],
};

/** A plywood setup on the default machine, 5 mm margins and 1 mm on top, zero on the top front left. */
const SETUP = {
  id: 'setup#$top',
  name: 'Setup 1',
  part: 'part#1',
  machine: 'shapeoko-5-pro-4x4',
  post: 'carbide-motion',
  stock: {
    kind: 'fromBody',
    margins: {
      xMin: expr('5 mm'),
      xMax: expr('5 mm'),
      yMin: expr('5 mm'),
      yMax: expr('5 mm'),
      top: expr('1 mm'),
      bottom: expr('0 mm'),
    },
    material: 'plywood',
  },
  wcs: { up: { kind: 'axis', axis: '+z' }, origin: { xy: 'front-left', z: 'top' } },
  heights: { clearance: expr('10 mm'), retract: expr('5 mm') },
  operations: [],
};

const facing = (tool: string) => ({
  type: 'addCamOperation',
  setupId: 'setup#$top',
  operation: {
    id: 'facing#$face',
    kind: 'facing',
    name: 'Face the top',
    suppressed: false,
    tool,
    geometry: [],
    depth: expr('1 mm'),
    angle: expr('0 deg'),
  },
});

/**
 * Batch 2, first attempt: the setup and a facing that cuts with `tool#1`, a tool the document does
 * not have. Core refuses the whole batch (`dependency`).
 */
export const CAM_BATCH_REFUSED = [{ type: 'addCamSetup', setup: SETUP }, facing('tool#1')];

/** Batch 2, corrected: the tool first, by a symbol, and the facing cutting with it. */
export const CAM_BATCH = [
  { type: 'addCamTool', tool: MILL },
  { type: 'addCamSetup', setup: SETUP },
  facing('tool#$mill'),
];

/** Batch 3: name the setup after what it machines. */
export const nameSetupBatch = (setupId: string) => [
  { type: 'editCamSetup', setupId, name: SETUP_NAME },
];
export const SETUP_NAME = 'Bracket top';

// Browser ---------------------------------------------------------------------------------------

interface SyncHook {
  state(): { status: { kind: string } };
  pending(): unknown[];
}

const syncStatus = (page: Page) =>
  page.evaluate(
    () =>
      (window.__manufakture as unknown as { sync?: SyncHook } | undefined)?.sync?.state().status
        .kind ?? null,
  );
const syncPending = (page: Page) =>
  page.evaluate(
    () => (window.__manufakture as unknown as { sync: SyncHook }).sync.pending().length,
  );

/** Wait until the page's document is synced with nothing of its own waiting. */
export async function synced(page: Page, timeout = 60_000): Promise<void> {
  await expect.poll(() => syncStatus(page), { timeout }).toBe('synced');
  await expect.poll(() => syncPending(page), { timeout }).toBe(0);
}

/** Open document `docId` from the server with the owner's token, as a browser that never had it. */
export async function openFromServer(page: Page, server: M8Server, docId: string): Promise<void> {
  if (!(await page.getByTestId('sync-panel').isVisible())) {
    await page.getByTestId('sync-button').click();
  }
  await expect(page.getByTestId('sync-panel')).toBeVisible();
  await page.getByTestId('sync-server-url').fill(server.url);
  await page.getByTestId('sync-token').fill(OWNER_TOKEN);
  await page.getByTestId('sync-save-server').click();
  await expect(page.getByTestId('sync-switch')).toBeVisible();
  await page.getByTestId('sync-list-documents').click();
  await page.locator(`[data-testid="sync-open-document"][data-document="${docId}"]`).click();
  await page.waitForURL(new RegExp(`doc=${docId}`));
  await expect
    .poll(() => page.evaluate(() => window.__manufakture?.document?.getState().document.id), {
      timeout: 60_000,
    })
    .toBe(docId);
  await synced(page);
  // Opening the document may have closed the panel already; out of the way either way.
  if (await page.getByTestId('sync-panel').isVisible())
    await page.getByTestId('sync-button').click();
  await expect(page.getByTestId('sync-panel')).toBeHidden();
}

/**
 * Wait until the model shows the open document, regenerated. A document that arrived by sync can
 * be an equal copy of the one the model shows, so equal JSON counts.
 */
export async function shown(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const hooks = window.__manufakture;
      if (!hooks?.model || !hooks.document) return false;
      const m = hooks.model.getState();
      if (m.pending || m.generation === 0 || !m.document) return false;
      const doc = hooks.document.getState().document;
      return m.document === doc || JSON.stringify(m.document) === JSON.stringify(doc);
    },
    null,
    { timeout: 90_000, polling: 50 },
  );
}

// Docs and budgets ------------------------------------------------------------------------------

/** A screenshot for the docs (M8_DOCS=1 only), the pointer out of the way. */
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

/** The machine the numbers were measured on: CPU, cores, memory and Node. */
export const MACHINE = {
  cpu: cpus()[0]?.model.trim() ?? 'unknown',
  cores: cpus().length,
  memoryGiB: Math.round(totalmem() / 2 ** 30),
  node: process.version,
  platform: `${process.platform} ${process.arch}`,
};

const BUDGETS_FILE = process.env.M8_BUDGETS ?? join(tmpdir(), 'mfk-m8-budgets.json');

async function mergeJson(path: string, key: string, value: unknown, note: string): Promise<void> {
  let current: { note?: string; budgets?: Record<string, unknown> } = {};
  try {
    current = JSON.parse(await readFile(path, 'utf8')) as typeof current;
  } catch {
    // A first run: start a new file.
  }
  const next = { note, machine: MACHINE, budgets: { ...current.budgets, [key]: value } };
  await mkdir(dirname(path), { recursive: true });
  // Written whole, then renamed over the file, so a reader never sees half of it.
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`);
  await rename(temp, path);
}

/** Record a measured budget: printed, and merged into the budgets file (and the docs' numbers). */
export async function recordBudget(key: string, value: unknown): Promise<void> {
  const note =
    'Wall-clock measurements of one e2e run (the MCP server over stdio with worker engines, the sync server in the test process, headless Chromium with SwiftShader), ms: estimates, not benchmarks.';
  console.log(`M8 budget ${key}: ${JSON.stringify(value)}`);
  await mergeJson(BUDGETS_FILE, key, value, note);
  if (DOCS) await mergeJson(join(DOCS_DIR, 'numbers.json'), key, value, note);
}
