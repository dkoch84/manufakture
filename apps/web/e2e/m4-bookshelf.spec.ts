import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import DxfParser from 'dxf-parser';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import { addVariable, ok, openEmpty, openTool, regenerated } from './bracket';
import { settle } from './helpers';
import { execute, look, saved, solved } from './m2-fixtures';
import {
  ASSEMBLY,
  BOARDS,
  HAND_SHEETS,
  INCH,
  INCH_UNITS,
  JOINTS,
  JOINT_NAMES,
  PANEL_DEPTH,
  SHELF,
  STICK_SETTINGS,
  assemblyCommands,
  carcassSketches,
  checkedLayout,
  drawnSheets,
  fraction,
  frameSketch,
  handCutList,
  handSheetInput,
  handVolumes,
  inch,
  instanceOf,
  kerfProblems,
  layoutParts,
  panelLength,
  railBlank,
  railLength,
  sortParts,
  type BoardSpec,
  type DrawnPart,
} from './m4-fixtures';

// M4 acceptance: a bookshelf, end to end (docs/m4-acceptance.md). The chapters share one browser
// page and its storage, so they run in order and a failing chapter skips the ones after it. Every
// M4 feature goes through its UI: the Board dialog and its stock picker, the Joint dialog, the
// Configurations panel and the header's switcher, the Cut list panel (list, layouts, CSV, PDF),
// the Explode panel, the drawing workspace (views, projected views, dimensions picked in the
// views, an exploded view, SVG, DXF and PDF) and the Stock panel. The sketches are made with
// commands, as M3's walkthrough does (the sketcher is M1's and its own specs cover it), and so
// are the per-board assembly's instances (M2's Insert panel and its own specs). Boards are named
// in the feature tree (F2); the cut list lists them by those names.
//
//  1. An inch document with #width; the face frame's four 1x2 sticks through the Board dialog.
//  2. The carcass: two sides, a bottom, a top and three shelves of 3/4" plywood and a back of
//     1/4" plywood, through the Board dialog; the bodies named.
//  3. Sixteen joints through the Joint dialog: rabbets for the top, the bottom and the back,
//     dados for the shelves, pocket screws for the rails. Every board's volume by hand.
//  4. The cut list and the sheet layouts as modelled (30" wide) against the hand calculation;
//     the layouts checked by the nesting package's checker and part by part for kerf gaps.
//  5. The configuration table, 24", 30" and 36", and the cut list and layouts of each row.
//  6. The assembly of per-board instances: its cut list is the part studio's, exactly; then
//     exploded in five steps.
//  7. A drawing: front, top and right views with overall dimensions in fractions, and the
//     exploded view inserted as an isometric view.
//  8. Exports: the drawing as SVG, DXF and PDF and the cut list as CSV and PDF, each read back.
//  9. A reload brings it all back.
// 10. The plywood measured at 11/16": the dados, the cut list and the dimensions follow.
//
// With M4_DOCS=1 the run also refreshes the screenshots in docs/m4-acceptance/.

test.describe.configure({ mode: 'serial' });

let page: Page;
let errors: string[];

const docsDir = (info: TestInfo) => resolve(info.project.testDir, '../../../docs/m4-acceptance');

async function docShot(name: string): Promise<void> {
  if (!process.env.M4_DOCS) return;
  await page.mouse.move(0, 0);
  await settle(page);
  const dir = docsDir(test.info());
  await mkdir(dir, { recursive: true });
  await page.screenshot({ path: join(dir, `${name}.png`) });
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

// --- Helpers -------------------------------------------------------------------------------------

/**
 * Every feature ok, without errors or warnings; but the face frame's sketch is four open lines
 * for sticks, and says so.
 */
async function allOk(): Promise<void> {
  const statuses = await regenerated(page);
  for (const [id, s] of Object.entries(statuses)) {
    const warnings = id === 'sketch#1' ? s.warnings.filter((w) => !OPEN_LINE.test(w)) : s.warnings;
    expect({ ...s, warnings }, id).toMatchObject({ status: 'ok', errors: [], warnings: [] });
  }
}

const OPEN_LINE = /^('e[1-4]'(, )?)+ (does|do) not close a loop$/;

/** Every shown body's exact volume, by board id, once `count` bodies are measured. */
async function volumes(count: number): Promise<Record<string, number | null>> {
  await regenerated(page);
  await page.evaluate(() => window.__manufakture!.selection.getState().clear());
  await page.waitForFunction(
    (n) => {
      const m = window.__manufakture!.measure.getState();
      const shown = window.__manufakture!.model.getState().parts[0]!.bodies.length;
      if (shown !== n) return false;
      if (m.status !== 'ready' || m.request?.targets.length !== 0) return false;
      return n === 1 ? !!m.result?.body : m.bodies.length === n;
    },
    count,
    { timeout: 90_000 },
  );
  return page.evaluate((n) => {
    const m = window.__manufakture!.measure.getState();
    if (n === 1) {
      const id = window.__manufakture!.model.getState().parts[0]!.bodies[0]!.bodyId;
      return { [id.slice(id.indexOf('/') + 1)]: m.result!.body!.volume };
    }
    return Object.fromEntries(
      m.bodies.map((b) => [b.bodyId.slice(b.bodyId.indexOf('/') + 1), b.body?.volume ?? null]),
    );
  }, count);
}

function expectVolumes(actual: Record<string, number | null>, expected: Record<string, number>) {
  for (const [id, v] of Object.entries(expected)) {
    expect(actual[id]! / v, id).toBeCloseTo(1, 6);
  }
}

interface BoardMetadataE2e {
  frame: {
    origin: number[];
    axes: { length: number[]; width: number[]; thickness: number[] };
    size: { length: number; width: number; thickness: number };
  };
}

/** Regen's board frames (the translator's metadata), by feature id. */
function frames(): Promise<Record<string, BoardMetadataE2e['frame']>> {
  return page.evaluate(() =>
    Object.fromEntries(
      window
        .__manufakture!.model.getState()
        .parts[0]!.features.map((f) => [
          f.featureId,
          (f as unknown as { metadata?: { frame?: unknown } }).metadata?.frame,
        ])
        .filter(([, frame]) => frame !== undefined),
    ),
  );
}

/** The corner of a board's blank nearest -infinity, and the far one, in inches. */
function extent(f: BoardMetadataE2e['frame']): { min: number[]; max: number[] } {
  const corners: number[][] = [];
  for (const a of [0, 1])
    for (const b of [0, 1])
      for (const c of [0, 1]) {
        corners.push(
          [0, 1, 2].map(
            (i) =>
              f.origin[i]! +
              a * f.size.length * f.axes.length[i]! +
              b * f.size.width * f.axes.width[i]! +
              c * f.size.thickness * f.axes.thickness[i]!,
          ),
        );
      }
  const round = (v: number) => Math.round((v / INCH) * 1e6) / 1e6 + 0;
  return {
    min: [0, 1, 2].map((i) => round(Math.min(...corners.map((p) => p[i]!)))),
    max: [0, 1, 2].map((i) => round(Math.max(...corners.map((p) => p[i]!)))),
  };
}

/** Where each board lies at width `w` (plywood `t`), inches: its blank's box. */
function handExtents(
  w: number,
  t: number = SHELF.ply,
): Record<string, { min: number[]; max: number[] }> {
  const { height: H, depth: D, back: b, stick } = SHELF;
  const x0 = SHELF.ply - SHELF.dado;
  const x1 = x0 + panelLength(w);
  const s = stick.width;
  const f = -stick.thickness;
  const r = (v: number) => Math.round(v * 1e6) / 1e6 + 0;
  const box = (min: number[], max: number[]) => ({ min: min.map(r), max: max.map(r) });
  return {
    'extension#1': box([0, f, 0], [s, 0, H]),
    'extension#2': box([w - s, f, 0], [w, 0, H]),
    'extension#3': box([s, f, 0], [w - s, 0, s]),
    'extension#4': box([s, f, H - s], [w - s, 0, H]),
    'extension#5': box([0, 0, 0], [t, D, H]),
    'extension#6': box([w - t, 0, 0], [w, D, H]),
    'extension#7': box([x0, 0, 0], [x1, PANEL_DEPTH, t]),
    'extension#8': box([x0, 0, H - t], [x1, PANEL_DEPTH, H]),
    ...Object.fromEntries(
      SHELF.shelves.map((z, i) => [
        `extension#${9 + i}`,
        box([x0, 0, z], [x1, PANEL_DEPTH, z + t]),
      ]),
    ),
    'extension#12': box([x0, D - b, 0], [x1, D, H]),
  };
}

async function expectPlaced(w: number, t: number = SHELF.ply, only?: readonly string[]) {
  const got = await frames();
  const hand = handExtents(w, t);
  for (const id of only ?? Object.keys(hand)) {
    expect(extent(got[id]!), id).toEqual(hand[id]);
  }
}

/** Select a sketch in the tree and open the Board dialog on it. */
async function boardDialog(spec: BoardSpec): Promise<Locator> {
  await page.getByTestId(`feature-${spec.sketch}`).click();
  await openTool(page, 'Board');
  const dialog = page.getByTestId('feature-dialog');
  await expect(dialog.getByTestId('field-sketch')).toHaveValue(spec.sketch);
  return dialog;
}

/** Rename a feature in the tree: select its row, F2, type, Enter. */
async function renameInTree(id: string, name: string): Promise<void> {
  const row = page.getByTestId(`feature-${id}`);
  await row.click();
  await row.press('F2');
  const input = row.locator('input.rename');
  await input.fill(name);
  await input.press('Enter');
  await expect(row.locator('.name')).toHaveText(name);
}

const cutListPanel = () => page.getByRole('complementary', { name: 'Cut list' });

async function openCutList(): Promise<Locator> {
  if ((await cutListPanel().count()) === 0) await page.getByTestId('open-cutlist').click();
  await expect(cutListPanel()).toBeVisible();
  return cutListPanel();
}

/** The cut list's rows as shown: item, size, quantity, total. */
async function rows(): Promise<{ item: string; size: string; quantity: number; total: string }[]> {
  const panel = cutListPanel();
  await panel.getByTestId('cutlist-tab-list').click();
  const out = [];
  for (const r of await panel.getByTestId('cutlist-row').all()) {
    out.push({
      item: (await r.getByTestId('cutlist-item').textContent())!,
      size: (await r.getByTestId('cutlist-size').textContent())!,
      quantity: Number(await r.getByTestId('cutlist-qty').textContent()),
      total: (await r.getByTestId('cutlist-total').textContent())!,
    });
  }
  return out;
}

/** The cut list at width `w` against the hand calculation. */
async function expectCutList(w: number, t: number = SHELF.ply): Promise<void> {
  const hand = handCutList(w, t);
  await expect.poll(rows, { timeout: 60_000 }).toEqual(hand.rows);
  const panel = cutListPanel();
  await expect(panel.getByTestId('cutlist-hardware')).toHaveText(
    `${hand.screws} x Pocket screw ${fraction(hand.screw)}`,
  );
  const totals = panel.getByTestId('cutlist-totals').locator('li');
  await expect(totals).toHaveText([
    `Sheet goods: ${(hand.plywood34 + hand.plywood14).toFixed(2)} sq ft, 8 pcs`,
    `Lumber: ${hand.boardFeet.toFixed(2)} bd ft, ${fraction(2 * SHELF.height + 2 * railLength(w))}, 4 pcs`,
    'Hardware: 4 pcs',
    `${hand.boardFeet.toFixed(2)} bd ft in all`,
  ]);
}

/**
 * Drawn or packed parts rounded to 1e-6 mm, for comparing layouts. Every exact position is a
 * whole number of 1/32" (0.79375 mm), so no rounding boundary is near one.
 */
const round = (parts: DrawnPart[]) =>
  sortParts(parts).map((p) =>
    [p.x, p.y, p.sizeX, p.sizeY].map((v) => Math.round(v * 1e6) / 1e6 + 0),
  );

/**
 * The layouts at width `w`: as many sheets as the hand calculation needs, placed exactly as the
 * nesting package lays out the hand-computed parts (which its checker accepts); every drawn part
 * inside its sheet, along the grain and a kerf from every other; and every lumber plan's sticks
 * long enough for their pieces and kerfs. Waits for the layouts of this width: the panel may
 * still show the last ones for a moment after a switch.
 */
async function expectLayouts(w: number): Promise<void> {
  const panel = cutListPanel();
  await panel.getByTestId('cutlist-tab-layouts').click();
  const hand = HAND_SHEETS[w]!;
  const plural = (n: number) => `${n} ${n === 1 ? 'sheet' : 'sheets'}`;
  const kerf = inch(SHELF.kerf);
  for (const [stock, size, n] of [
    ['us-ply-23-32', '3/4', hand.ply34],
    ['us-ply-7-32', '1/4', hand.ply14],
  ] as const) {
    // The packer and its checker on the hand-computed parts.
    const input = handSheetInput(w, size);
    const { result, problems } = checkedLayout(input);
    expect(problems, `${stock} at ${w}"`).toEqual([]);
    expect(result.unplaced).toEqual([]);
    expect(result.totals.sheets).toBe(n);
    // The app's layout is that one, sheet by sheet.
    await expect
      .poll(async () => (await drawnSheets(page, stock)).map((sheet) => round(sheet.parts)), {
        timeout: 60_000,
      })
      .toEqual(layoutParts(result).map(round));
    await expect(panel.getByTestId(`cutlist-sheets-${stock}`).locator('h3')).toHaveText(
      `${size}" plywood: ${plural(n)}`,
    );
    const drawn = await drawnSheets(page, stock);
    drawn.forEach((sheet, i) => {
      expect([sheet.length, sheet.width]).toEqual(
        [inch(96), inch(48)].map((v) => expect.closeTo(v, 6)),
      );
      expect(kerfProblems(sheet, kerf), `${stock} sheet ${i + 1}`).toEqual([]);
      // Grain-locked: every part's length lies along the sheet's.
      for (const p of sheet.parts) {
        const part = input.parts.find(
          (q) => Math.abs(q.length - p.sizeX) < 1e-6 && Math.abs(q.width - p.sizeY) < 1e-6,
        );
        expect(part, `${stock} part ${p.sizeX} x ${p.sizeY}`).toBeDefined();
      }
    });
    const parts = input.parts.reduce((a, p) => a + p.quantity, 0);
    expect(drawn.reduce((a, s) => a + s.parts.length, 0)).toBe(parts);
  }
  // The 1x2 plan: every piece once, and each stick holds its pieces with a kerf between them.
  const captions = () =>
    panel
      .getByTestId('cutlist-sticks-us-1x2')
      .getByTestId('cutlist-stick')
      .locator('figcaption')
      .allTextContents();
  const cutsOf = (caption: string) => {
    const m = /^(.+?): (.+); waste/.exec(caption)!;
    return { length: parseInches(m[1]!), cuts: m[2]!.split(', ').map(parseInches) };
  };
  await expect
    .poll(async () => (await captions()).flatMap((c) => cutsOf(c).cuts).sort((a, b) => a - b))
    .toEqual([railLength(w), railLength(w), SHELF.height, SHELF.height].sort((a, b) => a - b));
  for (const caption of await captions()) {
    const { length, cuts } = cutsOf(caption);
    expect(cuts.reduce((a, c) => a + c, 0) + SHELF.kerf * (cuts.length - 1)).toBeLessThanOrEqual(
      length,
    );
  }
}

/** `27"`, `29-1/16"`, `7/32"` in inches. */
function parseInches(text: string): number {
  const m = /^(?:(\d+)(?:-(\d+)\/(\d+))?|(\d+)\/(\d+))"$/.exec(text.trim());
  if (!m) throw new Error(`not an inch length: ${text}`);
  if (m[4]) return Number(m[4]) / Number(m[5]);
  return Number(m[1]) + (m[2] ? Number(m[2]) / Number(m[3]) : 0);
}

async function downloaded(click: () => Promise<void>): Promise<{ name: string; bytes: Buffer }> {
  const [download] = await Promise.all([page.waitForEvent('download'), click()]);
  return { name: download.suggestedFilename(), bytes: await readFile((await download.path())!) };
}

const switcher = () => page.getByTestId('configuration-switcher');

// --- Drawing helpers -------------------------------------------------------------------------

interface E2eDrawingView {
  id: string;
  direction: string;
  scale: unknown;
  position: [number, number];
  source: Record<string, unknown>;
}

interface E2eDrawing {
  id: string;
  name: string;
  sheets: { id: string; views: E2eDrawingView[]; dimensions: { id: string; kind: string }[] }[];
}

const D = 'drawing#1';
/** The orthographic views' scale. */
const SCALE = 12;

function drawing(): Promise<E2eDrawing | undefined> {
  return page.evaluate(
    () =>
      (
        window.__manufakture!.document.getState().document as unknown as {
          drawings?: E2eDrawing[];
        }
      ).drawings?.[0],
  );
}

async function sheetReady(): Promise<void> {
  await regenerated(page);
  await expect(page.getByTestId('drawing-sheet')).toHaveAttribute('data-state', 'ready', {
    timeout: 90_000,
  });
}

async function clickPaper(p: [number, number]): Promise<void> {
  const { x, y } = await toPage(p);
  await page.mouse.click(x, y);
}

/** Page coordinates of a paper point (mm from the sheet's bottom left). */
async function toPage(p: [number, number]): Promise<{ x: number; y: number }> {
  const sheet = page.getByTestId('drawing-sheet');
  const box = (await sheet.boundingBox())!;
  const w = Number(await sheet.getAttribute('data-width'));
  const h = Number(await sheet.getAttribute('data-height'));
  return { x: box.x + (p[0] / w) * box.width, y: box.y + ((h - p[1]) / h) * box.height };
}

/**
 * Drag a view with the Select tool so the middle of what it draws lands on paper point `to`:
 * grabbed at its middle, where no other view's middle is nearer.
 */
async function dragViewTo(id: string, to: [number, number]): Promise<void> {
  const boxes = await page
    .getByTestId('drawing-sheet')
    .locator(`path[data-owner="${id}"]`)
    .evaluateAll((els) =>
      els.map((e) => {
        const r = e.getBoundingClientRect();
        return [r.left, r.top, r.right, r.bottom];
      }),
    );
  const from = {
    x: (Math.min(...boxes.map((b) => b[0]!)) + Math.max(...boxes.map((b) => b[2]!))) / 2,
    y: (Math.min(...boxes.map((b) => b[1]!)) + Math.max(...boxes.map((b) => b[3]!))) / 2,
  };
  const target = await toPage(to);
  const before = (await drawing())!.sheets[0]!.views.find((v) => v.id === id)!.position;
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + target.x) / 2, (from.y + target.y) / 2, { steps: 4 });
  await page.mouse.move(target.x, target.y, { steps: 4 });
  await page.mouse.up();
  await expect
    .poll(async () => (await drawing())!.sheets[0]!.views.find((v) => v.id === id)!.position)
    .not.toEqual(before);
  await sheetReady();
}

/** A model point of a 1:12 view on paper: inches along the view's x and y. */
const on = (view: E2eDrawingView, v: [number, number]): [number, number] => [
  view.position[0] + inch(v[0]) / SCALE,
  view.position[1] + inch(v[1]) / SCALE,
];

async function dimension(
  kind: string,
  picks: [number, number][],
  place: [number, number],
): Promise<void> {
  await page.getByTestId('drawing-dimension-kind').selectOption(kind);
  const before = (await drawing())!.sheets[0]!.dimensions.length;
  for (const [i, p] of picks.entries()) {
    await clickPaper(p);
    await expect(page.getByTestId(`drawing-pick-${i}`)).toBeVisible();
  }
  await clickPaper(place);
  await expect.poll(async () => (await drawing())!.sheets[0]!.dimensions.length).toBe(before + 1);
}

const DIMENSIONS = ['dim#1', 'dim#2', 'dim#3', 'dim#4'];

async function dimensionValues(): Promise<string[]> {
  await sheetReady();
  const list = page.getByTestId('drawing-dimensions');
  const out: string[] = [];
  for (const id of DIMENSIONS) {
    await expect(list.getByTestId(`drawing-dimension-status-${id}`)).toHaveText('OK');
    out.push((await list.getByTestId(`drawing-dimension-value-${id}`).textContent())!.trim());
  }
  return out;
}

// --- State the chapters hand on ----------------------------------------------------------------

let partStudioRows: Awaited<ReturnType<typeof rows>> = [];
let modelledCsv = '';
let beforeReload: unknown = null;
let dimensionsBefore: string[] = [];

// --- Chapters ----------------------------------------------------------------------------------

test('1. an inch document, #width, and the face frame of 1x2 sticks', async () => {
  test.setTimeout(240_000);
  errors = await openEmpty(page);
  await execute(
    page,
    {
      type: 'batch',
      commands: [
        INCH_UNITS,
        { type: 'renameDocument', name: SHELF.name },
        { type: 'renamePart', partId: 'part#1', name: 'Carcass' },
      ],
    },
    'Set up the document',
  );
  await addVariable(page, 'width', `${SHELF.modelled}`);
  await expect(page.getByTestId('variable-width-value')).toHaveText('30"');
  await execute(
    page,
    { type: 'addFeature', partId: 'part#1', feature: frameSketch() },
    'Face frame sketch',
  );
  await regenerated(page);

  for (const spec of BOARDS.slice(0, 4)) {
    const dialog = await boardDialog(spec);
    // A sketch of several lines opens as a panel: a stick is chosen.
    await dialog.getByTestId('field-form').selectOption('stick');
    await expect(dialog.getByTestId('stock-region-us')).toHaveAttribute('aria-pressed', 'true');
    await dialog.getByTestId('field-stock').selectOption('us-1x2');
    await dialog.getByTestId('field-line').selectOption(spec.line!);
    await dialog.getByTestId('field-rotation').fill(STICK_SETTINGS.rotation);
    await dialog.getByTestId('field-justifyThickness').selectOption('positive');
    await dialog.getByTestId('field-justifyWidth').selectOption('positive');
    const length = spec.line === 'e1' || spec.line === 'e2' ? 72 : railLength(SHELF.modelled);
    await expect(dialog.getByTestId('board-preview')).toContainText(
      `Blank: ${fraction(length)} x 1-1/2" x 3/4"`,
    );
    await ok(page);
    await renameInTree(spec.id, spec.name);
  }
  await allOk();
  await expectPlaced(
    SHELF.modelled,
    SHELF.ply,
    BOARDS.slice(0, 4).map((b) => b.id),
  );
  expectVolumes(await volumes(4), {
    'extension#1': handVolumes(SHELF.modelled)['extension#1']!,
    'extension#2': handVolumes(SHELF.modelled)['extension#2']!,
    'extension#3': railBlank(SHELF.modelled),
    'extension#4': railBlank(SHELF.modelled),
  });
  await look(page, 'iso');
  await docShot('01-face-frame');
});

test('2. the carcass: sides, bottom, top, shelves and back from plywood', async () => {
  test.setTimeout(300_000);
  await execute(page, { type: 'batch', commands: carcassSketches() }, 'Carcass sketches');
  await regenerated(page);
  for (const spec of BOARDS.slice(4)) {
    const dialog = await boardDialog(spec);
    await expect(dialog.getByTestId('field-form')).toHaveValue('panel');
    // An inch document's panels default to 3/4" plywood; the back is 1/4".
    await expect(dialog.getByTestId('field-stock')).toHaveValue('us-ply-23-32');
    if (spec.stock !== 'us-ply-23-32') {
      await dialog.getByTestId('field-stock').selectOption(spec.stock);
    }
    if (spec.flip) await dialog.getByLabel('Opposite side of the sketch').check();
    await expect(dialog.getByTestId('board-preview')).toContainText('Blank: ');
    await ok(page);
    await renameInTree(spec.id, spec.name);
  }
  await allOk();
  await expectPlaced(SHELF.modelled);
  // Before the joints every board is its whole blank.
  const blanks = await frames();
  const v = await volumes(12);
  for (const b of BOARDS) {
    const s = blanks[b.id]!.size;
    expect(v[b.id]! / (s.length * s.width * s.thickness), b.id).toBeCloseTo(1, 6);
  }
  // Each board's material comes from its stock.
  expect(
    await page.evaluate(() =>
      window
        .__manufakture!.document.getState()
        .document.parts[0]!.bodies.map((b) => [b.id, b.material]),
    ),
  ).toEqual(BOARDS.map((b) => [b.id, b.stock === 'us-1x2' ? 'pine' : 'plywood']));
  await look(page, 'iso');
  await docShot('02-carcass');
});

test('3. sixteen joints: rabbets, dados and pocket screws', async () => {
  test.setTimeout(600_000);
  for (const j of JOINTS) {
    await openTool(page, 'Joint');
    const dialog = page.getByTestId('feature-dialog');
    await dialog.getByTestId('field-kind').selectOption(j.kind);
    await dialog.getByTestId('field-a').selectOption(j.a);
    await dialog.getByTestId('field-b').selectOption(j.b);
    const a = BOARDS.find((b) => b.id === j.a)!.name;
    const b = BOARDS.find((x) => x.id === j.b)!.name;
    if (j.kind === 'pocket-screw') {
      await expect(dialog.getByTestId('field-face')).toHaveValue('low');
      await expect(dialog.getByTestId('joint-hardware')).toContainText('1 pocket screw');
    } else {
      await expect(dialog.getByTestId('joint-cuts-a')).toHaveText(`Cut from ${a} (A): a groove.`);
      await expect(dialog.getByTestId('joint-cuts-b')).toHaveText(`Cut from ${b} (B): nothing.`);
    }
    if (j.id === 'extension#17') {
      await expect(dialog.getByTestId('joint-sizes')).toHaveText(
        'Groove 23/32" wide and 1/4" deep, 11-1/4" long.',
      );
      await docShot('03-dado-dialog');
    }
    await ok(page);
  }
  await allOk();
  const names = await page.evaluate(() =>
    window
      .__manufakture!.document.getState()
      .document.parts[0]!.features.filter((f) => f.kind === 'extension')
      .map((f) => f.name),
  );
  expect(names.slice(12)).toEqual(
    JOINTS.map((j) => `${JOINT_NAMES[j.kind]} ${j.id.slice('extension#'.length)}`),
  );
  const v = await volumes(12);
  expectVolumes(v, handVolumes(SHELF.modelled));
  // A rail loses its two pockets and nothing else.
  for (const id of ['extension#3', 'extension#4']) {
    expect(v[id]!).toBeLessThan(railBlank(SHELF.modelled));
    expect(v[id]!).toBeGreaterThan(railBlank(SHELF.modelled) * 0.99);
  }
  await look(page, 'iso');
  await docShot('04-joined');
});

test('4. the cut list and the sheet layouts as modelled, against the hand calculation', async () => {
  test.setTimeout(240_000);
  const panel = await openCutList();
  await expectCutList(SHELF.modelled);
  partStudioRows = await rows();
  await docShot('05-cut-list');
  await expectLayouts(SHELF.modelled);
  await docShot('06-sheet-layouts');

  // The CSV is the table, exactly.
  const csv = await downloaded(() => panel.getByTestId('cutlist-csv').click());
  expect(csv.name).toBe('Bookshelf cut list.csv');
  modelledCsv = csv.bytes.toString('utf8');
  // Inches in a CSV field: quoted, the inch mark doubled.
  const L = fraction(panelLength(SHELF.modelled)).replace('"', '""');
  const rail = fraction(railLength(SHELF.modelled)).replace('"', '""');
  expect(modelledCsv).toBe(
    [
      '#,Item,Stock,Material,Length,Width,Thickness,Quantity,Total,Flags,Bodies',
      `1,Back,"1/4"" plywood",Plywood (birch),"72""","${L}","7/32""",1,14.53 sq ft,,extension#12`,
      '2,"Left side, Right side","3/4"" plywood",Plywood (birch),"72""","11-1/4""","23/32""",2,11.25 sq ft,,extension#5 extension#6',
      `3,"Bottom, Top, Shelf 1, Shelf 2, Shelf 3","3/4"" plywood",Plywood (birch),"${L}","11-1/32""","23/32""",5,11.13 sq ft,,extension#7 extension#8 extension#9 extension#10 extension#11`,
      '4,"Left stile, Right stile",1x2,Pine (eastern white),"72""","1-1/2""","3/4""",2,2.00 bd ft,,extension#1 extension#2',
      `5,"Bottom rail, Top rail",1x2,Pine (eastern white),"${rail}","1-1/2""","3/4""",2,0.75 bd ft,,extension#3 extension#4`,
      '',
    ].join('\r\n'),
  );
});

test('5. widths as configurations: 24", 30" and 36", each cut and laid out', async () => {
  test.setTimeout(360_000);
  const configurations = page.getByRole('complementary', { name: 'Configurations' });
  await configurations.getByTestId('config-add-parameter').selectOption({ label: '#width' });
  await expect(page.getByTestId('config-param-cp#1')).toContainText('#width');
  for (const [i, w] of SHELF.widths.entries()) {
    await page.getByTestId('config-add-row').click();
    const name = configurations.getByLabel(`Name of configuration Configuration ${i + 1}`);
    await name.fill(`${w} in`);
    await name.press('Enter');
    const cell = page.getByTestId(`config-cell-cfg#${i + 1}-cp#1`);
    await cell.fill(String(w));
    await cell.press('Enter');
    await expect(cell).toHaveValue(`${w} in`);
  }
  await expect(switcher().locator('option')).toHaveText([
    'None (as modelled)',
    '24 in',
    '30 in',
    '36 in',
  ]);
  for (const w of [24, 36, 30]) {
    await switcher().selectOption({ label: `${w} in` });
    await allOk();
    await expectPlaced(w);
    await openCutList();
    await expect(cutListPanel().getByTestId('cutlist-configuration')).toHaveText(
      `For the configuration ${w} in.`,
    );
    await expectCutList(w);
    await expectLayouts(w);
    if (w === 36) await docShot('07-layouts-36');
  }
  await switcher().selectOption({ label: 'None (as modelled)' });
  await allOk();
  await expectCutList(SHELF.modelled);
});

test('6. the assembly of per-board instances: the same cut list; exploded in five steps', async () => {
  test.setTimeout(300_000);
  await execute(page, { type: 'batch', commands: assemblyCommands() }, 'Assemble per board');
  await page.getByTestId(`assembly-tab-${ASSEMBLY}`).click();
  const asm = await solved(page, ASSEMBLY);
  expect(asm.instances.map((x) => x.bodies)).toEqual(BOARDS.map((b) => [b.id]));

  // Counted through the instances, each showing one board: exactly the part studio's list.
  await openCutList();
  await expect.poll(rows, { timeout: 60_000 }).toEqual(partStudioRows);
  await expect(cutListPanel().getByTestId('cutlist-hardware')).toHaveText(
    '4 x Pocket screw 1-1/4"',
  );
  const csv = await downloaded(() => cutListPanel().getByTestId('cutlist-csv').click());
  // The same rows, each body counted once, through its instance.
  const strip = (text: string) =>
    text
      .split('\r\n')
      .map((l) => l.replace(/,[^,]*$/, ''))
      .join('\n');
  expect(strip(csv.bytes.toString('utf8'))).toBe(strip(modelledCsv));
  await cutListPanel().getByTestId('cutlist-close').click();

  // Explode: the top up, the back out behind, the face frame forward, the sides apart.
  await page.getByTestId('assembly-explode').click();
  const panel = page.getByTestId('explode-panel');
  await panel.getByTestId('explode-new').click();
  const step = async (names: string[], axis: string, distance: string) => {
    const wanted = new Set(names.map(instanceOf));
    for (const box of await panel.locator('[data-testid^="explode-instance-"]').all()) {
      const id = (await box.getAttribute('data-testid'))!.slice('explode-instance-'.length);
      await box.setChecked(wanted.has(id));
    }
    await panel.getByTestId('explode-axis').selectOption(axis);
    await panel.getByTestId('explode-distance').fill(distance);
    await panel.getByTestId('explode-add-step').click();
  };
  await step(['Top'], '+z', '12');
  await step(['Back'], '+y', '12');
  await step(['Left stile', 'Right stile', 'Bottom rail', 'Top rail'], '-y', '12');
  await step(['Left side'], '-x', '12');
  await step(['Right side'], '+x', '12');
  await expect(panel.getByTestId('explode-steps').locator(':scope > li')).toHaveCount(5);
  const steps = async () => {
    await regenerated(page);
    return page.evaluate((id) => {
      const a = window.__manufakture!.model.getState().assemblies.find((x) => x.assemblyId === id);
      const views = (
        a as unknown as {
          explodedViews?: {
            steps: { instances: string[]; direction: number[] | null; distance: number | null }[];
          }[];
        }
      ).explodedViews;
      return (views?.[0]?.steps ?? []).map((s) => ({
        instances: s.instances,
        move: s.direction!.map((c) => Math.round(c * s.distance! * 1e6) / 1e6 + 0),
      }));
    }, ASSEMBLY);
  };
  const foot = 304.8; // 12", mm
  await expect.poll(steps).toEqual([
    { instances: [instanceOf('Top')], move: [0, 0, foot] },
    { instances: [instanceOf('Back')], move: [0, foot, 0] },
    {
      instances: ['Left stile', 'Right stile', 'Bottom rail', 'Top rail'].map(instanceOf),
      move: [0, -foot, 0],
    },
    { instances: [instanceOf('Left side')], move: [-foot, 0, 0] },
    { instances: [instanceOf('Right side')], move: [foot, 0, 0] },
  ]);
  await expect(page.getByTestId('explode-overlay')).toHaveAttribute('data-trails', '8');
  // The stored poses never move.
  const poses = await page.evaluate(
    (id) =>
      window
        .__manufakture!.document.getState()
        .document.assemblies.find((a) => a.id === id)!
        .instances.map((x) => x.pose),
    ASSEMBLY,
  );
  expect(poses).toEqual(BOARDS.map(() => ({ translation: [0, 0, 0], rotation: [0, 0, 0, 1] })));
  await look(page, 'iso');
  await page.evaluate(() =>
    window.__manufakture!.viewport.frameBox(
      { min: [-400, -400, -50], max: [1200, 700, 2200] },
      false,
    ),
  );
  await docShot('08-exploded');
});

test('7. a drawing: three views with overall dimensions, and the exploded view', async () => {
  test.setTimeout(360_000);
  // A taller window for the drawing chapters, so the whole sheet fits on screen.
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.getByTestId('part-tab-part#1').click();
  await regenerated(page);
  await page.getByTestId('drawing-add').click();
  await page.getByTestId('drawing-new-name').fill('Bookshelf');
  await page.getByTestId('drawing-new-size').selectOption('tabloid');
  await page.getByTestId('drawing-new-field-Drawn by').fill('E2E');
  await page.getByTestId('drawing-new-create').click();
  await expect(page.getByTestId(`drawing-tab-${D}`)).toHaveAttribute('aria-selected', 'true');
  // The whole sheet on screen, so every point of it can be clicked.
  await page.getByTestId('drawing-zoom-fit').click();
  await page.getByTestId('drawing-insert-source').selectOption('part:part#1');
  await page.getByTestId('drawing-insert-direction').selectOption('front');
  await page.getByTestId('drawing-insert-scale').fill(`1:${SCALE}`);
  await page.getByTestId('drawing-insert-ok').click();
  await page.getByTestId('drawing-insert-close').click();
  await sheetReady();

  // Down to the bottom left, so the top view fits above it and the right view beside it.
  const W = SHELF.modelled;
  await dragViewTo('view#1', [95, 110]);
  const front = (await drawing())!.sheets[0]!.views[0]!;
  await clickPaper(on(front, [W / 2, 1]));
  await expect(page.getByTestId('drawing-view-panel')).toBeVisible();
  await page.getByTestId('drawing-project-top').click();
  await clickPaper(on(front, [W / 2, 1]));
  await page.getByTestId('drawing-project-right').click();
  const views = (await drawing())!.sheets[0]!.views;
  expect(views.map((v) => v.direction)).toEqual(['front', 'top', 'right']);
  const top = views[1]!;
  await sheetReady();

  // Overall width, height and depth, and the first shelf's thickness, picked in the views.
  // Front view: x is model X, y is model Z; top view: x is X, y is Y.
  await page.getByTestId('drawing-tool-dimension').click();
  await dimension('horizontal', [on(front, [0, 0]), on(front, [W, 0])], on(front, [W / 2, -8]));
  await dimension('vertical', [on(front, [W, 0]), on(front, [W, 72])], on(front, [W + 8, 36]));
  await dimension(
    'vertical',
    [on(top, [0, -SHELF.stick.thickness]), on(top, [0, SHELF.depth])],
    on(top, [-8, 5]),
  );
  const z = SHELF.shelves[0];
  await dimension(
    'vertical',
    [on(front, [W / 2, z]), on(front, [W / 2, z + SHELF.ply])],
    on(front, [W / 2 + 4, z]),
  );
  dimensionsBefore = await dimensionValues();
  expect(dimensionsBefore).toEqual(['30"', '72"', '12"', '23/32"']);

  // The exploded view of the assembly, isometric, through the Insert view panel.
  const explodedId = await page.evaluate(
    (id) =>
      (
        window
          .__manufakture!.document.getState()
          .document.assemblies.find((a) => a.id === id) as unknown as {
          explodedViews: { id: string }[];
        }
      ).explodedViews[0]!.id,
    ASSEMBLY,
  );
  await page.getByTestId('drawing-tool-select').click();
  await page.getByTestId('drawing-insert-view').click();
  await page.getByTestId('drawing-insert-source').selectOption(`explode:${ASSEMBLY}:${explodedId}`);
  await page.getByTestId('drawing-insert-direction').selectOption('isometric');
  await page.getByTestId('drawing-insert-scale').fill('1:16');
  await page.getByTestId('drawing-insert-ok').click();
  await page.getByTestId('drawing-insert-close').click();
  await sheetReady();
  await dragViewTo('view#4', [320, 165]);
  const all = (await drawing())!.sheets[0]!.views;
  expect(all).toHaveLength(4);
  expect(all[3]!.direction).toBe('isometric');
  expect(all[3]!.source).toEqual({ assembly: ASSEMBLY, explodedView: explodedId });
  for (const v of all) {
    await expect(
      page.getByTestId('drawing-sheet').locator(`path[data-owner="${v.id}"]`).first(),
    ).toBeAttached();
  }
  await expect(page.getByTestId('drawing-messages')).toHaveCount(0);
  await docShot('09-drawing');
});

test('8. exports: the drawing as SVG, DXF and PDF, the cut list as CSV and PDF', async () => {
  test.setTimeout(240_000);
  const values = dimensionsBefore;

  const svg = await downloaded(() => page.getByTestId('drawing-export-svg').click());
  expect(svg.name).toBe('Bookshelf - Sheet 1.svg');
  const svgText = svg.bytes.toString('utf8');
  expect(svgText).toMatch(/^<\?xml[^>]*>\s*<svg [^>]*width="431\.8mm" height="279\.4mm"/);
  for (const id of ['view#1', 'view#2', 'view#3', 'view#4', ...DIMENSIONS]) {
    expect(svgText).toContain(`data-owner="${id}"`);
  }
  for (const v of values) expect(svgText).toContain(`>${v.replaceAll('"', '&quot;')}</text>`);

  const dxf = await downloaded(() => page.getByTestId('drawing-export-dxf').click());
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dxf-parser's types are loose
  const parsed: any = new DxfParser().parseSync(dxf.bytes.toString('utf8'));
  expect(Object.keys(parsed.tables.layer.layers)).toEqual(
    expect.arrayContaining(['visible', 'hidden', 'dimension', 'text']),
  );
  const texts = parsed.entities
    .filter((e: { type: string }) => e.type === 'TEXT')
    .map((e: { text: string }) => e.text);
  expect(texts).toEqual(expect.arrayContaining(values));

  const pdf = await downloaded(() => page.getByTestId('drawing-export-pdf').click());
  expect(pdf.name).toBe('Bookshelf.pdf');
  const doc = await getDocument({ data: new Uint8Array(pdf.bytes), verbosity: 0 }).promise;
  expect(doc.numPages).toBe(1);
  const p1 = await doc.getPage(1);
  const vp = p1.getViewport({ scale: 1 });
  expect([vp.width, vp.height].map((v) => Math.round(v))).toEqual([1224, 792]);
  const pdfText = (await p1.getTextContent()).items.map((i) => ('str' in i ? i.str : '')).join(' ');
  for (const v of values) expect(pdfText).toContain(v);
  await doc.cleanup();

  // The cut list's PDF: the list, then every sheet and stick plan, numbered as in the list.
  await page.getByTestId('part-tab-part#1').click();
  await regenerated(page);
  const panel = await openCutList();
  await expectLayouts(SHELF.modelled);
  const list = await downloaded(() => panel.getByTestId('cutlist-pdf').click());
  expect(list.name).toBe('Bookshelf cut list.pdf');
  const cut = await getDocument({ data: new Uint8Array(list.bytes), verbosity: 0 }).promise;
  const pages: string[] = [];
  for (let n = 1; n <= cut.numPages; n++) {
    pages.push(
      (await (await cut.getPage(n)).getTextContent()).items
        .map((i) => ('str' in i ? i.str : ''))
        .filter((s) => s !== '')
        .join(' '),
    );
  }
  const text = pages.join('\n');
  for (const item of ['Back', 'Left side, Right side', 'Bottom, Top, Shelf 1-3']) {
    expect(text).toContain(item);
  }
  expect(text).toContain('1/4" plywood: sheet 1 of 1');
  expect(text).toContain('3/4" plywood: sheet 1 of 1');
  await cut.cleanup();
});

test('9. a reload brings it all back', async () => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  beforeReload = await page.evaluate(() => window.__manufakture!.document.getState().document);
  await saved(page);
  await page.reload();
  await expect(page.getByTestId('document-name')).toHaveText(SHELF.name, { timeout: 90_000 });
  await allOk();
  expect(await page.evaluate(() => window.__manufakture!.document.getState().document)).toEqual(
    beforeReload,
  );
  expectVolumes(await volumes(12), handVolumes(SHELF.modelled));
  await openCutList();
  await expect.poll(rows, { timeout: 60_000 }).toEqual(partStudioRows);
  await page.getByTestId(`drawing-tab-${D}`).click();
  expect(await dimensionValues()).toEqual(dimensionsBefore);
});

test('10. the plywood measured at 11/16": dados, cut list and dimensions follow', async () => {
  test.setTimeout(300_000);
  await page.getByTestId('part-tab-part#1').click();
  await regenerated(page);
  const stock = page.getByRole('complementary', { name: 'Stock' });
  await stock.getByTestId('stock-row-us-ply-23-32').getByTestId('stock-edit').click();
  await stock.getByTestId('override-thickness').fill('11/16"');
  await stock.getByTestId('override-save').click();
  await expect(stock.getByTestId('stock-row-us-ply-23-32').getByTestId('stock-size')).toHaveText(
    '11/16" (measured)',
  );
  const t = SHELF.measured;
  await allOk();
  await expectPlaced(SHELF.modelled, t);
  expectVolumes(await volumes(12), handVolumes(SHELF.modelled, t));

  // The dado follows the shelf: as wide as it is thick, and 1/32" shallower.
  await page.getByTestId('feature-extension#17').dblclick();
  await expect(page.getByTestId('joint-sizes')).toHaveText(
    'Groove 11/16" wide and 7/32" deep, 11-1/4" long.',
  );
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByTestId('feature-dialog')).toBeHidden();

  await openCutList();
  await expectCutList(SHELF.modelled, t);
  // Thinner plywood changes no blank's length or width, so the layouts are the same.
  await expectLayouts(SHELF.modelled);
  await docShot('10-measured');

  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.getByTestId(`drawing-tab-${D}`).click();
  expect(await dimensionValues()).toEqual(['30"', '72"', '12"', '11/16"']);
  await docShot('11-drawing-measured');
  expect(errors).toEqual([]);
});
