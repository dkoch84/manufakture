import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { dxfLoops, svgLoops, type ReadLoop } from '../src/cam/laser/readBack.test-fixture';
import { BRACKET, buildBracket, openEmpty, view } from './bracket';
import { clickWorld } from './helpers';

// The laser and plasma export (M5 plan, T5.6b) through the UI and the real regen worker, on the
// M1 bracket built as docs/m1-acceptance.md walks through it. Its side profile (the front face,
// Y = -15: the L of the foot and the upright with the 4 mm fillet in the corner) is picked in the
// view and exported as DXF and as SVG; each file is read back (dxf-parser, and the SVG's own path
// syntax) and compared with the profile: one loop, its exact area, 50 x 40 mm from (0, 0), and
// the fillet still an arc, its centre in the inside corner (so the drawing is not mirrored). Then a 0.2 mm kerf grows the outline by its perimeter times 0.1 mm,
// and a section across Y gives the same profile as the face.

const T = 6;
const { length, height, fillet } = BRACKET;
/** The L, plus the fillet's corner square less its quarter disc. */
const AREA = length * T + (height - T) * T + fillet * fillet * (1 - Math.PI / 4);
/** The L's sides, the fillet's straight parts replaced by its quarter circle. */
const PERIMETER = 2 * length + 2 * height - 2 * fillet + (Math.PI / 2) * fillet;

/** Export from the open dialog and return the downloaded file's text. */
async function exportLaser(
  page: Page,
  format: 'dxf' | 'svg',
): Promise<{ name: string; text: string }> {
  await page.getByTestId('laser-format').selectOption(format);
  await expect(page.getByTestId('laser-export')).toBeEnabled();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('laser-export').click(),
  ]);
  const text = await readFile(await download.path(), 'utf8');
  const name = download.suggestedFilename();
  await expect(page.getByTestId('io-status')).toHaveText(
    new RegExp(`^Exported ${name.replace('.', '\\.')}`),
  );
  return { name, text };
}

function expectProfile(loops: ReadLoop[], layer: string, grow = 0): void {
  expect(loops).toHaveLength(1);
  const [loop] = loops as [ReadLoop];
  expect(loop.layer).toBe(layer);
  const d = grow / 2;
  // Steiner's formula for an offset outline; the kerf's refit is within 0.002 mm of exact.
  expect(Math.abs(Math.abs(loop.area) - (AREA + PERIMETER * d + Math.PI * d * d))).toBeLessThan(
    grow > 0 ? 0.002 * PERIMETER : 1e-4,
  );
  expect(loop.arcs).toBeGreaterThanOrEqual(1);
  expect(loop.min[0]).toBeCloseTo(0, 5);
  expect(loop.min[1]).toBeCloseTo(0, 5);
  expect(loop.max[0]).toBeCloseTo(length + grow, 3);
  expect(loop.max[1]).toBeCloseTo(height + grow, 3);
  // Neither mirrored nor turned: the fillet's centre sits in the inside corner, low and on the
  // left beside the upright (a mirror or a turn would move it to another corner).
  const c = T + fillet + d;
  expect(loop.centers.some((p) => Math.hypot(p[0] - c, p[1] - c) < 1e-3)).toBe(true);
}

test('laser export: the M1 bracket side profile as DXF and SVG, read back', async ({ page }) => {
  test.setTimeout(300_000);
  const errors = await openEmpty(page);
  await buildBracket(page, T);

  // 1. The Export menu opens the dialog.
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await page.getByTestId('export-laser').click();
  const dialog = page.getByTestId('laser-dialog');
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId('laser-outline')).toHaveAttribute('data-state', 'empty');

  // 2. The side profile: the front face, picked in the view.
  await view(page, 'front');
  await clickWorld(page, [length / 4, -BRACKET.width / 2, T / 2]);
  await expect(page.getByTestId('laser-source-0')).toContainText('Face extrude#1:');
  const outline = page.getByTestId('laser-outline');
  await expect(outline).toHaveAttribute('data-state', 'ok', { timeout: 60_000 });
  await expect(outline).toHaveAttribute('data-width', String(length));
  await expect(outline).toHaveAttribute('data-height', String(height));
  await page.getByTestId('laser-layer-0').fill('profile');
  await expect(outline).toHaveAttribute('data-state', 'ok', { timeout: 60_000 });

  // 3. DXF and SVG, read back.
  const dxf = await exportLaser(page, 'dxf');
  expect(dxf.name).toMatch(/\.dxf$/);
  expectProfile(dxfLoops(dxf.text), 'profile');
  const svg = await exportLaser(page, 'svg');
  expect(svg.name).toMatch(/\.svg$/);
  expect(svg.text).toContain(`width="${length}mm" height="${height}mm"`);
  expectProfile(svgLoops(svg.text), 'profile');

  // 4. The kerf: checked as typed, then a 0.2 mm kerf grows the outline.
  await page.getByTestId('laser-kerf').fill('-1');
  await expect(page.getByTestId('laser-kerf-error')).toHaveText('The kerf must be zero or more.');
  await expect(page.getByTestId('laser-export')).toBeDisabled();
  await page.getByTestId('laser-kerf').fill('12');
  await expect(page.getByTestId('laser-kerf-error')).toContainText('A kerf over 10 mm');
  await page.getByTestId('laser-kerf').fill('0.2');
  await expect(page.getByTestId('laser-kerf-error')).toHaveCount(0);
  const kerfed = await exportLaser(page, 'dxf');
  expectProfile(dxfLoops(kerfed.text), 'profile', 0.2);

  // 5. A section across Y, 10 mm in from the front, is the same profile.
  await page.getByTestId('laser-kerf').fill('0');
  await page.getByRole('button', { name: /^Remove Face/ }).click();
  await page.getByTestId('laser-section-axis').selectOption('y');
  await page.getByTestId('laser-section-position').fill('-5');
  await page.getByTestId('laser-add-section').click();
  await expect(page.getByTestId('laser-source-0')).toContainText('Section across Y at -5 mm');
  await expect(outline).toHaveAttribute('data-state', 'ok', { timeout: 60_000 });
  const section = await exportLaser(page, 'svg');
  expectProfile(svgLoops(section.text), 'section-1');

  // 6. Closed, the feature tree is back.
  await page.getByTestId('laser-close').click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId('feature-tree')).toBeVisible();
  expect(errors).toEqual([]);
});
