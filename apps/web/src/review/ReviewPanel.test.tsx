import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createModelStore, type ModelStore } from '../model/model';
import { ReviewPanel } from './ReviewPanel';
import type { AgentBranch } from './review';
import {
  PARTS,
  apply,
  measureAsBundle,
  renameLeftOut,
  savedAfterBundle,
  seeded,
  type Seeded,
} from './review.test-fixture';

beforeEach(() => {
  let n = 0;
  vi.stubGlobal(
    'URL',
    Object.assign(URL, {
      createObjectURL: () => `blob:test-${++n}`,
      revokeObjectURL: () => undefined,
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

/** The model as the app's regen of the branch head would have it. */
function modelOf(s: Seeded) {
  const model = createModelStore();
  model.setState({ available: true, generation: 1, document: s.head, parts: PARTS });
  return model;
}

async function panel(
  s: Seeded,
  options: { open?: string; scale?: number; branch?: AgentBranch; model?: ModelStore } = {},
) {
  const onApprove = vi.fn(async () => ({ ok: true as const, label: 'Approve' }));
  const onOpenBranch = vi.fn();
  const branch =
    options.branch ?? ((await s.branches()).find((b) => b.id === s.branch.id) as AgentBranch);
  const view = render(
    <ReviewPanel
      source={s.lib}
      documentId={s.id}
      branch={branch}
      openBranch={options.open ?? s.branch.id}
      model={options.model ?? modelOf(s)}
      measure={measureAsBundle(s.bundle, options.scale ?? 1)}
      onOpenBranch={onOpenBranch}
      onApprove={onApprove}
      onClose={() => undefined}
    />,
  );
  return { view, onApprove, onOpenBranch };
}

describe('ReviewPanel', () => {
  it('shows who made the branch, the agent’s note, the checks and the bundle, and offers Approve', async () => {
    const s = await seeded();
    const { onApprove } = await panel(s);
    expect(screen.getByTestId('review-client').textContent).toBe('Test agent');
    expect(screen.getByTestId('review-state').textContent).toBe('Submitted for review');
    await waitFor(() =>
      expect(screen.getByTestId('review-check-regen').dataset.state).toBe('match'),
    );
    // A bundle a session built: its command list is the log's, and nothing is flagged.
    await waitFor(() =>
      expect(screen.getByTestId('review-check-commands').dataset.state).toBe('match'),
    );
    expect(screen.queryByTestId('review-commands-mismatch')).toBeNull();
    expect(screen.getByTestId('review-note').textContent).toContain('A boss 4 mm tall');
    expect(screen.getByTestId('review-check-stale').textContent).toContain('revision 2');
    await waitFor(() =>
      expect(screen.getByTestId('review-check-merge').textContent).toContain('1 batches apply'),
    );
    const bodies = screen.getByTestId('review-bodies');
    expect(bodies.textContent).toContain('Extrude 1');
    expect(screen.getByTestId('review-items').textContent).toContain(
      'Edited Fillet 1: radius 4 mm to 2 mm',
    );
    // Renders: eight images, each shown once its bytes check out.
    await waitFor(() =>
      expect(
        screen.getAllByRole('img').filter((i) => i.getAttribute('src')?.startsWith('blob:')),
      ).toHaveLength(8),
    );
    // Command JSON is one click away.
    expect(screen.queryByText(/"type":"addFeature"/)).toBeNull();
    fireEvent.click(screen.getAllByTestId('review-command-json')[0]!);
    expect(screen.getByText(/"type":"addFeature"/)).toBeTruthy();

    const approve = screen.getByTestId('review-approve') as HTMLButtonElement;
    await waitFor(() => expect(approve.disabled).toBe(false));
    fireEvent.click(approve);
    await waitFor(() => expect(onApprove).toHaveBeenCalledWith(2, false));
    await waitFor(() =>
      expect(screen.getByTestId('review-outcome').textContent).toContain('Approved and merged'),
    );
  });

  it('shows a mismatch with this app’s regen and does not offer Approve', async () => {
    const s = await seeded();
    await panel(s, { scale: 1.01 });
    await waitFor(() => expect(screen.getByTestId('review-mismatch')).toBeTruthy());
    expect(screen.getByTestId('review-mismatch').textContent).toMatch(
      /volume .* in the bundle, .* here/,
    );
    expect((screen.getByTestId('review-approve') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('review-blockers').textContent).toContain(
      'This app’s regen does not match the bundle.',
    );
  });

  it('asks for the branch to be open before comparing', async () => {
    const s = await seeded();
    const { onOpenBranch } = await panel(s, { open: 'main' });
    expect(screen.getByTestId('review-check-regen').dataset.state).toBe('not-open');
    fireEvent.click(screen.getByTestId('review-open-branch'));
    expect(onOpenBranch).toHaveBeenCalled();
    expect((screen.getByTestId('review-approve') as HTMLButtonElement).disabled).toBe(true);
  });

  it('does not offer Approve for a stale bundle', async () => {
    const s = await seeded();
    await s.lib.open(s.id, s.branch.id);
    await s.lib.save(
      { ...s.head, name: 'Later' },
      [
        {
          cause: 'execute',
          label: 'Rename',
          command: { type: 'renameDocument', name: 'Later' },
          at: 'x',
        },
      ],
      s.branch.id,
    );
    await panel(s);
    await waitFor(() =>
      expect(screen.getByTestId('review-check-stale').textContent).toContain('Stale'),
    );
    expect((screen.getByTestId('review-approve') as HTMLButtonElement).disabled).toBe(true);
  });

  it('stores a comment with Request changes, and Reject closes the branch', async () => {
    const s = await seeded();
    const { view } = await panel(s);
    fireEvent.click(screen.getByTestId('review-request-changes'));
    fireEvent.change(screen.getByTestId('review-comment-input'), {
      target: { value: 'Make the boss 6 mm tall.' },
    });
    fireEvent.click(screen.getByTestId('review-comment-send'));
    await waitFor(() =>
      expect(screen.getByTestId('review-outcome').textContent).toContain('Changes requested'),
    );
    const asked = (await s.branches()).find((b) => b.id === s.branch.id)!;
    expect(asked.provenance).toMatchObject({
      review: 'changes-requested',
      comment: 'Make the boss 6 mm tall.',
    });
    view.unmount();

    await panel(s, { branch: asked as AgentBranch });
    expect(screen.getByTestId('review-comment').textContent).toContain('Make the boss 6 mm tall.');
    expect((screen.getByTestId('review-request-changes') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('review-reject'));
    fireEvent.click(screen.getByTestId('review-reject-confirm'));
    await waitFor(() =>
      expect(screen.getByTestId('review-outcome').textContent).toContain('Rejected'),
    );
    expect((await s.branches()).find((b) => b.id === s.branch.id)?.provenance?.review).toBe(
      'rejected',
    );
  });

  it('renders bundle text as text, never as HTML, and cuts long text', async () => {
    const hostile = '<img src=x onerror="alert(1)"><b>bold</b>';
    const s = await seeded({
      edit: (record) => {
        record.note = `${hostile} ${'n'.repeat(1000)}`;
        const bundle = record.bundle as {
          commands: { batches: { items: { label: string; commands: { summary: string }[] }[] } };
        };
        bundle.commands.batches.items[0]!.label = hostile;
        bundle.commands.batches.items[0]!.commands[0]!.summary = hostile;
      },
    });
    const { view } = await panel(s);
    await waitFor(() => expect(screen.getByTestId('review-batches')).toBeTruthy());
    await waitFor(() => expect(screen.getByTestId('review-commands-mismatch')).toBeTruthy());
    expect(view.container.querySelector('img[src="x"]')).toBeNull();
    expect(view.container.querySelector('b')).toBeNull();
    // The commands shown are the log's; the bundle's text shows only in the differences, as text.
    expect(screen.getByTestId('review-batches').textContent).not.toContain(hostile);
    expect(screen.getByTestId('review-commands-mismatch').textContent).toContain(hostile);
    const note = screen.getByTestId('review-note');
    expect(note.textContent!.length).toBeLessThan(700);
    fireEvent.click(within(note).getByText('Show all'));
    expect(note.textContent).toContain('n'.repeat(1000));
  });

  it('shows the log’s commands, not a bundle’s that leaves out a rename, and blocks Approve', async () => {
    const s = await seeded();
    const head = await renameLeftOut(s);
    const model = createModelStore();
    model.setState({ available: true, generation: 1, document: head, parts: PARTS });
    await panel(s, { model });
    await waitFor(() =>
      expect(screen.getByTestId('review-check-commands').dataset.state).toBe('mismatch'),
    );
    // The command list is the log's: the rename the bundle leaves out is there.
    const batches = screen.getByTestId('review-batches');
    expect(batches.textContent).toContain('Rename a fillet');
    expect(batches.textContent).toContain('Renamed Fillet 1 to Quiet round');
    const flag = screen.getByTestId('review-commands-mismatch');
    expect(flag.textContent).toContain('until the agent rebuilds its bundle');
    expect(flag.textContent).toContain('The bundle lists 1 batch; the branch log has 2.');
    expect(flag.textContent).toContain('"Rename a fillet": in the branch log');
    // Everything else passes: the bundle is not stale and the regen matches.
    await waitFor(() =>
      expect(screen.getByTestId('review-check-regen').dataset.state).toBe('match'),
    );
    expect(screen.getByTestId('review-check-stale').textContent).toContain('revision 3');
    await waitFor(() =>
      expect(screen.getByTestId('review-blockers').textContent).toBe(
        'The bundle’s command list does not match the branch log: the agent must rebuild its bundle.',
      ),
    );
    expect((screen.getByTestId('review-approve') as HTMLButtonElement).disabled).toBe(true);
  });

  it('explains and blocks Approve when the log is longer than the list shows', async () => {
    const s = await seeded();
    const commands = Array.from({ length: 5001 }, (_, i) => ({
      type: 'renameDocument',
      name: `Name ${i}`,
    }));
    const head = await savedAfterBundle(s, { type: 'batch', commands }, 'Many renames');
    const model = createModelStore();
    model.setState({ available: true, generation: 1, document: head, parts: PARTS });
    await panel(s, { model });
    const note = await screen.findByTestId('review-commands-omitted');
    expect(note.textContent).toContain('0 batches and 4 more commands are not shown');
    expect(note.textContent).toContain('Approve would merge them unseen');
    await waitFor(() =>
      expect(screen.getByTestId('review-blockers').textContent).toContain(
        'The branch log is longer than this view lists',
      ),
    );
    expect((screen.getByTestId('review-approve') as HTMLButtonElement).disabled).toBe(true);
  });

  it('says so when the bundle does not read', async () => {
    const s = await seeded({
      edit: (record) => {
        (record.bundle as { scripts: unknown }).scripts = Array(6000).fill(0);
      },
    });
    await panel(s);
    await waitFor(() =>
      expect(screen.getByTestId('review-error').textContent).toContain('too long'),
    );
    expect((screen.getByTestId('review-approve') as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows the scripts the branch head has, and blocks Approve when the bundle shows others', async () => {
    const script = {
      id: 'script#1',
      name: 'Holes',
      language: 'js',
      apiVersion: 1,
      source: 'evil(); // \u202e',
    };
    const s = await seeded({
      edit: (record) => {
        (record.bundle as { scripts: unknown[] }).scripts = [
          {
            scriptId: 'script#1',
            name: 'Holes',
            language: 'javascript',
            apiVersion: 1,
            change: 'added',
            source: 'harmless();',
            truncated: false,
            hiddenCharacters: false,
            features: [],
          },
        ];
      },
    });
    // The head as the review reads it has the script (stored on the branch).
    const command = { type: 'setScript', script } as const;
    const head = apply(s.head, command);
    await s.lib.save(
      head,
      [{ cause: 'execute', label: 'Add script', command: command as never, at: 'x' }],
      s.branch.id,
    );
    // The bundle names revision 2; store it again for the head now so it is not stale.
    const opened = await s.lib.open(s.id, s.branch.id);
    if (!opened.ok) throw new Error(opened.message);
    const stored = await s.lib.reviewBundle(s.id, s.branch.id);
    if (!stored.ok || stored.value === null) throw new Error('no bundle');
    const record = structuredClone(stored.value.record) as {
      revision: number;
      bundle: { key: { headRevision: number } };
    };
    record.revision = opened.value.revision;
    record.bundle.key.headRevision = opened.value.revision;
    await s.lib.storeReviewBundle(s.id, s.branch.id, opened.value.revision, record);
    const model = createModelStore();
    model.setState({ available: true, generation: 1, document: head, parts: PARTS });
    await panel(s, { model });
    await waitFor(() =>
      expect(screen.getByTestId('review-check-scripts').dataset.state).toBe('mismatch'),
    );
    const shown = screen.getByTestId('review-script');
    // The head's source, its hidden character shown as an escape and warned about.
    expect(shown.textContent).toContain('evil(); // \\u{202e}');
    expect(shown.textContent).not.toContain('harmless');
    expect(within(shown).getByTestId('review-script-hidden')).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByTestId('review-blockers').textContent).toContain(
        'The bundle’s scripts are not the branch head’s.',
      ),
    );
    expect((screen.getByTestId('review-approve') as HTMLButtonElement).disabled).toBe(true);
  });

  it('needs an acknowledgement of bodies the bundle left out', async () => {
    const s = await seeded({
      edit: (record) => {
        const m = (record.bundle as { measurements: { bodies: unknown } }).measurements;
        m.bodies = { items: [], omitted: 2 };
      },
    });
    await panel(s);
    const box = (await screen.findByTestId('review-acknowledge')) as HTMLInputElement;
    expect(screen.getByTestId('review-unverified').textContent).toContain(
      'not in the bundle, which left out 2',
    );
    await waitFor(() =>
      expect(screen.getByTestId('review-blockers').textContent).toContain('Acknowledge'),
    );
    const approve = screen.getByTestId('review-approve') as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    fireEvent.click(box);
    await waitFor(() => expect(approve.disabled).toBe(false));
  });

  it('offers Finish approval for an approved branch Main does not record', async () => {
    const s = await seeded();
    const set = await s.lib.setBranchReview(s.id, s.branch.id, 'approved', {
      expected: 'submitted',
    });
    if (!set.ok) throw new Error(set.message);
    const { onApprove } = await panel(s, { branch: set.value as AgentBranch });
    expect(await screen.findByTestId('review-unfinished')).toBeTruthy();
    const approve = screen.getByTestId('review-approve') as HTMLButtonElement;
    expect(approve.textContent).toBe('Finish approval');
    await waitFor(() => expect(approve.disabled).toBe(false));
    fireEvent.click(approve);
    await waitFor(() => expect(onApprove).toHaveBeenCalledWith(2, true));
  });

  it('offers nothing for an approval Main records', async () => {
    const s = await seeded();
    const set = await s.lib.setBranchReview(s.id, s.branch.id, 'approved', {
      expected: 'submitted',
    });
    if (!set.ok) throw new Error(set.message);
    await s.lib.createVersion(s.id, {
      name: 'Approved',
      review: {
        branch: s.branch.id,
        sessionId: 'session-1',
        clientName: 'Test agent',
        bundleRevision: 2,
        label: 'x',
      },
    });
    await panel(s, { branch: set.value as AgentBranch });
    await waitFor(() =>
      expect(screen.getByTestId('review-check-merge').textContent).toContain('apply'),
    );
    expect(screen.queryByTestId('review-unfinished')).toBeNull();
    const approve = screen.getByTestId('review-approve') as HTMLButtonElement;
    expect(approve.textContent).toBe('Approve');
    expect(approve.disabled).toBe(true);
  });
});
