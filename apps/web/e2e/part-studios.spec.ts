import { expect, test, type Page } from '@playwright/test';
import { exportAs, openEmpty, regenerated } from './bracket';
import { settle } from './helpers';
import { newSketch, rectangle } from './sketch-helpers';

// Several part studios in one document (T2.1e): a second part studio gets its own box, the
// viewport shows only the active tab's bodies, undo on one tab switches to the tab it changes,
// and a reload brings back both part studios and the active tab. Reference imports, whose
// feature ids repeat across part studios, stay apart.

/** Sketch a rectangle on Top and extrude it: a `w` x `d` x `h` box in the active part studio. */
async function box(page: Page, w: number, d: number, h: number): Promise<void> {
  await newSketch(page, 'Top (XY)');
  await rectangle(page, [0, 0], [w, d]);
  await page.getByRole('button', { name: 'Finish sketch' }).click();
  await page.getByTestId('feature-sketch#1').click();
  await page
    .getByRole('toolbar', { name: 'Features' })
    .getByRole('button', { name: 'Extrude' })
    .click();
  await page.getByTestId('field-distance').fill(String(h));
  await page.getByTestId('dialog-ok').click();
  await expect(page.getByTestId('feature-dialog')).toBeHidden();
}

/** Bodies the viewport shows, once the model has caught up with the document. */
async function shownBodies(page: Page): Promise<number> {
  await regenerated(page);
  await settle(page);
  return page.evaluate(() => window.__manufakture!.viewport.info().bodies.length);
}

/** The measured volume of the shown body, or null while measuring (nothing selected). */
function volume(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const s = window.__manufakture!.measure.getState();
    return s.status === 'ready' && s.request?.targets.length === 0
      ? (s.result?.body?.volume ?? null)
      : null;
  });
}

const active = (page: Page) =>
  page.evaluate(() => window.__manufakture!.document.getState().activePartId);
const partParam = (page: Page) => new URL(page.url()).searchParams.get('part');
const tab = (page: Page, id: string) => page.getByTestId(`part-tab-${id}`);

test('part studios: a box in a second tab, switching, undo across tabs, reload', async ({
  page,
}) => {
  test.setTimeout(240_000);
  const errors = await openEmpty(page);

  // Part 1: a 40 x 25 x 15 box.
  await box(page, 40, 25, 15);
  expect(await shownBodies(page)).toBe(1);
  await expect.poll(() => volume(page), { timeout: 30_000 }).toBeCloseTo(40 * 25 * 15, 0);

  // A second part studio: active, empty, and the first part's box is not shown.
  await page.getByTestId('part-add').click();
  await expect(tab(page, 'part#2')).toHaveAttribute('aria-selected', 'true');
  expect(await active(page)).toBe('part#2');
  await expect(page.getByTestId('empty-hint')).toBeVisible();
  expect(await shownBodies(page)).toBe(0);

  // Its own box, with its own feature ids.
  await box(page, 20, 20, 10);
  expect(await shownBodies(page)).toBe(1);
  await expect.poll(() => volume(page), { timeout: 30_000 }).toBeCloseTo(20 * 20 * 10, 0);
  const parts = await page.evaluate(() =>
    window.__manufakture!.document.getState().document.parts.map((p) => ({
      id: p.id,
      features: p.features.map((f) => f.id),
    })),
  );
  expect(parts).toEqual([
    { id: 'part#1', features: ['sketch#1', 'extrude#1'] },
    { id: 'part#2', features: ['sketch#1', 'extrude#1'] },
  ]);
  expect(partParam(page)).toBe('part#2');

  // Rename the tab.
  await tab(page, 'part#2').dblclick();
  await page.getByTestId('part-rename-input').fill('Lid');
  await page.getByTestId('part-rename-input').press('Enter');
  await expect(tab(page, 'part#2')).toHaveText('Lid');

  // Switch back: the first box again, and the URL names no tab for the first part.
  await tab(page, 'part#1').click();
  expect(await active(page)).toBe('part#1');
  expect(await shownBodies(page)).toBe(1);
  await expect.poll(() => volume(page), { timeout: 30_000 }).toBeCloseTo(40 * 25 * 15, 0);
  expect(partParam(page)).toBeNull();

  // Undo on the first tab: the rename was the last step, so undo switches to Lid.
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await active(page)).toBe('part#2');
  await expect(tab(page, 'part#2')).toHaveText('Part 2');
  // Back to the first tab, undo again: the second box's extrude goes, shown on its own tab.
  await tab(page, 'part#1').click();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await active(page)).toBe('part#2');
  await expect(tab(page, 'part#2')).toHaveAttribute('aria-selected', 'true');
  expect(await shownBodies(page)).toBe(0);
  // Redo from the first tab brings it back, on its tab.
  await tab(page, 'part#1').click();
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  expect(await active(page)).toBe('part#2');
  expect(await shownBodies(page)).toBe(1);
  await expect.poll(() => volume(page), { timeout: 30_000 }).toBeCloseTo(20 * 20 * 10, 0);

  // Reload: both part studios come back, and so does the active tab.
  await expect(page.getByTestId('save-status')).toHaveText('Saved', { timeout: 15_000 });
  const before = await page.evaluate(() => window.__manufakture!.document.getState().document);
  expect(partParam(page)).toBe('part#2');
  await page.reload();
  await page.waitForFunction(
    () => (window.__manufakture?.model?.getState().generation ?? 0) > 0,
    null,
    {
      timeout: 90_000,
    },
  );
  expect(await shownBodies(page)).toBe(1);
  expect(await page.evaluate(() => window.__manufakture!.document.getState().document)).toEqual(
    before,
  );
  expect(await active(page)).toBe('part#2');
  await expect(tab(page, 'part#2')).toHaveAttribute('aria-selected', 'true');
  await expect(tab(page, 'part#1')).toHaveText('Part 1');
  await expect.poll(() => volume(page), { timeout: 30_000 }).toBeCloseTo(20 * 20 * 10, 0);
  await tab(page, 'part#1').click();
  await expect.poll(() => volume(page), { timeout: 30_000 }).toBeCloseTo(40 * 25 * 15, 0);

  // A STEP reference import in each part studio: both are import#1 in their own part, and
  // each tab shows its own body, before and after a reload.
  const step = await exportAs(page, 'step');
  const importInto = async (partId: string) => {
    await tab(page, partId).click();
    await page.getByTestId('import-input').setInputFiles({
      name: 'ref.step',
      mimeType: 'model/step',
      buffer: Buffer.from(step.bytes),
    });
    await page.waitForFunction(
      (id) =>
        window
          .__manufakture!.document.getState()
          .document.parts.find((p) => p.id === id)!
          .features.some((f) => f.id === 'import#1'),
      partId,
      { timeout: 30_000 },
    );
  };
  const bodyIds = () =>
    page.evaluate(() => window.__manufakture!.viewport.info().bodies.map((b) => b.id));
  const showsOwnImport = async (partId: string, other: string) => {
    await tab(page, partId).click();
    await expect.poll(bodyIds, { timeout: 30_000 }).toContain(`${partId}/import#1`);
    expect(await bodyIds()).not.toContain(`${other}/import#1`);
  };
  await importInto('part#1');
  await importInto('part#2');
  await showsOwnImport('part#2', 'part#1');
  await showsOwnImport('part#1', 'part#2');
  await expect(page.getByTestId('save-status')).toHaveText('Saved', { timeout: 15_000 });
  await page.reload();
  await showsOwnImport('part#1', 'part#2');
  await showsOwnImport('part#2', 'part#1');

  // Duplicate the first part studio: the copy is active and shows its box and its own import.
  await tab(page, 'part#1').click();
  await page.getByTestId('part-duplicate').click();
  expect(await active(page)).toBe('part#3');
  await expect(tab(page, 'part#3')).toHaveText('Part 1 copy');
  await expect.poll(bodyIds, { timeout: 30_000 }).toContain('part#3/import#1');
  expect(await bodyIds()).not.toContain('part#1/import#1');
  expect(await shownBodies(page)).toBe(2);

  expect(errors).toEqual([]);
});
