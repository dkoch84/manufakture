import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { AGENT_REVIEW_PLACEHOLDERS as P, type AgentReviewFixture } from '../src/review/fixture';
import { openEmpty, regenerated } from './bracket';

// Reviewing an agent's branch in History (M8 plan T8.3b), with the real regen worker and the
// browser's storage.
//
// Where the branch comes from: an agent session runs in Node and writes its branch and review
// bundle to its own library; a browser sees it only through the sync server (ADR 0016 decision
// 10), which carries agent branches with provenance only from T8.4b. Until then this spec seeds
// the browser's library directly, with what a real session made: `agent-review.fixture.json`,
// which src/review/agentReviewFixture.test.ts builds with `packages/session` and the bundle
// builder of `packages/review` on the kernel in Node, and checks in (that test fails when the
// fixture no longer matches what they make). The spec makes the M1 bracket Main, makes an agent
// branch from Main's head as a session does (`branchFromRevision` with provenance), saves the
// agent's batch on it exactly as the session logged it, and stores the bundle and its PNGs with
// the branch, its made-up ids replaced by the ones made here. A checked-in fixture rather than a
// session run at test time: the session needs the kernel and the domains in Node, which the
// Playwright runner does not load (opentype.js and the wasm glue are not ESM-clean there), and a
// fixture keeps the e2e as quick as the other History specs.

const FIXTURE = JSON.parse(
  readFileSync(fileURLToPath(new URL('./agent-review.fixture.json', import.meta.url)), 'utf8'),
) as AgentReviewFixture;
const SESSION = 'session-1';
const BRANCH_NAME = `Agent session ${SESSION}`;
const LABEL = `Approve agent session ${SESSION} (${FIXTURE.clientName})`;

/** The library calls this spec makes, beyond the ones `global.d.ts` declares. */
interface ReviewLibrary {
  branchFromRevision(
    id: string,
    options: {
      version: { name: string };
      name: string;
      provenance: { origin: 'agent'; sessionId: string; clientName: string; review: 'open' };
    },
  ): Promise<E2eResult<{ version: { id: string }; branch: { id: string } }>>;
  setBranchReview(
    id: string,
    branch: string,
    review: string,
    options?: { expected?: string },
  ): Promise<E2eResult<unknown>>;
  storeReviewBundle(
    id: string,
    branch: string,
    revision: number,
    record: unknown,
  ): Promise<E2eResult<void>>;
  storeReviewImage(id: string, bytes: Uint8Array): Promise<E2eResult<string>>;
  listBranches(
    id: string,
  ): Promise<E2eResult<{ id: string; provenance?: { review: string; comment?: string } }[]>>;
  open(id: string, branch?: string): Promise<E2eResult<{ revision: number }>>;
}

async function saved(page: Page) {
  await expect(page.getByTestId('save-status')).toHaveText('Saved', { timeout: 15_000 });
}

async function execute(page: Page, command: unknown, label: string): Promise<void> {
  const ok = await page.evaluate(
    ([c, l]) => window.__manufakture!.document.getState().execute(c, l as string).ok,
    [command, label] as const,
  );
  expect(ok, label).toBe(true);
}

/** The names of the features of Main's (or the open branch's) only part studio. */
const featureNames = (page: Page) =>
  page.evaluate(() =>
    window.__manufakture!.document.getState().document.parts[0]!.features.map((f) => f.name),
  );

/**
 * Main is the bracket; the agent branch has the agent's batch and its bundle, submitted, and is
 * open. `edit` changes the stored bundle before it is stored. `extra` is a batch saved on the
 * branch after the agent's, with the bundle then stored for that later head as it is, as an agent
 * with its token could `PUT` it (threat model N-1). Returns the page errors so far and the
 * branch's id.
 */
async function seed(
  page: Page,
  edit?: (record: Record<string, unknown>) => void,
  extra?: { command: unknown; label: string },
): Promise<{ errors: string[]; branchId: string }> {
  const errors = await openEmpty(page);
  const id = await page.evaluate(() => window.__manufakture!.document.getState().document.id);
  await execute(page, { type: 'replaceDocument', document: { ...FIXTURE.base, id } }, 'Bracket');
  await regenerated(page);
  await saved(page);

  const made = await page.evaluate(
    async ([docId, name, session, client]) => {
      const library = window.__manufakture!.library as unknown as ReviewLibrary;
      const r = await library.branchFromRevision(docId!, {
        version: { name: `${name} start` },
        name: name!,
        provenance: { origin: 'agent', sessionId: session!, clientName: client!, review: 'open' },
      });
      if (!r.ok) throw new Error(r.message);
      return { branchId: r.value.branch.id, versionId: r.value.version.id };
    },
    [id, BRANCH_NAME, SESSION, FIXTURE.clientName] as const,
  );
  const branchSelect = page.getByTestId('branch-select');
  await branchSelect.selectOption({ label: BRANCH_NAME });
  await expect(branchSelect.locator('option:checked')).toHaveText(BRANCH_NAME);
  await regenerated(page);
  for (const b of FIXTURE.batches) await execute(page, b.command, b.label);
  await regenerated(page);
  await saved(page);
  const revision = FIXTURE.record.revision + (extra === undefined ? 0 : 1);
  if (extra !== undefined) {
    await execute(page, extra.command, extra.label);
    await regenerated(page);
    await saved(page);
  }

  const record = JSON.parse(
    JSON.stringify(FIXTURE.record)
      .split(P.document)
      .join(id)
      .split(P.branch)
      .join(made.branchId)
      .split(P.baseVersion)
      .join(made.versionId)
      .split(P.session)
      .join(SESSION),
  ) as Record<string, unknown>;
  record.revision = revision;
  (record.bundle as { key: { headRevision: number } }).key.headRevision = revision;
  edit?.(record);
  await page.evaluate(
    async ([docId, branch, rec, images, revision]) => {
      const library = window.__manufakture!.library as unknown as ReviewLibrary;
      const head = await library.open(docId!, branch as string);
      if (!head.ok || head.value.revision !== revision) {
        throw new Error(`The branch head is not revision ${String(revision)}`);
      }
      for (const b64 of Object.values(images as Record<string, string>)) {
        const r = await library.storeReviewImage(
          docId!,
          Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)),
        );
        if (!r.ok) throw new Error(r.message);
      }
      const stored = await library.storeReviewBundle(
        docId!,
        branch as string,
        revision as number,
        rec,
      );
      if (!stored.ok) throw new Error(stored.message);
      const submitted = await library.setBranchReview(docId!, branch as string, 'submitted', {
        expected: 'open',
      });
      if (!submitted.ok) throw new Error(submitted.message);
    },
    [id, made.branchId, record, FIXTURE.images, revision] as const,
  );
  return { errors, branchId: made.branchId };
}

/** Open History and the Review view of the agent branch. */
async function openReview(page: Page, branchId: string) {
  await page.getByTestId('open-history').click();
  const history = page.getByRole('complementary', { name: 'History' });
  const item = history.getByTestId(`agent-branch-${branchId}`);
  await expect(item.getByTestId('agent-branch-state')).toHaveText('Submitted for review');
  await expect(item.getByTestId('agent-branch-client')).toHaveText(FIXTURE.clientName);
  await item.getByTestId('agent-branch-review').click();
  const review = page.getByRole('complementary', { name: 'Review' });
  await expect(review).toBeVisible();
  return { history, review, item };
}

const reviewOf = (page: Page, branchId: string) =>
  page.evaluate(async (branch) => {
    const hooks = window.__manufakture!;
    const library = hooks.library as unknown as ReviewLibrary;
    const r = await library.listBranches(hooks.document.getState().document.id);
    if (!r.ok) throw new Error(r.message);
    return r.value.find((b) => b.id === branch)?.provenance ?? null;
  }, branchId);

test('an agent branch is reviewed in History and approved into Main as one undoable step', async ({
  page,
}) => {
  test.setTimeout(300_000);
  const { errors, branchId } = await seed(page);
  await expect(page.getByTestId('branch-agent')).toContainText(`session ${SESSION}`);
  await expect(page.getByTestId('branch-agent')).toContainText('Submitted for review');
  const { history, review, item } = await openReview(page, branchId);

  // The bundle: renders side by side (each checked against its SHA-256), measurements, commands.
  await expect(review.getByTestId('review-client')).toHaveText(FIXTURE.clientName);
  await expect(review.getByTestId('review-note')).toContainText('A boss 4 mm tall');
  await expect(review.locator('img.review-image[data-state="ok"]')).toHaveCount(8, {
    timeout: 30_000,
  });
  await expect(review.getByTestId('review-bodies')).toContainText('Extrude 1');
  await expect(review.getByTestId('review-items')).toContainText(
    'Edited Fillet 1: radius 4 mm to 2 mm',
  );
  await review.getByTestId('review-command-json').first().click();
  await expect(review.getByTestId('review-batches')).toContainText('"type":"addFeature"');
  // The commands are the branch log's, replayed here, and the bundle built in a session agrees.
  await expect(review.getByTestId('review-check-commands')).toHaveAttribute('data-state', 'match');
  await expect(review.getByTestId('review-commands-mismatch')).toHaveCount(0);

  // The checks pass: not stale, this app's regen matches, the merge applies everything.
  await expect(review.getByTestId('review-check-stale')).toContainText(
    'describes the branch head (revision 2)',
  );
  await expect(review.getByTestId('review-check-regen')).toHaveAttribute('data-state', 'match', {
    timeout: 60_000,
  });
  await expect(review.getByTestId('review-check-merge')).toContainText('1 batches apply');
  const approve = review.getByTestId('review-approve');
  await expect(approve).toBeEnabled();
  await approve.click();

  // Main is open, with the agent's boss, as one step labelled with the session.
  await expect(review.getByTestId('review-outcome')).toContainText('Approved and merged', {
    timeout: 60_000,
  });
  const branchSelect = page.getByTestId('branch-select');
  await expect(branchSelect.locator('option:checked')).toHaveText('Main');
  await regenerated(page);
  expect(await featureNames(page)).toContain('Boss');
  await expect(review.getByTestId('review-state')).toHaveText('Approved');
  await expect(item.getByTestId('agent-branch-state')).toHaveText('Approved');
  await expect(history.getByTestId(`version-Approved: ${BRANCH_NAME}`)).toBeVisible();
  expect((await reviewOf(page, branchId))?.review).toBe('approved');
  await saved(page);

  await review.getByRole('button', { name: 'Close review' }).click();
  const undo = page.getByRole('button', { name: 'Undo', exact: true });
  await expect(undo).toHaveAttribute('title', new RegExp(LABEL.replace(/[()]/g, '\\$&')));
  await undo.click();
  await regenerated(page);
  expect(await featureNames(page)).not.toContain('Boss');
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await regenerated(page);
  expect(await featureNames(page)).toContain('Boss');
  await saved(page);
  expect(errors).toEqual([]);
});

test('request changes stores the comment for the agent', async ({ page }) => {
  test.setTimeout(300_000);
  const { errors, branchId } = await seed(page);
  const { review, item } = await openReview(page, branchId);
  await review.getByTestId('review-request-changes').click();
  await review.getByTestId('review-comment-input').fill('Make the boss 6 mm tall, please.');
  await review.getByTestId('review-comment-send').click();
  await expect(review.getByTestId('review-outcome')).toContainText('Changes requested');
  await expect(item.getByTestId('agent-branch-state')).toHaveText('Changes requested');
  await expect(review.getByTestId('review-comment')).toContainText('Make the boss 6 mm tall');
  expect(await reviewOf(page, branchId)).toMatchObject({
    review: 'changes-requested',
    comment: 'Make the boss 6 mm tall, please.',
  });
  await expect(review.getByTestId('review-approve')).toBeDisabled();
  expect(errors).toEqual([]);
});

test('a branch changed after its bundle cannot be approved', async ({ page }) => {
  test.setTimeout(300_000);
  const { errors, branchId } = await seed(page);
  // A later change on the branch, after the bundle was made.
  await execute(page, { type: 'renameDocument', name: 'Bracket, later' }, 'Rename document');
  await saved(page);
  const { review } = await openReview(page, branchId);
  await expect(review.getByTestId('review-check-stale')).toContainText('Stale');
  await expect(review.getByTestId('review-approve')).toBeDisabled();
  await expect(review.getByTestId('review-blockers')).toContainText(
    'The branch changed after its bundle was made.',
  );
  expect(errors).toEqual([]);
});

test('a bundle whose measurements disagree with this app’s regen shows the mismatch', async ({
  page,
}) => {
  test.setTimeout(300_000);
  const { errors, branchId } = await seed(page, (record) => {
    const bundle = record.bundle as {
      measurements: { bodies: { items: { head: { volume: number } }[] } };
    };
    bundle.measurements.bodies.items[0]!.head.volume += 1;
  });
  const { review } = await openReview(page, branchId);
  await expect(review.getByTestId('review-check-regen')).toHaveAttribute('data-state', 'mismatch', {
    timeout: 60_000,
  });
  await expect(review.getByTestId('review-mismatch')).toContainText(
    /Extrude 1: volume 14703\.78766 mm³ in the bundle, 14702\.78766 mm³ here/,
  );
  await expect(review.getByTestId('review-approve')).toBeDisabled();
  expect(errors).toEqual([]);
});

test('a bundle whose command list leaves out a rename in the log shows the log’s and blocks Approve', async ({
  page,
}) => {
  test.setTimeout(300_000);
  // The rename is in the branch log; the bundle stored for that head is the one without it.
  const { errors, branchId } = await seed(page, undefined, {
    command: {
      type: 'renameFeature',
      partId: 'part#1',
      featureId: 'fillet#1',
      name: 'Quiet round',
    },
    label: 'Rename a fillet',
  });
  const { review } = await openReview(page, branchId);
  await expect(review.getByTestId('review-check-stale')).toContainText(
    'describes the branch head (revision 3)',
  );
  await expect(review.getByTestId('review-check-commands')).toHaveAttribute(
    'data-state',
    'mismatch',
  );
  await expect(review.getByTestId('review-batches')).toContainText('Rename a fillet');
  await expect(review.getByTestId('review-batches')).toContainText(
    'Renamed Fillet 1 to Quiet round',
  );
  const flag = review.getByTestId('review-commands-mismatch');
  await expect(flag).toContainText('until the agent rebuilds its bundle');
  await expect(flag).toContainText('The bundle lists 1 batch; the branch log has 2.');
  // Everything else passes, so the command list alone blocks Approve.
  await expect(review.getByTestId('review-check-regen')).toHaveAttribute('data-state', 'match', {
    timeout: 60_000,
  });
  await expect(review.getByTestId('review-check-merge')).toContainText('2 batches apply');
  await expect(review.getByTestId('review-blockers')).toHaveText(
    'The bundle’s command list does not match the branch log: the agent must rebuild its bundle.',
  );
  await expect(review.getByTestId('review-approve')).toBeDisabled();
  expect(errors).toEqual([]);
});
