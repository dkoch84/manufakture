import { expect, test, type Page } from '@playwright/test';
import { bracketVolume, buildBracket, editVariable, openEmpty, regenerated } from './bracket';

// Version history with the real regen worker and the browser's storage: the M1 bracket at 6 mm
// is named as a version, made 8 mm, and the version is viewed read-only (rebuilt in the worker,
// measured at the 6 mm volume) without touching the open document; Back shows 8 mm again;
// Restore makes it 6 mm as one undo step, Undo makes it 8 mm again, and a reload keeps that,
// with the version and the logged restore in the history.

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

test('a version is viewed read-only, restored, and the restore undone', async ({ page }) => {
  test.setTimeout(300_000);
  const errors = await openEmpty(page);
  await buildBracket(page, 6);
  await shownVolume(page, 6);
  await saved(page);

  // Name the 6 mm state.
  await page.getByTestId('open-history').click();
  const history = page.getByRole('complementary', { name: 'History' });
  await history.getByTestId('version-create').click();
  await history.getByTestId('version-name').fill('6 mm');
  await history.getByTestId('version-description').fill('Before the walls grew');
  await history.getByTestId('version-save').click();
  await expect(history.getByTestId('version-6 mm')).toBeVisible();

  // Make it 8 mm.
  await editVariable(page, 'thickness', '8');
  await regenerated(page);
  await shownVolume(page, 8);
  await saved(page);
  const eight = await page.evaluate(() => window.__manufakture!.document.getState().document);

  // View "6 mm": rebuilt and measured at 6 mm, read-only, the open document untouched.
  await history.getByRole('button', { name: 'View version 6 mm' }).click();
  const viewer = page.getByTestId('history-viewer');
  await expect(viewer.getByTestId('history-viewer-label')).toHaveText('Viewing Version "6 mm"');
  await expect(viewer.getByTestId('history-compare')).toContainText(
    'Variables that differ: #thickness.',
  );
  await shownVolume(page, 6);
  await expect(page.getByRole('toolbar', { name: 'Features' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await expect(page.getByTestId('rollback-bar')).toHaveAttribute('aria-disabled', 'true');
  await expect(page.getByRole('complementary', { name: 'Variables' })).toHaveCount(0);
  // Ctrl+Z does nothing while viewing.
  await page.keyboard.press('Control+z');
  expect(await page.evaluate(() => window.__manufakture!.document.getState().document)).toEqual(
    eight,
  );

  // Back: the 8 mm bracket again, editable.
  await viewer.getByTestId('history-back').click();
  await expect(viewer).toBeHidden();
  await expect(page.getByRole('toolbar', { name: 'Features' })).toBeVisible();
  await regenerated(page);
  await shownVolume(page, 8);

  // Restore "6 mm": one undo step, built like any change.
  await history.getByRole('button', { name: 'View version 6 mm' }).click();
  await shownVolume(page, 6);
  await viewer.getByTestId('history-restore').click();
  await expect(viewer).toBeHidden();
  await expect(page.getByTestId('variable-thickness-value')).toHaveText('6.00 mm');
  await regenerated(page);
  await shownVolume(page, 6);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toHaveAttribute(
    'title',
    'Undo Restore Version "6 mm" (Ctrl+Z)',
  );

  // Undo the restore: 8 mm again.
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByTestId('variable-thickness-value')).toHaveText('8.00 mm');
  await regenerated(page);
  await shownVolume(page, 8);
  await saved(page);
  expect(await page.evaluate(() => window.__manufakture!.document.getState().document)).toEqual(
    eight,
  );

  // Reload: 8 mm, the version still there, the restore and its undo on the timeline.
  await page.reload();
  await expect(page.getByTestId('variable-thickness-value')).toHaveText('8.00 mm', {
    timeout: 90_000,
  });
  await regenerated(page);
  await shownVolume(page, 8);
  await page.getByTestId('open-history').click();
  await expect(history.getByTestId('version-6 mm')).toContainText('Before the walls grew');
  await expect(history).toContainText('Undo Restore Version "6 mm"');
  expect(errors).toEqual([]);
});
