import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { openEmpty, regenerated, view } from './bracket';
import { settle } from './helpers';
import { execute, saved } from './m2-fixtures';
import {
  FT_IN_UNITS,
  SHED_FACES,
  SHED_FRAMED,
  SHED_COST_MIN,
  SHED_FRAMED_24,
  SHED_IDS,
  SHED_LUMBER_MIN,
  SHED_PLATES,
  SHED_PRECUT,
  SHED_PRECUT_24,
  SHED_PRICES,
  SHED_ROLES,
  SHED_ROLES_24,
  SHED_SHEETS_MIN,
  SHED_UNIT_PRICES,
  STUD_ROLES,
  type FramedRow,
} from './m6-fixtures';

// M6 acceptance: a 12' x 16' shed framed through the UI (docs/m6-acceptance.md; the M6 plan,
// T6.7). In a feet-and-inches document to 1/16": start construction (level 1, 97-1/8" walls, so
// 92-5/8" precut studs on one bottom and two top plates), a 2x4 wall type with 7/16" OSB sheathing
// and no drywall, and a header rule the user enters ("openings up to 4': two 2x6 plies on one jack
// stud each end"); the wall type's own default header is two 2x8 plies, so a 2x6 header proves the
// rule chose it. Then a closed loop of walls 16', 12', 16', 12' at 16" on centre, a 36" x 80" door
// centred on the first 12' end, two 24" x 36" windows (44" sill) centred 4' and 12' along the first
// 16' side; a floor 12' x 16' on three 4x6 skids with 2x6 joists at 16" and 3/4" OSB; a 6/12 gable
// roof with 2x6 rafters at 16", a 2x8 ridge, 12" eave and rake overhangs, 2x4 rafter ties 24" above
// the plates on every other pair, gable studs, and 7/16" OSB roof sheathing.
//
// The takeoff is checked row by row against the hand calculation in
// docs/m6-acceptance/hand-calculation.md (the tables are in m6-fixtures.ts), then the stud rows at
// 24" against its second table, the drawing set (plan and the door wall's framing elevation, ft-in
// strings, the 6/12 pitch symbol), the exports (takeoff CSV and PDF, drawings PDF, IFC, STEP), and
// all of it again after a reload. The short disclaimer is checked in the app and in every export.
//
// What to buy is packed by heuristics ("good, not optimal", packages/nesting/README.md), so the
// bought rows are checked against the hand calculation's proven least quantities: they cover every
// member and face of the hand tables, and each stock comes to at least its least and at most one
// 16' stick or one sheet more; the cost is the bought rows' sum at the fixed prices. The STEP file
// holds the layer bodies and every framing member as B-reps, under the disclaimer.
//
// With M6_DOCS=1 the run also refreshes the screenshots in docs/m6-acceptance/ and writes
// numbers.json there (wall-clock timings of this run: estimates, not benchmarks).

const DISCLAIMER = [
  'Not an engineering tool: manufakture lays out framing by rules you choose.',
  'Provided without warranty under GPL-3.0-or-later.',
];
const { wall: WALL, door: DOOR, windows: WINDOWS, floor: FLOOR, roof: ROOF } = SHED_IDS;

let page: Page;
let errors: string[];
const timings: Record<string, number> = {};

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  // The docs' screenshots are wider, so the side panels fit beside the view.
  page = await browser.newPage(
    process.env.M6_DOCS ? { viewport: { width: 1600, height: 1000 } } : {},
  );
  errors = await openEmpty(page);
});

test.afterAll(async () => {
  expect(errors).toEqual([]);
  await page.close();
});

const docsDir = () => resolve(test.info().project.testDir, '../../../docs/m6-acceptance');

/** A screenshot for the docs (M6_DOCS=1), with `focus` (a test id) scrolled to the top of its panel. */
async function docShot(name: string, focus?: string): Promise<void> {
  if (!process.env.M6_DOCS) return;
  if (focus) await page.getByTestId(focus).evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.mouse.move(0, 0);
  await settle(page);
  await mkdir(docsDir(), { recursive: true });
  await page.screenshot({ path: join(docsDir(), `${name}.png`) });
}

/** Run `step` and record its wall-clock time under `name`, in ms (an estimate). */
async function timed<T>(name: string, step: () => Promise<T>): Promise<T> {
  const t0 = Date.now();
  const out = await step();
  timings[name] = Date.now() - t0;
  return out;
}

/** `8' 1-1/8"`, `7' 11-53/64"`, `8-5/8"` or `3/8"` in inches. */
function inches(text: string): number {
  const m = /^(?:(-?\d+)' ?)?(?:(\d+)?(?:[- ]?(\d+)\/(\d+))?")?$/.exec(text.trim());
  if (!m) throw new Error(`not a feet-and-inches length: ${text}`);
  const [, ft, whole, num, den] = m;
  return Number(ft ?? 0) * 12 + Number(whole ?? 0) + (num ? Number(num) / Number(den) : 0);
}

/** Member counts by role from a list of `[data-testid^=prefix]` items with `data-count`. */
function rolesOf(prefix: string): Promise<Record<string, number>> {
  return page.evaluate((p) => {
    const out: Record<string, number> = {};
    for (const li of document.querySelectorAll(`[data-testid^="${p}"]`))
      out[li.getAttribute('data-testid')!.slice(p.length)] = Number(li.getAttribute('data-count'));
    return out;
  }, prefix);
}

async function memberCount(testId: string): Promise<number> {
  const text = (await page.getByTestId(testId).textContent()) ?? '';
  const m = /^(\d+) members$/.exec(text);
  expect(m, `${testId}: ${text}`).not.toBeNull();
  return Number(m![1]);
}

/** Every group's member counts as the Construction panel lists them. */
async function framing() {
  await regenerated(page);
  return {
    wall: await rolesOf(`wall-role-${WALL}-`),
    door: await memberCount(`opening-members-${DOOR}`),
    window: [
      await memberCount(`opening-members-${WINDOWS[0]}`),
      await memberCount(`opening-members-${WINDOWS[1]}`),
    ],
    floor: await rolesOf(`construction-role-${FLOOR}-`),
    roof: await rolesOf(`construction-role-${ROOF}-`),
  };
}

function expectedFraming(t: typeof SHED_ROLES | typeof SHED_ROLES_24) {
  return {
    wall: t.wall,
    door: t.door,
    window: [t.window, t.window],
    floor: t.floor,
    roof: t.roof,
  };
}

/** The cells of a takeoff section's rows. */
async function section(category: string): Promise<
  {
    item: string;
    counted: string;
    stock: string;
    size: string;
    qty: string;
    total: string;
    cost: string;
  }[]
> {
  await regenerated(page);
  return page.evaluate((c) => {
    const rows = document.querySelectorAll(
      `[data-testid="takeoff-section-${c}"] [data-testid="takeoff-row"]`,
    );
    return [...rows].map((r) => {
      const t = (id: string) => r.querySelector(`[data-testid="${id}"]`)?.textContent ?? '';
      return {
        item: t('takeoff-item'),
        counted: t('takeoff-counted'),
        stock: t('takeoff-stock'),
        size: t('takeoff-size'),
        qty: t('takeoff-qty'),
        total: t('takeoff-total'),
        cost: t('takeoff-row-cost'),
      };
    });
  }, category);
}

/** The "As framed" rows as hand-table rows (roles sorted). */
async function framedRows(): Promise<FramedRow[]> {
  return (await section('framing')).map((r) => ({
    roles: r.item.split(', ').sort(),
    stock: r.stock,
    length: inches(r.size),
    qty: Number(r.qty),
  }));
}

/** Compare rows with lengths to 1/64", the finest fraction the takeoff shows. */
function sameRows(got: FramedRow[], want: FramedRow[]): void {
  const key = (r: FramedRow) => `${r.stock} ${r.roles.join(', ')} ${Math.round(r.length * 64)}`;
  const fmt = (rows: FramedRow[]) =>
    rows.map((r) => `${key(r)}: ${r.qty}`).sort((a, b) => a.localeCompare(b));
  expect(fmt(got)).toEqual(fmt(want.map((r) => ({ ...r, roles: [...r.roles].sort() }))));
  for (const w of want) {
    const g = got.find((r) => key(r) === key({ ...w, roles: [...w.roles].sort() }))!;
    expect(Math.abs(g.length - w.length), key(w)).toBeLessThanOrEqual(1 / 128);
  }
}

/** Bought lumber rows as `stock length: quantity`. */
async function bought(): Promise<string[]> {
  return (await section('lumber')).map((r) => `${r.stock} ${r.size}: ${r.qty}`);
}

async function openTakeoff(): Promise<void> {
  if (!(await page.getByTestId('construction-panel').isVisible())) {
    await page.getByTestId('construction-open').click();
  }
  if (!(await page.getByTestId('takeoff-panel').isVisible())) {
    await page.getByTestId('takeoff-open').click();
  }
  await expect(page.getByTestId('takeoff-panel')).toBeVisible();
  await expect(page.getByTestId('takeoff-tab-rows')).toBeVisible();
  await page.getByTestId('takeoff-tab-rows').click();
}

async function downloaded(click: () => Promise<void>): Promise<{ name: string; bytes: Buffer }> {
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 120_000 }),
    click(),
  ]);
  return { name: download.suggestedFilename(), bytes: await readFile((await download.path())!) };
}

async function pdfPages(bytes: Buffer): Promise<string[]> {
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
  return pages;
}

interface E2eSheet {
  id: string;
  name: string;
  views: { id: string }[];
}

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

async function showSheet(name: string): Promise<E2eSheet> {
  const sheet = (await sheets()).find((s) => s.name === name)!;
  expect(sheet, name).toBeDefined();
  await page.getByTestId(`drawing-sheet-tab-${sheet.id}`).click();
  await regenerated(page);
  await expect(page.getByTestId('drawing-sheet')).toHaveAttribute('data-state', 'ready', {
    timeout: 90_000,
  });
  return sheet;
}

/** The texts the shown sheet draws for `owner` (a string, a dimension or a symbol), in order. */
function texts(owner: string): Promise<string[]> {
  return page.evaluate(
    (o) =>
      [...document.querySelectorAll('[data-testid="drawing-sheet"] .drawing-svg text')]
        .filter((t) => t.getAttribute('data-owner') === o)
        .map((t) => t.textContent ?? ''),
    owner,
  );
}

/** The plan's strings and the door wall's framing elevation, as the hand calculation reads them. */
async function checkDrawings(): Promise<void> {
  expect((await sheets()).map((s) => s.name)).toEqual([
    'Plan: Level 1',
    'Elevations',
    'Framing: Wall 1',
    'Roof framing: Roof 1',
  ]);
  const plan = await showSheet('Plan: Level 1');
  const p = plan.views[0]!.id;
  const s = (seg: number, what: string) => texts(`${p}/${WALL}:s${seg}:${what}`);
  // The windows' side: centres 4' and 12' along (4', 8', 4'), rough openings 2' wide.
  expect(await s(1, 'centres')).toEqual([`4' 0"`, `8' 0"`, `4' 0"`]);
  expect(await s(1, 'openings')).toEqual([`3' 0"`, `2' 0"`, `6' 0"`, `2' 0"`, `3' 0"`]);
  expect(await s(1, 'overall')).toEqual([`16' 0"`]);
  // The door's end: centred, 3' wide, so 4' 6" each side.
  expect(await s(2, 'centres')).toEqual([`6' 0"`, `6' 0"`]);
  expect(await s(2, 'openings')).toEqual([`4' 6"`, `3' 0"`, `4' 6"`]);
  expect(await s(2, 'overall')).toEqual([`12' 0"`]);
  expect(await s(3, 'overall')).toEqual([`16' 0"`]);
  expect(await s(4, 'overall')).toEqual([`12' 0"`]);
  await expect(page.getByTestId('drawing-sheet')).toContainText('Not an engineering tool');

  // The framing sheet has a view per segment; the door's end is the second.
  const framingSheet = await showSheet('Framing: Wall 1');
  const e = framingSheet.views[1]!.id;
  // Along the bottom: corner to the rough opening, the door, to the other corner, overall.
  expect(await texts(`${e}/${WALL}:s2:along`)).toEqual([`4' 6"`, `3' 0"`, `4' 6"`, `12' 0"`]);
  // Up the side: the door's head 80", from it to the top of the plates, the wall's 97-1/8".
  expect(await texts(`${e}/${WALL}:s2:up`)).toEqual([`6' 8"`, `1' 5-1/8"`, `8' 1-1/8"`]);
  // The gable end carries the roof's pitch symbol: 12 across, 6 up.
  expect(await texts(`${e}/${ROOF}:pitch`)).toEqual(['12', '6']);
  // The windows' side is an eave, where the roof does not slope across the view: no symbol.
  expect(await texts(`${framingSheet.views[0]!.id}/${ROOF}:pitch`)).toEqual([]);
  await expect(page.getByTestId('drawing-sheet')).toContainText('Not an engineering tool');
  // The other two sheets are drawn, under the disclaimer too.
  for (const name of ['Elevations', 'Roof framing: Roof 1']) {
    await showSheet(name);
    await expect(page.getByTestId('drawing-sheet'), name).toContainText('Not an engineering tool');
  }
}

/** Times `step` under `name` on the first pass only; the checks after the reload are not timed. */
function maybeTimed<T>(first: boolean, name: string, step: () => Promise<T>): Promise<T> {
  return first ? timed(name, step) : step();
}

/** The drawing set's PDF, from the shown drawing: 4 pages, each under the disclaimer. */
async function checkDrawingsPdf(first: boolean): Promise<Buffer> {
  const drawings = await maybeTimed(first, 'drawings pdf', () =>
    downloaded(() => page.getByTestId('drawing-export-pdf').click()),
  );
  const drawingPages = await pdfPages(drawings.bytes);
  expect(drawingPages).toHaveLength(4);
  for (const [i, p] of drawingPages.entries())
    for (const sentence of DISCLAIMER) expect(p, `drawing page ${i + 1}`).toContain(sentence);
  expect(drawingPages[0]).toContain(`16' 0"`);
  expect(drawingPages[2]).toContain(`8' 1-1/8"`);
  return drawings.bytes;
}

/** The takeoff's CSV and PDF, from the part studio: the disclaimer and the precut stud row. */
async function checkTakeoffExports(): Promise<string> {
  await openTakeoff();
  const panel = page.getByTestId('takeoff-panel');
  const csv = (await downloaded(() => panel.getByTestId('takeoff-csv').click())).bytes.toString(
    'utf8',
  );
  const lines = csv.split('\r\n');
  expect(lines[1]).toMatch(/^"Not an engineering tool: manufakture lays out framing/);
  // The as-framed lines are the hand table's.
  const framedLines = lines.filter((l) => l.startsWith('As framed,'));
  expect(framedLines).toHaveLength(SHED_FRAMED.length);
  expect(lines.find((l) => l.startsWith('Lumber to buy,') && l.includes('precut'))).toContain(
    ',49,49 pcs,',
  );
  const pdf = await pdfPages(
    (await downloaded(() => panel.getByTestId('takeoff-pdf').click())).bytes,
  );
  for (const p of pdf) for (const sentence of DISCLAIMER) expect(p).toContain(sentence);
  expect(pdf.join(' ')).toMatch(/7' 8-5\/8" 49 49 pcs \$220\.50/);
  await page.getByTestId('takeoff-close').click();
  return csv;
}

/** IFC of the building from the Export menu: the disclaimer in its header, every element. */
async function checkIfc(first: boolean): Promise<Buffer> {
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const ifc = await maybeTimed(first, 'ifc', () =>
    downloaded(() => page.getByTestId('export-ifc').click()),
  );
  const text = ifc.bytes.toString('utf8');
  expect(ifc.name).toMatch(/\.ifc$/);
  expect(text).toMatch(/^ISO-10303-21;/);
  expect(text).toContain("FILE_SCHEMA(('IFC4'))");
  expect(text.replace(/','/g, ' ')).toContain(
    'Not an engineering tool: manufakture lays out framing by rules you choose.',
  );
  // The building's elements, and every framing member of the hand table: 84 in the walls (with
  // their openings), 18 in the floor, 54 in the roof.
  const count = (entity: string) => text.split(`=${entity}(`).length - 1;
  expect(
    ['IFCWALL', 'IFCDOOR', 'IFCWINDOW', 'IFCOPENINGELEMENT', 'IFCSLAB', 'IFCROOF'].map(count),
  ).toEqual([1, 1, 2, 3, 1, 1]);
  expect(count('IFCMEMBER') + count('IFCBEAM')).toBe(84 + 18 + 54);
  return ifc.bytes;
}

/** STEP of the framing from the Export menu: every member and layer body, under the disclaimer. */
async function checkStep(first: boolean): Promise<Buffer> {
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const step = await maybeTimed(first, 'step', () =>
    downloaded(() => page.getByTestId('export-step').click()),
  );
  // The members of the hand tables, built on demand in the regen worker (a batch per owner).
  await expect(page.getByTestId('io-status')).toContainText(
    `${84 + 18 + 54} framing members as B-reps.`,
  );
  const text = step.bytes.toString('utf8');
  expect(step.name).toMatch(/\.step$/);
  expect(text).toMatch(/^ISO-10303-21;/);
  // In the header's description, the short disclaimer, in STEP strings of up to 200 characters.
  const header = text.slice(0, text.indexOf('ENDSEC;'));
  const description = /FILE_DESCRIPTION\(\(([\s\S]*?)\),'2;1'\);/.exec(header)![1]!;
  const strings = [...description.matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1]!);
  for (const sentence of DISCLAIMER) expect(strings.join(' ')).toContain(sentence);
  // One solid per member (156) and per layer body: the wall's sheathing, the subfloor, two roof
  // planes and two gable fills.
  const solids = text.split('MANIFOLD_SOLID_BREP(').length - 1;
  expect(solids).toBe(84 + 18 + 54 + 6);
  for (const id of [
    `${WALL}:s0`,
    `${DOOR}:header`,
    `${FLOOR}:j0`,
    `${ROOF}:e1:c0`,
    `${ROOF}:ridge:1`,
  ])
    expect(text, id).toContain(`PRODUCT('${id}'`);
  return step.bytes;
}

/** Dollars from `$1,234.50`. */
const dollars = (text: string) => Number(text.replace(/[$,]/g, ''));

/**
 * What to buy against hand table 3: precut studs exactly; for each packed stock, every member or
 * face of the hand tables is cut from what is bought, and the quantity is at least the proven
 * least and at most one 16' stick or one sheet more; the cost is the sum of the bought rows at the
 * fixed prices, within the bounds that follow.
 */
async function checkBought(): Promise<void> {
  const lumber = await section('lumber');
  const sheets = await section('sheet');
  const precut = lumber.filter((r) => r.item.includes('precut'));
  expect(precut.map((r) => `${r.stock} ${r.size}: ${r.qty}`)).toEqual([SHED_PRECUT]);
  let total = Number(precut[0]!.qty) * SHED_UNIT_PRICES[precut[0]!.stock]!;
  expect(dollars(precut[0]!.cost)).toBeCloseTo(total, 9);
  let most = total;
  for (const want of SHED_LUMBER_MIN) {
    const rows = lumber.filter((r) => r.stock === want.stock);
    const members = rows.reduce(
      (a, r) => a + Number(/cut into (\d+) members?/.exec(r.counted)![1]),
      0,
    );
    const feet = rows.reduce((a, r) => a + (inches(r.size) / 12) * Number(r.qty), 0);
    expect({ stock: want.stock, members }).toEqual({ stock: want.stock, members: want.members });
    expect(feet * 12, want.stock).toBeGreaterThanOrEqual(want.length);
    expect(feet, want.stock).toBeGreaterThanOrEqual(want.feet);
    expect(feet, want.stock).toBeLessThanOrEqual(want.feet + 16);
    const price = SHED_UNIT_PRICES[want.stock]!;
    for (const r of rows)
      expect(dollars(r.cost), `${r.stock} ${r.size}`).toBeCloseTo(
        (inches(r.size) / 12) * Number(r.qty) * price,
        9,
      );
    total += feet * price;
    most += (want.feet + 16) * price;
  }
  for (const want of SHED_SHEETS_MIN) {
    const r = sheets.find((x) => x.stock === want.stock)!;
    expect(r.counted, want.stock).toBe(
      `for ${want.faces} ${want.faces === 1 ? 'face or part' : 'faces and parts'}`,
    );
    const n = Number(r.qty);
    expect(n * 96 * 48, want.stock).toBeGreaterThanOrEqual(want.area);
    expect(n, want.stock).toBeGreaterThanOrEqual(want.sheets);
    expect(n, want.stock).toBeLessThanOrEqual(want.sheets + 1);
    const price = SHED_UNIT_PRICES[want.stock]!;
    expect(dollars(r.cost), want.stock).toBeCloseTo(n * price, 9);
    total += n * price;
    most += (want.sheets + 1) * price;
  }
  const cost = dollars(
    /Cost of what to buy: (.*)$/.exec((await page.getByTestId('takeoff-cost').textContent())!)![1]!,
  );
  expect(cost).toBeCloseTo(total, 9);
  expect(cost).toBeGreaterThanOrEqual(SHED_COST_MIN - 1e-9);
  expect(cost).toBeLessThanOrEqual(most + 1e-9);
  // The whole sheets the faces take are the hand table's.
  await page.getByTestId('takeoff-tab-layouts').click();
  for (const [id, want] of [
    ['us-osb-7-16', SHED_SHEETS_MIN[0]!],
    ['us-osb-23-32', SHED_SHEETS_MIN[1]!],
  ] as const)
    await expect(page.getByTestId(`takeoff-sheets-${id}`).locator('h3')).toContainText(
      `(${want.whole} whole,`,
    );
  await page.getByTestId('takeoff-tab-rows').click();
}

/** The takeoff checks that hold before and after the reload. */
async function checkTakeoff(): Promise<void> {
  await openTakeoff();
  await expect(page.getByTestId('takeoff-disclaimer')).toContainText('Not an engineering tool');
  await expect.poll(async () => (await framedRows()).length).toBe(SHED_FRAMED.length);
  sameRows(await framedRows(), SHED_FRAMED);
  // Plates in linear length: 13 pieces, 1938" = 161' 6".
  expect((await section('linear')).map((r) => `${r.item} ${r.stock}: ${r.qty}`)).toEqual([
    `Plates 2x4: ${SHED_PLATES.pieces}`,
  ]);
  const plates = await page.evaluate(
    () =>
      document.querySelector('[data-testid="takeoff-section-linear"] [data-testid="takeoff-total"]')
        ?.textContent ?? '',
  );
  expect(inches(plates)).toBe(SHED_PLATES.length);
  expect(
    (await section('faces')).map((r) => `${r.item} ${r.stock}: ${r.qty} pieces, ${r.total}`),
  ).toEqual(SHED_FACES);
  await checkBought();
  // As framed only: no estimating row.
  await expect(page.getByTestId('takeoff-panel')).not.toContainText(/rule of thumb|estimate/i);
}

test('a feet-and-inches document, level 1, a 2x4 wall type and a header rule', async () => {
  await execute(page, FT_IN_UNITS, 'Feet and inches');
  await page.getByTestId('construction-open').click();
  await expect(page.getByTestId('construction-disclaimer')).toContainText(
    'Not an engineering tool',
  );
  await page.getByTestId('construction-start').click();
  await expect(page.getByTestId('levels-panel')).toBeVisible();
  // Level 1 at 0, its walls 97-1/8" high: one bottom and two top plates on 92-5/8" precut studs.
  await expect(page.getByTestId('level-name-level-1')).toHaveValue('Level 1');
  await expect(page.getByTestId('level-height-level-1')).toHaveValue('97-1/8"');
  // A new document has no header rules (ADR 0015 decision 7).
  await page.getByTestId('framing-settings').locator('summary').click();
  await expect(page.getByTestId('header-rules-empty')).toBeVisible();

  // The wall type: 2x4 studs, 7/16" OSB outside, no drywall; its default header two 2x8 plies.
  await page.getByTestId('wall-type-new').click();
  await expect(page.getByTestId('wall-type-stud')).toHaveValue('us-2x4');
  await expect(page.getByTestId('wall-type-sheathing-on')).toBeChecked();
  await expect(page.getByTestId('wall-type-sheathing')).toHaveValue('us-osb-7-16');
  await expect(page.getByTestId('wall-type-drywall-on')).not.toBeChecked();
  await page.getByTestId('wall-type-header-stock').selectOption('us-2x8');
  await page.getByTestId('field-wall-type-header-plies').selectOption('2');
  await page.getByTestId('field-wall-type-header-jacks').selectOption('1');
  await page.getByTestId('wall-type-create').click();
  await expect(page.getByTestId('wall-type-exterior-2x4')).toBeVisible();

  // The header rule: openings up to 4' get two 2x6 plies on one jack stud each end.
  await page.getByTestId('header-rule-add').click();
  await page.getByTestId('header-rule-width-1').fill(`4'`);
  await page.getByTestId('header-rule-1-header-stock').selectOption('us-2x6');
  await page.getByTestId('field-header-rule-1-header-plies').selectOption('2');
  await page.getByTestId('field-header-rule-1-header-jacks').selectOption('1');
  await docShot('01-header-rule', 'header-rules');
  await page.getByTestId('header-rules-save').click();
  await expect(page.getByTestId('header-rules-empty')).toBeHidden();
  await page.getByTestId('framing-settings').locator('summary').click();
});

test("four 2x4 walls in a 12' x 16' loop, a door on a 12' end, two windows on a 16' side", async () => {
  await page.getByTestId('construction-wall').click();
  for (const length of [`16'`, `12'`, `16'`]) {
    await page.getByTestId('wall-length').fill(length);
    await page.getByTestId('wall-length').press('Enter');
  }
  await page.getByTestId('wall-closed').check();
  await expect(page.getByTestId('wall-summary')).toHaveText(`4 segments, 56' 0" in all, closed.`);
  await docShot('02-walls', 'wall-tool');
  await timed('walls', async () => {
    await page.getByTestId('wall-add').click();
    await expect(page.getByTestId('wall-tool')).toBeHidden();
    await regenerated(page);
  });

  // The door: 3' x 6' 8", centred on segment 2 (the first 12' end).
  await page.getByTestId('construction-opening').click();
  await page.getByTestId('field-opening-segment').selectOption('2');
  await page.getByTestId('opening-width').fill(`3'`);
  await page.getByTestId('opening-height').fill(`6' 8"`);
  await expect(page.getByTestId('opening-header-preview')).toContainText(
    `Your header rule for openings up to 4' 0"`,
  );
  await page.getByTestId('opening-ok').click();
  await expect(page.getByTestId('opening-tool')).toBeHidden();
  // The windows: 2' x 3' at a 44" sill, centred 4' and 12' from the start of segment 1.
  for (const at of [`4'`, `12'`]) {
    await page.getByTestId('construction-opening').click();
    await page.getByTestId('field-opening-kind').selectOption('window');
    await page.getByTestId('opening-width').fill(`2'`);
    await page.getByTestId('opening-height').fill(`3'`);
    await page.getByTestId('opening-sill').fill(`44"`);
    await page.getByTestId('field-opening-placement').selectOption('start');
    await page.getByTestId('opening-position').fill(at);
    await page.getByTestId('opening-ok').click();
    await expect(page.getByTestId('opening-tool')).toBeHidden();
  }
  const status = await regenerated(page);
  for (const id of [WALL, DOOR, ...WINDOWS]) {
    expect(status[id]?.status, `${id}: ${JSON.stringify(status[id])}`).toBe('ok');
    expect(status[id]?.warnings, id).toEqual([]);
  }
  // Every header comes from the rule (the default would be 2x8).
  for (const id of [DOOR, ...WINDOWS]) {
    await expect(page.getByTestId(`opening-header-${id}`)).toHaveAttribute('data-source', 'rule');
    await expect(page.getByTestId(`opening-header-${id}`)).toContainText('2 plies of 2x6');
  }
  const counts = await framing();
  expect({ wall: counts.wall, door: counts.door, window: counts.window }).toEqual({
    wall: SHED_ROLES.wall,
    door: SHED_ROLES.door,
    window: [SHED_ROLES.window, SHED_ROLES.window],
  });
  await view(page, 'iso');
  await docShot('03-walls-framed', 'walls-list');
});

test('a floor on three 4x6 skids and a 6/12 gable roof', async () => {
  await page.getByTestId('construction-floor').click();
  await expect(page.getByTestId(`floor-wall-${WALL}`)).toBeChecked();
  await page.getByTestId('floor-type-name').fill('Shed floor');
  await page.getByTestId('floor-type-joist').selectOption('us-2x6');
  await page.getByTestId('floor-type-subfloor').selectOption('us-osb-23-32');
  await page.getByTestId('floor-skids').check();
  await page.getByTestId('floor-skid-stock').selectOption('us-4x6');
  await page.getByTestId('field-floor-skid-count').selectOption('3');
  await timed('floor', async () => {
    await page.getByTestId('floor-ok').click();
    await expect(page.getByTestId('floor-tool')).toBeHidden();
    await regenerated(page);
  });

  await page.getByTestId('construction-roof').click();
  await expect(page.getByTestId(`roof-wall-${WALL}`)).toBeChecked();
  await page.getByTestId('roof-type-name').fill('Shed roof');
  await page.getByTestId('roof-type-rafter').selectOption('us-2x6');
  await page.getByTestId('roof-type-ridge').selectOption('us-2x8');
  if (!(await page.getByTestId('roof-type-sheathing-on').isChecked()))
    await page.getByTestId('roof-type-sheathing-on').check();
  await expect(page.getByTestId('roof-type-sheathing')).toHaveValue('us-osb-7-16');
  await page.getByTestId('roof-pitch').fill('6/12');
  await expect(page.getByTestId('roof-pitch-shown')).toHaveText('6/12, 26.57°');
  await page.getByTestId('roof-overhang').fill(`12"`);
  await page.getByTestId('roof-rake-overhang').fill(`12"`);
  await page.getByTestId('field-roof-ties').selectOption('rafter-ties');
  await page.getByTestId('roof-tie-stock').selectOption('us-2x4');
  await page.getByTestId('field-roof-tie-every').selectOption('2');
  await page.getByTestId('roof-tie-height').fill(`2'`);
  await expect(page.getByTestId('roof-gable-studs')).toBeChecked();
  await docShot('04-roof-tool', 'roof-tool');
  await timed('roof', async () => {
    await page.getByTestId('roof-ok').click();
    await expect(page.getByTestId('roof-tool')).toBeHidden();
    await regenerated(page);
  });
  const status = await regenerated(page);
  for (const id of [FLOOR, ROOF]) {
    expect(status[id]?.status, `${id}: ${JSON.stringify(status[id])}`).toBe('ok');
    expect(status[id]?.warnings, id).toEqual([]);
  }
  await expect(page.getByTestId(`roof-summary-${ROOF}`)).toHaveText('Gable, 6/12, 26.57°');
  expect(await framing()).toEqual(expectedFraming(SHED_ROLES));
  await view(page, 'iso');
  await docShot('05-shed', 'floors-roofs-list');
});

test('the takeoff equals the hand calculation, row by row', async () => {
  // The fixed prices of the cost check, as stock overrides (one undo step).
  await execute(page, SHED_PRICES, 'Prices');
  await timed('takeoff', async () => {
    await openTakeoff();
    await expect(page.getByTestId('takeoff-cost')).toBeVisible();
  });
  await checkTakeoff();
  await docShot('06-takeoff', 'takeoff-panel');
  await page.getByTestId('takeoff-tab-layouts').click();
  await docShot('07-takeoff-layouts', 'takeoff-panel');
  await page.getByTestId('takeoff-tab-rows').click();
});

test('studs at 24" change the stud rows as the second hand table says', async () => {
  await page.getByTestId('takeoff-close').click();
  await page.getByTestId('framing-settings').locator('summary').click();
  await page.getByTestId('framing-spacing').fill('24"');
  await page.getByTestId('framing-save').click();
  await page.getByTestId('framing-settings').locator('summary').click();
  await expect.poll(() => framing()).toEqual(expectedFraming(SHED_ROLES_24));
  await openTakeoff();
  const isStudRow = (r: FramedRow) => r.roles.some((x) => STUD_ROLES.includes(x));
  const want = [...SHED_FRAMED.filter((r) => !isStudRow(r)), ...SHED_FRAMED_24];
  await expect
    .poll(async () => (await framedRows()).filter(isStudRow).length)
    .toBe(SHED_FRAMED_24.length);
  sameRows(await framedRows(), want);
  expect((await bought()).find((r) => r.includes('precut'))).toBe(SHED_PRECUT_24);
  await docShot('08-takeoff-24', 'takeoff-panel');
  // One undo step brings 16" back.
  await page.getByTestId('takeoff-close').click();
  await page.getByRole('button', { name: /^Undo/ }).click();
  await expect.poll(() => framing()).toEqual(expectedFraming(SHED_ROLES));
  await openTakeoff();
  sameRows(await framedRows(), SHED_FRAMED);
});

test('the drawing set: plan and the door wall framed, ft-in strings and the pitch symbol', async () => {
  await page.getByTestId('takeoff-close').click();
  await page.getByTestId('drawing-add').click();
  await page.getByTestId('drawing-new-name').fill('Shed set');
  await page.getByTestId('drawing-new-create').click();
  await page.getByTestId('drawing-construction-set').click();
  await expect(page.getByTestId('construction-set-panel')).toBeVisible();
  await expect(page.getByTestId('construction-set-disclaimer')).toContainText(
    'Not an engineering tool',
  );
  await timed('drawing set', async () => {
    await page.getByTestId('construction-set-create').click();
    await expect(page.getByTestId('drawing-status')).toContainText('Added 4 sheets');
  });
  await checkDrawings();
  await showSheet('Plan: Level 1');
  await docShot('09-plan');
  await showSheet('Framing: Wall 1');
  await docShot('10-framing-elevations');
});

test('exports: takeoff CSV and PDF, drawings PDF and IFC, each with the disclaimer', async () => {
  const drawings = await checkDrawingsPdf(true);
  // Back to the part studio for the takeoff and the Export menu.
  await page.getByTestId('part-tab-part#1').click();
  const csv = await checkTakeoffExports();
  const ifc = await checkIfc(true);
  const out = join(test.info().project.outputDir, 'm6-shed');
  await mkdir(out, { recursive: true });
  await writeFile(join(out, 'shed.ifc'), ifc);
  await writeFile(join(out, 'takeoff.csv'), csv);
  await writeFile(join(out, 'drawings.pdf'), drawings);
});

test('STEP of the framing: the layer bodies and every member as B-reps, with the disclaimer', async () => {
  const step = await checkStep(true);
  await writeFile(join(test.info().project.outputDir, 'm6-shed', 'shed.step'), step);
});

test('a reload keeps the shed, its takeoff and its drawing set', async () => {
  await saved(page);
  await page.reload();
  await expect(page.getByTestId('document-name')).toBeVisible({ timeout: 90_000 });
  await regenerated(page);
  if (!(await page.getByTestId('construction-panel').isVisible())) {
    await page.getByTestId('construction-open').click();
  }
  await expect(page.getByTestId(`wall-members-${WALL}`)).toHaveText(/members$/, {
    timeout: 60_000,
  });
  await expect(page.getByTestId('construction-disclaimer')).toContainText(
    'Not an engineering tool',
  );
  expect(await framing()).toEqual(expectedFraming(SHED_ROLES));
  for (const id of [DOOR, ...WINDOWS])
    await expect(page.getByTestId(`opening-header-${id}`)).toHaveAttribute('data-source', 'rule');
  await checkTakeoff();
  await page.getByTestId('takeoff-close').click();
  const drawingId = await page.evaluate(
    () =>
      (
        window.__manufakture!.document.getState().document as unknown as {
          drawings: { id: string }[];
        }
      ).drawings[0]!.id,
  );
  await page.getByTestId(`drawing-tab-${drawingId}`).click();
  await checkDrawings();
  // Every export again from the reloaded document, with its disclaimer and its counts.
  await checkDrawingsPdf(false);
  await page.getByTestId('part-tab-part#1').click();
  await checkTakeoffExports();
  await checkIfc(false);
  await checkStep(false);
  if (process.env.M6_DOCS) {
    await writeFile(
      join(docsDir(), 'numbers.json'),
      `${JSON.stringify({ note: 'Wall-clock times of one e2e run, ms: estimates, not benchmarks.', timings }, null, 2)}\n`,
    );
  }
});
