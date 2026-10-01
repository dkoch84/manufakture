import { readFile } from 'node:fs/promises';
import { expect, type Page } from '@playwright/test';
import { bracketVolume, buildBracket, regenerated } from './bracket';
import { settle, type Vec3 } from './helpers';

// The M2 acceptance model, "a wall shelf with a derived bracket, assembled" (docs/m2-acceptance.md),
// its dimensions and the values computed by hand, shared by the m2-*.spec.ts chapters.
//
// The shelf hangs on a wall in the plane x = 0: its depth runs along +X away from the wall, its
// width along +Y and its height along +Z. It is one part studio of four bodies, each a rectangle on
// a horizontal plane extruded upwards:
//
// - Left side:  x 0..200, y 0..18,          z 0..300
// - Right side: x 0..200, y W - 18..W,      z 0..300
// - Bottom:     x 0..200, y 18..W - 18,     z 0..18
// - Top:        x 0..200, y 18..W - 18,     z 282..300
//
// with W = #width (600 mm, and 800 and 1000 mm as configurations). Two supports, each the M1
// bracket derived from its own document, hang under it against the wall, and a drawer box slides
// in and out on the bottom board.

export const SHELF = {
  /** Depth, along X from the wall, mm. */
  depth: 200,
  /** Height of the sides, along Z, mm. */
  height: 300,
  /** Board thickness: the sides, the bottom and the top, mm. */
  board: 18,
  /** The widths of the configuration table, mm; the first is the stored #width. */
  widths: [600, 800, 1000] as const,
  /** Pine (eastern white), packages/core/src/materials.ts, kg/m3. */
  density: 400,
};

export const DRAWER = {
  /** Along X (depth), Y (width) and Z (height), mm. */
  size: [180, 240, 120] as Vec3,
  /** The slider's limits: how far the drawer's front is in front of the shelf's, mm. */
  limits: [0, 150] as const,
};

/** Exact volumes of the shelf's bodies at width `w`, mm3. */
export function shelfVolumes(w: number) {
  const { depth, height, board } = SHELF;
  const side = depth * board * height;
  const plank = depth * (w - 2 * board) * board;
  return { side, board: plank, total: 2 * side + 2 * plank };
}

export const drawerVolume = DRAWER.size[0] * DRAWER.size[1] * DRAWER.size[2];

/** Grams of pine in `mm3` cubic millimetres. */
export const pineGrams = (mm3: number) => (mm3 * SHELF.density) / 1e6;

/** What the shelf's bodies are called, in the order their extrusions made them. */
export const BODY_NAMES = ['Left side', 'Right side', 'Bottom', 'Top'] as const;

/** The bracket's thickness at the two versions of its document. */
export const BRACKET_VERSIONS = { '6 mm': 6, '8 mm': 8 } as const;

export { bracketVolume };

const mm = (source: string) => ({ source, lengthUnit: 'mm', angleUnit: 'deg' });

/** A horizontal sketch plane at height `z`: sketch x is world X, sketch y is world Y. */
const planeAt = (z: number) =>
  ({ type: 'plane', origin: [0, 0, z], normal: [0, 0, 1], xDir: [1, 0, 0] }) as const;

/**
 * A fully constrained rectangle: its first corner `x0`, `y0` from the sketch origin and its size
 * `w` by `h`, each an expression (so `#width` can drive it). `at` gives the numbers it is drawn
 * at, for the solver to start from.
 */
function rectangleSketch(
  n: number,
  id: string,
  name: string,
  z: number,
  expr: { x0: string; y0: string; w: string; h: string },
  at: { x0: number; y0: number; w: number; h: number },
) {
  const corners: [number, number][] = [
    [at.x0, at.y0],
    [at.x0 + at.w, at.y0],
    [at.x0 + at.w, at.y0 + at.h],
    [at.x0, at.y0 + at.h],
  ];
  // Entity and constraint ids are counted per part studio, never per sketch.
  const ids = [1, 2, 3, 4].map((i) => `e${4 * n + i}`);
  const k = (i: number) => `k${12 * n + i}`;
  const origin = { entity: '@origin' };
  const corner = { entity: ids[0], at: 'start' };
  return {
    id,
    kind: 'sketch',
    name,
    suppressed: false,
    plane: planeAt(z),
    entities: corners.map((start, i) => ({
      id: ids[i],
      kind: 'line',
      construction: false,
      start,
      end: corners[(i + 1) % 4],
    })),
    constraints: [
      ...ids.map((e, i) => ({
        id: k(i + 1),
        kind: 'coincident',
        a: { entity: e, at: 'end' },
        b: { entity: ids[(i + 1) % 4], at: 'start' },
      })),
      { id: k(5), kind: 'horizontal', line: ids[0] },
      { id: k(6), kind: 'horizontal', line: ids[2] },
      { id: k(7), kind: 'vertical', line: ids[1] },
      { id: k(8), kind: 'vertical', line: ids[3] },
      { id: k(9), kind: 'horizontalDistance', a: origin, b: corner, value: mm(expr.x0) },
      { id: k(10), kind: 'verticalDistance', a: origin, b: corner, value: mm(expr.y0) },
      // Signed sizes: an unsigned distance lets the solver fold the rectangle back over its
      // corner when #width moves it far (it takes the nearest solution).
      {
        id: k(11),
        kind: 'horizontalDistance',
        a: { entity: ids[0], at: 'start' },
        b: { entity: ids[0], at: 'end' },
        value: mm(expr.w),
      },
      {
        id: k(12),
        kind: 'verticalDistance',
        a: { entity: ids[1], at: 'start' },
        b: { entity: ids[1], at: 'end' },
        value: mm(expr.h),
      },
    ],
  };
}

/**
 * The shelf's four profiles, as `addFeature` commands for part studio `partId`: the sides' and
 * the bottom's on the ground plane, the top's 18 mm below the sides' tops. Each is extruded
 * upwards: the sides 300 mm, the boards 18 mm.
 */
export function shelfSketches(partId: string): unknown[] {
  const { depth: d, height, board: t, widths } = SHELF;
  const w = widths[0];
  const D = `${d} mm`;
  const T = `${t} mm`;
  const inner = `#width - ${2 * t} mm`;
  const sketches = [
    rectangleSketch(
      0,
      'sketch#1',
      'Left side',
      0,
      { x0: '0 mm', y0: '0 mm', w: D, h: T },
      {
        x0: 0,
        y0: 0,
        w: d,
        h: t,
      },
    ),
    rectangleSketch(
      1,
      'sketch#2',
      'Right side',
      0,
      { x0: '0 mm', y0: `#width - ${t} mm`, w: D, h: T },
      { x0: 0, y0: w - t, w: d, h: t },
    ),
    rectangleSketch(
      2,
      'sketch#3',
      'Bottom',
      0,
      { x0: '0 mm', y0: T, w: D, h: inner },
      {
        x0: 0,
        y0: t,
        w: d,
        h: w - 2 * t,
      },
    ),
    rectangleSketch(
      3,
      'sketch#4',
      'Top',
      height - t,
      { x0: '0 mm', y0: T, w: D, h: inner },
      {
        x0: 0,
        y0: t,
        w: d,
        h: w - 2 * t,
      },
    ),
  ];
  return sketches.map((feature) => ({ type: 'addFeature', partId, feature }));
}

/** The drawer's profile: its footprint from the origin, on the ground plane. */
export function drawerSketch(partId: string): unknown {
  const [x, y] = DRAWER.size;
  return {
    type: 'addFeature',
    partId,
    feature: rectangleSketch(
      0,
      'sketch#1',
      'Drawer',
      0,
      { x0: '0 mm', y0: '0 mm', w: `${x} mm`, h: `${y} mm` },
      { x0: 0, y0: 0, w: x, h: y },
    ),
  };
}

/** An extrusion of `sketch` upwards as a new body, as the Extrude dialog makes it. */
export function extrudeFeature(id: string, name: string, sketch: string, height: number) {
  return {
    id,
    kind: 'extrude',
    name,
    suppressed: false,
    profile: { sketch },
    operation: 'new',
    extent: { type: 'blind', distance: mm(`${height} mm`) },
    reverse: false,
  };
}

/** Run a document command through the store, as one undo step with `label`. */
export async function execute(page: Page, command: unknown, label: string): Promise<void> {
  const result = await page.evaluate(
    ([c, l]) => JSON.stringify(window.__manufakture!.document.getState().execute(c, l as string)),
    [command, label] as const,
  );
  expect((JSON.parse(result) as { ok: boolean }).ok, `${label}: ${result}`).toBe(true);
}

/** Turn the view to a standard view without animation, and wait for it to settle. */
export async function look(
  page: Page,
  v: 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom' | 'iso',
): Promise<void> {
  await page.evaluate((name) => window.__manufakture!.viewport.setStandardView(name, false), v);
  await settle(page);
}

export async function saved(page: Page): Promise<void> {
  await expect(page.getByTestId('save-status')).toHaveText('Saved', { timeout: 15_000 });
}

/** The active assembly's regen result, once the model shows the open document. */
export async function solved(page: Page, assemblyId: string): Promise<E2eAssemblyResult> {
  await regenerated(page);
  await settle(page);
  return page.evaluate(
    (id) => window.__manufakture!.model.getState().assemblies.find((a) => a.assemblyId === id)!,
    assemblyId,
  );
}

export const instance = (a: E2eAssemblyResult, id: string) =>
  a.instances.find((x) => x.instanceId === id)!;

/** A point of an instance in world coordinates (`p_world = R p + t`, R a unit quaternion). */
export function place(pose: E2ePose, p: Vec3): Vec3 {
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

export function expectNear(actual: readonly number[], expected: readonly number[], digits = 3) {
  expect(actual.length).toBe(expected.length);
  actual.forEach((v, i) => expect(v, `component ${i}`).toBeCloseTo(expected[i]!, digits));
}

/** Choose an Export menu item and return the downloaded file. */
export async function download(
  page: Page,
  item: 'stl' | '3mf' | 'step',
): Promise<{ name: string; bytes: Uint8Array }> {
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const [file] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId(`export-${item}`).click(),
  ]);
  const bytes = new Uint8Array(await readFile(await file.path()));
  await expect(page.getByTestId('io-status')).toHaveText(
    new RegExp(`^Exported ${file.suggestedFilename().replace('.', '\\.')}`),
  );
  return { name: file.suggestedFilename(), bytes };
}

/** The bounding box of a list of xyz positions. */
export function boxOf(positions: ArrayLike<number>): { min: Vec3; max: Vec3 } {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let j = 0; j < positions.length; j += 3) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k]!, positions[j + k]!);
      max[k] = Math.max(max[k]!, positions[j + k]!);
    }
  }
  return { min, max };
}

// --- The assembled shelf, quickly ------------------------------------------------------------
// For the views and the budgets: the same document the walkthrough (m2-shelf.spec.ts) makes
// through the UI, made with commands where that is quicker. The bracket is built through the UI
// (bracket.ts) and the support derived through the Derived part dialog, since a pin carries its
// source document. The mates are the ones the walkthrough picks: the supports' uprights fastened
// to the sides' backs, the drawer's front on a slider on the bottom board's front.

const value = (source: string | number) => mm(String(source));

function connector(
  id: string,
  instance: string,
  ref: string,
  face: string,
  offset?: { x?: number; y?: number; angle?: number },
) {
  return {
    id,
    instance,
    ...(offset
      ? {
          offset: {
            translation: [value(offset.x ?? 0), value(offset.y ?? 0), value(0)],
            rotation: [value(0), value(0), value(offset.angle ?? 0)],
          },
        }
      : {}),
    inference: 'centroid',
    origin: { id: ref, ref: { face } },
  };
}

const identity = { translation: [0, 0, 0], rotation: [0, 0, 0, 1] };
const halfTurnX = [1, 0, 0, 0];

/** The assembly as commands, with the poses the mates solve to at 600 mm. */
export function assemblyCommands(): unknown[] {
  const assemblyId = 'assembly#1';
  const support = 'derived#1:from/extrude#1:side:e6';
  const inst = (id: string, name: string, part: string, pose: unknown, fixed = false) => ({
    type: 'addInstance',
    assemblyId,
    instance: { id, name, source: { part }, fixed, suppressed: false, pose },
  });
  const mate = (id: string, name: string, kind: string, a: unknown, b: unknown, extra = {}) => ({
    type: 'addMate',
    assemblyId,
    mate: { id, name, kind, a, b, suppressed: false, ...extra },
  });
  return [
    { type: 'addAssembly', assemblyId, name: 'Assembly 1' },
    inst('inst#1', 'Shelf 1', 'part#1', identity, true),
    inst('inst#2', 'Support 1', 'part#2', { translation: [0, 33, 0], rotation: halfTurnX }),
    inst('inst#3', 'Support 2', 'part#2', { translation: [0, 567, 0], rotation: halfTurnX }),
    inst('inst#4', 'Drawer 1', 'part#3', { translation: [20, 180, 18], rotation: [0, 0, 0, 1] }),
    mate(
      'mate#1',
      'Fastened 1',
      'fastened',
      connector('mc#1', 'inst#1', 'r1', 'extrude#1:side:e4', { x: 24, y: 170, angle: 180 }),
      connector('mc#2', 'inst#2', 'r2', support),
    ),
    mate(
      'mate#2',
      'Fastened 2',
      'fastened',
      connector('mc#3', 'inst#1', 'r3', 'extrude#2:side:e8', { x: -24, y: 170, angle: 180 }),
      connector('mc#4', 'inst#3', 'r4', support),
    ),
    mate(
      'mate#3',
      'Slider 3',
      'slider',
      connector('mc#5', 'inst#1', 'r5', 'extrude#3:side:e10', { y: 69 }),
      connector('mc#6', 'inst#4', 'r6', 'extrude#1:side:e2'),
      { limits: { min: value(DRAWER.limits[0]), max: value(DRAWER.limits[1]) } },
    ),
  ];
}

/** The shelf document's part studios and configurations, as commands. */
export function shelfDocumentCommands(): unknown[] {
  const heights = [SHELF.height, SHELF.height, SHELF.board, SHELF.board];
  return [
    { type: 'renameDocument', name: 'Wall shelf' },
    { type: 'renamePart', partId: 'part#1', name: 'Shelf' },
    { type: 'setVariable', name: 'width', expression: value(`${SHELF.widths[0]} mm`) },
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
    { type: 'setMaterial', partId: 'part#1', material: 'pine' },
    {
      type: 'setConfigParameter',
      parameter: { id: 'cp#1', name: '#width', kind: 'variable', variable: 'width' },
    },
    ...SHELF.widths.map((w, i) => ({
      type: 'setConfigRow',
      row: { id: `cfg#${i + 1}`, name: `${w} mm`, values: { 'cp#1': value(`${w} mm`) } },
    })),
    { type: 'addPart', partId: 'part#2', name: 'Support' },
    { type: 'addPart', partId: 'part#3', name: 'Drawer' },
    drawerSketch('part#3'),
    {
      type: 'addFeature',
      partId: 'part#3',
      feature: extrudeFeature('extrude#1', 'Extrude 1', 'sketch#1', DRAWER.size[2]),
    },
  ];
}

/**
 * From an empty document: the bracket document at version "6 mm", then the wall shelf document,
 * assembled at 600 mm, its assembly tab open and solved.
 */
export async function buildWallShelf(page: Page): Promise<void> {
  await execute(page, { type: 'renameDocument', name: 'Bracket' }, 'Rename document');
  await buildBracket(page, 6);
  await saved(page);
  const version = await page.evaluate(() =>
    window.__manufakture!.autosave.createVersion({ name: '6 mm' }),
  );
  expect(version.ok).toBe(true);

  await page.getByTestId('open-home').click();
  await page.getByRole('button', { name: 'New document' }).click();
  await expect(page.getByTestId('empty-hint')).toBeVisible();
  await execute(page, { type: 'batch', commands: shelfDocumentCommands() }, 'Make the parts');
  await regenerated(page);

  await page.getByTestId('part-tab-part#2').click();
  await page
    .getByRole('toolbar', { name: 'Features' })
    .getByRole('button', { name: 'Derived part', exact: true })
    .click();
  const dialog = page.getByTestId('feature-dialog');
  await dialog.getByTestId('pin-document').selectOption({ label: 'Bracket' });
  await dialog.getByRole('button', { name: 'Use version 6 mm' }).click();
  await expect(dialog.getByTestId('pin-part')).toHaveValue('part#1');
  await page.getByTestId('dialog-ok').click();
  await expect(dialog).toBeHidden();
  await regenerated(page);

  await execute(page, { type: 'batch', commands: assemblyCommands() }, 'Assemble');
  await page.getByTestId('assembly-tab-assembly#1').click();
  const asm = await solved(page, 'assembly#1');
  expect(asm.dof).toBe(1);
  expect(asm.mates.map((m) => m.status)).toEqual(['ok', 'ok', 'ok']);
  expectNear(instance(asm, 'inst#3').transform.translation, [0, 567, 0]);
  expectNear(instance(asm, 'inst#4').transform.translation, [20, 180, 18]);
  await saved(page);
}
