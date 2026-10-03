// The verifier's parser ships no types; its declarations live with the cam package's post tests.
// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="../../../packages/cam/src/post/gcode-toolpath.d.ts" />
import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { findBuiltinTool, findMachine } from '@manufakture/cam/library';
import { strFromU8, unzipSync } from 'fflate';
import { CARBIDE_MOTION_DIALECT } from '../../../packages/cam/src/post/carbide-motion';
import { GRBL_DIALECT } from '../../../packages/cam/src/post/grbl';
import type { Dialect, ToolChangeStyle } from '../../../packages/cam/src/post/dialect';
import { verifyGcode, type VerifyTool } from '../../../packages/cam/test/verify-gcode';
import { BRACKET, buildBracket, openEmpty, view } from './bracket';
import { clickWorld } from './helpers';

// G-code export and the setup sheet (M5 plan, T5.4e), through the UI and the real regen and CAM
// workers, on the fixture job of cam-preview.spec.ts with a second tool: the M1 bracket in
// plywood on the default machine (the Shapeoko 5 Pro 4x4 with its default post, Carbide Motion),
// a facing of the whole stock top with the #201 1/4" flat end mill and a 3 mm profile around the
// upright's top face with the #102 1/8" flat end mill. Nothing is generated beforehand: Export
// generates first. The saved files are read back and checked with the G-code verifier (T5.4d):
// one Carbide Motion file with an M6 at each tool change, then Grbl's one file per tool (a zip
// with the setup sheet). The setup sheet lists both tool changes. An operation with an error
// (the profile made an inside one with a tool too wide for the face) refuses the export.

const machine = findMachine('shapeoko-5-pro-4x4')!;
const TRAVEL: [number, number, number] = [
  machine.travel.x.value,
  machine.travel.y.value,
  machine.travel.z.value,
];
const IN = 25.4;
const tool = (id: string): VerifyTool => {
  const t = findBuiltinTool(id)!;
  return { number: t.vendor!.number!, name: t.name, diameter: t.diameter * IN };
};
const T201 = tool('c3d-201');
const T102 = tool('c3d-102');
/**
 * The stock in WCS coordinates: the bracket's 50 x 30 x 40 mm box with the new setup's margins
 * (5 mm on every side, 1 mm on top, none below), the origin on its top front-left corner.
 */
const STOCK = { min: [0, 0, -(BRACKET.height + 1)], max: [60, 40, 0] } as const;

function verify(text: string, dialect: Dialect, toolChange: ToolChangeStyle, tools: VerifyTool[]) {
  const report = verifyGcode(text, {
    dialect,
    toolChange,
    stock: STOCK,
    machine: { travel: TRAVEL },
    tools,
  });
  if (!report.ok) throw new Error(report.error.message);
  expect(report.value.issues).toEqual([]);
  return report.value;
}

/** Click Save and return the downloaded file's name and bytes. */
async function save(page: Page): Promise<{ name: string; bytes: Uint8Array }> {
  await expect(page.getByTestId('cam-export-save')).toBeEnabled();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('cam-export-save').click(),
  ]);
  const bytes = new Uint8Array(await readFile(await download.path()));
  return { name: download.suggestedFilename(), bytes };
}

test('G-code export of the fixture job, verified, with its setup sheet', async ({ page }) => {
  test.setTimeout(300_000);
  const errors = await openEmpty(page);
  await buildBracket(page);
  const t = 6;

  // Two tools from the built-in library and a plywood setup on the default machine.
  await page.getByTestId('open-cam').click();
  await page.getByTestId('cam-open-tools').click();
  await page.getByTestId('cam-use-c3d-201').click();
  await expect(page.getByTestId('cam-tool-tool#1')).toContainText('#201');
  await page.getByTestId('cam-use-c3d-102').click();
  await expect(page.getByTestId('cam-tool-tool#2')).toContainText('#102');
  await page.getByTestId('cam-tools-close').click();
  await page.getByTestId('cam-add-setup').click();
  await page.getByTestId('cam-setup-material').selectOption('plywood');
  await expect(page.getByTestId('cam-setup-material')).toHaveValue('plywood');

  // A facing of the stock top (#201), and a 3 mm profile around the upright's top face (#102).
  await page.getByTestId('cam-new-facing').click();
  await page.getByTestId('cam-op-ok').click();
  await expect(page.getByTestId('cam-op-dialog')).toBeHidden();
  await page.getByTestId('cam-new-profile').click();
  await view(page, 'iso');
  await clickWorld(page, [t / 2, 0, BRACKET.height]);
  await expect(page.getByTestId('cam-source-0')).toContainText('Face extrude#1:');
  await page.getByTestId('cam-op-tool').selectOption('tool#2');
  await page.getByTestId('cam-field-depthMode').selectOption('blind');
  await page.getByTestId('cam-field-depth').fill('3');
  await page.getByTestId('cam-op-ok').click();
  await expect(page.getByTestId('cam-op-dialog')).toBeHidden();
  for (const id of ['facing#1', 'profile#1']) {
    await expect(page.getByTestId(`cam-op-status-${id}`)).toHaveAttribute('data-state', 'ok', {
      timeout: 60_000,
    });
  }

  // Export: nothing was generated, so the dialog generates first, then summarises.
  await page.getByTestId('cam-export').click();
  const dialog = page.getByTestId('cam-export-dialog');
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId('cam-export-summary')).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId('cam-op-status-profile#1')).toHaveAttribute(
    'data-toolpath',
    'generated',
  );
  await expect(page.getByTestId('cam-export-post')).toHaveValue('carbide-motion');
  await expect(page.getByTestId('cam-export-tools').locator('li')).toHaveText([
    /^T201 #201 1\/4" flat end mill: Facing/,
    /^T102 #102 1\/8" flat end mill: Profile/,
  ]);
  await expect(page.getByTestId('cam-export-time')).toContainText(/\d+:\d\d/);
  await expect(page.getByTestId('cam-export-extents')).toContainText('X ');

  // The setup sheet: stock, work zero, both tools and every tool change.
  const sheet = page.frameLocator('[data-testid="cam-export-sheet"]');
  await expect(sheet.locator('[data-sheet="stock"]')).toContainText('60 x 40 x 41 mm');
  await expect(sheet.locator('[data-sheet="stock"]')).toContainText('stock top, front left corner');
  await expect(sheet.locator('[data-sheet="tool-changes"] li')).toHaveText([
    /^Load T201 #201 1\/4" flat end mill for Facing/,
    /^Change to T102 #102 1\/8" flat end mill for Profile/,
  ]);
  await expect(sheet.locator('[data-sheet="tools"] tbody tr')).toHaveCount(2);
  // 3 mm below the face, which is 1 mm under the stock top (the setup's top margin).
  await expect(sheet.locator('[data-operation="profile#1"]')).toContainText('-4 mm');
  await expect(sheet.locator('[data-sheet="zeroing"]')).toContainText('BitSetter');

  // Save: one Carbide Motion file, M6 at each tool change; the verifier finds nothing wrong.
  const cm = await save(page);
  expect(cm.name).toMatch(/ - Setup 1\.nc$/);
  const cmText = strFromU8(cm.bytes);
  const cmReport = verify(cmText, CARBIDE_MOTION_DIALECT, 'm6', [T201, T102]);
  expect(cmReport.toolChanges).toBe(2);
  expect(cmText).toMatch(/^M6 T201$/m);
  expect(cmText).toMatch(/^M6 T102$/m);
  await expect(page.getByTestId('cam-export-saved')).toContainText(cm.name);

  // Grbl, one file per tool: a zip of both files and the setup sheet, each file verified.
  await page.getByTestId('cam-export-post').selectOption('grbl');
  await expect(page.getByTestId('cam-export-multitool')).toHaveValue('files');
  await expect(page.getByTestId('cam-export-files').locator('li')).toHaveCount(2);
  const zip = await save(page);
  expect(zip.name).toMatch(/ - Setup 1\.zip$/);
  const entries = unzipSync(zip.bytes);
  const names = Object.keys(entries);
  expect(names).toHaveLength(3);
  expect(names[0]).toMatch(/ - 1 of 2 - #201 1_4_ flat end mill\.nc$/);
  expect(names[1]).toMatch(/ - 2 of 2 - #102 1_8_ flat end mill\.nc$/);
  expect(names[2]).toMatch(/ - setup sheet\.html$/);
  verify(strFromU8(entries[names[0]!]!), GRBL_DIALECT, 'none', [T201]);
  verify(strFromU8(entries[names[1]!]!), GRBL_DIALECT, 'none', [T102]);
  expect(strFromU8(entries[names[2]!]!)).toContain('data-tool-change="2"');
  await page.getByTestId('cam-export-close').click();
  await expect(dialog).toBeHidden();

  // An inside profile with the 1/4" tool around the 6 mm face: the tool does not fit, and the
  // export refuses, naming the operation and the reason.
  await page.getByRole('button', { name: /^Edit Profile/ }).click();
  await page.getByTestId('cam-op-tool').selectOption('tool#1');
  await page.getByTestId('cam-field-side').selectOption('inside');
  await page.getByTestId('cam-op-ok').click();
  await expect(page.getByTestId('cam-op-dialog')).toBeHidden();
  await page.getByTestId('cam-export').click();
  await expect(page.getByTestId('cam-export-refused')).toContainText(
    /Profile \d+: .*does not fit inside the profile/,
    { timeout: 90_000 },
  );
  await expect(page.getByTestId('cam-export-summary')).toBeHidden();
  await expect(page.getByTestId('cam-export-save')).toBeDisabled();
  await page.getByTestId('cam-export-close').click();
  expect(errors).toEqual([]);
});
