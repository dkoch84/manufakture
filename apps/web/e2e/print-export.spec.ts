import { readFile } from 'node:fs/promises';
import { buildMeshes, meshProperties, validate3mf } from '@manufakture/io';
import { checkBedFit, findPrinter } from '@manufakture/print';
import { expect, test, type Page } from '@playwright/test';
import { openEmpty, regenerated } from './bracket';
import { settle } from './helpers';
import { execute, saved } from './m2-fixtures';

// Export for printing and the slicer hand-off (M3 plan, T3.3b), through the UI and the real regen
// and kernel workers, on the owner's printer (a Bambu Lab X1 Carbon, 0.4 mm nozzle):
// - a part of two bodies in two colours (a 30 x 20 x 10 block and a 10 x 10 x 4 knob beside it),
//   laid flat on the block's front face, two copies, opened in the slicer: the download is
//   `<document>-<setup>.3mf`, validate3mf passes, there are two colour groups, and each copy is one
//   object with a part per body (io writes the two meshes and a components object holding them,
//   per copy: six objects and two build items), every body inside the plate and clear of the
//   excluded corner, each body's box as oriented;
// - the hand-off panel shows OrcaSlicer by default, and the slicer chosen in it survives a reload;
// - a 300 mm bar is refused, with the axis named.

const mm = (source: string) => ({ source, lengthUnit: 'mm', angleUnit: 'deg' });
const XY = { type: 'plane', origin: [0, 0, 0], normal: [0, 0, 1], xDir: [1, 0, 0] };

/** A rectangle sketch on the top plane, x0..x1 by y0..y1; entity ids from e<first>. */
function rectangle(id: string, x0: number, y0: number, x1: number, y1: number, first = 1) {
  const points: [number, number][] = [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
  return {
    id,
    kind: 'sketch',
    name: id,
    suppressed: false,
    plane: XY,
    entities: points.map((start, i) => ({
      id: `e${i + first}`,
      kind: 'line',
      construction: false,
      start,
      end: points[(i + 1) % points.length],
    })),
    constraints: [],
  };
}

function extrude(id: string, sketch: string, height: number) {
  return {
    id,
    kind: 'extrude',
    name: id,
    suppressed: false,
    profile: { sketch },
    operation: 'new',
    extent: { type: 'blind', distance: mm(`${height} mm`) },
    reverse: false,
  };
}

async function bodiesBuilt(page: Page, partId: string, count: number) {
  await page.waitForFunction(
    ([id, n]) => {
      const hooks = window.__manufakture!;
      const m = hooks.model.getState();
      return (
        !m.pending &&
        m.document === hooks.document.getState().document &&
        m.parts.some((p) => p.partId === id && p.bodies.length === n)
      );
    },
    [partId, count] as const,
    { timeout: 90_000 },
  );
}

/** Wait until the print workspace has resolved the setup as it is now, every item ok. */
async function resolvedOk(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const p = window.__manufakture!.print!;
    const r = p.resolved();
    return r !== null && r.items.every((i) => i.status === 'ok') && p.meshesSettled();
  });
}

const x1c = findPrinter('bambu-x1c')!;

test('export for printing: a two-colour part laid flat, two copies, into the slicer', async ({
  page,
}) => {
  test.setTimeout(300_000);
  const errors = await openEmpty(page);
  await execute(
    page,
    {
      type: 'batch',
      commands: [
        { type: 'renameDocument', name: 'Jig' },
        { type: 'renamePart', partId: 'part#1', name: 'Jig' },
        { type: 'addFeature', partId: 'part#1', feature: rectangle('sketch#1', 0, 0, 30, 20) },
        { type: 'addFeature', partId: 'part#1', feature: extrude('extrude#1', 'sketch#1', 10) },
        { type: 'addFeature', partId: 'part#1', feature: rectangle('sketch#2', 40, 0, 50, 10, 5) },
        { type: 'addFeature', partId: 'part#1', feature: extrude('extrude#2', 'sketch#2', 4) },
      ],
    },
    'Make the jig',
  );
  await bodiesBuilt(page, 'part#1', 2);
  await execute(
    page,
    {
      type: 'batch',
      commands: [
        {
          type: 'setBodyProps',
          partId: 'part#1',
          bodyId: 'extrude#1',
          props: { name: 'Block', color: '#d03030' },
        },
        {
          type: 'setBodyProps',
          partId: 'part#1',
          bodyId: 'extrude#2',
          props: { name: 'Knob', color: '#3050d0' },
        },
      ],
    },
    'Name and colour the bodies',
  );
  await regenerated(page);

  // A setup on the X1 Carbon printing the whole part.
  await page.getByTestId('open-print').click();
  await page.getByTestId('print-add-setup').click();
  await expect(page.getByTestId('print-printer')).toHaveValue('bambu-x1c');
  await page.getByTestId('print-add-item').click();
  await resolvedOk(page);

  // Lay it flat on the block's front face (y = 0, facing -y): pick the face in the view.
  await page.evaluate(() => {
    const hooks = window.__manufakture!;
    const boxes = hooks.print!.resolved()!.items[0]!.copies.map((c) => c.box);
    hooks.viewport.setViewDirection([0.2, -1, 0.35], false);
    hooks.viewport.frameBox(boxes[0]!, false);
  });
  await settle(page);
  const front = await page.evaluate(() => {
    const t = window.__manufakture!.print!.resolved()!.items[0]!.copies[0]!.placement.translation;
    return [15 + t[0], 0 + t[1], 5 + t[2]] as [number, number, number];
  });
  await page.getByTestId('print-lay-flat').click();
  const at = await page.evaluate((p) => window.__manufakture!.viewport.projectToClient(p), front);
  await page.mouse.click(at.x, at.y);
  await expect(page.getByTestId('print-item-item#1')).toContainText('Flat on');

  // Two copies; Enter commits and keeps the focus in the field.
  const copies = page.getByTestId('print-item-item#1-copies');
  await copies.fill('2');
  await copies.press('Enter');
  await expect(copies).toBeFocused();
  await expect
    .poll(() =>
      page.evaluate(() => window.__manufakture!.print!.resolved()!.items[0]!.copies.length),
    )
    .toBe(2);
  await resolvedOk(page);
  await expect(page.getByTestId('print-export-refusal')).toHaveCount(0);

  // Open in slicer: the 3MF downloads, and the help for OrcaSlicer (the default) shows.
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('print-open-slicer').click(),
  ]);
  expect(download.suggestedFilename()).toBe('Jig-Plate 1.3mf');
  const bytes = new Uint8Array(await readFile(await download.path()));
  await expect(page.getByTestId('print-export-status')).toContainText(
    "2 copies of 1 item on the Bambu Lab X1 Carbon's plate",
  );
  const help = page.getByTestId('slicer-handoff');
  await expect(help).toBeVisible();
  await expect(help).toHaveAttribute('data-slicer', 'orcaslicer');
  await expect(page.getByTestId('slicer-steps')).toContainText('Jig-Plate 1.3mf');

  const report = validate3mf(bytes);
  expect(report.problems).toEqual([]);
  const parsed = report.parsed!;
  expect(parsed.colorGroups.map((g) => g.colors)).toEqual([['#D03030'], ['#3050D0']]);
  expect(parsed.objects.map((o) => o.name)).toEqual([
    'Block',
    'Knob',
    'Jig',
    'Block',
    'Knob',
    'Jig',
  ]);
  expect(parsed.items).toHaveLength(2);
  expect(parsed.modelSettings!.map((o) => o.parts.map((p) => p.metadata.extruder))).toEqual([
    ['1', '2'],
    ['1', '2'],
  ]);
  const built = buildMeshes(parsed).map((m) => ({
    name: m.name,
    box: meshProperties(m.mesh).boundingBox!,
  }));
  expect(built.map((b) => b.name)).toEqual(['Block', 'Knob', 'Block', 'Knob']);
  for (const b of built) {
    // On the bed, inside the plate and clear of the excluded corner.
    expect(checkBedFit(x1c, { box: b.box }).fits, b.name).toBe(true);
    expect(b.box.min[2]).toBeCloseTo(0, 3);
    const size = [0, 1, 2].map((a) => b.box.max[a]! - b.box.min[a]!);
    // Face down on the front face: the 20 mm (block) and 10 mm (knob) depth is the height, and
    // the modelled height runs along y.
    if (b.name === 'Block') {
      expect(size[0]).toBeCloseTo(30, 3);
      expect(size[1]).toBeCloseTo(10, 3);
      expect(size[2]).toBeCloseTo(20, 3);
    } else {
      expect(size[0]).toBeCloseTo(10, 3);
      expect(size[1]).toBeCloseTo(4, 3);
      expect(size[2]).toBeCloseTo(10, 3);
    }
  }
  // The two copies do not overlap.
  const [a, b] = [built[0]!.box, built[2]!.box];
  expect(
    a.max[0] < b.min[0] || b.max[0] < a.min[0] || a.max[1] < b.min[1] || b.max[1] < a.min[1],
  ).toBe(true);

  // Another slicer, chosen in the help, is remembered across a reload.
  await page.getByTestId('slicer-choice').selectOption('bambustudio');
  await page.getByTestId('slicer-handoff-close').click();
  await expect(help).toHaveCount(0);

  // An oversize part is refused, with the axis named.
  await execute(page, { type: 'addPart', partId: 'part#2', name: 'Bar' }, 'Add Bar');
  await execute(
    page,
    {
      type: 'batch',
      commands: [
        { type: 'addFeature', partId: 'part#2', feature: rectangle('sketch#1', 0, 0, 300, 20) },
        { type: 'addFeature', partId: 'part#2', feature: extrude('extrude#1', 'sketch#1', 10) },
      ],
    },
    'Make the bar',
  );
  await bodiesBuilt(page, 'part#2', 1);
  await page.getByTestId('print-add-setup').click();
  await expect(page.getByTestId('print-setup-name')).toHaveValue('Plate 2');
  await page.getByTestId('print-add-part').selectOption('part#2');
  await page.getByTestId('print-add-item').click();
  const refusal = page.getByTestId('print-export-refusal');
  await expect(refusal).toHaveText(
    "Not exported. Bar does not fit the Bambu Lab X1 Carbon's bed: too big by x 44.00 mm.",
  );
  await expect(page.getByTestId('print-export-button')).toBeDisabled();
  await expect(page.getByTestId('print-open-slicer')).toBeDisabled();

  await saved(page);
  await page.reload();
  await expect(page.getByTestId('document-name')).toBeVisible({ timeout: 90_000 });
  await regenerated(page);
  await page.getByTestId('open-print').click();
  await page.getByTestId('print-slicer-help').click();
  await expect(page.getByTestId('slicer-choice')).toHaveValue('bambustudio');
  await expect(page.getByTestId('slicer-handoff')).toContainText('Open it in Bambu Studio');
  expect(errors).toEqual([]);
});
