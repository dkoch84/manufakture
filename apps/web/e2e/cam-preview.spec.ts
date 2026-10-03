import { expect, test, type Page } from '@playwright/test';
import { BRACKET, buildBracket, openEmpty, view } from './bracket';
import { clickWorld, settle } from './helpers';

// The toolpath preview and playback (M5 plan, T5.3b) on a fixture job, through the real regen
// and CAM workers: the M1 bracket in plywood, a 1/4" flat end mill, a facing of the whole stock
// top and a 3 mm profile around the upright's top face (as in cam.spec.ts). Generated, the job
// shows in the view with the stock box and the WCS gizmo; scrubbing to a move puts the tool
// marker at that move's end; and the screenshots compare against the baselines in
// e2e/__screenshots__/ (SwiftShader, tolerances in playwright.config.ts; see m1-views.spec.ts).
//
// After an intended change to how the preview draws, refresh the baselines with
//   pnpm --filter @manufakture/web e2e cam-preview --update-snapshots

type V3 = [number, number, number];

interface PreviewState {
  moveCount: number;
  done: number;
  tool: V3 | null;
  toolMachine: V3 | null;
  marker: V3 | null;
  buffers: number;
  hidden: string[];
  message: string | null;
}

type PreviewHook = { state(): PreviewState; seek(n: number): void };

function previewState(page: Page): Promise<PreviewState> {
  return page.evaluate(() =>
    (window.__manufakture as unknown as { camPreview: PreviewHook }).camPreview.state(),
  );
}

/** A plain element over the view cube (top right of the canvas), for `mask`. */
async function cubeMask(page: Page) {
  await page.evaluate(() => {
    const canvas = document.querySelector('[data-testid="viewport-canvas"]')!;
    const r = canvas.getBoundingClientRect();
    const size = 110 + 2 * 12; // viewCube.ts: sizePx and marginPx
    const mask = document.createElement('div');
    mask.id = 'e2e-cube-mask';
    document.body.append(mask);
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

test('the toolpath preview of a facing and a profile on the M1 bracket', async ({ page }) => {
  test.setTimeout(300_000);
  const errors = await openEmpty(page);
  await buildBracket(page);
  const t = 6;

  // The workspace, a tool from the built-in library, and a plywood setup on the default machine.
  await page.getByTestId('open-cam').click();
  await page.getByTestId('cam-open-tools').click();
  await page.getByTestId('cam-use-c3d-201').click();
  await expect(page.getByTestId('cam-tool-tool#1')).toContainText('#201');
  await page.getByTestId('cam-tools-close').click();
  await page.getByTestId('cam-add-setup').click();
  await page.getByTestId('cam-setup-material').selectOption('plywood');
  await expect(page.getByTestId('cam-setup-material')).toHaveValue('plywood');
  // Before any generation the panel says so; the stock and WCS are drawn already.
  await expect(page.getByTestId('cam-preview')).toContainText('Generate to preview');

  // A facing of the whole stock top, with the dialog's defaults.
  await page.getByTestId('cam-new-facing').click();
  await page.getByTestId('cam-op-ok').click();
  await expect(page.getByTestId('cam-op-dialog')).toBeHidden();

  // A profile around the upright's top face, 3 mm deep.
  await page.getByTestId('cam-new-profile').click();
  await view(page, 'iso');
  await clickWorld(page, [t / 2, 0, BRACKET.height]);
  await expect(page.getByTestId('cam-source-0')).toContainText('Face extrude#1:');
  await page.getByTestId('cam-field-depthMode').selectOption('blind');
  await page.getByTestId('cam-field-depth').fill('3');
  await page.getByTestId('cam-op-ok').click();
  await expect(page.getByTestId('cam-op-dialog')).toBeHidden();
  for (const id of ['facing#1', 'profile#1']) {
    await expect(page.getByTestId(`cam-op-status-${id}`)).toHaveAttribute('data-state', 'ok', {
      timeout: 60_000,
    });
  }

  // Generate: the preview shows the linked job and its statistics.
  await page.getByTestId('cam-generate').click();
  await expect(page.getByTestId('cam-generate-message')).toHaveText(
    'Generated 2 of 2 operations.',
    { timeout: 60_000 },
  );
  await expect(page.getByTestId('cam-preview-stats')).toBeVisible();
  await expect(page.getByTestId('cam-preview-op-facing#1')).toContainText('mm');
  await expect(page.getByTestId('cam-preview-op-profile#1')).toContainText('mm');
  await expect(page.getByTestId('cam-preview-job')).toContainText(/\d+:\d\d/);
  const whole = await previewState(page);
  expect(whole.message).toBeNull();
  expect(whole.moveCount).toBeGreaterThan(20);
  expect(whole.done).toBe(whole.moveCount);
  // One line buffer per operation and move class, not one object per move.
  expect(whole.buffers).toBeLessThan(12);

  // Scrubbing to a move puts the tool marker where that move ends, on the part.
  const k = Math.floor(whole.moveCount / 2);
  await page.getByTestId('cam-preview-scrubber').fill(String(k));
  await expect(page.getByTestId('cam-preview-position')).toContainText(
    `Move ${k} of ${whole.moveCount}`,
  );
  const half = await previewState(page);
  expect(half.done).toBe(k);
  for (let i = 0; i < 3; i++) expect(half.marker![i]).toBeCloseTo(half.tool![i]!, 6);
  // The WCS origin is on the stock top: machine Z 0 is model Z of the stock top. The bracket's
  // stock spans its 40 mm height plus margins, so a cut below the top sits under 40 + margin.
  expect(half.tool![2]! - half.toolMachine![2]!).toBeGreaterThanOrEqual(BRACKET.height);

  // Screenshots: the canvas pinned (see m1-views.spec.ts) and overlays over it hidden.
  await page.evaluate(() => window.__manufakture!.selection.getState().clear());
  const pin = await page.addStyleTag({
    content:
      '[data-testid="viewport-canvas"] { position: fixed !important; left: 0 !important; ' +
      'top: 0 !important; width: 760px !important; height: 540px !important; } ' +
      '.viewport > :not(canvas) { display: none !important; }',
  });
  await page.mouse.move(1270, 790);
  const canvas = page.getByTestId('viewport-canvas');
  await expect
    .poll(() => canvas.evaluate((c: HTMLCanvasElement) => [c.width, c.height].join('x')))
    .toBe(await page.evaluate(() => `${760 * devicePixelRatio}x${540 * devicePixelRatio}`));
  const mask = await cubeMask(page);
  // The stock (the bracket's box plus 5 mm margins, 1 mm above) up to the clearance height.
  const frame = async () => {
    await page.evaluate(() =>
      window.__manufakture!.viewport.frameBox({ min: [-5, -20, 0], max: [55, 20, 51] }, false),
    );
    await settle(page);
  };

  await view(page, 'iso');
  await frame();
  await expect(canvas).toHaveScreenshot('cam-preview-half-iso.png', { mask: [mask] });

  await page.evaluate(() =>
    (window.__manufakture as unknown as { camPreview: PreviewHook }).camPreview.seek(1e9),
  );
  await expect.poll(async () => (await previewState(page)).done).toBe(whole.moveCount);
  await view(page, 'iso');
  await frame();
  await expect(canvas).toHaveScreenshot('cam-preview-iso.png', { mask: [mask] });
  await view(page, 'top');
  await frame();
  await expect(canvas).toHaveScreenshot('cam-preview-top.png', { mask: [mask] });

  // Hiding the facing leaves the profile.
  // (The pinned canvas lies over the panel, so the click is dispatched to the box itself.)
  await page.getByTestId('cam-preview-show-facing#1').dispatchEvent('click');
  await expect(page.getByTestId('cam-preview-show-facing#1')).not.toBeChecked();
  expect((await previewState(page)).hidden).toEqual(['facing#1']);
  await view(page, 'iso');
  await frame();
  await expect(canvas).toHaveScreenshot('cam-preview-profile-only-iso.png', { mask: [mask] });

  // Closed, the workspace takes its preview away.
  await pin.evaluate((e) => (e as Element).remove());
  await page.getByTestId('open-cam').click();
  await expect(page.getByTestId('feature-tree')).toBeVisible();
  expect(
    await page.evaluate(
      () => (window.__manufakture as unknown as { camPreview?: unknown }).camPreview ?? null,
    ),
  ).toBeNull();
  expect(errors).toEqual([]);
});
