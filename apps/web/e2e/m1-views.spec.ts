import { expect, test, type Page } from '@playwright/test';
import { buildBracket, openEmpty, view } from './bracket';

// Viewport screenshots of the M1 bracket in the canonical views, against the baselines in
// e2e/__screenshots__/. The browser renders with SwiftShader (software WebGL, see
// playwright.config.ts): the same Chromium build draws the same pixels on any x86-64 machine
// in practice, but tiny rasterization differences between CPUs are possible, so the comparison
// allows a small share of differing pixels (the thresholds are in playwright.config.ts). The
// view cube is masked: its labels are text drawn with whatever system font the machine has.
//
// After an intended change to how the viewport draws, refresh the baselines with
//   pnpm --filter @manufakture/web e2e m1-views --update-snapshots
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

test('the bracket in the iso, top and front views', async ({ page }) => {
  test.setTimeout(240_000);
  const errors = await openEmpty(page);
  await buildBracket(page);
  await page.evaluate(() => window.__manufakture!.selection.getState().clear());
  // Off the canvas, so nothing is hovered.
  await page.mouse.move(0, 0);
  const canvas = page.getByTestId('viewport-canvas');
  const mask = await cubeMask(page);
  for (const v of ['iso', 'top', 'front'] as const) {
    await view(page, v);
    await expect(canvas).toHaveScreenshot(`bracket-${v}.png`, { mask: [mask] });
  }
  expect(errors).toEqual([]);
});
