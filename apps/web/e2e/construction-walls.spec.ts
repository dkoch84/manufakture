import { expect, test, type Page } from '@playwright/test';
import { openEmpty, regenerated } from './bracket';
import { execute, saved } from './m2-fixtures';

// Construction walls end to end (M6 T6.1d), through the Construction toolbar group and panel: in a
// feet-and-inches document, start construction (one level, no header rules), make a 2x4 wall type
// with its default header (two 2x6 plies on one jack, the shed's header in T6.3a's fixture), draw a
// 12' x 16' loop of walls on level 1 by typed lengths, add a door and a window, and check what is
// framed against the T6.2a fixtures' rules (derived below). Then the wall's spacing goes to 24"
// and the counts drop, undo brings them back, and a reload keeps it all. The short disclaimer is
// on screen throughout.
//
// The counts, by hand. A closed wall frames as a pinwheel (T6.1b): every segment runs through at
// its end, with one corner stud past the other wall (a two-stud corner), and butts at its start,
// 3-1/2" in. So the 16' segments frame 188-1/2" and the 12' ones 140-1/2", laid out from their
// framed start. T6.2a's 16 ft wall has 13 studs at 16" (slot 0 flush, marks every 16", an end
// stud): 188-1/2" gives marks 0..176 (12) + the end stud = 13, 140-1/2" gives 0..128 (9) + 1 =
// 10. So 13 + 10 + 13 + 10 = 46 studs, 4 corner studs, 4 bottom and 8 top plates: 62.
//
// The door, 3' x 6' 8" centred on segment 2 (path 72", framed 68-1/2"): rough opening 50-1/2" to
// 86-1/2", header span 49" to 88". As T6.2a's 36 x 80 door: kings and jacks each side, two header
// plies, and cripples above on the marks inside the span (64", 80"): 8 members. It hides the
// layout studs at 48", 64" and 80", and stops the bottom plate (one more piece).
// The window, 2' x 3' at a 44" sill, its centre 4' along segment 1 (framed 44-1/2"): rough opening
// 32-1/2" to 56-1/2", span 31" to 58": kings, jacks, two plies, a rough sill, cripples above on
// 32" and 48" and below on 48" (inside the rough opening only): 10 members. It hides 32" and 48".
// So 46 - 5 = 41 studs, 4 corners, 5 bottom and 8 top plates, 8 + 10 opening members: 76.
//
// At 24": 188-1/2" gives marks 0..168 (8) + 1 = 9 studs, 140-1/2" gives 0..120 (6) + 1 = 7, so 32
// before openings. The door hides 48" and 72" and keeps one cripple (72"; 48" starts before the
// span): 7 members. The window hides 48" and keeps cripples above and below it: 9 members. So 29
// studs, 4 corners, 5 bottom and 8 top plates, 7 + 9: 62.

const AT_16 = {
  total: 76,
  door: 8,
  window: 10,
  roles: {
    stud: 41,
    corner: 4,
    'bottom-plate': 5,
    'top-plate': 8,
    king: 4,
    jack: 4,
    header: 4,
    'rough-sill': 1,
    cripple: 5,
  },
};
const AT_24 = {
  total: 62,
  door: 7,
  window: 9,
  roles: { ...AT_16.roles, stud: 29, cripple: 3 },
};

const FT_IN = {
  type: 'setDisplayUnits',
  units: { length: { unit: 'ft-in', denominator: 16 }, angle: { unit: 'deg' } },
};
const WALL = 'extension#1';
const DOOR = 'extension#2';
const WINDOW = 'extension#3';

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

/** The text of a test id, once regen has caught up with the document. */
async function count(testId: string): Promise<number> {
  await regenerated(page);
  const text = (await page.getByTestId(testId).textContent()) ?? '';
  const m = /^(\d+) members$/.exec(text);
  expect(m, `${testId}: ${text}`).not.toBeNull();
  return Number(m![1]);
}

async function roles(): Promise<Record<string, number>> {
  await regenerated(page);
  return page.evaluate((wall) => {
    const out: Record<string, number> = {};
    for (const li of document.querySelectorAll(`[data-testid^="wall-role-${wall}-"]`)) {
      const role = li.getAttribute('data-testid')!.slice(`wall-role-${wall}-`.length);
      out[role] = Number(li.getAttribute('data-count'));
    }
    return out;
  }, WALL);
}

test('start construction and make a wall type with its default header', async () => {
  await execute(page, FT_IN, 'Feet and inches');
  await page.getByTestId('construction-open').click();
  await expect(page.getByTestId('construction-disclaimer')).toContainText(
    'Not an engineering tool',
  );
  await page.getByTestId('construction-start').click();
  await expect(page.getByTestId('levels-panel')).toBeVisible();
  await page.getByTestId('wall-type-new').click();
  await page.getByTestId('wall-type-header-stock').selectOption('us-2x6');
  await page.getByTestId('field-wall-type-header-plies').selectOption('2');
  await page.getByTestId('field-wall-type-header-jacks').selectOption('1');
  await page.getByTestId('wall-type-create').click();
  await expect(page.getByTestId('wall-type-exterior-2x4')).toBeVisible();
});

test("draw a 12' x 16' loop of walls on level 1", async () => {
  await page.getByTestId('construction-wall').click();
  for (const length of [`16'`, `12'`, `16'`]) {
    await page.getByTestId('wall-length').fill(length);
    await page.getByTestId('wall-length').press('Enter');
  }
  await page.getByTestId('wall-closed').check();
  await expect(page.getByTestId('wall-summary')).toHaveText(`4 segments, 56' 0" in all, closed.`);
  await page.getByTestId('wall-add').click();
  await expect(page.getByTestId('wall-tool')).toBeHidden();
  const status = await regenerated(page);
  expect(status[WALL]?.status, JSON.stringify(status[WALL])).toBe('ok');
  // Before any opening: 46 studs, 4 corners, 4 bottom and 8 top plates (see above).
  expect(await count(`wall-members-${WALL}`)).toBe(62);
  expect(await roles()).toEqual({ stud: 46, corner: 4, 'bottom-plate': 4, 'top-plate': 8 });
});

test('add a door and a window', async () => {
  await page.getByTestId('construction-opening').click();
  await page.getByTestId('field-opening-segment').selectOption('2');
  await page.getByTestId('opening-width').fill(`3'`);
  await page.getByTestId('opening-height').fill(`6' 8"`);
  await expect(page.getByTestId('opening-header-preview')).toHaveText(
    "The wall type's default header: 2 plies of 2x6 on 1 jack stud each end.",
  );
  await page.getByTestId('opening-ok').click();
  await expect(page.getByTestId('opening-tool')).toBeHidden();

  await page.getByTestId('construction-opening').click();
  await page.getByTestId('field-opening-kind').selectOption('window');
  await page.getByTestId('opening-width').fill(`2'`);
  await page.getByTestId('opening-height').fill(`3'`);
  await page.getByTestId('opening-sill').fill(`44"`);
  await page.getByTestId('field-opening-placement').selectOption('start');
  await page.getByTestId('opening-position').fill(`4'`);
  await page.getByTestId('opening-ok').click();
  await expect(page.getByTestId('opening-tool')).toBeHidden();
  const status = await regenerated(page);
  for (const id of [WALL, DOOR, WINDOW]) expect(status[id]?.status, id).toBe('ok');
  await expectCounts(AT_16);
  // No header rules in a new document: both openings use the wall type's default, and say so.
  for (const id of [DOOR, WINDOW]) {
    await expect(page.getByTestId(`opening-header-${id}`)).toHaveAttribute(
      'data-source',
      'default',
    );
    await expect(page.getByTestId(`opening-header-${id}`)).toHaveText(
      "Header: The wall type's default header: 2 plies of 2x6 on 1 jack stud each end.",
    );
  }
  await expect(page.getByTestId('construction-disclaimer')).toBeVisible();
});

test('change the spacing to 24", then undo', async () => {
  await page.getByTestId(`wall-framing-${WALL}`).click();
  await page.getByTestId('wall-spacing').fill('24"');
  await page.getByTestId('wall-framing-save').click();
  await expect(page.getByTestId('wall-framing-editor')).toBeHidden();
  await expectCounts(AT_24);
  await page.getByRole('button', { name: /^Undo/ }).click();
  await expectCounts(AT_16);
});

test('a reload keeps the walls, the openings and their framing', async () => {
  await saved(page);
  await page.reload();
  await expect(page.getByTestId('document-name')).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId('construction-panel')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId(`wall-members-${WALL}`)).toHaveText(/members$/, {
    timeout: 60_000,
  });
  await expectCounts(AT_16);
  await expect(page.getByTestId('construction-disclaimer')).toContainText(
    'Not an engineering tool',
  );
});

async function expectCounts(want: typeof AT_16): Promise<void> {
  await expect
    .poll(async () => ({
      total: await count(`wall-members-${WALL}`),
      door: await count(`opening-members-${DOOR}`),
      window: await count(`opening-members-${WINDOW}`),
      roles: await roles(),
    }))
    .toEqual(want);
}

test('a partition drawn from the outline names it in dependsOn and joins its layers', async () => {
  // From 8' along the 16' wall, 6' in: its start lies on the outline, a tee (T6.1b, #1172).
  await page.getByTestId('construction-wall').click();
  await page.getByTestId('wall-start-x').fill(`8'`);
  await page.getByTestId('field-wall-direction').selectOption('90');
  await page.getByTestId('wall-length').fill(`6'`);
  await page.getByTestId('wall-length').press('Enter');
  await page.getByTestId('wall-add').click();
  await expect(page.getByTestId('wall-tool')).toBeHidden();
  const status = await regenerated(page);
  const partition = await page.evaluate(
    () =>
      window.__manufakture!.document.getState().document.parts[0]!.features.at(-1) as unknown as {
        id: string;
        dependsOn: string[];
      },
  );
  expect(partition.dependsOn).toEqual([WALL]);
  for (const id of [WALL, partition.id]) {
    expect(status[id]?.status, JSON.stringify(status[id])).toBe('ok');
  }
});
