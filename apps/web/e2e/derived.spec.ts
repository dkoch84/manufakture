import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import {
  BRACKET,
  bodyVolume,
  bracketVolume,
  buildBracket,
  editVariable,
  ok,
  openEmpty,
  openTool,
  regenerated,
  view,
} from './bracket';
import { clickWorld } from './helpers';

// Derived parts with the real regen worker and the browser's storage. The M1 bracket is built in
// document A and named as version "6 mm". Document B derives it through the Derived part dialog,
// rounds one of its edges (the top edge at the end of the foot), and has the exact volume. A is
// made 8 mm and named "8 mm"; B shows that an update is available, and updating the pin keeps
// the fillet on its edge (resolved exactly) at the new volume. Open source shows A read-only at
// the pinned version. B, exported as a .mfk, still regenerates after A is deleted and B is
// imported into a browser that never had A.

/** The rounded edge: where the foot's end face meets its top face, along Y. */
const ROUND = 2;
const roundedOff = BRACKET.width * ROUND * ROUND * (1 - Math.PI / 4);
const derivedVolume = (t: number) => bracketVolume(t) - roundedOff;

async function saved(page: Page) {
  await expect(page.getByTestId('save-status')).toHaveText('Saved', { timeout: 15_000 });
}

async function rename(page: Page, name: string) {
  const done = await page.evaluate(
    (n) =>
      window
        .__manufakture!.document.getState()
        .execute({ type: 'renameDocument', name: n }, 'Rename document').ok,
    name,
  );
  expect(done).toBe(true);
}

/** Name the open document's current state from the History panel. */
async function createVersion(page: Page, name: string) {
  await saved(page);
  await page.getByTestId('open-history').click();
  const history = page.getByRole('complementary', { name: 'History' });
  await history.getByTestId('version-create').click();
  await history.getByTestId('version-name').fill(name);
  await history.getByTestId('version-save').click();
  await expect(history.getByTestId(`version-${name}`)).toBeVisible();
  await history.getByRole('button', { name: 'Close history' }).click();
}

/** Open a stored document from the home screen and wait until it is rebuilt. */
async function openDocument(page: Page, name: string) {
  await page.getByTestId('open-home').click();
  await page.getByRole('button', { name, exact: true }).click();
  await expect(page.getByTestId('document-name')).toHaveText(name);
  await regenerated(page);
}

/** Every feature's status, and the fillet's reference, after the model shows the document. */
async function derivedState(page: Page) {
  const statuses = await regenerated(page);
  return {
    statuses: Object.fromEntries(Object.entries(statuses).map(([id, s]) => [id, s.status])),
    fillet: statuses['fillet#1']?.references.map((r) => ({ via: r.via, fragile: r.fragile })),
  };
}

test('a derived part is inserted, updated to a new version, and survives its source', async ({
  page,
  browser,
}) => {
  test.setTimeout(480_000);
  const errors = await openEmpty(page);

  // Document A: the bracket at 6 mm, named "6 mm".
  await rename(page, 'Bracket');
  await buildBracket(page, 6);
  await createVersion(page, '6 mm');
  const a = await page.evaluate(() => window.__manufakture!.document.getState().document.id);

  // Document B: derive A's part at "6 mm".
  await page.getByTestId('open-home').click();
  await page.getByRole('button', { name: 'New document' }).click();
  await expect(page.getByTestId('empty-hint')).toBeVisible();
  await rename(page, 'Deriving');
  await openTool(page, 'Derived part');
  const dialog = page.getByTestId('feature-dialog');
  await dialog.getByTestId('pin-document').selectOption({ label: 'Bracket' });
  await dialog.getByRole('button', { name: 'Use version 6 mm' }).click();
  await expect(dialog.getByTestId('pin-part')).toHaveValue('part#1');
  await expect(dialog.getByTestId('field-bodies')).toContainText('All bodies');
  await ok(page);
  expect((await derivedState(page)).statuses).toEqual({ 'derived#1': 'ok' });
  expect(await bodyVolume(page)).toBeCloseTo(bracketVolume(6), 3);
  const row = page.getByTestId('derived-source-derived#1');
  await expect(row).toContainText('From Bracket at 6 mm');
  await expect(page.getByTestId('update-available-derived#1')).toHaveCount(0);

  // Round the top edge at the end of the derived foot.
  await view(page, 'iso');
  await openTool(page, 'Fillet');
  await clickWorld(page, [BRACKET.length, -BRACKET.width / 4, 6]);
  await expect(page.getByTestId('ref-edges').locator('li')).toHaveCount(1);
  await expect(page.getByTestId('ref-edges')).toContainText('derived#1:from/extrude#1:');
  await page.getByTestId('field-radius').fill(String(ROUND));
  await ok(page);
  expect(await derivedState(page)).toEqual({
    statuses: { 'derived#1': 'ok', 'fillet#1': 'ok' },
    fillet: [{ via: 'exact', fragile: false }],
  });
  expect(await bodyVolume(page)).toBeCloseTo(derivedVolume(6), 3);
  await saved(page);
  const b = await page.evaluate(() => window.__manufakture!.document.getState().document.id);
  const edge = await page.evaluate(
    () =>
      window.__manufakture!.document.getState().document.parts[0]!.features[1] as unknown as {
        edges: { ref: { faces: string[] } }[];
      },
  );

  // A at 8 mm, named "8 mm".
  await openDocument(page, 'Bracket');
  await editVariable(page, 'thickness', '8');
  await regenerated(page);
  expect(await bodyVolume(page)).toBeCloseTo(bracketVolume(8), 3);
  await createVersion(page, '8 mm');

  // B knows there is a newer version; updating the pin keeps the fillet exact.
  await openDocument(page, 'Deriving');
  await expect(page.getByTestId('update-available-derived#1')).toBeVisible();
  await page.getByTestId('update-derived#1').click();
  await page
    .getByTestId('update-versions-derived#1')
    .getByRole('button', { name: 'Use version 8 mm' })
    .click();
  await expect(row).toContainText('From Bracket at 8 mm');
  await expect(page.getByTestId('update-available-derived#1')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toHaveAttribute(
    'title',
    'Undo Update Derived 1 to "8 mm" (Ctrl+Z)',
  );
  expect(await derivedState(page)).toEqual({
    statuses: { 'derived#1': 'ok', 'fillet#1': 'ok' },
    fillet: [{ via: 'exact', fragile: false }],
  });
  expect(await bodyVolume(page)).toBeCloseTo(derivedVolume(8), 3);
  // The fillet itself did not change: the same named edge.
  expect(
    await page.evaluate(
      () => window.__manufakture!.document.getState().document.parts[0]!.features[1],
    ),
  ).toEqual(edge);
  await saved(page);

  // Open source: A, read-only at the pinned version.
  await page.getByTestId('open-source-derived#1').click();
  await expect(page.getByTestId('document-name')).toHaveText('Bracket');
  await expect(page.getByTestId('history-viewer-label')).toHaveText('Viewing Version "8 mm"');
  await page.getByTestId('history-back').click();
  await expect(page.getByTestId('history-viewer')).toBeHidden();

  // B as a .mfk; then A is deleted.
  await page.getByTestId('open-home').click();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId(`doc-${b}`).getByRole('button', { name: 'Export' }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('Deriving.mfk');
  const mfk = await readFile(await download.path());
  const rowA = page.getByTestId(`doc-${a}`);
  await rowA.getByRole('button', { name: 'Delete' }).click();
  await rowA.getByRole('button', { name: 'Delete' }).click();
  await expect(rowA).toBeHidden();
  expect(errors).toEqual([]);

  // Elsewhere (a browser with none of these documents): B imports and regenerates on its own.
  const elsewhere = await browser.newContext();
  const other = await elsewhere.newPage();
  const otherErrors = await openEmpty(other);
  await other.getByTestId('open-home').click();
  await other.getByTestId('mfk-input').setInputFiles({
    name: 'Deriving.mfk',
    mimeType: 'application/vnd.manufakture+zip',
    buffer: mfk,
  });
  await expect(other.getByTestId('document-name')).toHaveText('Deriving', { timeout: 30_000 });
  expect(await derivedState(other)).toEqual({
    statuses: { 'derived#1': 'ok', 'fillet#1': 'ok' },
    fillet: [{ via: 'exact', fragile: false }],
  });
  expect(await bodyVolume(other)).toBeCloseTo(derivedVolume(8), 3);
  // Its source is not here: it says so, with nothing to update.
  await expect(other.getByTestId('derived-source-derived#1')).toContainText('Source not here');
  await expect(other.getByTestId('update-derived#1')).toHaveCount(0);
  expect(otherErrors).toEqual([]);
  await elsewhere.close();
});
