import type { LogEntry } from '@manufakture/library';
import { describe, expect, it } from 'vitest';
import { createDocumentStore } from '../state/document';
import { approveBranch } from './approve';
import { approvalRecorded } from './review';
import { apply, seeded, type Seeded } from './review.test-fixture';

/** The branch's review state in the library now. */
async function review(s: Seeded) {
  return (await s.branches()).find((b) => b.id === s.branch.id)?.provenance?.review;
}

/** The editor on Main, saving to the library when flushed. */
async function onMain(s: Seeded) {
  const opened = await s.lib.open(s.id);
  if (!opened.ok) throw new Error(opened.message);
  const documents = createDocumentStore(opened.value.document);
  // What is pending, logged as autosave logs it.
  let pending: LogEntry[] = [];
  documents.core.subscribe((event) => {
    if (!event.command || event.cause === 'load' || event.cause === 'remote') return;
    pending.push({ cause: event.cause, label: event.label, command: event.command, at: 'now' });
  });
  let opens = 0;
  const deps = {
    source: s.lib,
    documentId: s.id,
    branch: (await s.branches()).find((b) => b.id === s.branch.id) as Seeded['branch'],
    bundleRevision: 2,
    openMain: async () => {
      opens++;
      return null;
    },
    documents,
    flush: async () => {
      await s.lib.save(documents.getState().document, pending);
      pending = [];
      return true;
    },
  };
  return { documents, deps, opens: () => opens };
}

describe('approveBranch', () => {
  it('merges into Main as one undoable step, records the review and approves', async () => {
    const s = await seeded();
    const { documents, deps, opens } = await onMain(s);
    const r = await approveBranch(deps);
    expect(r).toEqual({ ok: true, label: 'Approve agent session session-1 (Test agent)' });
    expect(opens()).toBe(1);
    const features = () => documents.getState().document.parts[0]!.features.map((f) => f.name);
    expect(features()).toContain('Boss');
    expect(documents.getState().undoLabel).toBe('Approve agent session session-1 (Test agent)');
    const branch = (await s.branches()).find((b) => b.id === s.branch.id)!;
    expect(branch.provenance?.review).toBe('approved');
    const reviewed = await s.lib.reviewOf(s.id);
    expect(reviewed.ok && reviewed.value?.review).toEqual({
      branch: s.branch.id,
      sessionId: 'session-1',
      clientName: 'Test agent',
      bundleRevision: 2,
      label: 'Approve agent session session-1 (Test agent)',
    });
    // The bundle stays with the branch.
    const kept = await s.lib.reviewBundle(s.id, s.branch.id);
    expect(kept.ok && kept.value?.revision).toBe(2);
    // One step: undo takes the whole merge back.
    documents.getState().undo();
    expect(features()).not.toContain('Boss');
    expect(documents.getState().document).toEqual(s.base);
  });

  it('refuses a branch written after its bundle, and changes nothing', async () => {
    const s = await seeded();
    await s.lib.open(s.id, s.branch.id);
    const later = apply(s.head, { type: 'renameDocument', name: 'Later' });
    await s.lib.save(
      later,
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
    const { documents, deps } = await onMain(s);
    const before = documents.getState().document;
    expect(await approveBranch(deps)).toEqual({
      ok: false,
      message: 'Not approved: the branch changed after its bundle was made.',
    });
    expect(documents.getState().document).toBe(before);
    expect((await s.branches()).find((b) => b.id === s.branch.id)?.provenance?.review).toBe(
      'submitted',
    );
  });

  it('refuses when the state changed meanwhile, or when a change would be dropped', async () => {
    const changed = await seeded({ submit: false });
    const a = await onMain(changed);
    const r = await approveBranch(a.deps);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toMatch(/^Not approved: The branch is open, not submitted/);
    expect(a.documents.getState().canUndo).toBe(false);

    // Main deletes the fillet the agent edited: that edit would not apply.
    const dropped = await seeded();
    const main = apply(dropped.base, {
      type: 'deleteFeature',
      partId: 'part#1',
      featureId: 'fillet#1',
    });
    await dropped.lib.open(dropped.id);
    await dropped.lib.save(main, [
      {
        cause: 'execute',
        label: 'Delete Fillet 1',
        command: { type: 'deleteFeature', partId: 'part#1', featureId: 'fillet#1' },
        at: 'x',
      },
    ]);
    const b = await onMain(dropped);
    const refused = await approveBranch(b.deps);
    expect(!refused.ok && refused.message).toMatch(/would not apply on Main/);
    expect(
      (await dropped.branches()).find((x) => x.id === dropped.branch.id)?.provenance?.review,
    ).toBe('submitted');
  });

  it('sets the branch back to submitted when the merge cannot run', async () => {
    const s = await seeded();
    const { documents, deps } = await onMain(s);
    const before = documents.getState().document;
    documents.setState({
      execute: () => ({ ok: false, error: { message: 'The merge broke.' } }) as never,
    });
    expect(await approveBranch(deps)).toEqual({
      ok: false,
      message: 'Not approved: It cannot be merged into Main: The merge broke.',
    });
    expect(documents.getState().document).toBe(before);
    expect(await review(s)).toBe('submitted');
    expect(await approvalRecorded(s.lib, s.id, s.branch.id)).toBe(false);
  });

  it('when Main cannot be saved, keeps the branch approved and lets Finish approval record it', async () => {
    const s = await seeded();
    const { documents, deps } = await onMain(s);
    let saves = 0;
    const r = await approveBranch({
      ...deps,
      flush: async () => {
        if (saves++ === 0) return false;
        return deps.flush();
      },
    });
    expect(!r.ok && r.message).toMatch(/^Approved and merged, but Main could not be saved yet/);
    expect(await review(s)).toBe('approved');
    expect(await approvalRecorded(s.lib, s.id, s.branch.id)).toBe(false);
    // The merge is in the editor already: finishing does not merge it twice.
    const steps = () => documents.getState().document.parts[0]!.features.length;
    const merged = steps();
    const finished = await approveBranch({
      ...deps,
      branch: (await s.branches()).find((b) => b.id === s.branch.id) as Seeded['branch'],
      flush: deps.flush,
      finishing: true,
    });
    expect(finished).toEqual({ ok: true, label: 'Approve agent session session-1 (Test agent)' });
    expect(steps()).toBe(merged);
    expect(await approvalRecorded(s.lib, s.id, s.branch.id)).toBe(true);
    const saved = await s.lib.open(s.id);
    expect(saved.ok && saved.value.document.parts[0]!.features.map((f) => f.name)).toContain(
      'Boss',
    );
  });

  it('when the review cannot be recorded, Finish approval records it later', async () => {
    const s = await seeded();
    const { deps } = await onMain(s);
    const r = await approveBranch({
      ...deps,
      source: {
        open: (...a: Parameters<typeof s.lib.open>) => s.lib.open(...a),
        previewMerge: (...a: Parameters<typeof s.lib.previewMerge>) => s.lib.previewMerge(...a),
        setBranchReview: (...a: Parameters<typeof s.lib.setBranchReview>) =>
          s.lib.setBranchReview(...a),
        listVersions: (...a: Parameters<typeof s.lib.listVersions>) => s.lib.listVersions(...a),
        readLog: (...a: Parameters<typeof s.lib.readLog>) => s.lib.readLog(...a),
        createVersion: async () => ({ ok: false as const, message: 'The disk is full' }),
      },
    });
    expect(!r.ok && r.message).toMatch(
      /^Approved and merged, but the review could not be recorded/,
    );
    expect(await review(s)).toBe('approved');
    // Main has the merge, saved: finishing merges nothing and records the review.
    const again = await onMain(s);
    const finished = await approveBranch({ ...again.deps, finishing: true });
    expect(finished.ok).toBe(true);
    expect(again.documents.getState().canUndo).toBe(false);
    expect(await approvalRecorded(s.lib, s.id, s.branch.id)).toBe(true);
  });

  it('finishes an approval the tab closed on before the merge was saved', async () => {
    const s = await seeded();
    // Approved, then the tab closed: Main never got the merge.
    const set = await s.lib.setBranchReview(s.id, s.branch.id, 'approved', {
      expected: 'submitted',
    });
    expect(set.ok).toBe(true);
    const { documents, deps } = await onMain(s);
    // Approve proper refuses (the branch is not submitted); finishing merges and records.
    const refused = await approveBranch(deps);
    expect(!refused.ok && refused.message).toMatch(/^Not approved: The branch is approved/);
    expect(documents.getState().canUndo).toBe(false);
    const finished = await approveBranch({ ...deps, finishing: true });
    expect(finished.ok).toBe(true);
    expect(documents.getState().undoLabel).toBe('Approve agent session session-1 (Test agent)');
    expect(await approvalRecorded(s.lib, s.id, s.branch.id)).toBe(true);
    expect(await review(s)).toBe('approved');
    // Finishing a branch that is not approved is refused.
    const other = await seeded();
    const b = await onMain(other);
    const r = await approveBranch({ ...b.deps, finishing: true });
    expect(!r.ok && r.message).toMatch(/^Not finished: The branch is submitted, not approved/);
  });
});
