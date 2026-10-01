import { readFile } from 'node:fs/promises';
import { buildMeshes, meshProperties, parseStl, validate3mf } from '@manufakture/io';
import { expect, test, type Page } from '@playwright/test';
import { openEmpty, regenerated } from './bracket';
import { settle } from './helpers';

// Configurations of instances (T2.4c) with the real regen worker: a shelf board whose width is
// #width, in rows 600, 800 and 1000 mm (the table is made with commands; the Configurations
// panel has its own spec). An assembly shows the board twice, and each instance is set to a row
// in the assembly tree: one at 600 mm, one at 1000 mm. Regen builds the 1000 mm board apart from
// the part and reports it as a source of its own; the exports carry each board at its own width;
// undo takes a row choice back; a reload keeps the rows.

const XY = { type: 'plane', origin: [0, 0, 0], normal: [0, 0, 1], xDir: [1, 0, 0] } as const;
const mm = (source: string) => ({ source, lengthUnit: 'mm', angleUnit: 'deg' });
const DEPTH = 300;
const THICKNESS = 18;
const board = (width: number) => width * DEPTH * THICKNESS;

/** The board: a rectangle on Top, #width by 300 mm from the origin, extruded 18 mm. */
function boardCommands(): unknown[] {
  const corners: [number, number][] = [
    [0, 0],
    [600, 0],
    [600, DEPTH],
    [0, DEPTH],
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
        value: mm('#width'),
      },
      {
        id: 'k11',
        kind: 'distance',
        a: { entity: 'e2', at: 'start' },
        b: { entity: 'e2', at: 'end' },
        value: mm(`${DEPTH} mm`),
      },
    ],
  };
  const extrude = {
    id: 'extrude#1',
    kind: 'extrude',
    name: 'Board',
    suppressed: false,
    profile: { sketch: 'sketch#1' },
    operation: 'new',
    extent: { type: 'blind', distance: mm(`${THICKNESS} mm`) },
    reverse: false,
  };
  return [
    { type: 'renameDocument', name: 'Shelf' },
    { type: 'renamePart', partId: 'part#1', name: 'Board' },
    { type: 'setVariable', name: 'width', expression: mm('600 mm') },
    { type: 'addFeature', partId: 'part#1', feature: sketch },
    { type: 'addFeature', partId: 'part#1', feature: extrude },
    {
      type: 'setConfigParameter',
      parameter: { id: 'cp#1', name: 'Width', kind: 'variable', variable: 'width' },
    },
    ...[600, 800, 1000].map((w, i) => ({
      type: 'setConfigRow',
      row: { id: `cfg#${i + 1}`, name: `${w} mm`, values: { 'cp#1': mm(`${w} mm`) } },
    })),
  ];
}

async function execute(page: Page, command: unknown, label: string): Promise<void> {
  const ok = await page.evaluate(
    ([c, l]) => window.__manufakture!.document.getState().execute(c, l as string).ok,
    [command, label] as const,
  );
  expect(ok, label).toBe(true);
}

/** What the instances of the first assembly show, as the last regen reported. */
async function shown(page: Page) {
  await regenerated(page);
  await settle(page);
  return page.evaluate(() => {
    const m = window.__manufakture!.model.getState();
    return {
      instances: (m.assemblies[0]?.instances ?? []).map((i) => [i.instanceId, i.status, i.source]),
      sources: m.sources.map((s) => s.key),
    };
  });
}

/** The rows the instances name, from the document. */
function rows(page: Page) {
  return page.evaluate(() =>
    window
      .__manufakture!.document.getState()
      .document.assemblies[0]!.instances.map(
        (i) => (i.source as { configuration?: string }).configuration ?? null,
      ),
  );
}

async function exportAs(page: Page, item: 'stl' | '3mf') {
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId(`export-${item}`).click(),
  ]);
  await expect(page.getByTestId('io-status')).toContainText('2 instances of 2 parts');
  return new Uint8Array(await readFile(await download.path()));
}

const near = (actual: readonly number[], expected: readonly number[]) =>
  actual.forEach((v, i) => expect(v, `component ${i}`).toBeCloseTo(expected[i]!, 3));

test('configured instances: the 600 mm and 1000 mm shelf boards from one part', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const errors = await openEmpty(page);
  await execute(page, { type: 'batch', commands: boardCommands() }, 'Make the board');
  await regenerated(page);

  // Two instances of the board, the second set 400 mm behind the first.
  await page.getByTestId('assembly-add').click();
  await page.getByTestId('assembly-insert').click();
  const panel = page.getByTestId('insert-panel');
  for (let n = 0; n < 2; n++) {
    await panel.getByTestId('insert-part-part#1').click();
    await expect(panel.getByTestId('insert-message')).toContainText('Inserted');
  }
  await panel.getByTestId('insert-close').click();
  await execute(
    page,
    {
      type: 'setPoses',
      assemblyId: 'assembly#1',
      poses: { 'inst#2': { translation: [0, 400, 0], rotation: [0, 0, 0, 1] } },
    },
    'Place the second board',
  );

  // Each instance offers the board's rows, the default first; choose 600 and 1000 mm.
  const first = page.getByTestId('instance-configuration-inst#1');
  const second = page.getByTestId('instance-configuration-inst#2');
  await expect(first.locator('option')).toHaveText([
    'Default (as stored)',
    '600 mm',
    '800 mm',
    '1000 mm',
  ]);
  await first.selectOption({ label: '600 mm' });
  await second.selectOption({ label: '1000 mm' });
  await expect(page.getByTestId('instance-inst#2')).toContainText('Board (1000 mm)');
  await expect.poll(() => rows(page)).toEqual(['cfg#1', 'cfg#3']);
  await expect
    .poll(() => shown(page))
    .toEqual({
      instances: [
        ['inst#1', 'ok', { source: 'part:part#1:row:cfg#1' }],
        ['inst#2', 'ok', { source: 'part:part#1:row:cfg#3' }],
      ],
      sources: ['part:part#1:row:cfg#1', 'part:part#1:row:cfg#3'],
    });

  // The exports carry each board at its width: two parts, each placed.
  const stl = meshProperties(parseStl(await exportAs(page, 'stl')).mesh);
  expect(stl.volume).toBeCloseTo(board(600) + board(1000), 0);
  const report = validate3mf(await exportAs(page, '3mf'));
  expect(report.problems).toEqual([]);
  expect(report.parsed!.objects.map((o) => o.name)).toEqual(['Board (600 mm)', 'Board (1000 mm)']);
  const built = buildMeshes(report.parsed!).map((m) => meshProperties(m.mesh).boundingBox!);
  near(built[0]!.max, [600, DEPTH, THICKNESS]);
  near(built[1]!.min, [0, 400, 0]);
  near(built[1]!.max, [1000, 400 + DEPTH, THICKNESS]);

  // Undo takes the last row choice back: the second board is in its default again.
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(() => rows(page)).toEqual(['cfg#1', null]);
  await expect(second).toHaveValue('');
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect.poll(() => rows(page)).toEqual(['cfg#1', 'cfg#3']);

  // A reload keeps the rows.
  await expect(page.getByTestId('save-status')).toHaveText('Saved', { timeout: 15_000 });
  await page.reload();
  await regenerated(page);
  await expect.poll(() => rows(page)).toEqual(['cfg#1', 'cfg#3']);

  // A row that sets nothing, while 1000 mm is shown: the first board in it is the stored 600 mm,
  // not the shown row's width; the second board, in the shown row, is the part itself.
  await execute(
    page,
    {
      type: 'batch',
      commands: [
        { type: 'setConfigRow', row: { id: 'cfg#4', name: 'Plain', values: {} } },
        { type: 'setActiveConfiguration', rowId: 'cfg#3' },
      ],
    },
    'Add an empty row and show 1000 mm',
  );
  await page.getByTestId('instance-configuration-inst#1').selectOption({ label: 'Plain' });
  await expect.poll(() => rows(page)).toEqual(['cfg#4', 'cfg#3']);
  await expect
    .poll(() => shown(page))
    .toEqual({
      instances: [
        ['inst#1', 'ok', { source: 'part:part#1:row:cfg#4' }],
        ['inst#2', 'ok', { part: 'part#1' }],
      ],
      sources: ['part:part#1:row:cfg#4'],
    });
  const mixed = meshProperties(parseStl(await exportAs(page, 'stl')).mesh);
  expect(mixed.volume).toBeCloseTo(board(600) + board(1000), 0);

  expect(errors).toEqual([]);
});
