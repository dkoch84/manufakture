import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { addVariable, bodyVolume, openEmpty } from './bracket';

// Scripted features in the app (T7.2d): write the box script in the editor (CodeMirror, loaded on
// first use), insert it, drive a parameter by a variable and see the volume follow; a script
// error marked in the source; an infinite loop failing with a timeout while the app stays
// responsive. Then the opt-in (ADR 0010 amendment, item 11): the document exported and imported
// as a .mfk shows the banner and the tree marks, and runs nothing (the regen reports "Scripts not
// run" and the worker counts no run) until Run scripts; after a reload it builds without asking.
// The whole spec runs under the production Content-Security-Policy, which CodeMirror's styles
// must get through.

test.use({ bypassCSP: false });

const BOX = `// A box with rounded vertical edges.
export const params = {
  width: { kind: 'length', default: 40, min: 1, label: 'Width' },
  depth: { kind: 'length', default: 30, min: 1, label: 'Depth' },
  height: { kind: 'length', default: 20, min: 1, label: 'Height' },
  radius: { kind: 'length', default: 2, min: 0, label: 'Corner radius' },
};

export function run(ctx, p) {
  const base = ctx.sketch('base', {
    plane: 'XY',
    loops: [[
      { kind: 'line', id: 'front', start: [0, 0], end: [p.width, 0] },
      { kind: 'line', id: 'right', start: [p.width, 0], end: [p.width, p.depth] },
      { kind: 'line', id: 'back', start: [p.width, p.depth], end: [0, p.depth] },
      { kind: 'line', id: 'left', start: [0, p.depth], end: [0, 0] },
    ]],
  });
  const box = ctx.extrude('box', base, { distance: p.height });
  if (p.radius > 0) ctx.fillet('round', ctx.edges(box, { direction: [0, 0, 1] }), p.radius);
}
`;

/** The box with a throw on line 10 (QuickJS reports the call, column 18). */
const THROWS = BOX.replace(
  'export function run(ctx, p) {\n',
  "export function run(ctx, p) {\n  throw new Error('no box today');\n",
);
const LOOPS = BOX.replace(
  'export function run(ctx, p) {\n',
  'export function run(ctx, p) {\n  while (true) {}\n',
);

const boxVolume = (w: number, d: number, h: number, r: number) =>
  w * d * h - (4 - Math.PI) * r * r * h;

interface Outcome {
  status: string;
  errors: { code: string; scriptCode?: string; message: string; line?: number }[];
}

/** Once the model shows the open document: each feature's status and errors. */
async function results(page: Page): Promise<Record<string, Outcome>> {
  await page.waitForFunction(
    () => {
      const hooks = window.__manufakture;
      if (!hooks?.model || !hooks.document) return false;
      const m = hooks.model.getState();
      return !m.pending && m.generation > 0 && m.document === hooks.document.getState().document;
    },
    null,
    { timeout: 90_000 },
  );
  return page.evaluate(() =>
    Object.fromEntries(
      window
        .__manufakture!.model.getState()
        .parts[0]!.features.map((f) => [
          f.featureId,
          { status: f.status, errors: f.errors as Outcome['errors'] },
        ]),
    ),
  );
}

interface Stats {
  declarations: number;
  runs: number;
}

function scriptStats(page: Page): Promise<Stats> {
  return page.evaluate(async () => {
    const hooks = window.__manufakture as unknown as {
      scripts: { stats(): Promise<Stats | null> };
    };
    return (await hooks.scripts.stats())!;
  });
}

const editor = (page: Page) => page.getByTestId('script-editor');
const code = (page: Page) => page.getByTestId('script-source').locator('.cm-content');

async function setSource(page: Page, source: string): Promise<void> {
  await code(page).fill(source);
  await page.getByTestId('script-save').click();
  await expect(page.getByTestId('script-save')).toBeDisabled();
}

test('write a script, insert it, drive it by a variable; errors, timeouts and the opt-in', async ({
  page,
}) => {
  test.setTimeout(300_000);
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => {
      // zod probes `Function('')` once and falls back (src/hosting/headers.ts).
      if (e.effectiveDirective === 'script-src' && e.blockedURI === 'eval') return;
      (window as unknown as { __csp?: string[] }).__csp ??= [];
      (window as unknown as { __csp: string[] }).__csp.push(
        `${e.effectiveDirective} ${e.blockedURI}`,
      );
    });
  });
  const errors = await openEmpty(page);

  // Until the security sign-off, running scripts automatically cannot be turned on.
  await expect(page.getByTestId('scripts-auto')).toBeDisabled();
  await expect(page.getByTestId('scripts-auto')).not.toBeChecked();
  await expect(page.getByTestId('scripts-auto-locked')).toContainText('security review');

  // Write the box script in the editor and save it.
  await page.getByTestId('script-new').click();
  await expect(editor(page)).toBeVisible();
  await expect(code(page)).toBeVisible();
  await page.getByTestId('script-name').fill('Box');
  await setSource(page, BOX);
  await expect(page.getByTestId('script-script#1')).toContainText('Box');
  await page.getByTestId('script-close').click();
  await expect(editor(page)).toBeHidden();

  // Insert it: the dialog is generated from the parameters the script declares.
  await page
    .getByRole('toolbar', { name: 'Features' })
    .getByRole('button', { name: 'Scripted', exact: true })
    .click();
  await expect(page.getByTestId('feature-dialog')).toBeVisible();
  await expect(page.getByTestId('field-param-width')).toHaveValue('40');
  await expect(page.getByTestId('field-seed')).toHaveValue('0');
  await page.getByTestId('dialog-ok').click();
  await expect(page.getByTestId('feature-dialog')).toBeHidden();
  expect((await results(page))['scripted#1']!.status).toBe('ok');
  await expect(page.getByTestId('script-mark-scripted#1')).toHaveText('Script: Box');
  await expect(page.getByTestId('scripts-banner')).toBeHidden();
  expect(await bodyVolume(page)).toBeCloseTo(boxVolume(40, 30, 20, 2), 2);

  // A variable drives the width.
  await addVariable(page, 'w', '50');
  await page.getByTestId('feature-scripted#1').dblclick();
  await page.getByTestId('field-param-width').fill('#w + 5');
  await page.getByTestId('dialog-ok').click();
  await expect(page.getByTestId('feature-dialog')).toBeHidden();
  expect((await results(page))['scripted#1']!.status).toBe('ok');
  await expect.poll(() => bodyVolume(page)).toBeCloseTo(boxVolume(55, 30, 20, 2), 2);

  // A script error: marked in the source and listed with its position.
  await page.getByRole('button', { name: 'Edit script Box' }).click();
  await expect(code(page)).toBeVisible();
  await setSource(page, THROWS);
  const thrown = (await results(page))['scripted#1']!;
  expect(thrown.status).toBe('error');
  expect(thrown.errors[0]).toMatchObject({ code: 'script', scriptCode: 'runtime', line: 10 });
  await expect(page.getByTestId('script-problem')).toContainText('Scripted 1 (line 10, column 18)');
  await expect(page.getByTestId('script-problem')).toContainText('no box today');
  await expect(editor(page).locator('.cm-lint-marker-error')).toHaveCount(1);
  await expect(editor(page).locator('.cm-lintRange-error')).toHaveCount(1);

  // An infinite loop fails with a timeout, and the app answers meanwhile.
  await code(page).fill(LOOPS);
  await page.getByTestId('script-save').click();
  await expect
    .poll(() => page.evaluate(() => window.__manufakture!.model.getState().pending))
    .toBe(true);
  const t0 = Date.now();
  await page.getByTestId('script-name').fill('Box loop');
  await page.getByTestId('script-name').fill('Box');
  expect(await page.evaluate(() => 1 + 1)).toBe(2);
  expect(Date.now() - t0).toBeLessThan(1500);
  const looped = (await results(page))['scripted#1']!;
  expect(looped.status).toBe('error');
  expect(looped.errors[0]).toMatchObject({ scriptCode: 'timeout' });
  await expect(page.getByTestId('script-problem')).toContainText('limit');

  // Back to the box.
  await setSource(page, BOX);
  expect((await results(page))['scripted#1']!.status).toBe('ok');
  await page.getByTestId('script-close').click();
  await expect(page.getByTestId('save-status')).toHaveText('Saved', { timeout: 15_000 });

  // Export the document as a .mfk and import it: a document whose scripts were never allowed on
  // this device (a new id, and an import forgets what was allowed under an id anyway).
  const before = await scriptStats(page);
  await page.getByTestId('open-home').click();
  const id = await page.evaluate(() => window.__manufakture!.document.getState().document.id);
  const row = page.getByTestId(`doc-${id}`);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    row.getByRole('button', { name: 'Export' }).click(),
  ]);
  const mfk = await readFile(await download.path());
  await page.getByTestId('mfk-input').setInputFiles({
    name: 'Box.mfk',
    mimeType: 'application/vnd.manufakture+zip',
    buffer: mfk,
  });
  await expect
    .poll(() => page.evaluate(() => window.__manufakture!.document.getState().document.id), {
      timeout: 30_000,
    })
    .not.toBe(id);
  const imported = await page.evaluate(() => window.__manufakture!.document.getState().document.id);

  // The banner lists the scripted feature and its script; the tree marks it; nothing ran.
  const banner = page.getByTestId('scripts-banner');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('Scripted 1: script Box');
  await expect(page.getByTestId('script-mark-scripted#1')).toHaveText('Script: Box');
  const blocked = (await results(page))['scripted#1']!;
  expect(blocked.status).toBe('error');
  expect(blocked.errors[0]).toMatchObject({ scriptCode: 'not-allowed' });
  expect(blocked.errors[0]!.message).toMatch(/^Scripts not run/);
  expect(await scriptStats(page)).toEqual(before);
  await page.getByTestId('feature-scripted#1').dblclick();
  await expect(page.getByTestId('scripted-blocked')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('feature-dialog')).toBeHidden();
  expect(await scriptStats(page)).toEqual(before);

  // Run scripts: it builds.
  await page.getByTestId('run-scripts').click();
  await expect(banner).toBeHidden();
  await expect.poll(async () => (await results(page))['scripted#1']!.status).toBe('ok');
  // (Served from the regen cache: the same script, parameters and seed ran in the first document.
  // The policy is checked before the cache, so nothing of it showed until now.)
  expect(await bodyVolume(page)).toBeCloseTo(boxVolume(55, 30, 20, 2), 2);

  // Reload: the choice is this device's, so it builds without asking.
  await page.reload();
  await expect
    .poll(() => page.evaluate(() => window.__manufakture?.document?.getState().document.id ?? null))
    .toBe(imported);
  expect((await results(page))['scripted#1']!.status).toBe('ok');
  await expect(page.getByTestId('scripts-banner')).toBeHidden();

  expect(errors).toEqual([]);
  expect(
    await page.evaluate(() => (window as unknown as { __csp?: string[] }).__csp ?? []),
  ).toEqual([]);
});
