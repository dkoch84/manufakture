import { expect, test, type Page } from '@playwright/test';
import { openEmpty, regenerated } from './bracket';
import { project, settle, type Vec3 } from './helpers';
import {
  BODY_NAMES,
  SHELF,
  execute,
  extrudeFeature,
  look,
  saved,
  shelfSketches,
  solved,
} from './m2-fixtures';

// Exploded views (M4 plan, T4.5a) with the real regen worker and the browser's storage.
//
// The bookshelf of M2's acceptance model (four boards in one part studio: two sides, a bottom and
// a top) is assembled per board, as decision 5 has it: one instance of the part studio per board,
// each showing that one body. Everything about the exploded view goes through the Explode panel:
// a new view, three steps (the top up, then each side out), the slider scrubbed from assembled to
// exploded, a fourth step added by dragging the bottom along an axis in the view, and a reload.
// Where each board is drawn is checked by picking the view where it should be; the solved and
// stored poses never move.

const A = 'assembly#1';
const W = SHELF.widths[0];
const { depth: D, height: H, board: T } = SHELF;
const IDENTITY = { translation: [0, 0, 0], rotation: [0, 0, 0, 1] };

/** The middle of each board's top face, assembled (instances in BODY_NAMES' order). */
const TOPS: Record<string, Vec3> = {
  'inst#1': [D / 2, T / 2, H],
  'inst#2': [D / 2, W - T / 2, H],
  'inst#3': [D / 2, W / 2, T],
  'inst#4': [D / 2, W / 2, H],
};

function documentCommands(): unknown[] {
  const heights = [H, H, T, T];
  return [
    { type: 'renameDocument', name: 'Bookshelf' },
    { type: 'renamePart', partId: 'part#1', name: 'Shelf' },
    { type: 'setVariable', name: 'width', expression: mm(`${W} mm`) },
    { type: 'setVariable', name: 'gap', expression: mm('120 mm') },
    ...shelfSketches('part#1'),
    ...heights.map((h, i) => ({
      type: 'addFeature',
      partId: 'part#1',
      feature: extrudeFeature(`extrude#${i + 1}`, `Extrude ${i + 1}`, `sketch#${i + 1}`, h),
    })),
    ...BODY_NAMES.map((name, i) => ({
      type: 'setBodyProps',
      partId: 'part#1',
      bodyId: `extrude#${i + 1}`,
      props: { name },
    })),
    { type: 'addAssembly', assemblyId: A, name: 'Bookshelf' },
    ...BODY_NAMES.map((name, i) => ({
      type: 'addInstance',
      assemblyId: A,
      instance: {
        id: `inst#${i + 1}`,
        name,
        source: { part: 'part#1' },
        bodies: [`extrude#${i + 1}`],
        fixed: true,
        suppressed: false,
        pose: IDENTITY,
      },
    })),
  ];
}

function mm(source: string) {
  return { source, lengthUnit: 'mm', angleUnit: 'deg' };
}

const add = (p: Vec3, q: Vec3): Vec3 => [p[0] + q[0], p[1] + q[1], p[2] + q[2]];

/** The instance drawn at world point `p` (picked through the view: faces only), or null. */
async function instanceAt(page: Page, p: Vec3): Promise<string | null> {
  await page.evaluate(() => {
    const sel = window.__manufakture!.selection.getState();
    sel.setKindEnabled('edge', false);
    sel.setKindEnabled('vertex', false);
  });
  await settle(page);
  const { x, y } = await project(page, p);
  return page.evaluate(
    ([cx, cy]) => {
      const box = document
        .querySelector('[data-testid="viewport-canvas"]')!
        .getBoundingClientRect();
      const hit = window.__manufakture!.viewport.pickAt(cx - box.left, cy - box.top);
      const body = hit && 'bodyId' in hit ? String((hit as { bodyId: string }).bodyId) : null;
      return body ? (/\/(inst#\d+)\//.exec(body)?.[1] ?? null) : null;
    },
    [x, y] as const,
  );
}

/** Regen's resolved steps of the assembly's first exploded view: per step, its instances' move. */
async function resolvedSteps(
  page: Page,
): Promise<{ instances: string[]; move: number[] | null }[]> {
  await regenerated(page);
  return page.evaluate((id) => {
    const a = window.__manufakture!.model.getState().assemblies.find((x) => x.assemblyId === id);
    const views = (
      a as unknown as {
        explodedViews?: {
          steps: { instances: string[]; direction: number[] | null; distance: number | null }[];
        }[];
      }
    ).explodedViews;
    return (views?.[0]?.steps ?? []).map((s) => ({
      instances: s.instances,
      move: s.direction && s.distance !== null ? s.direction.map((c) => c * s.distance! + 0) : null,
    }));
  }, A);
}

async function storedPoses(page: Page): Promise<unknown[]> {
  return page.evaluate(
    (id) =>
      window
        .__manufakture!.document.getState()
        .document.assemblies.find((a) => a.id === id)!
        .instances.map((x) => x.pose),
    A,
  );
}

async function addStep(page: Page, instance: string, axis: string, distance: string) {
  const panel = page.getByTestId('explode-panel');
  for (const box of await panel.locator('[data-testid^="explode-instance-"]').all()) {
    await box.setChecked(
      (await box.getAttribute('data-testid')) === `explode-instance-${instance}`,
    );
  }
  await panel.getByTestId('explode-axis').selectOption(axis);
  await panel.getByTestId('explode-distance').fill(distance);
  await panel.getByTestId('explode-add-step').click();
}

async function scrub(page: Page, percent: number) {
  await page.getByTestId('explode-progress').fill(String(percent));
  await expect(page.getByTestId('explode-progress-value')).toHaveText(`${percent}%`);
}

test('exploded views: three steps on the bookshelf, the slider, a dragged step, reload', async ({
  page,
}) => {
  const errors = await openEmpty(page);
  await execute(page, { type: 'batch', commands: documentCommands() }, 'Make the bookshelf');
  await page.getByTestId(`assembly-tab-${A}`).click();
  const asm = await solved(page, A);
  expect(asm.instances.map((x) => [x.instanceId, x.bodies])).toEqual([
    ['inst#1', ['extrude#1']],
    ['inst#2', ['extrude#2']],
    ['inst#3', ['extrude#3']],
    ['inst#4', ['extrude#4']],
  ]);
  await look(page, 'iso');
  await page.evaluate(() =>
    window.__manufakture!.viewport.frameBox({ min: [-50, -250, -50], max: [250, 850, 550] }, false),
  );
  for (const [id, p] of Object.entries(TOPS)) expect(await instanceAt(page, p)).toBe(id);

  // --- Three steps through the panel ---------------------------------------------------------
  await page.getByTestId('assembly-explode').click();
  const panel = page.getByTestId('explode-panel');
  await expect(panel.getByTestId('explode-empty')).toBeVisible();
  await panel.getByTestId('explode-new').click();
  await addStep(page, 'inst#4', '+z', '#gap');
  await addStep(page, 'inst#1', '-y', '150');
  await addStep(page, 'inst#2', '+y', '150');
  await expect(panel.getByTestId('explode-steps').locator(':scope > li')).toHaveCount(3);
  await expect(panel.getByTestId('explode-step-direction-step#2')).toHaveText('-Y');
  expect(await resolvedSteps(page)).toEqual([
    { instances: ['inst#4'], move: [0, 0, 120] },
    { instances: ['inst#1'], move: [0, -150, 0] },
    { instances: ['inst#2'], move: [0, 150, 0] },
  ]);
  // Exploded: each board where its steps took it; trails show the three moves.
  await expect(page.getByTestId('explode-overlay')).toHaveAttribute('data-trails', '3');
  expect(await instanceAt(page, add(TOPS['inst#4']!, [0, 0, 120]))).toBe('inst#4');
  expect(await instanceAt(page, add(TOPS['inst#1']!, [0, -150, 0]))).toBe('inst#1');
  expect(await instanceAt(page, add(TOPS['inst#2']!, [0, 150, 0]))).toBe('inst#2');
  await expect(page.getByTestId('explode-trail-step#1-inst#4')).toHaveAttribute(
    'data-end',
    `${D / 2},${W / 2},${H - T / 2 + 120}`,
  );

  // --- The slider: assembled, then part way ----------------------------------------------------
  await scrub(page, 0);
  await expect(page.getByTestId('explode-overlay')).toHaveCount(0);
  for (const [id, p] of Object.entries(TOPS)) expect(await instanceAt(page, p)).toBe(id);
  // Half way through three steps: the top all the way up, the left side half out, the right not.
  await scrub(page, 50);
  await expect(page.getByTestId('explode-overlay')).toHaveAttribute('data-trails', '2');
  expect(await instanceAt(page, add(TOPS['inst#4']!, [0, 0, 120]))).toBe('inst#4');
  await expect(page.getByTestId('explode-trail-step#2-inst#1')).toHaveAttribute(
    'data-end',
    `${D / 2},${T / 2 - 75},${H / 2}`,
  );
  expect(await instanceAt(page, TOPS['inst#2']!)).toBe('inst#2');
  await scrub(page, 100);

  // --- A fourth step, dragged: the bottom along +X -------------------------------------------
  await panel.getByTestId('explode-axis').selectOption('+x');
  for (const box of await panel.locator('[data-testid^="explode-instance-"]').all()) {
    await box.setChecked(false);
  }
  const from = await project(page, TOPS['inst#3']!);
  const to = await project(page, add(TOPS['inst#3']!, [100, 0, 0]));
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 4 });
  await page.mouse.move(to.x, to.y, { steps: 4 });
  await page.mouse.up();
  await expect(panel.getByTestId('explode-steps').locator(':scope > li')).toHaveCount(4);
  const dragged = (await resolvedSteps(page))[3]!;
  expect(dragged.instances).toEqual(['inst#3']);
  expect(Math.abs(dragged.move![0]! - 100)).toBeLessThanOrEqual(3);
  expect(dragged.move!.slice(1)).toEqual([0, 0]);
  expect(await instanceAt(page, add(TOPS['inst#3']!, [dragged.move![0]!, 0, 0]))).toBe('inst#3');

  // Nothing moved the stored poses; and an instance a step names cannot be deleted.
  expect(await storedPoses(page)).toEqual([IDENTITY, IDENTITY, IDENTITY, IDENTITY]);
  await expect(page.getByTestId('instance-delete-inst#4')).toBeDisabled();
  await expect(page.getByTestId('instance-delete-inst#4')).toHaveAttribute(
    'title',
    /step 1 of Exploded view 1/,
  );
  await saved(page);

  // --- A reload keeps the exploded view ---------------------------------------------------
  await page.reload();
  await expect(page.getByTestId('document-name')).toHaveText('Bookshelf', { timeout: 90_000 });
  await regenerated(page);
  await page.getByTestId(`assembly-tab-${A}`).click();
  await solved(page, A);
  await page.getByTestId('assembly-explode').click();
  await expect(page.getByTestId('explode-steps').locator(':scope > li')).toHaveCount(4);
  const after = await resolvedSteps(page);
  expect(after.slice(0, 3)).toEqual([
    { instances: ['inst#4'], move: [0, 0, 120] },
    { instances: ['inst#1'], move: [0, -150, 0] },
    { instances: ['inst#2'], move: [0, 150, 0] },
  ]);
  await look(page, 'iso');
  await page.evaluate(() =>
    window.__manufakture!.viewport.frameBox({ min: [-50, -250, -50], max: [250, 850, 550] }, false),
  );
  await expect(page.getByTestId('explode-overlay')).toHaveAttribute('data-trails', '4');
  expect(await instanceAt(page, add(TOPS['inst#4']!, [0, 0, 120]))).toBe('inst#4');
  expect(await storedPoses(page)).toEqual([IDENTITY, IDENTITY, IDENTITY, IDENTITY]);
  // Closing the panel shows the assembly assembled again.
  await page.getByTestId('explode-close').click();
  for (const [id, p] of Object.entries(TOPS)) expect(await instanceAt(page, p)).toBe(id);

  expect(errors).toEqual([]);
});
