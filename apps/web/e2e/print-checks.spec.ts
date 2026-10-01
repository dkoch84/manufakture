import { expect, test, type Page } from '@playwright/test';
import { openEmpty, regenerated } from './bracket';
import { settle } from './helpers';
import { execute, saved } from './m2-fixtures';

// The print workspace (M3 plan, T3.1d), through the UI and the real regen and print-analysis
// workers, on the owner's printer (a Bambu Lab X1 Carbon with a 0.4 mm nozzle):
// - a T-shaped part as modelled shows an overhang under the bar; laid flat on the bar's top face
//   it has none; undo brings the overhang back, redo takes it away again;
// - a 0.5 mm fin is listed as a thin wall;
// - a 200 mm part fails bed fit on an A1 mini, along x by 20 mm, and fits an X1 Carbon;
// - the setups survive a reload.
// Screenshot baselines of the overhang and thickness shading are in e2e/__screenshots__/; the
// canvas is pinned to a fixed size and place so the machine's fonts cannot change its layout.
// Refresh them after an intended change to the shading with --update-snapshots.

const mm = (source: string) => ({ source, lengthUnit: 'mm', angleUnit: 'deg' });
const XZ = { type: 'plane', origin: [0, 0, 0], normal: [0, -1, 0], xDir: [1, 0, 0] };
const XY = { type: 'plane', origin: [0, 0, 0], normal: [0, 0, 1], xDir: [1, 0, 0] };

/** A closed polyline sketch. */
function outline(plane: unknown, points: [number, number][]) {
  return {
    id: 'sketch#1',
    kind: 'sketch',
    name: 'Sketch 1',
    suppressed: false,
    plane,
    entities: points.map((start, i) => ({
      id: `e${i + 1}`,
      kind: 'line',
      construction: false,
      start,
      end: points[(i + 1) % points.length],
    })),
    constraints: [],
  };
}

function extrude(distance: number) {
  return {
    id: 'extrude#1',
    kind: 'extrude',
    name: 'Extrude 1',
    suppressed: false,
    profile: { sketch: 'sketch#1' },
    operation: 'new',
    extent: { type: 'blind', distance: mm(`${distance} mm`) },
    reverse: false,
  };
}

const rectangle = (x: number, y: number): [number, number][] => [
  [0, 0],
  [x, 0],
  [x, y],
  [0, y],
];

/**
 * The T on the front plane: a stem 10 wide and 30 high under a bar 40 wide and 10 high,
 * extruded 10 mm. The bar's underside, either side of the stem, faces straight down 30 mm up.
 */
const T: [number, number][] = [
  [15, 0],
  [25, 0],
  [25, 30],
  [40, 30],
  [40, 40],
  [0, 40],
  [0, 30],
  [15, 30],
];

async function addPart(
  page: Page,
  partId: string,
  name: string,
  plane: unknown,
  points: [number, number][],
  height: number,
) {
  if (partId !== 'part#1') await execute(page, { type: 'addPart', partId, name }, `Add ${name}`);
  await execute(
    page,
    { type: 'addFeature', partId, feature: outline(plane, points) },
    'Add sketch',
  );
  await execute(page, { type: 'addFeature', partId, feature: extrude(height) }, 'Add extrude');
  await page.waitForFunction(
    (id) => {
      const hooks = window.__manufakture!;
      const m = hooks.model.getState();
      return (
        !m.pending &&
        m.document === hooks.document.getState().document &&
        m.parts.some((p) => p.partId === id && p.bodies.length === 1)
      );
    },
    partId,
    { timeout: 90_000 },
  );
}

/** Wait until the print workspace has checked the setup as it is now. */
async function checked(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const p = window.__manufakture!.print!;
    const r = p.resolved();
    const a = p.analysis();
    // The export-tolerance meshes first: the analysis of the coarse meshes is not the last one.
    return (
      r !== null &&
      r.items.every((i) => i.status === 'ok') &&
      p.meshesSettled() &&
      !a.running &&
      a.reply !== null
    );
  });
}

/** Issue kinds listed now, in order. */
function issueKinds(page: Page): Promise<string[]> {
  return page.evaluate(() => window.__manufakture!.print!.issues().map((i) => i.kind));
}

/**
 * A screenshot of the canvas pinned to a fixed size and place (so it does not depend on the
 * toolbar's height, which follows the machine's fonts), looking along `eye` at every placed
 * copy. The pin is taken off again afterwards, since the pinned canvas covers the toolbars.
 */
async function shot(page: Page, name: string, eye: [number, number, number]) {
  const style = await page.addStyleTag({
    content:
      '[data-testid="viewport-canvas"] { position: fixed !important; left: 0 !important; ' +
      'top: 0 !important; width: 760px !important; height: 540px !important; }',
  });
  await page.mouse.move(1270, 790);
  const canvas = page.getByTestId('viewport-canvas');
  await expect
    .poll(() => canvas.evaluate((c: HTMLCanvasElement) => [c.width, c.height].join('x')))
    .toBe(await page.evaluate(() => `${760 * devicePixelRatio}x${540 * devicePixelRatio}`));
  const mask = await cubeMask(page);
  await frameItems(page, eye);
  await expect(canvas).toHaveScreenshot(name, { mask: [mask] });
  await style.evaluate((e) => (e as Element).remove());
  await page.evaluate(() => document.getElementById('e2e-cube-mask')?.remove());
  await settle(page);
}

/** A plain element over the view cube, for `mask`. */
async function cubeMask(page: Page) {
  await page.evaluate(() => {
    const canvas = document.querySelector('[data-testid="viewport-canvas"]')!;
    const r = canvas.getBoundingClientRect();
    const size = 110 + 2 * 12;
    let mask = document.getElementById('e2e-cube-mask');
    if (!mask) {
      mask = document.createElement('div');
      mask.id = 'e2e-cube-mask';
      document.body.append(mask);
    }
    Object.assign(mask.style, {
      position: 'fixed',
      left: `${r.right - size}px`,
      top: `${r.top}px`,
      width: `${size}px`,
      height: `${size}px`,
      pointerEvents: 'none',
    });
  });
  return page.locator('#e2e-cube-mask');
}

/** Look along `direction` (from the eye towards the target) at every placed copy, at once. */
async function frameItems(page: Page, eye: [number, number, number]) {
  await page.evaluate((e) => {
    const hooks = window.__manufakture!;
    const boxes = hooks.print!.resolved()!.items.flatMap((i) => i.copies.map((c) => c.box));
    const min = [0, 1, 2].map((a) => Math.min(...boxes.map((b) => b.min[a]!))) as [
      number,
      number,
      number,
    ];
    const max = [0, 1, 2].map((a) => Math.max(...boxes.map((b) => b.max[a]!))) as [
      number,
      number,
      number,
    ];
    hooks.viewport.setViewDirection(e, false);
    hooks.viewport.frameBox({ min, max }, false);
  }, eye);
  await settle(page);
}

test('print checks: overhangs, lay flat, thin walls, bed fit, reload', async ({ page }) => {
  test.setTimeout(300_000);
  const errors = await openEmpty(page);
  await addPart(page, 'part#1', 'T', XZ, T, 10);
  await regenerated(page);

  // 1. The print workspace, a setup on the X1 Carbon with a 0.4 mm nozzle, and the T as modelled.
  await page.getByTestId('open-print').click();
  await expect(page.getByTestId('print-empty')).toBeVisible();
  await page.getByTestId('print-add-setup').click();
  await expect(page.getByTestId('print-printer')).toHaveValue('bambu-x1c');
  await expect(page.getByTestId('print-nozzle')).toHaveValue('0.4');
  await page.getByTestId('print-add-item').click();
  await checked(page);
  await expect(page.getByTestId('print-bed-fit')).toHaveAttribute('data-fits', 'true');
  const overhang = page.getByTestId('print-issue-overhang');
  await expect(overhang).toBeVisible();
  // The bar's underside faces straight down: a flat ceiling at 90 degrees from vertical.
  await expect(overhang).toHaveAttribute('data-worst', '90.00°');
  expect(await page.evaluate(() => window.__manufakture!.viewport.info().shading)).toBe('overhang');
  expect(await page.evaluate(() => window.__manufakture!.viewport.info().buildVolume)).toBe(true);
  // Clicking it selects the two faces under the bar.
  await overhang.click();
  await expect
    .poll(() => page.evaluate(() => window.__manufakture!.selection.getState().selected.length))
    .toBe(2);
  await page.evaluate(() => window.__manufakture!.selection.getState().clear());

  // Screenshot: the overhang shading, from below, so the bar's underside shows.
  await shot(page, 't-overhang.png', [0.8, -1.2, -0.7]);

  // 2. Lay flat on the bar's top face: the T stands on its bar, and nothing overhangs.
  await frameItems(page, [0.6, -1, 1.2]);
  const top = await page.evaluate(() => {
    const copy = window.__manufakture!.print!.resolved()!.items[0]!.copies[0]!;
    const t = copy.placement.translation;
    // The middle of the bar's top face in the part (x 20, y -5, z 40), placed (no rotation yet).
    return [20 + t[0], -5 + t[1], 40 + t[2]] as [number, number, number];
  });
  await page.getByTestId('print-lay-flat').click();
  await expect(page.getByTestId('print-lay-flat-hint')).toBeVisible();
  const at = await page.evaluate((p) => window.__manufakture!.viewport.projectToClient(p), top);
  await page.mouse.click(at.x, at.y);
  await expect(page.getByTestId('print-item-item#1')).toContainText('Flat on');
  await checked(page);
  await expect(page.getByTestId('print-issue-overhang')).toHaveCount(0);
  expect(await issueKinds(page)).not.toContain('overhang');
  const flat = await page.evaluate(
    () => window.__manufakture!.print!.resolved()!.items[0]!.copies[0]!.box,
  );
  // Upside down, still 40 mm tall, standing on the bed.
  expect(flat.min[2]).toBeCloseTo(0, 6);
  expect(flat.max[2]).toBeCloseTo(40, 4);

  // 3. Undo takes the orientation back (and the overhang with it); redo lays it flat again.
  await page.keyboard.press('Control+z');
  await expect(page.getByTestId('print-item-item#1')).toContainText('As modelled');
  await expect(page.getByTestId('print-issue-overhang')).toBeVisible();
  await page.keyboard.press('Control+y');
  await expect(page.getByTestId('print-item-item#1')).toContainText('Flat on');
  await expect(page.getByTestId('print-issue-overhang')).toHaveCount(0);

  // 4. A 0.5 mm fin: a thin wall (two lines at 0.4 mm are 0.84 mm).
  await addPart(page, 'part#2', 'Fin', XY, rectangle(0.5, 10), 10);
  await page.getByTestId('print-add-part').selectOption('part#2');
  await page.getByTestId('print-add-item').click();
  await checked(page);
  const thin = page.getByTestId('print-issue-thinWall');
  await expect(thin).toBeVisible();
  await expect(thin).toHaveAttribute('data-item', 'item#2');
  await expect(thin).toHaveAttribute('data-worst', '0.50 mm');

  // Screenshot: the thickness heat map of the T (laid flat) and the fin.
  await page.getByTestId('print-shading-thickness').click();
  expect(await page.evaluate(() => window.__manufakture!.viewport.info().shading)).toBe(
    'thickness',
  );
  await shot(page, 't-and-fin-thickness.png', [0.6, -1, 0.8]);

  // 5. Bed fit: a 200 mm bar on an A1 mini (180 mm) is 20 mm too long in x; it fits an X1 Carbon.
  await addPart(page, 'part#3', 'Bar', XY, rectangle(200, 20), 10);
  await page.getByTestId('print-add-setup').click();
  await expect(page.getByTestId('print-setup-name')).toHaveValue('Plate 2');
  await page.getByTestId('print-printer').selectOption('bambu-a1-mini');
  await page.getByTestId('print-add-part').selectOption('part#3');
  await page.getByTestId('print-add-item').click();
  const bedFit = page.getByTestId('print-issue-bedFit');
  await expect(bedFit).toBeVisible();
  await expect(bedFit).toHaveAttribute('data-worst', 'x 20.00 mm');
  await expect(page.getByTestId('print-bed-fit')).toHaveAttribute('data-fits', 'false');
  await page.getByTestId('print-printer').selectOption('bambu-x1c');
  await expect(page.getByTestId('print-bed-fit')).toHaveAttribute('data-fits', 'true');
  await expect(page.getByTestId('print-issue-bedFit')).toHaveCount(0);

  // 6. A reload keeps both setups, their printers and items.
  await saved(page);
  await page.reload();
  await expect(page.getByTestId('document-name')).toBeVisible({ timeout: 90_000 });
  await regenerated(page);
  await page.getByTestId('open-print').click();
  const setups = page.getByTestId('print-setup-select').locator('option');
  await expect(setups).toHaveText(['Plate 1', 'Plate 2']);
  await expect(page.getByTestId('print-item-item#1')).toContainText('Flat on');
  await expect(page.getByTestId('print-item-item#2')).toBeVisible();
  await page.getByTestId('print-setup-select').selectOption({ label: 'Plate 2' });
  await expect(page.getByTestId('print-printer')).toHaveValue('bambu-x1c');
  await expect(page.getByTestId('print-item-item#3')).toBeVisible();
  expect(errors).toEqual([]);
});
