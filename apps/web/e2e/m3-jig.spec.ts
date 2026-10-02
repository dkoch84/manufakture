import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { buildMeshes, meshProperties, validate3mf } from '@manufakture/io';
import { checkBedFit, classifyOverhangs, findPrinter } from '@manufakture/print';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { addVariable, editVariable, ok, openEmpty, openTool, regenerated, view } from './bracket';
import { clickWorld, settle, type Vec3 } from './helpers';
import {
  BLOCK,
  FACES,
  JIG,
  SCREW,
  THREAD_TOLERANCE,
  addSketch,
  bodyVolumes,
  checked,
  jigVolumes,
  lookAt,
  pick,
  printBodies,
  printIssues,
  ring,
  threadReference,
  threadReport,
  type PrintBody,
} from './m3-fixtures';
import { execute, saved } from './m2-fixtures';
import { sketchIdle, sketchToClient, tool, type Vec2 } from './sketch-helpers';

// M3 acceptance: a cutting jig for 4 mm PTFE tube, end to end (docs/m3-acceptance.md). The
// chapters share one browser page and its storage, so they run in order and a failing chapter
// skips the ones after it. Every M3 feature is used through its UI: Insert fit variables, the
// Text tool and the Extrude dialog's region picker, the Thread dialog with its face picked in the
// view, the Print workspace (setup, items, Lay flat on face, the Issues list) and Open in slicer.
// The profiles are sketched with commands (m3-fixtures.ts says why); the features on them go
// through their dialogs.
//
//  1. Variables: #length, #width, #height, #blade, and the fit variables; the block, extruded.
//  2. The label "PTFE 4" on the top face, debossed 0.6 mm: the volume drops by its letters' area
//     times the depth.
//  3. The bore, 4 mm + #fit_slip through the length, and a 0.5 mm chamfer on its entry edge.
//  4. The blade slot across the bore, #blade + #fit_press wide.
//  5. The side hole into the bore, threaded M5 (modelled) with the Thread dialog: the thread's
//     volume against the profile reference, within T3.2e's tolerance.
//  6. The thumbscrew, a second body in a second colour: a lobed head and an M5 shank, threaded.
//  7. A print setup on the X1 Carbon, each body laid flat (the block on its base, the thumbscrew
//     on its head): it fits; overhangs only where expected, the thumbscrew's flanks steep and
//     not overhanging; one teardrop flag, on the bore; thin walls only on the threads' teeth,
//     the label's letters and the head's lobes.
//  8. Open in slicer: the 3MF is valid, two objects in two colours, both on the X1 Carbon's
//     plate and 5 mm clear of its excluded corner. It goes to test-results/m3-jig/.
//  9. A looser slip fit: #fit_slip from 0.2 to 0.3 mm, and the bore, the side hole, the shank and
//     both threads follow; the print checks with them.
// 10. A reload brings it all back.
//
// With M3_DOCS=1 the run also refreshes the screenshots in docs/m3-acceptance/.

test.describe.configure({ mode: 'serial' });

let page: Page;
let errors: string[];

const x1c = findPrinter('bambu-x1c')!;

const docsDir = (info: TestInfo) => resolve(info.project.testDir, '../../../docs/m3-acceptance');

async function docShot(name: string): Promise<void> {
  if (!process.env.M3_DOCS) return;
  await page.mouse.move(0, 0);
  await settle(page);
  const dir = docsDir(test.info());
  await mkdir(dir, { recursive: true });
  await page.screenshot({ path: join(dir, `${name}.png`) });
}

/** Every feature ok, without errors or warnings. */
async function allOk(): Promise<void> {
  const statuses = await regenerated(page);
  for (const [id, s] of Object.entries(statuses)) {
    expect(s, id).toMatchObject({ status: 'ok', errors: [], warnings: [] });
  }
}

/** Select a sketch in the tree and open the Extrude dialog on it. */
async function extrudeDialog(sketch: string): Promise<void> {
  await page.getByTestId(`feature-${sketch}`).click();
  await openTool(page, 'Extrude');
  await expect(page.getByTestId('field-sketch')).toHaveValue(sketch);
}

/** The volumes of the shown bodies, once they are what `expected` says to `digits`. */
async function expectVolumes(expected: Record<string, number>, digits = 3): Promise<void> {
  await expect
    .poll(
      async () => {
        const v = await bodyVolumes(page);
        return Object.fromEntries(Object.keys(expected).map((k) => [k, v[k] ?? null]));
      },
      { timeout: 60_000 },
    )
    .toEqual(
      Object.fromEntries(Object.entries(expected).map(([k, x]) => [k, expect.closeTo(x, digits)])),
    );
}

/** The sketch point of the open sketch at world point `p` (its plane's own frame). */
function sketchPointAt(p: Vec3): Promise<Vec2> {
  return page.evaluate((q) => {
    const s = window.__manufakture!.sketcher.store.getState();
    const pl = s.source!.placement as unknown as {
      origin: number[];
      normal: number[];
      xDir: number[];
    };
    const [nx, ny, nz] = pl.normal as [number, number, number];
    const [xx, xy, xz] = pl.xDir as [number, number, number];
    const y = [ny * xz - nz * xy, nz * xx - nx * xz, nx * xy - ny * xx];
    const d = q.map((v, i) => v - pl.origin[i]!);
    return [d[0]! * xx + d[1]! * xy + d[2]! * xz, d[0]! * y[0]! + d[1]! * y[1]! + d[2]! * y[2]!];
  }, p) as Promise<Vec2>;
}

/** Thread the face `name` with the Thread dialog: M5, the whole face, #fit_slip, modelled. */
async function threadFace(name: string, points: Vec3[], side: 'internal' | 'external') {
  await openTool(page, 'Thread');
  await pick(page, 'face', name, points);
  const dialog = page.getByTestId('feature-dialog');
  await expect(dialog.getByTestId('ref-face')).toContainText(name);
  await expect(dialog.getByTestId('field-cylinder')).toContainText(`an ${side} thread`);
  await dialog.getByTestId('field-size').selectOption('M5');
  await expect(dialog.getByTestId('field-clearance')).toHaveValue('#fit_slip');
  await expect(dialog.getByTestId('field-representation')).toHaveValue('modelled');
  await ok(page);
}

test.beforeAll(async ({ browser }, info) => {
  const { baseURL, viewport } = info.project.use;
  const context = await browser.newContext({
    ...(baseURL ? { baseURL } : {}),
    ...(viewport ? { viewport } : {}),
  });
  page = await context.newPage();
});

test.afterAll(async () => {
  await page.context().close();
});

const hand = jigVolumes(JIG.fits.slip);
/** The bodies' exact volumes at the end of chapter 6, before the print workspace opens. */
let modelled: Record<string, number | null> = {};
let coarse: Record<string, number> = {};
/** And at the end of chapter 9. */
let looserVolumes: Record<string, number | null> = {};

/** Triangles of each body's viewport mesh (0.1 mm), in modelling. */
async function viewTriangles(): Promise<Record<string, number>> {
  return page.evaluate(() =>
    Object.fromEntries(
      window.__manufakture!.viewport.info().bodies.map((b) => [b.id, b.triangles]),
    ),
  );
}

test('1. variables, the fit variables and the block', async () => {
  test.setTimeout(240_000);
  errors = await openEmpty(page);
  await execute(page, { type: 'renameDocument', name: JIG.name }, 'Rename document');
  await execute(page, { type: 'renamePart', partId: 'part#1', name: 'Jig' }, 'Rename part');
  await addVariable(page, 'length', `${JIG.length}`);
  await addVariable(page, 'width', `${JIG.width}`);
  await addVariable(page, 'height', `${JIG.height}`);
  await addVariable(page, 'blade', `${JIG.blade}`);
  // The blade's thickness is the person's to measure; the fits are placeholders until the
  // fit-test coupon is printed (docs/user/fits.md).
  await page
    .getByRole('complementary', { name: 'Variables' })
    .getByTestId('variable-insert-fits')
    .click();
  await expect(page.getByTestId('variable-fit_press-value')).toHaveText('0.10 mm');
  await expect(page.getByTestId('variable-fit_slip-value')).toHaveText('0.20 mm');
  await expect(page.getByTestId('variable-fit_sliding-value')).toHaveText('0.40 mm');

  await addSketch(page, 'block');
  await extrudeDialog('sketch#1');
  await expect(page.getByTestId('field-operation')).toHaveValue('new');
  await page.getByTestId('field-distance').fill('#height');
  await ok(page);
  await allOk();
  await expectVolumes({ [BLOCK]: hand.block.extruded }, 6);
});

test('2. the label, debossed into the top face', async () => {
  test.setTimeout(240_000);
  await view(page, 'top');
  await clickWorld(page, [JIG.label.at[0], 3, JIG.height]);
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__manufakture!.selection.getState().selected.map((i) => i.name ?? i.id),
      ),
    )
    .toEqual([FACES.top]);
  await page.getByRole('button', { name: 'New sketch' }).click();
  await page.getByRole('menuitem', { name: 'Selected face' }).click();
  await expect(page.getByRole('toolbar', { name: 'Sketch' })).toBeVisible();
  await settle(page);
  await sketchIdle(page);

  await tool(page, 'Text');
  const at = await sketchToClient(page, await sketchPointAt([...JIG.label.at, JIG.height]));
  await page.mouse.move(at.x, at.y);
  await page.mouse.click(at.x, at.y);
  await sketchIdle(page);
  await expect(page.getByTestId('text-panel')).toBeVisible();
  const drawn = page.locator('[data-testid^="text-e"]').first();
  await expect(drawn).toHaveAttribute('data-glyphs', '4');
  await expect(page.getByTestId('text-string')).toBeFocused();
  await page.getByTestId('text-string').fill(JIG.label.text);
  // Five glyphs: the space has none.
  await expect(drawn).toHaveAttribute('data-glyphs', '5');
  await page.getByTestId('text-size').fill(`${JIG.label.size}`);
  await page.getByTestId('text-size').press('Enter');
  await sketchIdle(page);
  await expect(page.getByTestId('text-warning')).toHaveCount(0);
  await docShot('01-label');
  await page.getByRole('button', { name: 'Finish sketch' }).click();
  await expect(page.getByRole('toolbar', { name: 'Sketch' })).toBeHidden();

  await extrudeDialog('sketch#2');
  await page.getByTestId('regions-text').check();
  await page.getByTestId('field-operation').selectOption('cut');
  await page.getByTestId('field-distance').fill(`${JIG.label.depth}`);
  await page.getByLabel('Opposite direction').check();
  await ok(page);
  await allOk();
  const doc = await page.evaluate(
    () => window.__manufakture!.document.getState().document.parts[0]!.features,
  );
  expect(doc.at(-2)).toMatchObject({
    id: 'sketch#2',
    plane: { type: 'face' },
    entities: [{ id: 'e5', kind: 'outline' }],
  });
  expect(doc.at(-1)).toMatchObject({
    id: 'extrude#2',
    operation: 'cut',
    profile: { sketch: 'sketch#2', entities: ['e5'] },
  });
  // The letters' area (opentype.js on the font file, Green's theorem), times 0.6 mm.
  expect(hand.parts.text / JIG.label.depth).toBeCloseTo(48.1758, 4);
  await expectVolumes({ [BLOCK]: hand.block.labelled });
});

test('3. the bore and its entry chamfer', async () => {
  test.setTimeout(240_000);
  await addSketch(page, 'bore');
  await extrudeDialog('sketch#3');
  await page.getByTestId('field-operation').selectOption('cut');
  await page.getByTestId('field-extent').selectOption('throughAll');
  await ok(page);
  await allOk();
  await expectVolumes({ [BLOCK]: hand.block.bored });

  // The entry edge, picked looking at the end x = 0.
  await lookAt(page, [-1, -0.35, 0.3]);
  await openTool(page, 'Chamfer');
  const edge = [FACES.bore, FACES.end].sort().join('|');
  const b = hand.radii.bore;
  await pick(
    page,
    'edge',
    edge,
    ring([0, JIG.bore.y, JIG.bore.z], 0, b, [0], 10).filter((p) => p[2] > JIG.bore.z),
  );
  await expect(page.getByTestId('ref-edges').locator('li')).toHaveCount(1);
  await page.getByTestId('field-distance').fill(`${JIG.chamfer}`);
  await ok(page);
  await allOk();
  await expectVolumes({ [BLOCK]: hand.block.chamfered });
});

test('4. the blade slot', async () => {
  test.setTimeout(240_000);
  await addSketch(page, 'slot');
  await extrudeDialog('sketch#4');
  await page.getByTestId('field-operation').selectOption('cut');
  await page.getByTestId('field-distance').fill(`${JIG.height - JIG.slot.bottom}`);
  await page.getByLabel('Opposite direction').check();
  await ok(page);
  await allOk();
  await expectVolumes({ [BLOCK]: hand.block.slotted });
});

test('5. the side hole, threaded M5', async () => {
  test.setTimeout(300_000);
  await addSketch(page, 'side');
  await extrudeDialog('sketch#5');
  await page.getByTestId('field-operation').selectOption('cut');
  await page.getByTestId('field-distance').fill(`${JIG.side.depth}`);
  await ok(page);
  await allOk();
  // To 0.005 mm3: the measure tool integrates the B-spline faces where the two holes cross with
  // a fixed Gauss rule, 0.0017 mm3 from the exact value (the integral here converges to 1e-12).
  await expectVolumes({ [BLOCK]: hand.block.holed }, 2);
  const before = (await bodyVolumes(page))[BLOCK]!;

  await lookAt(page, [0.25, -1, 0.2]);
  const a = hand.radii.side;
  await threadFace(FACES.side, ring([JIG.side.x, 0, JIG.bore.z], 1, a, [1, 2, 3, 0.5]), 'internal');
  await allOk();
  await expect(page.getByTestId('detail-thread#1')).toHaveText('M5');
  expect(await threadReport(page, 'thread#1')).toMatchObject({
    bodyId: 'extrude#1',
    side: 'internal',
    start: 'chamfer',
    end: 'closed',
  });
  const removed = before - (await bodyVolumes(page))[BLOCK]!;
  const reference = threadReference('side', JIG.fits.slip);
  console.log(`side thread: removed ${removed.toFixed(6)} mm3, reference ${reference.toFixed(6)}`);
  expect(Math.abs(removed / reference - 1)).toBeLessThan(THREAD_TOLERANCE);
  await view(page, 'iso');
  await docShot('02-block');
});

test('6. the thumbscrew: a second body, lobed and threaded', async () => {
  test.setTimeout(300_000);
  await addSketch(page, 'head');
  await extrudeDialog('sketch#6');
  await page.getByTestId('field-operation').selectOption('new');
  await page.getByTestId('field-distance').fill(`${JIG.head.height}`);
  await ok(page);
  await allOk();
  await expectVolumes({ [SCREW]: hand.screw.head });

  await addSketch(page, 'shank');
  await extrudeDialog('sketch#7');
  await page.getByTestId('field-operation').selectOption('add');
  await page.getByTestId('field-distance').fill(`${JIG.shank.length}`);
  await ok(page);
  await allOk();
  await expectVolumes({ [SCREW]: hand.screw.shank });

  await addSketch(page, 'lobes');
  await extrudeDialog('sketch#8');
  await page.getByTestId('field-operation').selectOption('cut');
  await page.getByTestId('field-distance').fill(`${JIG.head.height}`);
  await ok(page);
  await allOk();
  await expectVolumes({ [SCREW]: hand.screw.lobed });
  const before = (await bodyVolumes(page))[SCREW]!;

  const [sx, sy] = JIG.screw;
  await lookAt(page, [1, -1, 0.8], { min: [sx - 6, sy - 6, 0], max: [sx + 6, sy + 6, 15] });
  await threadFace(
    FACES.shank,
    ring([sx, sy, JIG.head.height], 2, hand.radii.shank, [8, 7, 9, 6]),
    'external',
  );
  await allOk();
  expect(await threadReport(page, 'thread#2')).toMatchObject({
    bodyId: 'extrude#6',
    side: 'external',
    start: 'closed',
    end: 'chamfer',
  });
  const removed = before - (await bodyVolumes(page))[SCREW]!;
  const reference = threadReference('screw', JIG.fits.slip);
  console.log(`screw thread: removed ${removed.toFixed(6)} mm3, reference ${reference.toFixed(6)}`);
  expect(Math.abs(removed / reference - 1)).toBeLessThan(THREAD_TOLERANCE);

  // Names and colours, in the Bodies list (shown once the part has two bodies).
  await page.getByLabel('Colour of Body 1').fill(JIG.colors.block);
  await page.getByRole('button', { name: 'Rename Body 1' }).click();
  await page.getByLabel('New name for Body 1').fill('Block');
  await page.getByLabel('New name for Body 1').press('Enter');
  await expect(page.getByTestId('body-extrude#1')).toContainText('Block');
  await page.getByLabel('Colour of Body 2').fill(JIG.colors.screw);
  await page.getByRole('button', { name: 'Rename Body 2' }).click();
  await page.getByLabel('New name for Body 2').fill('Thumbscrew');
  await page.getByLabel('New name for Body 2').press('Enter');
  await expect(page.getByTestId('body-extrude#6')).toContainText('Thumbscrew');
  const bodies = await page.evaluate(
    () => window.__manufakture!.document.getState().document.parts[0]!.bodies,
  );
  expect(bodies).toEqual([
    { id: 'extrude#1', name: 'Block', color: JIG.colors.block },
    { id: 'extrude#6', name: 'Thumbscrew', color: JIG.colors.screw },
  ]);
  await view(page, 'iso');
  await docShot('03-jig');
  modelled = await bodyVolumes(page);
  coarse = await viewTriangles();
});

/** Wait until every drawn body has its export-tolerance mesh, or never will. */
async function settledMeshes(): Promise<void> {
  await page.waitForFunction(() => window.__manufakture!.print!.meshesSettled(), null, {
    timeout: 60_000,
  });
}

/** Lay the active item flat on the face under part point `p` of copy 0, seen from `eye`. */
async function layFlat(itemIndex: number, p: Vec3, eye: Vec3): Promise<void> {
  const item = `item#${itemIndex + 1}`;
  await settledMeshes();
  await page.getByTestId(`print-item-${item}`).locator('.print-item-pick').click();
  const box = await page.evaluate(
    (i) => window.__manufakture!.print!.resolved()!.items[i]!.copies[0]!.box,
    itemIndex,
  );
  await lookAt(page, eye, box);
  const at = await page.evaluate(
    ([i, q]) => {
      const t = window.__manufakture!.print!.resolved()!.items[i]!.copies[0]!.placement.translation;
      return window.__manufakture!.viewport.projectToClient([
        q[0] + t[0],
        q[1] + t[1],
        q[2] + t[2],
      ]);
    },
    [itemIndex, p] as const,
  );
  await page.getByTestId('print-lay-flat').click();
  await expect(page.getByTestId('print-lay-flat-hint')).toBeVisible();
  await page.mouse.click(at.x, at.y);
  await expect(page.getByTestId(`print-item-${item}`)).toContainText('Flat on');
}

/** Overhang and steep areas per face name, and the steepest angle, of a drawn body. */
function overhangByFace(body: PrintBody, threshold = Math.PI / 3) {
  const r = classifyOverhangs(
    {
      positions: Float32Array.from(body.positions),
      normals: Float32Array.from(body.normals),
      indices: Uint32Array.from(body.indices),
      triangleFaces: Uint32Array.from(body.triangleFaces),
      faceRanges: Uint32Array.from(body.faceRanges),
    },
    { placement: body.placement, threshold, bedZ: 0 },
  );
  return r.faces.map((f) => ({
    name: body.faceNames[f.face - 1]!,
    overhang: f.areas.overhang + f.areas.downwardFlat,
    steep: f.areas.steep,
    area: Object.values(f.areas).reduce((x, y) => x + y, 0),
    maxAngle: (f.maxAngle * 180) / Math.PI,
  }));
}

/** The box of a body's faces whose names match, in part coordinates. */
function facesBox(body: PrintBody, match: (name: string) => boolean) {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let t = 0; t < body.triangleFaces.length; t++) {
    if (!match(body.faceNames[body.triangleFaces[t]! - 1]!)) continue;
    for (let k = 0; k < 3; k++) {
      const v = body.indices[3 * t + k]!;
      for (let a = 0; a < 3; a++) {
        min[a] = Math.min(min[a]!, body.positions[3 * v + a]!);
        max[a] = Math.max(max[a]!, body.positions[3 * v + a]!);
      }
    }
  }
  return { min, max };
}

const isThread = (n: string) => n.includes(':thread:');
const isLabel = (n: string) => n.startsWith('extrude#2:');
const isLobe = (n: string) => n.startsWith('extrude#8:');
const isBore = (n: string) => n.startsWith(`${FACES.bore}#`) || n === FACES.bore;
const isSideHole = (n: string) => n.startsWith(`${FACES.side}#`) || n === FACES.side;

/** What the print workspace finds, checked against what the jig should show (chapters 7, 9). */
async function expectPrintChecks(slip: number, view: Record<string, number>): Promise<void> {
  await checked(page);
  await expect(page.getByTestId('print-bed-fit')).toHaveAttribute('data-fits', 'true');
  const issues = await printIssues(page);
  const kinds = issues.map((i) => `${i.kind} ${i.itemId}`);
  console.log(
    `print issues at #fit_slip ${slip}: ${JSON.stringify(issues.map((i) => [i.kind, i.itemId, i.worst, i.detail]))}`,
  );
  expect(kinds.filter((k) => k.startsWith('bedFit'))).toEqual([]);
  expect(kinds.filter((k) => k.startsWith('smallHole'))).toEqual([]);

  // The meshes the workspace checks (the export tolerance), with the faces' names.
  const bodies = await printBodies(page);
  const blockBody = bodies.find((b) => b.faceNames.some((n) => n.startsWith('thread#1:')))!;
  const screwBody = bodies.find((b) => b.faceNames.some((n) => n.startsWith('thread#2:')))!;

  // One teardrop flag: the bore, horizontal and above 3 mm, listing every face of it (the slot
  // cuts it in two) and nothing else. The threaded side hole is left out (its crest strips are
  // coaxial with thread faces), and the thumbscrew has none (vertical; and a pin).
  const teardrops = issues.filter((i) => i.kind === 'teardrop');
  expect(teardrops).toHaveLength(1);
  expect(teardrops[0]).toMatchObject({ itemId: 'item#1', worst: `${(4 + slip).toFixed(2)} mm` });
  const boreFaces = [...new Set(blockBody.faceNames.filter(isBore))].sort();
  expect(boreFaces.length).toBeGreaterThanOrEqual(2);
  expect([...new Set(teardrops[0]!.faces)].sort()).toEqual(boreFaces);

  // Overhangs: on the block only the top of the bore and of the side hole with its thread; on
  // the thumbscrew, if any, only facets of its thread's flanks (measured below).
  const overhangs = issues.filter((i) => i.kind === 'overhang');
  expect(overhangs.map((i) => i.itemId).filter((id) => id === 'item#1')).toEqual(['item#1']);
  for (const i of overhangs.filter((x) => x.itemId === 'item#2')) {
    for (const f of i.faces) expect(isThread(f), f).toBe(true);
  }
  const block = overhangs.find((i) => i.itemId === 'item#1')!.faces;
  for (const f of block) expect(isBore(f) || isSideHole(f) || isThread(f), f).toBe(true);
  expect(block.some(isBore)).toBe(true);
  expect(block.some(isSideHole)).toBe(true);
  expect(block.some(isThread)).toBe(true);

  // Per face, on the meshes the workspace checks (the export tolerance).
  // At the export tolerance, finer than the viewport's: a body whose finer mesh never arrived
  // would be checked on its viewport mesh, which tips the thumbscrew's flanks over 60 degrees.
  for (const [b, id] of [
    [blockBody, BLOCK],
    [screwBody, SCREW],
  ] as const) {
    const n = b.indices.length / 3;
    console.log(`${id}: ${n} triangles checked, ${view[id]} in the viewport`);
    expect(n, id).toBeGreaterThan(1.5 * view[id]!);
  }
  const blockFaces = overhangByFace(blockBody);
  // The entry chamfer: its steepest line is 45 degrees from vertical, out of the steep band.
  const chamfer = blockFaces.filter((f) => f.name.startsWith('chamfer#1:'));
  expect(chamfer.length).toBeGreaterThan(0);
  for (const f of chamfer) {
    expect(f.maxAngle, f.name).toBeLessThan(45.5);
    expect(f.overhang + f.steep, f.name).toBe(0);
  }
  // The thumbscrew stands on its head: its downward flanks are about 59.9 degrees from
  // vertical, steep but under the 60 degree threshold. Facets may tip a few over: up to 2% of
  // the thread faces' area may read as overhang; anything else on it may not.
  const screwFaces = overhangByFace(screwBody);
  const thread = screwFaces.filter((f) => isThread(f.name));
  const threadArea = thread.reduce((a, f) => a + f.area, 0);
  const threadOverhang = thread.reduce((a, f) => a + f.overhang, 0);
  const steepest = Math.max(...thread.map((f) => f.maxAngle));
  console.log(
    `thumbscrew thread: ${threadOverhang.toFixed(4)} of ${threadArea.toFixed(2)} mm2 overhang, ` +
      `${thread.reduce((a, f) => a + f.steep, 0).toFixed(2)} mm2 steep, steepest ${steepest.toFixed(3)} deg`,
  );
  expect(threadOverhang / threadArea).toBeLessThanOrEqual(0.02);
  expect(steepest).toBeGreaterThan(59);
  for (const f of screwFaces.filter((x) => !isThread(x.name))) {
    expect(f.overhang, f.name).toBe(0);
  }

  // Walls and gaps: only the threads' teeth (an ISO tooth is P/4 = 0.2 mm across at an internal
  // crest), the label's letters (the walls left between neighbouring letters, the counters of P
  // and 4 with their knife-edge corners) and the head's lobes (where each meets the rim at an
  // edge).
  const label = facesBox(blockBody, isLabel);
  for (const issue of issues.filter((i) =>
    ['thinWall', 'belowMinFeature', 'narrowGap'].includes(i.kind),
  )) {
    for (const f of issue.faces) {
      if (issue.kind === 'narrowGap') {
        expect(isThread(f), `${issue.kind} ${f}`).toBe(true);
        continue;
      }
      if (f.startsWith(`${FACES.top}`)) {
        // A piece of the top face left between letters: the counter of P or 4.
        const box = facesBox(blockBody, (n) => n === f);
        expect(box.min[0], f).toBeGreaterThanOrEqual(label.min[0] - 1e-6);
        expect(box.max[0], f).toBeLessThanOrEqual(label.max[0] + 1e-6);
        expect(box.min[1], f).toBeGreaterThanOrEqual(label.min[1] - 1e-6);
        expect(box.max[1], f).toBeLessThanOrEqual(label.max[1] + 1e-6);
        continue;
      }
      expect(isThread(f) || isLabel(f) || isLobe(f), `${issue.kind} ${f}`).toBe(true);
    }
  }
  const timing = await page.evaluate(() => window.__manufakture!.print!.analysis());
  console.log(`analysis in the worker: ${(timing as unknown as { ms: number }).ms} ms`);
}

test('7. a print setup on the X1 Carbon: fit, overhangs, teardrops, walls', async () => {
  test.setTimeout(300_000);
  await page.getByTestId('open-print').click();
  await expect(page.getByTestId('print-empty')).toBeVisible();
  await page.getByTestId('print-add-setup').click();
  await expect(page.getByTestId('print-printer')).toHaveValue('bambu-x1c');
  await expect(page.getByTestId('print-nozzle')).toHaveValue('0.4');
  await page.getByTestId('print-add-body').selectOption('extrude#1');
  await page.getByTestId('print-add-item').click();
  await page.getByTestId('print-add-body').selectOption('extrude#6');
  await page.getByTestId('print-add-item').click();
  await expect(page.getByTestId('print-item-item#2')).toBeVisible();

  // The block on its base, the thumbscrew on its head: picked from below the bed.
  await layFlat(0, [JIG.length / 2, JIG.width / 2, 0], [0.3, -0.5, -1]);
  await layFlat(1, [JIG.screw[0], JIG.screw[1], 0], [0.3, -0.5, -1]);
  const items = await page.evaluate(() => {
    const doc = window.__manufakture!.document.getState().document as unknown as {
      print: { setups: { items: { body?: string; orientation: unknown }[] }[] };
    };
    return doc.print.setups[0]!.items.map((i) => [i.body, i.orientation]);
  });
  expect(items).toEqual([
    ['extrude#1', { kind: 'layFlat', face: { id: expect.any(String), ref: { face: FACES.base } } }],
    [
      'extrude#6',
      { kind: 'layFlat', face: { id: expect.any(String), ref: { face: FACES.headBottom } } },
    ],
  ]);
  await expectPrintChecks(JIG.fits.slip, coarse);
  const boxes = await page.evaluate(() =>
    window.__manufakture!.print!.resolved()!.items.map((i) => i.copies[0]!.box),
  );
  // Laid flat as modelled, on the bed: 40 x 20 x 15, and the thumbscrew 15 tall and 12 across in
  // y. In x a lobe sits at each end, so the head reaches only to where a lobe meets the rim, at
  // an angle t with cos t = 1 - r^2 / (2 R^2) (lobe radius r, rim radius R): 11.625 mm.
  const R = JIG.head.diameter / 2;
  const r = JIG.head.lobeDiameter / 2;
  const across = JIG.head.diameter * (1 - (r * r) / (2 * R * R));
  for (const [b, size] of [
    [boxes[0]!, [JIG.length, JIG.width, JIG.height]],
    [boxes[1]!, [across, JIG.head.diameter, JIG.head.height + JIG.shank.length]],
  ] as const) {
    expect(b.min[2]).toBeCloseTo(0, 4);
    // From the mesh's vertices: a round side may fall short by the chordal tolerance, 0.02 mm.
    for (let a = 0; a < 3; a++) expect(b.max[a]! - b.min[a]!).toBeCloseTo(size[a]!, 1);
  }
  if (process.env.M3_DOCS) {
    // For the doc: a section through the bore's axis, seen from behind the cut and below, so the
    // overhanging tops of the bore and the side hole show (as in m3-views.spec.ts).
    const section = (enabled: boolean) =>
      page.evaluate(
        (on) =>
          window.__manufakture!.settings.getState().setSection({
            enabled: on,
            axis: 'y',
            position: 0.5,
            flipped: true,
          }),
        enabled,
      );
    await section(true);
    await lookAt(page, [0.45, 1, -0.4], boxes[0]!);
    await docShot('04-print-overhangs');
    await section(false);
  }
});

test('8. open in slicer: a two-colour 3MF on the X1 Carbon plate', async () => {
  test.setTimeout(240_000);
  await expect(page.getByTestId('print-export-refusal')).toHaveCount(0);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('print-open-slicer').click(),
  ]);
  expect(download.suggestedFilename()).toBe(`${JIG.name}-Plate 1.3mf`);
  const bytes = new Uint8Array(await readFile(await download.path()));
  await expect(page.getByTestId('print-export-status')).toContainText(
    "2 items on the Bambu Lab X1 Carbon's plate",
  );
  await expect(page.getByTestId('slicer-handoff')).toHaveAttribute('data-slicer', 'orcaslicer');
  await docShot('05-open-in-slicer');

  const report = validate3mf(bytes);
  expect(report.problems).toEqual([]);
  const parsed = report.parsed!;
  expect(parsed.colorGroups.map((g) => g.colors)).toEqual([
    [JIG.colors.block.toUpperCase()],
    [JIG.colors.screw.toUpperCase()],
  ]);
  expect(parsed.items).toHaveLength(2);
  const built = buildMeshes(parsed).map((m) => ({ name: m.name, props: meshProperties(m.mesh) }));
  console.log(
    `3MF objects: ${JSON.stringify(parsed.objects.map((o) => o.name))}, items: ${parsed.items.length}`,
  );
  expect(built.map((b) => b.name)).toEqual(['Jig: Block', 'Jig: Thumbscrew']);
  // Measured before the workspace opened: it draws the copies, which the measure tool does not.
  const exact = modelled;
  const corner = x1c.excluded.map((e) => e.polygon);
  for (const [b, id] of [
    [built[0]!, BLOCK],
    [built[1]!, SCREW],
  ] as const) {
    const box = b.props.boundingBox!;
    // On the plate, on the bed, clear of the excluded corner by 5 mm.
    expect(checkBedFit(x1c, { box }).fits, b.name).toBe(true);
    expect(box.min[2]).toBeCloseTo(0, 3);
    for (const poly of corner) {
      const ex = {
        min: [Math.min(...poly.map((p) => p[0])), Math.min(...poly.map((p) => p[1]))],
        max: [Math.max(...poly.map((p) => p[0])), Math.max(...poly.map((p) => p[1]))],
      };
      const clear =
        box.min[0] >= ex.max[0]! + 5 - 1e-6 ||
        box.max[0] <= ex.min[0]! - 5 + 1e-6 ||
        box.min[1] >= ex.max[1]! + 5 - 1e-6 ||
        box.max[1] <= ex.min[1]! - 5 + 1e-6;
      expect(clear, `${b.name} 5 mm clear of the excluded corner`).toBe(true);
    }
    // The mesh's volume is the exact one to within its facets (0.02 mm chordal).
    expect(Math.abs(b.props.volume / exact[id]! - 1), b.name).toBeLessThan(0.002);
  }
  const [a, b] = [built[0]!.props.boundingBox!, built[1]!.props.boundingBox!];
  expect(
    a.max[0] + 5 - 1e-6 <= b.min[0] ||
      b.max[0] + 5 - 1e-6 <= a.min[0] ||
      a.max[1] + 5 - 1e-6 <= b.min[1] ||
      b.max[1] + 5 - 1e-6 <= a.min[1],
  ).toBe(true);
  await page.getByTestId('slicer-handoff-close').click();

  // For the print (T3.4b) and the optional OrcaSlicer check: the CI artifact m3-jig.
  const out = join(test.info().project.outputDir, 'm3-jig');
  await mkdir(out, { recursive: true });
  await writeFile(join(out, 'ptfe-tube-jig.3mf'), bytes);
  await writeFile(
    join(out, 'expected.json'),
    `${JSON.stringify(
      {
        printer: 'bambu-x1c',
        nozzle: 0.4,
        objects: built.map((x) => ({ name: x.name, volume: x.props.volume })),
        colors: [JIG.colors.block.toUpperCase(), JIG.colors.screw.toUpperCase()],
      },
      null,
      2,
    )}\n`,
  );
});

test('9. a looser slip fit: the bore, the holes and the threads follow', async () => {
  test.setTimeout(300_000);
  // The fit variables are in the Variables panel, under the Print panel while it is open.
  const slip = 0.3;
  await editVariable(page, 'fit_slip', `${slip} mm`);
  await expect(page.getByTestId('variable-fit_slip-value')).toHaveText('0.30 mm');
  await allOk();
  const looser = jigVolumes(slip);
  expect(await threadReport(page, 'thread#1')).toMatchObject({
    radius: expect.closeTo(looser.radii.side, 6),
  });
  expect(await threadReport(page, 'thread#2')).toMatchObject({
    radius: expect.closeTo(looser.radii.shank, 6),
  });

  // Back in modelling, the exact volumes: every feature before the threads by hand, and each
  // thread against its reference at the new clearance.
  await page.getByTestId('open-print').click();
  await expect(page.getByTestId('print-panel')).toHaveCount(0);
  looserVolumes = await bodyVolumes(page);
  const view = await viewTriangles();
  const side = threadReference('side', slip);
  const screw = threadReference('screw', slip);
  const removedSide = looser.block.holed - looserVolumes[BLOCK]!;
  const removedScrew = looser.screw.lobed - looserVolumes[SCREW]!;
  console.log(
    `at #fit_slip ${slip}: side thread removed ${removedSide.toFixed(6)} (reference ${side.toFixed(6)}), ` +
      `screw thread ${removedScrew.toFixed(6)} (reference ${screw.toFixed(6)})`,
  );
  expect(Math.abs(removedSide / side - 1)).toBeLessThan(THREAD_TOLERANCE);
  expect(Math.abs(removedScrew / screw - 1)).toBeLessThan(THREAD_TOLERANCE);
  // Larger holes, a thinner shank: both bodies lose material against the 0.2 mm fit.
  expect(looserVolumes[BLOCK]!).toBeLessThan(modelled[BLOCK]!);
  expect(looserVolumes[SCREW]!).toBeLessThan(modelled[SCREW]!);

  // And the print checks follow: the bore's teardrop flag is 4.30 mm now.
  await page.getByTestId('open-print').click();
  await expectPrintChecks(slip, view);
});

test('10. a reload brings it all back', async () => {
  test.setTimeout(240_000);
  await saved(page);
  await page.reload();
  await expect(page.getByTestId('document-name')).toBeVisible({ timeout: 90_000 });
  await allOk();
  await page.waitForFunction(() => window.__manufakture!.viewport.info().bodies.length === 2);
  const after = await bodyVolumes(page);
  expect(after[BLOCK]).toBeCloseTo(looserVolumes[BLOCK]!, 6);
  expect(after[SCREW]).toBeCloseTo(looserVolumes[SCREW]!, 6);
  await expect(page.getByTestId('variable-fit_slip-value')).toHaveText('0.30 mm');
  await page.getByTestId('open-print').click();
  await expect(page.getByTestId('print-item-item#1')).toContainText('Flat on');
  await expect(page.getByTestId('print-item-item#2')).toContainText('Flat on');
  await checked(page);
  await expect(page.getByTestId('print-bed-fit')).toHaveAttribute('data-fits', 'true');
  expect(errors).toEqual([]);
});
