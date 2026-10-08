import { expect, test, type Page } from '@playwright/test';
import { bodyVolume, openEmpty, regenerated } from './bracket';

// Editing in the script editor's code area (#1199): click into the middle of a line, type, click
// somewhere else, type again; the text goes in at the caret and nothing on screen moves, also
// after a save rebuilds the feature that runs the script. Under the production
// Content-Security-Policy, which refused CodeMirror's injected <style> element: the editor lost
// its layout (line numbers stacked above the code, no indentation), clicks landed on the wrong
// character and the box scrolled under the caret. CodeMirror now sits in a shadow root, where its
// styles are a constructed style sheet (src/scripts/CodeEditor.tsx).

test.use({ bypassCSP: false });

interface Violation {
  directive: string;
  blocked: string;
}

/** Where the caret is: 1-based line and 0-based column, read from the selection in the editor. */
function caret(page: Page): Promise<{ line: number; column: number } | null> {
  return page.evaluate(() => {
    const root = document.querySelector('[data-testid="script-source"]')!
      .shadowRoot as ShadowRoot & {
      getSelection?: () => Selection | null;
    };
    const sel = root.getSelection?.() ?? document.getSelection();
    if (!sel?.focusNode) return null;
    const node = sel.focusNode;
    const line = (node instanceof Element ? node : node.parentElement)?.closest('.cm-line');
    if (!line) return null;
    const lines = [...root.querySelectorAll('.cm-content .cm-line')];
    const range = document.createRange();
    range.setStart(line, 0);
    range.setEnd(node, sel.focusOffset);
    return { line: lines.indexOf(line) + 1, column: range.toString().length };
  });
}

/** A line's text and where it is on screen (its top, rounded). */
function lineAt(page: Page, n: number): Promise<{ text: string; top: number; left: number }> {
  return page.evaluate(
    ({ n }) => {
      const root = document.querySelector('[data-testid="script-source"]')!.shadowRoot!;
      const line = root.querySelectorAll('.cm-content .cm-line')[n - 1]!;
      const box = line.getBoundingClientRect();
      return { text: line.textContent ?? '', top: Math.round(box.top), left: Math.round(box.left) };
    },
    { n },
  );
}

/** Click just past the middle of character `column` (0-based) of line `n`. */
async function clickAt(page: Page, n: number, column: number): Promise<void> {
  const at = await page.evaluate(
    ({ n, column }) => {
      const root = document.querySelector('[data-testid="script-source"]')!.shadowRoot!;
      const line = root.querySelectorAll('.cm-content .cm-line')[n - 1]!;
      // Find the text node and offset that hold the column.
      const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
      let left = column;
      for (let t = walker.nextNode(); t; t = walker.nextNode()) {
        const len = t.textContent!.length;
        if (left < len) {
          const range = document.createRange();
          range.setStart(t, left);
          range.setEnd(t, left + 1);
          const r = range.getBoundingClientRect();
          // Left of the character's middle: the caret goes before it.
          return { x: r.left + r.width * 0.3, y: r.top + r.height / 2 };
        }
        left -= len;
      }
      throw new Error(`no column ${column} on line ${n}`);
    },
    { n, column },
  );
  await page.mouse.click(at.x, at.y);
}

test('click into a line and type: the text goes in at the caret and stays put', async ({
  page,
}) => {
  test.setTimeout(240_000);
  await page.addInitScript(() => {
    const seen: Violation[] = [];
    (window as unknown as { __cspViolations: Violation[] }).__cspViolations = seen;
    document.addEventListener('securitypolicyviolation', (e) => {
      seen.push({ directive: e.effectiveDirective, blocked: e.blockedURI });
    });
  });
  const errors = await openEmpty(page);

  await page.getByTestId('script-new').click();
  const source = page.getByTestId('script-source');
  await expect(source.locator('.cm-content')).toBeVisible();
  await expect(page.getByTestId('script-hint')).toContainText('JavaScript');
  await page.getByTestId('script-name').fill('Box');

  // Laid out as an editor: the line numbers beside the code, level with their lines, and the
  // indentation kept.
  const gutter = (await source.locator('.cm-gutters').boundingBox())!;
  const content = (await source.locator('.cm-content').boundingBox())!;
  expect(gutter.x + gutter.width).toBeLessThanOrEqual(content.x + 1);
  const number3 = (await source
    .locator('.cm-lineNumbers .cm-gutterElement', { hasText: /^3$/ })
    .boundingBox())!;
  const line3 = await lineAt(page, 3);
  expect(Math.abs(number3.y - line3.top)).toBeLessThanOrEqual(2);
  expect(line3.text).toBe("  width: { kind: 'length', default: 40, min: 1, label: 'Width' },");
  await expect(source.locator('.cm-content')).toHaveCSS('white-space', 'pre');

  // Click between the 4 and the 0 of the width's default, and type.
  const column = line3.text.indexOf('40') + 1;
  await clickAt(page, 3, column);
  expect(await caret(page)).toEqual({ line: 3, column });
  const before = { line3: await lineAt(page, 3), line13: await lineAt(page, 13) };
  await page.keyboard.type('5');
  expect(await caret(page)).toEqual({ line: 3, column: column + 1 });
  const typed = await lineAt(page, 3);
  expect(typed.text).toBe("  width: { kind: 'length', default: 450, min: 1, label: 'Width' },");
  expect({ top: typed.top, left: typed.left }).toEqual({
    top: before.line3.top,
    left: before.line3.left,
  });
  expect((await lineAt(page, 13)).top).toBe(before.line13.top);

  // Somewhere else: into the comment on line 1, before "rounded".
  const line1 = await lineAt(page, 1);
  const rounded = line1.text.indexOf('rounded');
  await clickAt(page, 1, rounded);
  expect(await caret(page)).toEqual({ line: 1, column: rounded });
  await page.keyboard.type('big ');
  expect(await caret(page)).toEqual({ line: 1, column: rounded + 4 });
  expect((await lineAt(page, 1)).text).toContain('A box with big rounded vertical edges.');
  expect((await lineAt(page, 1)).top).toBe(line1.top);
  expect((await lineAt(page, 3)).text).toContain('default: 450,');

  // Save it and run it in a feature.
  await page.getByTestId('script-save').click();
  await expect(page.getByTestId('script-save')).toBeDisabled();
  await page.getByTestId('script-close').click();
  await page
    .getByRole('toolbar', { name: 'Features' })
    .getByRole('button', { name: 'Scripted', exact: true })
    .click();
  await page.getByTestId('dialog-ok').click();
  await expect(page.getByTestId('feature-dialog')).toBeHidden();
  expect((await regenerated(page))['scripted#1']!.status).toBe('ok');
  expect(await bodyVolume(page)).toBeGreaterThan(0);
  const generation = () => page.evaluate(() => window.__manufakture!.model.getState().generation);

  // Edit again, between the 3 and the 0 of the depth, and save: the regen that follows changes
  // the part and leaves the caret, the text and its place on screen alone.
  await page.getByRole('button', { name: 'Edit script Box' }).click();
  await expect(source.locator('.cm-content')).toBeVisible();
  const line4 = await lineAt(page, 4);
  const depth = line4.text.indexOf('30') + 1;
  await clickAt(page, 4, depth);
  await page.keyboard.type('5');
  expect(await caret(page)).toEqual({ line: 4, column: depth + 1 });
  const edited = await lineAt(page, 4);
  expect(edited.text).toBe("  depth: { kind: 'length', default: 350, min: 1, label: 'Depth' },");
  expect(edited.top).toBe(line4.top);
  const built = await generation();
  await page.getByTestId('script-save').click();
  await expect(page.getByTestId('script-save')).toBeDisabled();
  // The feature keeps its own parameter values, so the part comes out the same; it is rebuilt.
  await expect.poll(generation).toBeGreaterThan(built);
  expect((await regenerated(page))['scripted#1']!.status).toBe('ok');
  // Saving moved the focus to the button; back in the code, the caret is where it was.
  await source.locator('.cm-content').focus();
  expect(await caret(page)).toEqual({ line: 4, column: depth + 1 });
  expect(await lineAt(page, 4)).toEqual(edited);
  await page.keyboard.type('0');
  expect((await lineAt(page, 4)).text).toContain('default: 3500,');
  expect((await lineAt(page, 4)).top).toBe(line4.top);

  // Keys typed in the code stay there: Ctrl+Z undoes the typing in the code (the two keystrokes
  // since the click are one step), not the document's last step, the save.
  const saved = () =>
    page.evaluate(
      () =>
        (window.__manufakture!.document.getState().document as { scripts?: { source: string }[] })
          .scripts?.[0]?.source,
    );
  expect(await saved()).toContain('default: 350,');
  await page.keyboard.press('Control+z');
  expect((await lineAt(page, 4)).text).toContain('default: 30,');
  expect(await saved()).toContain('default: 350,');
  expect((await regenerated(page))['scripted#1']!.status).toBe('ok');

  const violations = await page.evaluate(
    () => (window as unknown as { __cspViolations: Violation[] }).__cspViolations,
  );
  // zod probes `Function('')` once and falls back (src/hosting/headers.ts).
  expect(violations.filter((v) => !(v.directive === 'script-src' && v.blocked === 'eval'))).toEqual(
    [],
  );
  expect(errors).toEqual([]);
});
