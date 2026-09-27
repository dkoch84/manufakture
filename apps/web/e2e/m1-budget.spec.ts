import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { buildBracket, editVariable, regenerated } from './bracket';

// Performance budgets for M1: how long the app takes to have the geometry kernel ready (on a
// first visit with an empty HTTP cache, and after a reload), and how long the M1 bracket takes
// to regenerate (the whole part, and after a change of #thickness).
//
// The numbers are recorded, not tuned against: they go to the console, to a JSON attachment,
// to test-results/m1-budget.json and, in GitHub Actions, to the job summary. The budgets are
// generous on purpose (tens of times what a laptop takes, several times a slow CI runner) and
// fail only on a large regression, such as a regen that rebuilds far more than it should or a
// kernel start-up that stalls. The server is `vite preview` on localhost, so the 42 MB kernel
// download costs next to nothing here, and the preview server sends no caching headers, so a
// reload fetches it again (hosting serves it immutable, ADR 0002). The browser is headless
// Chromium on shared machines; the numbers say little about a user's machine, and SwiftShader
// (software WebGL) makes anything drawn slower than on a GPU.

const BUDGET_MS = {
  /** Navigation start to kernel ready and the first model shown, empty HTTP cache. */
  coldStart: 30_000,
  /** The same after a reload, with a document to open and regenerate. */
  reloadStart: 30_000,
  /** Regenerating the whole bracket in the worker (after the reload). */
  fullRegen: 5_000,
  /** Regenerating after #thickness changes (every feature reads it), in the worker. */
  editRegen: 5_000,
  /** From saving the variable to the new part in the model, as the user waits for it. */
  editRoundTrip: 10_000,
};

type Measures = Record<keyof typeof BUDGET_MS, number>;

/** Milliseconds from navigation start until the kernel is ready and the model is regenerated. */
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

/**
 * Record the kernel wasm responses (the worker fetches it, so the page's Resource Timing never
 * sees it; Playwright's network events do), with the body size fetched (0 from a cache).
 */
function watchWasm(page: Page) {
  const seen: { url: string; bytes: number }[] = [];
  page.context().on('requestfinished', (request) => {
    if (!request.url().endsWith('.wasm')) return;
    void request.sizes().then((sizes) => {
      seen.push({ url: new URL(request.url()).pathname, bytes: sizes.responseBodySize });
    });
  });
  return seen;
}

const regenMs = (page: Page) => page.evaluate(() => window.__manufakture!.model.getState().ms);

test('kernel start-up and bracket regeneration stay within their budgets', async ({
  page,
}, testInfo) => {
  test.setTimeout(300_000);

  // Cold: every test runs in a fresh browser context, with nothing cached.
  const wasm = watchWasm(page);
  await page.goto('/');
  const coldStart = await readyAt(page);
  await expect(page.getByTestId('empty-hint')).toBeVisible();
  // The kernel really was downloaded: its wasm (tens of MB) came over the network.
  await expect.poll(() => wasm.length).toBeGreaterThan(0);
  expect(Math.max(...wasm.map((w) => w.bytes))).toBeGreaterThan(10_000_000);
  await buildBracket(page);
  await expect(page.getByTestId('save-status')).toHaveText('Saved', { timeout: 15_000 });

  // A reload: the document is read back from storage and the bracket regenerated whole.
  await page.reload();
  const reloadStart = await readyAt(page);
  await regenerated(page);
  const fullRegen = await regenMs(page);

  // Edits: five new values of #thickness, none seen before, so no feature comes from the cache;
  // the median of the five.
  const edits: { worker: number; roundTrip: number }[] = [];
  for (const t of [7, 8, 9, 10, 11]) {
    const start = Date.now();
    await editVariable(page, 'thickness', String(t));
    const statuses = await regenerated(page);
    const roundTrip = Date.now() - start;
    expect(Object.values(statuses).every((s) => s.status === 'ok')).toBe(true);
    edits.push({ worker: await regenMs(page), roundTrip });
  }
  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
  const measures: Measures = {
    coldStart,
    reloadStart,
    fullRegen,
    editRegen: median(edits.map((e) => e.worker)),
    editRoundTrip: median(edits.map((e) => e.roundTrip)),
  };

  const rows = (Object.keys(BUDGET_MS) as (keyof Measures)[]).map((k) => ({
    measure: k,
    ms: Math.round(measures[k]),
    budget: BUDGET_MS[k],
  }));
  const report = { measures: rows, edits, wasm };
  console.log(`m1 budget: ${JSON.stringify(rows)}`);
  await testInfo.attach('m1-budget', {
    body: JSON.stringify(report, null, 2),
    contentType: 'application/json',
  });
  await mkdir(testInfo.project.outputDir, { recursive: true });
  await writeFile(
    join(testInfo.project.outputDir, 'm1-budget.json'),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) {
    await appendFile(
      summary,
      [
        '### M1 performance (headless Chromium on a CI runner; not representative of a desktop)',
        '',
        '| Measure | Time | Budget |',
        '| --- | ---: | ---: |',
        ...rows.map((r) => `| ${r.measure} | ${r.ms} ms | ${r.budget} ms |`),
        '',
      ].join('\n'),
    );
  }

  for (const r of rows) expect(r.ms, `${r.measure} over budget`).toBeLessThanOrEqual(r.budget);
});
