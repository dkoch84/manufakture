import { readFile } from 'node:fs/promises';
import { expect, type Page } from '@playwright/test';
import { clickWorld, settle } from './helpers';
import { clickSketch, newSketch, sketchIdle, sketchState, tool } from './sketch-helpers';

// The M1 bracket, built through the UI exactly as docs/m1-acceptance.md walks through it, and
// its dimensions and exact volume, computed by hand.
//
// An L-profile on Front (XZ): a foot 50 mm long along +X and an upright 40 mm high along +Z,
// both `#thickness` thick, extruded 30 mm symmetric about the plane (Y from -15 to 15). Two M4
// counterbored holes go through the foot at X = 25 and X = 40 on the Y = 0 line, and the inside
// corner between the foot and the upright is rounded with a 4 mm fillet.
//
// On Front (XZ) the sketch x axis is world X and the sketch y axis is world Z; on the foot's top
// face the sketch x axis is world X and y is world Y, with the origin over the world origin.

export const BRACKET = {
  /** Foot length along X, mm. */
  length: 50,
  /** Upright height along Z, mm. */
  height: 40,
  /** Extrusion, symmetric about the XZ plane, mm. */
  width: 30,
  /** Fillet radius of the inside corner, mm. */
  fillet: 4,
  /** Hole centres on the foot, sketch (= world) X, at Y = 0. */
  holes: [25, 40] as const,
  /** M4, normal fit (ISO 273), and its counterbore (packages/kernel/src/holes.ts). */
  hole: { size: 'M4', diameter: 4.5, headDiameter: 8, headDepth: 4.4 },
};

/** Exact volume of the bracket (mm3) at each stage, for a given wall thickness. */
export function bracketVolume(t: number, stage: 'extrude' | 'holes' | 'fillet' = 'fillet'): number {
  const { length, height, width, fillet, hole } = BRACKET;
  const extruded = width * (length * t + (height - t) * t);
  if (stage === 'extrude') return extruded;
  const r = hole.diameter / 2;
  const R = hole.headDiameter / 2;
  const oneHole = Math.PI * (R * R * hole.headDepth + r * r * (t - hole.headDepth));
  const holed = extruded - 2 * oneHole;
  if (stage === 'holes') return holed;
  // A concave fillet adds the corner square less the quarter disc, along the whole width.
  return holed + width * fillet * fillet * (1 - Math.PI / 4);
}

/**
 * Faces of the bracket: 6 sides and 2 caps from the extrusion; each counterbored hole adds its
 * counterbore wall, its floor and the hole wall; the fillet adds its round.
 */
export const BRACKET_FACES = { extrude: 8, holes: 14, fillet: 15 };

/** The bracket's bounding box (it does not depend on the thickness). */
export const BRACKET_BOX = {
  min: [0, -BRACKET.width / 2, 0] as [number, number, number],
  max: [BRACKET.length, BRACKET.width / 2, BRACKET.height] as [number, number, number],
};

/** Open the app on a new, empty document and wait for the kernel; returns collected page errors. */
export async function openEmpty(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.getByTestId('empty-hint')).toBeVisible({ timeout: 90_000 });
  await page.waitForFunction(() => window.__manufakture!.model.getState().generation > 0);
  return errors;
}

export interface FeatureStatus {
  status: string;
  cached: boolean;
  warnings: string[];
  errors: string[];
  references: { referenceId: string; target: string; via: string; fragile: boolean }[];
}

/** Wait until the model shows the open document; then every feature's regen result, by id. */
export async function regenerated(page: Page): Promise<Record<string, FeatureStatus>> {
  await page.waitForFunction(
    () => {
      const hooks = window.__manufakture;
      if (!hooks?.model || !hooks.document || !hooks.viewport) return false;
      const m = hooks.model.getState();
      return !m.pending && m.generation > 0 && m.document === hooks.document.getState().document;
    },
    null,
    { timeout: 90_000 },
  );
  return page.evaluate(() =>
    Object.fromEntries(
      window.__manufakture!.model.getState().parts[0]!.features.map((f) => [
        f.featureId,
        {
          status: f.status,
          cached: f.cached,
          warnings: f.warnings.map((w) => w.message),
          errors: f.errors.map((e) => e.message),
          references: f.references,
        },
      ]),
    ),
  );
}

/** The part's exact volume from the measure tool (nothing selected: the body). */
export async function bodyVolume(page: Page): Promise<number> {
  await page.evaluate(() => window.__manufakture!.selection.getState().clear());
  await page.waitForFunction(() => {
    const s = window.__manufakture!.measure.getState();
    return s.status === 'ready' && s.request?.targets.length === 0 && s.result?.body;
  });
  return page.evaluate(() => window.__manufakture!.measure.getState().result!.body!.volume);
}

/** The part body's face and edge counts, as the viewport shows them. */
export async function bodyTopology(page: Page): Promise<{ faces: number; edges: number }> {
  const info = await page.evaluate(() => window.__manufakture!.viewport.info());
  // One body, the first extrusion's.
  expect(info.bodies.map((b) => b.id)).toEqual(['part#1/extrude#1']);
  return { faces: info.bodies[0]!.faces, edges: info.bodies[0]!.edges };
}

export async function openTool(page: Page, name: string): Promise<void> {
  await page
    .getByRole('toolbar', { name: 'Features' })
    .getByRole('button', { name, exact: true })
    .click();
  await expect(page.getByTestId('feature-dialog')).toBeVisible();
}

export async function ok(page: Page): Promise<void> {
  await page.getByTestId('dialog-ok').click();
  await expect(page.getByTestId('feature-dialog')).toBeHidden();
}

const variables = (page: Page) => page.getByRole('complementary', { name: 'Variables' });

export async function addVariable(page: Page, name: string, value: string): Promise<void> {
  await variables(page).getByTestId('variable-add').click();
  await page.getByTestId('variable-name').fill(name);
  await page.getByTestId('variable-expression').fill(value);
  await page.getByTestId('variable-save').click();
  await expect(page.getByTestId('variable-editor')).toBeHidden();
}

export async function editVariable(page: Page, name: string, value: string): Promise<void> {
  await variables(page)
    .getByRole('button', { name: `Edit #${name}` })
    .click();
  await page.getByTestId('variable-expression').fill(value);
  await page.getByTestId('variable-save').click();
  await expect(page.getByTestId('variable-editor')).toBeHidden();
}

/** Place a dimension on the curve under `on`, its label at `label`, with the value typed. */
async function dimension(page: Page, on: [number, number], label: [number, number], value: string) {
  await tool(page, 'Dimension');
  await clickSketch(page, on);
  await clickSketch(page, label);
  const input = page.getByTestId('dimension-input');
  await expect(input).toBeFocused();
  await input.fill(value);
  // A variable typed in full has nothing left to complete: Enter sets the dimension.
  await expect(input).toHaveAttribute('aria-expanded', 'false');
  await input.press('Enter');
  await expect(input).toBeHidden();
  await sketchIdle(page);
}

/** Wait for the view to settle and turn it to a standard view without animation. */
export async function view(page: Page, v: 'iso' | 'top' | 'front' | 'right'): Promise<void> {
  await page.evaluate((name) => window.__manufakture!.viewport.setStandardView(name, false), v);
  await settle(page);
}

/** Hooks called between the steps of `buildBracket`, for screenshots of the walkthrough. */
export type StepHook = (
  step: 'variable' | 'sketch' | 'extrude' | 'holes' | 'fillet',
) => Promise<void>;

/**
 * Build the bracket through the UI on an empty document: the `#thickness` variable, the
 * L-profile sketch, the extrusion, the hole sketch and the counterbored holes, the fillet.
 * Checks each step's result on the way.
 */
export async function buildBracket(page: Page, thickness = 6, onStep?: StepHook): Promise<void> {
  const { length, height, width, fillet, holes, hole } = BRACKET;
  const t = thickness;

  // 1. The variable every wall reads.
  await addVariable(page, 'thickness', String(t));
  await expect(page.getByTestId('variable-thickness-value')).toHaveText(`${t.toFixed(2)} mm`);
  await onStep?.('variable');

  // 2. The L-profile, drawn roughly (walls 8 mm) as one closed chain of lines from the origin,
  // then dimensioned: the foot's length, the upright's height and both walls by #thickness.
  await newSketch(page, 'Front (XZ)');
  const drawn = 8;
  await tool(page, 'Line');
  for (const p of [
    [0, 0],
    [length, 0],
    [length, drawn],
    [drawn, drawn],
    [drawn, height],
    [0, height],
    [0, 0],
  ] as [number, number][]) {
    await clickSketch(page, p);
  }
  await sketchIdle(page);
  const chain = await sketchState(page);
  expect(chain.entities.map((e) => e.kind)).toEqual(Array(6).fill('line'));
  await dimension(page, [length / 2, 0], [length / 2, -8], String(length));
  await dimension(page, [0, height / 2], [-8, height / 2], String(height));
  await dimension(page, [length, drawn / 2], [length + 8, drawn / 2], '#thickness');
  await dimension(page, [drawn / 2, height], [drawn / 2, height + 8], '#thickness');
  await expect(page.getByTestId('sketch-dof')).toHaveText('Fully constrained');
  const solved = await sketchState(page);
  expect(solved.status).toBe('solved');
  expect(solved.conflicting).toEqual([]);
  expect(solved.constraints.filter((c) => c.value).map((c) => c.value!.source)).toEqual([
    String(length),
    String(height),
    '#thickness',
    '#thickness',
  ]);
  await onStep?.('sketch');
  await page.getByRole('button', { name: 'Finish sketch' }).click();
  await expect(page.getByTestId('feature-sketch#1')).toBeVisible();

  // 3. Extrude it 30 mm, split evenly to both sides of the plane.
  await page.getByTestId('feature-sketch#1').click();
  await openTool(page, 'Extrude');
  await expect(page.getByTestId('field-sketch')).toHaveValue('sketch#1');
  await expect(page.getByTestId('field-operation')).toHaveValue('new');
  await page.getByTestId('field-extent').selectOption('symmetric');
  await page.getByTestId('field-distance').fill(String(width));
  await ok(page);
  expect(await regenerated(page)).toMatchObject({
    'sketch#1': { status: 'ok' },
    'extrude#1': { status: 'ok' },
  });
  expect(await bodyVolume(page)).toBeCloseTo(bracketVolume(t, 'extrude'), 3);
  expect((await bodyTopology(page)).faces).toBe(BRACKET_FACES.extrude);
  await onStep?.('extrude');

  // 4. A sketch on the foot's top face, with a point at each hole centre.
  await view(page, 'iso');
  await clickWorld(page, [(holes[0] + holes[1]) / 2, 8, t]);
  const topFace = await page.evaluate(() =>
    window.__manufakture!.selection.getState().selected.map((i) => i.name ?? i.id),
  );
  expect(topFace).toHaveLength(1);
  expect(topFace[0]).toMatch(/^extrude#1:side:/);
  await newSketch(page, 'Selected face');
  await tool(page, 'Point');
  for (const x of holes) await clickSketch(page, [x, 0]);
  await sketchIdle(page);
  const points = await sketchState(page);
  expect(points.entities.map((e) => e.kind)).toEqual(['point', 'point']);
  await page.getByRole('button', { name: 'Finish sketch' }).click();
  const sketch2 = await page.evaluate(() =>
    window.__manufakture!.document.getState().document.parts[0]!.features.at(-1)!,
  );
  expect(sketch2).toMatchObject({
    id: 'sketch#2',
    plane: { type: 'face', face: { ref: { face: topFace[0] } } },
  });

  // 5. The holes: M4 from the standard sizes, normal fit, counterbored, through the part.
  await page.getByTestId('feature-sketch#2').click();
  await openTool(page, 'Hole');
  await expect(page.getByTestId('field-sketch')).toHaveValue('sketch#2');
  const centres = page.getByTestId('field-points').getByRole('checkbox');
  await expect(centres).toHaveCount(2);
  for (const c of await centres.all()) await expect(c).toBeChecked();
  await page.getByTestId('field-standard').selectOption(hole.size);
  await expect(page.getByTestId('field-fit')).toHaveValue('normal');
  await page.getByTestId('field-head').selectOption('counterbore');
  await expect(page.getByTestId('field-extent')).toHaveValue('throughAll');
  await expect(page.getByTestId('field-diameter-note')).toHaveText(
    `= ${hole.diameter.toFixed(2)} mm`,
  );
  await expect(page.getByTestId('field-headDiameter-note')).toHaveText(
    `= ${hole.headDiameter.toFixed(2)} mm`,
  );
  await expect(page.getByTestId('field-headDepth-note')).toHaveText(
    `= ${hole.headDepth.toFixed(2)} mm`,
  );
  await ok(page);
  expect(await regenerated(page)).toMatchObject({ 'hole#1': { status: 'ok', warnings: [] } });
  expect(await bodyVolume(page)).toBeCloseTo(bracketVolume(t, 'holes'), 3);
  expect((await bodyTopology(page)).faces).toBe(BRACKET_FACES.holes);
  await onStep?.('holes');

  // 6. Round the inside corner: its edge picked in the view, radius 4.
  await view(page, 'iso');
  await openTool(page, 'Fillet');
  await clickWorld(page, [t, -width / 4, t]);
  await expect(page.getByTestId('ref-edges').locator('li')).toHaveCount(1);
  await page.getByTestId('field-radius').fill(String(fillet));
  await ok(page);
  const statuses = await regenerated(page);
  expect(Object.fromEntries(Object.entries(statuses).map(([id, s]) => [id, s.status]))).toEqual({
    'sketch#1': 'ok',
    'extrude#1': 'ok',
    'sketch#2': 'ok',
    'hole#1': 'ok',
    'fillet#1': 'ok',
  });
  expect(await bodyVolume(page)).toBeCloseTo(bracketVolume(t), 3);
  expect((await bodyTopology(page)).faces).toBe(BRACKET_FACES.fillet);
  await onStep?.('fillet');
}

/** Choose an Export menu item and return the downloaded file. */
export async function exportAs(
  page: Page,
  item: 'stl' | '3mf' | 'step',
  tolerance?: 'draft' | 'normal' | 'fine',
): Promise<{ name: string; bytes: Uint8Array }> {
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  if (tolerance) await page.getByLabel('Mesh tolerance').selectOption(tolerance);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId(`export-${item}`).click(),
  ]);
  const bytes = new Uint8Array(await readFile(await download.path()));
  await expect(page.getByTestId('io-status')).toHaveText(
    new RegExp(`^Exported ${download.suggestedFilename().replace('.', '\\.')}`),
  );
  return { name: download.suggestedFilename(), bytes };
}
