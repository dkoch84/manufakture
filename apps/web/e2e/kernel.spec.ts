import { expect, test } from '@playwright/test';
import { clickWorld, openScene, selection } from './helpers';

// The default page: the real kernel worker loads libcascade (42 MB of wasm),
// builds the demo part (a filleted 60 x 40 x 20 block with a hole) and the
// viewport renders it. Names are placeholders until the naming layer (#931).

test('loads the kernel with a progress splash and picks a face of the demo part', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.getByTestId('splash')).toBeVisible();
  await openScene(page, '', 90_000);
  const info = await page.evaluate(() => window.__manufakture!.viewport.info());
  expect(info.bodies).toHaveLength(1);
  expect(info.bodies[0]!.faces).toBeGreaterThan(10);
  expect(info.bodies[0]!.triangles).toBeGreaterThan(100);

  // A point on the flat top face, clear of the hole and the fillets.
  await clickWorld(page, [20, 10, 20]);
  const picked = await selection(page);
  expect(picked).toHaveLength(1);
  expect(picked[0]).toMatch(/^face placeholder:face:\d+$/);
  expect(errors).toEqual([]);
});
