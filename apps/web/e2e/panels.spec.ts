import { expect, test, type Locator, type Page } from '@playwright/test';
import { openEmpty, regenerated } from './bracket';
import { execute } from './m2-fixtures';

// The editor's side panels: drag their inner edge to resize, collapse them to a rail, and they
// come back the same after a reload. Buttons that put content in the right panel show it: pressed
// while it shows, and opening it expands the panel and scrolls it into view.

const INCH = 25.4;

/** One 24" x 12" plywood panel, so the Cut list button is offered. */
async function oneBoard(page: Page) {
  const c: [number, number][] = [
    [0, 0],
    [24 * INCH, 0],
    [24 * INCH, 12 * INCH],
    [0, 12 * INCH],
  ];
  await execute(
    page,
    {
      type: 'batch',
      commands: [
        {
          type: 'addFeature',
          partId: 'part#1',
          feature: {
            id: 'sketch#1',
            kind: 'sketch',
            name: 'Shelf outline',
            suppressed: false,
            plane: { type: 'plane', origin: [0, 0, 0], normal: [0, 0, 1], xDir: [1, 0, 0] },
            entities: c.map((start, i) => ({
              id: `e${i + 1}`,
              kind: 'line',
              construction: false,
              start,
              end: c[(i + 1) % 4]!,
            })),
            constraints: [],
          },
        },
        {
          type: 'addFeature',
          partId: 'part#1',
          feature: {
            id: 'extension#1',
            kind: 'extension',
            name: 'Shelf',
            suppressed: false,
            extension: 'wood.board',
            schemaVersion: 1,
            operation: 'new',
            dependsOn: ['sketch#1'],
            references: [],
            expressions: {},
            params: { sketch: 'sketch#1', form: 'panel', stock: 'us-ply-23-32' },
          },
        },
      ],
    },
    'Board',
  );
  await regenerated(page);
}

const width = (l: Locator) => l.evaluate((e) => e.getBoundingClientRect().width);

async function dragBy(page: Page, handle: Locator, dx: number) {
  const box = (await handle.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y, { steps: 4 });
  await page.mouse.move(x + dx, y, { steps: 4 });
  await page.mouse.up();
}

test('side panels resize, collapse and are remembered', async ({ page }) => {
  const errors = await openEmpty(page);
  const left = page.getByTestId('panel-left');
  const right = page.getByTestId('panel-right');
  const canvas = page.getByTestId('viewport-canvas');

  const left0 = await width(left);
  const right0 = await width(right);
  const canvas0 = await width(canvas);

  // Dragging an edge toward the viewport widens that panel by as much; the canvas gives it up.
  await dragBy(page, page.getByTestId('panel-left-handle'), 100);
  await dragBy(page, page.getByTestId('panel-right-handle'), -150);
  await expect.poll(() => width(left)).toBeCloseTo(left0 + 100, -1);
  await expect.poll(() => width(right)).toBeCloseTo(right0 + 150, -1);
  await expect.poll(() => width(canvas)).toBeCloseTo(canvas0 - 250, -1);

  // The keyboard resizes too: the handle is a separator.
  const handle = page.getByTestId('panel-right-handle');
  const before = Number(await handle.getAttribute('aria-valuenow'));
  await handle.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(handle).toHaveAttribute('aria-valuenow', String(before + 16));

  // Collapsing leaves a rail; the canvas takes the room, and the content is gone.
  await page.getByTestId('panel-left-toggle').click();
  await expect(page.getByTestId('panel-left-toggle')).toHaveAttribute('aria-expanded', 'false');
  await expect(left.locator('.side-frame-body')).toHaveCount(0);
  await expect.poll(() => width(left)).toBeLessThan(40);
  await expect.poll(() => width(canvas)).toBeGreaterThan(canvas0 - 250 - 16 + left0);

  // After a reload: the left panel still collapsed, the right one at its new width.
  const rightNow = await width(right);
  await page.reload();
  await expect(page.getByTestId('panel-left-toggle')).toHaveAttribute('aria-expanded', 'false', {
    timeout: 90_000,
  });
  await expect.poll(() => width(right)).toBeCloseTo(rightNow, -1);
  await page.getByTestId('panel-left-toggle').click();
  await expect.poll(() => width(left)).toBeCloseTo(left0 + 100, -1);
  expect(errors).toEqual([]);
});

test('the Cut list button is pressed while the cut list shows, and opening it shows it', async ({
  page,
}) => {
  const errors = await openEmpty(page);
  await oneBoard(page);
  const button = page.getByTestId('open-cutlist');
  await expect(button).toHaveAttribute('aria-pressed', 'false');

  // With the right panel collapsed, opening the cut list expands it and brings the list into view.
  await page.getByTestId('panel-right-toggle').click();
  await expect(page.getByTestId('panel-right-toggle')).toHaveAttribute('aria-expanded', 'false');
  await button.click();
  await expect(button).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('panel-right-toggle')).toHaveAttribute('aria-expanded', 'true');
  const list = page.getByRole('complementary', { name: 'Cut list' });
  await expect(list).toBeInViewport();

  // It looks pressed, not just announced as pressed.
  const style = (l: Locator) =>
    l.evaluate((e) => {
      const s = getComputedStyle(e);
      return `${s.backgroundColor} ${s.borderColor}`;
    });
  const pressed = await style(button);
  await expect(page.getByRole('button', { name: 'Print', exact: true })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  expect(pressed).not.toBe(await style(page.getByRole('button', { name: 'Print', exact: true })));

  // Clicking it again closes the list and releases the button.
  await button.click();
  await expect(button).toHaveAttribute('aria-pressed', 'false');
  await expect(list).toBeHidden();
  expect(errors).toEqual([]);
});
