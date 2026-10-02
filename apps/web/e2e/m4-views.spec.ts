import { expect, test, type Page } from '@playwright/test';
import { openEmpty, view } from './bracket';
import { settle } from './helpers';
import { execute, solved } from './m2-fixtures';
import { ASSEMBLY, assemblyCommands, buildBookshelf, explodeCommand } from './m4-fixtures';

// Viewport screenshots of the M4 acceptance bookshelf (m4-fixtures.ts, 30" wide) against the
// baselines in e2e/__screenshots__/: the part studio in the iso and front views, and the
// per-board assembly exploded in its five steps. As for M1 to M3 (m3-views.spec.ts): SwiftShader
// renders, the comparison allows a small share of differing pixels (playwright.config.ts), the
// view cube is masked, and the canvas is pinned to a fixed size and place so the machine's fonts
// cannot change its layout.
//
// After an intended change to how the viewport draws, refresh the baselines with
//   pnpm --filter @manufakture/web e2e m4-views --update-snapshots
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

/** Pin the canvas to 760 x 540 at the top left; returns a function that takes the pin off. */
async function pin(page: Page): Promise<() => Promise<void>> {
  const style = await page.addStyleTag({
    content:
      '[data-testid="viewport-canvas"] { position: fixed !important; left: 0 !important; ' +
      'top: 0 !important; width: 760px !important; height: 540px !important; } ' +
      // Layers drawn over the canvas where it was: hidden with it pinned.
      '[data-testid="committed-sketches"], [data-testid="explode-overlay"] ' +
      '{ display: none !important; }',
  });
  // Off the canvas (now at the top left), so nothing is hovered.
  await page.mouse.move(1270, 790);
  const canvas = page.getByTestId('viewport-canvas');
  await expect
    .poll(() => canvas.evaluate((c: HTMLCanvasElement) => [c.width, c.height].join('x')))
    .toBe(await page.evaluate(() => `${760 * devicePixelRatio}x${540 * devicePixelRatio}`));
  return async () => {
    await style.evaluate((e) => (e as Element).remove());
    await page.evaluate(() => document.getElementById('e2e-cube-mask')?.remove());
    await settle(page);
  };
}

test('the bookshelf in the iso and front views, and exploded', async ({ page }) => {
  test.setTimeout(240_000);
  const errors = await openEmpty(page);
  await buildBookshelf(page);
  await page.evaluate(() => window.__manufakture!.selection.getState().clear());
  const canvas = page.getByTestId('viewport-canvas');

  let unpin = await pin(page);
  let mask = await cubeMask(page);
  for (const v of ['iso', 'front'] as const) {
    await view(page, v);
    await expect(canvas).toHaveScreenshot(`bookshelf-${v}.png`, { mask: [mask] });
  }
  await unpin();

  await execute(
    page,
    { type: 'batch', commands: [...assemblyCommands(), explodeCommand()] },
    'Assemble and explode',
  );
  await page.getByTestId(`assembly-tab-${ASSEMBLY}`).click();
  await solved(page, ASSEMBLY);
  await page.getByTestId('assembly-explode').click();
  await expect(page.getByTestId('explode-steps').locator(':scope > li')).toHaveCount(5);
  unpin = await pin(page);
  mask = await cubeMask(page);
  await view(page, 'iso');
  await page.evaluate(() =>
    window.__manufakture!.viewport.frameBox(
      { min: [-400, -400, -50], max: [1200, 700, 2200] },
      false,
    ),
  );
  await settle(page);
  await expect(canvas).toHaveScreenshot('bookshelf-exploded.png', { mask: [mask] });
  await unpin();
  expect(errors).toEqual([]);
});
