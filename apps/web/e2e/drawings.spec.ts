import { readFile } from 'node:fs/promises';
import DxfParser from 'dxf-parser';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { expect, test, type Page } from '@playwright/test';
import { BRACKET, buildBracket, editVariable, openEmpty, regenerated } from './bracket';
import { saved } from './m2-fixtures';

// The drawing workspace (M4 plan, T4.4g) with the real regen worker: the M1 bracket, built through
// the UI, drawn on an A4 sheet in three views (front, then top and right projected from it,
// aligned), dimensioned by picking edges and vertices in the views (four dimensions, two of them
// the wall `#thickness`), then `#thickness` changed from 6 to 8 and the dimensions follow. The
// sheet is exported as SVG, DXF and PDF and each file read back with T4.4f's parsers (dxf-parser
// and pdfjs-dist, as the writers' own tests do); a dimension is undone and redone; and the drawing
// survives a reload.

const T0 = 6;
const T1 = 8;
const D = 'drawing#1';

interface E2eDrawingView {
  id: string;
  direction: unknown;
  position: [number, number];
}

interface E2eDrawing {
  id: string;
  name: string;
  sheets: { id: string; views: E2eDrawingView[]; dimensions: { id: string; kind: string }[] }[];
}

function drawing(page: Page): Promise<E2eDrawing | undefined> {
  return page.evaluate(
    () =>
      (
        window.__manufakture!.document.getState().document as unknown as {
          drawings?: E2eDrawing[];
        }
      ).drawings?.[0],
  );
}

/** The sheet, drawn for the document as it is now. */
async function sheetReady(page: Page): Promise<void> {
  await regenerated(page);
  await expect(page.getByTestId('drawing-sheet')).toHaveAttribute('data-state', 'ready', {
    timeout: 60_000,
  });
}

/** Where a paper point (mm from the sheet's bottom left) is on the page. */
async function toPage(page: Page, p: [number, number]): Promise<{ x: number; y: number }> {
  const sheet = page.getByTestId('drawing-sheet');
  const box = (await sheet.boundingBox())!;
  const w = Number(await sheet.getAttribute('data-width'));
  const h = Number(await sheet.getAttribute('data-height'));
  return { x: box.x + (p[0] / w) * box.width, y: box.y + ((h - p[1]) / h) * box.height };
}

async function clickPaper(page: Page, p: [number, number]): Promise<void> {
  const { x, y } = await toPage(page, p);
  await page.mouse.click(x, y);
}

/** A point of a view at 1:1 on paper: its model origin's position plus its view coordinates. */
const on = (view: E2eDrawingView, v: [number, number]): [number, number] => [
  view.position[0] + v[0],
  view.position[1] + v[1],
];

/** Dimension by picking `picks` in a view, then clicking `place` (all paper mm). */
async function dimension(
  page: Page,
  kind: string,
  picks: [number, number][],
  place: [number, number],
): Promise<void> {
  await page.getByTestId('drawing-dimension-kind').selectOption(kind);
  const before = (await drawing(page))!.sheets[0]!.dimensions.length;
  for (const [i, p] of picks.entries()) {
    await clickPaper(page, p);
    await expect(page.getByTestId(`drawing-pick-${i}`)).toBeVisible();
  }
  await clickPaper(page, place);
  await expect
    .poll(async () => (await drawing(page))!.sheets[0]!.dimensions.length)
    .toBe(before + 1);
}

async function values(page: Page): Promise<Record<string, string>> {
  await sheetReady(page);
  const list = page.getByTestId('drawing-dimensions');
  const out: Record<string, string> = {};
  for (const id of ['dim#1', 'dim#2', 'dim#3', 'dim#4']) {
    await expect(list.getByTestId(`drawing-dimension-status-${id}`)).toHaveText('OK');
    out[id] = (await list.getByTestId(`drawing-dimension-value-${id}`).textContent())!.trim();
  }
  return out;
}

async function save(page: Page, format: 'svg' | 'dxf' | 'pdf') {
  const [file] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId(`drawing-export-${format}`).click(),
  ]);
  return {
    name: file.suggestedFilename(),
    bytes: new Uint8Array(await readFile(await file.path())),
  };
}

const number = (text: string) => Number(/[0-9.]+/.exec(text)![0]);

test('drawings: the bracket in three views, four dimensions, #thickness 6 to 8, export, undo, reload', async ({
  page,
}) => {
  test.setTimeout(240_000);
  const errors = await openEmpty(page);
  await buildBracket(page, T0);
  await regenerated(page);

  // --- A new drawing: A4 landscape with a title block, a front view ----------------------------
  await page.getByTestId('drawing-add').click();
  await page.getByTestId('drawing-new-name').fill('Bracket');
  await page.getByTestId('drawing-new-size').selectOption('A4');
  await page.getByTestId('drawing-new-field-Drawn by').fill('E2E');
  await page.getByTestId('drawing-new-create').click();
  await expect(page.getByTestId(`drawing-tab-${D}`)).toHaveAttribute('aria-selected', 'true');
  await page.getByTestId('drawing-insert-direction').selectOption('front');
  await page.getByTestId('drawing-insert-scale').fill('1:1');
  await page.getByTestId('drawing-insert-ok').click();
  await page.getByTestId('drawing-insert-close').click();
  await sheetReady(page);
  await expect(page.getByTestId('drawing-sheet')).toContainText('E2E');

  // --- Top and right views, projected from the front so they stay aligned with it --------------
  const front = (await drawing(page))!.sheets[0]!.views[0]!;
  await clickPaper(page, on(front, [BRACKET.length / 2, T0 / 2]));
  await expect(page.getByTestId('drawing-view-panel')).toBeVisible();
  await page.getByTestId('drawing-project-top').click();
  await clickPaper(page, on(front, [BRACKET.length / 2, T0 / 2]));
  await page.getByTestId('drawing-project-right').click();
  let views = (await drawing(page))!.sheets[0]!.views;
  expect(views.map((v) => v.direction)).toEqual(['front', 'top', 'right']);
  const [, top, right] = views as [E2eDrawingView, E2eDrawingView, E2eDrawingView];
  expect(top.position[0]).toBe(front.position[0]);
  expect(right.position[1]).toBe(front.position[1]);
  await sheetReady(page);
  for (const v of views) {
    await expect(
      page.getByTestId('drawing-sheet').locator(`path[data-owner="${v.id}"]`).first(),
    ).toBeAttached();
  }

  // --- Four dimensions, by picking -------------------------------------------------------------
  // Front view: x is model X, y is model Z. Top view: x is X, y is Y.
  await page.getByTestId('drawing-tool-dimension').click();
  const { length: L, height: Ht } = BRACKET;
  await dimension(
    page,
    'horizontal',
    [on(front, [0, 0]), on(front, [L, 0])],
    on(front, [L / 2, -12]),
  );
  await dimension(
    page,
    'vertical',
    [on(front, [L, 0]), on(front, [L, T0])],
    on(front, [L + 8, T0 / 2]),
  );
  await dimension(
    page,
    'horizontal',
    [on(front, [0, Ht]), on(front, [T0, Ht])],
    on(front, [T0 / 2, Ht + 6]),
  );
  const counterbore = BRACKET.hole.headDiameter / 2;
  await dimension(
    page,
    'diameter',
    [on(top, [BRACKET.holes[0] - counterbore, 0])],
    on(top, [BRACKET.holes[0] - 14, 14]),
  );
  const dims = (await drawing(page))!.sheets[0]!.dimensions;
  expect(dims.map((d) => d.kind)).toEqual(['horizontal', 'vertical', 'horizontal', 'diameter']);
  const before = await values(page);
  expect(Object.values(before).map(number)).toEqual([L, T0, T0, BRACKET.hole.headDiameter]);
  await expect(page.getByTestId('drawing-sheet')).toHaveAttribute('data-dimensions', '4');

  // --- Undo and redo the last dimension --------------------------------------------------------
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(async () => (await drawing(page))!.sheets[0]!.dimensions.length).toBe(3);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect.poll(async () => (await drawing(page))!.sheets[0]!.dimensions.length).toBe(4);

  // --- #thickness 6 to 8: the wall dimensions follow; the others stay --------------------------
  await page.getByTestId('part-tab-part#1').click();
  await expect(page.getByTestId('drawing-workspace')).toHaveCount(0);
  await editVariable(page, 'thickness', String(T1));
  await regenerated(page);
  await page.getByTestId(`drawing-tab-${D}`).click();
  const after = await values(page);
  expect(Object.values(after).map(number)).toEqual([L, T1, T1, BRACKET.hole.headDiameter]);

  // --- Export, and read each file back -----------------------------------------------------------
  const svg = await save(page, 'svg');
  expect(svg.name).toBe('Bracket - Sheet 1.svg');
  const svgText = new TextDecoder().decode(svg.bytes);
  expect(svgText).toMatch(/^<\?xml[^>]*>\s*<svg [^>]*width="297mm" height="210mm"/);
  for (const id of ['view#1', 'view#2', 'view#3', 'dim#1', 'dim#4']) {
    expect(svgText).toContain(`data-owner="${id}"`);
  }
  // The linear values as written (a diameter's sign is spelled per format, so it is left out).
  const linear = [after['dim#1']!, after['dim#2']!, after['dim#3']!];
  for (const v of linear) expect(svgText).toContain(`>${v}</text>`);

  const dxf = await save(page, 'dxf');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dxf-parser's types are loose
  const parsed: any = new DxfParser().parseSync(new TextDecoder().decode(dxf.bytes));
  const layers = Object.keys(parsed.tables.layer.layers);
  expect(layers).toEqual(expect.arrayContaining(['visible', 'hidden', 'dimension', 'text']));
  const texts = parsed.entities
    .filter((e: { type: string }) => e.type === 'TEXT')
    .map((e: { text: string }) => e.text);
  expect(texts).toEqual(expect.arrayContaining(linear));
  expect(
    parsed.entities.filter((e: { layer: string }) => e.layer === 'visible').length,
  ).toBeGreaterThan(10);

  const pdf = await save(page, 'pdf');
  expect(pdf.name).toBe('Bracket.pdf');
  const doc = await getDocument({ data: pdf.bytes.slice(), verbosity: 0 }).promise;
  expect(doc.numPages).toBe(1);
  const p1 = await doc.getPage(1);
  const vp = p1.getViewport({ scale: 1 });
  expect([vp.width, vp.height].map((v) => Math.round(v))).toEqual([842, 595]);
  const content = await p1.getTextContent();
  const pdfText = content.items.map((i) => ('str' in i ? i.str : '')).join(' ');
  for (const v of linear) expect(pdfText).toContain(v);
  expect(pdfText).toContain('E2E');

  // --- Reload: the drawing, its views and dimensions come back ---------------------------------
  await saved(page);
  await page.reload();
  await regenerated(page);
  await page.getByTestId(`drawing-tab-${D}`).click();
  views = (await drawing(page))!.sheets[0]!.views;
  expect(views).toHaveLength(3);
  expect(await values(page)).toEqual(after);
  expect(errors).toEqual([]);
});
