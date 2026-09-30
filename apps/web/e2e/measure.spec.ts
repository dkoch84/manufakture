import { expect, test, type Page } from '@playwright/test';
import { clickWorld, openScene, settle } from './helpers';

// The measure tool on the demo part: a 60 x 40 x 20 mm block from
// (-30, -20, 0) to (30, 20, 20), every edge filleted at 3 mm, with a through
// hole of radius 8 on the z axis. Values come from the exact B-rep in the
// kernel worker, so they are checked against hand-computed numbers.

/** Wait until the measure tool has measured exactly `targets` selected items. */
async function measured(page: Page, targets: number): Promise<void> {
  await page.waitForFunction((n) => {
    const s = window.__manufakture!.measure.getState();
    return s.status === 'ready' && s.request?.targets.length === n;
  }, targets);
}

const value = (page: Page, key: string) => page.getByTestId(`measure-value-${key}`);

test.describe('measuring the demo part', () => {
  test.beforeEach(async ({ page }) => {
    await openScene(page, '?scene=demo', 90_000);
  });

  test('a face shows its area, and the body its volume', async ({ page }) => {
    await measured(page, 0);
    // Without a selection: the body. Its bounding box is the block.
    await expect(value(page, 'body.size')).toHaveText('60.00 mm x 40.00 mm x 20.00 mm');

    // The flat top: 54 x 34 inside the fillets, less the hole: 1836 - 64 pi = 1634.94 mm2.
    await clickWorld(page, [20, 10, 20]);
    await measured(page, 1);
    await expect(page.getByTestId('measure-item1').locator('h3')).toHaveText('Face 1 (plane)');
    await expect(value(page, 'item1.area')).toHaveText('1634.94 mm²');
  });

  test('two faces show their distance, with the witness line drawn', async ({ page }) => {
    await clickWorld(page, [20, 10, 20]);
    await measured(page, 1);
    // The bottom face, seen from below.
    await page.evaluate(() => window.__manufakture!.viewport.setStandardView('bottom', false));
    await settle(page);
    await clickWorld(page, [20, 10, 0], ['Shift']);
    await measured(page, 2);
    await expect(value(page, 'distance')).toHaveText('20.00 mm');
    await expect(value(page, 'distance.z')).toHaveText('20.00 mm');
    await expect(value(page, 'angle.normals')).toHaveText('180.00°');
    const distance = await page.evaluate(
      () => window.__manufakture!.measure.getState().result!.distance!,
    );
    expect(distance.from[2]).toBeCloseTo(20, 6);
    expect(distance.to[2]).toBeCloseTo(0, 6);
    await expect(page.getByTestId('measure-witness')).toBeVisible();
    await expect(page.getByTestId('measure-witness').locator('text')).toHaveText('20.00 mm');
  });

  test('the rim of the hole shows its radius and diameter', async ({ page }) => {
    // Clear of the seam vertex at +x: 60 degrees round towards the viewer.
    await clickWorld(page, [8 * Math.cos(-Math.PI / 3), 8 * Math.sin(-Math.PI / 3), 20]);
    await measured(page, 1);
    await expect(page.getByTestId('measure-item1').locator('h3')).toHaveText(/^Edge 1/);
    await expect(value(page, 'item1.radius')).toHaveText('8.00 mm');
    await expect(value(page, 'item1.diameter')).toHaveText('16.00 mm');
  });

  test('a material gives the mass, and the display units follow the document', async ({ page }) => {
    await measured(page, 0);
    await page
      .getByRole('combobox', { name: 'Material', exact: true })
      .selectOption('aluminium-6061');
    const volume = await page.evaluate(
      () => window.__manufakture!.measure.getState().result!.body!.volume,
    );
    // grams = mm3 * kg/m3 * 1e-6
    await expect(value(page, 'body.mass')).toHaveText(`${(volume * 2700e-6).toFixed(2)} g`);
    await page.evaluate(() =>
      window.__manufakture!.document.getState().execute({
        type: 'setDisplayUnits',
        units: { length: { unit: 'ft-in', denominator: 16 }, angle: { unit: 'deg' } },
      }),
    );
    // 60 mm is 2.362 in: 2-3/8" to the nearest sixteenth.
    await expect(value(page, 'body.size')).toHaveText(`2-3/8" x 1-9/16" x 13/16"`);
  });
});
