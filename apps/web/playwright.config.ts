import { defineConfig, devices } from '@playwright/test';

// End-to-end checks against a production build served by `vite preview`
// (COOP/COEP headers included). Run with `pnpm --filter @manufakture/web e2e`.
// The build is made with VITE_E2E=1, which keeps the test hook and the test
// scenes that a normal production build leaves out (src/testHooks.ts), and it
// goes to its own directory so it never mixes with the deployable dist/.
// Results and the HTML report go to test-results/ and playwright-report/.
//
// E2E_PORT picks the preview port. PLAYWRIGHT_BROWSER_LD_LIBRARY_PATH is for
// minimal containers that lack Chromium's shared libraries: point it at an
// unpacked copy and it is passed to the browser process only. CI installs the
// libraries with `playwright install --with-deps` and leaves it unset.

const port = Number(process.env.E2E_PORT ?? 4317);
const ci = !!process.env.CI;
const extraLibs = process.env.PLAYWRIGHT_BROWSER_LD_LIBRARY_PATH;
const appDir = 'dist/e2e-app';

export default defineConfig({
  testDir: './e2e',
  outputDir: 'test-results',
  // One worker: the perf check must not share the CPU with other tests.
  workers: 1,
  timeout: 120_000,
  expect: {
    timeout: 15_000,
    // Viewport screenshots (m1-views.spec.ts) are rendered by SwiftShader. Tolerant on purpose:
    // a pixel counts as different only past a colour distance of 0.2, and up to 1% of them may
    // differ, which absorbs rasterization noise between machines but not a changed model, view
    // or shading.
    toHaveScreenshot: { threshold: 0.2, maxDiffPixelRatio: 0.01, animations: 'disabled' },
  },
  // Baselines are shared by every platform (the renderer is SwiftShader everywhere), so their
  // names carry no browser or OS suffix.
  snapshotPathTemplate: '{testDir}/__screenshots__/{testFilePath}/{arg}{ext}',
  // CI only compares: it never writes or rewrites a baseline, so a missing or changed image
  // fails there and is updated on purpose, locally, with --update-snapshots.
  updateSnapshots: ci ? 'none' : 'missing',
  forbidOnly: ci,
  retries: ci ? 1 : 0,
  reporter: ci
    ? [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]]
    : 'list',
  use: {
    baseURL: `http://localhost:${port}`,
    viewport: { width: 1280, height: 800 },
    trace: 'retain-on-failure',
    // `vite preview` sends the production Content-Security-Policy (src/hosting/headers.ts). Specs
    // that pin layout inject inline styles, which that policy refuses, so the policy is bypassed
    // by default; e2e/csp.spec.ts turns it back on and runs the app, the viewer and the source
    // page under it.
    bypassCSP: true,
    launchOptions: {
      // Software WebGL, so the viewport renders on machines without a GPU.
      args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'],
      ...(extraLibs ? { env: { ...process.env, LD_LIBRARY_PATH: extraLibs } } : {}),
    },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command:
      `pnpm exec vite build --outDir ${appDir} && ` +
      `pnpm exec vite preview --outDir ${appDir} --port ${port} --strictPort`,
    env: { VITE_E2E: '1' },
    url: `http://localhost:${port}`,
    reuseExistingServer: !ci,
    timeout: 180_000,
  },
});
