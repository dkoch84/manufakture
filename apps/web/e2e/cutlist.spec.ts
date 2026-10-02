import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { openEmpty, regenerated } from './bracket';
import { execute } from './m2-fixtures';

// The Cut list panel (M4 plan T4.3d) on real boards in an inch document:
// - Bookshelf A (nesting fixtures): two 3/4" plywood sides 72" x 11-1/4" and five 29" x 11-1/4"
//   parts (top, bottom, three shelves) give the hand-computed table: 2 sides of 11.25 sq ft
//   (2 x 72 x 11.25 = 1620 sq in) and 5 parts of 11.33 sq ft (5 x 29 x 11.25 = 1631.25 sq in),
//   all on one 4' x 8' sheet. The CSV is exact; the PDF has the list and the sheet, numbered.
// - Four 24" x 48" MDF panels: one sheet with no kerf, two once the kerf is 1/8" (24 + 1/8 + 24 is
//   more than 48, so only three fit a sheet; `fourPanels` in the nesting fixtures).

const INCH = 25.4;

const ground = (z: number) =>
  ({ type: 'plane', origin: [0, 0, z], normal: [0, 0, 1], xDir: [1, 0, 0] }) as const;

/** A closed rectangle sketch, `w` by `d` inches, at height `z` mm; entity ids from `first`. */
function rectangle(id: string, name: string, z: number, first: number, w: number, d: number) {
  const c: [number, number][] = [
    [0, 0],
    [w * INCH, 0],
    [w * INCH, d * INCH],
    [0, d * INCH],
  ];
  return {
    type: 'addFeature',
    partId: 'part#1',
    feature: {
      id,
      kind: 'sketch',
      name,
      suppressed: false,
      plane: ground(z),
      entities: c.map((start, i) => ({
        id: `e${first + i}`,
        kind: 'line',
        construction: false,
        start,
        end: c[(i + 1) % 4]!,
      })),
      constraints: [],
    },
  };
}

function panel(n: number, name: string, sketchId: string, stock: string) {
  return {
    type: 'addFeature',
    partId: 'part#1',
    feature: {
      id: `extension#${n}`,
      kind: 'extension',
      name,
      suppressed: false,
      extension: 'wood.board',
      schemaVersion: 1,
      operation: 'new',
      dependsOn: [sketchId],
      references: [],
      expressions: {},
      params: { sketch: sketchId, form: 'panel', stock },
    },
  };
}

const INCH_UNITS = {
  type: 'setDisplayUnits',
  units: { length: { unit: 'in-fraction', denominator: 16 }, angle: { unit: 'deg' } },
};

/** Boards from `[name, w, d]` rectangles, one sketch and one panel each. */
async function boards(
  page: Page,
  stock: string,
  parts: [string, number, number][],
  extra: unknown[] = [],
) {
  const commands: unknown[] = [INCH_UNITS, ...extra];
  parts.forEach(([name, w, d], i) => {
    commands.push(rectangle(`sketch#${i + 1}`, `${name} outline`, i * 30, 4 * i + 1, w, d));
    commands.push(panel(i + 1, name, `sketch#${i + 1}`, stock));
  });
  await execute(page, { type: 'batch', commands }, 'Boards');
  await regenerated(page);
  await page.waitForFunction(
    (n) => window.__manufakture!.model.getState().parts[0]!.bodies.length === n,
    parts.length,
  );
}

async function openCutList(page: Page) {
  await page.getByTestId('open-cutlist').click();
  return page.getByRole('complementary', { name: 'Cut list' });
}

async function downloaded(page: Page, click: () => Promise<void>): Promise<Buffer> {
  const [download] = await Promise.all([page.waitForEvent('download'), click()]);
  return readFile((await download.path())!);
}

test('cut list: the bookshelf table, its sheet, the CSV and the PDF', async ({ page }) => {
  const errors = await openEmpty(page);
  await boards(page, 'us-ply-23-32', [
    ['Side 1', 72, 11.25],
    ['Side 2', 72, 11.25],
    ['Top', 29, 11.25],
    ['Bottom', 29, 11.25],
    ['Shelf 1', 29, 11.25],
    ['Shelf 2', 29, 11.25],
    ['Shelf 3', 29, 11.25],
  ]);
  const panelEl = await openCutList(page);
  const rows = panelEl.getByTestId('cutlist-row');
  await expect(rows).toHaveCount(2);
  const cells = async () =>
    Promise.all(
      (await rows.all()).map(async (r) => [
        await r.getByTestId('cutlist-item').textContent(),
        await r.getByTestId('cutlist-size').textContent(),
        await r.getByTestId('cutlist-qty').textContent(),
        await r.getByTestId('cutlist-total').textContent(),
      ]),
    );
  expect(await cells()).toEqual([
    ['Side 1, 2', '72" x 11-1/4" x 23/32"', '2', '11.25 sq ft'],
    ['Top, Bottom, Shelf 1-3', '29" x 11-1/4" x 23/32"', '5', '11.33 sq ft'],
  ]);
  await expect(panelEl.getByTestId('cutlist-totals')).toContainText(
    'Sheet goods: 22.58 sq ft, 7 pcs',
  );

  // Clicking a row selects its two bodies.
  await rows.first().click();
  const selected = await page.evaluate(() => [
    ...new Set(
      window
        .__manufakture!.selection.getState()
        .selected.map((s) => (s as unknown as { bodyId: string }).bodyId),
    ),
  ]);
  expect(selected).toEqual(['part#1/extension#1', 'part#1/extension#2']);

  // One sheet, from the nesting worker.
  await panelEl.getByTestId('cutlist-tab-layouts').click();
  await expect(panelEl.getByTestId('cutlist-sheet')).toHaveCount(1, { timeout: 30_000 });
  await expect(panelEl.getByTestId('cutlist-sheets-us-ply-23-32')).toContainText(
    '3/4" plywood: 1 sheet',
  );

  const csv = await downloaded(page, () => panelEl.getByTestId('cutlist-csv').click());
  expect(csv.toString('utf8')).toBe(
    [
      '#,Item,Stock,Material,Length,Width,Thickness,Quantity,Total,Flags,Bodies',
      '1,"Side 1, Side 2","3/4"" plywood",Plywood (birch),"72""","11-1/4""","23/32""",2,11.25 sq ft,,extension#1 extension#2',
      '2,"Top, Bottom, Shelf 1, Shelf 2, Shelf 3","3/4"" plywood",Plywood (birch),"29""","11-1/4""","23/32""",5,11.33 sq ft,,extension#3 extension#4 extension#5 extension#6 extension#7',
      '',
    ].join('\r\n'),
  );

  const pdfBytes = await downloaded(page, () => panelEl.getByTestId('cutlist-pdf').click());
  const pdf = await getDocument({ data: new Uint8Array(pdfBytes), verbosity: 0 }).promise;
  expect(pdf.numPages).toBe(2);
  const text = async (n: number) =>
    (await (await pdf.getPage(n)).getTextContent()).items
      .map((i) => ('str' in i ? i.str : ''))
      .filter((s) => s !== '');
  expect((await text(1)).join(' ')).toContain('Top, Bottom, Shelf 1-3');
  const sheet = await text(2);
  expect(sheet).toContain('3/4" plywood: sheet 1 of 1');
  expect(sheet.filter((s) => s === '1')).toHaveLength(2);
  expect(sheet.filter((s) => s === '2')).toHaveLength(5);
  await pdf.cleanup();
  expect(errors).toEqual([]);
});

test('cut list: four 24" x 48" panels take one sheet with no kerf and two with a 1/8" kerf', async ({
  page,
}) => {
  const errors = await openEmpty(page);
  const noKerf = {
    type: 'setDomainData',
    namespace: 'wood',
    schemaVersion: 1,
    data: { kerf: { source: '0', lengthUnit: 'in', angleUnit: 'deg' } },
  };
  await boards(
    page,
    'us-mdf-3-4',
    [
      ['Panel 1', 48, 24],
      ['Panel 2', 48, 24],
      ['Panel 3', 48, 24],
      ['Panel 4', 48, 24],
    ],
    [noKerf],
  );
  const panelEl = await openCutList(page);
  await expect(panelEl.getByTestId('cutlist-item')).toHaveText(['Panel 1-4']);
  await panelEl.getByTestId('cutlist-tab-layouts').click();
  const sheets = panelEl.getByTestId('cutlist-sheets-us-mdf-3-4');
  await expect(sheets).toContainText('1 sheet', { timeout: 30_000 });
  await expect(panelEl.getByTestId('cutlist-sheet')).toHaveCount(1);

  await panelEl.getByText('Saw and layout settings').click();
  await panelEl.getByTestId('cutlist-kerf').fill('1/8');
  await panelEl.getByTestId('cutlist-settings-save').click();
  await expect(sheets).toContainText('2 sheets', { timeout: 30_000 });
  await expect(sheets).toContainText('Kerf 1/8"');
  await expect(panelEl.getByTestId('cutlist-sheet')).toHaveCount(2);

  // One undo step puts the kerf back.
  await page.evaluate(() => window.__manufakture!.document.getState().undo());
  await expect(sheets).toContainText('1 sheet', { timeout: 30_000 });
  expect(errors).toEqual([]);
});
