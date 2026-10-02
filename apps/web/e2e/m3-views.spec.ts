import { expect, test, type Page } from '@playwright/test';
import { openEmpty, view } from './bracket';
import { settle } from './helpers';
import { buildJig, checked } from './m3-fixtures';

// Viewport screenshots of the M3 acceptance jig (m3-fixtures.ts, at #fit_slip 0.2) against the
// baselines in e2e/__screenshots__/: the block and the thumbscrew in the iso and front views, and
// on the X1 Carbon's plate in the print workspace with the overhang shading, from below so the
// tops of the bore and of the side hole show. As for M1 and M2 (m2-views.spec.ts): SwiftShader
// renders, the comparison allows a small share of differing pixels (playwright.config.ts), the
// view cube is masked, and the canvas is pinned to a fixed size and place so the machine's fonts
// cannot change its layout.
//
// After an intended change to how the viewport draws, refresh the baselines with
//   pnpm --filter @manufakture/web e2e m3-views --update-snapshots
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
      // The committed sketches are drawn over the canvas where it was: hide them with it pinned.
      '[data-testid="committed-sketches"] { display: none !important; }',
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

const EYE: [number, number, number] = [0.45, 1, -0.4];
const SECTION_FLIPPED = true;

test('the jig in the iso and front views, and its overhangs on the plate', async ({ page }) => {
  test.setTimeout(240_000);
  const errors = await openEmpty(page);
  await buildJig(page);
  await page.evaluate(() => window.__manufakture!.selection.getState().clear());
  const canvas = page.getByTestId('viewport-canvas');

  let unpin = await pin(page);
  let mask = await cubeMask(page);
  for (const v of ['iso', 'front'] as const) {
    await view(page, v);
    await expect(canvas).toHaveScreenshot(`jig-${v}.png`, { mask: [mask] });
  }
  await unpin();

  await page.getByTestId('open-print').click();
  await checked(page);
  expect(await page.evaluate(() => window.__manufakture!.viewport.info().shading)).toBe('overhang');
  // A section through the bore's axis (the middle of the plate's items in y), so the tops of
  // the bore and of the side hole show from inside.
  await page.evaluate(
    (flipped) =>
      window.__manufakture!.settings.getState().setSection({
        enabled: true,
        axis: 'y',
        position: 0.5,
        flipped,
      }),
    SECTION_FLIPPED,
  );
  unpin = await pin(page);
  mask = await cubeMask(page);
  await page.evaluate((eye) => {
    const hooks = window.__manufakture!;
    // The block's copy: the thumbscrew beside it is in the other checks.
    const box = hooks.print!.resolved()!.items[0]!.copies[0]!.box;
    hooks.viewport.setViewDirection(eye, false);
    hooks.viewport.frameBox(box, false);
  }, EYE);
  await settle(page);
  await expect(canvas).toHaveScreenshot('jig-print-overhang.png', { mask: [mask] });
  await unpin();
  expect(errors).toEqual([]);
});
