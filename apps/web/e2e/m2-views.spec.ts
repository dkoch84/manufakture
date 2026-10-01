import { expect, test, type Page } from '@playwright/test';
import { openEmpty, view } from './bracket';
import { buildWallShelf } from './m2-fixtures';

// Viewport screenshots of the M2 acceptance assembly (the wall shelf, its two supports and the
// drawer, at 600 mm) in the iso, front and right views, against the baselines in e2e/__screenshots__/.
// As for M1 (m1-views.spec.ts): SwiftShader renders, the comparison allows a small share of
// differing pixels (playwright.config.ts), the view cube is masked, and the canvas is pinned to a
// fixed size and place so the machine's fonts cannot change its layout.
//
// After an intended change to how the viewport draws, refresh the baselines with
//   pnpm --filter @manufakture/web e2e m2-views --update-snapshots
// and commit the new PNGs. CI never writes baselines (updateSnapshots: 'none').

/** A plain element over the view cube (top right of the canvas), for `mask`. */
async function cubeMask(page: Page) {
  await page.evaluate(() => {
    const canvas = document.querySelector('[data-testid="viewport-canvas"]')!;
    const r = canvas.getBoundingClientRect();
    const size = 110 + 2 * 12; // viewCube.ts: sizePx and marginPx
    let mask = document.getElementById('e2e-cube-mask');
    if (!mask) {
      mask = document.createElement('div');
      mask.id = 'e2e-cube-mask';
      document.body.append(mask);
    }
    Object.assign(mask.style, {
      position: 'fixed',
      left: `${r.right - size}px`,
      top: `${r.top}px`,
      width: `${size}px`,
      height: `${size}px`,
      pointerEvents: 'none',
    });
  });
  return page.locator('#e2e-cube-mask');
}

test('the assembled wall shelf in the iso, front and right views', async ({ page }) => {
  test.setTimeout(240_000);
  const errors = await openEmpty(page);
  await buildWallShelf(page);
  await page.evaluate(() => window.__manufakture!.selection.getState().clear());
  await page.addStyleTag({
    content:
      '[data-testid="viewport-canvas"] { position: fixed !important; left: 0 !important; ' +
      'top: 0 !important; width: 760px !important; height: 540px !important; }',
  });
  // Off the canvas (now at the top left), so nothing is hovered.
  await page.mouse.move(1270, 790);
  const canvas = page.getByTestId('viewport-canvas');
  await expect
    .poll(() => canvas.evaluate((c: HTMLCanvasElement) => [c.width, c.height].join('x')))
    .toBe(await page.evaluate(() => `${760 * devicePixelRatio}x${540 * devicePixelRatio}`));
  const mask = await cubeMask(page);
  for (const v of ['iso', 'front', 'right'] as const) {
    await view(page, v);
    await expect(canvas).toHaveScreenshot(`wall-shelf-${v}.png`, { mask: [mask] });
  }
  expect(errors).toEqual([]);
});
