import { readFile } from 'node:fs/promises';
import { validate3mf } from '@manufakture/io';
import { expect, test, type Download, type Page } from '@playwright/test';
import { addVariable, bodyVolume, openEmpty, regenerated } from './bracket';

// A shelf board whose width is the variable #width, configured in rows 600, 800 and 1000 mm
// through the Configurations panel. Switching rows in the toolbar rebuilds the board at each
// width (exact volumes); a row edit is one undo step; and "Every configuration" exports three
// 3MF files, one per row, each with its own bounding box.

const DEPTH = 300;
const THICKNESS = 18;
const WIDTHS = [600, 800, 1000] as const;

const mm = (source: string) => ({ source, lengthUnit: 'mm', angleUnit: 'deg' });

/** The board: a rectangle on Top dimensioned #width by 300 mm, extruded 18 mm. */
async function buildBoard(page: Page): Promise<void> {
  await addVariable(page, 'width', '600');
  const corners: [number, number][] = [
    [0, 0],
    [600, 0],
    [600, DEPTH],
    [0, DEPTH],
  ];
  const sketch = {
    id: 'sketch#1',
    kind: 'sketch',
    name: 'Sketch 1',
    suppressed: false,
    plane: { type: 'plane', origin: [0, 0, 0], normal: [0, 0, 1], xDir: [1, 0, 0] },
    entities: corners.map((start, i) => ({
      id: `e${i + 1}`,
      kind: 'line',
      construction: false,
      start,
      end: corners[(i + 1) % 4]!,
    })),
    constraints: [
      ...[1, 2, 3, 4].map((n) => ({
        id: `k${n}`,
        kind: 'coincident',
        a: { entity: `e${n}`, at: 'end' },
        b: { entity: `e${(n % 4) + 1}`, at: 'start' },
      })),
      { id: 'k5', kind: 'horizontal', line: 'e1' },
      { id: 'k6', kind: 'vertical', line: 'e2' },
      { id: 'k7', kind: 'horizontal', line: 'e3' },
      { id: 'k8', kind: 'vertical', line: 'e4' },
      { id: 'k9', kind: 'fix', point: { entity: 'e1', at: 'start' } },
      {
        id: 'k10',
        kind: 'distance',
        a: { entity: 'e1', at: 'start' },
        b: { entity: 'e1', at: 'end' },
        value: mm('#width'),
      },
      {
        id: 'k11',
        kind: 'distance',
        a: { entity: 'e2', at: 'start' },
        b: { entity: 'e2', at: 'end' },
        value: mm(`${DEPTH} mm`),
      },
    ],
  };
  const extrude = {
    id: 'extrude#1',
    kind: 'extrude',
    name: 'Board',
    suppressed: false,
    profile: { sketch: 'sketch#1' },
    operation: 'new',
    extent: { type: 'blind', distance: mm(`${THICKNESS} mm`) },
    reverse: false,
  };
  const done = await page.evaluate(
    ([s, e]) => {
      const store = window.__manufakture!.document.getState();
      return [
        store.execute({ type: 'addFeature', partId: 'part#1', feature: s }, 'Add Sketch 1').ok,
        window
          .__manufakture!.document.getState()
          .execute({ type: 'addFeature', partId: 'part#1', feature: e }, 'Add Board').ok,
      ];
    },
    [sketch, extrude] as const,
  );
  expect(done).toEqual([true, true]);
  const statuses = await regenerated(page);
  expect(statuses['extrude#1']).toMatchObject({ status: 'ok', errors: [] });
}

const panel = (page: Page) => page.getByRole('complementary', { name: 'Configurations' });

/** Set a row's #width cell (a bare number, which gets its unit) and commit it with Enter. */
async function setWidth(page: Page, rowId: string, value: string): Promise<void> {
  const cell = page.getByTestId(`config-cell-${rowId}-cp#1`);
  await cell.fill(value);
  await cell.press('Enter');
  await expect
    .poll(() =>
      page.evaluate(
        (id) =>
          (
            window.__manufakture!.document.getState().document as unknown as {
              configurations?: {
                rows: { id: string; values: Record<string, { source: string }> }[];
              };
            }
          ).configurations?.rows.find((r) => r.id === id)?.values['cp#1']?.source,
        rowId,
      ),
    )
    .toBe(`${value} mm`);
}

/** Choose a row in the toolbar's switcher and wait for the model to show it. */
async function show(page: Page, row: string): Promise<void> {
  await page.getByTestId('configuration-switcher').selectOption({ label: row });
  await regenerated(page);
}

const boardVolume = (width: number) => width * DEPTH * THICKNESS;

test('configurations: a shelf board in three widths, switched, edited, exported', async ({
  page,
}) => {
  const errors = await openEmpty(page);
  await buildBoard(page);
  expect(await bodyVolume(page)).toBeCloseTo(boardVolume(600), 3);

  // The table: #width as a parameter, three rows named after their widths.
  await expect(panel(page)).toContainText('Variants of this design');
  await page.getByTestId('config-add-parameter').selectOption({ label: '#width' });
  await expect(page.getByTestId('config-param-cp#1')).toContainText('#width');
  for (const [i, width] of WIDTHS.entries()) {
    await page.getByTestId('config-add-row').click();
    const name = panel(page).getByLabel(`Name of configuration Configuration ${i + 1}`);
    await name.fill(String(width));
    await name.press('Enter');
    await expect(panel(page).getByLabel(`Name of configuration ${width}`)).toBeVisible();
    await setWidth(page, `cfg#${i + 1}`, String(width));
  }
  // The switcher lists them; nothing is shown in a configuration yet.
  const switcher = page.getByTestId('configuration-switcher');
  await expect(switcher.locator('option')).toHaveText(['None (as modelled)', '600', '800', '1000']);
  await expect(switcher).toHaveValue('');

  // Switching rows rebuilds the board at each width, exactly.
  for (const width of [800, 1000, 600] as const) {
    await show(page, String(width));
    expect(await bodyVolume(page)).toBeCloseTo(boardVolume(width), 3);
  }
  await expect(page.getByTestId('config-row-cfg#1-shown')).toBeVisible();
  // The Variables panel says #width is configured, and its value in the shown row.
  await show(page, '1000');
  await expect(page.getByTestId('variable-width-configured')).toHaveText('In 1000: 1000.00 mm');

  // A row edit is one undo step: 1000 becomes 1200, then back.
  await setWidth(page, 'cfg#3', '1200');
  await regenerated(page);
  expect(await bodyVolume(page)).toBeCloseTo(boardVolume(1200), 3);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toHaveAttribute(
    'title',
    'Undo Set width in configuration 1000 (Ctrl+Z)',
  );
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByTestId('config-cell-cfg#3-cp#1')).toHaveValue('1000 mm');
  await regenerated(page);
  expect(await bodyVolume(page)).toBeCloseTo(boardVolume(1000), 3);

  // Every configuration: three 3MF files, one per row, each from its own regen.
  const downloads: Download[] = [];
  page.on('download', (d) => downloads.push(d));
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await page.getByTestId('export-every-configuration').check();
  await expect(page.getByTestId('export-stl-each')).toBeDisabled();
  await page.getByTestId('export-3mf').click();
  await expect(page.getByTestId('io-status')).toHaveText(
    'Exported 3 of 3 configurations: Untitled-600.3mf, Untitled-800.3mf, Untitled-1000.3mf.',
    { timeout: 90_000 },
  );
  await expect.poll(() => downloads.length).toBe(3);
  expect(downloads.map((d) => d.suggestedFilename())).toEqual([
    'Untitled-600.3mf',
    'Untitled-800.3mf',
    'Untitled-1000.3mf',
  ]);
  for (const [i, width] of WIDTHS.entries()) {
    const bytes = new Uint8Array(await readFile(await downloads[i]!.path()));
    const report = validate3mf(bytes);
    expect(report.problems).toEqual([]);
    expect(report.parsed!.objects).toHaveLength(1);
    const p = report.parsed!.objects[0]!.mesh.positions;
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let j = 0; j < p.length; j += 3) {
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k]!, p[j + k]!);
        max[k] = Math.max(max[k]!, p[j + k]!);
      }
    }
    const size = max.map((x, k) => x - min[k]!);
    expect(size[0]).toBeCloseTo(width, 3);
    expect(size[1]).toBeCloseTo(DEPTH, 3);
    expect(size[2]).toBeCloseTo(THICKNESS, 3);
    expect(report.objects[0]!.manifold.volume / boardVolume(width)).toBeCloseTo(1, 4);
  }

  // Afterwards the shown row is built again, and the board is the 1000 mm one.
  await expect(page.getByTestId('export-progress')).toBeHidden();
  await regenerated(page);
  expect(await bodyVolume(page)).toBeCloseTo(boardVolume(1000), 3);
  expect(errors).toEqual([]);
});
