import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { execute } from './m2-fixtures';
import { openEmpty, regenerated } from './bracket';
import { FT_IN_UNITS, SHED, WALLS } from './shed-fixture';

// The construction drawing set end to end (M6 plan T6.4b): T6.3a's 12' x 16' shed in a
// feet-and-inches document, a new drawing, then New construction set. The set's sheets are a plan
// of the level, the four elevations, a framing elevation of each wall and the roof framing plan.
// The plan shows three dimension strings outside each wall with openings (opening centres, rough
// openings, overall) and the overall alone outside the plain walls, in ft-in; the front wall's
// framing elevation draws every member of the wall's member list at its size; a string converted
// to dimensions reads the same values as ordinary dimensions; the PDF of the whole set parses back
// with the disclaimer in every title block.

const DISCLAIMER = [
  'Not an engineering tool: manufakture lays out framing by rules you choose.',
  'Provided without warranty under GPL-3.0-or-later.',
];

interface E2eSheet {
  id: string;
  name: string;
  views: { id: string; position: [number, number] }[];
  dimensions: { id: string }[];
}

let page: Page;
let errors: string[];

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  errors = await openEmpty(page);
});

test.afterAll(async () => {
  expect(errors).toEqual([]);
  await page.close();
});

function sheets(): Promise<E2eSheet[]> {
  return page.evaluate(
    () =>
      (
        window.__manufakture!.document.getState().document as unknown as {
          drawings?: { sheets: E2eSheet[] }[];
        }
      ).drawings?.[0]?.sheets ?? [],
  );
}

async function sheetReady(): Promise<void> {
  await regenerated(page);
  await expect(page.getByTestId('drawing-sheet')).toHaveAttribute('data-state', 'ready', {
    timeout: 90_000,
  });
}

async function showSheet(name: string): Promise<E2eSheet> {
  const sheet = (await sheets()).find((s) => s.name === name)!;
  expect(sheet, name).toBeDefined();
  await page.getByTestId(`drawing-sheet-tab-${sheet.id}`).click();
  await sheetReady();
  return sheet;
}

/** The texts the sheet draws for `owner` (a string's or a dimension's), in order. */
function texts(owner: string): Promise<string[]> {
  return page.evaluate(
    (o) =>
      [...document.querySelectorAll('[data-testid="drawing-sheet"] .drawing-svg text')]
        .filter((t) => t.getAttribute('data-owner') === o)
        .map((t) => t.textContent ?? ''),
    owner,
  );
}

/** Every string owner the sheet draws for a view. */
function stringOwners(viewId: string): Promise<string[]> {
  return page.evaluate((v) => {
    const owners = [
      ...document.querySelectorAll('[data-testid="drawing-sheet"] .drawing-svg [data-owner]'),
    ].map((e) => e.getAttribute('data-owner')!);
    return [...new Set(owners.filter((o) => o.startsWith(`${v}/`)))].sort();
  }, viewId);
}

test("the shed's set is created", async () => {
  await execute(page, FT_IN_UNITS, 'Feet and inches');
  await execute(page, SHED, 'The shed');
  const status = await regenerated(page);
  for (const id of [...WALLS, 'extension#5', 'extension#6', 'extension#7', 'extension#9'])
    expect(status[id]?.status, `${id}: ${JSON.stringify(status[id])}`).toBe('ok');

  await page.getByTestId('drawing-add').click();
  await page.getByTestId('drawing-new-name').fill('Shed set');
  await page.getByTestId('drawing-new-create').click();
  await page.getByTestId('drawing-construction-set').click();
  await expect(page.getByTestId('construction-set-panel')).toBeVisible();
  await expect(page.getByTestId('construction-set-size')).toHaveValue('tabloid');
  await page.getByTestId('construction-set-create').click();
  await expect(page.getByTestId('drawing-status')).toContainText('Added 7 sheets');
  expect((await sheets()).map((s) => s.name)).toEqual([
    'Plan: Level 1',
    'Elevations',
    'Framing: Front',
    'Framing: Back',
    'Framing: Right',
    'Framing: Left',
    'Roof framing: Roof',
  ]);
  // The first sheet of the set is shown; nothing else has been drawn yet.
  await sheetReady();
  await expect(page.getByTestId('drawing-sheet')).toContainText(`1/4" = 1'`);
});

test('the plan shows three dimension strings per wall with openings, in ft-in', async () => {
  const plan = await showSheet('Plan: Level 1');
  const v = plan.views[0]!.id;
  const s = (wall: string, what: string) => texts(`${v}/${wall}:s1:${what}`);
  // Front: windows 2' wide centred 4' and 12' along.
  expect(await s('extension#1', 'centres')).toEqual([`4' 0"`, `8' 0"`, `4' 0"`]);
  expect(await s('extension#1', 'openings')).toEqual([`3' 0"`, `2' 0"`, `6' 0"`, `2' 0"`, `3' 0"`]);
  expect(await s('extension#1', 'overall')).toEqual([`16' 0"`]);
  // Right: the 3' door centred 6' along.
  expect(await s('extension#3', 'centres')).toEqual([`6' 0"`, `6' 0"`]);
  expect(await s('extension#3', 'openings')).toEqual([`4' 6"`, `3' 0"`, `4' 6"`]);
  expect(await s('extension#3', 'overall')).toEqual([`12' 0"`]);
  // The plain walls: their overall alone (the other two strings would repeat it).
  expect(await s('extension#2', 'overall')).toEqual([`16' 0"`]);
  expect(await s('extension#4', 'overall')).toEqual([`12' 0"`]);
  expect(await stringOwners(v)).toEqual(
    [
      'extension#1:s1:centres',
      'extension#1:s1:openings',
      'extension#1:s1:overall',
      'extension#2:s1:overall',
      'extension#3:s1:centres',
      'extension#3:s1:openings',
      'extension#3:s1:overall',
      'extension#4:s1:overall',
    ].map((id) => `${v}/${id}`),
  );
  // The title block carries the disclaimer.
  await expect(page.getByTestId('drawing-sheet')).toContainText('Not an engineering tool');
});

test('a string converts to ordinary dimensions with the same values', async () => {
  const plan = (await sheets())[0]!;
  const v = plan.views[0]!.id;
  // Select the plan view: click in the middle of the building.
  const at = await page.evaluate(
    ([vid, pos]) => {
      const sheet = (
        (window.__manufakture as unknown as { drawingSheet: unknown }).drawingSheet as {
          sheet(): {
            views: {
              viewId: string;
              bounds: { min: number[]; max: number[] };
              scale: { paper: number; model: number };
            }[];
          };
        }
      ).sheet();
      const view = sheet.views.find((x) => x.viewId === vid)!;
      const s = view.scale.paper / view.scale.model;
      return [
        pos[0] + (s * (view.bounds.min[0]! + view.bounds.max[0]!)) / 2,
        pos[1] + (s * (view.bounds.min[1]! + view.bounds.max[1]!)) / 2,
      ];
    },
    [v, plan.views[0]!.position] as const,
  );
  const sheetEl = page.getByTestId('drawing-sheet');
  const box = (await sheetEl.boundingBox())!;
  const w = Number(await sheetEl.getAttribute('data-width'));
  const h = Number(await sheetEl.getAttribute('data-height'));
  await page.mouse.click(box.x + (at[0]! / w) * box.width, box.y + ((h - at[1]!) / h) * box.height);
  await expect(page.getByTestId('construction-strings')).toBeVisible();
  await page.getByTestId('construction-string-convert-extension#1:s1:openings').click();
  await expect(page.getByTestId('construction-string-show-extension#1:s1:openings')).toBeVisible();
  await sheetReady();
  expect(await texts(`${v}/extension#1:s1:openings`)).toEqual([]);
  const list = page.getByTestId('drawing-dimensions');
  const values: string[] = [];
  for (const id of ['dim#1', 'dim#2', 'dim#3', 'dim#4', 'dim#5'])
    values.push((await list.getByTestId(`drawing-dimension-value-${id}`).textContent())!.trim());
  expect(values).toEqual([`3' 0"`, `2' 0"`, `6' 0"`, `2' 0"`, `3' 0"`]);
  // One undo step puts the string back and the dimensions away.
  await page.evaluate(() => window.__manufakture!.document.getState().undo());
  await sheetReady();
  expect(await texts(`${v}/extension#1:s1:openings`)).toHaveLength(5);
  expect((await sheets())[0]!.dimensions).toEqual([]);
});

test("a framing elevation draws every member of the wall's member list", async () => {
  const sheet = await showSheet('Framing: Front');
  const v = sheet.views[0]!.id;
  const check = await page.evaluate((vid) => {
    type V3 = [number, number, number];
    interface Member {
      id: string;
      role: string;
      length: number;
      stock: { width: number; depth: number };
      placement: { origin: V3; x: V3; y: V3 };
    }
    const hooks = window.__manufakture as unknown as {
      members: { getState(): { parts: Map<string, { group: string; members: Member[] }[]> } };
      drawingSheet: {
        sheet(): {
          views: {
            viewId: string;
            frame: { origin: V3; x: V3; y: V3 };
            input: { overlay?: { curve: { kind: string; a: number[]; b: number[] } }[] };
          }[];
        };
      };
    };
    const set = hooks.members
      .getState()
      .parts.get('part#1')!
      .find((s) => s.group === 'extension#1')!;
    const view = hooks.drawingSheet.sheet().views.find((x) => x.viewId === vid)!;
    const f = view.frame;
    const P = (p: V3) => {
      const r = [p[0] - f.origin[0], p[1] - f.origin[1], p[2] - f.origin[2]];
      return [
        r[0]! * f.x[0] + r[1]! * f.x[1] + r[2]! * f.x[2],
        r[0]! * f.y[0] + r[1]! * f.y[1] + r[2]! * f.y[2],
      ];
    };
    const lines = (view.input.overlay ?? [])
      .filter((o) => o.curve.kind === 'line')
      .map((o) => [o.curve.a, o.curve.b]);
    const near = (a: number[], b: number[]) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!) < 1e-3;
    const missing: string[] = [];
    const roles: Record<string, number> = {};
    for (const m of set.members) {
      roles[m.role] = (roles[m.role] ?? 0) + 1;
      const { origin: o, x, y } = m.placement;
      const z: V3 = [
        x[1] * y[2] - x[2] * y[1],
        x[2] * y[0] - x[0] * y[2],
        x[0] * y[1] - x[1] * y[0],
      ];
      const corners: number[][] = [];
      for (const a of [0, m.length])
        for (const b of [0, m.stock.width])
          for (const c of [0, m.stock.depth])
            corners.push(P([0, 1, 2].map((i) => o[i]! + a * x[i]! + b * y[i]! + c * z[i]!) as V3));
      const xs = corners.map((p) => p[0]!);
      const ys = corners.map((p) => p[1]!);
      const box = [
        [Math.min(...xs), Math.min(...ys)],
        [Math.max(...xs), Math.min(...ys)],
        [Math.max(...xs), Math.max(...ys)],
        [Math.min(...xs), Math.max(...ys)],
      ];
      for (let i = 0; i < 4; i++) {
        const a = box[i]!;
        const b = box[(i + 1) % 4]!;
        if (!lines.some(([p, q]) => (near(p!, a) && near(q!, b)) || (near(p!, b) && near(q!, a))))
          missing.push(`${m.id} edge ${i}`);
      }
    }
    return { members: set.members.length, roles, missing };
  }, v);
  expect(check.missing).toEqual([]);
  expect(check.members).toBeGreaterThan(20);
  expect(check.roles.stud).toBeGreaterThan(5);
  // Its string along the bottom: the windows' rough openings, and the overall.
  expect(await texts(`${v}/extension#1:s1:along`)).toEqual([
    `3' 0"`,
    `2' 0"`,
    `6' 0"`,
    `2' 0"`,
    `3' 0"`,
    `16' 0"`,
  ]);
});

test('the PDF of the set parses back with the disclaimer in every title block', async () => {
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 120_000 }),
    page.getByTestId('drawing-export-pdf').click(),
  ]);
  const bytes = await readFile((await download.path())!);
  const pdf = await getDocument({ data: new Uint8Array(bytes), verbosity: 0 }).promise;
  const pages: string[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const content = await (await pdf.getPage(i)).getTextContent();
    pages.push(
      content.items
        .map((item) => ('str' in item ? item.str : ''))
        .join(' ')
        .replace(/\s+/g, ' '),
    );
  }
  await pdf.cleanup();
  expect(pages).toHaveLength(7);
  for (const [i, p] of pages.entries())
    for (const sentence of DISCLAIMER) expect(p, `page ${i + 1}`).toContain(sentence);
  // The plan's strings made it to paper.
  expect(pages[0]).toContain(`16' 0"`);
});
