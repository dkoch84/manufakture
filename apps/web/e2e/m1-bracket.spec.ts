import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  checkManifold,
  meshProperties,
  parseStl,
  stepProductNames,
  validate3mf,
  type MeshProperties,
} from '@manufakture/io';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import {
  BRACKET,
  BRACKET_BOX,
  BRACKET_FACES,
  bodyTopology,
  bodyVolume,
  bracketVolume,
  buildBracket,
  editVariable,
  exportAs,
  openEmpty,
  regenerated,
  view,
  type FeatureStatus,
} from './bracket';
import { clickWorld } from './helpers';

// M1 acceptance: make a printable bracket, start to finish, through the UI (the walkthrough in
// docs/m1-acceptance.md). A new document; an L-profile whose walls are `#thickness`; extruded;
// two counterbored M4 holes on sketch points; the inside corner filleted. Exported as STL and
// 3MF (watertight, millimetres, the hand-computed volume) and STEP; reloaded, it regenerates to
// the same volume and faces; with `#thickness` changed, the fillet and the holes stay on the
// same faces and edges (the topological naming regression) and the volume follows.
//
// The exports and the expected values are written to test-results/m1-bracket/ for the interop
// CI job (FreeCAD and PrusaSlicer, see .github/workflows/ci.yml). With M1_DOCS=1 the run also
// refreshes the screenshots in docs/m1-acceptance/.

const T0 = 6;
const T1 = 8;

/** Where the walkthrough screenshots go when M1_DOCS=1. */
const docsDir = (info: TestInfo) => resolve(info.project.testDir, '../../../docs/m1-acceptance');

async function docShot(page: Page, info: TestInfo, name: string): Promise<void> {
  if (!process.env.M1_DOCS) return;
  await page.mouse.move(0, 0);
  const dir = docsDir(info);
  await mkdir(dir, { recursive: true });
  await page.screenshot({ path: join(dir, `${name}.png`) });
}

/** Names of the faces that share an edge with `face`, from the edges the viewport shows. */
async function neighbours(page: Page, face: string): Promise<string[]> {
  const edges = await page.evaluate(() =>
    window
      .__manufakture!.viewport.geometrySamples()
      .filter((g) => g.kind === 'edge')
      .map((g) => g.name),
  );
  const out = new Set<string>();
  for (const e of edges) {
    const faces = e.split('|');
    if (faces.includes(face)) for (const f of faces) if (f !== face) out.add(f);
  }
  return [...out].sort();
}

/** Face names of the part, from the edges the viewport shows. */
async function faceNames(page: Page): Promise<string[]> {
  const edges = await page.evaluate(() =>
    window
      .__manufakture!.viewport.geometrySamples()
      .filter((g) => g.kind === 'edge')
      .map((g) => g.name),
  );
  return [...new Set(edges.flatMap((e) => e.split('|')))].sort();
}

/** Click the fillet's round in the view and read its measured radius and name. */
async function measureRound(page: Page, t: number): Promise<{ name: string; radius: number }> {
  await view(page, 'iso');
  const r = BRACKET.fillet;
  // The middle of the round: 45 degrees round from both walls, towards the corner.
  const c = t + r - r / Math.SQRT2;
  await clickWorld(page, [c, -BRACKET.width / 4, c]);
  await page.waitForFunction(() => {
    const s = window.__manufakture!.measure.getState();
    return s.status === 'ready' && s.request?.targets.length === 1;
  });
  await expect(page.getByTestId('measure-value-item1.radius')).toHaveText(`${r.toFixed(2)} mm`);
  const item = await page.evaluate(() => {
    const s = window.__manufakture!.measure.getState() as unknown as {
      result: { items: { ok: boolean; name: string; surface: string; radius: number }[] };
    };
    return s.result.items[0]!;
  });
  expect(item).toMatchObject({ ok: true, surface: 'cylinder' });
  return { name: item.name, radius: item.radius };
}

function expectBox(p: MeshProperties, tol: number) {
  const box = p.boundingBox!;
  box.min.forEach((v, i) => expect(Math.abs(v - BRACKET_BOX.min[i]!)).toBeLessThan(tol));
  box.max.forEach((v, i) => expect(Math.abs(v - BRACKET_BOX.max[i]!)).toBeLessThan(tol));
}

/** Every feature built, with no warnings, every stored reference resolved exactly by name. */
function expectAllExact(statuses: Record<string, FeatureStatus>) {
  for (const [id, s] of Object.entries(statuses)) {
    expect(s.status, id).toBe('ok');
    expect(s.errors, id).toEqual([]);
    expect(s.warnings, id).toEqual([]);
    for (const ref of s.references) {
      expect({ id, ...ref }).toMatchObject({ id, via: 'exact', fragile: false });
    }
  }
}

test('M1: a printable bracket, built, exported, reloaded and re-dimensioned', async ({
  page,
}, testInfo) => {
  test.setTimeout(300_000);
  const errors = await openEmpty(page);
  await docShot(page, testInfo, '00-empty');

  await buildBracket(page, T0, async (step) => {
    const names = {
      variable: '01-variable',
      sketch: '02-sketch',
      extrude: '03-extrude',
      holes: '04-holes',
      fillet: '05-fillet',
    } as const;
    if (step === 'extrude' || step === 'holes' || step === 'fillet') await view(page, 'iso');
    await docShot(page, testInfo, names[step]);
  });

  // The stored references: the hole sketch on the foot's top face, the fillet on the edge
  // between that face and the inside of the upright, all resolved exactly, none fragile.
  let statuses = await regenerated(page);
  expectAllExact(statuses);
  const TOP = 'extrude#1:side:e3';
  const INSIDE = 'extrude#1:side:e4';
  expect(statuses['sketch#2']!.references.map((r) => r.target)).toEqual([TOP]);
  expect(statuses['fillet#1']!.references.map((r) => r.target)).toEqual([`${TOP}|${INSIDE}`]);

  // The round: radius 4, between the two walls, running the full width (cap to cap).
  const round = await measureRound(page, T0);
  expect(round.name).toMatch(/^fillet#1:round:/);
  const adjacency = ['extrude#1:cap:end', 'extrude#1:cap:start', TOP, INSIDE].sort();
  expect(await neighbours(page, round.name)).toEqual(adjacency);
  const holeWalls = (names: string[]) => names.filter((n) => /^hole#1:wall:/.test(n));
  const counterbores = (names: string[]) => names.filter((n) => /^hole#1:cbore:/.test(n));
  expect(holeWalls(await faceNames(page))).toHaveLength(2);
  expect(counterbores(await faceNames(page))).toHaveLength(2);
  await docShot(page, testInfo, '06-measure-round');
  await page.evaluate(() => window.__manufakture!.selection.getState().clear());

  // Export: STL and 3MF are closed meshes in millimetres with the exact volume, to within the
  // chordal error of the normal mesh tolerance (0.02 mm) over the curved faces.
  const volume = await bodyVolume(page);
  expect(volume).toBeCloseTo(bracketVolume(T0), 3);
  const out = join(testInfo.project.outputDir, 'm1-bracket');
  await mkdir(out, { recursive: true });

  const stl = await exportAs(page, 'stl', 'normal');
  expect(stl.name).toBe('Part 1.stl');
  const parsed = parseStl(stl.bytes);
  expect(parsed.format).toBe('binary');
  expect(checkManifold(parsed.mesh).problems).toEqual([]);
  const stlProps = meshProperties(parsed.mesh);
  expect(Math.abs(stlProps.volume / bracketVolume(T0) - 1)).toBeLessThan(2e-3);
  expectBox(stlProps, 0.01);

  const threemf = await exportAs(page, '3mf', 'normal');
  const report = validate3mf(threemf.bytes);
  expect(report.problems).toEqual([]);
  expect(report.parsed!.unit).toBe('millimeter');
  expect(report.parsed!.objects.map((o) => o.name)).toEqual(['Part 1']);
  expect(report.objects[0]!.manifold.problems).toEqual([]);
  expect(Math.abs(report.objects[0]!.manifold.volume / bracketVolume(T0) - 1)).toBeLessThan(2e-3);
  expectBox(meshProperties(report.parsed!.objects[0]!.mesh), 0.01);

  const step = await exportAs(page, 'step');
  expect(new TextDecoder().decode(step.bytes.subarray(0, 13))).toBe('ISO-10303-21;');
  expect(stepProductNames(step.bytes)).toEqual(['Part 1']);

  await writeFile(join(out, 'bracket.stl'), stl.bytes);
  await writeFile(join(out, 'bracket.3mf'), threemf.bytes);
  await writeFile(join(out, 'bracket.step'), step.bytes);
  const { faces } = await bodyTopology(page);
  await writeFile(
    join(out, 'expected.json'),
    `${JSON.stringify(
      {
        thickness: T0,
        volume,
        faces,
        min: BRACKET_BOX.min,
        max: BRACKET_BOX.max,
      },
      null,
      2,
    )}\n`,
  );

  // Reload: read back from the browser's storage and regenerated, identically.
  await expect(page.getByTestId('save-status')).toHaveText('Saved', { timeout: 15_000 });
  const before = await page.evaluate(() => window.__manufakture!.document.getState().document);
  const topologyBefore = await bodyTopology(page);
  await page.reload();
  expectAllExact(await regenerated(page));
  await expect
    .poll(() => page.evaluate(() => window.__manufakture!.viewport.info().bodies.length))
    .toBe(1);
  expect(await page.evaluate(() => window.__manufakture!.document.getState().document)).toEqual(
    before,
  );
  expect(await bodyTopology(page)).toEqual(topologyBefore);
  expect(topologyBefore.faces).toBe(BRACKET_FACES.fillet);
  expect(await bodyVolume(page)).toBeCloseTo(volume, 6);

  // A thicker bracket: every wall follows #thickness; the sketch and every feature after it are
  // rebuilt, and the hole sketch, the holes and the fillet keep their faces and edges.
  await editVariable(page, 'thickness', String(T1));
  await expect(page.getByTestId('variable-thickness-value')).toHaveText(`${T1.toFixed(2)} mm`);
  statuses = await regenerated(page);
  expectAllExact(statuses);
  for (const id of ['sketch#1', 'extrude#1', 'sketch#2', 'hole#1', 'fillet#1']) {
    expect(statuses[id]!.cached, id).toBe(false);
  }
  expect(statuses['sketch#2']!.references.map((r) => r.target)).toEqual([TOP]);
  expect(statuses['fillet#1']!.references.map((r) => r.target)).toEqual([`${TOP}|${INSIDE}`]);
  expect(await bodyVolume(page)).toBeCloseTo(bracketVolume(T1), 3);
  expect((await bodyTopology(page)).faces).toBe(BRACKET_FACES.fillet);
  const after = await measureRound(page, T1);
  expect(after.name).toBe(round.name);
  expect(after.radius).toBeCloseTo(BRACKET.fillet, 9);
  expect(await neighbours(page, round.name)).toEqual(adjacency);
  expect(holeWalls(await faceNames(page))).toHaveLength(2);
  expect(counterbores(await faceNames(page))).toHaveLength(2);
  // The counterbores still start on the (now higher) top face: their floors sit a counterbore
  // depth below it.
  const floors = await page.evaluate(() =>
    window
      .__manufakture!.viewport.geometrySamples()
      .filter((g) => g.kind === 'edge' && /^hole#1:cbore-floor:[^|]+\|hole#1:wall:/.test(g.name))
      .map((g) => g.points.map((p) => p[2])),
  );
  expect(floors).toHaveLength(2);
  for (const zs of floors) {
    for (const z of zs) expect(z).toBeCloseTo(T1 - BRACKET.hole.headDepth, 3);
  }
  await docShot(page, testInfo, '07-thickness-8');

  // Back to 6 with one undo: the first bracket again.
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expectAllExact(await regenerated(page));
  expect(await bodyVolume(page)).toBeCloseTo(volume, 6);
  expect(errors).toEqual([]);
});
