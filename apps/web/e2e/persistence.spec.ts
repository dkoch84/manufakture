import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { clickWorld, settle } from './helpers';
import { newSketch, rectangle } from './sketch-helpers';

// Persistence with the real regen worker and the browser's own storage (OPFS in Chromium): a
// part built through the UI, with an imported STEP reference body, survives a reload and
// regenerates identically; exported as a .mfk, deleted and imported again, it is identical
// once more.

interface Snapshot {
  document: unknown;
  bodies: { id: string; faces: number; edges: number }[];
  volume: number;
}

/** Wait until the model shows the open document, with `bodies` bodies in the viewport. */
async function regenerated(page: Page, bodies: number): Promise<void> {
  await page.waitForFunction(
    (n) => {
      const hooks = window.__manufakture;
      if (!hooks?.model || !hooks.document || !hooks.viewport) return false;
      const m = hooks.model.getState();
      const doc = hooks.document.getState().document;
      const shown = m.parts[0]?.features.map((f) => f.featureId).join() ?? '';
      return (
        !m.pending &&
        m.generation > 0 &&
        shown === doc.parts[0]!.features.map((f) => f.id).join() &&
        hooks.viewport.info().bodies.length === n
      );
    },
    bodies,
    { timeout: 90_000 },
  );
  await settle(page);
}

/** The document, the bodies' topology and the part's exact volume. */
async function snapshot(page: Page): Promise<Snapshot> {
  await page.evaluate(() => window.__manufakture!.selection.getState().clear());
  await page.waitForFunction(() => {
    const s = window.__manufakture!.measure.getState();
    return s.status === 'ready' && s.request?.targets.length === 0 && s.result?.body;
  });
  return page.evaluate(() => {
    const hooks = window.__manufakture!;
    return {
      document: hooks.document.getState().document,
      bodies: hooks.viewport
        .info()
        .bodies.map((b) => ({ id: b.id, faces: b.faces, edges: b.edges })),
      volume: hooks.measure.getState().result!.body!.volume,
    };
  });
}

async function saved(page: Page) {
  await expect(page.getByTestId('save-status')).toHaveText('Saved', { timeout: 15_000 });
}

function expectSame(actual: Snapshot, expected: Snapshot) {
  expect(actual.document).toEqual(expected.document);
  expect(actual.bodies).toEqual(expected.bodies);
  expect(actual.volume).toBeCloseTo(expected.volume, 6);
}

test('a part survives a reload, and a .mfk export, delete and import', async ({ page }) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.getByTestId('empty-hint')).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId('document-name')).toHaveText('Untitled');

  // A 40 x 25 x 15 block, filleted on one edge.
  await newSketch(page, 'Top (XY)');
  await rectangle(page, [0, 0], [40, 25]);
  await page.getByRole('button', { name: 'Finish sketch' }).click();
  await page.getByTestId('feature-sketch#1').click();
  await page
    .getByRole('toolbar', { name: 'Features' })
    .getByRole('button', { name: 'Extrude' })
    .click();
  await page.getByTestId('field-distance').fill('15');
  await page.getByTestId('dialog-ok').click();
  await regenerated(page, 1);
  await page.evaluate(() => window.__manufakture!.viewport.setStandardView('iso', false));
  await settle(page);
  await page
    .getByRole('toolbar', { name: 'Features' })
    .getByRole('button', { name: 'Fillet' })
    .click();
  await clickWorld(page, [20, 0, 15]);
  await expect(page.getByTestId('ref-edges')).toContainText('extrude#1:cap:end');
  await page.getByTestId('field-radius').fill('3');
  await page.getByTestId('dialog-ok').click();
  await regenerated(page, 1);

  // Its own STEP export, imported back as a reference body.
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const [stepDownload] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('export-step').click(),
  ]);
  const step = await readFile(await stepDownload.path());
  await page.getByTestId('import-input').setInputFiles({
    name: 'block.step',
    mimeType: 'model/step',
    buffer: step,
  });
  await expect(page.getByTestId('io-status')).toHaveText(/^Imported block\.step/, {
    timeout: 30_000,
  });
  await regenerated(page, 2);
  await saved(page);
  const before = await snapshot(page);
  expect(before.bodies.map((b) => b.id)).toEqual(['part#1', 'import#1']);
  expect(before.bodies[0]!.faces).toBe(7);
  expect(before.bodies[1]!.faces).toBe(7);
  const id = (before.document as { id: string }).id;
  expect(new URL(page.url()).searchParams.get('doc')).toBe(id);

  // Reload: the document is read back from storage and regenerated, the import read again.
  await page.reload();
  await regenerated(page, 2);
  expectSame(await snapshot(page), before);
  await expect(page.getByTestId('save-status')).toHaveText('');

  // Export the .mfk from the home screen, delete the document, import the file.
  await page.getByTestId('open-home').click();
  const row = page.getByTestId(`doc-${id}`);
  await expect(row).toContainText('Untitled');
  await expect(page.getByTestId('storage-info')).toContainText('Origin Private File System');
  const [mfkDownload] = await Promise.all([
    page.waitForEvent('download'),
    row.getByRole('button', { name: 'Export' }).click(),
  ]);
  expect(mfkDownload.suggestedFilename()).toBe('Untitled.mfk');
  const mfk = await readFile(await mfkDownload.path());
  await row.getByRole('button', { name: 'Delete' }).click();
  await row.getByRole('button', { name: 'Delete' }).click();
  await expect(row).toBeHidden();
  await expect(page.getByText('No saved documents yet')).toBeVisible();

  await page.getByTestId('mfk-input').setInputFiles({
    name: 'Untitled.mfk',
    mimeType: 'application/vnd.manufakture+zip',
    buffer: mfk,
  });
  await expect(page.getByTestId('document-name')).toHaveText('Untitled', { timeout: 30_000 });
  await regenerated(page, 2);
  expectSame(await snapshot(page), before);

  // And it is stored again: another reload brings it back.
  await page.reload();
  await regenerated(page, 2);
  expectSame(await snapshot(page), before);
  expect(errors).toEqual([]);
});

test('a newer file is refused with a clear message, and nothing is stored', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('empty-hint')).toBeVisible({ timeout: 90_000 });
  await page.getByTestId('open-home').click();
  // A .mfk whose document says it was written by a far newer app.
  const { zipSync, strToU8 } = await import('fflate');
  const doc = { format: 'manufakture', version: 999, namingScheme: 1, id: 'x', name: 'Future' };
  const bytes = zipSync({ 'document.json': strToU8(JSON.stringify(doc)) });
  await page.getByTestId('mfk-input').setInputFiles({
    name: 'future.mfk',
    mimeType: 'application/vnd.manufakture+zip',
    buffer: Buffer.from(bytes),
  });
  await expect(page.getByRole('alert')).toHaveText(
    /^future\.mfk: This document was saved by a newer version of manufakture \(file format 999/,
  );
  await expect(page.getByText('No saved documents yet')).toBeVisible();
});

test('two tabs on one document never save over each other', async ({ page, context }) => {
  test.setTimeout(240_000);
  const rename = (p: Page, name: string) =>
    p.evaluate(
      (n) =>
        window
          .__manufakture!.document.getState()
          .execute({ type: 'renameDocument', name: n }, 'Rename document').ok,
      name,
    );
  await page.goto('/');
  await expect(page.getByTestId('empty-hint')).toBeVisible({ timeout: 90_000 });
  expect(await rename(page, 'Shared')).toBe(true);
  await saved(page);

  // The same document in a second tab, which saves a change of its own.
  const second = await context.newPage();
  await second.goto(page.url());
  await expect(second.getByTestId('document-name')).toHaveText('Shared', { timeout: 90_000 });
  expect(await rename(second, 'From the second tab')).toBe(true);
  await saved(second);

  // The first tab's next change is not saved over it: the conflict is shown instead.
  expect(await rename(page, 'From the first tab')).toBe(true);
  await expect(page.getByTestId('save-conflict')).toBeVisible();
  await expect(page.getByTestId('save-status')).toHaveText(/^Not saved: It was changed/);
  await page.getByTestId('conflict-copy').click();
  await expect(page.getByTestId('document-name')).toHaveText('From the first tab (copy)');
  await expect(page.getByTestId('save-conflict')).toBeHidden();

  // Both versions are stored.
  await second.reload();
  await expect(second.getByTestId('document-name')).toHaveText('From the second tab', {
    timeout: 90_000,
  });
  await second.getByTestId('open-home').click();
  await expect(second.getByRole('button', { name: 'From the first tab (copy)' })).toBeVisible();
  await second.close();
});
