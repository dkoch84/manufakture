import { validate3mf } from '@manufakture/io';
import { expect, test, type Page } from '@playwright/test';
import { bodyVolume, exportAs, ok, openEmpty, openTool, regenerated, view } from './bracket';
import { clickWorld, settle } from './helpers';
import { newSketch, rectangle } from './sketch-helpers';

// Several bodies in one part, through the UI: two overlapping rectangles on Top extruded 10 mm
// as new bodies stay two bodies, each with its own exact volume. The second is coloured,
// renamed and given PETG (its mass follows), hidden (it is neither drawn nor picked), and
// exported with the first as two named 3MF objects. A third extrusion that adds and touches both
// fuses them into one body with the volume of the union.

const DEPTH = 10;
// Body 1: x 0..20, y 0..10. Body 2: x 10..30, y 5..15. Each 20 x 10 x 10.
const BODY_VOLUME = 20 * 10 * DEPTH;
// Body 3 (add): x 5..25, y -5..20, which covers everything but x 0..5 of body 1 and x 25..30 of
// body 2 (5 x 10 each).
const FUSED_VOLUME = (20 * 25 + 5 * 10 + 5 * 10) * DEPTH;

/** A rectangle as `[xmin, ymin, xmax, ymax]`. */
type Rect = [number, number, number, number];

/**
 * The rectangle a sketch really holds: clicked points land a few micrometres off the round
 * numbers, and the volumes are checked exactly against what was drawn.
 */
async function drawn(page: Page, sketchId: string): Promise<Rect> {
  const points = await page.evaluate(
    (id) =>
      window
        .__manufakture!.document.getState()
        .document.parts[0]!.features.find((f) => f.id === id)!
        .entities!.flatMap((e) => [e.start!, e.end!]),
    sketchId,
  );
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

const area = (r: Rect | null) => (r ? (r[2] - r[0]) * (r[3] - r[1]) : 0);

function meet(a: Rect | null, b: Rect | null): Rect | null {
  if (!a || !b) return null;
  const r: Rect = [
    Math.max(a[0], b[0]),
    Math.max(a[1], b[1]),
    Math.min(a[2], b[2]),
    Math.min(a[3], b[3]),
  ];
  return r[0] < r[2] && r[1] < r[3] ? r : null;
}

/** The area of the union of three rectangles (inclusion and exclusion). */
function unionArea(a: Rect, b: Rect, c: Rect): number {
  return (
    area(a) +
    area(b) +
    area(c) -
    area(meet(a, b)) -
    area(meet(a, c)) -
    area(meet(b, c)) +
    area(meet(meet(a, b), c))
  );
}

/** Zoom out until the view is at least `halfHeight` mm tall above and below its centre. */
async function zoomOut(page: Page, halfHeight = 40): Promise<void> {
  const box = (await page.getByTestId('viewport-canvas').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 20; i++) {
    const h = await page.evaluate(() => window.__manufakture!.viewport.info().halfHeight);
    if (h >= halfHeight) return;
    await page.mouse.wheel(0, 400);
    await settle(page);
  }
  throw new Error('The view did not zoom out');
}

async function extrudeRectangle(
  page: Page,
  sketchId: string,
  a: [number, number],
  b: [number, number],
  operation: 'new' | 'add',
): Promise<void> {
  // A sketch keeps the zoom, centred on the origin: make room for the whole rectangle.
  await zoomOut(page);
  await newSketch(page, 'Top (XY)');
  await rectangle(page, a, b);
  await page.getByRole('button', { name: 'Finish sketch' }).click();
  await expect(page.getByTestId(`feature-${sketchId}`)).toBeVisible();
  await page.getByTestId(`feature-${sketchId}`).click();
  await openTool(page, 'Extrude');
  await expect(page.getByTestId('field-sketch')).toHaveValue(sketchId);
  await page.getByTestId('field-operation').selectOption(operation);
  await page.getByTestId('field-distance').fill(String(DEPTH));
  await ok(page);
  // The new model refits the view: wait for it, so the next zoom is not undone.
  await regenerated(page);
  await settle(page);
}

/** The part's bodies as regen made them: `[bodyId, solids]`. */
async function bodies(page: Page): Promise<[string, number][]> {
  await regenerated(page);
  return page.evaluate(() =>
    window
      .__manufakture!.model.getState()
      .parts[0]!.bodies.map((b) => [b.bodyId, b.solids] as [string, number]),
  );
}

/** With nothing selected: every body's exact volume, by viewport id. */
async function bodyVolumes(page: Page): Promise<Record<string, number | null>> {
  await page.evaluate(() => window.__manufakture!.selection.getState().clear());
  await page.waitForFunction(() => {
    const s = window.__manufakture!.measure.getState();
    return s.status === 'ready' && s.request?.targets.length === 0 && s.bodies.length > 1;
  });
  return page.evaluate(() =>
    Object.fromEntries(
      window
        .__manufakture!.measure.getState()
        .bodies.map((b) => [b.bodyId, b.body?.volume ?? null]),
    ),
  );
}

const selectedIds = (page: Page) =>
  page.evaluate(() => window.__manufakture!.selection.getState().selected.map((i) => i.id));

test('bodies: two new bodies, named, coloured, weighed, hidden, exported, then fused', async ({
  page,
}) => {
  const errors = await openEmpty(page);

  // Two overlapping new extrusions are two bodies, each exactly its own volume.
  await extrudeRectangle(page, 'sketch#1', [0, 0], [20, 10], 'new');
  await extrudeRectangle(page, 'sketch#2', [10, 5], [30, 15], 'new');
  expect(await bodies(page)).toEqual([
    ['extrude#1', 1],
    ['extrude#2', 1],
  ]);
  const statuses = await regenerated(page);
  expect(statuses['extrude#2']).toMatchObject({ status: 'ok', warnings: [] });
  const volumes = await bodyVolumes(page);
  expect(Object.keys(volumes)).toEqual(['part#1/extrude#1', 'part#1/extrude#2']);
  const [first, second] = [await drawn(page, 'sketch#1'), await drawn(page, 'sketch#2')];
  // Each body is exactly its own extrusion: the overlap is in both, not merged.
  expect(volumes['part#1/extrude#1']).toBeCloseTo(area(first) * DEPTH, 6);
  expect(volumes['part#1/extrude#2']).toBeCloseTo(area(second) * DEPTH, 6);
  expect(volumes['part#1/extrude#1']! / BODY_VOLUME).toBeCloseTo(1, 4);
  expect(volumes['part#1/extrude#2']! / BODY_VOLUME).toBeCloseTo(1, 4);
  const section = page.getByRole('region', { name: 'Bodies' });
  await expect(section.getByRole('listitem')).toHaveCount(2);

  // Colour the second body, rename it and make it of PETG: its mass follows.
  await page.getByLabel('Colour of Body 2').fill('#ff8800');
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__manufakture!.viewport.info().bodies.find((b) => b.id === 'part#1/extrude#2')
            ?.color,
      ),
    )
    .toBe('#ff8800');
  await page.getByRole('button', { name: 'Rename Body 2' }).click();
  await page.getByLabel('New name for Body 2').fill('Lid');
  await page.getByLabel('New name for Body 2').press('Enter');
  await expect(page.getByTestId('body-extrude#2')).toContainText('Lid');
  await page.getByLabel('Material of Lid').selectOption('petg');
  expect(
    await page.evaluate(() => window.__manufakture!.document.getState().document.parts[0]!.bodies),
  ).toEqual([{ id: 'extrude#2', name: 'Lid', color: '#ff8800', material: 'petg' }]);
  const measure = page.getByRole('complementary', { name: 'Measure' });
  await expect(measure.getByTestId('measure-body2').getByRole('heading')).toHaveText('Lid');
  // 2000 mm3 of PETG at 1270 kg/m3.
  await expect(measure.getByTestId('measure-value-body2.mass')).toHaveText('2.54 g');
  await expect(measure.getByTestId('measure-value-body1.mass')).toHaveCount(0);

  // Hidden, the body is neither drawn nor picked; hiding is no undo step.
  await view(page, 'top');
  const onLidOnly: [number, number, number] = [25, 10, DEPTH];
  await clickWorld(page, onLidOnly);
  expect(await selectedIds(page)).toEqual(['part#1/extrude#2/extrude#2:cap:end']);
  const undoBefore = await page
    .getByRole('button', { name: 'Undo', exact: true })
    .getAttribute('title');
  await page.getByRole('button', { name: 'Hide Lid' }).click();
  await expect
    .poll(() => page.evaluate(() => window.__manufakture!.viewport.info().bodies.map((b) => b.id)))
    .toEqual(['part#1/extrude#1']);
  expect(await selectedIds(page)).toEqual([]);
  await view(page, 'top');
  await clickWorld(page, onLidOnly);
  expect((await selectedIds(page)).filter((id) => id.startsWith('part#1/extrude#2/'))).toEqual([]);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toHaveAttribute(
    'title',
    undoBefore!,
  );
  await page.getByRole('button', { name: 'Show Lid' }).click();
  await expect
    .poll(() => page.evaluate(() => window.__manufakture!.viewport.info().bodies.length))
    .toBe(2);

  // 3MF: one named object per body, each with its volume.
  const threemf = await exportAs(page, '3mf', 'normal');
  const report = validate3mf(threemf.bytes);
  expect(report.problems).toEqual([]);
  expect(report.parsed!.objects.map((o) => o.name)).toEqual(['Body 1', 'Lid']);
  for (const o of report.objects) {
    expect(o.manifold.volume / BODY_VOLUME).toBeCloseTo(1, 4);
  }

  // A third extrusion adding to both fuses them into one body, under the first one's id.
  await extrudeRectangle(page, 'sketch#3', [5, -5], [25, 20], 'add');
  await expect.poll(() => bodies(page), { timeout: 30_000 }).toEqual([['extrude#1', 1]]);
  const third = await drawn(page, 'sketch#3');
  expect(await bodyVolume(page)).toBeCloseTo(unionArea(first, second, third) * DEPTH, 6);
  expect((await bodyVolume(page)) / FUSED_VOLUME).toBeCloseTo(1, 4);
  await expect(page.getByRole('region', { name: 'Bodies' }).getByRole('listitem')).toHaveCount(1);
  expect(errors).toEqual([]);
});
