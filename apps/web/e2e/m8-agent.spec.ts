import { mkdtempSync, rmSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { openEmpty } from './bracket';
import {
  BOSS_BATCH,
  BRACKET_DOC,
  CAM_BATCH,
  CAM_BATCH_REFUSED,
  CLIENT_NAME,
  DOCS,
  SETUP_NAME,
  docShot,
  issueAgentToken,
  median,
  nameSetupBatch,
  ok,
  openFromServer,
  recordBudget,
  shown,
  startAgent,
  startServer,
  synced,
  type Agent,
  type Data,
  type M8Server,
} from './m8-fixtures';

// M8 acceptance (docs/m8-acceptance.md; the agent surface plan, T8.8): the milestone end to end.
// A sync server started by the suite holds the M1 bracket. Its owner issues an agent token, and
// the MCP server (apps/mcp) runs over stdio with that token, as an MCP client starts it; the suite
// is the agent, through the MCP SDK's client. It opens a session on the bracket, applies three
// batches (the second refused by core first and corrected), exports G-code from its unreviewed
// branch (no export is gated) and submits for review. The owner, in a browser context, opens the
// bracket from the server, reviews the agent branch in History and approves it: the merge into
// Main is one step and Main gets a version that records the review. Then the owner exports
// G-code from Main, and the review that Main's work came from is the agent's. Last, a new session
// starts from that version. Budgets: session cold start, batch round trip, bundle build.

test.describe.configure({ mode: 'serial' });

let server: M8Server;
let agent: Agent | undefined;
let outputDir: string;
let ctx: BrowserContext;
let page: Page;
let sessionId: string;
let branchId: string;
let branchName: string;
let setupId: string;
/** Page errors of the browser, collected as they happen (the array `openEmpty` keeps filling). */
let errors: string[] = [];

test.beforeAll(async ({ baseURL, browser }) => {
  server = await startServer(baseURL!);
  outputDir = mkdtempSync(join(tmpdir(), 'mfk-m8-out-'));
  ctx = await browser.newContext();
  page = await ctx.newPage();
});

test.afterAll(async () => {
  await agent?.close().catch(() => undefined);
  await ctx?.close();
  await server?.close();
  if (outputDir) rmSync(outputDir, { recursive: true, force: true });
});

/** The labels of the entries in the server's log of `branch`, oldest first. */
const labels = (branch: string) =>
  server.store.entries(BRACKET_DOC.id, branch, 0, 100_000).map((p) => p.entry.label);

test('an agent works the bracket through the MCP server, over sync, and submits it', async () => {
  test.setTimeout(300_000);
  const token = await issueAgentToken(server, [BRACKET_DOC.id]);
  expect(token).toMatch(/^agent\./);

  // Cold start: the process starts and initializes, then the session opens (the branch made on the
  // server, the kernel loaded in a worker, the first regen).
  const started = await startAgent(server, token, outputDir);
  agent = started.agent;
  const listed = ok(await agent.call('list_documents'));
  expect(listed.documents).toEqual([
    expect.objectContaining({ id: BRACKET_DOC.id, name: 'Bracket', branches: [] }),
  ]);
  const opening = await agent.call('open_session', { documentId: BRACKET_DOC.id });
  const opened = ok(opening);
  ({
    sessionId,
    branch: branchId,
    branchName,
  } = opened as {
    sessionId: string;
    branch: string;
    branchName: string;
  });
  expect(opened).toMatchObject({ review: 'open', resumed: false, revision: 1 });
  expect(branchName).toBe(`Agent session ${sessionId}`);

  // Batch 1: a boss on the upright.
  const boss = await agent.call('apply', {
    sessionId,
    label: 'Add a boss on the upright',
    commands: BOSS_BATCH,
  });
  expect(ok(boss)).toMatchObject({ revision: 2, errors: [] });
  expect(boss.result.measured[0].boundingBox.max).toEqual([50, 15, 45]);

  // Batch 2: a facing setup. The first attempt cuts with a tool the document does not have; core
  // refuses the batch as a whole, as data, and nothing is written.
  const refused = await agent.call('apply', {
    sessionId,
    label: 'Face the stock top',
    commands: CAM_BATCH_REFUSED,
  });
  expect(refused.result).toMatchObject({
    ok: false,
    error: { kind: 'core', error: { code: 'dependency', blockers: ['tool#1'] } },
  });
  expect(refused.result.error.error.message).toContain('is not in the CAM tools');
  // Corrected: the tool first, by a symbol.
  const cam = await agent.call('apply', {
    sessionId,
    label: 'Face the stock top',
    commands: CAM_BATCH,
  });
  expect(ok(cam)).toMatchObject({ revision: 3 });
  expect(cam.result.symbols).toEqual({ $mill: 'tool#1', $top: 'setup#1', $face: 'facing#1' });
  setupId = cam.result.symbols.$top as string;

  // Batch 3: name the setup.
  const named = await agent.call('apply', {
    sessionId,
    label: 'Name the setup',
    commands: nameSetupBatch(setupId),
  });
  expect(ok(named)).toMatchObject({ revision: 4 });

  // The server holds the three batches on the agent's branch, refused attempt excluded.
  expect(labels(branchId)).toEqual([
    'Add a boss on the upright',
    'Face the stock top',
    'Name the setup',
  ]);

  // Batch round trips: each call from the client, through the session's regen, to the server's
  // log and back. Plus dry runs of the boss (applied, regenerated and put back; nothing written).
  const dry: number[] = [];
  for (let i = 0; i < 5; i++) {
    const d = await agent.call('apply', {
      sessionId,
      label: 'Try the boss again',
      commands: BOSS_BATCH,
      dryRun: true,
    });
    expect(ok(d)).toMatchObject({ dryRun: true });
    dry.push(d.ms);
  }

  // No export gate: G-code from the unreviewed agent branch, marked as not reviewed.
  const gcode = await agent.call('export', {
    sessionId,
    format: 'gcode',
    setupId,
    fileName: 'branch',
  });
  expect(ok(gcode)).toMatchObject({ format: 'gcode', reviewed: false, review: 'open' });
  expect(await readdir(outputDir)).toEqual(['branch.nc']);
  const branchGcode = await readFile(join(outputDir, 'branch.nc'), 'utf8');
  expect(branchGcode).toContain(`(Setup: ${SETUP_NAME})`);
  expect(branchGcode).toMatch(/^M6 T201$/m);

  // Submit: the review bundle built in Node (renders, measurements, the batches), sent to the
  // server with the branch.
  const submitted = await agent.call('submit_for_review', {
    sessionId,
    note: 'A boss 4 mm across and 5 mm tall on the upright, and a facing setup for the router.',
  });
  expect(ok(submitted)).toEqual({ ok: true, revision: 4, review: 'submitted' });
  const review = ok(await agent.call('get_review', { sessionId }));
  expect(review).toMatchObject({ review: 'submitted', clientName: CLIENT_NAME });
  ok(await agent.call('close_session', { sessionId }));
  // The token is never in the server's log lines.
  expect(agent.stderr()).not.toContain(token);

  await recordBudget('sessionColdStartMs', {
    what: 'MCP server process spawned until open_session answered (worker engine, over sync)',
    total: Math.round(started.ms + opening.ms),
    processReady: Math.round(started.ms),
    openSession: Math.round(opening.ms),
  });
  const batches = [boss.ms, cam.ms, named.ms];
  await recordBudget('batchRoundTripMs', {
    what: 'apply, from the MCP client over stdio, through regen and the sync server, and back',
    batches: batches.map(Math.round),
    refused: Math.round(refused.ms),
    dryRuns: dry.map(Math.round),
    dryRunMedian: Math.round(median(dry)),
  });
  await recordBudget('bundleBuildMs', {
    what: 'submit_for_review: the bundle built in Node (8 renders, measurements, quantities, batches) and uploaded',
    submit: Math.round(submitted.ms),
  });
});

test('the owner reviews the agent branch in the browser and approves it into Main', async () => {
  test.setTimeout(300_000);
  errors = await openEmpty(page);
  await openFromServer(page, server, BRACKET_DOC.id);
  await shown(page);

  // History lists the agent branch, submitted, with its client.
  await page.getByTestId('open-history').click();
  const history = page.getByRole('complementary', { name: 'History' });
  const item = history.getByTestId(`agent-branch-${branchId}`);
  await expect(item.getByTestId('agent-branch-state')).toHaveText('Submitted for review', {
    timeout: 60_000,
  });
  await expect(item.getByTestId('agent-branch-client')).toHaveText(CLIENT_NAME);
  await docShot(page, '01-history-agent-branch');

  await item.getByTestId('agent-branch-review').click();
  const review = page.getByRole('complementary', { name: 'Review' });
  await expect(review).toBeVisible();
  await expect(review.getByTestId('review-client')).toHaveText(CLIENT_NAME);
  await expect(review.getByTestId('review-note')).toContainText('A boss 4 mm across');
  // Base and head renders of the four fixed views, each checked against its SHA-256.
  await expect(review.locator('img.review-image[data-state="ok"]')).toHaveCount(8, {
    timeout: 60_000,
  });
  await expect(review.getByTestId('review-batches')).toContainText('Add a boss on the upright');
  await expect(review.getByTestId('review-batches')).toContainText('Face the stock top');
  await expect(review.getByTestId('review-batches')).toContainText('Name the setup');
  await expect(review.getByTestId('review-check-stale')).toContainText(
    'describes the branch head (revision 4)',
  );
  // The app regenerates the branch head itself and compares it with the bundle: the branch must be
  // open for that, and the Review view offers to open it.
  await expect(review.getByTestId('review-check-regen')).toHaveAttribute('data-state', 'not-open');
  const opening = performance.now();
  await review.getByTestId('review-open-branch').click();
  await expect(page.getByTestId('branch-select').locator('option:checked')).toHaveText(branchName);
  await expect(review.getByTestId('review-check-regen')).toHaveAttribute('data-state', 'match', {
    timeout: 90_000,
  });
  const regenCheckMs = performance.now() - opening;
  await expect(review.getByTestId('review-check-merge')).toContainText('3 batches apply');
  await docShot(page, '02-review');

  const approve = review.getByTestId('review-approve');
  await expect(approve).toBeEnabled();
  const approving = performance.now();
  await approve.click();
  await expect(review.getByTestId('review-outcome')).toContainText('Approved and merged', {
    timeout: 60_000,
  });
  const approveMs = performance.now() - approving;
  await expect(review.getByTestId('review-state')).toHaveText('Approved');
  await expect(page.getByTestId('branch-select').locator('option:checked')).toHaveText('Main');
  await shown(page);
  const main = await page.evaluate(() => {
    const doc = window.__manufakture!.document.getState().document as unknown as {
      parts: { features: { name: string }[] }[];
      cam: { setups: { name: string }[] };
    };
    return {
      features: doc.parts[0]!.features.map((f) => f.name),
      setups: doc.cam.setups.map((s) => s.name),
    };
  });
  expect(main.features).toContain('Boss');
  expect(main.setups).toEqual([SETUP_NAME]);
  await expect(history.getByTestId(`version-Approved: ${branchName}`)).toBeVisible();
  await synced(page);

  // On the server: Main has the merge, the branch is approved, and the version records the review.
  await expect
    .poll(async () => {
      const r = await server.owner('GET', `/documents/${BRACKET_DOC.id}/branches`);
      const b = (r.body as { branches: { id: string; provenance?: { review: string } }[] })
        .branches;
      return b.find((x) => x.id === branchId)?.provenance?.review;
    })
    .toBe('approved');
  await expect
    .poll(async () => {
      const r = await server.owner('GET', `/documents/${BRACKET_DOC.id}/versions`);
      return (r.body as { versions: { name: string }[] }).versions.map((v) => v.name);
    })
    .toContain(`Approved: ${branchName}`);
  await review.getByRole('button', { name: 'Close review' }).click();
  await page.waitForFunction(
    () => (window.__manufakture?.viewport.info().bodies.length ?? 0) === 1,
    null,
    { timeout: 60_000 },
  );
  if (DOCS) await page.getByRole('button', { name: 'Fit', exact: true }).click();
  await docShot(page, '03-approved');
  await recordBudget('reviewMs', {
    what: 'in the browser: Open the branch until its regen matches the bundle; Approve until merged and recorded',
    regenCheck: Math.round(regenCheckMs),
    approve: Math.round(approveMs),
  });
});

test('G-code exported from Main names the review its work came from', async () => {
  test.setTimeout(300_000);
  // Main's work came from the agent's review: the version the approval made says which.
  const reviewOf = await page.evaluate(async () => {
    const hooks = window.__manufakture!;
    const library = hooks.library as unknown as {
      reviewOf(
        id: string,
      ): Promise<
        | { ok: true; value: { version: { name: string }; review: Data } | null }
        | { ok: false; message: string }
      >;
    };
    const r = await library.reviewOf(hooks.document.getState().document.id);
    if (!r.ok) throw new Error(r.message);
    return r.value;
  });
  expect(reviewOf?.version.name).toBe(`Approved: ${branchName}`);
  expect(reviewOf?.review).toMatchObject({
    branch: branchId,
    sessionId,
    clientName: CLIENT_NAME,
    bundleRevision: 4,
  });

  // The CAM workspace on Main: the agent's setup, exported (generated first), then saved.
  await expect(page.getByTestId('branch-select').locator('option:checked')).toHaveText('Main');
  await page.getByTestId('open-cam').click();
  await expect(page.getByTestId('cam-setup-name')).toHaveValue(SETUP_NAME);
  await page.getByTestId('cam-export').click();
  await expect(page.getByTestId('cam-export-dialog')).toBeVisible();
  await expect(page.getByTestId('cam-export-summary')).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId('cam-export-post')).toHaveValue('carbide-motion');
  await expect(page.getByTestId('cam-export-tools').locator('li')).toHaveText([
    /^T201 #?.*1\/4" flat end mill: Face the top/,
  ]);
  await docShot(page, '04-gcode-from-main');
  await expect(page.getByTestId('cam-export-save')).toBeEnabled();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('cam-export-save').click(),
  ]);
  expect(download.suggestedFilename()).toMatch(new RegExp(` - ${SETUP_NAME}\\.nc$`));
  const text = await readFile(await download.path(), 'utf8');
  expect(text).toContain('(Job: Bracket)');
  expect(text).toContain(`(Setup: ${SETUP_NAME})`);
  expect(text).toMatch(/^M6 T201$/m);
  expect(text).toContain('(Face the top)');
  await page.getByTestId('cam-export-close').click();

  // A new session starts from Main's head, the version that records the review.
  const opened = ok(await agent!.call('open_session', { documentId: BRACKET_DOC.id }));
  const versions = await server.owner('GET', `/documents/${BRACKET_DOC.id}/versions`);
  const approval = (versions.body as { versions: { id: string; name: string }[] }).versions.find(
    (v) => v.name === `Approved: ${branchName}`,
  );
  expect(approval).toBeDefined();
  expect(opened.baseVersion).toBe(approval!.id);
  const tree = ok(await agent!.call('get_tree', { sessionId: opened.sessionId as string }));
  expect(JSON.stringify(tree)).toContain('Boss');
  ok(await agent!.call('close_session', { sessionId: opened.sessionId as string }));
  expect(errors).toEqual([]);
});
