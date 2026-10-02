import { expect, test } from '@playwright/test';
import { BRACKET, buildBracket, openEmpty, regenerated, view } from './bracket';
import { clickWorld } from './helpers';
import { saved } from './m2-fixtures';

// The Manufacture workspace (M5 plan, T5.3a), through the UI and the real regen and CAM workers,
// on the M1 bracket built as docs/m1-acceptance.md walks through it:
// - a 1/4" flat end mill copied from the built-in library into the document;
// - a setup on the default machine (the Shapeoko 5 Pro 4x4, with its default post), cut in
//   plywood;
// - a profile operation on the top face of the upright, picked in the view, 3 mm deep: the
//   geometry stage resolves it (`ok`), and Generate makes its toolpath in the CAM worker;
// - a reload keeps the setup and the operation, which resolves again.

test('manufacture: a setup and a profile operation on the M1 bracket', async ({ page }) => {
  test.setTimeout(300_000);
  const errors = await openEmpty(page);
  await buildBracket(page);
  const t = 6;

  // 1. The workspace replaces the feature tree; the modelling tools step aside.
  await page.getByTestId('open-cam').click();
  await expect(page.getByTestId('cam-tree')).toBeVisible();
  await expect(page.getByTestId('feature-tree')).toBeHidden();
  await expect(page.getByTestId('cam-empty')).toContainText('Shapeoko 5 Pro 4x4');

  // 2. A tool from the built-in library.
  await page.getByTestId('cam-open-tools').click();
  await expect(page.getByTestId('cam-tools-dialog')).toBeVisible();
  await page.getByTestId('cam-use-c3d-201').click();
  await expect(page.getByTestId('cam-tool-tool#1')).toContainText('#201');
  await page.getByTestId('cam-tools-close').click();

  // 3. A setup of the bracket on the default machine, in plywood (for the tool's feed presets).
  await page.getByTestId('cam-add-setup').click();
  await expect(page.getByTestId('cam-setup-machine')).toHaveValue('shapeoko-5-pro-4x4');
  await expect(page.getByTestId('cam-setup-post')).not.toHaveValue('');
  await page.getByTestId('cam-setup-material').selectOption('plywood');
  await expect(page.getByTestId('cam-setup-material')).toHaveValue('plywood');

  // 4. A profile on the upright's top face (x 0 to t, z = height), picked in the view.
  await page.getByTestId('cam-new-profile').click();
  await expect(page.getByTestId('cam-op-dialog')).toBeVisible();
  await view(page, 'iso');
  await clickWorld(page, [t / 2, 0, BRACKET.height]);
  await expect(page.getByTestId('cam-source-0')).toContainText('Face extrude#1:');
  await page.getByTestId('cam-field-depthMode').selectOption('blind');
  await page.getByTestId('cam-field-depth').fill('3');
  await page.getByTestId('cam-op-ok').click();
  await expect(page.getByTestId('cam-op-dialog')).toBeHidden();

  // 5. The geometry stage resolved it: its sources and numbers are `ok`.
  const status = page.getByTestId('cam-op-status-profile#1');
  await expect(status).toHaveAttribute('data-state', 'ok', { timeout: 60_000 });
  await expect(status).toHaveText('ok');

  // 6. Generate: the CAM worker makes the toolpath.
  await page.getByTestId('cam-generate').click();
  await expect(page.getByTestId('cam-generate-message')).toHaveText('Generated 1 of 1 operation.', {
    timeout: 60_000,
  });
  await expect(status).toHaveAttribute('data-toolpath', 'generated');
  await expect(status).toHaveAttribute('data-stale', 'false');

  // 7. Undo and redo the operation.
  await page.getByRole('button', { name: /^Undo/ }).click();
  await expect(page.getByTestId('cam-op-profile#1')).toHaveCount(0);
  await page.getByRole('button', { name: /^Redo/ }).click();
  await expect(page.getByTestId('cam-op-profile#1')).toBeVisible();

  // 8. A reload keeps the setup and its operation, which resolves again.
  await saved(page);
  await page.reload();
  await expect(page.getByTestId('document-name')).toBeVisible({ timeout: 90_000 });
  await regenerated(page);
  await page.getByTestId('open-cam').click();
  await expect(page.getByTestId('cam-setup-select').locator('option')).toHaveText(['Setup 1']);
  await expect(page.getByTestId('cam-setup-machine')).toHaveValue('shapeoko-5-pro-4x4');
  await expect(page.getByTestId('cam-op-status-profile#1')).toHaveAttribute('data-state', 'ok', {
    timeout: 60_000,
  });

  // 9. Closed, the modelling UI is back.
  await page.getByTestId('open-cam').click();
  await expect(page.getByTestId('feature-tree')).toBeVisible();
  expect(errors).toEqual([]);
});
