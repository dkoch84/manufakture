import { expect, test } from '@playwright/test';
import { clickWorld, openScene, settle } from './helpers';
import {
  clickSketch,
  dimension,
  features,
  newSketch,
  rectangle,
  sketchIdle,
  sketchState,
  sketchToClient,
  statusBar,
  tool,
} from './sketch-helpers';

// The sketcher on the kernel-free test scene (a 40 x 30 x 20 box standing on
// the origin). The solver runs in its own worker with the real planegcs wasm.
// Sketch coordinates are millimetres in the sketch plane; on Top (XY) they
// are world X and Y.

test.describe('the sketcher', () => {
  test.beforeEach(async ({ page }) => {
    await openScene(page, '?scene=test');
  });

  test('a rectangle with two sides dimensioned is fully constrained', async ({ page }) => {
    await newSketch(page, 'Top (XY)');
    await expect(statusBar(page)).toHaveAttribute('data-state', 'fully'); // an empty sketch

    // The first corner snaps to the origin: coincident with it.
    await rectangle(page, [0, 0], [40, 25]);
    let s = await sketchState(page);
    expect(s.entities.map((e) => e.kind)).toEqual(['line', 'line', 'line', 'line']);
    expect(s.constraints.filter((c) => c.kind === 'coincident')).toHaveLength(5);
    expect(s.dof).toBe(2);
    await expect(statusBar(page)).toHaveAttribute('data-state', 'under');
    await expect(page.getByTestId('sketch-dof')).toHaveText('2 degrees of freedom left');
    await expect(page.getByTestId(`entity-${s.entities[1]!.id}`)).toHaveAttribute(
      'data-status',
      'under',
    );

    // Width on the bottom side, height on the right side.
    await dimension(page, [20, 0], [20, -8], '40');
    await expect(page.getByTestId('sketch-dof')).toHaveText('1 degree of freedom left');
    await dimension(page, [40, 12.5], [48, 12.5], '25');

    await expect(statusBar(page)).toHaveAttribute('data-state', 'fully');
    await expect(page.getByTestId('sketch-dof')).toHaveText('Fully constrained');
    s = await sketchState(page);
    expect(s.dof).toBe(0);
    for (const e of s.entities) {
      await expect(page.getByTestId(`entity-${e.id}`)).toHaveAttribute('data-status', 'fully');
    }
    const dims = s.constraints.filter((c) => c.value);
    expect(dims.map((c) => c.value!.source)).toEqual(['40', '25']);

    await page.getByRole('button', { name: 'Finish sketch' }).click();
    await expect(page.getByRole('toolbar', { name: 'Sketch' })).toBeHidden();
    const [sketch] = await features(page);
    expect(sketch).toMatchObject({ id: 'sketch#1', kind: 'sketch', name: 'Sketch 1' });
    expect(sketch!.entities).toHaveLength(4);
    await expect(page.getByTestId('feature-tree')).toContainText('Sketch 1');
  });

  test('a dimension accepts an expression with units and variables', async ({ page }) => {
    // Until the variables table exists, the variable goes in through the document store.
    const added = await page.evaluate(
      () =>
        window.__manufakture!.document.getState().execute({
          type: 'setVariable',
          name: 't',
          expression: { source: '5 mm', lengthUnit: 'mm', angleUnit: 'deg' },
        }).ok,
    );
    expect(added).toBe(true);
    await newSketch(page, 'Top (XY)');
    await rectangle(page, [0, 0], [30, 15]);

    // 3/4" is an inch fraction: 19.05 mm.
    await tool(page, 'Dimension');
    await clickSketch(page, [15, 0]);
    await clickSketch(page, [15, -8]);
    const input = page.getByTestId('dimension-input');
    await input.fill('3/4" + 5deg');
    await expect(page.getByTestId('dimension-error')).toContainText('length');
    await input.press('Enter');
    await expect(input).toBeVisible(); // refused: still editing
    await input.fill('3/4"');
    await expect(page.getByTestId('dimension-preview')).toHaveText('= 19.05 mm');
    await input.press('Enter');
    await sketchIdle(page);

    // The width is now 19.05 mm, so the right side has moved.
    await dimension(page, [19.05, 7.5], [27, 7.5], '2*#t');
    const s = await sketchState(page);
    expect(s.dof).toBe(0);
    const [width, height] = s.constraints.filter((c) => c.value);
    await expect(page.getByTestId(`dimension-${width!.id}`)).toHaveText('3/4" = 19.05 mm');
    await expect(page.getByTestId(`dimension-${height!.id}`)).toHaveText('2*#t = 10.00 mm');
    const bottom = s.entities[0]!;
    expect(bottom.end![0] - bottom.start![0]).toBeCloseTo(19.05, 6);
    const right = s.entities[1]!;
    expect(right.end![1] - right.start![1]).toBeCloseTo(10, 6);
  });

  test('a conflict is explained and resolved by deleting a constraint', async ({ page }) => {
    await newSketch(page, 'Top (XY)');
    await rectangle(page, [0, 0], [40, 25]);
    await dimension(page, [20, 0], [20, -8], '40');
    await dimension(page, [40, 12.5], [48, 12.5], '25');
    await expect(statusBar(page)).toHaveAttribute('data-state', 'fully');

    // Make the (vertical, 25 mm) right side horizontal as well.
    await tool(page, 'Select');
    await clickSketch(page, [40, 8]);
    await page.getByRole('button', { name: 'Horizontal', exact: true }).click();
    await sketchIdle(page);

    const panel = page.getByTestId('conflict-panel');
    await expect(panel).toBeVisible();
    await expect(statusBar(page)).toHaveAttribute('data-state', 'conflict');
    const s = await sketchState(page);
    const added = s.constraints.at(-1)!;
    expect(added.kind).toBe('horizontal');
    expect(s.conflicting).toContain(added.id);
    // The newest constraint is blamed first, and every conflicting glyph is red.
    await expect(panel.locator('li').first()).toHaveAttribute('data-constraint', added.id);
    await expect(page.getByTestId(`constraint-${added.id}`)).toHaveAttribute(
      'data-state',
      'conflicting',
    );

    await panel
      .locator('li')
      .first()
      .getByRole('button', { name: /^Delete/ })
      .click();
    await sketchIdle(page);
    await expect(panel).toBeHidden();
    await expect(statusBar(page)).toHaveAttribute('data-state', 'fully');
    expect((await sketchState(page)).constraints.map((c) => c.id)).not.toContain(added.id);
  });

  test('committing a sketch is one undoable step, and a sketch can be edited again', async ({
    page,
  }) => {
    await newSketch(page, 'Top (XY)');
    await rectangle(page, [0, 0], [40, 25]);
    await page.getByRole('button', { name: 'Finish sketch' }).click();
    await expect(page.getByTestId('feature-tree')).toContainText('Sketch 1');
    await expect(page.getByTestId('committed-sketches').locator('path')).toHaveCount(4);

    await page.keyboard.press('Control+z');
    expect(await features(page)).toEqual([]);
    await expect(page.getByTestId('feature-tree')).not.toContainText('Sketch 1');
    await page.keyboard.press('Control+y');
    expect((await features(page)).map((f) => f.id)).toEqual(['sketch#1']);

    // Edit it again: add a circle, finish, and undo only that edit.
    await page.getByTestId('feature-sketch#1').dblclick();
    await expect(page.getByTestId('sketch-name')).toHaveText('Sketch 1');
    await settle(page);
    await sketchIdle(page);
    expect((await sketchState(page)).entities).toHaveLength(4);
    await tool(page, 'Circle');
    await clickSketch(page, [20, 12]);
    await clickSketch(page, [25, 12]);
    await sketchIdle(page);
    await page.getByRole('button', { name: 'Finish sketch' }).click();
    await expect(page.getByRole('toolbar', { name: 'Sketch' })).toBeHidden();
    let [sketch] = await features(page);
    expect(sketch!.entities).toHaveLength(5);
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    [sketch] = await features(page);
    expect(sketch!.entities).toHaveLength(4);
  });

  test('dragging an under-constrained point re-solves live', async ({ page }) => {
    await newSketch(page, 'Top (XY)');
    await rectangle(page, [5, 5], [35, 20]);
    const before = await sketchState(page);
    expect(before.dof).toBe(4);

    // Drag the top right corner up and to the right: the rectangle stays a rectangle.
    const from = await sketchToClient(page, [35, 20]);
    const to = await sketchToClient(page, [40, 28]);
    await tool(page, 'Select');
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) {
      await page.mouse.move(from.x + ((to.x - from.x) * i) / 8, from.y + ((to.y - from.y) * i) / 8);
    }
    await page.mouse.up();
    await sketchIdle(page);
    const after = await sketchState(page);
    const [bottom, right, top] = after.entities;
    expect(right!.end![0]).toBeCloseTo(40, 0);
    expect(right!.end![1]).toBeCloseTo(28, 0);
    // Still joined and axis aligned.
    expect(top!.start![0]).toBeCloseTo(right!.end![0], 6);
    expect(bottom!.start![1]).toBeCloseTo(bottom!.end![1], 6);
    expect(right!.start![0]).toBeCloseTo(right!.end![0], 6);

    // One undo step brings the corner back.
    await page.keyboard.press('Control+z');
    await sketchIdle(page);
    const undone = (await sketchState(page)).entities[1]!.end!;
    expect(undone[0]).toBeCloseTo(before.entities[1]!.end![0], 6);
    expect(undone[1]).toBeCloseTo(before.entities[1]!.end![1], 6);
  });

  test('a sketch on a picked planar face lies in that face', async ({ page }) => {
    await clickWorld(page, [0, 0, 20]);
    await newSketch(page, 'Selected face');
    const placement = await page.evaluate(
      () => window.__manufakture!.sketcher.store.getState().source!.placement,
    );
    expect(placement.origin).toEqual([0, 0, 20]);
    expect(placement.normal).toEqual([0, 0, 1]);
    await tool(page, 'Circle');
    await clickSketch(page, [0, 0]);
    await clickSketch(page, [8, 0]);
    await sketchIdle(page);
    const s = await sketchState(page);
    expect(s.entities).toHaveLength(1);
    // The centre snapped to the sketch origin, the face's centre.
    expect(s.constraints.map((c) => c.kind)).toEqual(['coincident']);
    await page.getByRole('button', { name: 'Finish sketch' }).click();
    const [sketch] = await features(page);
    expect(sketch!.plane).toMatchObject({ type: 'plane', origin: [0, 0, 20], normal: [0, 0, 1] });
  });

  test('lines chain with inferred constraints and closed regions fill', async ({ page }) => {
    await newSketch(page, 'Top (XY)');
    await tool(page, 'Line');
    // Slightly off axis: horizontal and vertical are inferred and straightened.
    await clickSketch(page, [0, 0]);
    await clickSketch(page, [30, 0.4]);
    await clickSketch(page, [30.3, 20]);
    await clickSketch(page, [0, 0]); // closes the triangle on the start point
    await sketchIdle(page);
    const s = await sketchState(page);
    expect(s.entities).toHaveLength(3);
    const kinds = s.constraints.map((c) => c.kind);
    expect(kinds.filter((k) => k === 'horizontal')).toHaveLength(1);
    expect(kinds.filter((k) => k === 'vertical')).toHaveLength(1);
    // Straightened to the start of each line, not left where the pointer was.
    expect(s.entities[0]!.end![1]).toBeCloseTo(0, 9);
    expect(s.entities[1]!.end![0]).toBeCloseTo(s.entities[1]!.start![0], 9);
    expect(s.entities[1]!.end![0]).toBeCloseTo(30, 3);
    await expect(page.getByTestId('region-fill')).toHaveCount(1);

    // Shift suppresses snapping and inference.
    await clickSketch(page, [-30, -10.4], ['Shift']);
    await clickSketch(page, [-5, -10.9], ['Shift']);
    await sketchIdle(page);
    const after = await sketchState(page);
    expect(after.entities).toHaveLength(4);
    expect(after.constraints).toHaveLength(s.constraints.length);
    expect(after.entities[3]!.end![1]).toBeCloseTo(-10.9, 1);
  });

  test('a tangent arc continues a line smoothly', async ({ page }) => {
    await newSketch(page, 'Top (XY)');
    await tool(page, 'Line');
    await clickSketch(page, [-20, 10]);
    await clickSketch(page, [0, 10.3]);
    await page.keyboard.press('Escape');
    await tool(page, 'Tangent arc');
    await clickSketch(page, [0, 10]);
    await clickSketch(page, [10, 20]);
    await sketchIdle(page);
    const s = await sketchState(page);
    expect(s.status).toBe('solved');
    const [line, arc] = s.entities;
    expect(arc!.kind).toBe('arc');
    expect(s.constraints.at(-1)).toMatchObject({
      kind: 'tangent',
      a: line!.id,
      b: arc!.id,
      at: ['end', 'start'],
    });
    // The arc leaves the line's end along it: its centre is straight above the joint.
    expect(arc!.center![0]).toBeCloseTo(line!.end![0], 6);
    expect(arc!.start![1]).toBeCloseTo(line!.end![1], 6);
    await expect(statusBar(page)).toHaveAttribute('data-state', 'under');
  });
});
