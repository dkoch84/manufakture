import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { openEmpty, regenerated } from './bracket';
import { execute } from './m2-fixtures';

// The construction takeoff end to end (M6 T6.3b): T6.3a's 12' x 16' shed built in a feet-and-inches
// document (a floor on three 4x6 skids under 23/32" OSB, four 2x4 walls with 7/16" OSB sheathing,
// the 16' walls running through the corners and the 12' gable walls butting between them, a 3' x
// 6' 8" door and two 2' x 3' windows, a 6/12 gable roof with 12" eave and rake overhangs, rafter
// ties on every other pair 24" up, gable studs and 7/16" OSB sheathing), with T6.3a's fixed prices.
// The Takeoff panel then shows T6.3a's rows to buy (derived by hand in
// packages/domain-construction/src/takeoff/shed.test.ts) but for the 2x4 sticks (see BOUGHT), and
// its cost, $1,708.90 + $1.50 = $1,710.40. Studs at 24" change the stud rows; the
// CSV is checked line by line and the PDF parsed back. Every export opens with the short
// disclaimer.

const IN = (v: number | string) => ({ source: String(v), lengthUnit: 'in', angleUnit: 'deg' });
const PART = 'part#1';
const OSB = 'us-osb-7-16';

const CONSTRUCTION = {
  levels: [{ id: 'level-1', name: 'Level 1', elevation: IN(0), height: IN(97.125) }],
  wallTypes: [
    {
      id: 'ext-2x4',
      name: 'Exterior 2x4',
      layers: [
        { id: 'sheathing', kind: 'sheathing', stock: OSB },
        {
          id: 'framing',
          kind: 'framing',
          stock: 'us-2x4',
          header: { stock: 'us-2x6', plies: 2, jacks: 1 },
        },
      ],
    },
  ],
  floorTypes: [
    { id: 'shed-floor', name: 'Shed floor', joistStock: 'us-2x6', subfloor: 'us-osb-23-32' },
  ],
  roofTypes: [
    {
      id: 'shed-roof',
      name: 'Shed roof',
      rafterStock: 'us-2x6',
      ridgeStock: 'us-2x8',
      sheathing: OSB,
      overhang: IN(12),
      rakeOverhang: IN(12),
    },
  ],
};

const PRICES = {
  overrides: Object.fromEntries(
    (
      [
        ['us-2x4-precut-92-5-8', 4.5, 'piece'],
        ['us-2x4', 0.75, 'foot'],
        ['us-2x6', 1.1, 'foot'],
        ['us-2x8', 1.5, 'foot'],
        ['us-4x6', 2.5, 'foot'],
        [OSB, 16, 'sheet'],
        ['us-osb-23-32', 38, 'sheet'],
      ] as const
    ).map(([id, amount, per]) => [id, { price: { amount, per, currency: 'USD' } }]),
  ),
};

function ext(
  id: string,
  name: string,
  extension: string,
  params: Record<string, unknown>,
  expressions: Record<string, unknown>,
  dependsOn: string[] = [],
  operation: 'new' | null = 'new',
) {
  return {
    type: 'addFeature',
    partId: PART,
    feature: {
      id,
      kind: 'extension',
      name,
      suppressed: false,
      extension,
      schemaVersion: 1,
      dependsOn,
      references: [],
      expressions,
      params,
      ...(operation ? { operation } : {}),
    },
  };
}

const wall = (id: string, name: string, a: [number, number], b: [number, number]) =>
  ext(
    id,
    name,
    'construction.wall',
    { level: 'level-1', wallType: 'ext-2x4', points: 2 },
    { x1: IN(a[0]), y1: IN(a[1]), x2: IN(b[0]), y2: IN(b[1]) },
  );

// Counter-clockwise, the exterior to the right, the path on the framing's outside face. The 16'
// walls come first, so they run through the corners and the 12' walls butt between them.
const WALLS = ['extension#1', 'extension#2', 'extension#3', 'extension#4'];
const opening = (
  id: string,
  name: string,
  host: string,
  kind: 'door' | 'window',
  at: Record<string, unknown>,
) =>
  ext(
    id,
    name,
    'construction.opening',
    { kind, segment: 1, from: 'start', header: { kind: 'auto' } },
    at,
    [host],
    null,
  );

const SHED = {
  type: 'batch',
  commands: [
    { type: 'setDomainData', namespace: 'construction', schemaVersion: 1, data: CONSTRUCTION },
    { type: 'setDomainData', namespace: 'stock', schemaVersion: 1, data: PRICES },
    wall('extension#1', 'Front', [0, 0], [192, 0]),
    wall('extension#2', 'Back', [192, 144], [0, 144]),
    wall('extension#3', 'Right', [192, 0], [192, 144]),
    wall('extension#4', 'Left', [0, 144], [0, 0]),
    opening('extension#5', 'Window 1', 'extension#1', 'window', {
      position: IN(48),
      width: IN(24),
      height: IN(36),
      sill: IN(44),
    }),
    opening('extension#6', 'Window 2', 'extension#1', 'window', {
      position: IN(144),
      width: IN(24),
      height: IN(36),
      sill: IN(44),
    }),
    opening('extension#7', 'Door', 'extension#3', 'door', {
      position: IN(72),
      width: IN(36),
      height: IN(80),
    }),
    ext(
      'extension#8',
      'Floor',
      'construction.floor',
      {
        level: 'level-1',
        floorType: 'shed-floor',
        outline: 'walls',
        skids: { stock: 'us-4x6', count: 3 },
      },
      {},
      WALLS,
    ),
    ext(
      'extension#9',
      'Roof',
      'construction.roof',
      {
        roofType: 'shed-roof',
        kind: 'gable',
        ties: { kind: 'rafter-ties', stock: 'us-2x4', every: 2 },
      },
      { pitch: IN('6/12'), tieHeight: IN(24) },
      WALLS,
    ),
  ],
};

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

/** Rows of a section as `item | size: quantity`. */
async function section(category: string): Promise<string[]> {
  await regenerated(page);
  return page.evaluate((c) => {
    const rows = document.querySelectorAll(
      `[data-testid="takeoff-section-${c}"] [data-testid="takeoff-row"]`,
    );
    return [...rows].map((r) => {
      const t = (id: string) => r.querySelector(`[data-testid="${id}"]`)?.textContent ?? '';
      return `${t('takeoff-item')} ${t('takeoff-size')}: ${t('takeoff-qty')}`;
    });
  }, category);
}

async function downloaded(click: () => Promise<void>): Promise<Buffer> {
  const [download] = await Promise.all([page.waitForEvent('download'), click()]);
  return readFile((await download.path())!);
}

// T6.3a's rows to buy, but for the 2x4 sticks: the app's roof (T6.1c) lays each gable end's studs
// on the stud layout of the wall under it, where T6.3a's fixture uses the roof generator's own
// origin. The same 16 gable studs and the same 298" of them, cut to other lengths, so the 1D layout
// packs the 2x4s as 15 x 16', 1 x 14' and 2 x 12' (still 18 sticks: 3265.082" > 17 x 192") where
// the fixture has 13, 4 and 1; 2 ft more, $1.50 at $0.75 a foot. The unit test "the shed as the app
// frames its roof" (src/construction/takeoff/takeoff.test.ts) derives the same from the generators.
const BOUGHT = [
  `2x4 16' 0": 15`,
  `2x4 14' 0": 1`,
  `2x4 12' 0": 2`,
  `2x4 precut stud 92-5/8" 7' 8-5/8": 51`,
  `2x6 16' 0": 18`,
  `2x6 12' 0": 13`,
  `2x8 16' 0": 1`,
  `2x8 8' 0": 1`,
  `4x6 16' 0": 3`,
];

test("the shed's takeoff equals T6.3a's rows and cost", async () => {
  await execute(
    page,
    {
      type: 'setDisplayUnits',
      units: { length: { unit: 'ft-in', denominator: 16 }, angle: { unit: 'deg' } },
    },
    'Feet and inches',
  );
  await execute(page, SHED, 'The shed');
  const status = await regenerated(page);
  for (const id of [
    ...WALLS,
    'extension#5',
    'extension#6',
    'extension#7',
    'extension#8',
    'extension#9',
  ]) {
    expect(status[id]?.status, `${id}: ${JSON.stringify(status[id])}`).toBe('ok');
  }
  if (!(await page.getByTestId('construction-panel').isVisible())) {
    await page.getByTestId('construction-open').click();
  }
  await page.getByTestId('takeoff-open').click();
  await expect(page.getByTestId('takeoff-panel')).toBeVisible();
  await expect(page.getByTestId('takeoff-disclaimer')).toContainText('Not an engineering tool');
  await expect.poll(() => section('lumber')).toEqual(BOUGHT);
  expect(await section('sheet')).toEqual([
    `7/16" OSB 8' 0" x 4' 0": 25`,
    `3/4" OSB 8' 0" x 4' 0": 6`,
  ]);
  await expect(page.getByTestId('takeoff-cost')).toHaveText('Cost of what to buy: $1,710.40');
  // As framed only: no estimating row.
  await expect(page.getByTestId('takeoff-panel')).not.toContainText(/rule of thumb|estimate/i);
});

test('studs at 24" change the stud rows', async () => {
  // 24" on centre: A 7 studs, 4 kings, 2 corners; B 5 studs, 2 kings; C 9 and 2 corners; D 7: 38
  // precut studs (the same layout rules as T6.3a's 16" count, which gives 51).
  await execute(
    page,
    {
      type: 'setDomainData',
      namespace: 'construction',
      schemaVersion: 1,
      data: { ...CONSTRUCTION, framing: { spacing: IN(24) } },
    },
    'Studs at 24"',
  );
  await expect
    .poll(async () => (await section('lumber')).find((r) => r.includes('precut')))
    .toBe(`2x4 precut stud 92-5/8" 7' 8-5/8": 38`);
  // As framed, the 92-5/8" row counts the same studs, kings and corner studs.
  expect((await section('framing')).find((r) => r.startsWith('Stud, '))).toBe(
    `Stud, Corner stud, King stud 7' 8-5/8": 38`,
  );
  await page.evaluate(() => window.__manufakture!.document.getState().undo());
  await expect.poll(() => section('lumber')).toEqual(BOUGHT);
});

test('the CSV is exact and the PDF reads back, each with the disclaimer', async () => {
  const panel = page.getByTestId('takeoff-panel');
  const csv = (await downloaded(() => panel.getByTestId('takeoff-csv').click())).toString('utf8');
  const lines = csv.split('\r\n');
  expect(lines[0]).toMatch(/^Takeoff: ./);
  expect(lines[1]).toMatch(/^"Not an engineering tool: manufakture lays out framing/);
  expect(lines[3]).toBe(
    'Section,#,Item,Stock,Size,Quantity,Total,Also,Price,Cost,Counted from,Notes',
  );
  const lumber = lines.filter((l) => l.startsWith('Lumber to buy,'));
  const n = Number(lumber[0]!.split(',')[1]);
  expect(lumber).toEqual(
    [
      `2x4,2x4,"16' 0""",15,15 pcs,"240' 0""; 160.00 bd ft",$0.75 per ft,$180.00,cut into 43 members,`,
      `2x4,2x4,"14' 0""",1,1 pcs,"14' 0""; 9.33 bd ft",$0.75 per ft,$10.50,cut into 3 members,`,
      `2x4,2x4,"12' 0""",2,2 pcs,"24' 0""; 16.00 bd ft",$0.75 per ft,$18.00,cut into 3 members,`,
      `"2x4 precut stud 92-5/8""","2x4 precut stud 92-5/8""","7' 8-5/8""",51,51 pcs,"393' 7-7/8""; 262.44 bd ft",$4.50 each,$229.50,cut into 51 members,precut stud`,
      `2x6,2x6,"16' 0""",18,18 pcs,"288' 0""; 288.00 bd ft",$1.10 per ft,$316.80,cut into 38 members,`,
      `2x6,2x6,"12' 0""",13,13 pcs,"156' 0""; 156.00 bd ft",$1.10 per ft,$171.60,cut into 13 members,`,
      `2x8,2x8,"16' 0""",1,1 pcs,"16' 0""; 21.33 bd ft",$1.50 per ft,$24.00,cut into 1 member,`,
      `2x8,2x8,"8' 0""",1,1 pcs,"8' 0""; 10.67 bd ft",$1.50 per ft,$12.00,cut into 1 member,`,
      `4x6,4x6,"16' 0""",3,3 pcs,"48' 0""; 96.00 bd ft",$2.50 per ft,$120.00,cut into 3 members,`,
    ].map((line, i) => `Lumber to buy,${n + i},${line}`),
  );
  expect(lines.filter((l) => l.startsWith('Sheets to buy,'))).toEqual([
    `Sheets to buy,${n + 9},"7/16"" OSB","7/16"" OSB","8' 0"" x 4' 0""",25,25 sheets,800.00 sq ft,$16.00 per sheet,$400.00,for 6 faces and parts,`,
    `Sheets to buy,${n + 10},"3/4"" OSB","3/4"" OSB","8' 0"" x 4' 0""",6,6 sheets,192.00 sq ft,$38.00 per sheet,$228.00,for 1 face or part,`,
  ]);
  expect(lines.at(-2)).toBe('"Cost of what to buy: $1,710.40"');

  const pdfBytes = await downloaded(() => panel.getByTestId('takeoff-pdf').click());
  const pdf = await getDocument({ data: new Uint8Array(pdfBytes), verbosity: 0 }).promise;
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
  const all = pages.join(' ');
  for (const p of pages) {
    expect(p).toContain(
      'Not an engineering tool: manufakture lays out framing by rules you choose.',
    );
    expect(p).toContain('Provided without warranty under GPL-3.0-or-later.');
  }
  expect(all).toMatch(/2x4 2x4 16' 0" 15 15 pcs \$180\.00 cut into \d+ members/);
  expect(all).toMatch(/7' 8-5\/8" 51 51 pcs \$229\.50 cut into 51 members; precut stud/);
  expect(all).toContain('Cost of what to buy: $1,710.40');
});
