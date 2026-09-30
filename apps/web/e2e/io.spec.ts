import { readFile } from 'node:fs/promises';
import {
  checkManifold,
  meshProperties,
  parseStl,
  stepProductNames,
  validate3mf,
} from '@manufakture/io';
import { expect, test, type Page } from '@playwright/test';
import { openScene } from './helpers';

// Export and import on the demo part (a 60 x 40 x 20 mm block, every edge
// filleted at 3 mm, a through hole of radius 8), regenerated from the demo
// document by the real regen worker.
// Downloads are captured and checked with @manufakture/io: STL watertight
// with the part's volume, 3MF structurally valid in millimetres, STEP named;
// the exported STEP and STL are then imported back through the file picker.

/** Choose an Export menu item and return the downloaded file. */
async function exportAs(
  page: Page,
  item: 'stl' | '3mf' | 'step',
  tolerance?: 'draft' | 'normal' | 'fine',
): Promise<{ name: string; bytes: Uint8Array }> {
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  if (tolerance) await page.getByLabel('Mesh tolerance').selectOption(tolerance);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId(`export-${item}`).click(),
  ]);
  const path = await download.path();
  const bytes = new Uint8Array(await readFile(path));
  await expect(page.getByTestId('io-status')).toHaveText(
    new RegExp(`^Exported ${download.suggestedFilename().replace('.', '\\.')}`),
  );
  return { name: download.suggestedFilename(), bytes };
}

/** The demo part's exact volume, from the measure tool (nothing selected: the body). */
async function exactVolume(page: Page): Promise<number> {
  await page.waitForFunction(() => {
    const s = window.__manufakture!.measure.getState();
    return s.status === 'ready' && s.result?.body !== null;
  });
  return page.evaluate(() => window.__manufakture!.measure.getState().result!.body!.volume);
}

async function importFile(page: Page, name: string, bytes: Uint8Array, mimeType: string) {
  await page.getByTestId('import-input').setInputFiles({
    name,
    mimeType,
    buffer: Buffer.from(bytes),
  });
}

test.describe('export and import', () => {
  test.beforeEach(async ({ page }) => {
    await openScene(page, '?scene=demo', 90_000);
  });

  test('STL and 3MF of the demo part are watertight, in millimetres, with its volume', async ({
    page,
  }) => {
    const volume = await exactVolume(page);
    expect(volume).toBeGreaterThan(40_000);

    const stl = await exportAs(page, 'stl', 'fine');
    expect(stl.name).toBe('Demo part.stl');
    const parsed = parseStl(stl.bytes);
    expect(parsed.format).toBe('binary');
    const report = checkManifold(parsed.mesh);
    expect(report.problems).toEqual([]);
    expect(meshProperties(parsed.mesh).volume / volume).toBeCloseTo(1, 2);

    const threemf = await exportAs(page, '3mf');
    expect(threemf.name).toBe('Demo part.3mf');
    const r = validate3mf(threemf.bytes);
    expect(r.problems).toEqual([]);
    expect(r.parsed!.unit).toBe('millimeter');
    expect(r.parsed!.objects.map((o) => o.name)).toEqual(['Demo part']);
    expect(r.objects[0]!.manifold.volume / volume).toBeCloseTo(1, 1);
  });

  test('STEP exports named, and imports back as a reference body with the same faces', async ({
    page,
  }) => {
    const step = await exportAs(page, 'step');
    expect(step.name).toBe('Demo part.step');
    expect(new TextDecoder().decode(step.bytes.subarray(0, 13))).toBe('ISO-10303-21;');
    expect(stepProductNames(step.bytes)).toEqual(['Demo part']);

    await importFile(page, 'Demo part.step', step.bytes, 'model/step');
    await expect(page.getByTestId('io-status')).toHaveText(
      'Imported Demo part.step as Demo part (STEP, a reference body).',
      { timeout: 30_000 },
    );
    const info = await page.evaluate(() => window.__manufakture!.viewport.info());
    expect(info.bodies.map((b) => b.id)).toEqual(['part#1', 'part#1/import#1']);
    expect(info.bodies[1]!.faces).toBe(info.bodies[0]!.faces);

    // The document holds the import feature with the file.
    const feature = await page.evaluate(() =>
      window.__manufakture!.document.getState().document.parts[0]!.features.at(-1)!,
    );
    expect(feature).toMatchObject({
      id: 'import#1',
      kind: 'import',
      name: 'Demo part',
      operation: 'reference',
      source: { format: 'step', fileName: 'Demo part.step', size: step.bytes.length },
    });
  });

  test('an imported reference body is never exported, before or after undo', async ({ page }) => {
    const volume = await exactVolume(page);
    const before = await exportAs(page, 'stl', 'draft');
    const triangles = parseStl(before.bytes).mesh.indices.length / 3;
    const step = await exportAs(page, 'step');
    await importFile(page, 'Demo part.step', step.bytes, 'model/step');
    await expect(page.getByTestId('io-status')).toHaveText(/^Imported Demo part\.step/, {
      timeout: 30_000,
    });

    /** Export STL and STEP, and check both hold the part alone. */
    const onlyThePart = async () => {
      const stl = await exportAs(page, 'stl', 'draft');
      expect(stl.name).toBe('Demo part.stl');
      const mesh = parseStl(stl.bytes).mesh;
      expect(mesh.indices.length / 3).toBe(triangles);
      expect(checkManifold(mesh).problems).toEqual([]);
      expect(meshProperties(mesh).volume / volume).toBeCloseTo(1, 1);
      const threemf = await exportAs(page, '3mf', 'draft');
      expect(validate3mf(threemf.bytes).parsed!.objects.map((o) => o.name)).toEqual(['Demo part']);
      const again = await exportAs(page, 'step');
      expect(again.name).toBe('Demo part.step');
      expect(stepProductNames(again.bytes)).toEqual(['Demo part']);
    };
    await onlyThePart();

    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect
      .poll(() =>
        page.evaluate(() => window.__manufakture!.viewport.info().bodies.map((b) => b.id)),
      )
      .toEqual(['part#1']);
    await onlyThePart();
  });

  test('an STL imports as a mesh reference body', async ({ page }) => {
    const stl = await exportAs(page, 'stl', 'draft');
    await importFile(page, 'part.stl', stl.bytes, 'model/stl');
    await expect(page.getByTestId('io-status')).toHaveText(
      'Imported part.stl as part (STL mesh, a reference body).',
    );
    const info = await page.evaluate(() => window.__manufakture!.viewport.info());
    expect(info.bodies.map((b) => b.id)).toEqual(['part#1', 'part#1/import#1']);
    expect(info.bodies[1]!.faces).toBe(1);
    expect(info.bodies[1]!.edges).toBe(0);
    const feature = await page.evaluate(() =>
      window.__manufakture!.document.getState().document.parts[0]!.features.at(-1)!,
    );
    expect(feature).toMatchObject({ kind: 'import', source: { format: 'stl' } });
  });
});
