import { expect, test } from '@playwright/test';
import { clickWorld, openScene, selection } from './helpers';

// The real regen worker: libcascade (42 MB of wasm) and the regen engine in
// one worker. The default page starts with an empty document; the demo scene
// opens the demo part as a document (a filleted 60 x 40 x 20 block with a
// hole), which regen builds with every face named by the naming layer.

test('loads the kernel with a progress splash, then shows an empty document with a hint', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.getByTestId('splash')).toBeVisible();
  await expect(page.getByTestId('empty-hint')).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId('empty-hint')).toContainText('New sketch');
  await expect
    .poll(() => page.evaluate(() => window.__manufakture!.model.getState().generation))
    .toBeGreaterThan(0);
  const info = await page.evaluate(() => window.__manufakture!.viewport.info());
  expect(info.bodies).toHaveLength(0);
  expect(errors).toEqual([]);
});

test('regenerates the demo document and picks a face by its real name', async ({ page }) => {
  await openScene(page, '?scene=demo', 90_000);
  const info = await page.evaluate(() => window.__manufakture!.viewport.info());
  expect(info.bodies.map((b) => b.id)).toEqual(['part#1']);
  expect(info.bodies[0]!.faces).toBeGreaterThan(10);
  expect(info.bodies[0]!.triangles).toBeGreaterThan(100);

  // A point on the flat top face, clear of the hole and the fillets.
  await clickWorld(page, [20, 10, 20]);
  expect(await selection(page)).toEqual(['face extrude#1:cap:end']);
  const statuses = await page.evaluate(() =>
    window.__manufakture!.model.getState().parts[0]!.features.map((f) => f.status),
  );
  expect(statuses).toEqual(['ok', 'ok', 'ok', 'ok', 'ok']);
});
