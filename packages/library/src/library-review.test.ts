// The review reference a version of main records when an agent's approved branch is merged
// (ADR 0016 decision 11), which `reviewOf` reads back; and the check that a revision named for a
// version is one of the branch's before a file name is made of it.

import { applyCommand, type ManufaktureDocument } from '@manufakture/core';
import { describe, expect, it } from 'vitest';
import {
  DocumentLibrary,
  MAIN_BRANCH,
  MAX_REVIEW_LABEL,
  mergeLabel,
  parseReviewReference,
  parseVersions,
  type BranchProvenance,
  type LogEntry,
  type ReviewReference,
} from './library';
import { newBackend, partDocument, type TestBackend } from './test-fixtures';

let clock = 0;
const now = () => new Date(Date.UTC(2026, 9, 8, 12, 0, clock++));

function library(backend: TestBackend) {
  let n = 0;
  return new DocumentLibrary(backend, { now, locks: null, newId: () => `id-${++n}` });
}

function value<T>(r: { ok: true; value: T } | { ok: false; message: string }): T {
  if (!r.ok) throw new Error(r.message);
  return r.value;
}

function failure(r: { ok: true } | { ok: false; message: string }): string {
  if (r.ok) throw new Error('expected a failure');
  return r.message;
}

const agent: BranchProvenance = {
  origin: 'agent',
  sessionId: 'session-1',
  clientName: 'Some Agent 1.0',
  review: 'open',
};

const renameEntry = (name: string): LogEntry => ({
  cause: 'execute',
  label: 'Rename document',
  command: { type: 'renameDocument', name },
  at: `at ${name}`,
});

/** Main saved twice, and an agent's branch from its head with one change of its own. */
async function withAgentBranch() {
  const backend = newBackend();
  const lib = library(backend);
  await lib.save(partDocument('doc-1', 'R1'));
  await lib.save(partDocument('doc-1', 'R2'), [renameEntry('R2')]);
  const { branch } = value(
    await lib.branchFromRevision('doc-1', {
      version: { name: 'Agent session session-1 start' },
      name: 'Agent session-1',
      provenance: agent,
    }),
  );
  const onBranch = value(await lib.open('doc-1', branch.id)).document;
  const command = {
    type: 'renameFeature',
    partId: 'part#1',
    featureId: 'fillet#1',
    name: 'Round',
  } as const;
  const changed = applyCommand(onBranch, command);
  if (!changed.ok) throw new Error(changed.error.message);
  const doc: ManufaktureDocument = changed.value.document;
  await lib.save(
    doc,
    [{ cause: 'execute', label: 'Rename Fillet 1', command, at: 'x' }],
    branch.id,
  );
  value(await lib.open('doc-1'));
  return { backend, lib, branch };
}

const reference = (over: Partial<ReviewReference> = {}): ReviewReference => ({
  branch: 'branch-1',
  sessionId: 'session-1',
  clientName: 'Some Agent 1.0',
  bundleRevision: 2,
  label: 'Merge "Agent session-1" (session session-1)',
  ...over,
});

describe('review references', () => {
  it('record which review a merge into main came from', async () => {
    const { backend, lib, branch } = await withAgentBranch();
    value(await lib.setBranchReview('doc-1', branch.id, 'approved'));
    const merged = value(await lib.mergeBranch('doc-1', branch.id, MAIN_BRANCH));
    expect(merged.saved?.revision).toBe(3);
    const ref = reference({ branch: branch.id, label: mergeLabel(merged.plan.fromName) });
    const version = value(
      await lib.createVersion('doc-1', { name: 'Reviewed: Agent session-1', review: ref }),
    );
    expect(version).toMatchObject({ revision: 3, review: ref });
    expect(version).not.toHaveProperty('branch');

    // Read back by another library: the version, and what main's head came from.
    const other = library(backend);
    expect(value(await other.listVersions('doc-1')).find((v) => v.id === version.id)).toEqual(
      version,
    );
    expect(value(await other.reviewOf('doc-1'))).toEqual({ version, review: ref });
    expect(value(await other.reviewOf('doc-1', 3))).toEqual({ version, review: ref });
    // Before the merge, main's work was a person's.
    expect(value(await other.reviewOf('doc-1', 2))).toBeNull();
    // A later edit on main still came, last, from that review.
    await lib.save(partDocument('doc-1', 'R4'), [renameEntry('R4')]);
    expect(value(await other.reviewOf('doc-1'))?.version.id).toBe(version.id);
  });

  it('are refused on a version of another branch, and when they do not check', async () => {
    const { lib, branch } = await withAgentBranch();
    expect(
      failure(await lib.createVersion('doc-1', { name: 'V', review: reference() }, branch.id)),
    ).toBe('Only a version of the main branch records a review.');
    for (const bad of [
      reference({ branch: MAIN_BRANCH }),
      reference({ branch: '../x' }),
      reference({ sessionId: '' }),
      reference({ clientName: ' padded' }),
      reference({ clientName: 'bidi ‮' }),
      reference({ clientName: 'x'.repeat(201) }),
      reference({ bundleRevision: 0 }),
      reference({ bundleRevision: 1.5 }),
      reference({ label: '' }),
      reference({ label: 'x'.repeat(MAX_REVIEW_LABEL + 1) }),
      reference({ label: 'new\nline' }),
      'reviewed' as unknown as ReviewReference,
    ]) {
      expect(failure(await lib.createVersion('doc-1', { name: 'V', review: bad }))).toBe(
        'The review reference is invalid.',
      );
    }
    expect(value(await lib.listVersions('doc-1')).every((v) => v.review === undefined)).toBe(true);
  });

  it('keep only the known fields, and a damaged one makes the version list unreadable', () => {
    expect(parseReviewReference({ ...reference(), extra: 1 })).toEqual(reference());
    const version = {
      id: 'v-1',
      name: 'V',
      description: '',
      revision: 1,
      snapshotSha256: 'a'.repeat(64),
      createdAt: '2026-10-08T12:00:00.000Z',
    };
    expect(parseVersions([{ ...version, review: reference() }])).toEqual([
      { ...version, review: reference() },
    ]);
    expect(parseVersions([{ ...version, review: { ...reference(), bundleRevision: -1 } }])).toBe(
      null,
    );
    // Only main's versions carry one.
    expect(parseVersions([{ ...version, branch: 'branch-1', review: reference() }])).toBe(null);
  });

  it('do not survive a .mfk file: a review recorded elsewhere is not one of this library’s', async () => {
    const backend = newBackend();
    const lib = library(backend);
    await lib.save(partDocument('doc-1', 'R1'));
    value(await lib.createVersion('doc-1', { name: 'Reviewed', review: reference() }));
    const exported = value(await lib.exportMfk('doc-1', { versions: true }));
    await lib.remove('doc-1');
    value(await lib.importMfk(exported.bytes));
    const versions = value(await lib.listVersions('doc-1'));
    expect(versions.map((v) => v.name)).toEqual(['Reviewed']);
    expect(versions[0]).not.toHaveProperty('review');
    expect(value(await lib.reviewOf('doc-1'))).toBeNull();
  });
});

describe('a version of a revision that is not the head', () => {
  it('checks the revision is one of the branch’s before any file name is made of it', async () => {
    const backend = newBackend();
    const lib = library(backend);
    await lib.save(partDocument('doc-1', 'R1'));
    await lib.save(partDocument('doc-1', 'R2'), [renameEntry('R2')]);
    const reads: string[] = [];
    const read = backend.read.bind(backend);
    backend.read = (path: string) => {
      reads.push(path);
      return read(path);
    };
    for (const revision of [0, -1, 1.5, 3, Number.NaN, Infinity, 2 ** 53, '1' as unknown]) {
      expect(
        failure(
          await lib.branchFromRevision('doc-1', {
            revision: revision as number,
            version: { name: 'W' },
            name: 'New',
          }),
        ),
      ).toMatch(/no revision/);
    }
    const snapshots = reads.filter((p) => p.includes('/snapshot-'));
    expect(snapshots.every((p) => /\/snapshot-\d{8}\.json$/.test(p))).toBe(true);
    expect(snapshots.some((p) => /snapshot-0*[03]\.json$/.test(p))).toBe(false);
    expect(value(await lib.listVersions('doc-1'))).toEqual([]);
    expect(failure(await lib.reviewOf('doc-1', 0.5))).toMatch(/no revision/);
  });
});
