import { expect, test } from '@playwright/test';
import { openScene } from './helpers';

// Frame times for a ~200k triangle model while the camera orbits. The numbers
// are reported, not asserted: headless Chromium renders with SwiftShader
// (software GL on the CPU), so they say nothing about a real GPU. For real
// numbers, start the dev server (`pnpm dev`; production builds leave the test
// scenes out, see src/testHooks.ts), open `/?scene=perf` in a normal browser
// and run `await __manufakture.viewport.measureFrames(300)` in the console.

test('reports frame times for a 200k triangle model', async ({ page }, testInfo) => {
  test.setTimeout(300_000);
  await openScene(page, '?scene=perf&triangles=200000', 120_000);
  const renderer = await page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2');
    const ext = gl?.getExtension('WEBGL_debug_renderer_info');
    return ext && gl ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : 'unknown';
  });
  const stats = await page.evaluate(() => window.__manufakture!.viewport.measureFrames(120));
  const report = { renderer, ...stats };
  await testInfo.attach('frame-times', {
    body: JSON.stringify(report, null, 2),
    contentType: 'application/json',
  });
  console.log(`viewport perf: ${JSON.stringify(report)}`);
  expect(stats.triangles).toBeGreaterThanOrEqual(200_000);
  expect(stats.frames).toBe(120);
  expect(stats.meanMs).toBeGreaterThan(0);
});
