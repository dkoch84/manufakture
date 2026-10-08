import { expect, test, type Page } from '@playwright/test';
import { openEmpty, regenerated } from './bracket';

// The export gate (M8 plan T8.3c) in the app: a box with a CAM setup is saved, and an agent's
// branch is made from it through the library, as a headless session makes one (provenance, review
// state "open"). Opened on that branch, the G-code export dialog says why it exports nothing and
// keeps Save off; once the branch is approved the same dialog exports, and on main it always does.

const XY = { type: 'plane', origin: [0, 0, 0], normal: [0, 0, 1], xDir: [1, 0, 0] } as const;
const mm = (source: number) => ({ source: String(source), lengthUnit: 'mm', angleUnit: 'deg' });
const REFUSAL = "This is an agent's unreviewed branch. Review it in History first.";

/** A `w` x `d` x `h` box from the origin in part studio `partId`: a rectangle on Top, extruded. */
function box(partId: string, w: number, d: number, h: number): unknown[] {
  const corners: [number, number][] = [
    [0, 0],
    [w, 0],
    [w, d],
    [0, d],
  ];
  const ids = ['e1', 'e2', 'e3', 'e4'];
  const sketch = {
    id: 'sketch#1',
    kind: 'sketch',
    name: 'Sketch 1',
    suppressed: false,
    plane: XY,
    entities: corners.map((start, i) => ({
      id: ids[i],
      kind: 'line',
      construction: false,
      start,
      end: corners[(i + 1) % 4],
    })),
    constraints: [
      ...ids.map((id, i) => ({
        id: `k${i + 1}`,
        kind: 'coincident',
        a: { entity: id, at: 'end' },
        b: { entity: ids[(i + 1) % 4], at: 'start' },
      })),
      { id: 'k5', kind: 'horizontal', line: 'e1' },
      { id: 'k6', kind: 'horizontal', line: 'e3' },
      { id: 'k7', kind: 'vertical', line: 'e2' },
      { id: 'k8', kind: 'vertical', line: 'e4' },
      { id: 'k9', kind: 'coincident', a: { entity: 'e1', at: 'start' }, b: { entity: '@origin' } },
      {
        id: 'k10',
        kind: 'distance',
        a: { entity: 'e1', at: 'start' },
        b: { entity: 'e1', at: 'end' },
        value: mm(w),
      },
      {
        id: 'k11',
        kind: 'distance',
        a: { entity: 'e2', at: 'start' },
        b: { entity: 'e2', at: 'end' },
        value: mm(d),
      },
    ],
  };
  const extrude = {
    id: 'extrude#1',
    kind: 'extrude',
    name: 'Extrude 1',
    suppressed: false,
    profile: { sketch: 'sketch#1' },
    operation: 'new',
    extent: { type: 'blind', distance: mm(h) },
    reverse: false,
  };
  return [
    { type: 'addFeature', partId, feature: sketch },
    { type: 'addFeature', partId, feature: extrude },
  ];
}

async function execute(page: Page, command: unknown, label: string): Promise<void> {
  const ok = await page.evaluate(
    ([c, l]) => window.__manufakture!.document.getState().execute(c, l as string).ok,
    [command, label] as const,
  );
  expect(ok, label).toBe(true);
}

/** The library calls this spec makes, beyond the ones `global.d.ts` declares. */
interface AgentLibrary {
  branchFromRevision(
    id: string,
    options: {
      version: { name: string };
      name: string;
      provenance: { origin: 'agent'; sessionId: string; clientName: string; review: 'open' };
    },
  ): Promise<E2eResult<{ branch: { id: string } }>>;
  setBranchReview(id: string, branch: string, review: string): Promise<E2eResult<unknown>>;
}

/** Open the G-code export dialog of the setup shown, and return it. */
async function openExport(page: Page) {
  await page.getByTestId('cam-export').click();
  const dialog = page.getByTestId('cam-export-dialog');
  await expect(dialog).toBeVisible();
  return dialog;
}

test('the G-code export dialog refuses on an agent’s unreviewed branch', async ({ page }) => {
  test.setTimeout(300_000);
  const errors = await openEmpty(page);
  await execute(
    page,
    {
      type: 'batch',
      commands: [{ type: 'renameDocument', name: 'Plate' }, ...box('part#1', 60, 40, 12)],
    },
    'Make the plate',
  );
  await regenerated(page);

  // One tool, a plywood setup and a facing of the stock top.
  await page.getByTestId('open-cam').click();
  await page.getByTestId('cam-open-tools').click();
  await page.getByTestId('cam-use-c3d-201').click();
  await page.getByTestId('cam-tools-close').click();
  await page.getByTestId('cam-add-setup').click();
  await page.getByTestId('cam-setup-material').selectOption('plywood');
  await expect(page.getByTestId('cam-setup-material')).toHaveValue('plywood');
  await page.getByTestId('cam-new-facing').click();
  await page.getByTestId('cam-op-ok').click();
  await expect(page.getByTestId('cam-op-dialog')).toBeHidden();
  await expect(page.getByTestId('save-status')).toHaveText('Saved', { timeout: 15_000 });

  // Main exports.
  let dialog = await openExport(page);
  await expect(page.getByTestId('cam-export-summary')).toBeVisible({ timeout: 90_000 });
  await expect(dialog.getByTestId('export-gate-refusal')).toHaveCount(0);
  await expect(page.getByTestId('cam-export-save')).toBeEnabled();
  await page.getByTestId('cam-export-close').click();

  // An agent's branch of main's head, made through the library as a session makes it.
  const branchId = await page.evaluate(async () => {
    const hooks = window.__manufakture!;
    const id = hooks.document.getState().document.id;
    const library = hooks.library as unknown as AgentLibrary;
    const r = await library.branchFromRevision(id, {
      version: { name: 'Agent session session-1 start' },
      name: 'Agent session-1',
      provenance: {
        origin: 'agent',
        sessionId: 'session-1',
        clientName: 'Test agent',
        review: 'open',
      },
    });
    if (!r.ok) throw new Error(r.message);
    return r.value.branch.id;
  });
  const branchSelect = page.getByTestId('branch-select');
  await expect(branchSelect.locator('option')).toHaveText(['Main', 'Agent session-1']);
  await branchSelect.selectOption({ label: 'Agent session-1' });
  await expect(branchSelect.locator('option:checked')).toHaveText('Agent session-1');
  await regenerated(page);

  // On the agent's branch: the dialog says why, assembles no job, and Save stays off.
  dialog = await openExport(page);
  await expect(dialog.getByTestId('export-gate-refusal')).toHaveText(REFUSAL);
  await expect(page.getByTestId('cam-op-status-facing#1')).toHaveAttribute('data-state', 'ok', {
    timeout: 60_000,
  });
  await expect(page.getByTestId('cam-export-summary')).toHaveCount(0);
  await expect(page.getByTestId('cam-export-save')).toBeDisabled();
  await expect(page.getByTestId('cam-export-save-sheet')).toBeDisabled();

  // Submitted for review it is still refused; approved, the same dialog exports.
  const review = (state: string) =>
    page.evaluate(
      async ([b, s]) => {
        const hooks = window.__manufakture!;
        const library = hooks.library as unknown as AgentLibrary;
        const r = await library.setBranchReview(hooks.document.getState().document.id, b!, s!);
        if (!r.ok) throw new Error(r.message);
      },
      [branchId, state] as const,
    );
  await review('submitted');
  await expect(dialog.getByTestId('export-gate-refusal')).toHaveText(REFUSAL);
  await review('approved');
  await expect(dialog.getByTestId('export-gate-refusal')).toHaveCount(0);
  await expect(page.getByTestId('cam-export-summary')).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId('cam-export-save')).toBeEnabled();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('cam-export-save').click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/\.nc$/);

  expect(errors).toEqual([]);
});
