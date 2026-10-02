import { expect, test, type Page } from '@playwright/test';
import { ok, openEmpty, openTool, regenerated } from './bracket';
import { settle } from './helpers';
import { execute, saved } from './m2-fixtures';

// Joints between boards (M4 plan T4.2c), through the Joint dialog of a millimetre document: a dado
// and a rabbet, each between two 18 mm plywood panels, and a mortise and tenon between two 2x4
// sticks. Each joint's volumes are checked against hand-computed ones. Overriding the plywood's
// thickness in the Stock panel widens the dado and the rabbet with it (the groove is as wide as
// the shelf is thick) and deepens them (the side is thicker, the shelf still starts 12 mm up).
// Every step is undone and redone, and the document survives a reload with its joints.

const T = 18;
/** A 600 x 300 side, `t` thick, with a groove as wide as the shelf (t) and t - 12 deep. */
const SIDE = (t: number) => 600 * 300 * t - t * 300 * (t - 12);
const SHELF = (t: number) => 300 * 400 * t;
const IN = 25.4;
const LEG = 400 * 1.5 * IN * 3.5 * IN;
const RAIL = 300 * 1.5 * IN * 3.5 * IN;
// The tenon's defaults: a third of the rail's thickness, its width less two thirds of its
// thickness, as long as the rail reaches into the leg (25 mm).
const TENON = (1.5 * IN) / 3;
const TENON_WIDTH = 3.5 * IN - (2 / 3) * 1.5 * IN;
const MORTISE = TENON * TENON_WIDTH * 25;

type V = [number, number, number];
const plane = (origin: V, normal: V, xDir: V) => ({ type: 'plane', origin, normal, xDir }) as const;
const ground = (z: number) => plane([0, 0, z], [0, 0, 1], [1, 0, 0]);
/** A plane facing +x: sketch x along +y, sketch y up. */
const facingX = (origin: V) => plane(origin, [1, 0, 0], [0, 1, 0]);

function sketch(
  id: string,
  name: string,
  p: ReturnType<typeof plane>,
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
      plane: p,
      entities: lines.map((l) => ({ ...l, kind: 'line', construction: false })),
      constraints: [],
    },
  };
}

function rectangle(id: string, p: ReturnType<typeof plane>, w: number, h: number, first: number) {
  const c: [number, number][] = [
    [0, 0],
    [w, 0],
    [w, h],
    [0, h],
  ];
  return sketch(
    id,
    `Outline ${id}`,
    p,
    c.map((start, i) => ({ id: `e${first + i}`, start, end: c[(i + 1) % 4]! })),
  );
}

function board(n: number, name: string, sketchId: string, params: Record<string, unknown>) {
  return {
    type: 'addFeature',
    partId: 'part#1',
    feature: {
      id: `extension#${n}`,
      kind: 'extension',
      name,
      suppressed: false,
      extension: 'wood.board',
      schemaVersion: 1,
      operation: 'new',
      dependsOn: [sketchId],
      references: [],
      expressions: {},
      params: { sketch: sketchId, ...params },
    },
  };
}

const panel = (n: number, name: string, sketchId: string) =>
  board(n, name, sketchId, { form: 'panel', stock: 'mm-ply-18' });
const stick = (n: number, name: string, sketchId: string, line: string, thickness: string) =>
  board(n, name, sketchId, {
    form: 'stick',
    stock: 'us-2x4',
    line,
    justify: { thickness, width: 'positive' },
  });

/** Every shown body's exact volume, by regen body id, once `count` bodies are measured. */
async function volumes(page: Page, count: number): Promise<Record<string, number | null>> {
  await regenerated(page);
  await page.evaluate(() => window.__manufakture!.selection.getState().clear());
  await page.waitForFunction(
    (n) => {
      const m = window.__manufakture!.measure.getState();
      const shown = window.__manufakture!.model.getState().parts[0]!.bodies.length;
      if (shown !== n) return false;
      if (m.status !== 'ready' || m.request?.targets.length !== 0) return false;
      return m.bodies.length === n;
    },
    count,
    { timeout: 90_000 },
  );
  return page.evaluate(() =>
    Object.fromEntries(
      window
        .__manufakture!.measure.getState()
        .bodies.map((b) => [b.bodyId.slice(b.bodyId.indexOf('/') + 1), b.body?.volume ?? null]),
    ),
  );
}

function expectVolumes(actual: Record<string, number | null>, expected: Record<string, number>) {
  expect(Object.keys(actual).sort()).toEqual(Object.keys(expected).sort());
  for (const [id, v] of Object.entries(expected)) {
    expect(actual[id]! / v, id).toBeCloseTo(1, 6);
  }
}

/** Open the Joint tool and fill in its kind and boards. */
async function joint(page: Page, kind: string, a: string, b: string): Promise<void> {
  await openTool(page, 'Joint');
  await page.getByTestId('field-kind').selectOption(kind);
  await page.getByTestId('field-a').selectOption(a);
  await page.getByTestId('field-b').selectOption(b);
}

const previewLines = (page: Page) =>
  page.evaluate(() => window.__manufakture!.viewport.info().previewLines);
const undo = (page: Page) => page.evaluate(() => window.__manufakture!.document.getState().undo());
const redo = (page: Page) => page.evaluate(() => window.__manufakture!.document.getState().redo());

test('joints: a dado, a rabbet, a mortise and tenon; a thicker stock widens them; undo; reload', async ({
  page,
}) => {
  const errors = await openEmpty(page);
  await execute(
    page,
    {
      type: 'batch',
      commands: [
        // A side on the ground, a shelf standing in it 200 mm along, 12 mm up: 6 mm into it.
        rectangle('sketch#1', ground(0), 600, 300, 1),
        panel(1, 'Side', 'sketch#1'),
        rectangle('sketch#2', facingX([200, 0, 12]), 300, 400, 5),
        panel(2, 'Shelf', 'sketch#2'),
        // A second side higher up, a back standing at its end: a rabbet.
        rectangle('sketch#3', ground(1000), 600, 300, 9),
        panel(3, 'Top', 'sketch#3'),
        rectangle('sketch#4', facingX([0, 0, 1012]), 300, 400, 13),
        panel(4, 'Back', 'sketch#4'),
        // A 2x4 leg flat along x, and a 2x4 rail along y whose end reaches 25 mm into it.
        sketch('sketch#5', 'Leg line', ground(2000), [{ id: 'e17', start: [0, 0], end: [400, 0] }]),
        stick(5, 'Leg', 'sketch#5', 'e17', 'positive'),
        sketch('sketch#6', 'Rail line', ground(2000), [
          { id: 'e18', start: [200, 1.5 * IN - 25], end: [200, 1.5 * IN - 25 + 300] },
        ]),
        stick(6, 'Rail', 'sketch#6', 'e18', 'centre'),
      ],
    },
    'Boards',
  );
  const boards = {
    'extension#1': 600 * 300 * T,
    'extension#2': SHELF(T),
    'extension#3': 600 * 300 * T,
    'extension#4': SHELF(T),
    'extension#5': LEG,
    'extension#6': RAIL,
  };
  expectVolumes(await volumes(page, 6), boards);

  // A dado: the dialog says which board is cut where, and the view shows the groove.
  await joint(page, 'dado', 'extension#1', 'extension#2');
  await expect(page.getByTestId('joint-cuts-a')).toHaveText('Cut from Side (A): a groove.');
  await expect(page.getByTestId('joint-cuts-b')).toHaveText('Cut from Shelf (B): nothing.');
  await expect(page.getByTestId('joint-sizes')).toHaveText(
    'Groove 18.00 mm wide and 6.00 mm deep, 300.00 mm long.',
  );
  await settle(page);
  expect(await previewLines(page)).toBe(6);
  // The wrong kind is refused, readably, and draws nothing.
  await page.getByTestId('field-kind').selectOption('rabbet');
  await expect(page.getByTestId('joint-refusal')).toContainText('This joint cannot be built.');
  await settle(page);
  expect(await previewLines(page)).toBe(0);
  await page.getByTestId('field-kind').selectOption('dado');
  await ok(page);
  expect(await previewLines(page)).toBe(0);
  await expect(page.getByTestId('feature-extension#7')).toContainText('Dado 7');
  await expect(page.getByTestId('detail-extension#7')).toHaveText('Shelf into Side');
  const dado = { ...boards, 'extension#1': SIDE(T) };
  expectVolumes(await volumes(page, 6), dado);

  // A rabbet at the end of the top.
  await joint(page, 'rabbet', 'extension#3', 'extension#4');
  await expect(page.getByTestId('joint-cuts-a')).toHaveText('Cut from Top (A): a groove.');
  await ok(page);
  const rabbet = { ...dado, 'extension#3': SIDE(T) };
  expectVolumes(await volumes(page, 6), rabbet);

  // A mortise and tenon: the tenon on the rail's end (dashed in the view), the mortise in the leg.
  await joint(page, 'mortise-tenon', 'extension#5', 'extension#6');
  await expect(page.getByTestId('joint-cuts-a')).toHaveText('Cut from Leg (A): a mortise.');
  await expect(page.getByTestId('joint-cuts-b')).toContainText('2 tenon cheeks');
  await settle(page);
  expect(await previewLines(page)).toBeGreaterThan(6);
  await ok(page);
  const tenon = {
    ...rabbet,
    'extension#5': LEG - MORTISE,
    'extension#6': RAIL - (1.5 * IN * 3.5 * IN - TENON * TENON_WIDTH) * 25,
  };
  expectVolumes(await volumes(page, 6), tenon);
  const results = await regenerated(page);
  for (const id of ['extension#7', 'extension#8', 'extension#9']) {
    expect(results[id]!.status, id).toBe('ok');
  }

  // The plywood 19 mm thick: both grooves widen (and deepen) with it; the 2x4s do not change.
  const stock = page.getByRole('complementary', { name: 'Stock' });
  await stock.getByTestId('stock-row-mm-ply-18').getByTestId('stock-edit').click();
  await stock.getByTestId('override-thickness').fill('19mm');
  await stock.getByTestId('override-save').click();
  const thicker = {
    ...tenon,
    'extension#1': SIDE(19),
    'extension#2': SHELF(19),
    'extension#3': SIDE(19),
    'extension#4': SHELF(19),
  };
  expectVolumes(await volumes(page, 6), thicker);
  // The dialog reports the wider groove.
  await page.getByTestId('feature-extension#7').dblclick();
  await expect(page.getByTestId('joint-sizes')).toHaveText(
    'Groove 19.00 mm wide and 7.00 mm deep, 300.00 mm long.',
  );
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByTestId('feature-dialog')).toBeHidden();

  // Undo each step, then redo them all.
  await undo(page);
  expectVolumes(await volumes(page, 6), tenon);
  await undo(page);
  expectVolumes(await volumes(page, 6), rabbet);
  await undo(page);
  expectVolumes(await volumes(page, 6), dado);
  await undo(page);
  expectVolumes(await volumes(page, 6), boards);
  for (let i = 0; i < 4; i++) await redo(page);
  expectVolumes(await volumes(page, 6), thicker);

  // Reload: the joints come back, and so do the volumes.
  await saved(page);
  await page.reload();
  await expect(page.getByTestId('feature-extension#9')).toBeVisible({ timeout: 90_000 });
  expectVolumes(await volumes(page, 6), thicker);
  const joints = await page.evaluate(() =>
    window
      .__manufakture!.document.getState()
      .document.parts[0]!.features.filter((f) => f.kind === 'extension' && f.id > 'extension#6')
      .map((f) => f.name),
  );
  expect(joints).toEqual(['Dado 7', 'Rabbet 8', 'Mortise and tenon 9']);
  expect(errors).toEqual([]);
});
