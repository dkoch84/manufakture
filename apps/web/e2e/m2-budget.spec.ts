import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { openEmpty, regenerated, view } from './bracket';
import { project } from './helpers';
import {
  DRAWER,
  SHELF,
  buildWallShelf,
  execute,
  expectNear,
  instance,
  saved,
  solved,
} from './m2-fixtures';

// Performance budgets for M2, on the acceptance assembly (m2-fixtures.ts): a shelf of four
// bodies with a configuration table, a support derived from another document at a version, a
// drawer, and an assembly of four instances with two fastened mates and a slider.
//
// - Reload: navigation start to the kernel ready and the whole document regenerated, the
//   assembly tab open (three part studios, the pinned bracket's own regen, the assembly solve).
// - Regen in the worker: the whole document, after the reload; after #width changes (the
//   shelf's four bodies rebuilt and the assembly solved again); after a pose changes (the parts
//   come from the cache, so it is about the assembly solve).
// - Drag: from a pointer move over the drawer to the new pose shown, as the user waits for it.
//
// As for M1 (m1-budget.spec.ts), the numbers are recorded, not tuned against: console, JSON
// attachment, test-results/m2-budget.json and the GitHub job summary. The budgets are generous
// on purpose and fail only on a large regression. The solver alone is benchmarked in Node by
// packages/assembly (README, "Benchmark"); these numbers add the worker, the kernel and the
// page around it.

const BUDGET_MS = {
  /** Navigation start to kernel ready and the whole document shown, after a reload. */
  reloadStart: 30_000,
  /** Regenerating the whole document in the worker (after the reload, empty cache). */
  fullRegen: 10_000,
  /** Regenerating after #width changes: four bodies and the assembly, in the worker. */
  widthRegen: 5_000,
  /** From a #width change to the new model, as the user waits for it. */
  widthRoundTrip: 10_000,
  /** Regenerating after a pose changes (parts cached: the assembly solve), in the worker. */
  solveRegen: 1_000,
  /** From a pointer move while dragging the drawer to its new pose on screen. */
  dragStep: 1_000,
};

type Measures = Record<keyof typeof BUDGET_MS, number>;

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

/** Milliseconds from navigation start until the kernel is ready and the model is regenerated. */
async function readyAt(page: Page): Promise<number> {
  const handle = await page.waitForFunction(
    () => {
      const hooks = window.__manufakture;
      const ready =
        !!hooks?.model &&
        !!hooks.document &&
        hooks.model.getState().generation > 0 &&
        !hooks.model.getState().pending &&
        hooks.model.getState().assemblies.length > 0 &&
        document.querySelector('[data-testid="splash"]') === null;
      return ready ? performance.now() : 0;
    },
    null,
    { timeout: 120_000, polling: 50 },
  );
  return (await handle.jsonValue()) as number;
}

const regenMs = (page: Page) => page.evaluate(() => window.__manufakture!.model.getState().ms);

/** The drawer's shown x: a drag's newest answer, or else the last solve. */
const shownX = (page: Page) =>
  page.evaluate(() => {
    const hooks = window.__manufakture!;
    const dragged = hooks.assemblyUi.getState().poses.get('inst#4');
    const solved = hooks.model
      .getState()
      .assemblies[0]!.instances.find((i) => i.instanceId === 'inst#4')!.transform;
    return (dragged ?? solved).translation[0];
  });

test('reload, regeneration, solve and drag of the wall shelf stay within their budgets', async ({
  page,
}, testInfo) => {
  test.setTimeout(300_000);
  const errors = await openEmpty(page);
  await buildWallShelf(page);

  // A reload: the document read back from storage and regenerated whole, the assembly solved.
  await page.reload();
  const reloadStart = await readyAt(page);
  await expect(page.getByTestId('assembly-tab-assembly#1')).toHaveAttribute(
    'aria-selected',
    'true',
  );
  let asm = await solved(page, 'assembly#1');
  expect(asm.dof).toBe(1);
  const fullRegen = await regenMs(page);

  // #width: five values never seen before, so the shelf's bodies are rebuilt each time.
  const widths: { worker: number; roundTrip: number }[] = [];
  for (const w of [610, 620, 630, 640, 650]) {
    const start = Date.now();
    await execute(
      page,
      {
        type: 'setVariable',
        name: 'width',
        expression: { source: `${w} mm`, lengthUnit: 'mm', angleUnit: 'deg' },
      },
      `Width ${w}`,
    );
    asm = await solved(page, 'assembly#1');
    const roundTrip = Date.now() - start;
    // Every profile and body that #width moves is built again; the left side comes from the cache.
    const statuses = await regenerated(page);
    expect(
      Object.fromEntries(Object.entries(statuses).map(([id, s]) => [id, [s.status, s.cached]])),
    ).toEqual({
      'sketch#1': ['ok', true],
      'sketch#2': ['ok', false],
      'sketch#3': ['ok', false],
      'sketch#4': ['ok', false],
      'extrude#1': ['ok', true],
      'extrude#2': ['ok', false],
      'extrude#3': ['ok', false],
      'extrude#4': ['ok', false],
    });
    expect(asm.mates.map((m) => m.status)).toEqual(['ok', 'ok', 'ok']);
    expectNear(instance(asm, 'inst#3').transform.translation, [0, w - 33, 0]);
    widths.push({ worker: await regenMs(page), roundTrip });
  }

  // Poses: the drawer set at five places along its slider; only the assembly is solved again.
  const solves: number[] = [];
  for (const out of [90, 70, 50, 30, 10]) {
    await execute(
      page,
      {
        type: 'setPoses',
        assemblyId: 'assembly#1',
        poses: { 'inst#4': { translation: [20 + out, 200, SHELF.board], rotation: [0, 0, 0, 1] } },
      },
      `Drawer at ${out}`,
    );
    asm = await solved(page, 'assembly#1');
    expect(instance(asm, 'inst#4').transform.translation[0]).toBeCloseTo(20 + out, 6);
    solves.push(await regenMs(page));
  }

  // A drag of the drawer, step by step: each pointer move until the drawer is shown elsewhere.
  // It is 10 mm out (x 30 to 210): grabbed on its top just in front of the top board, which
  // hides the rest from the iso view, and pulled out 120 mm. The first move only starts the
  // drag (a short move is a click); the eight after it are timed.
  await view(page, 'iso');
  const z = SHELF.board + DRAWER.size[2];
  const along = async (mm: number) => project(page, [205 + mm, 325, z]);
  const grab = await along(0);
  await page.mouse.move(grab.x, grab.y);
  await page.mouse.down();
  let at = await shownX(page);
  const start = await along(10);
  await page.mouse.move(start.x, start.y);
  await expect.poll(() => shownX(page), { intervals: [5], timeout: 10_000 }).not.toBe(at);
  const steps: number[] = [];
  for (let i = 1; i <= 8; i++) {
    at = await shownX(page);
    const to = await along(10 + 13 * i);
    const t0 = Date.now();
    await page.mouse.move(to.x, to.y);
    await expect.poll(() => shownX(page), { intervals: [5], timeout: 10_000 }).not.toBe(at);
    steps.push(Date.now() - t0);
  }
  await page.mouse.up();
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toHaveAttribute(
    'title',
    'Undo Drag Drawer 1 (Ctrl+Z)',
  );
  // It only slid: square, centred on the 650 mm shelf, on the board, and further out.
  asm = await solved(page, 'assembly#1');
  const drawer = instance(asm, 'inst#4').transform;
  expectNear(drawer.translation.slice(1), [650 / 2 - DRAWER.size[1] / 2, SHELF.board]);
  expectNear(drawer.rotation, [0, 0, 0, 1], 6);
  expect(drawer.translation[0]).toBeGreaterThan(30);
  expect(drawer.translation[0]).toBeLessThanOrEqual(20 + DRAWER.limits[1] + 1e-6);
  await saved(page);

  const measures: Measures = {
    reloadStart,
    fullRegen,
    widthRegen: median(widths.map((w) => w.worker)),
    widthRoundTrip: median(widths.map((w) => w.roundTrip)),
    solveRegen: median(solves),
    dragStep: median(steps),
  };
  const rows = (Object.keys(BUDGET_MS) as (keyof Measures)[]).map((k) => ({
    measure: k,
    ms: Math.round(measures[k] * 10) / 10,
    budget: BUDGET_MS[k],
  }));
  const report = { measures: rows, widths, solves, steps };
  console.log(`m2 budget: ${JSON.stringify(rows)}`);
  await testInfo.attach('m2-budget', {
    body: JSON.stringify(report, null, 2),
    contentType: 'application/json',
  });
  await mkdir(testInfo.project.outputDir, { recursive: true });
  await writeFile(
    join(testInfo.project.outputDir, 'm2-budget.json'),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) {
    await appendFile(
      summary,
      [
        '### M2 performance (headless Chromium on a CI runner; not representative of a desktop)',
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
