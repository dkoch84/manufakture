import { expect, test, type Page } from '@playwright/test';
import { buildBracket, openEmpty, view } from './bracket';
import { clickWorld } from './helpers';

// 3D operations from the Manufacture workspace (M5 plan, T5.5b), through the UI and the real regen
// and CAM workers, on the M1 bracket, whose inside corner is a 4 mm fillet:
// - a parallel 3D finish over the whole part with a 1/8" ball end mill from the built-in library.
//   With nothing roughing before it the operation warns so; it generates, the preview plays it,
//   and the material-removal simulation (ball stamps, the part's mesh as the reference) reports no
//   gouge;
// - a z-level roughing with a 1/4" flat end mill, moved before the finish, which takes the warning
//   away, and a second finish bounded by the foot's top face, picked in the view; the three
//   generate together and simulate with no gouge.

type PreviewHook = {
  state(): { moveCount: number; done: number; message: string | null };
  seek(n: number): void;
};

function previewState(page: Page) {
  return page.evaluate(() =>
    (window.__manufakture as unknown as { camPreview: PreviewHook }).camPreview.state(),
  );
}

test('3D surfaces on the filleted bracket generate, preview and simulate with no gouge', async ({
  page,
}) => {
  test.setTimeout(420_000);
  const errors = await openEmpty(page);
  await buildBracket(page);

  // A ball end mill from the built-in library, and a plywood setup on the default machine.
  await page.getByTestId('open-cam').click();
  await page.getByTestId('cam-open-tools').click();
  await page.getByTestId('cam-use-c3d-101').click();
  await expect(page.getByTestId('cam-tool-tool#1')).toContainText('#101');
  await page.getByTestId('cam-tools-close').click();
  await page.getByTestId('cam-add-setup').click();
  await page.getByTestId('cam-setup-material').selectOption('plywood');
  await expect(page.getByTestId('cam-setup-material')).toHaveValue('plywood');

  // A parallel finish over the whole part (no boundary picked), 1 mm between lines.
  await page.getByTestId('cam-new-surface3d').click();
  const dialog = page.getByTestId('cam-op-dialog');
  await expect(dialog).toHaveAttribute('data-kind', 'surface3d');
  await expect(page.getByTestId('cam-op-tool')).toHaveValue('tool#1');
  await expect(page.getByTestId('cam-field-strategy')).toHaveValue('parallel');
  await page.getByTestId('cam-field-lineStepover').fill('1 mm');
  await page.getByTestId('cam-op-ok').click();
  await expect(dialog).toBeHidden();
  const id = 'surface3d#1';
  await expect(page.getByTestId(`cam-op-status-${id}`)).toHaveAttribute('data-state', 'ok', {
    timeout: 60_000,
  });
  // Nothing roughs before it: the workspace says so on its row.
  await expect(page.getByTestId(`cam-op-messages-${id}`)).toContainText('Nothing roughs');

  // Generate: the toolpath comes back and the preview plays it.
  await page.getByTestId('cam-generate').click();
  await expect(page.getByTestId('cam-generate-message')).toHaveText('Generated 1 of 1 operation.', {
    timeout: 180_000,
  });
  await expect(page.getByTestId(`cam-op-status-${id}`)).toHaveAttribute(
    'data-toolpath',
    'generated',
  );
  await expect(page.getByTestId('cam-preview-stats')).toBeVisible();
  await expect(page.getByTestId(`cam-preview-op-${id}`)).toContainText('mm');
  const whole = await previewState(page);
  expect(whole.message).toBeNull();
  expect(whole.moveCount).toBeGreaterThan(100);
  expect(whole.done).toBe(whole.moveCount);

  // Simulate the whole program with the ball's stamp against the part's mesh: no gouge, and no
  // rapid through material.
  await page.getByTestId('cam-sim-toggle').check();
  await expect(page.getByTestId('cam-sim-status')).toContainText(
    `Simulated to move ${whole.moveCount} of ${whole.moveCount}`,
    { timeout: 180_000 },
  );
  await expect(page.getByTestId('cam-sim-gouges')).toContainText('No gouge');
  await expect(page.getByTestId('cam-sim-collisions')).toHaveText(
    'No rapid runs through material.',
  );
  await expect(page.getByTestId('cam-sim-error')).toHaveCount(0);
  await page.getByTestId('cam-sim-toggle').uncheck();

  // A z-level roughing with a flat end mill, then moved before the finish: no more warning.
  await page.getByTestId('cam-open-tools').click();
  await page.getByTestId('cam-use-c3d-201').click();
  await expect(page.getByTestId('cam-tool-tool#2')).toContainText('#201');
  await page.getByTestId('cam-tools-close').click();
  await page.getByTestId('cam-new-surface3d').click();
  await page.getByTestId('cam-field-strategy').selectOption('zlevel');
  await page.getByTestId('cam-op-tool').selectOption('tool#2');
  await page.getByTestId('cam-op-name').fill('Rough');
  await page.getByTestId('cam-field-lineStepover').fill('2.5 mm');
  await page.getByTestId('cam-field-allowance').fill('0.3 mm');
  await page.getByTestId('cam-field-stepdown').fill('6 mm');
  await page.getByTestId('cam-op-ok').click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId(`cam-op-${id}`)).toContainText('Nothing roughs');
  await page.getByTestId('cam-up-surface3d#2').click();
  await expect(page.getByTestId(`cam-op-${id}`)).not.toContainText('Nothing roughs');

  // A finish bounded by the foot's top face, picked in the view.
  await page.getByTestId('cam-new-surface3d').click();
  await page.getByTestId('cam-op-name').fill('Foot');
  await view(page, 'iso');
  await clickWorld(page, [32.5, 8, 6]);
  await expect(page.getByTestId('cam-source-0')).toContainText('Face extrude#1');
  await page.getByTestId('cam-field-lineStepover').fill('0.8 mm');
  await page.getByTestId('cam-op-ok').click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId('cam-op-status-surface3d#3')).toHaveAttribute('data-state', 'ok', {
    timeout: 60_000,
  });

  // The three generate, and the program (rough, finish, bounded finish) simulates clean.
  await page.getByTestId('cam-generate').click();
  await expect(page.getByTestId('cam-generate-message')).toHaveText(
    'Generated 3 of 3 operations.',
    { timeout: 240_000 },
  );
  await expect(page.getByTestId('cam-preview-op-surface3d#3')).toContainText('mm');
  const all = await previewState(page);
  expect(all.message).toBeNull();
  expect(all.moveCount).toBeGreaterThan(whole.moveCount);
  await page.getByTestId('cam-sim-toggle').check();
  await expect(page.getByTestId('cam-sim-status')).toContainText(
    `Simulated to move ${all.moveCount} of ${all.moveCount}`,
    { timeout: 240_000 },
  );
  await expect(page.getByTestId('cam-sim-gouges')).toContainText('No gouge');
  await expect(page.getByTestId('cam-sim-collisions')).toHaveText(
    'No rapid runs through material.',
  );
  expect(errors).toEqual([]);
});
