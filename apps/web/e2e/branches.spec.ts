import { expect, test, type Page } from '@playwright/test';
import { bracketVolume, buildBracket, editVariable, openEmpty, regenerated } from './bracket';

// Branches with the real regen worker and the browser's storage: the M1 bracket at 6 mm is
// named as a version, made 8 mm on main, then a branch is made from "6 mm" in the history viewer
// and made 10 mm there. Switching back to main shows 8 mm, and a reload of each URL opens that
// branch again, as it was left.

const volumeText = (t: number) => `${bracketVolume(t).toFixed(2)} mm³`;

/** The body volume the Measure panel shows (nothing selected: the whole body). */
async function shownVolume(page: Page, t: number) {
  await page.evaluate(() => window.__manufakture!.selection.getState().clear());
  await expect(
    page.getByRole('complementary', { name: 'Measure' }).getByTestId('measure-value-body.volume'),
  ).toHaveText(volumeText(t), { timeout: 90_000 });
}

async function saved(page: Page) {
  await expect(page.getByTestId('save-status')).toHaveText('Saved', { timeout: 15_000 });
}

async function thickness(page: Page, t: number) {
  await expect(page.getByTestId('variable-thickness-value')).toHaveText(`${t.toFixed(2)} mm`, {
    timeout: 90_000,
  });
  await regenerated(page);
  await shownVolume(page, t);
}

test('a branch from a version is worked on, switched away from, and both reload', async ({
  page,
}) => {
  test.setTimeout(400_000);
  const errors = await openEmpty(page);
  await buildBracket(page, 6);
  await shownVolume(page, 6);
  await saved(page);

  // Name the 6 mm state, then make main 8 mm.
  await page.getByTestId('open-history').click();
  const history = page.getByRole('complementary', { name: 'History' });
  await history.getByTestId('version-create').click();
  await history.getByTestId('version-name').fill('6 mm');
  await history.getByTestId('version-save').click();
  await expect(history.getByTestId('version-6 mm')).toBeVisible();
  await editVariable(page, 'thickness', '8');
  await thickness(page, 8);
  await saved(page);
  const branchSelect = page.getByTestId('branch-select');
  await expect(branchSelect.locator('option')).toHaveText(['Main']);

  // Branch from "6 mm" in the viewer: the branch opens at 6 mm, with its own empty timeline.
  await history.getByRole('button', { name: 'View version 6 mm' }).click();
  const viewer = page.getByTestId('history-viewer');
  await expect(viewer.getByTestId('history-viewer-label')).toHaveText('Viewing Version "6 mm"');
  await viewer.getByTestId('history-branch').click();
  await viewer.getByTestId('branch-name').fill('Thick walls');
  await viewer.getByTestId('branch-create').click();
  await expect(viewer).toBeHidden();
  await expect(branchSelect.locator('option:checked')).toHaveText('Thick walls');
  await thickness(page, 6);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await expect(history.getByTestId('history-branch-name')).toHaveText('Thick walls');
  // Main's version is listed, tagged with its branch; the timeline is the branch's own.
  await expect(history.getByTestId('version-branch-6 mm')).toHaveText('Main');
  await expect(history.getByTestId('revision-2')).toHaveCount(0);
  const branchUrl = page.url();
  expect(new URL(branchUrl).searchParams.get('branch')).toBeTruthy();

  // 10 mm on the branch.
  await editVariable(page, 'thickness', '10');
  await thickness(page, 10);
  await saved(page);
  await expect(history.getByTestId('revision-2')).toBeVisible();

  // Back to main: 8 mm, its own history; the URL names no branch.
  await branchSelect.selectOption({ label: 'Main' });
  await thickness(page, 8);
  await expect(history.getByTestId('version-branch-6 mm')).toHaveCount(0);
  await expect(history.getByTestId('history-branch-name')).toHaveCount(0);
  expect(new URL(page.url()).searchParams.get('branch')).toBeNull();
  const mainUrl = page.url();

  // Reload main: 8 mm.
  await page.reload();
  await thickness(page, 8);
  await expect(branchSelect.locator('option:checked')).toHaveText('Main');
  await expect(branchSelect.locator('option')).toHaveText(['Main', 'Thick walls']);

  // Reload the branch from its URL: 10 mm, and main is still 8 mm after switching.
  await page.goto(branchUrl);
  await thickness(page, 10);
  await expect(branchSelect.locator('option:checked')).toHaveText('Thick walls');
  await branchSelect.selectOption({ label: 'Main' });
  await thickness(page, 8);
  expect(page.url()).toBe(mainUrl);
  expect(errors).toEqual([]);
});
