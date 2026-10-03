import { expect, test, type Page } from '@playwright/test';
import { openEmpty, regenerated } from './bracket';
import { execute, saved } from './m2-fixtures';

// Floors and roofs end to end (M6 T6.1e), through the Construction toolbar group: in a
// feet-and-inches document, the 12' x 16' shed's walls (one closed loop of 2x4 walls on level 1,
// as construction-walls.spec.ts draws them), then a floor on three 4x6 skids under them, with 2x6
// joists and 23/32" OSB subfloor from a floor type made in the Floor tool, and a 6/12 gable roof
// with 2x6 rafters and a 2x8 ridge from a roof type made in the Roof tool. The pitch goes to
// 4/12, the roof turns hip (the roof type gets its hip stock in the same step), undo brings the
// gable back, and a reload keeps it all.
//
// The counts are T6.2b's and T6.2c's shed (packages/domain-construction, floor-roof.regen.test.ts):
// the floor's joists span the 12' side at 16" on centre inside a 16' rim, so 13 joists, 2 rims
// and the 3 skids; the gable has 13 pairs of common rafters, a ridge and 8 gable studs on each
// 12' wall's own layout (the closed loop's pinwheel butts the 12' segments 3-1/2" in from the
// corner, as the four separate walls there do), still 16 at 4/12, only shorter. A hip roof has
// four hip rafters and no gable studs.

const FT_IN = {
  type: 'setDisplayUnits',
  units: { length: { unit: 'ft-in', denominator: 16 }, angle: { unit: 'deg' } },
};
const WALL = 'extension#1';
const FLOOR = 'extension#2';
const ROOF = 'extension#3';

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

/** Member counts by role of a floor or roof, once regen has caught up with the document. */
async function roles(id: string): Promise<Record<string, number>> {
  await regenerated(page);
  await expect(page.getByTestId(`construction-members-${id}`)).toHaveText(/^\d+ members$/);
  return page.evaluate((feature) => {
    const out: Record<string, number> = {};
    for (const li of document.querySelectorAll(`[data-testid^="construction-role-${feature}-"]`)) {
      const role = li.getAttribute('data-testid')!.slice(`construction-role-${feature}-`.length);
      out[role] = Number(li.getAttribute('data-count'));
    }
    return out;
  }, id);
}

async function roof(): Promise<{ kind: unknown; pitch: string | undefined; types: unknown }> {
  return page.evaluate(() => {
    const doc = window.__manufakture!.document.getState().document;
    const f = doc.parts[0]!.features.find((x) => x.id === 'extension#3') as unknown as {
      params: { kind: unknown };
      expressions: Record<string, { source: string }>;
    };
    const data = doc.domains?.construction?.data as { roofTypes?: unknown } | undefined;
    return { kind: f.params.kind, pitch: f.expressions.pitch?.source, types: data?.roofTypes };
  });
}

test("draw the shed's walls", async () => {
  await execute(page, FT_IN, 'Feet and inches');
  await page.getByTestId('construction-open').click();
  await page.getByTestId('construction-start').click();
  await page.getByTestId('wall-type-new').click();
  await page.getByTestId('wall-type-header-stock').selectOption('us-2x6');
  await page.getByTestId('field-wall-type-header-plies').selectOption('2');
  await page.getByTestId('field-wall-type-header-jacks').selectOption('1');
  await page.getByTestId('wall-type-create').click();
  await page.getByTestId('construction-wall').click();
  for (const length of [`16'`, `12'`, `16'`]) {
    await page.getByTestId('wall-length').fill(length);
    await page.getByTestId('wall-length').press('Enter');
  }
  await page.getByTestId('wall-closed').check();
  await page.getByTestId('wall-add').click();
  await expect(page.getByTestId('wall-tool')).toBeHidden();
  const status = await regenerated(page);
  expect(status[WALL]?.status, JSON.stringify(status[WALL])).toBe('ok');
});

test('add a floor on three skids under the walls', async () => {
  await page.getByTestId('construction-floor').click();
  await expect(page.getByTestId(`floor-wall-${WALL}`)).toBeChecked();
  await page.getByTestId('floor-type-name').fill('Shed floor');
  await page.getByTestId('floor-type-joist').selectOption('us-2x6');
  await page.getByTestId('floor-type-subfloor').selectOption('us-osb-23-32');
  await page.getByTestId('floor-skids').check();
  await page.getByTestId('floor-skid-stock').selectOption('us-4x6');
  await page.getByTestId('field-floor-skid-count').selectOption('3');
  await page.getByTestId('floor-ok').click();
  await expect(page.getByTestId('floor-tool')).toBeHidden();
  const status = await regenerated(page);
  expect(status[FLOOR]?.status, JSON.stringify(status[FLOOR])).toBe('ok');
  expect(await roles(FLOOR)).toEqual({ joist: 13, rim: 2, skid: 3 });
});

const GABLE = { 'common-rafter': 26, ridge: 1, 'gable-stud': 16 };

test('add a 6/12 gable roof on the walls', async () => {
  await page.getByTestId('construction-roof').click();
  await expect(page.getByTestId(`roof-wall-${WALL}`)).toBeChecked();
  await page.getByTestId('roof-type-name').fill('Shed roof');
  await page.getByTestId('roof-type-rafter').selectOption('us-2x6');
  await page.getByTestId('roof-type-ridge').selectOption('us-2x8');
  // A bare number is ambiguous in a slope field.
  await page.getByTestId('roof-pitch').fill('30');
  await expect(page.getByTestId('roof-pitch-error')).toHaveText('Ambiguous: write 30° or 30/12');
  await page.getByTestId('roof-pitch').fill('6/12');
  await expect(page.getByTestId('roof-pitch-shown')).toHaveText('6/12, 26.57°');
  // The preview in the view carries the pitch.
  await expect(page.getByTestId('roof-pitch-label')).toHaveText('6/12, 26.57°');
  await page.getByTestId('roof-ok').click();
  await expect(page.getByTestId('roof-tool')).toBeHidden();
  await expect(page.getByTestId('roof-pitch-label')).toHaveCount(0);
  const status = await regenerated(page);
  expect(status[ROOF]?.status, JSON.stringify(status[ROOF])).toBe('ok');
  expect(await roles(ROOF)).toEqual(GABLE);
  await expect(page.getByTestId(`roof-summary-${ROOF}`)).toHaveText('Gable, 6/12, 26.57°');
});

test('change the pitch to 4/12, then switch to hip', async () => {
  await page.getByTestId(`construction-edit-${ROOF}`).click();
  await expect(page.getByTestId('roof-pitch')).toHaveValue('6/12');
  await page.getByTestId('roof-pitch').fill('4/12');
  await expect(page.getByTestId('roof-pitch-shown')).toHaveText('4/12, 18.43°');
  await page.getByTestId('roof-ok').click();
  await expect(page.getByTestId('roof-tool')).toBeHidden();
  await expect(page.getByTestId(`roof-summary-${ROOF}`)).toHaveText('Gable, 4/12, 18.43°');
  expect(await roles(ROOF)).toEqual(GABLE);

  await page.getByTestId(`construction-edit-${ROOF}`).click();
  await page.getByTestId('field-roof-kind').selectOption('hip');
  await page.getByTestId('roof-ok').click();
  // The roof type has no hip rafters yet: the tool asks for their stock.
  await expect(page.getByTestId('roof-tool')).toContainText('has no hip rafters');
  await page.getByTestId('roof-hip-stock').selectOption('us-2x8');
  await page.getByTestId('roof-ok').click();
  await expect(page.getByTestId('roof-tool')).toBeHidden();
  const status = await regenerated(page);
  expect(status[ROOF]?.status, JSON.stringify(status[ROOF])).toBe('ok');
  await expect(page.getByTestId(`roof-summary-${ROOF}`)).toHaveText('Hip, 4/12, 18.43°');
  const hip = await roles(ROOF);
  expect(hip).toMatchObject({ 'hip-rafter': 4, ridge: 1 });
  expect(hip['gable-stud']).toBeUndefined();
});

test('undo brings the 4/12 gable back', async () => {
  await page.getByRole('button', { name: /^Undo/ }).click();
  await expect(page.getByTestId(`roof-summary-${ROOF}`)).toHaveText('Gable, 4/12, 18.43°');
  expect(await roof()).toMatchObject({ kind: 'gable', pitch: '4/12' });
  // The hip stock came with the hip roof, in the same step: it went with it.
  expect(((await roof()).types as { hipStock?: string }[])[0]!.hipStock).toBeUndefined();
  expect(await roles(ROOF)).toEqual(GABLE);
});

test('a reload keeps the floor and the roof', async () => {
  await saved(page);
  await page.reload();
  await expect(page.getByTestId('document-name')).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId('construction-panel')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId(`construction-members-${ROOF}`)).toHaveText(/members$/, {
    timeout: 60_000,
  });
  expect(await roles(FLOOR)).toEqual({ joist: 13, rim: 2, skid: 3 });
  expect(await roles(ROOF)).toEqual(GABLE);
  await expect(page.getByTestId(`roof-summary-${ROOF}`)).toHaveText('Gable, 4/12, 18.43°');
  await expect(page.getByTestId('construction-disclaimer')).toContainText(
    'Not an engineering tool',
  );
});
