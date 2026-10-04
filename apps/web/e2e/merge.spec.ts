import { expect, test, type Page } from '@playwright/test';
import { clickWorld } from './helpers';
import {
  BRACKET,
  bracketVolume,
  buildBracket,
  editVariable,
  ok,
  openEmpty,
  openTool,
  regenerated,
  view,
} from './bracket';

// Merging a branch by replay, with the real regen worker and the browser's storage (T7.1f): the
// M1 bracket without its fillet is named "6 mm", main is made 8 mm, and the branch "10 mm" from
// that version is made 10 mm and gets the fillet. Merging "10 mm" into main previews both
// changes and that main's own thickness is replaced whole (last writer wins per object), then
// adds the fillet and the thickness to main as one step that undo takes back and redo brings
// again. The merge is saved as one revision and survives a reload. No server takes part.

const volumeText = (t: number, stage: 'holes' | 'fillet') =>
  `${bracketVolume(t, stage).toFixed(2)} mm³`;

async function shownVolume(page: Page, t: number, stage: 'holes' | 'fillet') {
  await page.evaluate(() => window.__manufakture!.selection.getState().clear());
  await expect(
    page.getByRole('complementary', { name: 'Measure' }).getByTestId('measure-value-body.volume'),
  ).toHaveText(volumeText(t, stage), { timeout: 90_000 });
}

async function saved(page: Page) {
  await expect(page.getByTestId('save-status')).toHaveText('Saved', { timeout: 15_000 });
}

async function bracket(page: Page, t: number, stage: 'holes' | 'fillet') {
  await expect(page.getByTestId('variable-thickness-value')).toHaveText(`${t.toFixed(2)} mm`, {
    timeout: 90_000,
  });
  const statuses = await regenerated(page);
  expect(Object.values(statuses).map((s) => s.status)).toEqual(
    Array(stage === 'fillet' ? 5 : 4).fill('ok'),
  );
  await shownVolume(page, t, stage);
}

test('a branch merged into main adds its later fillet, as one undoable step', async ({ page }) => {
  test.setTimeout(500_000);
  const errors = await openEmpty(page);
  await buildBracket(page, 6);
  // The fillet comes later, on the branch: take it back here.
  const undo = page.getByRole('button', { name: 'Undo', exact: true });
  await undo.click();
  await bracket(page, 6, 'holes');
  await saved(page);

  // Name the 6 mm state, then make main 8 mm.
  await page.getByTestId('open-history').click();
  const history = page.getByRole('complementary', { name: 'History' });
  await history.getByTestId('version-create').click();
  await history.getByTestId('version-name').fill('6 mm');
  await history.getByTestId('version-save').click();
  await expect(history.getByTestId('version-6 mm')).toBeVisible();
  await editVariable(page, 'thickness', '8');
  await bracket(page, 8, 'holes');
  await saved(page);
  // With one branch there is nothing to merge.
  await expect(history.getByTestId('merge-branch')).toHaveCount(0);

  // The branch "10 mm" from "6 mm": 10 mm, then the fillet on the inside corner.
  await history.getByRole('button', { name: 'View version 6 mm' }).click();
  const viewer = page.getByTestId('history-viewer');
  await viewer.getByTestId('history-branch').click();
  await viewer.getByTestId('branch-name').fill('10 mm');
  await viewer.getByTestId('branch-create').click();
  await expect(viewer).toBeHidden();
  const branchSelect = page.getByTestId('branch-select');
  await expect(branchSelect.locator('option:checked')).toHaveText('10 mm');
  await editVariable(page, 'thickness', '10');
  await bracket(page, 10, 'holes');
  await view(page, 'iso');
  await openTool(page, 'Fillet');
  await clickWorld(page, [10, -BRACKET.width / 4, 10]);
  await expect(page.getByTestId('ref-edges').locator('li')).toHaveCount(1);
  await page.getByTestId('field-radius').fill(String(BRACKET.fillet));
  await ok(page);
  await bracket(page, 10, 'fillet');
  await saved(page);

  // Back on main (8 mm, no fillet), preview merging "10 mm" into it.
  await branchSelect.selectOption({ label: 'Main' });
  await bracket(page, 8, 'holes');
  const merge = history.getByTestId('merge-branch');
  await expect(merge.getByTestId('merge-from').locator('option:checked')).toHaveText('10 mm');
  await merge.getByTestId('merge-preview').click();
  const applied = merge.getByTestId('merge-applied').locator('li');
  await expect(applied).toHaveCount(2);
  await expect(applied.nth(1)).toContainText('Fillet');
  await expect(merge.getByTestId('merge-dropped')).toHaveCount(0);
  // Main's own 8 mm is replaced whole by the branch's 10 mm, and the preview says so.
  await expect(merge.getByTestId('merge-replaced')).toHaveText('the variable #thickness');
  await expect(merge.getByTestId('merge-plan')).toContainText('not per field');
  // A preview changes nothing.
  await bracket(page, 8, 'holes');

  await merge.getByTestId('merge-apply').click();
  await expect(merge.getByTestId('merge-status')).toHaveText(
    'Merged 10 mm into Main. Undo takes it back.',
  );
  await bracket(page, 10, 'fillet');
  await expect(branchSelect.locator('option:checked')).toHaveText('Main');

  // One step: undo takes the whole merge back, redo brings it again.
  await expect(undo).toHaveAttribute('title', /Merge "10 mm"/);
  await undo.click();
  await bracket(page, 8, 'holes');
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await bracket(page, 10, 'fillet');
  await saved(page);

  // Saved on main as a revision labelled as the merge; the branch is as it was.
  await expect(
    history.locator('.history-labels').filter({ hasText: 'Merge "10 mm"' }),
  ).not.toHaveCount(0);
  await page.reload();
  await bracket(page, 10, 'fillet');
  await expect(branchSelect.locator('option:checked')).toHaveText('Main');
  await branchSelect.selectOption({ label: '10 mm' });
  await bracket(page, 10, 'fillet');
  expect(errors).toEqual([]);
});
