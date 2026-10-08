// Agent branches (docs/plans/agent-surface.md, decision 3 and the headless session model): branch
// provenance in the branch list, review states, and branching from a revision through a version.

import { applyCommand, serialize, type ManufaktureDocument } from '@manufakture/core';
import { describe, expect, it } from 'vitest';
import { sha256Hex } from '@manufakture/io';
import {
  DocumentLibrary,
  MAIN_BRANCH,
  encodeStored,
  MAX_CLIENT_NAME,
  parseProvenance,
  type BranchProvenance,
  type LogEntry,
} from './library';
import { newBackend, partDocument, type TestBackend } from './test-fixtures';

let clock = 0;
const now = () => new Date(Date.UTC(2026, 9, 8, 12, 0, clock++));

function library(backend: TestBackend, ids = 'id') {
  let n = 0;
  return new DocumentLibrary(backend, { now, locks: null, newId: () => `${ids}-${++n}` });
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

const named = (name: string) => partDocument('doc-1', name);

/** Main saved as revisions 1 to `n`, named "R1" to "Rn", each a logged rename. */
async function saved(n: number) {
  const backend = newBackend();
  const lib = library(backend);
  await lib.save(named('R1'));
  for (let r = 2; r <= n; r++) await lib.save(named(`R${r}`), [renameEntry(`R${r}`)]);
  return { backend, lib };
}

/** The branch list file the main head names, as JSON. */
function branchList(backend: TestBackend): { path: string; json: Record<string, unknown> } {
  const head = JSON.parse(
    new TextDecoder().decode(backend.files.get('documents/doc-1/head.json')!),
  ) as { branches: number };
  const path = `documents/doc-1/branches-${String(head.branches).padStart(8, '0')}.json`;
  const json = JSON.parse(new TextDecoder().decode(backend.files.get(path)!)) as Record<
    string,
    unknown
  >;
  return { path, json };
}

describe('branch provenance', () => {
  it('is kept with the branch, read back by another library, and absent on a person’s', async () => {
    const { backend, lib } = await saved(1);
    const v = value(await lib.createVersion('doc-1', { name: 'Start' }));
    const mine = value(await lib.createBranch('doc-1', v.id, 'Mine'));
    expect(mine).not.toHaveProperty('provenance');
    const theirs = value(
      await lib.createBranch('doc-1', v.id, 'Agent', { provenance: { ...agent } }),
    );
    expect(theirs.provenance).toEqual(agent);

    const again = value(await library(backend).listBranches('doc-1'));
    expect(again.map((b) => [b.name, b.provenance ?? null])).toEqual([
      ['Main', null],
      ['Mine', null],
      ['Agent', agent],
    ]);
    // The branch opens like any other.
    expect(value(await library(backend).open('doc-1', theirs.id)).document.name).toBe('R1');
  });

  it('loads a branch list written before provenance existed', async () => {
    const { backend, lib } = await saved(1);
    const v = value(await lib.createVersion('doc-1', { name: 'Start' }));
    const b = value(await lib.createBranch('doc-1', v.id, 'Old'));
    // A list exactly as an older release writes it: four fields per branch.
    const { path, json } = branchList(backend);
    expect(json.branches).toEqual([
      { id: b.id, name: 'Old', fromVersion: v.id, createdAt: b.createdAt },
    ]);
    backend.files.set(path, new TextEncoder().encode(JSON.stringify(json)));
    const listed = value(await library(backend).listBranches('doc-1'));
    expect(listed[1]).toEqual({ id: b.id, name: 'Old', fromVersion: v.id, createdAt: b.createdAt });
  });

  it('sets the review state of an agent branch, and only of one', async () => {
    const { backend, lib } = await saved(1);
    const v = value(await lib.createVersion('doc-1', { name: 'Start' }));
    const person = value(await lib.createBranch('doc-1', v.id, 'Mine'));
    const b = value(await lib.createBranch('doc-1', v.id, 'Agent', { provenance: agent }));
    const changes: string[] = [];
    lib.subscribe((c) => changes.push(c.kind));
    for (const review of ['submitted', 'changes-requested', 'open', 'approved'] as const) {
      expect(value(await lib.setBranchReview('doc-1', b.id, review)).provenance?.review).toBe(
        review,
      );
      const read = value(await library(backend).listBranches('doc-1')).find((x) => x.id === b.id);
      expect(read?.provenance).toEqual({ ...agent, review });
    }
    expect(changes).toEqual(['branches', 'branches', 'branches', 'branches']);
    expect(failure(await lib.setBranchReview('doc-1', person.id, 'approved'))).toMatch(
      /not an agent branch/,
    );
    expect(failure(await lib.setBranchReview('doc-1', MAIN_BRANCH, 'approved'))).toMatch(
      /no such branch/,
    );
    expect(failure(await lib.setBranchReview('doc-1', 'nope', 'approved'))).toMatch(
      /no such branch/,
    );
    expect(
      failure(await lib.setBranchReview('doc-1', b.id, 'merged' as unknown as 'approved')),
    ).toMatch(/no review state "merged"/);
  });

  it('refuses provenance that does not check, before anything is written', async () => {
    const { backend, lib } = await saved(1);
    const v = value(await lib.createVersion('doc-1', { name: 'Start' }));
    const before = [...backend.files.keys()].sort();
    const bad: unknown[] = [
      { ...agent, origin: 'person' },
      { ...agent, sessionId: '../x' },
      { ...agent, sessionId: '' },
      { ...agent, clientName: '' },
      { ...agent, clientName: ' padded ' },
      { ...agent, clientName: 'a\nb' },
      { ...agent, clientName: 'x'.repeat(MAX_CLIENT_NAME + 1) },
      // Unicode Cc (C1 controls too) and Cf (bidi overrides, zero-width marks), lone surrogates.
      { ...agent, clientName: 'a\u0085b' },
      { ...agent, clientName: 'Agent \u202Eexe.txt' },
      { ...agent, clientName: 'Ag\u200Bent' },
      { ...agent, clientName: 'Agent\u2066' },
      { ...agent, clientName: 'Agent \uD800' },
      { ...agent, clientName: '\uDC00 Agent' },
      { ...agent, review: 'merged' },
      { origin: 'agent' },
      null,
    ];
    for (const p of bad) {
      expect(parseProvenance(p)).toBeNull();
      expect(
        failure(
          await lib.createBranch('doc-1', v.id, 'Agent', {
            provenance: p as BranchProvenance,
          }),
        ),
      ).toBe('The branch provenance is invalid.');
    }
    expect([...backend.files.keys()].sort()).toEqual(before);
    expect(parseProvenance({ ...agent, clientName: 'x'.repeat(MAX_CLIENT_NAME) })).not.toBeNull();
    for (const clientName of [
      'Agent \u{1F916}',
      'Zeichner \u00FC 2.0',
      '\u30A8\u30FC\u30B8\u30A7\u30F3\u30C8',
    ]) {
      expect(parseProvenance({ ...agent, clientName })?.clientName).toBe(clientName);
    }
    // Other fields are left out.
    expect(parseProvenance({ ...agent, extra: 1 })).toEqual(agent);
  });

  it('makes a new agent branch only in review state open', async () => {
    const { backend, lib } = await saved(1);
    const v = value(await lib.createVersion('doc-1', { name: 'Start' }));
    const before = [...backend.files.keys()].sort();
    for (const review of ['submitted', 'changes-requested', 'approved', 'rejected'] as const) {
      // Read leniently (a stored branch may be in any state), but never made in one.
      expect(parseProvenance({ ...agent, review })).toEqual({ ...agent, review });
      const message = 'A new agent branch starts in review state "open".';
      expect(
        failure(
          await lib.createBranch('doc-1', v.id, 'Agent', { provenance: { ...agent, review } }),
        ),
      ).toBe(message);
      expect(
        failure(
          await lib.branchFromRevision('doc-1', {
            version: { name: 'W' },
            name: 'Agent',
            provenance: { ...agent, review },
          }),
        ),
      ).toBe(message);
    }
    expect([...backend.files.keys()].sort()).toEqual(before);
  });

  it('never reads a damaged provenance as a person’s branch', async () => {
    const { backend, lib } = await saved(1);
    const v = value(await lib.createVersion('doc-1', { name: 'Start' }));
    const b = value(await lib.createBranch('doc-1', v.id, 'Agent', { provenance: agent }));
    const { path, json } = branchList(backend);
    const branches = json.branches as Record<string, unknown>[];
    for (const provenance of [{ ...agent, review: 'merged' }, 'agent', { origin: 'agent' }]) {
      backend.files.set(
        path,
        new TextEncoder().encode(
          JSON.stringify({ ...json, branches: branches.map((x) => ({ ...x, provenance })) }),
        ),
      );
      const listed = await library(backend).listBranches('doc-1');
      // The list does not read (and has no spare to fall back to), or reads without the branch.
      if (listed.ok) expect(listed.value.some((x) => x.id === b.id && !x.provenance)).toBe(false);
    }
  });
});

describe('branchFromRevision', () => {
  it('branches from main’s head through a version, with provenance', async () => {
    const { backend, lib } = await saved(3);
    const r = value(
      await lib.branchFromRevision('doc-1', {
        version: { name: 'Agent session session-1 start' },
        name: 'Agent session-1',
        provenance: agent,
      }),
    );
    expect(r.version).toMatchObject({ name: 'Agent session session-1 start', revision: 3 });
    expect(r.version).not.toHaveProperty('branch');
    expect(r.branch).toMatchObject({ fromVersion: r.version.id, provenance: agent });
    const other = library(backend);
    expect(value(await other.open('doc-1', r.branch.id)).document.name).toBe('R3');
    expect(value(await other.listVersions('doc-1')).map((v) => v.name)).toEqual([
      'Agent session session-1 start',
    ]);
  });

  it('branches from an older revision, kept or rebuilt, and reads it back later', async () => {
    // Revisions 1 to 5: after the last save, 2 and 3 are no longer kept (1 is the first
    // checkpoint, 4 the spare), so their versions name rebuilt revisions.
    const { backend, lib } = await saved(5);
    const kept = (rev: number) =>
      backend.files.has(`documents/doc-1/snapshot-${String(rev).padStart(8, '0')}.json`);
    expect([1, 2, 3, 4, 5].map(kept)).toEqual([true, false, false, true, true]);
    const expected = new Map<number, string>();
    for (const rev of [1, 2, 3, 4]) {
      expected.set(rev, serialize(value(await lib.readRevision('doc-1', rev)).document));
      const r = value(
        await lib.branchFromRevision('doc-1', {
          revision: rev,
          version: { name: `At ${rev}` },
          name: `From ${rev}`,
        }),
      );
      expect(r.version.revision).toBe(rev);
      expect(serialize(value(await lib.open('doc-1', r.branch.id)).document)).toBe(
        expected.get(rev),
      );
    }
    // More saves on main, then a library that never saw any of it.
    for (const n of [6, 7, 8]) await lib.save(named(`R${n}`), [renameEntry(`R${n}`)]);
    const later = library(backend);
    for (const v of value(await later.listVersions('doc-1'))) {
      const read = value(await later.readVersion('doc-1', v.id));
      expect(serialize(read.document)).toBe(expected.get(v.revision));
    }
  });

  it('writes the snapshot of a rebuilt revision, so its version reads without the log', async () => {
    const { backend, lib } = await saved(5);
    const snapshot = (rev: number) =>
      `documents/doc-1/snapshot-${String(rev).padStart(8, '0')}.json`;
    expect(backend.files.has(snapshot(3))).toBe(false);
    const expected = serialize(value(await lib.readRevision('doc-1', 3)).document);
    const r = value(
      await lib.branchFromRevision('doc-1', {
        revision: 3,
        version: { name: 'At 3' },
        name: 'From 3',
        provenance: agent,
      }),
    );
    // In storage form, with the SHA-256 the version records.
    const bytes = backend.files.get(snapshot(3))!;
    expect(bytes).toBeDefined();
    expect(await sha256Hex(bytes)).toBe(r.version.snapshotSha256);
    expect(new TextDecoder().decode(bytes)).toBe(
      encodeStored(value(await lib.readRevision('doc-1', 3)).document).text,
    );
    // Later saves keep it (a version names it), and the log segments the replay came from go.
    for (const n of [6, 7, 8]) await lib.save(named(`R${n}`), [renameEntry(`R${n}`)]);
    expect(backend.files.has(snapshot(3))).toBe(true);
    for (const rev of [2, 3]) {
      backend.files.delete(`documents/doc-1/log-${String(rev).padStart(8, '0')}.json`);
    }
    const read = value(await library(backend).readVersion('doc-1', r.version.id));
    expect(serialize(read.document)).toBe(expected);
  });

  it('branches from a revision of another branch', async () => {
    const { lib } = await saved(2);
    const first = value(
      await lib.branchFromRevision('doc-1', { version: { name: 'V' }, name: 'First' }),
    );
    value(await lib.open('doc-1', first.branch.id));
    for (const n of ['B2', 'B3']) {
      await lib.save(named(n), [renameEntry(n)], first.branch.id);
    }
    const r = value(
      await lib.branchFromRevision('doc-1', {
        from: first.branch.id,
        revision: 2,
        version: { name: 'Branch at 2' },
        name: 'Second',
      }),
    );
    expect(r.version).toMatchObject({ branch: first.branch.id, revision: 2 });
    expect(value(await lib.open('doc-1', r.branch.id)).document.name).toBe('B2');
  });

  it('checks the name, provenance and revision before making the version', async () => {
    const { lib } = await saved(2);
    value(await lib.branchFromRevision('doc-1', { version: { name: 'V' }, name: 'Taken' }));
    const versions = () => lib.listVersions('doc-1').then((r) => value(r).length);
    expect(await versions()).toBe(1);
    expect(
      failure(await lib.branchFromRevision('doc-1', { version: { name: 'W' }, name: 'Taken' })),
    ).toMatch(/Taken/);
    expect(
      failure(await lib.branchFromRevision('doc-1', { version: { name: 'W' }, name: ' ' })),
    ).toMatch(/branch name/);
    expect(
      failure(
        await lib.branchFromRevision('doc-1', {
          version: { name: 'W' },
          name: 'New',
          provenance: { ...agent, review: 'x' as 'open' },
        }),
      ),
    ).toBe('The branch provenance is invalid.');
    for (const revision of [0, 3, 1.5, -1]) {
      expect(
        failure(
          await lib.branchFromRevision('doc-1', { revision, version: { name: 'W' }, name: 'New' }),
        ),
      ).toMatch(/no revision/);
    }
    expect(
      failure(
        await lib.branchFromRevision('doc-1', { from: 'nope', version: { name: 'W' }, name: 'N' }),
      ),
    ).toMatch(/no such branch/);
    expect(await versions()).toBe(1);
  });

  it('merges an agent branch from an older revision back into main', async () => {
    const { lib } = await saved(3);
    const r = value(
      await lib.branchFromRevision('doc-1', {
        revision: 2,
        version: { name: 'Start' },
        name: 'Agent',
        provenance: agent,
      }),
    );
    const onBranch = value(await lib.open('doc-1', r.branch.id)).document;
    const changed = applyCommand(onBranch, {
      type: 'renameFeature',
      partId: 'part#1',
      featureId: 'fillet#1',
      name: 'Round',
    });
    if (!changed.ok) throw new Error(changed.error.message);
    const doc: ManufaktureDocument = changed.value.document;
    await lib.save(
      doc,
      [
        {
          cause: 'execute',
          label: 'Rename Fillet 1',
          command: {
            type: 'renameFeature',
            partId: 'part#1',
            featureId: 'fillet#1',
            name: 'Round',
          },
          at: 'x',
        },
      ],
      r.branch.id,
    );
    value(await lib.open('doc-1'));
    const merged = value(await lib.mergeBranch('doc-1', r.branch.id, MAIN_BRANCH));
    expect(merged.plan.fork).toEqual({ branch: MAIN_BRANCH, revision: 2 });
    expect(merged.plan.dropped).toEqual([]);
    const main = value(await lib.open('doc-1')).document;
    expect(main.name).toBe('R3');
    expect(main.parts[0]!.features.find((f) => f.id === 'fillet#1')?.name).toBe('Round');
  });
});
