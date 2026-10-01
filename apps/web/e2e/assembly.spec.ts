import { expect, test, type Page } from '@playwright/test';
import { openEmpty, regenerated, view } from './bracket';
import { clickWorld, project, settle, type Vec3 } from './helpers';

// The assembly workspace (T2.3e) with the real regen worker and the browser's storage.
//
// The part studios are made with commands (four boxes: a box, a lid, a drawer and a handle);
// everything about the assemblies goes through the UI: assembly tabs, Insert, the Mate dialog
// with connectors picked in the view, the mates list, and dragging.
//
// - Assembly 1: the lid hinged on the box's top front edge by a revolute (DOF 1). Dragging the
//   lid turns it about the hinge: the hinge stays put and the lid only turns about X.
// - Assembly 2: the drawer in the box on a slider between their front faces (DOF 1), limited to
//   0 to 25 mm; dragging moves it along the slider only. A handle fastened 4 mm in front of the
//   drawer leaves the DOF as it was, and follows the drawer. Undo takes the fastening back.
//   The interference check finds nothing with the drawer pulled out, then the box and the drawer
//   overlapping by 1500 mm3 once the drawer is made too deep, and nothing again when it fits.
//   A part of another document, inserted at a named version, is placed and shown.
// - A reload brings back both assemblies, their instances, mates and poses.

const XY = { type: 'plane', origin: [0, 0, 0], normal: [0, 0, 1], xDir: [1, 0, 0] } as const;
const mm = (source: number) => ({ source: String(source), lengthUnit: 'mm', angleUnit: 'deg' });

/**
 * A `w` x `d` x `h` box from the origin in part studio `partId`: a fully constrained rectangle on
 * Top (e1 along +X at Y = 0, e2 right, e3 back, e4 left) extruded up. Faces: `extrude#1:cap:start`
 * (bottom), `extrude#1:cap:end` (top), `extrude#1:side:e1` (front, -Y) to `side:e4`.
 */
function box(partId: string, w: number, d: number, h: number): unknown[] {
  const corners: [number, number][] = [
    [0, 0],
    [w, 0],
    [w, d],
    [0, d],
  ];
  const ids = ['e1', 'e2', 'e3', 'e4'];
  const sketch = {
    id: 'sketch#1',
    kind: 'sketch',
    name: 'Sketch 1',
    suppressed: false,
    plane: XY,
    entities: corners.map((start, i) => ({
      id: ids[i],
      kind: 'line',
      construction: false,
      start,
      end: corners[(i + 1) % 4],
    })),
    constraints: [
      ...ids.map((id, i) => ({
        id: `k${i + 1}`,
        kind: 'coincident',
        a: { entity: id, at: 'end' },
        b: { entity: ids[(i + 1) % 4], at: 'start' },
      })),
      { id: 'k5', kind: 'horizontal', line: 'e1' },
      { id: 'k6', kind: 'horizontal', line: 'e3' },
      { id: 'k7', kind: 'vertical', line: 'e2' },
      { id: 'k8', kind: 'vertical', line: 'e4' },
      { id: 'k9', kind: 'coincident', a: { entity: 'e1', at: 'start' }, b: { entity: '@origin' } },
      {
        id: 'k10',
        kind: 'distance',
        a: { entity: 'e1', at: 'start' },
        b: { entity: 'e1', at: 'end' },
        value: mm(w),
      },
      {
        id: 'k11',
        kind: 'distance',
        a: { entity: 'e2', at: 'start' },
        b: { entity: 'e2', at: 'end' },
        value: mm(d),
      },
    ],
  };
  const extrude = {
    id: 'extrude#1',
    kind: 'extrude',
    name: 'Extrude 1',
    suppressed: false,
    profile: { sketch: 'sketch#1' },
    operation: 'new',
    extent: { type: 'blind', distance: mm(h) },
    reverse: false,
  };
  return [
    { type: 'addFeature', partId, feature: sketch },
    { type: 'addFeature', partId, feature: extrude },
  ];
}

async function execute(page: Page, command: unknown, label: string): Promise<void> {
  const ok = await page.evaluate(
    ([c, l]) => window.__manufakture!.document.getState().execute(c, l as string).ok,
    [command, label] as const,
  );
  expect(ok, label).toBe(true);
}

async function saved(page: Page) {
  await expect(page.getByTestId('save-status')).toHaveText('Saved', { timeout: 15_000 });
}

/** The active assembly's regen result, once the model shows the open document. */
async function solved(page: Page, assemblyId: string) {
  await regenerated(page);
  await settle(page);
  return page.evaluate(
    (id) => window.__manufakture!.model.getState().assemblies.find((a) => a.assemblyId === id)!,
    assemblyId,
  );
}

/** Where the Mate dialog's preview shows an instance (rounded), from the viewport. */
async function solvedPreview(page: Page, instanceId: string) {
  return page.evaluate((id) => {
    const r = (v: number) => Math.round(v * 1e6) / 1e6 + 0;
    const t = window.__manufakture!.assemblyUi.getState().poses.get(id);
    return t ? { translation: t.translation.map(r), rotation: t.rotation.map(r) } : null;
  }, instanceId);
}

const instance = (a: E2eAssemblyResult, id: string) =>
  a.instances.find((x) => x.instanceId === id)!;

/** A point of an instance in world coordinates (`p_world = R p + t`, R a unit quaternion). */
function place(pose: E2ePose, p: Vec3): Vec3 {
  const [x, y, z, w] = pose.rotation;
  const [px, py, pz] = p;
  const c = [y * pz - z * py, z * px - x * pz, x * py - y * px];
  const d = [y * c[2]! - z * c[1]!, z * c[0]! - x * c[2]!, x * c[1]! - y * c[0]!];
  return [
    px + 2 * (w * c[0]! + d[0]!) + pose.translation[0],
    py + 2 * (w * c[1]! + d[1]!) + pose.translation[1],
    pz + 2 * (w * c[2]! + d[2]!) + pose.translation[2],
  ];
}

function expectNear(actual: readonly number[], expected: readonly number[], digits = 3) {
  expect(actual.length).toBe(expected.length);
  actual.forEach((v, i) => expect(v, `component ${i}`).toBeCloseTo(expected[i]!, digits));
}

/** Insert part studios into the active assembly from the Insert panel. */
async function insert(page: Page, partIds: string[]) {
  await page.getByTestId('assembly-insert').click();
  const panel = page.getByTestId('insert-panel');
  for (const id of partIds) {
    await panel.getByTestId(`insert-part-${id}`).click();
    await expect(panel.getByTestId('insert-message')).toContainText('Inserted');
  }
  await panel.getByTestId('insert-close').click();
  await expect(panel).toBeHidden();
}

/** Pick a connector in the view and wait until the dialog shows it. */
async function pickConnector(page: Page, side: 'a' | 'b', at: Vec3) {
  const dialog = page.getByTestId('mate-dialog');
  await dialog.getByTestId(`mate-pick-${side}`).click();
  await clickWorld(page, at);
  await expect(dialog.getByTestId(`mate-connector-label-${side}`)).toBeVisible();
}

/** Drag with the left button from one canvas point to another, in steps. */
async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  const steps = 12;
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(
      from.x + ((to.x - from.x) * i) / steps,
      from.y + ((to.y - from.y) * i) / steps,
    );
    // Let the worker answer some of the steps, as a hand would.
    await page.waitForTimeout(30);
  }
  await page.mouse.up();
}

test('assemblies: a hinged lid, a drawer on a slider with a handle, a pinned part, reload', async ({
  page,
}) => {
  test.setTimeout(300_000);
  const errors = await openEmpty(page);

  // Another document with a knob, named as version "v1", to insert from later.
  await execute(
    page,
    {
      type: 'batch',
      commands: [
        { type: 'renameDocument', name: 'Knob' },
        { type: 'renamePart', partId: 'part#1', name: 'Knob' },
        ...box('part#1', 6, 6, 6),
      ],
    },
    'Make a knob',
  );
  await regenerated(page);
  await saved(page);
  const version = await page.evaluate(() =>
    window.__manufakture!.autosave.createVersion({ name: 'v1' }),
  );
  expect(version.ok).toBe(true);

  // The chest: a box, a lid, a drawer and a handle.
  await page.getByTestId('open-home').click();
  await page.getByRole('button', { name: 'New document' }).click();
  await expect(page.getByTestId('empty-hint')).toBeVisible();
  await execute(
    page,
    {
      type: 'batch',
      commands: [
        { type: 'renameDocument', name: 'Chest' },
        { type: 'renamePart', partId: 'part#1', name: 'Box' },
        ...box('part#1', 40, 30, 20),
        { type: 'addPart', partId: 'part#2', name: 'Lid' },
        ...box('part#2', 40, 30, 5),
        { type: 'addPart', partId: 'part#3', name: 'Drawer' },
        ...box('part#3', 30, 20, 10),
        { type: 'addPart', partId: 'part#4', name: 'Handle' },
        ...box('part#4', 10, 4, 4),
      ],
    },
    'Make the parts',
  );
  await regenerated(page);

  // --- Assembly 1: the hinged lid ---------------------------------------------------------
  await page.getByTestId('assembly-add').click();
  await expect(page.getByTestId('assembly-tab-assembly#1')).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByTestId('assembly-hint')).toBeVisible();
  await insert(page, ['part#1', 'part#2']);
  // The first instance is fixed. Set the lid aside, so both can be picked.
  await expect(page.getByTestId('instance-inst#1')).toContainText('fixed');
  await execute(
    page,
    {
      type: 'setPoses',
      assemblyId: 'assembly#1',
      poses: { 'inst#2': { translation: [60, 0, 0], rotation: [0, 0, 0, 1] } },
    },
    'Set the lid aside',
  );
  let asm = await solved(page, 'assembly#1');
  expect(asm.dof).toBe(6);
  expect(
    await page.evaluate(() => window.__manufakture!.viewport.info().bodies.map((b) => b.id)),
  ).toEqual(['assembly#1/inst#1/extrude#1', 'assembly#1/inst#2/extrude#1']);

  // Picking on an instance names the face in its part, wherever the instance is.
  await view(page, 'iso');
  await clickWorld(page, [80, 15, 5]);
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__manufakture!.selection.getState().selected.map((i) => `${i.kind} ${i.id}`),
      ),
    )
    .toEqual(['face assembly#1/inst#2/extrude#1/extrude#1:cap:end']);
  await page.evaluate(() => window.__manufakture!.selection.getState().clear());
  // Hovering shows where a connector picked there would sit: the face's centroid, and on an
  // edge its midpoint.
  const hover = page.getByTestId('connector-hover');
  const centroid = await project(page, [80, 15, 5]);
  await page.mouse.move(centroid.x + 15, centroid.y + 4);
  await expect(hover).toContainText('Centroid');
  const marked = async () => {
    const box = (await page.getByTestId('viewport-canvas').boundingBox())!;
    return [
      box.x + Number(await hover.getAttribute('data-x')),
      box.y + Number(await hover.getAttribute('data-y')),
    ];
  };
  expectNear(await marked(), [centroid.x, centroid.y], 0);
  const edge = await project(page, [65, 0, 5]);
  await page.mouse.move(edge.x, edge.y);
  await expect(hover).toContainText('Midpoint');
  const midpoint = await project(page, [80, 0, 5]);
  expectNear(await marked(), [midpoint.x, midpoint.y], 0);

  // A revolute between the box's top front edge and the lid's bottom front edge.
  await page.getByTestId('assembly-mate').click();
  const dialog = page.getByTestId('mate-dialog');
  await dialog.getByTestId('mate-kind').selectOption('revolute');
  await pickConnector(page, 'a', [20, 0, 20]);
  await expect(dialog.getByTestId('mate-connector-label-a')).toContainText(
    'Box 1: midpoint of extrude#1:cap:end | extrude#1:side:e1',
  );
  await pickConnector(page, 'b', [80, 0, 0]);
  await expect(dialog.getByTestId('mate-connector-label-b')).toContainText(
    'Lid 1: midpoint of extrude#1:cap:start | extrude#1:side:e1',
  );
  // The two edges run opposite ways (their faces name them so): as picked, the lid would hang
  // upside down inside the box. Flipping the second connector lays it on the box.
  await expect(dialog.getByTestId('mate-preview')).toContainText('1 degree of freedom');
  await expect
    .poll(() => solvedPreview(page, 'inst#2'))
    .toEqual({ translation: [40, 0, 20], rotation: [0, 1, 0, 0] });
  await dialog.getByTestId('mate-flip').check();
  await expect
    .poll(() => solvedPreview(page, 'inst#2'))
    .toEqual({ translation: [0, 0, 20], rotation: [0, 0, 0, 1] });
  await dialog.getByTestId('mate-ok').click();
  await expect(dialog).toBeHidden();
  asm = await solved(page, 'assembly#1');
  expect(asm.dof).toBe(1);
  expect(asm.mates).toMatchObject([{ mateId: 'mate#1', status: 'ok' }]);
  await expect(page.getByTestId('assembly-dof')).toHaveText('1 degree of freedom');
  await expect(page.getByTestId('mate-status-mate#1')).toHaveText('OK');
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toHaveAttribute(
    'title',
    'Undo Add Revolute 1 (Ctrl+Z)',
  );
  // The hinge: the lid's bottom front edge lies on the box's top front edge, and the lid lies on
  // the box.
  let lid = instance(asm, 'inst#2').transform;
  expectNear(place(lid, [0, 0, 0]), [0, 0, 20]);
  expectNear(place(lid, [40, 0, 0]), [40, 0, 20]);
  expectNear(place(lid, [20, 30, 5]), [20, 30, 25]);

  // Drag the back of the lid up: it turns about the hinge, and only about it.
  await view(page, 'right');
  const grab = await project(page, place(lid, [20, 25, 2.5]));
  await drag(page, grab, { x: grab.x, y: grab.y - 120 });
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toHaveAttribute(
    'title',
    'Undo Drag Lid 1 (Ctrl+Z)',
  );
  asm = await solved(page, 'assembly#1');
  lid = instance(asm, 'inst#2').transform;
  expectNear(place(lid, [0, 0, 0]), [0, 0, 20]);
  expectNear(place(lid, [40, 0, 0]), [40, 0, 20]);
  // A turn about X: no Y or Z in the rotation, and the back of the lid is up.
  expect(Math.abs(lid.rotation[1])).toBeLessThan(1e-6);
  expect(Math.abs(lid.rotation[2])).toBeLessThan(1e-6);
  expect(place(lid, [20, 30, 0])[2]).toBeGreaterThan(30);
  expect(asm.dof).toBe(1);
  const lidPose = lid;

  // --- Assembly 2: the drawer, its handle and a pinned knob ---------------------------------
  await page.getByTestId('assembly-add').click();
  await expect(page.getByTestId('assembly-tab-assembly#2')).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await insert(page, ['part#1', 'part#3']);
  // The drawer, pulled 15 mm out of the box's front and set aside: the slider keeps the 15 mm.
  await execute(
    page,
    {
      type: 'setPoses',
      assemblyId: 'assembly#2',
      poses: { 'inst#2': { translation: [60, -15, 0], rotation: [0, 0, 0, 1] } },
    },
    'Set the drawer aside',
  );
  await solved(page, 'assembly#2');
  await view(page, 'iso');
  // A slider between the box's front face and the drawer's front face, limited to 0 to 25 mm.
  await page.getByTestId('assembly-mate').click();
  await dialog.getByTestId('mate-kind').selectOption('slider');
  await pickConnector(page, 'a', [20, 0, 10]);
  await expect(dialog.getByTestId('mate-connector-label-a')).toContainText(
    'Box 1: centroid of extrude#1:side:e1',
  );
  await pickConnector(page, 'b', [75, -15, 5]);
  await dialog.getByTestId('mate-limit-min').fill('0');
  await dialog.getByTestId('mate-limit-max').fill('25');
  await expect(dialog.getByTestId('mate-preview')).toContainText('1 degree of freedom');
  await dialog.getByTestId('mate-ok').click();
  await expect(dialog).toBeHidden();
  asm = await solved(page, 'assembly#2');
  expect(asm.dof).toBe(1);
  let drawer = instance(asm, 'inst#2').transform;
  // In the box, flush with its front face at 15 mm out: front face centroid on the box's.
  expectNear(drawer.translation, [5, -15, 5]);
  expectNear(drawer.rotation, [0, 0, 0, 1]);
  expect(asm.mates[0]!.coordinates[0]).toBeCloseTo(15, 3);

  // Drag the drawer sideways and in: it moves along the slider only.
  const top = await project(page, [20, -5, 15]);
  const aside = await project(page, [60, -40, 15]);
  await drag(page, top, aside);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toHaveAttribute(
    'title',
    'Undo Drag Drawer 1 (Ctrl+Z)',
  );
  asm = await solved(page, 'assembly#2');
  drawer = instance(asm, 'inst#2').transform;
  expect(drawer.translation[0]).toBeCloseTo(5, 6);
  expect(drawer.translation[2]).toBeCloseTo(5, 6);
  expectNear(drawer.rotation, [0, 0, 0, 1], 6);
  // Out as far as the 25 mm limit lets it.
  expect(drawer.translation[1]).toBeLessThan(-15);
  expect(drawer.translation[1]).toBeGreaterThanOrEqual(-25 - 1e-6);
  const out = -drawer.translation[1];

  // The handle, fastened 4 mm in front of the drawer: the DOF stays 1.
  await insert(page, ['part#4']);
  await execute(
    page,
    {
      type: 'setPoses',
      assemblyId: 'assembly#2',
      poses: { 'inst#3': { translation: [120, -20, 0], rotation: [0, 0, 0, 1] } },
    },
    'Set the handle aside',
  );
  asm = await solved(page, 'assembly#2');
  expect(asm.dof).toBe(7);
  await view(page, 'iso');
  await page.getByTestId('assembly-mate').click();
  await pickConnector(page, 'a', [20, -out, 10]);
  await expect(dialog.getByTestId('mate-connector-label-a')).toContainText(
    'Drawer 1: centroid of extrude#1:side:e1',
  );
  // The handle is small: faces only, so its edges do not take the click.
  await page.getByRole('checkbox', { name: 'Edges', exact: true }).uncheck();
  await page.getByRole('checkbox', { name: 'Vertices', exact: true }).uncheck();
  await pickConnector(page, 'b', [125, -20, 2]);
  await page.getByRole('checkbox', { name: 'Edges', exact: true }).check();
  await page.getByRole('checkbox', { name: 'Vertices', exact: true }).check();
  await expect(dialog.getByTestId('mate-connector-label-b')).toContainText(
    'Handle 1: centroid of extrude#1:side:e1',
  );
  await dialog.getByTestId('mate-offset-z').fill('4');
  await expect(dialog.getByTestId('mate-preview')).toContainText('1 degree of freedom');
  await dialog.getByTestId('mate-ok').click();
  await expect(dialog).toBeHidden();
  asm = await solved(page, 'assembly#2');
  expect(asm.dof).toBe(1);
  expect(asm.mates.map((m) => m.status)).toEqual(['ok', 'ok']);
  expectNear(instance(asm, 'inst#3').transform.translation, [15, -out - 4, 8]);

  // Undo takes the fastening back (the handle is free again); redo puts it back.
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  asm = await solved(page, 'assembly#2');
  expect(asm.mates).toHaveLength(1);
  expect(asm.dof).toBe(7);
  await expect(page.getByTestId('mate-mate#2')).toHaveCount(0);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  asm = await solved(page, 'assembly#2');
  expect(asm.dof).toBe(1);
  await expect(page.getByTestId('mate-mate#2')).toBeVisible();

  // --- Interference (T2.3d) ---------------------------------------------------------------
  // The drawer pulled out to its 25 mm limit (y -25..-5) clears the solid box (y 0..30), and the
  // handle only touches the drawer's front: nothing overlaps.
  await execute(
    page,
    {
      type: 'setPoses',
      assemblyId: 'assembly#2',
      poses: { 'inst#2': { translation: [5, -25, 5], rotation: [0, 0, 0, 1] } },
    },
    'Pull the drawer out',
  );
  asm = await solved(page, 'assembly#2');
  expectNear(instance(asm, 'inst#2').transform.translation, [5, -25, 5]);
  await page.getByTestId('assembly-interference').click();
  const interference = page.getByTestId('interference-panel');
  const status = interference.getByTestId('interference-status');
  await interference.getByTestId('interference-check').click();
  await expect(status).toHaveText('No interference between the 3 instances.');
  await expect(interference.getByTestId('interference-list')).toHaveCount(0);

  // A drawer too deep for where it is: 30 mm instead of 20 reaches 5 mm into the box, over its
  // 30 mm width and 10 mm height: 30 x 5 x 10 = 1500 mm3.
  const drawerSketch = (depth: number) => box('part#3', 30, depth, 10)[0] as { feature: unknown };
  await execute(
    page,
    { type: 'editFeature', partId: 'part#3', feature: drawerSketch(30).feature },
    'Make the drawer too deep',
  );
  await solved(page, 'assembly#2');
  await expect(status).toHaveAttribute('data-changed', 'true');
  await interference.getByTestId('interference-check').click();
  await expect(status).toHaveText('1 pair overlaps.');
  const clash = interference.getByTestId('interference-pair-inst#1/inst#2');
  await expect(clash).toContainText('Box 1 and Drawer 1');
  await expect(clash).toContainText('1500.00 mm³');
  expect(Number(await clash.getAttribute('data-volume'))).toBeCloseTo(1500, 3);
  await expect(interference.locator('[data-testid^="interference-pair-"]')).toHaveCount(1);
  // Picking the pair selects both instances and outlines the overlap (a 30 x 5 x 10 block).
  await clash.click();
  await expect(page.getByTestId('interference-overlay')).toHaveAttribute('data-edges', '12');
  // Each face's id is `<assembly id>/<instance id>/<body id>/<face name>`.
  const picked = await page.evaluate(() =>
    window
      .__manufakture!.selection.getState()
      .selected.map((i) => i.id.split('/').slice(0, 3).join('/')),
  );
  expect(new Set(picked)).toEqual(
    new Set(['assembly#2/inst#1/extrude#1', 'assembly#2/inst#2/extrude#1']),
  );

  // Back to 20 mm: the list is empty again.
  await execute(
    page,
    { type: 'editFeature', partId: 'part#3', feature: drawerSketch(20).feature },
    'Make the drawer fit',
  );
  await solved(page, 'assembly#2');
  await interference.getByTestId('interference-check').click();
  await expect(status).toHaveText('No interference between the 3 instances.');
  await expect(interference.locator('[data-testid^="interference-pair-"]')).toHaveCount(0);
  await expect(page.getByTestId('interference-overlay')).toHaveCount(0);
  await interference.getByTestId('interference-close').click();
  await expect(interference).toBeHidden();

  // The knob of the other document, at version v1: placed (free) and shown.
  await page.getByTestId('assembly-insert').click();
  const panel = page.getByTestId('insert-panel');
  await panel.getByTestId('pin-document').selectOption({ label: 'Knob' });
  await panel.getByRole('button', { name: 'Use version v1' }).click();
  await expect(panel.getByTestId('insert-pinned')).toHaveText('Insert Knob at v1');
  await panel.getByTestId('insert-pinned').click();
  await expect(panel.getByTestId('insert-message')).toContainText('Inserted Knob 1');
  await panel.getByTestId('insert-close').click();
  asm = await solved(page, 'assembly#2');
  expect(asm.dof).toBe(7);
  expect(instance(asm, 'inst#4')).toMatchObject({ status: 'ok', bodies: ['extrude#1'] });
  await expect
    .poll(() => page.evaluate(() => window.__manufakture!.viewport.info().bodies.map((b) => b.id)))
    .toContain('assembly#2/inst#4/extrude#1');
  await saved(page);

  // --- A reload keeps everything ---------------------------------------------------------
  expect(new URL(page.url()).searchParams.get('part')).toBe('assembly#2');
  await page.reload();
  await expect(page.getByTestId('document-name')).toHaveText('Chest', { timeout: 90_000 });
  // The assembly tab that was open is open again.
  await expect(page.getByTestId('assembly-tab-assembly#2')).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await regenerated(page);
  const doc = await page.evaluate(
    () => window.__manufakture!.document.getState().document.assemblies,
  );
  expect(doc.map((a) => [a.id, a.instances.length, a.mates.map((m) => m.kind)])).toEqual([
    ['assembly#1', 2, ['revolute']],
    ['assembly#2', 4, ['slider', 'fastened']],
  ]);
  await page.getByTestId('assembly-tab-assembly#1').click();
  asm = await solved(page, 'assembly#1');
  expect(asm.dof).toBe(1);
  expectNear(instance(asm, 'inst#2').transform.translation, lidPose.translation, 6);
  expectNear(instance(asm, 'inst#2').transform.rotation, lidPose.rotation, 6);
  await page.getByTestId('assembly-tab-assembly#2').click();
  asm = await solved(page, 'assembly#2');
  expect(asm.dof).toBe(7);
  expect(asm.mates.map((m) => m.status)).toEqual(['ok', 'ok']);
  expect(instance(asm, 'inst#4').status).toBe('ok');
  await expect(page.getByTestId('assembly-dof')).toHaveText('7 degrees of freedom');

  expect(errors).toEqual([]);
});
