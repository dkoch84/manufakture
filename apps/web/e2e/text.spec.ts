import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, test, type Page } from '@playwright/test';
import {
  addVariable,
  bodyVolume,
  editVariable,
  ok,
  openEmpty,
  openTool,
  regenerated,
  view,
} from './bracket';
import { clickWorld, settle, type Vec3 } from './helpers';
import { execute, saved } from './m2-fixtures';
import { sketchIdle, sketchToClient, tool, type Vec2 } from './sketch-helpers';

// Text through the UI and the real regen worker (M3 plan, T3.2d): a 40 x 30 x 10 block, text
// on its top face debossed 0.6 mm (the volume drops by the letters' area times 0.6), its string
// edited, its size changed through a #size variable, text embossed on a side face, and a reload.
//
// The letters' areas are computed here, independently of the app and of packages/text: each
// glyph's outline is read from the bundled font file with opentype.js and its area integrated
// exactly (Green's theorem over its lines and quadratic Beziers), scaled to the cap height. The
// glyphs of these strings are simple and disjoint, so a text's area is the sum of its glyphs'.

const BLOCK = { w: 40, d: 30, h: 10 };
const DEPTH = 0.6;

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

const textDir = new URL('../../../packages/text/', import.meta.url);
const opentype = createRequire(new URL('package.json', textDir))('opentype.js') as Opentype;
const fontBytes = readFileSync(new URL('fonts/Inter-Bold.ttf', textDir));
const font = opentype.parse(
  fontBytes.buffer.slice(fontBytes.byteOffset, fontBytes.byteOffset + fontBytes.length),
);

/** Twice the signed area a glyph's contours enclose, in font units squared. */
function glyphArea2(commands: readonly FontCommand[]): number {
  let a = 0;
  let start = [0, 0];
  let at = [0, 0];
  const cross = (p: number[], q: number[]) => p[0]! * q[1]! - q[0]! * p[1]!;
  for (const c of commands) {
    const to = [c.x, c.y];
    if (c.type === 'M') {
      start = to;
    } else if (c.type === 'L') {
      a += cross(at, to);
    } else if (c.type === 'Q') {
      const k = [c.x1, c.y1];
      a += (2 * cross(at, k) + 2 * cross(k, to) + cross(at, to)) / 3;
    } else if (c.type === 'Z') {
      a += cross(at, start);
      at = start;
      continue;
    } else {
      throw new Error('Inter Bold has TrueType (quadratic) outlines only');
    }
    at = to;
  }
  return a;
}

/** Square millimetres of `text`'s letters in Inter Bold at cap height `size` mm. */
function textArea(text: string, size: number): number {
  const scale = size / font.tables.os2.sCapHeight;
  let area = 0;
  for (const ch of text) {
    if (ch === ' ') continue;
    area += Math.abs(glyphArea2(font.charToGlyph(ch).path.commands)) / 2;
  }
  return area * scale * scale;
}

function block(): unknown {
  const c: [number, number][] = [
    [-BLOCK.w / 2, -BLOCK.d / 2],
    [BLOCK.w / 2, -BLOCK.d / 2],
    [BLOCK.w / 2, BLOCK.d / 2],
    [-BLOCK.w / 2, BLOCK.d / 2],
  ];
  const mm = (v: number) => ({ source: String(v), lengthUnit: 'mm', angleUnit: 'deg' });
  return {
    type: 'batch',
    commands: [
      {
        type: 'addFeature',
        partId: 'part#1',
        feature: {
          id: 'sketch#1',
          kind: 'sketch',
          name: 'Sketch 1',
          suppressed: false,
          plane: { type: 'plane', origin: [0, 0, 0], normal: [0, 0, 1], xDir: [1, 0, 0] },
          entities: c.map((start, i) => ({
            id: `e${i + 1}`,
            kind: 'line',
            construction: false,
            start,
            end: c[(i + 1) % 4],
          })),
          constraints: [],
        },
      },
      {
        type: 'addFeature',
        partId: 'part#1',
        feature: {
          id: 'extrude#1',
          kind: 'extrude',
          name: 'Block',
          suppressed: false,
          profile: { sketch: 'sketch#1' },
          operation: 'new',
          extent: { type: 'blind', distance: mm(BLOCK.h) },
          reverse: false,
        },
      },
    ],
  };
}

/** The sketch point of the open sketch at world point `p` (the sketch plane's own frame). */
async function sketchPointAt(page: Page, p: Vec3): Promise<Vec2> {
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

/** The open sketch's x axis in the world. */
function sketchXDir(page: Page): Promise<number[]> {
  return page.evaluate(
    () =>
      (
        window.__manufakture!.sketcher.store.getState().source!.placement as unknown as {
          xDir: number[];
        }
      ).xDir,
  );
}

async function selectFace(page: Page, at: Vec3, name: string): Promise<void> {
  await clickWorld(page, at);
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__manufakture!.selection.getState().selected.map((i) => i.name ?? i.id),
      ),
    )
    .toEqual([name]);
}

/** Place a text at world point `p` of the open sketch; resolves when it is drawn (ms taken). */
async function placeText(page: Page, p: Vec3): Promise<number> {
  await tool(page, 'Text');
  const at = await sketchToClient(page, await sketchPointAt(page, p));
  const started = Date.now();
  await page.mouse.move(at.x, at.y);
  await page.mouse.click(at.x, at.y);
  await sketchIdle(page);
  await expect(page.getByTestId('text-panel')).toBeVisible();
  // "Text": four glyphs drawn from the regen worker's layout.
  await expect(page.locator('[data-testid^="text-e"]').first()).toHaveAttribute('data-glyphs', '4');
  return Date.now() - started;
}

/** Type into the text panel's string and wait until the text is drawn with `glyphs` glyphs. */
async function setString(page: Page, text: string, glyphs: number): Promise<number> {
  const field = page.getByTestId('text-string');
  const started = Date.now();
  await field.fill(text);
  await expect(page.locator('[data-testid^="text-e"]').first()).toHaveAttribute(
    'data-glyphs',
    String(glyphs),
  );
  return Date.now() - started;
}

async function finish(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Finish sketch' }).click();
  await expect(page.getByRole('toolbar', { name: 'Sketch' })).toBeHidden();
}

/** Extrude the text regions of sketch `id` by DEPTH: `cut` into the face, or `add` out of it. */
async function extrudeText(page: Page, id: string, operation: 'cut' | 'add'): Promise<void> {
  await page.getByTestId(`feature-${id}`).click();
  await openTool(page, 'Extrude');
  await expect(page.getByTestId('field-sketch')).toHaveValue(id);
  await page.getByTestId('regions-text').check();
  await page.getByTestId('field-operation').selectOption(operation);
  await page.getByTestId('field-distance').fill(String(DEPTH));
  if (operation === 'cut') await page.getByLabel('Opposite direction').check();
  await ok(page);
}

async function allOk(page: Page): Promise<void> {
  const statuses = await regenerated(page);
  for (const [id, s] of Object.entries(statuses)) {
    expect(s, id).toMatchObject({ status: 'ok', errors: [] });
  }
}

test('text on a block: debossed, edited, resized by a variable, embossed on a side, reloaded', async ({
  page,
}) => {
  test.setTimeout(300_000);
  const errors = await openEmpty(page);
  await addVariable(page, 'size', '8 mm');
  await execute(page, block(), 'Make a block');
  await allOk(page);
  const solid = BLOCK.w * BLOCK.d * BLOCK.h;
  expect(await bodyVolume(page)).toBeCloseTo(solid, 6);

  // 1. Text on the top face, debossed 0.6 mm.
  await view(page, 'top');
  await selectFace(page, [5, 5, BLOCK.h], 'extrude#1:cap:end');
  await page.getByRole('button', { name: 'New sketch' }).click();
  await page.getByRole('menuitem', { name: 'Selected face' }).click();
  await expect(page.getByRole('toolbar', { name: 'Sketch' })).toBeVisible();
  await settle(page);
  await sketchIdle(page);
  const cold = await placeText(page, [0, 0, BLOCK.h]);
  // The new text's string is selected in the panel: typing replaces it.
  await expect(page.getByTestId('text-string')).toBeFocused();
  const warm = await setString(page, 'OK', 2);
  await page.getByTestId('text-size').fill('#size');
  await page.getByTestId('text-size').press('Enter');
  await sketchIdle(page);
  console.log(`text layout: first ${cold} ms (worker start and font load), typed ${warm} ms`);
  await finish(page);
  await extrudeText(page, 'sketch#2', 'cut');
  await allOk(page);
  const okArea = textArea('OK', 8);
  expect(okArea).toBeGreaterThan(20);
  expect(await bodyVolume(page)).toBeCloseTo(solid - okArea * DEPTH, 3);

  // 2. Edit the string: the volume follows the new letters.
  await page.getByTestId('feature-sketch#2').dblclick();
  await expect(page.getByRole('toolbar', { name: 'Sketch' })).toBeVisible();
  await settle(page);
  await sketchIdle(page);
  // Click the text's letters to select it (the "O", left of the anchor).
  const letter = await sketchToClient(page, await sketchPointAt(page, [-3.5, 0, BLOCK.h]));
  await page.mouse.click(letter.x, letter.y);
  await expect(page.getByTestId('text-panel')).toBeVisible();
  await setString(page, 'OK3', 3);
  await finish(page);
  await allOk(page);
  const ok3Area = textArea('OK3', 8);
  expect(await bodyVolume(page)).toBeCloseTo(solid - ok3Area * DEPTH, 3);

  // 3. A bigger #size: the letters grow with it.
  const resized = Date.now();
  await editVariable(page, 'size', '10 mm');
  await allOk(page);
  console.log(`regen after #size changed: ${Date.now() - resized} ms`);
  const bigArea = textArea('OK3', 10);
  expect(bigArea / ok3Area).toBeCloseTo(1.5625, 6);
  const topVolume = solid - bigArea * DEPTH;
  expect(await bodyVolume(page)).toBeCloseTo(topVolume, 3);

  // 4. Embossed text on the front side face (y = -15), 5 mm high, along the face.
  await view(page, 'front');
  await selectFace(page, [12, -BLOCK.d / 2, BLOCK.h / 2], 'extrude#1:side:e1');
  await page.getByRole('button', { name: 'New sketch' }).click();
  await page.getByRole('menuitem', { name: 'Selected face' }).click();
  await expect(page.getByRole('toolbar', { name: 'Sketch' })).toBeVisible();
  await settle(page);
  await sketchIdle(page);
  await placeText(page, [10, -BLOCK.d / 2, BLOCK.h / 2]);
  await setString(page, 'M3', 2);
  await page.getByTestId('text-size').fill('5');
  await page.getByTestId('text-size').press('Enter');
  // Run the text along the face: turn it when the sketch's x axis is vertical.
  const x = await sketchXDir(page);
  if (Math.abs(x[2]!) > 0.5) {
    await page.getByTestId('text-angle').fill('90');
    await page.getByTestId('text-angle').press('Enter');
  }
  await sketchIdle(page);
  await finish(page);
  await extrudeText(page, 'sketch#3', 'add');
  await allOk(page);
  const sideArea = textArea('M3', 5);
  const finalVolume = topVolume + sideArea * DEPTH;
  expect(await bodyVolume(page)).toBeCloseTo(finalVolume, 3);
  const doc = await page.evaluate(() => window.__manufakture!.document.getState().document);
  expect((doc as unknown as { fonts: unknown[] }).fonts).toEqual([
    {
      id: 'font#1',
      family: 'Inter',
      style: 'Bold',
      source: {
        kind: 'bundled',
        id: 'inter-bold',
        sha256: '288316099b1e0a47a4716d159098005eef7c0066921f34e3200393dbdb01947f',
      },
    },
  ]);

  // 5. Reload: read back from storage and regenerated, the same volume.
  await saved(page);
  await page.reload();
  await allOk(page);
  await page.waitForFunction(() => window.__manufakture!.viewport.info().bodies.length > 0);
  expect(await bodyVolume(page)).toBeCloseTo(finalVolume, 3);
  // The committed sketches draw their texts as regen placed them.
  await expect(page.locator('path[data-text="true"]')).not.toHaveCount(0);
  expect(errors).toEqual([]);
});
