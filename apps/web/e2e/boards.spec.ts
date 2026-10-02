import { expect, test, type Page } from '@playwright/test';
import { ok, openEmpty, openTool, regenerated } from './bracket';
import { settle } from './helpers';
import { execute, saved } from './m2-fixtures';

// Boards from real stock (M4 plan T4.1d), through the UI of an inch document: a 2x4 stick along
// an 8 ft sketch line has the exact volume of 1-1/2" x 3-1/2" x 96"; two 3/4" plywood panels from
// 600 x 300 mm regions are 23/32" thick; overriding the plywood's thickness to 18.2mm in the Stock
// panel rebuilds every plywood board and leaves the 2x4 alone. Every step is undone and redone,
// and the document survives a reload with its boards and its override.

const INCH = 25.4;
const EIGHT_FEET = 96 * INCH;
const STICK = 1.5 * INCH * 3.5 * INCH * EIGHT_FEET;
const PANEL = (thickness: number) => 600 * 300 * thickness;
const PLY = (23 / 32) * INCH;

const mm = (source: string) => ({ source, lengthUnit: 'mm', angleUnit: 'deg' });
const ground = (z: number) =>
  ({ type: 'plane', origin: [0, 0, z], normal: [0, 0, 1], xDir: [1, 0, 0] }) as const;

/** A sketch with the given lines, unconstrained (regen keeps them where they are drawn). */
function sketch(
  id: string,
  name: string,
  z: number,
  lines: { id: string; start: [number, number]; end: [number, number] }[],
) {
  return {
    type: 'addFeature',
    partId: 'part#1',
    feature: {
      id,
      kind: 'sketch',
      name,
      suppressed: false,
      plane: ground(z),
      entities: lines.map((l) => ({ ...l, kind: 'line', construction: false })),
      constraints: [],
    },
  };
}

function rectangle(id: string, name: string, z: number, first: number) {
  const c: [number, number][] = [
    [0, 0],
    [600, 0],
    [600, 300],
    [0, 300],
  ];
  return sketch(
    id,
    name,
    z,
    c.map((start, i) => ({ id: `e${first + i}`, start, end: c[(i + 1) % 4]! })),
  );
}

/** Every shown body's exact volume, by regen body id, once `count` bodies are measured. */
async function volumes(page: Page, count: number): Promise<Record<string, number | null>> {
  await regenerated(page);
  await page.evaluate(() => window.__manufakture!.selection.getState().clear());
  await page.waitForFunction(
    (n) => {
      const m = window.__manufakture!.measure.getState();
      const shown = window.__manufakture!.model.getState().parts[0]!.bodies.length;
      if (shown !== n) return false;
      if (n === 0) return true;
      if (m.status !== 'ready' || m.request?.targets.length !== 0) return false;
      return n === 1 ? !!m.result?.body : m.bodies.length === n;
    },
    count,
    { timeout: 90_000 },
  );
  return page.evaluate((n) => {
    const m = window.__manufakture!.measure.getState();
    if (n === 0) return {};
    if (n === 1) {
      const id = window.__manufakture!.model.getState().parts[0]!.bodies[0]!.bodyId;
      return { [id]: m.result!.body!.volume };
    }
    return Object.fromEntries(
      m.bodies.map((b) => [b.bodyId.slice(b.bodyId.indexOf('/') + 1), b.body?.volume ?? null]),
    );
  }, count);
}

function expectVolumes(actual: Record<string, number | null>, expected: Record<string, number>) {
  expect(Object.keys(actual).sort()).toEqual(Object.keys(expected).sort());
  for (const [id, v] of Object.entries(expected)) {
    expect(actual[id]! / v, id).toBeCloseTo(1, 6);
  }
}

async function board(page: Page, sketchId: string): Promise<void> {
  await page.getByTestId(`feature-${sketchId}`).click();
  await openTool(page, 'Board');
}

const undo = (page: Page) => page.evaluate(() => window.__manufakture!.document.getState().undo());
const redo = (page: Page) => page.evaluate(() => window.__manufakture!.document.getState().redo());

test('boards: a 2x4 stick, plywood panels, a thickness override; undo each step; reload', async ({
  page,
}) => {
  const errors = await openEmpty(page);
  await execute(
    page,
    {
      type: 'batch',
      commands: [
        {
          type: 'setDisplayUnits',
          units: { length: { unit: 'in-fraction', denominator: 16 }, angle: { unit: 'deg' } },
        },
        sketch('sketch#1', 'Rail line', 0, [{ id: 'e1', start: [0, 0], end: [EIGHT_FEET, 0] }]),
        rectangle('sketch#2', 'Shelf', 200, 2),
        rectangle('sketch#3', 'Top', 400, 6),
      ],
    },
    'Sketches',
  );
  await regenerated(page);

  // A 2x4 stick along the line: an inch document opens the picker on US stock.
  await board(page, 'sketch#1');
  await expect(page.getByTestId('field-form')).toHaveValue('stick');
  await expect(page.getByTestId('stock-region-us')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('field-stock')).toHaveValue('us-2x4');
  await expect(page.getByTestId('board-preview')).toContainText('96" x 3-1/2" x 1-1/2"');
  await settle(page);
  expect(await page.evaluate(() => window.__manufakture!.viewport.info().previewLines)).toBe(10);
  await ok(page);
  expect(await page.evaluate(() => window.__manufakture!.viewport.info().previewLines)).toBe(0);
  expectVolumes(await volumes(page, 1), { 'extension#1': STICK });
  await expect(page.getByTestId('detail-extension#1')).toHaveText('2x4');

  // Two 3/4" plywood panels from the regions, 23/32" thick.
  for (const s of ['sketch#2', 'sketch#3']) {
    await board(page, s);
    await expect(page.getByTestId('field-form')).toHaveValue('panel');
    await expect(page.getByTestId('field-stock')).toHaveValue('us-ply-23-32');
    await ok(page);
  }
  const built = { 'extension#1': STICK, 'extension#2': PANEL(PLY), 'extension#3': PANEL(PLY) };
  expectVolumes(await volumes(page, 3), built);
  // Grain arrows on both broad faces of every board (pine and plywood both have a grain).
  await settle(page);
  expect(await page.evaluate(() => window.__manufakture!.viewport.info().grainLines)).toBe(12);
  expect(
    await page.evaluate(() => window.__manufakture!.document.getState().document.parts[0]!.bodies),
  ).toEqual([
    { id: 'extension#1', material: 'pine' },
    { id: 'extension#2', material: 'plywood' },
    { id: 'extension#3', material: 'plywood' },
  ]);

  // Override the plywood's thickness: every plywood board updates, the 2x4 does not.
  const panel = page.getByRole('complementary', { name: 'Stock' });
  await panel.getByTestId('stock-row-us-ply-23-32').getByTestId('stock-edit').click();
  await panel.getByTestId('override-thickness').fill('18.2mm');
  await panel.getByTestId('override-save').click();
  await expect(panel.getByTestId('stock-row-us-ply-23-32').getByTestId('stock-size')).toHaveText(
    '18.2mm (measured)',
  );
  const overridden = { ...built, 'extension#2': PANEL(18.2), 'extension#3': PANEL(18.2) };
  expectVolumes(await volumes(page, 3), overridden);

  // Undo each step, then redo them all.
  await undo(page);
  expectVolumes(await volumes(page, 3), built);
  await undo(page);
  expectVolumes(await volumes(page, 2), { 'extension#1': STICK, 'extension#2': PANEL(PLY) });
  await undo(page);
  expectVolumes(await volumes(page, 1), { 'extension#1': STICK });
  await undo(page);
  expectVolumes(await volumes(page, 0), {});
  for (let i = 0; i < 4; i++) await redo(page);
  expectVolumes(await volumes(page, 3), overridden);

  // Reload: the boards and the override come back, and so do the volumes.
  await saved(page);
  await page.reload();
  await expect(page.getByTestId('feature-extension#3')).toBeVisible({ timeout: 90_000 });
  expectVolumes(await volumes(page, 3), overridden);
  expect(
    await page.evaluate(() => window.__manufakture!.document.getState().document.domains),
  ).toEqual({
    stock: {
      schemaVersion: 1,
      data: { overrides: { 'us-ply-23-32': { thickness: { ...mm('18.2mm'), lengthUnit: 'in' } } } },
    },
  });
  expect(errors).toEqual([]);
});
