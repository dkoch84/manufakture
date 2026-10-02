import { expect, test, type Page } from '@playwright/test';

// Fits as variables (ADR 0012 decision 10, plan M3 T3.2g), through the UI and the real regen
// worker: Insert fit variables adds #fit_press, #fit_slip and #fit_sliding in one undo step; a
// hole sized as an M3 with a printed slip fit reads #fit_slip; changing #fit_slip in the table
// changes the hole. Then the fit-test coupon template, made from the home screen, regenerates,
// its debossed clearance labels included.

const PLATE = { x: 40, y: 20, t: 5 };
const M3 = 3;

async function openEmpty(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.getByTestId('empty-hint')).toBeVisible({ timeout: 90_000 });
  await page.waitForFunction(() => window.__manufakture!.model.getState().generation > 0);
  return errors;
}

/** Wait until the model shows the open document; then every feature's status and warnings. */
async function regenerated(
  page: Page,
): Promise<
  Record<string, { status: string; cached: boolean; errors: unknown[]; warnings: string[] }>
> {
  await page.waitForFunction(() => {
    const hooks = window.__manufakture!;
    const m = hooks.model.getState();
    return !m.pending && m.document === hooks.document.getState().document;
  });
  return page.evaluate(() =>
    Object.fromEntries(
      window.__manufakture!.model.getState().parts[0]!.features.map((f) => [
        f.featureId,
        {
          status: f.status,
          cached: f.cached,
          errors: f.errors,
          warnings: f.warnings.map((w) => w.message),
        },
      ]),
    ),
  );
}

async function bodyVolume(page: Page): Promise<number> {
  await page.evaluate(() => window.__manufakture!.selection.getState().clear());
  await page.waitForFunction(() => {
    const s = window.__manufakture!.measure.getState();
    return s.status === 'ready' && s.request?.targets.length === 0 && s.result?.body;
  });
  return page.evaluate(() => window.__manufakture!.measure.getState().result!.body!.volume);
}

const panel = (page: Page) => page.getByRole('complementary', { name: 'Variables' });

/** A plate, and a sketch on its top face with one point at its centre. */
async function plateWithPoint(page: Page): Promise<void> {
  const mm = (source: string) => ({ source, lengthUnit: 'mm', angleUnit: 'deg' });
  const corners: [number, number][] = [
    [0, 0],
    [PLATE.x, 0],
    [PLATE.x, PLATE.y],
    [0, PLATE.y],
  ];
  const outline = {
    id: 'sketch#1',
    kind: 'sketch',
    name: 'Sketch 1',
    suppressed: false,
    plane: { type: 'plane', origin: [0, 0, 0], normal: [0, 0, 1], xDir: [1, 0, 0] },
    entities: corners.map((start, i) => ({
      id: `e${i + 1}`,
      kind: 'line',
      construction: false,
      start,
      end: corners[(i + 1) % 4],
    })),
    constraints: [],
  };
  const plate = {
    id: 'extrude#1',
    kind: 'extrude',
    name: 'Plate',
    suppressed: false,
    profile: { sketch: 'sketch#1' },
    operation: 'new',
    extent: { type: 'blind', distance: mm(`${PLATE.t} mm`) },
    reverse: false,
  };
  const centre = {
    id: 'sketch#2',
    kind: 'sketch',
    name: 'Sketch 2',
    suppressed: false,
    plane: { type: 'plane', origin: [0, 0, PLATE.t], normal: [0, 0, 1], xDir: [1, 0, 0] },
    entities: [{ id: 'e5', kind: 'point', construction: false, position: [20, 10] }],
    constraints: [],
  };
  const done = await page.evaluate(
    (features) =>
      features.map(
        (feature) =>
          window
            .__manufakture!.document.getState()
            .execute({ type: 'addFeature', partId: 'part#1', feature }, `Add ${feature.name}`).ok,
      ),
    [outline, plate, centre],
  );
  expect(done).toEqual([true, true, true]);
  expect((await regenerated(page))['extrude#1']).toMatchObject({ status: 'ok', errors: [] });
}

const holed = (clearance: number) =>
  PLATE.x * PLATE.y * PLATE.t - Math.PI * ((M3 + clearance) / 2) ** 2 * PLATE.t;

test('fit variables drive a printed-fit hole', async ({ page }) => {
  const errors = await openEmpty(page);
  await plateWithPoint(page);

  // 1. Insert fit variables: three variables, one undo step, the placeholder defaults (no print
  // setup in this document). A second press changes nothing.
  await panel(page).getByTestId('variable-insert-fits').click();
  await expect(page.getByTestId('variable-fit_press-value')).toHaveText('0.10 mm');
  await expect(page.getByTestId('variable-fit_slip-value')).toHaveText('0.20 mm');
  await expect(page.getByTestId('variable-fit_sliding-value')).toHaveText('0.40 mm');
  await expect(page.getByTestId('variable-fits-status')).toContainText('starting points');
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toHaveAttribute(
    'title',
    'Undo Insert fit variables (Ctrl+Z)',
  );
  await panel(page).getByTestId('variable-insert-fits').click();
  await expect(page.getByTestId('variable-fits-status')).toContainText('already in the table');

  // 2. A hole on the sketch's point: M3 with a printed slip fit, so its diameter reads #fit_slip.
  await page.getByTestId('feature-sketch#2').click();
  await page
    .getByRole('toolbar', { name: 'Features' })
    .getByRole('button', { name: 'Hole', exact: true })
    .click();
  await expect(page.getByTestId('feature-dialog')).toBeVisible();
  await page.getByTestId('field-standard').selectOption('M3');
  await page.getByTestId('field-fit').selectOption('slip');
  await expect(page.getByTestId('field-diameter')).toHaveValue('3 mm + #fit_slip');
  await expect(page.getByTestId('field-diameter-note')).toHaveText('= 3.20 mm');
  await expect(page.getByTestId('field-fit-note')).toContainText('slides in by hand');
  // The completion list offers the fit variables first in a diameter field.
  const diameter = page.getByTestId('field-diameter');
  await diameter.fill('3 mm + #fit');
  await expect(page.getByTestId('field-diameter-options').locator('.expr-option-name')).toHaveText([
    '#fit_press',
    '#fit_slip',
    '#fit_sliding',
  ]);
  await diameter.press('Escape');
  await diameter.fill('3 mm + #fit_slip');
  await page.getByTestId('dialog-ok').click();
  await expect(page.getByTestId('feature-dialog')).toBeHidden();
  const first = await regenerated(page);
  expect(first['hole#1']).toMatchObject({ status: 'ok', errors: [] });
  expect(await bodyVolume(page)).toBeCloseTo(holed(0.2), 3);
  const hole = await page.evaluate(() =>
    window.__manufakture!.document.getState().document.parts[0]!.features.at(-1),
  );
  expect(hole).toMatchObject({ kind: 'hole', diameter: { source: '3 mm + #fit_slip' } });

  // 3. A looser slip fit, set in the table: the hole follows, and only the hole is rebuilt.
  await panel(page).getByRole('button', { name: 'Edit #fit_slip' }).click();
  await page.getByTestId('variable-expression').fill('0.3 mm');
  await page.getByTestId('variable-save').click();
  await expect(page.getByTestId('variable-fit_slip-value')).toHaveText('0.30 mm');
  const second = await regenerated(page);
  expect(second['hole#1']).toMatchObject({ status: 'ok', cached: false });
  expect(second['extrude#1']).toMatchObject({ status: 'ok', cached: true });
  expect(await bodyVolume(page)).toBeCloseTo(holed(0.3), 3);

  // 4. The hole remembers its printed fit when edited again.
  await page.getByTestId('feature-hole#1').dblclick();
  await expect(page.getByTestId('feature-dialog')).toBeVisible();
  await expect(page.getByTestId('field-standard')).toHaveValue('M3');
  await expect(page.getByTestId('field-fit')).toHaveValue('slip');
  await expect(page.getByTestId('field-diameter-note')).toHaveText('= 3.30 mm');
  await page.getByTestId('feature-dialog').getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByTestId('feature-dialog')).toBeHidden();

  expect(errors).toEqual([]);
});

test('the fit-test coupon template regenerates', async ({ page }) => {
  const errors = await openEmpty(page);
  await page.getByTestId('open-home').click();
  await page.getByTestId('new-coupon').click();
  // The new document opens in the editor.
  await expect(page.getByTestId('home')).toBeHidden();
  await page.waitForFunction(() =>
    window
      .__manufakture!.document.getState()
      .document.parts[0]!.features.some((f) => f.name === 'Hole plate'),
  );
  const statuses = await regenerated(page);
  const failed = Object.entries(statuses).filter(([, s]) => s.status !== 'ok');
  expect(failed).toEqual([]);
  const count = await page.evaluate(
    () => window.__manufakture!.document.getState().document.parts[0]!.features.length,
  );
  expect(Object.keys(statuses)).toHaveLength(count);
  await expect(page.getByTestId('feature-hole#4')).toContainText('Hole 4: +0.15 mm');
  // The clearance labels: laid out by the text worker in the bundled font and debossed.
  await expect(page.getByTestId('feature-extrude#2')).toContainText('Labels');
  expect(statuses['sketch#3']).toMatchObject({ status: 'ok', warnings: [] });
  expect(statuses['extrude#2']).toMatchObject({ status: 'ok', warnings: [] });
  expect(errors).toEqual([]);
});
