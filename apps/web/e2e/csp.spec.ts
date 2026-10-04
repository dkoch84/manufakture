import { expect, test, type Page } from '@playwright/test';
import { openScene } from './helpers';

// The production Content-Security-Policy (src/hosting/headers.ts; deploy/Caddyfile sends the same,
// `vite preview` sends it for these tests) must not break the app, the viewer or the source page
// (T7.3c). Every violation a page reports is collected; the kernel running at all proves the
// worker policy lets its Emscripten glue in. The other specs bypass the policy (playwright.config.ts).

test.use({ bypassCSP: false });

interface Violation {
  directive: string;
  blocked: string;
  source: string;
}

/** Record every CSP violation the page reports, from before its first script runs. */
async function watchViolations(page: Page): Promise<() => Promise<Violation[]>> {
  await page.addInitScript(() => {
    const seen: Violation[] = [];
    (window as unknown as { __cspViolations: Violation[] }).__cspViolations = seen;
    document.addEventListener('securitypolicyviolation', (e) => {
      seen.push({ directive: e.effectiveDirective, blocked: e.blockedURI, source: e.sourceFile });
    });
  });
  return () =>
    page.evaluate(() => (window as unknown as { __cspViolations: Violation[] }).__cspViolations);
}

/**
 * zod probes `Function('')` once to learn whether it may compile validators, and falls back when
 * it may not; the browser reports the refusal. Anything else is a real violation.
 */
const isZodEvalProbe = (v: Violation) => v.directive === 'script-src' && v.blocked === 'eval';

test('the app regenerates the demo part under the policy', async ({ page }) => {
  const violations = await watchViolations(page);
  const response = await page.goto('/');
  const csp = response?.headers()['content-security-policy'] ?? '';
  expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval';");
  expect(csp).toContain("frame-ancestors 'none'");
  await openScene(page, '?scene=demo', 90_000);
  const info = await page.evaluate(() => window.__manufakture!.viewport.info());
  expect(info.bodies).toHaveLength(1);
  expect((await violations()).filter((v) => !isZodEvalProbe(v))).toEqual([]);
});

test('the Source link opens the source page, which names the build', async ({ page, context }) => {
  await page.goto('/');
  const link = page.getByTestId('source-link');
  await expect(link).toHaveAttribute('href', '/source.html');
  const [source] = await Promise.all([context.waitForEvent('page'), link.click()]);
  await source.waitForLoadState('domcontentloaded');
  await expect(source.getByRole('heading', { name: 'Source code of this build' })).toBeVisible();
  await expect(source.getByTestId('source-wasm').locator('tbody tr')).not.toHaveCount(0);
  await expect(source.getByTestId('source-wasm')).toContainText('libcascade');
  // The page's stylesheet is a file, so the strict policy lets it apply.
  const background = await source.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(background).toBe('rgb(244, 246, 248)');
});

test('the viewer starts under the policy and links the source page', async ({ page }) => {
  const violations = await watchViolations(page);
  await page.goto('/viewer.html');
  await expect(page.getByTestId('viewer-canvas')).toBeVisible();
  await expect(page.getByTestId('source-link')).toHaveAttribute('href', '/source.html');
  expect((await violations()).filter((v) => !isZodEvalProbe(v))).toEqual([]);
});
