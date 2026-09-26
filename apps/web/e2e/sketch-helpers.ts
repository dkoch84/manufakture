import { expect, type Page } from '@playwright/test';
import { settle } from './helpers';

export type Vec2 = [number, number];

/** Start a new sketch on a datum plane or the selected face, and wait until it is solved. */
export async function newSketch(
  page: Page,
  plane: 'Top (XY)' | 'Front (XZ)' | 'Right (YZ)' | 'Selected face',
): Promise<void> {
  await page.getByRole('button', { name: 'New sketch' }).click();
  await page.getByRole('menuitem', { name: plane }).click();
  await expect(page.getByRole('toolbar', { name: 'Sketch' })).toBeVisible();
  await settle(page);
  await sketchIdle(page);
}

/** Wait until no solve is in flight. */
export async function sketchIdle(page: Page): Promise<void> {
  await page.evaluate(() => window.__manufakture!.sketcher.store.getState().idle());
}

/** Page coordinates of a sketch point. */
export function sketchToClient(page: Page, p: Vec2): Promise<{ x: number; y: number }> {
  return page.evaluate((q) => window.__manufakture!.sketcher.toClient(q), p);
}

export async function clickSketch(page: Page, p: Vec2, modifiers: 'Shift'[] = []): Promise<void> {
  const { x, y } = await sketchToClient(page, p);
  for (const m of modifiers) await page.keyboard.down(m);
  await page.mouse.move(x, y);
  await page.mouse.click(x, y);
  for (const m of modifiers) await page.keyboard.up(m);
}

export async function tool(page: Page, name: string): Promise<void> {
  await page
    .getByRole('toolbar', { name: 'Sketch' })
    .getByRole('button', { name, exact: true })
    .click();
}

/** Draw a corner rectangle between two sketch points. */
export async function rectangle(page: Page, a: Vec2, b: Vec2): Promise<void> {
  await tool(page, 'Rectangle');
  await clickSketch(page, a);
  await clickSketch(page, b);
  await sketchIdle(page);
}

/** Place a dimension on one item (clicked at `on`) with the label at `label`, and type its value. */
export async function dimension(page: Page, on: Vec2, label: Vec2, value: string): Promise<void> {
  await tool(page, 'Dimension');
  await clickSketch(page, on);
  await clickSketch(page, label);
  const input = page.getByTestId('dimension-input');
  await expect(input).toBeFocused();
  await input.fill(value);
  await input.press('Enter');
  await expect(input).toBeHidden();
  await sketchIdle(page);
}

export function sketchState(page: Page) {
  return page.evaluate(() => {
    const s = window.__manufakture!.sketcher.store.getState();
    return {
      entities: s.sketch.entities,
      constraints: s.sketch.constraints,
      status: s.solve?.status ?? null,
      dof: s.solve?.diagnosis.dof ?? null,
      conflicting: s.solve?.diagnosis.conflicting ?? [],
    };
  });
}

export function features(page: Page) {
  return page.evaluate(() => window.__manufakture!.document.getState().document.parts[0]!.features);
}

/** The sketch status bar's state: under, fully, conflict, ... */
export function statusBar(page: Page) {
  return page.getByTestId('sketch-status');
}
