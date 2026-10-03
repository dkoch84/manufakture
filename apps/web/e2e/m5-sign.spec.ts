import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { strFromU8, unzipSync } from 'fflate';
import { format, resolveConfig } from 'prettier';
import { CARBIDE_MOTION_DIALECT } from '../../../packages/cam/src/post/carbide-motion';
import { GRBL_DIALECT } from '../../../packages/cam/src/post/grbl';
import type { GcodeReport, VerifyTool } from '../../../packages/cam/test/verify-gcode';
import { addVariable, bodyVolume, openEmpty, view } from './bracket';
import { clickWorld, project, settle } from './helpers';
import {
  MACHINE,
  SIGN,
  STOCK,
  SVG_WORD,
  SVG_WORD_CAP_HEIGHT,
  SVG_WORD_TEXT,
  TOOLS,
  build,
  cutCommands,
  grooveVolume,
  holesVolume,
  host,
  plateCommands,
  plateVolume,
  verifySignFile,
  wordArea,
} from './m5-fixtures';
import { newSketch, sketchIdle, sketchState } from './sketch-helpers';

// M5 acceptance: a plywood sign, end to end, through the UI (docs/m5-acceptance.md; the M5 plan,
// T5.7a). The model is in m5-fixtures.ts: a 400 x 200 mm plate #thickness thick (the sheet as
// measured) with rounded corners, a recessed border, two mounting holes and "WOODSHOP" imported
// from an SVG file. Then, in the Manufacture workspace:
//
//  1. Three tools from the built-in library: the #301 90 degree V-bit, the #102 1/8" and the #201
//     1/4" flat end mills.
//  2. A setup on the Shapeoko 5 Pro 4x4 (its default configuration) in plywood, the stock from the
//     part with 10 mm margins at the sides and none above or below (sheet stock), the origin on
//     the stock's top front left corner.
//  3. Operations, in cut order: a pocket of the border's floor (picked in the view) with the 1/8";
//     the two holes bored with the 1/8"; a V-carve of the lettering with the V-bit, 2 mm deep at
//     most, its flat floors cleared first by the 1/8"; a profile outside the plate's outline with
//     the 1/4", through, with four tabs. Three tools, each loaded once.
//  4. Generate: the four operations' toolpaths, timed.
//  5. Simulate the whole program on the material-removal heightmap against the part's mesh: no
//     gouge and no rapid through material; material is left only on the letters' walls (sloped
//     by the V-bit, straight in the model), never deeper than the letters, and every leftover
//     cell lies in the lettering's box (none on the border, the holes or the outline). Timed.
//  6. Export with the machine's default post, Carbide Motion (one file, M6 at each tool change),
//     and with the GRBL post (one file per tool, a zip with the setup sheet). Each export warns of
//     the clearing's entry and of at most a few tiny arcs written as lines. Every file passes
//     the G-code verifier (packages/cam/test/verify-gcode.ts): the dialect's words, Grbl's arc
//     rule, the machine travel, the stock box and the depth.
//
// The files go to test-results/m5-sign/ for CI's optional `gcode-validate` job (Grbl's and
// grblHAL's own parsers, .github/workflows/ci.yml), with numbers.json: the timings, the file
// sizes and the estimated cut time. With M5_DOCS=1 the run also refreshes the screenshots in
// docs/m5-acceptance/ and writes numbers.json there.

const docsDir = (info: TestInfo) => resolve(info.project.testDir, '../../../docs/m5-acceptance');

async function docShot(page: Page, info: TestInfo, name: string): Promise<void> {
  if (!process.env.M5_DOCS) return;
  await page.mouse.move(0, 0);
  await settle(page);
  const dir = docsDir(info);
  await mkdir(dir, { recursive: true });
  await page.screenshot({ path: join(dir, `${name}.png`) });
}

/** Scroll the panel holding `testId` so that the element (or its label) is at the top. */
async function scrollToTop(page: Page, testId: string): Promise<void> {
  await page
    .getByTestId(testId)
    .evaluate((el) => (el.closest('label') ?? el).scrollIntoView({ block: 'start' }));
}

type SimHook = { cells(kind: 'gouge' | 'leftover'): [number, number][] };

type PreviewHook = { state(): { moveCount: number; done: number; message: string | null } };

function previewState(page: Page) {
  return page.evaluate(() =>
    (window.__manufakture as unknown as { camPreview: PreviewHook }).camPreview.state(),
  );
}

/** Click Save in the export dialog and return the downloaded file's name and bytes. */
async function save(page: Page): Promise<{ name: string; bytes: Uint8Array }> {
  await expect(page.getByTestId('cam-export-save')).toBeEnabled();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('cam-export-save').click(),
  ]);
  const bytes = new Uint8Array(await readFile(await download.path()));
  return { name: download.suggestedFilename(), bytes };
}

/** A tool of TOOLS by the number in a file name ("... - 2 of 3 - #301 90 deg V-bit.nc"). */
function toolOfFile(name: string): VerifyTool {
  const tool = Object.values(TOOLS).find((t) => name.includes(` - #${t.number} `));
  if (!tool) throw new Error(`No tool for ${name}`);
  return tool;
}

/** The cell size, mm, from the simulation's status line ("... cells of 0.50 mm."). */
function simStatusCell(status: string): string {
  return status.match(/cells of ([\d.]+) mm/)![1]!;
}

/** "1:23:45" or "12:34" as seconds. */
function seconds(clock: string): number {
  const parts = clock.split(':').map(Number);
  return parts.reduce((s, p) => s * 60 + p, 0);
}

/**
 * The export's warnings, exactly: the V-carve clearing's entry, and at most a few arcs written as
 * lines by `post`; returns how many arcs.
 */
async function exportWarnings(page: Page, post: string): Promise<number> {
  const items = page.getByTestId('cam-export-warnings').locator('li');
  await expect(items).toHaveText([
    /^V-carve 1 \(clearing\): A helix does not fit in part of the pocket /,
    new RegExp(`^${post.replace('.', '\\.')}: \\d+ arcs? (was|were) written as straight lines`),
  ]);
  const arcs = Number((await items.nth(1).innerText()).match(/: (\d+) arc/)![1]);
  expect(arcs).toBeGreaterThan(0);
  expect(arcs).toBeLessThanOrEqual(MAX_LINEAR_ARCS);
  return arcs;
}

/** How many arcs the export may write as lines: a handful of tiny ones, not a whole pass. */
const MAX_LINEAR_ARCS = 4;

const fileEntry = (post: string, name: string, text: string, report: GcodeReport) => ({
  post,
  name,
  bytes: new TextEncoder().encode(text).length,
  lines: report.lines,
  toolChanges: report.toolChanges,
});

test('M5 acceptance: the plywood sign, modelled, machined, simulated and exported', async ({
  page,
}, testInfo) => {
  test.setTimeout(600_000);
  const errors = await openEmpty(page);
  const t = SIGN.thickness;
  const out = join(testInfo.project.outputDir, 'm5-sign');
  await mkdir(out, { recursive: true });

  // --- The model --------------------------------------------------------------------------------

  // #thickness is the sheet as measured; the plate, and the border and hole sketches on its top.
  await addVariable(page, 'thickness', `${t} mm`);
  await expect(page.getByTestId('variable-thickness-value')).toHaveText(`${t.toFixed(2)} mm`);
  await build(page, plateCommands(), 'Make the plate');
  expect(await bodyVolume(page)).toBeCloseTo(plateVolume(), 2);

  // The lettering: the top face picked in the view, a sketch on it, the SVG file imported as one
  // outline at twice its size, centred on the sign.
  await view(page, 'iso');
  await clickWorld(page, [SIGN.width / 2, 30, t]);
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__manufakture!.selection.getState().selected.map((i) => i.name ?? i.id),
      ),
    )
    .toEqual(['extrude#1:cap:end']);
  await newSketch(page, 'Selected face');
  await page.getByRole('button', { name: 'Import SVG' }).click();
  const dialog = page.getByRole('dialog', { name: 'Import SVG' });
  await dialog.getByTestId('svg-import-file').setInputFiles({
    name: 'woodshop.svg',
    mimeType: 'image/svg+xml',
    buffer: readFileSync(SVG_WORD),
  });
  await expect(dialog.getByTestId('svg-import-mode')).toHaveValue('outline');
  await expect(dialog.getByTestId('svg-import-counts')).toHaveText('8 shapes as one outline');
  await dialog.getByTestId('svg-import-scale').fill(String(SIGN.lettering.scale));
  await dialog.getByTestId('svg-import-anchor').selectOption('center');
  await dialog.getByTestId('svg-import-x').fill(String(SIGN.lettering.centre[0]));
  await dialog.getByTestId('svg-import-y').fill(String(SIGN.lettering.centre[1]));
  // The lettering's size as placed: its box on the sign, for the simulation's leftover check.
  const placedSize = (
    await dialog.getByTestId('svg-import-summary').locator('p').first().innerText()
  )
    .match(/([\d.]+) mm by ([\d.]+) mm/)!
    .slice(1, 3)
    .map(Number) as [number, number];
  expect(placedSize[0]).toBeGreaterThan(300);
  expect(placedSize[1]).toBeGreaterThan(40);
  const [cx, cy] = SIGN.lettering.centre;
  const letteringBox = {
    min: [cx - placedSize[0] / 2, cy - placedSize[1] / 2],
    max: [cx + placedSize[0] / 2, cy + placedSize[1] / 2],
  };
  // The dialog is wholly in the window.
  const box = (await dialog.boundingBox())!;
  const viewport = page.viewportSize()!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
  await docShot(page, testInfo, '01-svg-import');
  await dialog.getByTestId('svg-import-ok').click();
  await expect(dialog).toBeHidden();
  await sketchIdle(page);
  expect((await sketchState(page)).entities.map((e) => e.kind)).toEqual(['outline']);
  await expect(page.getByTestId('region-fill')).toHaveCount(8);
  await docShot(page, testInfo, '02-lettering');
  await page.getByRole('button', { name: 'Finish sketch' }).click();
  await expect(page.getByTestId('feature-sketch#4')).toBeVisible();

  // The cuts: the border groove, the holes, the letters. The volume by hand: the plate less the
  // groove, the holes and the letters' area (from the font) times their depth.
  await build(page, cutCommands(), 'Cut the border, the holes and the lettering');
  const letters =
    wordArea(SVG_WORD_TEXT, SVG_WORD_CAP_HEIGHT * SIGN.lettering.scale) * SIGN.lettering.depth;
  const expectedVolume = plateVolume() - grooveVolume() - holesVolume() - letters;
  const volume = await bodyVolume(page);
  console.log(`m5 sign: volume ${volume.toFixed(2)} mm3, by hand ${expectedVolume.toFixed(2)}`);
  expect(Math.abs(volume - expectedVolume) / expectedVolume).toBeLessThan(1e-4);
  await view(page, 'iso');
  await page.evaluate(() => window.__manufakture!.selection.getState().clear());
  await docShot(page, testInfo, '03-sign-model');

  // --- The setup --------------------------------------------------------------------------------

  await page.getByTestId('open-cam').click();
  await expect(page.getByTestId('cam-tree')).toBeVisible();
  await page.getByTestId('cam-open-tools').click();
  for (const [i, tool] of [TOOLS.vbit, TOOLS.eighth, TOOLS.quarter].entries()) {
    await page.getByTestId(`cam-use-${tool.id}`).click();
    // The built-in name starts with the number; it is not shown twice.
    const name = tool.name!;
    expect(name.startsWith(`#${tool.number} `)).toBe(true);
    await expect(page.getByTestId(`cam-tool-tool#${i + 1}`).locator('.cam-tool-name')).toHaveText(
      name,
    );
  }
  // The three tools' notes are long: a taller window for this picture shows them all.
  if (process.env.M5_DOCS) {
    const size = page.viewportSize()!;
    await page.setViewportSize({ width: size.width, height: 1000 });
    // The list's heading, "In this document", at the top.
    await page
      .getByTestId('cam-doc-tools')
      .evaluate((el) => (el.previousElementSibling ?? el).scrollIntoView({ block: 'start' }));
    await docShot(page, testInfo, '04-tools');
    await page.setViewportSize(size);
  }
  await page.getByTestId('cam-tools-close').click();

  await page.getByTestId('cam-add-setup').click();
  await expect(page.getByTestId('cam-setup-machine')).toHaveValue(MACHINE.id);
  await expect(page.getByTestId('cam-setup-post')).toHaveValue('carbide-motion');
  await page.getByTestId('cam-setup-material').selectOption('plywood');
  await expect(page.getByTestId('cam-setup-material')).toHaveValue('plywood');
  await expect(page.getByTestId('cam-wcs-corner')).toHaveValue('front-left');
  await expect(page.getByTestId('cam-wcs-z')).toHaveValue('top');
  await expect(page.getByTestId('cam-stock-fromBody')).toBeChecked();
  for (const k of ['xMin', 'xMax', 'yMin', 'yMax']) {
    await page.getByTestId(`cam-stock-${k}`).fill(`${SIGN.margin} mm`);
  }
  await page.getByTestId('cam-stock-top').fill('0 mm');
  await page.getByTestId('cam-stock-bottom').fill('0 mm');
  await page.getByTestId('cam-stock-apply').click();
  await expect(page.getByTestId('cam-stock-apply')).toBeDisabled();
  await scrollToTop(page, 'cam-setup-machine');
  await docShot(page, testInfo, '05-setup');

  // --- The operations ---------------------------------------------------------------------------

  const opDialog = page.getByTestId('cam-op-dialog');

  // Pocket the border: its floor picked in the view, the 1/8".
  await page.getByTestId('cam-new-pocket').click();
  await expect(opDialog).toHaveAttribute('data-kind', 'pocket');
  await page.getByTestId('cam-op-tool').selectOption('tool#2');
  await view(page, 'top');
  const groove = SIGN.border.inset + SIGN.border.width / 2;
  // Zoomed in on the left side of the groove, faces only in the view's Select filter, so the
  // click lands on its floor and not on an edge or a vertex near it.
  const select = page.getByRole('group', { name: 'Select' });
  await select.getByLabel('Edges').uncheck();
  await select.getByLabel('Vertices').uncheck();
  await page.evaluate((box) => window.__manufakture!.viewport.frameBox(box, false), {
    min: [0, SIGN.height / 2 - 20, 0],
    max: [2 * groove, SIGN.height / 2 + 20, t],
  } as {
    min: [number, number, number];
    max: [number, number, number];
  });
  const floor: [number, number, number] = [groove, SIGN.height / 2, t - SIGN.border.depth];
  // The dialog narrows the view as it opens: wait until the point stays put on screen.
  let last = '';
  await expect
    .poll(async () => {
      await settle(page);
      const at = JSON.stringify(await project(page, floor));
      const same = at === last;
      last = at;
      return same;
    })
    .toBe(true);
  await clickWorld(page, floor);
  await expect(page.getByTestId('cam-source-0')).toContainText('Face extrude#2:');
  await select.getByLabel('Edges').check();
  await select.getByLabel('Vertices').check();
  await expect(page.getByTestId('cam-source-1')).toHaveCount(0);
  await page.getByTestId('cam-op-ok').click();
  await expect(opDialog).toBeHidden();
  // A new operation's dialog starts from the faces selected in the view: clear the floor.
  await page.evaluate(() => window.__manufakture!.selection.getState().clear());

  // Bore the holes with the 1/8", each to its own depth (through).
  await page.getByTestId('cam-new-drill').click();
  await expect(opDialog).toHaveAttribute('data-kind', 'drill');
  await page.getByTestId('cam-op-tool').selectOption('tool#2');
  await page.getByTestId('cam-hole-feature').selectOption('hole#1');
  await page.getByTestId('cam-add-hole').click();
  await expect(page.getByTestId('cam-source-0')).toContainText('Holes of Mounting holes');
  await expect(page.getByTestId('cam-source-1')).toHaveCount(0);
  await expect(page.getByTestId('cam-field-depthMode')).toHaveValue('own');
  await page.getByTestId('cam-op-ok').click();
  await expect(opDialog).toBeHidden();

  // V-carve the lettering: the V-bit, at most 2 mm deep, the floors cleared by the 1/8" first.
  await page.getByTestId('cam-new-vcarve').click();
  await expect(opDialog).toHaveAttribute('data-kind', 'vcarve');
  await expect(page.getByTestId('cam-op-tool')).toHaveValue('tool#1');
  await page.getByTestId('cam-region-sketch').selectOption('sketch#4');
  await page.getByTestId('cam-add-region').click();
  await expect(page.getByTestId('cam-source-0')).toContainText('Regions of Lettering');
  await expect(page.getByTestId('cam-source-1')).toHaveCount(0);
  await page.getByTestId('cam-field-maxDepth').fill(`${SIGN.lettering.depth} mm`);
  await page.getByTestId('cam-field-clearing').check();
  await page.getByTestId('cam-field-clearingTool').selectOption('tool#2');
  await docShot(page, testInfo, '06-vcarve-dialog');
  await page.getByTestId('cam-op-ok').click();
  await expect(opDialog).toBeHidden();

  // Profile outside the plate's outline, through, with tabs, the 1/4".
  await page.getByTestId('cam-new-profile').click();
  await expect(opDialog).toHaveAttribute('data-kind', 'profile');
  await page.getByTestId('cam-op-tool').selectOption('tool#3');
  await page.getByTestId('cam-region-sketch').selectOption('sketch#1');
  await page.getByTestId('cam-add-region').click();
  await expect(page.getByTestId('cam-source-0')).toContainText('Regions of Outline');
  await expect(page.getByTestId('cam-source-1')).toHaveCount(0);
  await expect(page.getByTestId('cam-field-side')).toHaveValue('outside');
  await expect(page.getByTestId('cam-field-depthMode')).toHaveValue('through');
  await page.getByTestId('cam-field-tabs').check();
  await docShot(page, testInfo, '07-profile-dialog');
  await page.getByTestId('cam-op-ok').click();
  await expect(opDialog).toBeHidden();

  // In cut order: the 1/8" pocket, bore and V-carve clearing, then the V-bit, then the 1/4".
  const ops = ['pocket#1', 'drill#1', 'vcarve#1', 'profile#1'];
  for (const id of ops) {
    await expect(page.getByTestId(`cam-op-status-${id}`)).toHaveAttribute('data-state', 'ok', {
      timeout: 90_000,
    });
  }

  // --- Generate ---------------------------------------------------------------------------------

  const generateStart = Date.now();
  await page.getByTestId('cam-generate').click();
  await expect(page.getByTestId('cam-generate-message')).toHaveText(
    'Generated 4 of 4 operations.',
    { timeout: 240_000 },
  );
  const generateMs = Date.now() - generateStart;
  for (const id of ops) {
    await expect(page.getByTestId(`cam-op-status-${id}`)).toHaveAttribute(
      'data-toolpath',
      'generated',
    );
  }
  // No operation warns, but the V-carve's clearing says how it enters the narrowest floors: the
  // letters' floors are a few millimetres wide, and its default helix does not fit everywhere.
  for (const id of ops.filter((o) => o !== 'vcarve#1')) {
    await expect(page.getByTestId(`cam-op-messages-${id}`)).toHaveCount(0);
  }
  await expect(page.getByTestId('cam-op-messages-vcarve#1').locator('li')).toHaveText([
    /^Clearing: A helix does not fit in part of the pocket .*; the tool ramps along the ring there instead\.$/,
  ]);
  const whole = await previewState(page);
  expect(whole.message).toBeNull();
  expect(whole.done).toBe(whole.moveCount);
  const jobTime = (await page.getByTestId('cam-preview-job').innerText()).match(/\d+(:\d\d)+/)![0];
  // Per operation (a V-carve's clearing on a row of its own): cut length and estimated time.
  const perOperation = await page
    .getByTestId('cam-preview-stats')
    .locator('tbody tr[data-testid^="cam-preview-op-"]')
    .evaluateAll((rows) =>
      rows.flatMap((r) => {
        const [, name, cut, time] = [...r.querySelectorAll('td')].map((c) => c.textContent!.trim());
        return cut && time ? [{ name, cut, time }] : [];
      }),
    );
  const stats = page.getByTestId('cam-preview-stats');
  const jobCut = await stats.locator('[data-testid="cam-preview-job"] td').nth(1).innerText();
  const jobNote = (await stats.locator('tfoot .field-note').innerText()).split('.')[0]!;
  await view(page, 'iso');
  await docShot(page, testInfo, '08-toolpaths');

  // --- Simulate ---------------------------------------------------------------------------------

  const simStart = Date.now();
  await page.getByTestId('cam-sim-toggle').check();
  await expect(page.getByTestId('cam-sim-status')).toContainText(
    `Simulated to move ${whole.moveCount} of ${whole.moveCount}`,
    { timeout: 300_000 },
  );
  const simMs = Date.now() - simStart;
  await expect(page.getByTestId('cam-sim-error')).toHaveCount(0);
  await expect(page.getByTestId('cam-sim-gouges')).toContainText('No gouge');
  await expect(page.getByTestId('cam-sim-collisions')).toHaveText(
    'No rapid runs through material.',
  );
  const simStatus = await page.getByTestId('cam-sim-status').innerText();
  // Material is left only where the V-bit's sloped walls meet the letters' straight ones in the
  // model: never deeper than the letters.
  const leftover = await page.getByTestId('cam-sim-leftover').innerText();
  const leftoverDepth = Number(leftover.match(/up to ([\d.]+) mm/)![1]);
  expect(leftoverDepth).toBeLessThanOrEqual(SIGN.lettering.depth);
  // And only on the letters: every leftover cell lies in the lettering's box (widened by a cell
  // and the comparison's sideways allowance), so none on the border, the holes or the outline.
  const sim = await page.evaluate(() => {
    const hook = (window.__manufakture as unknown as { camSim: SimHook }).camSim;
    return { leftover: hook.cells('leftover'), gouge: hook.cells('gouge') };
  });
  expect(sim.gouge).toEqual([]);
  const leftoverCells = Number(leftover.match(/: (\d+) cells/)![1]);
  expect(sim.leftover).toHaveLength(leftoverCells);
  expect(leftoverCells).toBeGreaterThan(0);
  const gougeLine = await page.getByTestId('cam-sim-gouges').innerText();
  const slack =
    Number(simStatusCell(simStatus)) + Number(gougeLine.match(/within ([\d.]+) mm of a wall/)![1]);
  const outside = sim.leftover.filter(
    ([x, y]) =>
      x < letteringBox.min[0]! - slack ||
      x > letteringBox.max[0]! + slack ||
      y < letteringBox.min[1]! - slack ||
      y > letteringBox.max[1]! + slack,
  );
  expect(outside).toEqual([]);
  await view(page, 'iso');
  await docShot(page, testInfo, '09-simulation');
  // Close up from above, the toolpaths hidden: the letters' V-carved walls (material left where
  // the model's walls are straight), a mounting hole bored, the border's groove.
  if (process.env.M5_DOCS) {
    const shown = await page.getByTestId('cam-preview-stats').getByRole('checkbox').all();
    for (const box of shown) await box.uncheck();
    await view(page, 'top');
    await page.evaluate((box) => window.__manufakture!.viewport.frameBox(box, false), {
      min: [25, 95, 0],
      max: [95, 170, t],
    } as {
      min: [number, number, number];
      max: [number, number, number];
    });
    await docShot(page, testInfo, '10-simulation-close-up');
    for (const box of shown) await box.check();
  }
  await page.getByTestId('cam-sim-toggle').uncheck();

  // --- Export -----------------------------------------------------------------------------------

  // Carbide Motion, the machine's default post: one file, M6 at each tool change.
  await page.getByTestId('cam-export').click();
  const exportDialog = page.getByTestId('cam-export-dialog');
  await expect(exportDialog).toBeVisible();
  await expect(page.getByTestId('cam-export-summary')).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId('cam-export-post')).toHaveValue('carbide-motion');
  await expect(page.getByTestId('cam-export-refused')).toHaveCount(0);
  // What the export says on the way: the clearing's entry (as on the operation's row), and the
  // few arcs too small for the controller's arc check, written as lines.
  const cmArcs = await exportWarnings(page, 'Carbide Motion');
  const cutTime = (await page.getByTestId('cam-export-time').innerText()).match(/\d+(:\d\d)+/)![0];
  const sheet = page.frameLocator('[data-testid="cam-export-sheet"]');
  await expect(sheet.locator('[data-sheet="stock"]')).toContainText(
    `${STOCK.max[0]} x ${STOCK.max[1]} x ${t} mm`,
  );
  await expect(sheet.locator('[data-sheet="stock"]')).toContainText('stock top, front left corner');
  // Three tools, loaded once each in this cut order.
  await expect(sheet.locator('[data-sheet="tool-changes"] li')).toHaveText([
    /^Load T102 #102 1\/8" flat end mill for Pocket 1/,
    /^Change to T301 #301 90 deg V-bit for V-carve 1/,
    /^Change to T201 #201 1\/4" flat end mill for Profile 1/,
  ]);
  await docShot(page, testInfo, '11-export');

  const files: ReturnType<typeof fileEntry>[] = [];
  const cm = await save(page);
  const cmText = strFromU8(cm.bytes);
  const cmReport = verifySignFile(cmText, CARBIDE_MOTION_DIALECT, 'm6', Object.values(TOOLS));
  expect(cmText.match(/^M6 T\d+$/gm)).toEqual(['M6 T102', 'M6 T301', 'M6 T201']);
  expect(cmReport.toolChanges).toBe(3);
  await mkdir(join(out, 'carbide-motion'), { recursive: true });
  await writeFile(join(out, 'carbide-motion', cm.name), cm.bytes);
  files.push(fileEntry('carbide-motion', cm.name, cmText, cmReport));

  // GRBL, one file per tool: a zip of the files and the setup sheet, each file verified.
  await page.getByTestId('cam-export-post').selectOption('grbl');
  await expect(page.getByTestId('cam-export-multitool')).toHaveValue('files');
  const grblArcs = await exportWarnings(page, 'Grbl 1.1');
  const zip = await save(page);
  const entries = unzipSync(zip.bytes);
  const names = Object.keys(entries);
  const gcodeNames = names.filter((n) => n.endsWith('.nc'));
  expect(names.filter((n) => n.endsWith(' - setup sheet.html'))).toHaveLength(1);
  expect(gcodeNames).toHaveLength(3);
  expect(gcodeNames[0]).toMatch(/ - 1 of 3 - #102 1_8_ flat end mill\.nc$/);
  expect(gcodeNames[1]).toMatch(/ - 2 of 3 - #301 90 deg V-bit\.nc$/);
  expect(gcodeNames[2]).toMatch(/ - 3 of 3 - #201 1_4_ flat end mill\.nc$/);
  await mkdir(join(out, 'grbl'), { recursive: true });
  for (const name of gcodeNames) {
    const text = strFromU8(entries[name]!);
    const report = verifySignFile(text, GRBL_DIALECT, 'none', [toolOfFile(name)]);
    expect(text).not.toMatch(/^M6/m);
    await writeFile(join(out, 'grbl', name), entries[name]!);
    files.push(fileEntry('grbl', name, text, report));
  }
  await writeFile(join(out, 'grbl', zip.name), zip.bytes);
  await page.getByTestId('cam-export-close').click();
  await expect(exportDialog).toBeHidden();

  // --- Numbers ----------------------------------------------------------------------------------

  const numbers = {
    note:
      'Estimates. Timings are wall-clock times of this end-to-end run (a production build in ' +
      'headless Chromium with software WebGL), on the computer named below; the cut time is the ' +
      "app's estimate from the feeds and the machine's rapid rate, ignoring acceleration.",
    computer: host(),
    machine: { id: MACHINE.id, name: MACHINE.name, configuration: 'default' },
    sign: {
      size: [SIGN.width, SIGN.height, t],
      stock: [STOCK.max[0], STOCK.max[1], t],
      volume,
    },
    generate: { ms: generateMs, operations: ops.length, moves: whole.moveCount },
    simulation: {
      ms: simMs,
      status: simStatus,
      gouges: 'none',
      collisions: 'none',
      leftover,
      leftoverOutsideLettering: 0,
    },
    arcsWrittenAsLines: { 'carbide-motion': cmArcs, grbl: grblArcs },
    estimatedCutTime: {
      preview: jobTime,
      export: cutTime,
      seconds: seconds(cutTime),
      job: `${jobCut} cut; ${jobNote}`,
      operations: perOperation,
    },
    files,
  };
  // Formatted as the repository's Prettier would, so the committed copy passes `pnpm lint`.
  const docsNumbers = join(docsDir(testInfo), 'numbers.json');
  const json = await format(JSON.stringify(numbers), {
    ...(await resolveConfig(docsNumbers)),
    parser: 'json',
  });
  console.log(`m5 sign numbers: ${json}`);
  await writeFile(join(out, 'numbers.json'), json);
  if (process.env.M5_DOCS) await writeFile(docsNumbers, json);
  expect(errors).toEqual([]);
});
