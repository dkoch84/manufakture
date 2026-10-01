import { expect, test, type Page } from '@playwright/test';
import { ok, openEmpty, openTool, regenerated, view } from './bracket';
import { settle, type Vec3 } from './helpers';
import { execute } from './m2-fixtures';

// Threads (M3 plan, T3.2f; ADR 0012 decision 9), through the UI and the real regen worker: an M6
// bolt and a nut as two bodies of one part studio, each threaded with the Thread dialog on its
// picked round face, modelled, with the clearance the dialog starts from (#fit_slip). The bolt's
// thread cuts only the bolt, although the nut sits on it. Two instances in an assembly, one per
// body, show no interference. Then both threads go cosmetic (drawn as helix lines over resized
// faces) and back.

const MINOR = 4.917; // M6's basic minor diameter: the nut's hole as drilled.

const mm = (source: number) => ({ source: String(source), lengthUnit: 'mm', angleUnit: 'deg' });

function sketch(id: string, z: number, entities: unknown[]) {
  return {
    id,
    kind: 'sketch',
    name: id,
    suppressed: false,
    plane: { type: 'plane', origin: [0, 0, z], normal: [0, 0, 1], xDir: [1, 0, 0] },
    entities,
    constraints: [],
  };
}

const circle = (id: string, radius: number) => ({
  id,
  kind: 'circle',
  construction: false,
  center: [0, 0],
  radius,
});

function extrude(id: string, profile: string, distance: number, operation: string) {
  return {
    id,
    kind: 'extrude',
    name: id,
    suppressed: false,
    profile: { sketch: profile },
    operation,
    extent: { type: 'blind', distance: mm(distance) },
    reverse: false,
  };
}

/**
 * The bolt (body `extrude#1`): a head 10 across from z 0 to 4, a shank 6 across (`extrude#2`)
 * to z 24. The nut (body `extrude#3`): 12 across from z 10 to 16, with a hole at M6's minor
 * diameter.
 */
function boltAndNut(): unknown[] {
  const corners: [number, number][] = [
    [-6, -6],
    [6, -6],
    [6, 6],
    [-6, 6],
  ];
  const square = corners.map((start, i) => ({
    id: `e${i + 3}`,
    kind: 'line',
    construction: false,
    start,
    end: corners[(i + 1) % 4],
  }));
  const add = (feature: unknown) => ({ type: 'addFeature', partId: 'part#1', feature });
  return [
    add(sketch('sketch#1', 0, [circle('e1', 5)])),
    add(extrude('extrude#1', 'sketch#1', 4, 'new')),
    add(sketch('sketch#2', 4, [circle('e2', 3)])),
    add(extrude('extrude#2', 'sketch#2', 20, 'add')),
    add(sketch('sketch#3', 10, [...square, circle('e7', MINOR / 2)])),
    add(extrude('extrude#3', 'sketch#3', 6, 'new')),
  ];
}

/** Points round a cylinder of `radius` about z at heights `zs`, to look for a visible one. */
function ring(radius: number, zs: number[]): Vec3[] {
  const out: Vec3[] = [];
  for (const z of zs) {
    for (let a = 0; a < 360; a += 10) {
      const t = (a * Math.PI) / 180;
      out.push([radius * Math.cos(t), radius * Math.sin(t), z]);
    }
  }
  return out;
}

/** Click a point of face `name` the viewport shows (the first of `points` that picks it). */
async function pickFace(page: Page, name: string, points: Vec3[]): Promise<void> {
  await settle(page);
  const at = await page.evaluate(
    ([wanted, candidates]) => {
      const vp = window.__manufakture!.viewport;
      const rect = document
        .querySelector('[data-testid="viewport-canvas"]')!
        .getBoundingClientRect();
      for (const p of candidates) {
        const c = vp.projectToClient(p);
        const hit = vp.pickAt(c.x - rect.left, c.y - rect.top);
        if (hit?.kind === 'face' && hit.name === wanted) return c;
      }
      return null;
    },
    [name, points] as const,
  );
  expect(at, `a visible point of ${name}`).not.toBeNull();
  await page.mouse.click(at!.x, at!.y);
}

/** Thread the face `name` with the Thread dialog's defaults (the size it offers first). */
async function threadFace(page: Page, name: string, points: Vec3[]): Promise<void> {
  await openTool(page, 'Thread');
  await pickFace(page, name, points);
  const dialog = page.getByTestId('feature-dialog');
  await expect(dialog.getByTestId('ref-face')).toContainText(name);
  await expect(dialog.getByTestId('field-size')).toHaveValue('M6');
  await expect(dialog.getByTestId('field-clearance')).toHaveValue('#fit_slip');
  await expect(dialog.getByTestId('field-representation')).toHaveValue('modelled');
  await ok(page);
}

async function setRepresentation(page: Page, featureId: string, representation: string) {
  await page.getByTestId(`feature-${featureId}`).dblclick();
  const dialog = page.getByTestId('feature-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId('field-size')).toHaveValue('M6');
  await dialog.getByTestId('field-representation').selectOption(representation);
  await ok(page);
}

const threadLines = (page: Page) =>
  page.evaluate(
    () => (window.__manufakture!.viewport.info() as unknown as { threadLines: number }).threadLines,
  );

async function expectBuilt(page: Page, ids: string[]): Promise<void> {
  const statuses = await regenerated(page);
  for (const id of ids) {
    expect(statuses[id], id).toMatchObject({ status: 'ok', errors: [] });
  }
}

async function noInterference(page: Page): Promise<void> {
  await page.getByTestId('assembly-tab-assembly#1').click();
  await page.getByTestId('assembly-interference').click();
  const panel = page.getByTestId('interference-panel');
  await panel.getByTestId('interference-check').click();
  await expect(panel.getByTestId('interference-status')).toHaveText(
    'No interference between the 2 instances.',
    { timeout: 60_000 },
  );
  await panel.getByTestId('interference-close').click();
  await page.getByTestId('part-tab-part#1').click();
  await settle(page);
}

test('an M6 bolt and nut, threaded as two bodies, mate without interference', async ({ page }) => {
  test.setTimeout(240_000);
  const errors = await openEmpty(page);
  await page
    .getByRole('complementary', { name: 'Variables' })
    .getByTestId('variable-insert-fits')
    .click();
  await expect(page.getByTestId('variable-fit_slip-value')).toHaveText('0.20 mm');
  await execute(page, { type: 'batch', commands: boltAndNut() }, 'Make a bolt and a nut');
  await expectBuilt(page, ['extrude#1', 'extrude#2', 'extrude#3']);
  await view(page, 'iso');

  // The bolt: its shank, above the nut.
  await threadFace(page, 'extrude#2:side:e2', ring(3, [20, 22, 7]));
  await expectBuilt(page, ['thread#1']);
  await expect(page.getByTestId('detail-thread#1')).toHaveText('M6');
  const bolt = await page.evaluate(
    () =>
      window
        .__manufakture!.model.getState()
        .parts[0]!.features.find((f) => f.featureId === 'thread#1') as unknown as {
        thread: { bodyId: string; side: string };
      },
  );
  expect(bolt.thread).toMatchObject({ bodyId: 'extrude#1', side: 'external' });

  // The nut: hide the bolt, which fills its hole, to pick the hole's wall.
  const bodies = page.getByTestId('bodies');
  await bodies.getByTestId('body-extrude#1').getByRole('button', { name: /^Hide/ }).click();
  await threadFace(page, 'extrude#3:side:e7', ring(MINOR / 2, [15.5, 15, 14, 13]));
  await expectBuilt(page, ['thread#1', 'thread#2']);
  await bodies.getByTestId('body-extrude#1').getByRole('button', { name: /^Show/ }).click();
  const nut = await page.evaluate(
    () =>
      window
        .__manufakture!.model.getState()
        .parts[0]!.features.find((f) => f.featureId === 'thread#2') as unknown as {
        thread: { bodyId: string; side: string };
      },
  );
  expect(nut.thread).toMatchObject({ bodyId: 'extrude#3', side: 'internal' });
  expect(await threadLines(page)).toBe(0);

  // One instance per body, both where the part has them.
  const identity = { translation: [0, 0, 0], rotation: [0, 0, 0, 1] };
  const instance = (id: string, name: string, body: string, fixed: boolean) => ({
    type: 'addInstance',
    assemblyId: 'assembly#1',
    instance: {
      id,
      name,
      source: { part: 'part#1' },
      bodies: [body],
      fixed,
      suppressed: false,
      pose: identity,
    },
  });
  await execute(
    page,
    {
      type: 'batch',
      commands: [
        { type: 'addAssembly', assemblyId: 'assembly#1', name: 'Bolt and nut' },
        instance('inst#1', 'Bolt', 'extrude#1', true),
        instance('inst#2', 'Nut', 'extrude#3', false),
      ],
    },
    'Assemble the bolt and the nut',
  );
  await noInterference(page);

  // Cosmetic: no helical geometry, the faces resized and drawn with helix lines; then back.
  await setRepresentation(page, 'thread#1', 'cosmetic');
  await setRepresentation(page, 'thread#2', 'cosmetic');
  await expectBuilt(page, ['thread#1', 'thread#2']);
  await expect(page.getByTestId('detail-thread#2')).toHaveText('M6, cosmetic');
  await expect.poll(() => threadLines(page)).toBe(6);
  await setRepresentation(page, 'thread#1', 'modelled');
  await setRepresentation(page, 'thread#2', 'modelled');
  await expectBuilt(page, ['thread#1', 'thread#2']);
  await expect.poll(() => threadLines(page)).toBe(0);
  await noInterference(page);
  expect(errors).toEqual([]);
});
