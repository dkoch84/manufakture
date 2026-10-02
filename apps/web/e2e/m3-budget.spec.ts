import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { openEmpty, regenerated } from './bracket';
import { execute, saved } from './m2-fixtures';
import { buildJig, checked } from './m3-fixtures';

// Performance budgets for M3, on the acceptance jig (m3-fixtures.ts): one part studio of two
// bodies with a debossed label, two modelled M5 threads, a chamfer, a slot and a lobed head, and
// a print setup of two items on the X1 Carbon.
//
// - Reload: navigation start to the kernel ready and the whole jig regenerated.
// - Regen in the worker: the whole jig after the reload (empty cache: the label laid out, both
//   threads built); after #fit_slip changes (the bore, the side hole, the shank and both threads
//   rebuilt, and everything after them); after the label's string changes (the text laid out
//   again and every feature after it rebuilt, the threads included).
// - Print analysis in the worker: wall thickness and gaps of both bodies at the export
//   tolerance, after the print workspace opens and after each quarter turn of the block.
//
// As for M1 and M2 (m1-budget.spec.ts, m2-budget.spec.ts), the numbers are recorded, not tuned
// against: console, JSON attachment, test-results/m3-budget.json and the GitHub job summary. The
// budgets are generous on purpose and fail only on a large regression.

const BUDGET_MS = {
  /** Navigation start to kernel ready and the whole jig shown, after a reload. */
  reloadStart: 30_000,
  /** Regenerating the whole jig in the worker (after the reload, empty cache). */
  fullRegen: 20_000,
  /** Regenerating after #fit_slip changes, in the worker. */
  slipRegen: 10_000,
  /** From a #fit_slip change to the new model, as the user waits for it. */
  slipRoundTrip: 15_000,
  /** Regenerating after the label's string changes, in the worker. */
  labelRegen: 10_000,
  /** Wall thickness and gaps of both bodies, in the print-analysis worker. */
  analysis: 5_000,
};

type Measures = Record<keyof typeof BUDGET_MS, number>;

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

/** Milliseconds from navigation start until the kernel is ready and the jig is regenerated. */
async function readyAt(page: Page): Promise<number> {
  const handle = await page.waitForFunction(
    () => {
      const hooks = window.__manufakture;
      const ready =
        !!hooks?.model &&
        !!hooks.document &&
        hooks.model.getState().generation > 0 &&
        !hooks.model.getState().pending &&
        (hooks.model.getState().parts[0]?.bodies.length ?? 0) === 2 &&
        document.querySelector('[data-testid="splash"]') === null;
      return ready ? performance.now() : 0;
    },
    null,
    { timeout: 120_000, polling: 50 },
  );
  return (await handle.jsonValue()) as number;
}

const regenMs = (page: Page) => page.evaluate(() => window.__manufakture!.model.getState().ms);

async function allOk(page: Page): Promise<void> {
  const statuses = await regenerated(page);
  for (const [id, s] of Object.entries(statuses)) {
    expect(s, id).toMatchObject({ status: 'ok', errors: [] });
  }
}

/** The worker's time for the analysis now shown, once it is for the setup as it is now. */
async function analysisMs(page: Page): Promise<number> {
  await checked(page);
  return page.evaluate(
    () => (window.__manufakture!.print!.analysis() as unknown as { ms: number }).ms,
  );
}

test('reload, regeneration and print analysis of the jig stay within their budgets', async ({
  page,
}, testInfo) => {
  test.setTimeout(300_000);
  const errors = await openEmpty(page);
  await buildJig(page);
  await saved(page);

  // A reload: the jig read back from storage and regenerated whole.
  await page.reload();
  const reloadStart = await readyAt(page);
  await allOk(page);
  const fullRegen = await regenMs(page);

  // #fit_slip: five values never seen before, so everything that reads it is built again.
  const slips: { worker: number; roundTrip: number }[] = [];
  for (const slip of [0.21, 0.22, 0.23, 0.24, 0.25]) {
    const start = Date.now();
    await execute(
      page,
      {
        type: 'setVariable',
        name: 'fit_slip',
        expression: { source: `${slip} mm`, lengthUnit: 'mm', angleUnit: 'deg' },
      },
      `Slip ${slip}`,
    );
    const statuses = await regenerated(page);
    const roundTrip = Date.now() - start;
    for (const [id, s] of Object.entries(statuses)) {
      expect(s, id).toMatchObject({ status: 'ok', errors: [] });
    }
    // The block and the label come from the cache; the bore and both threads are rebuilt.
    expect(statuses['extrude#2']!.cached).toBe(true);
    expect(statuses['extrude#3']!.cached).toBe(false);
    expect(statuses['thread#1']!.cached).toBe(false);
    expect(statuses['thread#2']!.cached).toBe(false);
    slips.push({ worker: await regenMs(page), roundTrip });
  }

  // The label's string, five never seen before (the cache holds the ones that were): the text is
  // laid out again and everything after it built.
  const labels: number[] = [];
  for (const text of ['PTFE 5', 'PTFE 6', 'PTFE 7', 'PTFE 8', 'PTFE 9']) {
    const sketch = await page.evaluate(() =>
      window
        .__manufakture!.document.getState()
        .document.parts[0]!.features.find((f) => f.id === 'sketch#2')!,
    );
    const outline = sketch.entities![0] as unknown as { source: { text: string } };
    outline.source.text = text;
    await execute(
      page,
      { type: 'editFeature', partId: 'part#1', feature: sketch },
      `Label ${text}`,
    );
    const statuses = await regenerated(page);
    expect(statuses['extrude#2']!.cached).toBe(false);
    expect(statuses['thread#1']!.cached).toBe(false);
    for (const [id, s] of Object.entries(statuses)) {
      expect(s, id).toMatchObject({ status: 'ok', errors: [] });
    }
    labels.push(await regenMs(page));
  }

  // The print workspace: the analysis when it opens, and after each quarter turn of the block.
  await page.getByTestId('open-print').click();
  const analyses = [await analysisMs(page)];
  await page.getByTestId('print-item-item#1').locator('.print-item-pick').click();
  for (let i = 0; i < 4; i++) {
    const before = await page.evaluate(
      () => window.__manufakture!.print!.resolved()!.items[0]!.copies[0]!.placement.rotation,
    );
    await page.getByTestId('print-rotate-z').click();
    await page.waitForFunction(
      (r) =>
        window.__manufakture!.print!.resolved()!.items[0]!.copies[0]!.placement.rotation.join() !==
        r.join(),
      before,
    );
    analyses.push(await analysisMs(page));
  }

  const measures: Measures = {
    reloadStart,
    fullRegen,
    slipRegen: median(slips.map((s) => s.worker)),
    slipRoundTrip: median(slips.map((s) => s.roundTrip)),
    labelRegen: median(labels),
    analysis: median(analyses),
  };
  const rows = (Object.keys(BUDGET_MS) as (keyof Measures)[]).map((k) => ({
    measure: k,
    ms: Math.round(measures[k] * 10) / 10,
    budget: BUDGET_MS[k],
  }));
  const report = { measures: rows, slips, labels, analyses };
  console.log(`m3 budget: ${JSON.stringify(rows)}`);
  await testInfo.attach('m3-budget', {
    body: JSON.stringify(report, null, 2),
    contentType: 'application/json',
  });
  await mkdir(testInfo.project.outputDir, { recursive: true });
  await writeFile(
    join(testInfo.project.outputDir, 'm3-budget.json'),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) {
    await appendFile(
      summary,
      [
        '### M3 performance (headless Chromium on a CI runner; not representative of a desktop)',
        '',
        '| Measure | Time | Budget |',
        '| --- | ---: | ---: |',
        ...rows.map((r) => `| ${r.measure} | ${r.ms} ms | ${r.budget} ms |`),
        '',
      ].join('\n'),
    );
  }

  for (const r of rows) expect(r.ms, `${r.measure} over budget`).toBeLessThanOrEqual(r.budget);
  expect(errors).toEqual([]);
});
