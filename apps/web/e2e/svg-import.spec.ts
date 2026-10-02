import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, test, type Page } from '@playwright/test';
import { bodyVolume, ok, openEmpty, openTool, regenerated } from './bracket';
import { features, newSketch, sketchIdle, sketchState, statusBar } from './sketch-helpers';

// SVG import through the UI (M5 T5.8), each into a new sketch on Top (XY) and then extruded with
// every region, the body's volume checked against the artwork's area times the depth:
//
// 1. A whole word converted to paths (packages/io/src/fixtures/svg/word.svg, "WOODSHOP" in Inter
//    Bold, written by packages/io/scripts/svg-word-fixture.ts) as one outline, the default: far
//    more curves than a sketch's own lines and arcs could hold. Its area is computed here from
//    the font itself (opentype.js, Green's theorem over its lines and quadratic Beziers), as the
//    text spec does, scaled to the fixture's 20 mm cap height.
// 2. The lettering fixture ("O", "A", "B" with their counters, and a dot;
//    packages/io/src/fixtures/svg/letters.svg) as unconstrained sketch lines, arcs and a circle
//    that the solver leaves in place. Its area is computed from the file's own numbers: the A
//    from its polygons, the B from rectangles and half discs, the O from its cubic Beziers (a
//    dense polyline), and the dot as a disc.

const FIXTURE = new URL('../../../packages/io/src/fixtures/svg/letters.svg', import.meta.url);
const WORD_FIXTURE = new URL('../../../packages/io/src/fixtures/svg/word.svg', import.meta.url);
const WORD = 'WOODSHOP';
const WORD_CAP_HEIGHT = 20;
const DEPTH = 3;
const TOLERANCE = 0.01;

type P = [number, number];

function shoelace(points: readonly P[]): number {
  let a = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    const q = points[(i + 1) % points.length]!;
    a += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(a / 2);
}

function cubics(pieces: [P, P, P, P][]): P[] {
  const out: P[] = [];
  for (const [p0, p1, p2, p3] of pieces) {
    for (let i = 0; i < 20000; i++) {
      const t = i / 20000;
      const u = 1 - t;
      out.push([
        u ** 3 * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t ** 3 * p3[0],
        u ** 3 * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t ** 3 * p3[1],
      ]);
    }
  }
  return out;
}

const halfDisc = (r: number) => (Math.PI * r * r) / 2;

const AREA = {
  O:
    shoelace(
      cubics([
        [
          [34, 25],
          [34, 36.046],
          [27.732, 45],
          [20, 45],
        ],
        [
          [20, 45],
          [12.268, 45],
          [6, 36.046],
          [6, 25],
        ],
        [
          [6, 25],
          [6, 13.954],
          [12.268, 5],
          [20, 5],
        ],
        [
          [20, 5],
          [27.732, 5],
          [34, 13.954],
          [34, 25],
        ],
      ]),
    ) -
    shoelace(
      cubics([
        [
          [27, 25],
          [27, 18.373],
          [23.866, 13],
          [20, 13],
        ],
        [
          [20, 13],
          [16.134, 13],
          [13, 18.373],
          [13, 25],
        ],
        [
          [13, 25],
          [13, 31.627],
          [16.134, 37],
          [20, 37],
        ],
        [
          [20, 37],
          [23.866, 37],
          [27, 31.627],
          [27, 25],
        ],
      ]),
    ),
  A:
    shoelace([
      [0, 45],
      [11, 5],
      [19, 5],
      [30, 45],
      [23, 45],
      [20.5, 35],
      [9.5, 35],
      [7, 45],
    ]) -
    shoelace([
      [11.5, 28],
      [15, 13],
      [18.5, 28],
    ]),
  B:
    14 * 19 +
    halfDisc(9.5) +
    15 * 21 +
    halfDisc(10.5) -
    (6 * 7 + halfDisc(3.5)) -
    (7 * 10 + halfDisc(5)),
  dot: Math.PI * 16,
};

interface FontCommand {
  type: 'M' | 'L' | 'Q' | 'C' | 'Z';
  x: number;
  y: number;
  x1: number;
  y1: number;
}
interface Opentype {
  parse(buffer: ArrayBuffer): {
    tables: { os2: { sCapHeight: number } };
    charToGlyph(c: string): { path: { commands: FontCommand[] } };
  };
}

/** Square millimetres of `text`'s letters in Inter Bold at a cap height of `size` mm. */
function wordArea(text: string, size: number): number {
  const textDir = new URL('../../../packages/text/', import.meta.url);
  const opentype = createRequire(new URL('package.json', textDir))('opentype.js') as Opentype;
  const bytes = readFileSync(new URL('fonts/Inter-Bold.ttf', textDir));
  const font = opentype.parse(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length),
  );
  const k = size / font.tables.os2.sCapHeight;
  let total = 0;
  for (const c of text) {
    let a = 0;
    let start = [0, 0];
    let at = [0, 0];
    const cross = (p: number[], q: number[]) => p[0]! * q[1]! - q[0]! * p[1]!;
    for (const cmd of font.charToGlyph(c).path.commands) {
      const to = [cmd.x, cmd.y];
      if (cmd.type === 'M') start = to;
      else if (cmd.type === 'L') a += cross(at, to);
      else if (cmd.type === 'Q') {
        const q = [cmd.x1, cmd.y1];
        a += (2 * cross(at, q) + 2 * cross(q, to) + cross(at, to)) / 3;
      } else if (cmd.type === 'Z') {
        a += cross(at, start);
        at = start;
        continue;
      } else throw new Error('Inter Bold has quadratic outlines only');
      at = to;
    }
    total += Math.abs(a / 2);
  }
  return total * k * k;
}

async function importFile(page: Page, name: string, file: URL) {
  await page.getByRole('button', { name: 'Import SVG' }).click();
  const dialog = page.getByRole('dialog', { name: 'Import SVG' });
  await expect(dialog).toBeVisible();
  await dialog.getByTestId('svg-import-file').setInputFiles({
    name,
    mimeType: 'image/svg+xml',
    buffer: readFileSync(file),
  });
  return dialog;
}

async function extrudeAll(page: Page, depth: number): Promise<number> {
  await page.getByRole('button', { name: 'Finish sketch' }).click();
  await expect(page.getByRole('toolbar', { name: 'Sketch' })).toBeHidden();
  await page.getByTestId('feature-sketch#1').click();
  await openTool(page, 'Extrude');
  await expect(page.getByTestId('field-sketch')).toHaveValue('sketch#1');
  await page.getByTestId('field-distance').fill(String(depth));
  await ok(page);
  const statuses = await regenerated(page);
  for (const [id, status] of Object.entries(statuses)) {
    expect(status, id).toMatchObject({ status: 'ok', errors: [] });
  }
  return bodyVolume(page);
}

test('a whole word imports as one outline, and extrudes', async ({ page }) => {
  test.setTimeout(240_000);
  const errors = await openEmpty(page);
  await newSketch(page, 'Top (XY)');
  const dialog = await importFile(page, 'word.svg', WORD_FIXTURE);
  await expect(dialog.getByTestId('svg-import-mode')).toHaveValue('outline');
  await expect(dialog.getByTestId('svg-import-counts')).toHaveText('8 shapes as one outline');
  // Twice the size, by the scale the outline keeps.
  await dialog.getByTestId('svg-import-scale').fill('2');
  await dialog.getByTestId('svg-import-ok').click();
  await expect(dialog).toBeHidden();
  await sketchIdle(page);

  const s = await sketchState(page);
  expect(s.entities.map((e) => e.kind)).toEqual(['outline']);
  expect(s.status).toBe('solved');
  expect(s.dof).toBe(2); // the anchor only
  // Every letter shows as a region, the counters of the O's, the D and the P as holes in them.
  await expect(page.getByTestId('region-fill')).toHaveCount(8);
  const depth = 3;
  const volume = await extrudeAll(page, depth);
  // Stored as the one outline entity, its paths in the document.
  const [sketch] = await features(page);
  expect(sketch!.entities).toHaveLength(1);
  const expected = wordArea(WORD, WORD_CAP_HEIGHT * 2) * depth;
  console.log(`svg word: volume ${volume.toFixed(3)} mm3, expected ${expected.toFixed(3)}`);
  // Exact geometry (the font's quadratic Beziers), up to the fixture's 0.001 font-unit rounding.
  expect(Math.abs(volume - expected) / expected).toBeLessThan(1e-4);
  expect(errors).toEqual([]);
});

test('an SVG with letters imports as sketch geometry, and extrudes', async ({ page }) => {
  test.setTimeout(240_000);
  const errors = await openEmpty(page);
  await newSketch(page, 'Top (XY)');

  const dialog = await importFile(page, 'letters.svg', FIXTURE);
  await dialog.getByTestId('svg-import-mode').selectOption('entities');
  await expect(dialog.getByTestId('svg-import-counts')).toHaveText(
    /^\d+ lines, \d+ arcs and 1 circle$/,
  );
  await expect(dialog.getByTestId('svg-import-size')).toHaveText(/^110(\.0+)? mm$/);
  // The SVG page's bottom left corner on the sketch origin: the file's own millimetres.
  await dialog.getByTestId('svg-import-anchor').selectOption('page');
  await dialog.getByTestId('svg-import-ok').click();
  await expect(dialog).toBeHidden();
  await sketchIdle(page);

  const s = await sketchState(page);
  const kinds = s.entities.map((e) => e.kind);
  expect(kinds.filter((k) => k === 'circle')).toHaveLength(1);
  expect(kinds.filter((k) => k === 'arc').length).toBeGreaterThan(8);
  expect(s.constraints).toEqual([]);
  expect(s.status).toBe('solved');
  expect(s.conflicting).toEqual([]);
  await expect(statusBar(page)).toHaveAttribute('data-state', 'under');
  // The dot where the file put it: (112, 40) from the top left of a 50 mm page, so y = 10.
  const dot = s.entities.find((e) => e.kind === 'circle')!;
  expect(dot.center![0]).toBeCloseTo(112, 9);
  expect(dot.center![1]).toBeCloseTo(10, 9);
  // Four regions (the O, the A and the B with their counters as holes, and the dot).
  await expect(page.getByTestId('region-fill')).toHaveCount(4);

  await page.getByRole('button', { name: 'Finish sketch' }).click();
  await expect(page.getByRole('toolbar', { name: 'Sketch' })).toBeHidden();
  const [sketch] = await features(page);
  expect(sketch!.id).toBe('sketch#1');
  // Stored as plain lines, arcs and a circle, with no constraints.
  expect(sketch!.entities).toHaveLength(s.entities.length);
  expect(sketch!.constraints).toEqual([]);

  // Every region, extruded (the Extrude dialog takes all regions of the sketch by default).
  await page.getByTestId('feature-sketch#1').click();
  await openTool(page, 'Extrude');
  await expect(page.getByTestId('field-sketch')).toHaveValue('sketch#1');
  await page.getByTestId('field-distance').fill(String(DEPTH));
  await ok(page);
  const statuses = await regenerated(page);
  for (const [id, status] of Object.entries(statuses)) {
    expect(status, id).toMatchObject({ status: 'ok', errors: [] });
  }
  const area = AREA.O + AREA.A + AREA.B + AREA.dot;
  // Arcs stand in for the O's Beziers within 0.01 mm, over about 220 mm of its outlines.
  const slack = 220 * TOLERANCE * DEPTH;
  const volume = await bodyVolume(page);
  console.log(`svg import: volume ${volume.toFixed(3)} mm3, expected ${(area * DEPTH).toFixed(3)}`);
  expect(Math.abs(volume - area * DEPTH)).toBeLessThan(slack);
  expect(errors).toEqual([]);
});
