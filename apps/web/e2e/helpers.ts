import { expect, type Page } from '@playwright/test';

export type Vec3 = [number, number, number];

/** Open a scene and wait until the viewport has its bodies. */
export async function openScene(page: Page, query: string, timeout = 30_000): Promise<void> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`/${query}`);
  await page.waitForFunction(
    () => (window.__manufakture?.viewport.info().bodies.length ?? 0) > 0,
    null,
    {
      timeout,
    },
  );
  await settle(page);
  expect(errors).toEqual([]);
}

/** Wait until layout, size and camera are stable: two frames with nothing animating. */
export async function settle(page: Page): Promise<void> {
  await page.waitForFunction(() => !window.__manufakture!.viewport.info().animating);
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
}

/** Page coordinates of a world point in the current view. */
export function project(page: Page, p: Vec3): Promise<{ x: number; y: number }> {
  return page.evaluate((q) => window.__manufakture!.viewport.projectToClient(q), p);
}

export async function clickWorld(
  page: Page,
  p: Vec3,
  modifiers: ('Shift' | 'Control')[] = [],
): Promise<void> {
  const { x, y } = await project(page, p);
  for (const m of modifiers) await page.keyboard.down(m);
  await page.mouse.click(x, y);
  for (const m of modifiers) await page.keyboard.up(m);
}

/** The selection as `kind name` strings, read from the store. */
export function selection(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    window
      .__manufakture!.selection.getState()
      .selected.map((i) => `${i.kind} ${'name' in i ? String(i.name) : i.id}`),
  );
}
