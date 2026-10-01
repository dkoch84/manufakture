import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  buildMeshes,
  meshProperties,
  parseStl,
  stepProductNames,
  validate3mf,
} from '@manufakture/io';
import { expect, test, type Download, type Page, type TestInfo } from '@playwright/test';
import {
  addVariable,
  bodyVolume,
  buildBracket,
  editVariable,
  ok,
  openEmpty,
  openTool,
  regenerated,
  view,
} from './bracket';
import { clickWorld, project, type Vec3 } from './helpers';
import {
  BODY_NAMES,
  BRACKET_VERSIONS,
  DRAWER,
  SHELF,
  boxOf,
  bracketVolume,
  download,
  drawerSketch,
  drawerVolume,
  execute,
  expectNear,
  instance,
  pineGrams,
  place,
  saved,
  shelfSketches,
  look,
  shelfVolumes,
  solved,
} from './m2-fixtures';

// M2 acceptance: a wall shelf with a derived bracket, assembled (docs/m2-acceptance.md). The
// chapters share one browser page and its storage, so they run in order and a failing chapter
// skips the ones after it. Every M2 feature is used through its UI: the Bodies list, part studio
// tabs, the Configurations panel and switcher, the History panel and its viewer (versions,
// branches, restore), the Derived part dialog and its update, assembly tabs, Insert, the Mate
// dialog with connectors picked in the view, dragging, the Interference panel, an instance's
// configuration, and Export. The profiles are sketched with commands (the sketcher is M1's and
// its own specs cover it), and so are the poses that set parts aside before they are mated.
//
//  1. The bracket document: the M1 bracket at 6 mm, named "6 mm"; at 8 mm, named "8 mm".
//  2. The shelf: four profiles extruded as four new bodies with exact volumes, named, of pine
//     (their masses), exported as a 3MF of four named objects.
//  3. Configurations: #width in rows 600, 800 and 1000 mm, each rebuilt exactly; a 3MF per row.
//  4. A named version "Open shelf", and a branch from it that is 900 mm wide; main stays 600.
//  5. A second part studio deriving the bracket at "6 mm" (a newer version is offered).
//  6. A third part studio: the drawer.
//  7. The assembly: two supports fastened under the shelf and the drawer on a limited slider,
//     placed exactly where hand computation puts them; dragged; no interference; the shelf
//     instance in its 800 mm configuration, everything following.
//  8. The assembly exported as STEP, 3MF and STL, each part once and each instance placed.
//
// Chapters 4a, 7a and 8a hold the fixes for three defects the walkthrough found: the header
// fits a 1280 px window, a part studio's sketches stay out of the assembly tab, and the bodies
// of a multi-body part are named occurrences in the assembly STEP.
//  9. The support updated to "8 mm": the assembly holds, still without interference.
// 10. A reload brings it all back; restoring "Open shelf" and undoing the restore.
//
// The exports go to test-results/m2-shelf/. With M2_DOCS=1 the run also refreshes the
// screenshots in docs/m2-acceptance/.

test.describe.configure({ mode: 'serial' });

let page: Page;
let errors: string[];

/** Where the walkthrough screenshots go when M2_DOCS=1. */
const docsDir = (info: TestInfo) => resolve(info.project.testDir, '../../../docs/m2-acceptance');

async function docShot(name: string): Promise<void> {
  if (!process.env.M2_DOCS) return;
  await page.mouse.move(0, 0);
  const dir = docsDir(test.info());
  await mkdir(dir, { recursive: true });
  await page.screenshot({ path: join(dir, `${name}.png`) });
}

async function rename(name: string) {
  await execute(page, { type: 'renameDocument', name }, 'Rename document');
}

const history = () => page.getByRole('complementary', { name: 'History' });

/** Name the open document's current state from the History panel. */
async function createVersion(name: string, description?: string) {
  await saved(page);
  await page.getByTestId('open-history').click();
  await history().getByTestId('version-create').click();
  await history().getByTestId('version-name').fill(name);
  if (description) await history().getByTestId('version-description').fill(description);
  await history().getByTestId('version-save').click();
  await expect(history().getByTestId(`version-${name}`)).toBeVisible();
  await history().getByRole('button', { name: 'Close history' }).click();
}

/** With nothing selected: every shown body's exact volume, by viewport id. */
async function bodyVolumes(): Promise<Record<string, number | null>> {
  await page.evaluate(() => window.__manufakture!.selection.getState().clear());
  await page.waitForFunction(() => {
    const s = window.__manufakture!.measure.getState();
    return s.status === 'ready' && s.request?.targets.length === 0 && s.bodies.length > 0;
  });
  return page.evaluate(() =>
    Object.fromEntries(
      window
        .__manufakture!.measure.getState()
        .bodies.map((b) => [b.bodyId, b.body?.volume ?? null]),
    ),
  );
}

/** The shown shelf's bodies have the exact volumes of a shelf `width` wide. */
async function expectShelf(width: number): Promise<void> {
  const v = shelfVolumes(width);
  await expect
    .poll(
      async () => {
        await regenerated(page);
        return bodyVolumes();
      },
      { timeout: 30_000 },
    )
    .toEqual({
      'part#1/extrude#1': expect.closeTo(v.side, 6),
      'part#1/extrude#2': expect.closeTo(v.side, 6),
      'part#1/extrude#3': expect.closeTo(v.board, 6),
      'part#1/extrude#4': expect.closeTo(v.board, 6),
    });
  // And each where it belongs across the width (a side's volume does not depend on it).
  const t = SHELF.board;
  expect(await ySpans()).toEqual({
    'part#1/extrude#1': [0, t],
    'part#1/extrude#2': [width - t, width],
    'part#1/extrude#3': [t, width - t],
    'part#1/extrude#4': [t, width - t],
  });
}

/** Each shown body's extent along Y (the shelf's width), from the edges the viewport shows. */
function ySpans(): Promise<Record<string, [number, number]>> {
  return page.evaluate(() => {
    const out: Record<string, [number, number]> = {};
    for (const g of window.__manufakture!.viewport.geometrySamples()) {
      const ys = g.points.map((p) => p[1]);
      const r = (out[g.bodyId] ??= [Infinity, -Infinity]);
      r[0] = Math.round(Math.min(r[0], ...ys) * 1e6) / 1e6;
      r[1] = Math.round(Math.max(r[1], ...ys) * 1e6) / 1e6;
    }
    return out;
  });
}

/** A part studio's features (status, warnings) and bodies, once the model shows the document. */
async function partResult(partId: string) {
  await regenerated(page);
  return page.evaluate((id) => {
    const part = window.__manufakture!.model.getState().parts.find((p) => p.partId === id)!;
    return {
      features: part.features.map((f) => [f.featureId, f.status, f.warnings.length]),
      bodies: part.bodies.map((b) => [b.bodyId, b.solids]),
    };
  }, partId);
}

test.beforeAll(async ({ browser }, info) => {
  const { baseURL, viewport } = info.project.use;
  const context = await browser.newContext({
    ...(baseURL ? { baseURL } : {}),
    ...(viewport ? { viewport } : {}),
  });
  page = await context.newPage();
});

test.afterAll(async () => {
  await page.context().close();
});

test('1. the bracket document, named at 6 mm and at 8 mm', async () => {
  test.setTimeout(240_000);
  errors = await openEmpty(page);
  await rename('Bracket');
  await buildBracket(page, 6);
  await createVersion('6 mm');
  await editVariable(page, 'thickness', '8');
  await regenerated(page);
  expect(await bodyVolume(page)).toBeCloseTo(bracketVolume(BRACKET_VERSIONS['8 mm']), 3);
  await createVersion('8 mm');
  await page.getByTestId('open-history').click();
  await expect(history().getByTestId('version-6 mm')).toBeVisible();
  await expect(history().getByTestId('version-8 mm')).toBeVisible();
  await docShot('00-bracket-versions');
  await history().getByRole('button', { name: 'Close history' }).click();
});

test('2. the shelf: four bodies of pine in one part studio', async () => {
  test.setTimeout(180_000);
  await page.getByTestId('open-home').click();
  await page.getByRole('button', { name: 'New document' }).click();
  await expect(page.getByTestId('empty-hint')).toBeVisible();
  await rename('Wall shelf');
  await page.getByTestId('part-tab-part#1').dblclick();
  await page.getByTestId('part-rename-input').fill('Shelf');
  await page.getByTestId('part-rename-input').press('Enter');
  await expect(page.getByTestId('part-tab-part#1')).toHaveText('Shelf');

  // #width drives the right side and the boards; the four profiles are drawn on horizontal planes.
  await addVariable(page, 'width', '600');
  await execute(page, { type: 'batch', commands: shelfSketches('part#1') }, 'Draw the profiles');
  await regenerated(page);

  // Each profile extruded upwards as a new body: the sides 300 mm, the boards 18 mm.
  const heights = [SHELF.height, SHELF.height, SHELF.board, SHELF.board];
  for (const [i, h] of heights.entries()) {
    const sketch = `sketch#${i + 1}`;
    await page.getByTestId(`feature-${sketch}`).click();
    await openTool(page, 'Extrude');
    await expect(page.getByTestId('field-sketch')).toHaveValue(sketch);
    await page.getByTestId('field-operation').selectOption('new');
    await page.getByTestId('field-distance').fill(String(h));
    await ok(page);
    await regenerated(page);
  }
  const statuses = await regenerated(page);
  for (const [id, s] of Object.entries(statuses)) {
    expect({ id, status: s.status, warnings: s.warnings }).toEqual({
      id,
      status: 'ok',
      warnings: [],
    });
  }
  const bodies = await page.evaluate(() =>
    window
      .__manufakture!.model.getState()
      .parts[0]!.bodies.map((b) => [b.bodyId, b.solids] as [string, number]),
  );
  expect(bodies).toEqual([
    ['extrude#1', 1],
    ['extrude#2', 1],
    ['extrude#3', 1],
    ['extrude#4', 1],
  ]);
  // Each body is exactly its own extrusion: the sides 200 x 18 x 300, the boards 200 x 564 x 18.
  const v = shelfVolumes(600);
  await expectShelf(600);

  // Named in the Bodies list, and all of pine, the part's material.
  const section = page.getByRole('region', { name: 'Bodies' });
  await expect(section.getByRole('listitem')).toHaveCount(4);
  for (const [i, name] of BODY_NAMES.entries()) {
    await page.getByRole('button', { name: `Rename Body ${i + 1}` }).click();
    await page.getByLabel(`New name for Body ${i + 1}`).fill(name);
    await page.getByLabel(`New name for Body ${i + 1}`).press('Enter');
    await expect(page.getByTestId(`body-extrude#${i + 1}`)).toContainText(name);
  }
  const measure = page.getByRole('complementary', { name: 'Measure' });
  await measure.getByLabel('Part material').selectOption('pine');
  expect(
    await page.evaluate(() => {
      const part = window.__manufakture!.document.getState().document.parts[0]! as unknown as {
        material?: string;
        bodies: unknown[];
      };
      return { material: part.material, bodies: part.bodies };
    }),
  ).toEqual({
    material: 'pine',
    bodies: BODY_NAMES.map((name, i) => ({ id: `extrude#${i + 1}`, name })),
  });
  // Pine at 400 kg/m3: 432 g a side, 812.16 g a board.
  for (const [i, name] of BODY_NAMES.entries()) {
    const body = measure.getByTestId(`measure-body${i + 1}`);
    await expect(body.getByRole('heading')).toHaveText(name);
    const grams = pineGrams(i < 2 ? v.side : v.board);
    await expect(measure.getByTestId(`measure-value-body${i + 1}.mass`)).toHaveText(
      `${grams.toFixed(2)} g`,
    );
  }
  await docShot('01-shelf-bodies');

  // 3MF: one object per body, named after it, each its exact size and place.
  const threemf = await download(page, '3mf');
  expect(threemf.name).toBe('Wall shelf.3mf');
  const report = validate3mf(threemf.bytes);
  expect(report.problems).toEqual([]);
  expect(report.parsed!.unit).toBe('millimeter');
  expect(report.parsed!.objects.map((o) => o.name)).toEqual([...BODY_NAMES]);
  const { depth: d, height: h, board: t } = SHELF;
  const boxes = [
    [0, 0, 0, d, t, h],
    [0, 600 - t, 0, d, 600, h],
    [0, t, 0, d, 600 - t, t],
    [0, t, h - t, d, 600 - t, h],
  ];
  for (const [i, o] of report.objects.entries()) {
    expect(o.manifold.problems).toEqual([]);
    expect(o.manifold.volume / (i < 2 ? v.side : v.board)).toBeCloseTo(1, 6);
    const box = boxOf(report.parsed!.objects[i]!.mesh.positions);
    expectNear([...box.min, ...box.max], boxes[i]!);
  }
});

const configurations = () => page.getByRole('complementary', { name: 'Configurations' });

test('3. widths as configurations: 600, 800 and 1000 mm, switched and exported', async () => {
  test.setTimeout(180_000);
  await expect(configurations()).toContainText('Variants of this design');
  await page.getByTestId('config-add-parameter').selectOption({ label: '#width' });
  await expect(page.getByTestId('config-param-cp#1')).toContainText('#width');
  for (const [i, width] of SHELF.widths.entries()) {
    await page.getByTestId('config-add-row').click();
    const name = configurations().getByLabel(`Name of configuration Configuration ${i + 1}`);
    await name.fill(`${width} mm`);
    await name.press('Enter');
    const cell = page.getByTestId(`config-cell-cfg#${i + 1}-cp#1`);
    await cell.fill(String(width));
    await cell.press('Enter');
    await expect(cell).toHaveValue(`${width} mm`);
  }
  const switcher = page.getByTestId('configuration-switcher');
  await expect(switcher.locator('option')).toHaveText([
    'None (as modelled)',
    '600 mm',
    '800 mm',
    '1000 mm',
  ]);

  // Each row rebuilds every body at its width: the sides stay, the boards follow.
  for (const width of [800, 1000, 600]) {
    await switcher.selectOption({ label: `${width} mm` });
    await expectShelf(width);
    if (width === 1000) await docShot('02-configuration-1000');
  }

  // Every configuration: one 3MF per row, each of four bodies spanning its width.
  const files: { name: string; path: string }[] = [];
  const listener = (d: Download) => {
    void d.path().then((path) => files.push({ name: d.suggestedFilename(), path }));
  };
  page.on('download', listener);
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await page.getByTestId('export-every-configuration').check();
  await page.getByTestId('export-3mf').click();
  await expect(page.getByTestId('io-status')).toHaveText(
    'Exported 3 of 3 configurations: Wall shelf-600 mm.3mf, Wall shelf-800 mm.3mf, Wall shelf-1000 mm.3mf.',
    { timeout: 90_000 },
  );
  await expect.poll(() => files.length).toBe(3);
  page.off('download', listener);
  for (const width of SHELF.widths) {
    const file = files.find((f) => f.name === `Wall shelf-${width} mm.3mf`)!;
    const report = validate3mf(new Uint8Array(await readFile(file.path)));
    expect(report.problems).toEqual([]);
    expect(report.parsed!.objects.map((o) => o.name)).toEqual([...BODY_NAMES]);
    const total = report.objects.reduce((sum, o) => sum + o.manifold.volume, 0);
    expect(total / shelfVolumes(width).total).toBeCloseTo(1, 6);
    const box = boxOf(report.parsed!.objects.flatMap((o) => [...o.mesh.positions]));
    expectNear([...box.min, ...box.max], [0, 0, 0, SHELF.depth, width, SHELF.height]);
  }
  await expect(page.getByTestId('export-progress')).toBeHidden();

  // Back to the shelf as modelled (600 mm).
  await switcher.selectOption({ label: 'None (as modelled)' });
  await expectShelf(600);
});

test('4. a named version, and a branch made from it', async () => {
  test.setTimeout(180_000);
  await createVersion('Open shelf', 'Four boards, before the supports and the drawer');

  // A branch from "Open shelf", 900 mm wide there.
  await page.getByTestId('open-history').click();
  await history().getByRole('button', { name: 'View version Open shelf' }).click();
  const viewer = page.getByTestId('history-viewer');
  await expect(viewer.getByTestId('history-viewer-label')).toHaveText(
    'Viewing Version "Open shelf"',
  );
  await viewer.getByTestId('history-branch').click();
  await viewer.getByTestId('branch-name').fill('Wide');
  await viewer.getByTestId('branch-create').click();
  await expect(viewer).toBeHidden();
  const branchSelect = page.getByTestId('branch-select');
  await expect(branchSelect.locator('option:checked')).toHaveText('Wide');
  await editVariable(page, 'width', '900');
  await expectShelf(900);
  await saved(page);

  // Main is untouched, still 600 mm, and is where the rest of the work goes.
  await branchSelect.selectOption({ label: 'Main' });
  await expect(page.getByTestId('variable-width-value')).toHaveText('600.00 mm', {
    timeout: 90_000,
  });
  await expectShelf(600);
  await expect(branchSelect.locator('option')).toHaveText(['Main', 'Wide']);
  await history().getByRole('button', { name: 'Close history' }).click();
});

test('4a. the header fits a 1280 px wide window', async () => {
  // With the configuration switcher, the branch switcher and a status message ("Switched to the
  // branch Main.", which stays until the next one) in the header, the view toolbar (standard
  // views, selection filter, section) used to go past the window's right edge: the page
  // scrolled sideways, and so did a drag that left the window. The header now wraps instead.
  await expect(page.getByTestId('io-status')).toHaveText('Switched to the branch Main.');
  const width = await page.evaluate(() => [
    document.documentElement.scrollWidth,
    window.innerWidth,
  ]);
  expect(width[0]).toBeLessThanOrEqual(width[1]!);
});

test('5. the support: the bracket derived at its version "6 mm"', async () => {
  test.setTimeout(120_000);
  await page.getByTestId('part-add').click();
  await expect(page.getByTestId('part-tab-part#2')).toHaveAttribute('aria-selected', 'true');
  await page.getByTestId('part-tab-part#2').dblclick();
  await page.getByTestId('part-rename-input').fill('Support');
  await page.getByTestId('part-rename-input').press('Enter');
  await expect(page.getByTestId('part-tab-part#2')).toHaveText('Support');

  await openTool(page, 'Derived part');
  const dialog = page.getByTestId('feature-dialog');
  await dialog.getByTestId('pin-document').selectOption({ label: 'Bracket' });
  await dialog.getByRole('button', { name: 'Use version 6 mm' }).click();
  await expect(dialog.getByTestId('pin-part')).toHaveValue('part#1');
  await ok(page);
  expect(await partResult('part#2')).toEqual({
    features: [['derived#1', 'ok', 0]],
    bodies: [['derived#1:from/extrude#1', 1]],
  });
  expect(await bodyVolume(page)).toBeCloseTo(bracketVolume(BRACKET_VERSIONS['6 mm']), 3);
  await expect(page.getByTestId('derived-source-derived#1')).toContainText('From Bracket at 6 mm');
  await expect(page.getByTestId('update-available-derived#1')).toBeVisible();
  await docShot('03-support-derived');
});

test('6. the drawer, in a part studio of its own', async () => {
  test.setTimeout(120_000);
  await page.getByTestId('part-add').click();
  await page.getByTestId('part-tab-part#3').dblclick();
  await page.getByTestId('part-rename-input').fill('Drawer');
  await page.getByTestId('part-rename-input').press('Enter');
  await execute(page, drawerSketch('part#3'), 'Draw the drawer');
  await regenerated(page);
  await page.getByTestId('feature-sketch#1').click();
  await openTool(page, 'Extrude');
  await page.getByTestId('field-distance').fill(String(DRAWER.size[2]));
  await ok(page);
  await regenerated(page);
  expect(await partResult('part#3')).toEqual({
    features: [
      ['sketch#1', 'ok', 0],
      ['extrude#1', 'ok', 0],
    ],
    bodies: [['extrude#1', 1]],
  });
  expect(await bodyVolume(page)).toBeCloseTo(drawerVolume, 6);
});

/** Pick a connector in the view, faces only, and wait until the dialog shows it. */
async function pickFace(side: 'a' | 'b', at: Vec3) {
  const dialog = page.getByTestId('mate-dialog');
  await dialog.getByTestId(`mate-pick-${side}`).click();
  await clickWorld(page, at);
  await expect(dialog.getByTestId(`mate-connector-label-${side}`)).toBeVisible();
}

/** Where the Mate dialog's preview shows an instance (rounded), from the viewport. */
function preview(instanceId: string) {
  return page.evaluate((id) => {
    const r = (v: number) => Math.round(v * 1e6) / 1e6 + 0;
    const t = window.__manufakture!.assemblyUi.getState().poses.get(id);
    return t ? { translation: t.translation.map(r), rotation: t.rotation.map(r) } : null;
  }, instanceId);
}

test('7. the assembly: supports fastened, the drawer on a slider', async () => {
  test.setTimeout(240_000);
  await page.getByTestId('assembly-add').click();
  await expect(page.getByTestId('assembly-tab-assembly#1')).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.getByTestId('assembly-insert').click();
  const panel = page.getByTestId('insert-panel');
  for (const id of ['part#1', 'part#2', 'part#2', 'part#3']) {
    await panel.getByTestId(`insert-part-${id}`).click();
    await expect(panel.getByTestId('insert-message')).toContainText('Inserted');
  }
  await panel.getByTestId('insert-close').click();
  await expect(page.getByTestId('instance-inst#1')).toContainText('fixed');
  // Set the supports below the shelf and the drawer above it, so every face can be picked.
  await execute(
    page,
    {
      type: 'setPoses',
      assemblyId: 'assembly#1',
      poses: {
        'inst#2': { translation: [0, 100, -150], rotation: [0, 0, 0, 1] },
        'inst#3': { translation: [0, 400, -150], rotation: [0, 0, 0, 1] },
        'inst#4': { translation: [60, 100, 400], rotation: [0, 0, 0, 1] },
      },
    },
    'Set the parts aside',
  );
  let asm = await solved(page, 'assembly#1');
  // Three free instances: 18 degrees of freedom.
  expect(asm.dof).toBe(18);
  expect(
    await page.evaluate(() => window.__manufakture!.viewport.info().bodies.map((b) => b.id)),
  ).toEqual([
    'assembly#1/inst#1/extrude#1',
    'assembly#1/inst#1/extrude#2',
    'assembly#1/inst#1/extrude#3',
    'assembly#1/inst#1/extrude#4',
    'assembly#1/inst#2/derived#1:from/extrude#1',
    'assembly#1/inst#3/derived#1:from/extrude#1',
    'assembly#1/inst#4/extrude#1',
  ]);

  // Faces only while picking connectors: the boards' edges are close together.
  await page.getByRole('checkbox', { name: 'Edges', exact: true }).uncheck();
  await page.getByRole('checkbox', { name: 'Vertices', exact: true }).uncheck();
  const dialog = page.getByTestId('mate-dialog');

  // Each support: the back of its upright fastened to the back of a side (both in the wall
  // plane), turned half a turn about the wall's normal so the foot is on top, 170 mm down from
  // the side's centroid (so the foot's underside meets the shelf's bottom) and 24 mm across
  // (so it sits under the bottom board, against the side).
  await look(page, 'left');
  const supports = [
    { id: 'inst#2', side: [0, 9, 150], aside: [0, 100, -130], across: 24, face: 'e4' },
    { id: 'inst#3', side: [0, 591, 150], aside: [0, 400, -130], across: -24, face: 'e8' },
  ] as const;
  for (const [n, s] of supports.entries()) {
    await page.getByTestId('assembly-mate').click();
    await dialog.getByTestId('mate-kind').selectOption('fastened');
    await pickFace('a', [...s.side]);
    await expect(dialog.getByTestId('mate-connector-label-a')).toContainText(
      `Shelf 1: centroid of extrude#${n + 1}:side:${s.face}`,
    );
    await pickFace('b', [...s.aside]);
    await expect(dialog.getByTestId('mate-connector-label-b')).toContainText(
      `Support ${n + 1}: centroid of derived#1:from/extrude#1:side:e6`,
    );
    await dialog.getByTestId('mate-offset-x').fill(String(s.across));
    await dialog.getByTestId('mate-offset-y').fill('170');
    await dialog.getByTestId('mate-offset-angle').fill('180');
    await expect
      .poll(() => preview(s.id))
      .toMatchObject({ translation: [0, n === 0 ? 33 : 600 - 33, 0] });
    await dialog.getByTestId('mate-ok').click();
    await expect(dialog).toBeHidden();
  }
  asm = await solved(page, 'assembly#1');
  expect(asm.dof).toBe(6);
  expect(asm.mates.map((m) => [m.mateId, m.status])).toEqual([
    ['mate#1', 'ok'],
    ['mate#2', 'ok'],
  ]);
  expectSupports(asm, 600);
  await view(page, 'iso');
  await docShot('04-supports');

  // The drawer on a slider: its front face on the bottom board's front face, 69 mm up (half
  // the drawer's height plus half a board), free to slide along the face's normal (+X), from
  // flush (0) to 150 mm out.
  await view(page, 'right');
  await page.getByTestId('assembly-mate').click();
  await dialog.getByTestId('mate-kind').selectOption('slider');
  await pickFace('a', [SHELF.depth, 300, SHELF.board / 2]);
  await expect(dialog.getByTestId('mate-connector-label-a')).toContainText(
    'Shelf 1: centroid of extrude#3:side:e10',
  );
  await pickFace('b', [60 + DRAWER.size[0], 100 + DRAWER.size[1] / 2, 400 + DRAWER.size[2] / 2]);
  await expect(dialog.getByTestId('mate-connector-label-b')).toContainText(
    'Drawer 1: centroid of extrude#1:side:e2',
  );
  await dialog.getByTestId('mate-offset-y').fill('69');
  await dialog.getByTestId('mate-limit-min').fill(String(DRAWER.limits[0]));
  await dialog.getByTestId('mate-limit-max').fill(String(DRAWER.limits[1]));
  await expect(dialog.getByTestId('mate-preview')).toContainText('1 degree of freedom');
  await dialog.getByTestId('mate-ok').click();
  await expect(dialog).toBeHidden();
  await page.getByRole('checkbox', { name: 'Edges', exact: true }).check();
  await page.getByRole('checkbox', { name: 'Vertices', exact: true }).check();
  asm = await solved(page, 'assembly#1');
  expect(asm.dof).toBe(1);
  await expect(page.getByTestId('assembly-dof')).toHaveText('1 degree of freedom');
  // Set aside 40 mm in front of the shelf, it slid in square, centred and on the board: x 60
  // (its front at 240, 40 mm out), y 300 - 120, z 18.
  expect(asm.mates[2]).toMatchObject({ mateId: 'mate#3', status: 'ok' });
  expect(asm.mates[2]!.coordinates[0]).toBeCloseTo(40, 6);
  expectDrawer(asm, 40, 600);

  // Dragged out and back in, it only slides, and stops at its limits.
  await view(page, 'iso');
  const top = (out: number): Vec3 => [20 + out + 90, 300, SHELF.board + DRAWER.size[2]];
  let from = await project(page, top(40));
  let to = await project(page, [600, 300, SHELF.board + DRAWER.size[2]]);
  await drag(from, { x: to.x, y: to.y + 40 });
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toHaveAttribute(
    'title',
    'Undo Drag Drawer 1 (Ctrl+Z)',
  );
  asm = await solved(page, 'assembly#1');
  expectDrawer(asm, DRAWER.limits[1], 600);
  from = await project(page, top(DRAWER.limits[1]));
  to = await project(page, [-400, 300, SHELF.board + DRAWER.size[2]]);
  await drag(from, to);
  asm = await solved(page, 'assembly#1');
  expectDrawer(asm, DRAWER.limits[0], 600);
  await docShot('05-assembled');

  // Nothing overlaps: the supports and the drawer only touch the shelf.
  await page.getByTestId('assembly-interference').click();
  const interference = page.getByTestId('interference-panel');
  const status = interference.getByTestId('interference-status');
  await interference.getByTestId('interference-check').click();
  await expect(status).toHaveText('No interference between the 4 instances.');
  await expect(interference.locator('[data-testid^="interference-pair-"]')).toHaveCount(0);

  // The shelf instance in its 800 mm configuration: the right support and the drawer follow
  // (mates stay on named faces), and nothing overlaps still.
  const configuration = page.getByTestId('instance-configuration-inst#1');
  await expect(configuration.locator('option')).toHaveText([
    'Default (as stored)',
    '600 mm',
    '800 mm',
    '1000 mm',
  ]);
  await configuration.selectOption({ label: '800 mm' });
  await expect(page.getByTestId('instance-inst#1')).toContainText('Shelf (800 mm)');
  await expect
    .poll(async () => instance(await solved(page, 'assembly#1'), 'inst#1').source)
    .toEqual({ source: 'part:part#1:row:cfg#2' });
  asm = await solved(page, 'assembly#1');
  expect(asm.dof).toBe(1);
  expect(asm.mates.map((m) => m.status)).toEqual(['ok', 'ok', 'ok']);
  expectSupports(asm, 800);
  expectDrawer(asm, 0, 800);
  await expect(status).toHaveAttribute('data-changed', 'true');
  await interference.getByTestId('interference-check').click();
  await expect(status).toHaveText('No interference between the 4 instances.');
  await view(page, 'iso');
  await docShot('06-configured-800');
  await interference.getByTestId('interference-close').click();
});

test("7a. the last part studio's sketches are not drawn over the assembly", async () => {
  // The Drawer part studio was open before the assembly tab. Its sketch (a 180 x 240 mm
  // rectangle at the origin) used to stay on screen over the assembly, belonging to no
  // instance; an assembly tab draws no part studio's sketches.
  await expect(page.getByTestId('assembly-tab-assembly#1')).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByTestId('committed-sketches')).toHaveCount(0, { timeout: 2_000 });
});

/** Where each support hangs on a shelf `width` wide, checked at three of its points. */
function expectSupports(asm: E2eAssemblyResult, width: number) {
  for (const [id, y] of [
    ['inst#2', 33],
    ['inst#3', width - 33],
  ] as const) {
    const pose = instance(asm, id).transform;
    // The back of the foot's underside, at the wall, under the bottom board.
    expectNear(place(pose, [0, 0, 0]), [0, y, 0]);
    // The tip of the foot, 50 mm out from the wall.
    expectNear(place(pose, [50, 15, 0]), [50, y - 15, 0]);
    // The top of the upright, now its lower end, 40 mm down the wall.
    expectNear(place(pose, [0, -15, 40]), [0, y + 15, -40]);
  }
}

/** The drawer `out` mm in front of the shelf `width` wide: square, centred, on the board. */
function expectDrawer(asm: E2eAssemblyResult, out: number, width: number) {
  const pose = instance(asm, 'inst#4').transform;
  expectNear(pose.translation, [20 + out, width / 2 - DRAWER.size[1] / 2, SHELF.board]);
  expectNear(place(pose, [1, 0, 0]), [21 + out, width / 2 - DRAWER.size[1] / 2, SHELF.board], 6);
  expectNear(place(pose, [0, 1, 1]), [20 + out, width / 2 - DRAWER.size[1] / 2 + 1, 19], 6);
}

/** Drag with the left button from one canvas point to another, in steps. */
async function drag(from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  const steps = 12;
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(
      from.x + ((to.x - from.x) * i) / steps,
      from.y + ((to.y - from.y) * i) / steps,
    );
    await page.waitForTimeout(30);
  }
  await page.mouse.up();
}

test('8. the assembly exported as STEP, 3MF and STL', async () => {
  test.setTimeout(120_000);
  // With the shelf at 800 mm: the shelf, one support part shown twice, and the drawer.
  const w = 800;
  const exact = shelfVolumes(w).total + 2 * bracketVolume(6) + drawerVolume;
  const out = join(test.info().project.outputDir, 'm2-shelf');
  await mkdir(out, { recursive: true });

  // STEP: each part one product (the shelf an assembly of its four bodies, each a named
  // occurrence in it), each instance a named, placed occurrence of it.
  const step = await download(page, 'step');
  expect(step.name).toBe('Assembly 1.step');
  await expect(page.getByTestId('io-status')).toContainText('4 instances of 3 parts.');
  expect(new TextDecoder().decode(step.bytes.subarray(0, 13))).toBe('ISO-10303-21;');
  expect(stepProductNames(step.bytes)).toEqual([
    'Assembly 1',
    'Shelf (800 mm)',
    ...BODY_NAMES,
    'Support',
    'Drawer',
  ]);
  expect(occurrences(step.bytes)).toEqual([
    'Shelf 1',
    ...BODY_NAMES,
    'Support 1',
    'Support 2',
    'Drawer 1',
  ]);

  // 3MF: an object per body per instance (the shelf's four bodies, each support twice, the
  // drawer), each placed by its own build item.
  const threemf = await download(page, '3mf');
  expect(threemf.name).toBe('Assembly 1.3mf');
  const report = validate3mf(threemf.bytes);
  expect(report.problems).toEqual([]);
  expect(report.parsed!.objects.map((o) => o.name)).toEqual([
    ...BODY_NAMES,
    'Support',
    'Support',
    'Drawer',
  ]);
  expect(report.parsed!.items.map((i) => i.objectId)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  // The build: the shelf's four bodies, then each support and the drawer.
  const meshes = buildMeshes(report.parsed!);
  expect(meshes.map((m) => m.name)).toEqual([...BODY_NAMES, 'Support', 'Support', 'Drawer']);
  const built = meshes.map((m) => meshProperties(m.mesh));
  const { depth: d, height: h, board: t } = SHELF;
  const boxes = [
    [0, 0, 0, d, t, h],
    [0, w - t, 0, d, w, h],
    [0, t, 0, d, w - t, t],
    [0, t, h - t, d, w - t, h],
    [0, 18, -40, 50, 48, 0],
    [0, w - 48, -40, 50, w - 18, 0],
    [20, w / 2 - 120, 18, 200, w / 2 + 120, 138],
  ];
  built.forEach((p, i) => expectNear([...p.boundingBox!.min, ...p.boundingBox!.max], boxes[i]!));
  const total = built.reduce((sum, p) => sum + p.volume, 0);
  // The supports' holes and round are facets in a mesh: within 0.2% of their volume.
  expect(Math.abs(total - exact)).toBeLessThan(2e-3 * 2 * bracketVolume(6));

  // STL: everything in place, in one file.
  const stl = await download(page, 'stl');
  expect(stl.name).toBe('Assembly 1.stl');
  const mesh = meshProperties(parseStl(stl.bytes).mesh);
  expect(Math.abs(mesh.volume - exact)).toBeLessThan(2e-3 * 2 * bracketVolume(6));
  expectNear(
    [...mesh.boundingBox!.min, ...mesh.boundingBox!.max],
    [0, 0, -40, SHELF.depth, w, SHELF.height],
  );

  await writeFile(join(out, 'wall-shelf.step'), step.bytes);
  await writeFile(join(out, 'wall-shelf.3mf'), threemf.bytes);
  await writeFile(join(out, 'wall-shelf.stl'), stl.bytes);
  stepBytes = step.bytes;
});

/** The names of a STEP file's NEXT_ASSEMBLY_USAGE_OCCURRENCEs, in order. */
function occurrences(bytes: Uint8Array): string[] {
  const text = new TextDecoder().decode(bytes);
  return [...text.matchAll(/NEXT_ASSEMBLY_USAGE_OCCURRENCE\('[^']*','([^']*)'/g)].map((m) => m[1]!);
}

let stepBytes: Uint8Array | null = null;

test('8a. the bodies of a multi-body part are named occurrences in STEP', async () => {
  // Every occurrence is named: the instances, and the bodies inside a several-body part's
  // product, which used to carry OCCT's label entries ("=>[0:1:1:2]") instead of "Left side".
  expect(stepBytes).not.toBeNull();
  expect(occurrences(stepBytes!)).toEqual([
    'Shelf 1',
    ...BODY_NAMES,
    'Support 1',
    'Support 2',
    'Drawer 1',
  ]);
});

test('9. the support updated to the bracket\'s version "8 mm"', async () => {
  test.setTimeout(120_000);
  await page.getByTestId('part-tab-part#2').click();
  await expect(page.getByTestId('update-available-derived#1')).toBeVisible();
  await page.getByTestId('update-derived#1').click();
  await page
    .getByTestId('update-versions-derived#1')
    .getByRole('button', { name: 'Use version 8 mm' })
    .click();
  await expect(page.getByTestId('derived-source-derived#1')).toContainText('From Bracket at 8 mm');
  await expect(page.getByTestId('update-available-derived#1')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toHaveAttribute(
    'title',
    'Undo Update Derived 1 to "8 mm" (Ctrl+Z)',
  );
  expect(await partResult('part#2')).toEqual({
    features: [['derived#1', 'ok', 0]],
    bodies: [['derived#1:from/extrude#1', 1]],
  });
  await expect
    .poll(() => bodyVolume(page), { timeout: 30_000 })
    .toBeCloseTo(bracketVolume(BRACKET_VERSIONS['8 mm']), 3);

  // In the assembly, both supports show the 8 mm bracket where they were: the faces their mates
  // are on (the upright's back) did not move, and the thicker walls overlap nothing.
  await page.getByTestId('assembly-tab-assembly#1').click();
  const asm = await solved(page, 'assembly#1');
  expect(asm.dof).toBe(1);
  expect(asm.mates.map((m) => m.status)).toEqual(['ok', 'ok', 'ok']);
  expectSupports(asm, 800);
  expectDrawer(asm, 0, 800);
  await page.getByTestId('assembly-interference').click();
  const interference = page.getByTestId('interference-panel');
  await interference.getByTestId('interference-check').click();
  await expect(interference.getByTestId('interference-status')).toHaveText(
    'No interference between the 4 instances.',
  );
  await interference.getByTestId('interference-close').click();
  await view(page, 'iso');
  await docShot('07-supports-8mm');
});

test('10. reloaded, then the version "Open shelf" restored and the restore undone', async () => {
  test.setTimeout(240_000);
  await saved(page);
  const before = await page.evaluate(() => window.__manufakture!.document.getState().document);
  await page.reload();
  await expect(page.getByTestId('document-name')).toHaveText('Wall shelf', { timeout: 90_000 });
  await expect(page.getByTestId('assembly-tab-assembly#1')).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await regenerated(page);
  expect(await page.evaluate(() => window.__manufakture!.document.getState().document)).toEqual(
    before,
  );
  let asm = await solved(page, 'assembly#1');
  expect(asm.dof).toBe(1);
  expect(asm.mates.map((m) => m.status)).toEqual(['ok', 'ok', 'ok']);
  expect(instance(asm, 'inst#1').source).toEqual({ source: 'part:part#1:row:cfg#2' });
  expectSupports(asm, 800);
  expectDrawer(asm, 0, 800);
  await expect(page.getByTestId('branch-select').locator('option:checked')).toHaveText('Main');

  // Restore "Open shelf": the document as it was then, one part studio and no assembly, as one
  // step.
  await page.getByTestId('open-history').click();
  await expect(history().getByTestId('version-Open shelf')).toContainText(
    'Four boards, before the supports and the drawer',
  );
  await history().getByRole('button', { name: 'View version Open shelf' }).click();
  const viewer = page.getByTestId('history-viewer');
  await expect(viewer.getByTestId('history-viewer-label')).toHaveText(
    'Viewing Version "Open shelf"',
  );
  await docShot('08-viewing-open-shelf');
  await viewer.getByTestId('history-restore').click();
  await expect(viewer).toBeHidden();
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toHaveAttribute(
    'title',
    'Undo Restore Version "Open shelf" (Ctrl+Z)',
  );
  const restored = await page.evaluate(() => {
    const d = window.__manufakture!.document.getState().document;
    return { parts: d.parts.map((p) => p.name), assemblies: d.assemblies.length };
  });
  expect(restored).toEqual({ parts: ['Shelf'], assemblies: 0 });
  await expect(page.getByTestId('part-tab-part#1')).toHaveAttribute('aria-selected', 'true');
  await expectShelf(600);

  // Undo the restore: everything is back, assembled as it was.
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.__manufakture!.document.getState().document))
    .toEqual(before);
  await page.getByTestId('assembly-tab-assembly#1').click();
  asm = await solved(page, 'assembly#1');
  expect(asm.dof).toBe(1);
  expectSupports(asm, 800);
  expectDrawer(asm, 0, 800);
  await saved(page);
  expect(errors).toEqual([]);
});
