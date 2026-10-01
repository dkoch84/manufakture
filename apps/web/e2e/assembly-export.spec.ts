import { readFile } from 'node:fs/promises';
import {
  buildMeshes,
  meshProperties,
  parseStl,
  stepProductNames,
  validate3mf,
} from '@manufakture/io';
import { expect, test, type Page } from '@playwright/test';
import { openEmpty, regenerated } from './bracket';
import { settle } from './helpers';

// Exporting an assembly (T2.3f) with the real regen and kernel workers: two instances of a box
// and one of a lid, placed by poses, exported from the Export menu of the assembly tab as STL,
// 3MF and STEP. The downloads are checked with @manufakture/io: every part written once and
// placed once per instance (3MF build items, STEP components), the STL merged in place.

const XY = { type: 'plane', origin: [0, 0, 0], normal: [0, 0, 1], xDir: [1, 0, 0] } as const;
const mm = (source: number) => ({ source: String(source), lengthUnit: 'mm', angleUnit: 'deg' });

/** A `w` x `d` x `h` box from the origin in part studio `partId`: a rectangle on Top, extruded. */
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

/** Choose an Export menu item and return the downloaded file. */
async function exportAs(page: Page, item: 'stl' | '3mf' | 'step') {
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  // An assembly is exported whole: no body choice, no file per body.
  await expect(page.getByTestId('export-stl-each')).toHaveCount(0);
  await expect(page.getByTestId('export-bodies')).toHaveCount(0);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId(`export-${item}`).click(),
  ]);
  const bytes = new Uint8Array(await readFile(await download.path()));
  await expect(page.getByTestId('io-status')).toHaveText(
    new RegExp(
      `^Exported ${download.suggestedFilename().replace('.', '\\.')} \\(.*\\): 3 instances of 2 parts\\.$`,
    ),
  );
  return { name: download.suggestedFilename(), bytes };
}

const near = (actual: readonly number[], expected: readonly number[]) =>
  actual.forEach((v, i) => expect(v, `component ${i}`).toBeCloseTo(expected[i]!, 3));

test('an assembly exports to STL, 3MF and STEP with each part once and placed', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const errors = await openEmpty(page);
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
      ],
    },
    'Make the parts',
  );
  await regenerated(page);

  await page.getByTestId('assembly-add').click();
  await expect(page.getByTestId('assembly-tab-assembly#1')).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.getByTestId('assembly-insert').click();
  const panel = page.getByTestId('insert-panel');
  for (const id of ['part#1', 'part#1', 'part#2']) {
    await panel.getByTestId(`insert-part-${id}`).click();
    await expect(panel.getByTestId('insert-message')).toContainText('Inserted');
  }
  await panel.getByTestId('insert-close').click();
  // The second box turned a quarter about z and set beside the first; the lid on top.
  await execute(
    page,
    {
      type: 'setPoses',
      assemblyId: 'assembly#1',
      poses: {
        'inst#2': { translation: [100, 0, 0], rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2] },
        'inst#3': { translation: [0, 0, 20], rotation: [0, 0, 0, 1] },
      },
    },
    'Place the instances',
  );
  await regenerated(page);
  await settle(page);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window
            .__manufakture!.model.getState()
            .assemblies[0]?.instances.map((i) => [i.instanceId, i.transform.translation[0]]) ?? [],
      ),
    )
    .toEqual([
      ['inst#1', 0],
      ['inst#2', 100],
      ['inst#3', 0],
    ]);

  // 3MF: an object per body per instance, each placed by its own build item.
  const threemf = await exportAs(page, '3mf');
  expect(threemf.name).toBe('Assembly 1.3mf');
  const report = validate3mf(threemf.bytes);
  expect(report.problems).toEqual([]);
  expect(report.parsed!.objects.map((o) => o.name)).toEqual(['Box', 'Box', 'Lid']);
  expect(report.parsed!.items.map((i) => i.objectId)).toEqual([1, 2, 3]);
  const built = buildMeshes(report.parsed!).map((m) => meshProperties(m.mesh));
  near(built[0]!.boundingBox!.min, [0, 0, 0]);
  near(built[0]!.boundingBox!.max, [40, 30, 20]);
  // 40 x 30 turned a quarter about z: x -30..0, y 0..40; then 100 along x.
  near(built[1]!.boundingBox!.min, [70, 0, 0]);
  near(built[1]!.boundingBox!.max, [100, 40, 20]);
  near(built[2]!.boundingBox!.min, [0, 0, 20]);
  near(built[2]!.boundingBox!.max, [40, 30, 25]);

  // STL: every instance in place, in one file.
  const stl = await exportAs(page, 'stl');
  expect(stl.name).toBe('Assembly 1.stl');
  const mesh = meshProperties(parseStl(stl.bytes).mesh);
  expect(mesh.volume).toBeCloseTo(2 * 24_000 + 6_000, 0);
  near(mesh.boundingBox!.min, [0, 0, 0]);
  near(mesh.boundingBox!.max, [100, 40, 25]);

  // STEP: each part one product, each instance a named occurrence of it.
  const step = await exportAs(page, 'step');
  expect(step.name).toBe('Assembly 1.step');
  expect(stepProductNames(step.bytes).sort()).toEqual(['Assembly 1', 'Box', 'Lid']);
  const text = new TextDecoder().decode(step.bytes);
  const occurrences = [...text.matchAll(/NEXT_ASSEMBLY_USAGE_OCCURRENCE\('[^']*','([^']*)'/g)];
  expect(occurrences.map((m) => m[1])).toEqual(['Box 1', 'Box 2', 'Lid 1']);

  expect(errors).toEqual([]);
});
