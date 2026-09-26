import { expect, test } from '@playwright/test';
import { clickWorld, openScene, project, selection, settle } from './helpers';

// The test scene is a 40 x 30 x 20 box from (-20, -15, 0) to (20, 15, 20),
// named like the naming layer would: faces `test-box/<side>`, edges after
// their two faces. It needs no kernel. The default view is iso, from the
// front right top, so the front, right and top faces are visible.

test.describe('picking in the test scene', () => {
  test.beforeEach(async ({ page }) => {
    await openScene(page, '?scene=test');
  });

  test('clicking a face selects its name, not an index', async ({ page }) => {
    await clickWorld(page, [0, 0, 20]);
    expect(await selection(page)).toEqual(['face test-box/top']);
    await expect(page.locator('[data-testid="selected"] li')).toHaveAttribute(
      'data-name',
      'test-box/top',
    );
  });

  test('shift adds, ctrl toggles, a click on empty space clears', async ({ page }) => {
    await clickWorld(page, [0, 0, 20]);
    await clickWorld(page, [0, -15, 10], ['Shift']);
    await clickWorld(page, [20, 0, 10], ['Shift']);
    expect(await selection(page)).toEqual([
      'face test-box/top',
      'face test-box/front',
      'face test-box/right',
    ]);
    await clickWorld(page, [0, -15, 10], ['Control']);
    expect(await selection(page)).toEqual(['face test-box/top', 'face test-box/right']);
    await page.mouse.click(60, 700);
    expect(await selection(page)).toEqual([]);
  });

  test('edges and vertices are picked within a few pixels', async ({ page }) => {
    // The edge between the front and top faces, clicked 3 px below its midpoint.
    const mid = await project(page, [0, -15, 20]);
    await page.mouse.click(mid.x, mid.y + 3);
    expect(await selection(page)).toEqual(['edge test-box/front|top']);

    await clickWorld(page, [20, -15, 20]);
    const [vertex] = await selection(page);
    // Vertices have no name slots yet, so their names are placeholders.
    expect(vertex).toMatch(/^vertex placeholder:vertex:\d+$/);
  });

  test('the selection filter limits what can be picked', async ({ page }) => {
    await page.getByRole('checkbox', { name: 'Edges', exact: true }).uncheck();
    await page.getByRole('checkbox', { name: 'Vertices' }).uncheck();
    await clickWorld(page, [0, -15, 20]);
    const [picked] = await selection(page);
    expect(['face test-box/front', 'face test-box/top']).toContain(picked);
  });

  test('hover highlights and reports what is under the cursor', async ({ page }) => {
    const top = await project(page, [0, 0, 20]);
    await page.mouse.move(top.x, top.y);
    await expect(page.getByTestId('hovered')).toHaveText('face: test-box/top');
    await page.mouse.move(60, 700);
    await expect(page.getByTestId('hovered')).toHaveText('Nothing under the cursor');
  });

  test('hidden faces cannot be picked through the part', async ({ page }) => {
    // The back face's centre is behind the box in the iso view: the click hits a front face.
    await clickWorld(page, [0, 15, 10]);
    const [picked] = await selection(page);
    expect(picked).not.toBe('face test-box/back');
    expect(picked).toMatch(/^face test-box\/(front|right|top)$/);
  });

  test('the view cube turns to the clicked view, and standard views work', async ({ page }) => {
    const canvas = await page.getByTestId('viewport-canvas').boundingBox();
    expect(canvas).not.toBeNull();
    // The cube is 110 px, 12 px from the top right corner; its face centre points at the viewer.
    await page.getByRole('button', { name: 'Front' }).click();
    await settle(page);
    const cubeCentre = { x: canvas!.x + canvas!.width - 12 - 55, y: canvas!.y + 12 + 55 };
    // In the front view, the cube shows its Front face in the middle; click its Top edge band.
    await page.mouse.click(cubeCentre.x, cubeCentre.y - 45);
    await settle(page);
    // Front-top edge region: looking from (0, -1, 1). The top face centre and front face centre
    // are now at the same distance from the screen centre, above and below.
    const top = await project(page, [0, 0, 20]);
    const front = await project(page, [0, -15, 10]);
    expect(top.y).toBeLessThan(front.y);

    await page.getByRole('button', { name: 'Top' }).click();
    await settle(page);
    const centre = await project(page, [0, 0, 20]);
    expect(Math.abs(centre.x - (canvas!.x + canvas!.width / 2))).toBeLessThan(2);
    expect(Math.abs(centre.y - (canvas!.y + canvas!.height / 2))).toBeLessThan(2);
    // Looking down, the front edge (y = -15) is below the back edge on screen.
    const frontEdge = await project(page, [0, -15, 20]);
    const backEdge = await project(page, [0, 15, 20]);
    expect(frontEdge.y).toBeGreaterThan(backEdge.y);
  });

  test('orthographic projection keeps picking correct', async ({ page }) => {
    await page.getByRole('button', { name: 'Perspective' }).click();
    await expect(page.getByRole('button', { name: 'Orthographic' })).toBeVisible();
    await clickWorld(page, [20, 0, 10]);
    expect(await selection(page)).toEqual(['face test-box/right']);
  });

  test('a section plane hides the cut away part from picking', async ({ page }) => {
    // Default section: the Y axis at half height, keeping the back half (y >= 0), so
    // the cut faces the default iso view. The cap is not geometry: it picks nothing.
    await page.getByRole('checkbox', { name: 'On' }).check();
    await settle(page);
    await clickWorld(page, [0, 7, 20]);
    expect(await selection(page)).toEqual(['face test-box/top']);
    await clickWorld(page, [0, -7, 20]); // cut away: the ray passes into the open cut
    expect(await selection(page)).not.toContain('face test-box/top');
    await clickWorld(page, [-10, 0, 10]); // on the cap
    expect(await selection(page)).toEqual([]);
    await page.getByRole('checkbox', { name: 'Flip' }).check();
    await settle(page);
    await clickWorld(page, [0, -7, 20]);
    expect(await selection(page)).toEqual(['face test-box/top']);
  });

  test('the wheel zooms about the model point under the cursor', async ({ page }) => {
    const point: [number, number, number] = [8, -6, 20]; // on the top face
    const before = await project(page, point);
    const zoomBefore = await page.evaluate(() => window.__manufakture!.viewport.info().halfHeight);
    await page.mouse.move(before.x, before.y);
    await page.mouse.wheel(0, -200);
    await settle(page);
    const after = await project(page, point);
    const zoomAfter = await page.evaluate(() => window.__manufakture!.viewport.info().halfHeight);
    expect(zoomAfter).toBeLessThan(zoomBefore);
    expect(Math.hypot(after.x - before.x, after.y - before.y)).toBeLessThan(1.5);
    await page.mouse.wheel(0, 200);
    await settle(page);
    const back = await page.evaluate(() => window.__manufakture!.viewport.info().halfHeight);
    expect(back).toBeCloseTo(zoomBefore, 3);
  });

  test('right drag orbits and middle drag pans (Onshape bindings)', async ({ page }) => {
    // Grab the top face: the grabbed point follows the cursor exactly.
    const point: [number, number, number] = [0, 0, 20];
    const start = await project(page, point);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down({ button: 'middle' });
    await page.mouse.move(start.x + 40, start.y + 20, { steps: 4 });
    await page.mouse.up({ button: 'middle' });
    await settle(page);
    const panned = await project(page, point);
    expect(panned.x - start.x).toBeCloseTo(40, 0);
    expect(panned.y - start.y).toBeCloseTo(20, 0);
    await page.mouse.move(600, 420);

    const corner: [number, number, number] = [20, -15, 0];
    const beforeOrbit = await project(page, corner);
    await page.mouse.down({ button: 'right' });
    await page.mouse.move(700, 450, { steps: 4 });
    await page.mouse.up({ button: 'right' });
    await settle(page);
    const afterOrbit = await project(page, corner);
    expect(Math.hypot(afterOrbit.x - beforeOrbit.x, afterOrbit.y - beforeOrbit.y)).toBeGreaterThan(
      20,
    );
    // Navigation drags never select anything.
    expect(await selection(page)).toEqual([]);
  });
});
