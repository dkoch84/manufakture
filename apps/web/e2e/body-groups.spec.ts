import { expect, test, type Page } from '@playwright/test';
import { ok, openEmpty, openTool, regenerated } from './bracket';
import { settle } from './helpers';
import { newSketch, rectangle } from './sketch-helpers';

// Body groups in the Bodies list (#1198), through the UI. Three separate new extrusions make a
// part with three bodies. Two are ticked and grouped (the name editor opens at once; Enter keeps
// `Group 1`), then renamed. Hiding the group hides both members in the viewport and is no undo
// step; hiding one member alone marks the group partly hidden; isolating the group hides the
// third body only. Groups are document data and come back after a reload; which bodies are
// hidden is per-session view state (it is not persisted: see src/state/viewSettings.ts), so
// after the reload nothing is hidden, the group included. Deleting the group leaves its bodies,
// and undo brings the group back.

const DEPTH = 10;
const GROUP = 'group#1';
const ALL = ['part#1/extrude#1', 'part#1/extrude#2', 'part#1/extrude#3'];

/** Zoom out until the view is at least `halfHeight` mm tall above and below its centre. */
async function zoomOut(page: Page, halfHeight = 40): Promise<void> {
  const box = (await page.getByTestId('viewport-canvas').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 20; i++) {
    const h = await page.evaluate(() => window.__manufakture!.viewport.info().halfHeight);
    if (h >= halfHeight) return;
    await page.mouse.wheel(0, 400);
    await settle(page);
  }
  throw new Error('The view did not zoom out');
}

/** A rectangle on Top, extruded `DEPTH` mm as a new body. */
async function newBody(
  page: Page,
  sketchId: string,
  a: [number, number],
  b: [number, number],
): Promise<void> {
  await zoomOut(page);
  await newSketch(page, 'Top (XY)');
  await rectangle(page, a, b);
  await page.getByRole('button', { name: 'Finish sketch' }).click();
  await expect(page.getByTestId(`feature-${sketchId}`)).toBeVisible();
  await page.getByTestId(`feature-${sketchId}`).click();
  await openTool(page, 'Extrude');
  await expect(page.getByTestId('field-sketch')).toHaveValue(sketchId);
  await page.getByTestId('field-operation').selectOption('new');
  await page.getByTestId('field-distance').fill(String(DEPTH));
  await ok(page);
  await regenerated(page);
  await settle(page);
}

/** The bodies the viewport draws, by view id, sorted. */
async function drawnBodies(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    window
      .__manufakture!.viewport.info()
      .bodies.map((b) => b.id)
      .sort(),
  );
}

/** The bodies hidden in the open document, by view id, sorted. */
function hiddenIds(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const m = window.__manufakture!;
    const id = m.document.getState().document.id;
    return [...(m.settings.getState().hiddenBodies[id] ?? [])].sort();
  });
}

/** The groups the document holds on its first part. */
function groupsInDocument(page: Page): Promise<unknown> {
  return page.evaluate(
    () =>
      (
        window.__manufakture!.document.getState().document.parts[0] as unknown as {
          bodyGroups?: unknown;
        }
      ).bodyGroups ?? null,
  );
}

const undoTitle = (page: Page) =>
  page.getByRole('button', { name: 'Undo', exact: true }).getAttribute('title');

async function saved(page: Page) {
  await expect(page.getByTestId('save-status')).toHaveText('Saved', { timeout: 15_000 });
}

test('body groups: group, rename, hide, isolate, collapse, reload, delete, undo', async ({
  page,
}) => {
  const errors = await openEmpty(page);

  // Three separate new bodies.
  await newBody(page, 'sketch#1', [-30, 0], [-15, 10]);
  await newBody(page, 'sketch#2', [-7, 0], [7, 10]);
  await newBody(page, 'sketch#3', [15, 0], [30, 10]);
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__manufakture!.model.getState().parts[0]!.bodies.map((b) => b.bodyId),
      ),
    )
    .toEqual(['extrude#1', 'extrude#2', 'extrude#3']);
  await expect.poll(() => drawnBodies(page)).toEqual(ALL);

  const section = page.getByRole('region', { name: 'Bodies' });
  const groupButton = page.getByTestId('new-body-group');
  await expect(groupButton).toBeVisible();
  await expect(groupButton).toHaveAccessibleName('Group selected bodies');
  // Nothing chosen yet: the button is there but disabled.
  await page.evaluate(() => window.__manufakture!.selection.getState().clear());
  await expect(groupButton).toBeDisabled();

  // Tick two bodies and group them: the name editor opens with the default name, Enter keeps it.
  await page.getByLabel('Select Body 1').check();
  await page.getByLabel('Select Body 2').check();
  await expect(page.getByTestId('body-pick-extrude#1')).toBeChecked();
  await expect(groupButton).toBeEnabled();
  await groupButton.click();
  const nameInput = page.getByLabel('New name for group Group 1');
  await expect(nameInput).toBeFocused();
  await expect(nameInput).toHaveValue('Group 1');
  await nameInput.press('Enter');
  await expect(nameInput).toHaveCount(0);
  const group = page.getByTestId(`body-group-${GROUP}`);
  await expect(group).toHaveAttribute('data-group', GROUP);
  await expect(group).toContainText('Group 1');
  expect(await groupsInDocument(page)).toEqual([
    { id: GROUP, name: 'Group 1', bodies: ['extrude#1', 'extrude#2'] },
  ]);
  // The ticks are cleared once the group is made.
  await expect(page.getByTestId('body-pick-extrude#1')).not.toBeChecked();
  await expect(page.getByTestId('body-pick-extrude#2')).not.toBeChecked();
  await expect(groupButton).toBeDisabled();

  // Rename it.
  await page.getByRole('button', { name: 'Rename group Group 1' }).click();
  await page.getByLabel('New name for group Group 1').fill('Pair');
  await page.getByLabel('New name for group Group 1').press('Enter');
  await expect(group).toContainText('Pair');
  expect(await groupsInDocument(page)).toEqual([
    { id: GROUP, name: 'Pair', bodies: ['extrude#1', 'extrude#2'] },
  ]);

  // The members are listed under the group; the third body is not.
  await expect(page.getByTestId(`body-group-count-${GROUP}`)).toHaveText('2 bodies');
  const members = group.getByRole('list', { name: 'Bodies in Pair' });
  await expect(members.getByRole('listitem')).toHaveCount(2);
  await expect(members.getByTestId('body-extrude#1')).toHaveAttribute('data-group', GROUP);
  await expect(members.getByTestId('body-extrude#2')).toHaveAttribute('data-group', GROUP);
  await expect(members.getByTestId('body-extrude#3')).toHaveCount(0);
  await expect(page.getByTestId('body-extrude#3')).not.toHaveAttribute('data-group');
  await expect(page.getByRole('button', { name: 'Remove Body 1 from Pair' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Remove Body 3 from Pair' })).toHaveCount(0);

  // Hide the group: both members leave the viewport, the third stays; no undo step.
  const undoBefore = await undoTitle(page);
  await page.getByRole('button', { name: 'Hide group Pair' }).click();
  await expect.poll(() => drawnBodies(page)).toEqual(['part#1/extrude#3']);
  expect(await hiddenIds(page)).toEqual(['part#1/extrude#1', 'part#1/extrude#2']);
  await expect(group).toHaveClass(/(^|\s)hidden(\s|$)/);
  await expect(group).not.toHaveClass(/partly-hidden/);
  const showGroup = page.getByRole('button', { name: 'Show group Pair' });
  await expect(showGroup).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('body-extrude#1')).toHaveClass(/(^|\s)hidden(\s|$)/);
  await expect(page.getByTestId('body-extrude#2')).toHaveClass(/(^|\s)hidden(\s|$)/);
  await expect(page.getByTestId('body-extrude#3')).not.toHaveClass(/(^|\s)hidden(\s|$)/);
  expect(await undoTitle(page)).toBe(undoBefore);

  // Show it again: all three are drawn.
  await showGroup.click();
  await expect.poll(() => drawnBodies(page)).toEqual(ALL);
  await expect(group).not.toHaveClass(/(^|\s)hidden(\s|$)/);
  await expect(page.getByRole('button', { name: 'Hide group Pair' })).toHaveAttribute(
    'aria-pressed',
    'false',
  );

  // One member hidden alone: the group is partly hidden, not hidden.
  await page.getByRole('button', { name: 'Hide Body 1' }).click();
  await expect.poll(() => drawnBodies(page)).toEqual(['part#1/extrude#2', 'part#1/extrude#3']);
  await expect(group).toHaveClass(/partly-hidden/);
  await expect(group).not.toHaveClass(/(^|\s)hidden(\s|$)/);
  await expect(page.getByRole('button', { name: 'Hide group Pair' })).toHaveAttribute(
    'aria-pressed',
    'mixed',
  );
  // Hiding the partly hidden group hides the rest of it.
  await page.getByRole('button', { name: 'Hide group Pair' }).click();
  await expect.poll(() => drawnBodies(page)).toEqual(['part#1/extrude#3']);
  await expect(group).toHaveClass(/(^|\s)hidden(\s|$)/);
  await page.getByRole('button', { name: 'Show group Pair' }).click();
  await expect.poll(() => drawnBodies(page)).toEqual(ALL);

  // Isolate the group: only its members are drawn, the non-member is hidden.
  await page.getByRole('button', { name: 'Isolate group Pair' }).click();
  await expect.poll(() => drawnBodies(page)).toEqual(['part#1/extrude#1', 'part#1/extrude#2']);
  expect(await hiddenIds(page)).toEqual(['part#1/extrude#3']);
  await expect(page.getByTestId('body-extrude#3')).toHaveClass(/(^|\s)hidden(\s|$)/);
  await expect(page.getByRole('button', { name: 'Show Body 3' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(group).not.toHaveClass(/hidden/);
  await expect(section.getByRole('button', { name: 'Show all' })).toBeVisible();
  expect(await undoTitle(page)).toBe(undoBefore);

  // Collapse and expand: the member list goes and comes back.
  const toggle = page.getByTestId(`body-group-toggle-${GROUP}`);
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(toggle).toHaveAccessibleName('Collapse Pair');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(toggle).toHaveAccessibleName('Expand Pair');
  await expect(group.getByRole('list', { name: 'Bodies in Pair' })).toHaveCount(0);
  await expect(page.getByTestId('body-extrude#1')).toHaveCount(0);
  await expect(page.getByTestId(`body-group-count-${GROUP}`)).toHaveText('2 bodies');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(members.getByRole('listitem')).toHaveCount(2);

  // Reload, with the third body still hidden by the isolate. The group is document data and is
  // kept; hidden bodies are per-session view state, so nothing is hidden afterwards.
  await saved(page);
  await page.reload();
  await expect(page.getByTestId(`body-group-${GROUP}`)).toBeVisible({ timeout: 90_000 });
  await regenerated(page);
  expect(await groupsInDocument(page)).toEqual([
    { id: GROUP, name: 'Pair', bodies: ['extrude#1', 'extrude#2'] },
  ]);
  await expect(page.getByTestId(`body-group-count-${GROUP}`)).toHaveText('2 bodies');
  await expect(
    page.getByRole('list', { name: 'Bodies in Pair' }).getByRole('listitem'),
  ).toHaveCount(2);
  await expect.poll(() => drawnBodies(page)).toEqual(ALL);
  expect(await hiddenIds(page)).toEqual([]);
  await expect(page.getByTestId(`body-group-${GROUP}`)).not.toHaveClass(/hidden/);
  await expect(page.getByTestId('body-extrude#3')).not.toHaveClass(/(^|\s)hidden(\s|$)/);
  await expect(page.getByRole('button', { name: 'Hide group Pair' })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  await expect(
    page.getByRole('region', { name: 'Bodies' }).getByRole('button', { name: 'Show all' }),
  ).toHaveCount(0);

  // Delete the group: its bodies stay, ungrouped, and are still drawn.
  await page.getByRole('button', { name: 'Delete group Pair' }).click();
  await expect(page.getByTestId(`body-group-${GROUP}`)).toHaveCount(0);
  expect(await groupsInDocument(page)).toBeNull();
  for (const id of ['extrude#1', 'extrude#2', 'extrude#3']) {
    await expect(page.getByTestId(`body-${id}`)).toBeVisible();
    await expect(page.getByTestId(`body-${id}`)).not.toHaveAttribute('data-group');
  }
  await expect(page.getByRole('region', { name: 'Bodies' }).locator('li.body-row')).toHaveCount(3);
  expect(
    await page.evaluate(() =>
      window.__manufakture!.model.getState().parts[0]!.bodies.map((b) => b.bodyId),
    ),
  ).toEqual(['extrude#1', 'extrude#2', 'extrude#3']);
  await expect.poll(() => drawnBodies(page)).toEqual(ALL);

  // Undo brings the group back with its members.
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByTestId(`body-group-${GROUP}`)).toBeVisible();
  expect(await groupsInDocument(page)).toEqual([
    { id: GROUP, name: 'Pair', bodies: ['extrude#1', 'extrude#2'] },
  ]);
  await expect(page.getByTestId(`body-group-count-${GROUP}`)).toHaveText('2 bodies');

  expect(errors).toEqual([]);
});
