// Branches in the document library: each branch has its own head, snapshots and log under
// `branches/<id>/`, the main branch stays in the document's directory, and every branch change
// is committed by the main head. Crash safety is checked per branch: a crash on one branch
// leaves every other one byte for byte as it was.

import { describe, expect, it } from 'vitest';
import { MemoryBackend } from './backend';
import {
  BranchDeleted,
  DocumentLibrary,
  MAIN_BRANCH,
  RevisionConflict,
  type LogEntry,
} from './library';
import { unpackMfk } from './mfk';
import { CrashingBackend, cloneBackend, partDocument, partWithImport } from './test-fixtures';

let clock = 0;
const now = () => new Date(Date.UTC(2026, 8, 30, 12, 0, clock++));

function library(backend: MemoryBackend | CrashingBackend, ids = 'id') {
  let n = 0;
  return new DocumentLibrary(backend, { now, locks: null, newId: () => `${ids}-${++n}` });
}

function value<T>(r: { ok: true; value: T } | { ok: false; message: string }): T {
  if (!r.ok) throw new Error(r.message);
  return r.value;
}

const renameEntry = (name: string): LogEntry => ({
  cause: 'execute',
  label: 'Rename document',
  command: { type: 'renameDocument', name },
  at: `at ${name}`,
});

const named = (name: string) => partDocument('doc-1', name);

/** The files under `prefix`, with their bytes as text: to check nothing there changed. */
function tree(backend: MemoryBackend, prefix: string, except?: string): Map<string, string> {
  const out = new Map<string, string>();
  const decoder = new TextDecoder();
  for (const [path, bytes] of backend.files) {
    if (!path.startsWith(prefix)) continue;
    if (except && path.startsWith(except)) continue;
    out.set(path, decoder.decode(bytes));
  }
  return out;
}

const MAIN_FILES = (backend: MemoryBackend) =>
  tree(backend, 'documents/doc-1/', 'documents/doc-1/branches/');

/**
 * Main at revision 2 ("Two"), version "A" of revision 1 ("One"), and the branch "Try" (id
 * `b-1`) from it, saved once ("Branch two") so it is at revision 2 with a log.
 */
async function branched() {
  const backend = new MemoryBackend();
  const lib = library(backend, 'v');
  await lib.save(named('One'));
  const a = value(await lib.createVersion('doc-1', { name: 'A' }));
  await lib.save(named('Two'), [renameEntry('Two')]);
  const branchLib = new DocumentLibrary(backend, { now, locks: null, newId: () => 'b-1' });
  const branch = value(await branchLib.createBranch('doc-1', a.id, 'Try'));
  value(await branchLib.open('doc-1', branch.id));
  await branchLib.save(named('Branch two'), [renameEntry('Branch two')], branch.id);
  return { backend, a, branch };
}

describe('branches', () => {
  it('branch from a version: own directory, head and history; main stays where it was', async () => {
    const { backend, a, branch } = await branched();
    expect(branch).toEqual({
      id: 'b-1',
      name: 'Try',
      fromVersion: a.id,
      createdAt: expect.any(String) as string,
    });
    const files = [...backend.files.keys()].sort();
    expect(files).toEqual([
      'documents/doc-1/branches-00000001.json',
      'documents/doc-1/branches/b-1/head.json',
      'documents/doc-1/branches/b-1/log-00000002.json',
      'documents/doc-1/branches/b-1/snapshot-00000001.json',
      'documents/doc-1/branches/b-1/snapshot-00000002.json',
      'documents/doc-1/head.json',
      'documents/doc-1/log-00000002.json',
      'documents/doc-1/snapshot-00000001.json',
      'documents/doc-1/snapshot-00000002.json',
      'documents/doc-1/versions-00000001.json',
    ]);

    const lib = library(backend);
    expect(value(await lib.listBranches('doc-1')).map((b) => [b.id, b.name])).toEqual([
      [MAIN_BRANCH, 'Main'],
      ['b-1', 'Try'],
    ]);
    // Main opens as before, by default; the branch by its id.
    expect(value(await lib.open('doc-1')).document.name).toBe('Two');
    const onBranch = value(await lib.open('doc-1', 'b-1'));
    expect(onBranch).toMatchObject({ revision: 2, recovered: false });
    expect(onBranch.document.name).toBe('Branch two');

    // Each branch's history is its own.
    expect(value(await lib.readHistory('doc-1', MAIN_BRANCH)).map((r) => r.revision)).toEqual([2]);
    expect(value(await lib.readHistory('doc-1', 'b-1'))).toEqual([
      {
        revision: 2,
        entries: [{ cause: 'execute', label: 'Rename document', at: 'at Branch two' }],
      },
    ]);
    expect(value(await lib.readRevision('doc-1', 1, { branch: 'b-1' })).document.name).toBe('One');
    expect(value(await lib.readRevision('doc-1', 2, { branch: 'b-1' })).document.name).toBe(
      'Branch two',
    );
    expect(value(await lib.readRevision('doc-1', 2, { branch: MAIN_BRANCH })).document.name).toBe(
      'Two',
    );
    expect(value(await lib.historyStart('doc-1', 'b-1'))).toBe(1);
    // The document list shows the main branch.
    expect(value(await lib.open('doc-1')).document.name).toBe('Two');
    expect((await lib.list())[0]).toMatchObject({ id: 'doc-1', name: 'Two', revision: 2 });
  });

  it('saves and names versions on the branch given, and records the branch', async () => {
    const { backend } = await branched();
    const lib = library(backend, 'v2');
    value(await lib.open('doc-1', 'b-1'));
    await lib.save(named('Branch three'), [renameEntry('Branch three')], 'b-1');
    const onBranch = value(await lib.createVersion('doc-1', { name: 'B' }, 'b-1'));
    expect(onBranch).toMatchObject({ name: 'B', revision: 3, branch: 'b-1' });
    const onMain = value(await lib.createVersion('doc-1', { name: 'C' }));
    expect(onMain).toMatchObject({ name: 'C', revision: 2 });
    expect(onMain).not.toHaveProperty('branch');

    // Every version without a branch; one branch's with one.
    expect(value(await lib.listVersions('doc-1')).map((v) => v.name)).toEqual(['A', 'B', 'C']);
    expect(value(await lib.listVersions('doc-1', 'b-1')).map((v) => v.name)).toEqual(['B']);
    expect(value(await lib.listVersions('doc-1', MAIN_BRANCH)).map((v) => v.name)).toEqual([
      'A',
      'C',
    ]);
    // A version reads from its own branch, whichever is open.
    expect(value(await lib.readVersion('doc-1', onBranch.id)).document.name).toBe('Branch three');
    expect(value(await lib.readVersion('doc-1', onMain.id)).document.name).toBe('Two');
    expect(value(await library(backend).open('doc-1')).document.name).toBe('Two');
  });

  it('two branches saved alternately keep their own revisions, checkpoints and versions', async () => {
    const { backend } = await branched();
    const main = library(backend, 'm');
    const side = library(backend, 's');
    value(await main.open('doc-1'));
    value(await side.open('doc-1', 'b-1'));
    const mainNames = new Map<number, string>([[2, 'Two']]);
    const sideNames = new Map<number, string>([[2, 'Branch two']]);
    let sideVersion = '';
    for (let i = 3; i <= 140; i++) {
      await main.save(named(`Main ${i}`), [renameEntry(`Main ${i}`)]);
      mainNames.set(i, `Main ${i}`);
      await side.save(named(`Side ${i}`), [renameEntry(`Side ${i}`)], 'b-1');
      sideNames.set(i, `Side ${i}`);
      if (i === 10) {
        sideVersion = value(await side.createVersion('doc-1', { name: 'S10' }, 'b-1')).id;
      }
    }
    const reader = library(backend);
    expect(value(await reader.open('doc-1')).document.name).toBe('Main 140');
    expect(value(await reader.open('doc-1', 'b-1')).document.name).toBe('Side 140');
    for (const rev of [2, 3, 64, 65, 66, 100, 129, 130, 139]) {
      expect(
        value(await reader.readRevision('doc-1', rev, { branch: MAIN_BRANCH })).document.name,
      ).toBe(mainNames.get(rev));
      expect(value(await reader.readRevision('doc-1', rev, { branch: 'b-1' })).document.name).toBe(
        sideNames.get(rev),
      );
    }
    expect(value(await reader.readVersion('doc-1', sideVersion)).document.name).toBe('Side 10');
    // The branch kept its versioned revision and checkpoints, and main did not keep it.
    const kept = (dir: string) =>
      [...backend.files.keys()]
        .map((f) => new RegExp(`^${dir}snapshot-(\\d+)\\.json$`).exec(f)?.[1])
        .filter((r): r is string => r !== undefined)
        .map(Number)
        .sort((x, y) => x - y);
    expect(kept('documents/doc-1/branches/b-1/')).toEqual([1, 10, 65, 129, 139, 140]);
    expect(kept('documents/doc-1/')).toEqual([1, 65, 129, 139, 140]);
  });

  it('an operation given no branch is on main, whichever branch was opened last', async () => {
    const { backend } = await branched();
    const lib = library(backend);
    value(await lib.open('doc-1', 'b-1'));
    await lib.save(named('Main three'), [renameEntry('Main three')]);
    value(await lib.rename('doc-1', 'Main four'));
    const version = value(await lib.createVersion('doc-1', { name: 'M' }));
    expect(version).not.toHaveProperty('branch');
    const exported = value(await lib.exportMfk('doc-1'));
    expect(JSON.parse(unpackMfk(exported.bytes).document)).toMatchObject({ name: 'Main four' });
    const copy = value(await lib.duplicate('doc-1'));
    expect(copy.name).toBe('Main four (copy)');
    expect(value(await lib.readHistory('doc-1')).map((r) => r.revision)).toEqual([2, 3, 4]);
    expect(value(await lib.readLog('doc-1')).map((e) => e.at)).toEqual([
      'at Two',
      'at Main three',
      expect.any(String) as string,
    ]);
    const reader = library(backend);
    expect(value(await reader.open('doc-1')).document.name).toBe('Main four');
    expect(value(await reader.open('doc-1', 'b-1')).document.name).toBe('Branch two');
  });

  it('a branch change never deletes a branch a version names, even when no list names it', async () => {
    const { backend, a } = await branched();
    const lib = library(backend);
    value(await lib.createVersion('doc-1', { name: 'On Try' }, 'b-1'));
    // A release from before branches saved the document: its head names no branch list.
    const path = 'documents/doc-1/head.json';
    const head = JSON.parse(new TextDecoder().decode(backend.files.get(path)!)) as Record<
      string,
      unknown
    >;
    delete head.branches;
    backend.files.set(path, new TextEncoder().encode(JSON.stringify(head)));
    for (const f of [...backend.files.keys()]) {
      if (/branches-\d+\.json$/.test(f)) backend.files.delete(f);
    }
    const again = new DocumentLibrary(backend, { now, locks: null, newId: () => 'b-2' });
    value(await again.createBranch('doc-1', a.id, 'Other'));
    expect(await backend.list('documents/doc-1/branches')).toEqual(['b-1', 'b-2']);
    const pinned = value(await again.listVersions('doc-1', 'b-1'))[0]!;
    expect(value(await again.readVersion('doc-1', pinned.id)).document.name).toBe('Branch two');
  });

  it('writes a new branch again when its directory went before the commit was seen', async () => {
    const { backend, a } = await branched();
    // Another tab without Web Locks takes the new directory for an orphan just as it commits.
    const racing = new CrashingBackend(backend);
    const original = racing.write.bind(racing);
    racing.write = async (path, bytes) => {
      await original(path, bytes);
      if (path === 'documents/doc-1/head.json') {
        await backend.removeTree('documents/doc-1/branches/b-2');
      }
    };
    const lib = new DocumentLibrary(racing, {
      now,
      locks: null,
      newId: () => 'b-2',
      warn: () => {},
    });
    value(await lib.createBranch('doc-1', a.id, 'Other'));
    expect(value(await library(backend).open('doc-1', 'b-2')).document.name).toBe('One');
  });

  it('renames and deletes a branch; deleting leaves main exactly as it was', async () => {
    const { backend } = await branched();
    const lib = library(backend);
    expect(value(await lib.renameBranch('doc-1', 'b-1', '  Wider  '))).toMatchObject({
      id: 'b-1',
      name: 'Wider',
    });
    expect(await lib.renameBranch('doc-1', MAIN_BRANCH, 'X')).toEqual({
      ok: false,
      message: 'The main branch cannot be renamed.',
    });
    expect(await lib.renameBranch('doc-1', 'b-1', 'Main')).toEqual({
      ok: false,
      message: 'There is a branch called "Main" already.',
    });
    expect(await lib.renameBranch('doc-1', 'nope', 'X')).toEqual({
      ok: false,
      message: 'There is no such branch.',
    });

    const before = MAIN_FILES(backend);
    const mainBefore = value(await lib.open('doc-1'));
    expect(await lib.deleteBranch('doc-1', MAIN_BRANCH)).toEqual({
      ok: false,
      message: 'The main branch cannot be deleted.',
    });
    value(await lib.deleteBranch('doc-1', 'b-1'));
    expect(tree(backend, 'documents/doc-1/branches/').size).toBe(0);
    // Only the branch list moved on: main's head names the new one, and nothing else changed.
    const after = MAIN_FILES(backend);
    for (const [path, text] of before) {
      if (path.endsWith('head.json') || path.includes('branches-')) continue;
      expect(after.get(path)).toBe(text);
    }
    expect(value(await lib.open('doc-1'))).toEqual(mainBefore);
    expect(value(await lib.listBranches('doc-1')).map((b) => b.id)).toEqual([MAIN_BRANCH]);
    expect(await lib.open('doc-1', 'b-1')).toEqual({
      ok: false,
      noBranch: true,
      message: 'There is no such branch.',
    });
    // The versions of main still read.
    for (const v of value(await lib.listVersions('doc-1'))) {
      expect((await lib.readVersion('doc-1', v.id)).ok).toBe(true);
    }
  });

  it('keeps a branch that a version names', async () => {
    const { backend } = await branched();
    const lib = library(backend);
    value(await lib.open('doc-1', 'b-1'));
    value(await lib.createVersion('doc-1', { name: 'Kept' }, 'b-1'));
    expect(await lib.deleteBranch('doc-1', 'b-1')).toEqual({
      ok: false,
      message: 'It has a named version, which are kept for good, so it cannot be deleted.',
    });
    expect(value(await library(backend).open('doc-1', 'b-1')).document.name).toBe('Branch two');
  });

  it('refuses a branch name taken, empty or too long, a version that is not there, and bad ids', async () => {
    const { backend, a } = await branched();
    const lib = library(backend);
    expect(await lib.createBranch('doc-1', a.id, 'Try')).toEqual({
      ok: false,
      message: 'There is a branch called "Try" already.',
    });
    expect((await lib.createBranch('doc-1', a.id, '   ')).ok).toBe(false);
    expect((await lib.createBranch('doc-1', a.id, 'x'.repeat(201))).ok).toBe(false);
    expect(await lib.createBranch('doc-1', 'missing', 'New')).toEqual({
      ok: false,
      message: 'There is no version "missing" of it.',
    });
    // A branch id from a URL is never repeated back.
    const odd = `<b>${'x'.repeat(5000)}`;
    expect(await lib.open('doc-1', odd)).toEqual({
      ok: false,
      noBranch: true,
      message: 'There is no such branch.',
    });
    expect((await lib.open('doc-1', '../x')).ok).toBe(false);
    expect((await lib.readHistory('doc-1', '../x')).ok).toBe(false);
    expect((await lib.open('doc-1', 'unknown')).ok).toBe(false);
  });

  it('a save to a branch deleted meanwhile is refused as a conflict, writing nothing', async () => {
    const { backend } = await branched();
    const tab = library(backend);
    value(await tab.open('doc-1', 'b-1'));
    value(await library(backend).deleteBranch('doc-1', 'b-1'));
    const files = [...backend.files.keys()].sort();
    const save = tab.save(named('Lost'), [renameEntry('Lost')], 'b-1');
    await expect(save).rejects.toBeInstanceOf(BranchDeleted);
    await expect(save).rejects.toBeInstanceOf(RevisionConflict);
    expect([...backend.files.keys()].sort()).toEqual(files);
    // Keeping this tab's version as a copy works as for any conflict.
    const copy = await tab.saveCopy(named('Lost'));
    expect(copy.summary.name).toBe('Lost (copy)');
  });

  it('two tabs on one branch: a save over the other tab’s is refused', async () => {
    const { backend } = await branched();
    const one = library(backend);
    const two = library(backend);
    value(await one.open('doc-1', 'b-1'));
    value(await two.open('doc-1', 'b-1'));
    await one.save(named('One wins'), [renameEntry('One wins')], 'b-1');
    await expect(two.save(named('Two loses'), [], 'b-1')).rejects.toBeInstanceOf(RevisionConflict);
    // Main is another branch: saving it is no conflict.
    value(await two.open('doc-1'));
    await two.save(named('Main moves'), [renameEntry('Main moves')]);
    expect(value(await library(backend).open('doc-1', 'b-1')).document.name).toBe('One wins');
  });

  it('recovers the branch list from a torn main head', async () => {
    const { backend } = await branched();
    const head = backend.files.get('documents/doc-1/head.json')!;
    backend.files.set('documents/doc-1/head.json', head.slice(0, 20));
    const lib = library(backend);
    const r = value(await lib.open('doc-1'));
    expect(r).toMatchObject({ recovered: true, revision: 2 });
    expect(value(await lib.listBranches('doc-1')).map((b) => b.name)).toEqual(['Main', 'Try']);
    expect(value(await lib.open('doc-1', 'b-1')).document.name).toBe('Branch two');
  });

  it('exports a branch, and an export with versions imports every version onto main', async () => {
    const { backend } = await branched();
    const lib = library(backend, 'x');
    value(await lib.open('doc-1', 'b-1'));
    const b = value(await lib.createVersion('doc-1', { name: 'B' }, 'b-1'));
    const exported = value(await lib.exportMfk('doc-1', { versions: true, branch: 'b-1' }));
    expect(JSON.parse(unpackMfk(exported.bytes).document)).toMatchObject({ name: 'Branch two' });
    await lib.remove('doc-1');
    value(await lib.importMfk(exported.bytes));
    const versions = value(await lib.listVersions('doc-1'));
    expect(versions.map((v) => v.name)).toEqual(['A', 'B']);
    for (const v of versions) expect(v).not.toHaveProperty('branch');
    expect(value(await lib.readVersion('doc-1', b.id)).document.name).toBe('Branch two');
    expect(value(await lib.listBranches('doc-1')).map((x) => x.id)).toEqual([MAIN_BRANCH]);
  });
});

describe('crash safety per branch', () => {
  it('lists the steps of a branch save: blobs, log, snapshot, then the branch head', async () => {
    const { backend } = await branched();
    const counting = new CrashingBackend(backend);
    const lib = library(counting);
    value(await lib.open('doc-1', 'b-1'));
    await lib.save(await partWithImport(), [renameEntry('x')], 'b-1');
    expect(counting.ops.map((o) => o.replace(/[0-9a-f]{64}/, '<sha>'))).toEqual([
      'write documents/doc-1/blobs/<sha>',
      'write documents/doc-1/branches/b-1/log-00000003.json',
      'write documents/doc-1/branches/b-1/snapshot-00000003.json',
      'write documents/doc-1/branches/b-1/head.json',
    ]);
  });

  // A crash at every step of a save on the branch, clean or torn: the branch is its old or its
  // new state, and main is byte for byte what it was.
  for (const torn of [false, true]) {
    it.each([0, 1, 2, 3])(
      `a branch save that dies at step %i (${torn ? 'torn write' : 'clean'}) leaves main intact`,
      async (at) => {
        const { backend: base } = await branched();
        const backend = cloneBackend(base);
        const before = MAIN_FILES(backend);
        const after = await partWithImport();
        const crashing = new CrashingBackend(backend, at, torn);
        const lib = library(crashing);
        value(await lib.open('doc-1', 'b-1'));
        await expect(lib.save(after, [renameEntry('x')], 'b-1')).rejects.toThrow(/Simulated crash/);

        // Main: untouched (a blob of the document's is not main's to lose).
        const now = MAIN_FILES(backend);
        for (const [path, text] of before) expect(now.get(path)).toBe(text);
        const reloaded = library(backend);
        expect(value(await reloaded.open('doc-1')).document.name).toBe('Two');

        // The branch: the old state, or the new one once its snapshot is whole.
        const r = value(await reloaded.open('doc-1', 'b-1'));
        expect(r.document).toEqual(at >= 3 ? after : named('Branch two'));
        expect(r.revision).toBe(at >= 3 ? 3 : 2);
        // And the next save on it works, without touching main.
        await reloaded.save(named('Branch next'), [renameEntry('Branch next')], 'b-1');
        expect(value(await library(backend).open('doc-1', 'b-1')).document.name).toBe(
          'Branch next',
        );
        expect(value(await reloaded.readLog('doc-1', 'b-1')).length).toBeGreaterThan(0);
        expect(value(await library(backend).open('doc-1')).document.name).toBe('Two');
      },
    );
  }

  it('a main save that dies leaves the branch intact', async () => {
    for (const at of [0, 1, 2]) {
      for (const torn of [false, true]) {
        const { backend: base } = await branched();
        const backend = cloneBackend(base);
        const branchFiles = tree(backend, 'documents/doc-1/branches/');
        const crashing = new CrashingBackend(backend, at, torn);
        const lib = library(crashing);
        value(await lib.open('doc-1'));
        await expect(lib.save(named('Main three'), [renameEntry('Main three')])).rejects.toThrow(
          /Simulated crash/,
        );
        expect(tree(backend, 'documents/doc-1/branches/')).toEqual(branchFiles);
        const reloaded = library(backend);
        expect(value(await reloaded.open('doc-1', 'b-1')).document.name).toBe('Branch two');
        expect(value(await reloaded.listBranches('doc-1')).map((b) => b.name)).toEqual([
          'Main',
          'Try',
        ]);
      }
    }
  });

  it('lists the steps of creating a branch: its files, the list, then the main head', async () => {
    const { backend, a } = await branched();
    const counting = new CrashingBackend(backend);
    const lib = new DocumentLibrary(counting, { now, locks: null, newId: () => 'b-2' });
    value(await lib.createBranch('doc-1', a.id, 'Other'));
    expect(counting.ops).toEqual([
      'removeTree documents/doc-1/branches/b-2',
      'write documents/doc-1/branches/b-2/snapshot-00000001.json',
      'write documents/doc-1/branches/b-2/head.json',
      'write documents/doc-1/branches-00000002.json',
      'write documents/doc-1/head.json',
    ]);
  });

  for (const torn of [false, true]) {
    it.each([0, 1, 2, 3, 4])(
      `creating a branch that dies at step %i (${torn ? 'torn write' : 'clean'}): it is there whole or not at all`,
      async (at) => {
        const { backend: base, a } = await branched();
        const backend = cloneBackend(base);
        const others = tree(backend, 'documents/doc-1/branches/b-1/');
        const crashing = new CrashingBackend(backend, at, torn);
        const create = new DocumentLibrary(crashing, {
          now,
          locks: null,
          newId: () => 'b-2',
        }).createBranch('doc-1', a.id, 'Other');
        await expect(create).rejects.toThrow(/Simulated crash/);

        const reloaded = library(backend);
        // Committed once the list is whole and the head written or torn (a torn head is
        // recovered from the newest list that reads).
        const committed = at === 4 && torn;
        expect(value(await reloaded.open('doc-1')).document.name).toBe('Two');
        const names = value(await reloaded.listBranches('doc-1')).map((b) => b.name);
        expect(names).toEqual(committed ? ['Main', 'Try', 'Other'] : ['Main', 'Try']);
        if (committed) {
          expect(value(await reloaded.open('doc-1', 'b-2')).document.name).toBe('One');
        } else {
          expect((await reloaded.open('doc-1', 'b-2')).ok).toBe(false);
        }
        // The other branch is untouched.
        expect(tree(backend, 'documents/doc-1/branches/b-1/')).toEqual(others);
        expect(value(await reloaded.open('doc-1', 'b-1')).document.name).toBe('Branch two');

        // The next branch change deletes what the dead one left, and works.
        const again = new DocumentLibrary(backend, { now, locks: null, newId: () => 'b-3' });
        value(await again.createBranch('doc-1', a.id, 'Third'));
        const dirs = await backend.list('documents/doc-1/branches');
        expect(dirs).toEqual(committed ? ['b-1', 'b-2', 'b-3'] : ['b-1', 'b-3']);
        expect(value(await again.open('doc-1', 'b-3')).document.name).toBe('One');
      },
    );
  }

  for (const torn of [false, true]) {
    it.each([0, 1, 2])(
      `deleting a branch that dies at step %i (${torn ? 'torn write' : 'clean'}): main and the branch are whole`,
      async (at) => {
        const { backend: base } = await branched();
        const backend = cloneBackend(base);
        const branchFiles = tree(backend, 'documents/doc-1/branches/b-1/');
        const crashing = new CrashingBackend(backend, at, torn);
        const r = library(crashing).deleteBranch('doc-1', 'b-1');
        // Step 2 is removing the directory, after the commit.
        if (at === 2) await expect(r).resolves.toEqual({ ok: true, value: undefined });
        else await expect(r).rejects.toThrow(/Simulated crash/);
        expect(crashing.ops.slice(0, 3)).toEqual(
          [
            'write documents/doc-1/branches-00000002.json',
            'write documents/doc-1/head.json',
            'removeTree documents/doc-1/branches/b-1',
          ].slice(0, at + 1),
        );

        const reloaded = library(backend);
        expect(value(await reloaded.open('doc-1')).document.name).toBe('Two');
        const gone = at === 2 || (at === 1 && torn);
        expect(value(await reloaded.listBranches('doc-1')).map((b) => b.id)).toEqual(
          gone ? [MAIN_BRANCH] : [MAIN_BRANCH, 'b-1'],
        );
        if (!gone) {
          expect(tree(backend, 'documents/doc-1/branches/b-1/')).toEqual(branchFiles);
          expect(value(await reloaded.open('doc-1', 'b-1')).document.name).toBe('Branch two');
        }
      },
    );
  }
});

describe('branch changes that die, and races without locks', () => {
  // Every mutating step of a change, counted on a dry run, then crashed at one by one.
  async function stepsOf(run: (backend: CrashingBackend) => Promise<unknown>): Promise<string[]> {
    const { backend } = await branched();
    const counting = new CrashingBackend(cloneBackend(backend));
    await run(counting);
    return counting.ops;
  }

  const renameTry = (b: CrashingBackend) => library(b).renameBranch('doc-1', 'b-1', 'Renamed');

  it('renaming a branch writes only the list and the main head', async () => {
    expect(await stepsOf(renameTry)).toEqual([
      'write documents/doc-1/branches-00000002.json',
      'write documents/doc-1/head.json',
    ]);
  });

  for (const torn of [false, true]) {
    it.each([0, 1])(
      `renaming a branch that dies at step %i (${torn ? 'torn write' : 'clean'}): the old name or the new`,
      async (at) => {
        const { backend: base } = await branched();
        const backend = cloneBackend(base);
        const branchFiles = tree(backend, 'documents/doc-1/branches/');
        const snapshots = tree(backend, 'documents/doc-1/snapshot-');
        await expect(renameTry(new CrashingBackend(backend, at, torn))).rejects.toThrow(
          /Simulated crash/,
        );
        const reloaded = library(backend);
        const committed = at === 1 && torn;
        expect(value(await reloaded.listBranches('doc-1')).map((b) => b.name)).toEqual([
          'Main',
          committed ? 'Renamed' : 'Try',
        ]);
        // Nothing in any branch's directory, nor main's snapshots, changed.
        expect(tree(backend, 'documents/doc-1/branches/')).toEqual(branchFiles);
        expect(tree(backend, 'documents/doc-1/snapshot-')).toEqual(snapshots);
        expect(value(await reloaded.open('doc-1')).document.name).toBe('Two');
        expect(value(await reloaded.open('doc-1', 'b-1')).document.name).toBe('Branch two');
        // And the next change works.
        expect(value(await reloaded.renameBranch('doc-1', 'b-1', 'Again')).name).toBe('Again');
      },
    );
  }

  const versionOnTry = async (b: CrashingBackend) => {
    const lib = library(b, 'w');
    value(await lib.open('doc-1', 'b-1'));
    return lib.createVersion('doc-1', { name: 'On Try' }, 'b-1');
  };

  it('naming a version on a branch writes only the version list and the main head', async () => {
    expect(await stepsOf(versionOnTry)).toEqual([
      'write documents/doc-1/versions-00000002.json',
      'write documents/doc-1/head.json',
    ]);
  });

  for (const torn of [false, true]) {
    it.each([0, 1])(
      `naming a version on a branch that dies at step %i (${torn ? 'torn write' : 'clean'}): the old list or the new`,
      async (at) => {
        const { backend: base } = await branched();
        const backend = cloneBackend(base);
        const branchFiles = tree(backend, 'documents/doc-1/branches/');
        await expect(versionOnTry(new CrashingBackend(backend, at, torn))).rejects.toThrow(
          /Simulated crash/,
        );
        expect(tree(backend, 'documents/doc-1/branches/')).toEqual(branchFiles);
        const reloaded = library(backend);
        const committed = at === 1 && torn;
        const versions = value(await reloaded.listVersions('doc-1'));
        expect(versions.map((v) => v.name)).toEqual(committed ? ['A', 'On Try'] : ['A']);
        if (committed) {
          expect(versions[1]).toMatchObject({ branch: 'b-1', revision: 2 });
          expect(value(await reloaded.readVersion('doc-1', versions[1]!.id)).document.name).toBe(
            'Branch two',
          );
        }
        expect(value(await reloaded.open('doc-1')).document.name).toBe('Two');
        expect(value(await reloaded.open('doc-1', 'b-1')).document.name).toBe('Branch two');
        // The branch saves on, and the list is still the document's.
        await reloaded.save(named('Branch three'), [renameEntry('Branch three')], 'b-1');
        expect(value(await reloaded.listBranches('doc-1')).map((b) => b.id)).toEqual([
          MAIN_BRANCH,
          'b-1',
        ]);
      },
    );
  }

  it('a branch save does not commit after another tab deleted the branch, even before its directory went', async () => {
    const { backend } = await branched();
    // Another tab, also without Web Locks, deletes the branch while this one is writing its
    // snapshot: its delete commits, then it dies before removing the directory.
    const racing = new CrashingBackend(backend);
    const original = racing.write.bind(racing);
    let raced = false;
    racing.write = async (path, bytes) => {
      await original(path, bytes);
      if (!raced && path === 'documents/doc-1/branches/b-1/snapshot-00000003.json') {
        raced = true;
        const other = new CrashingBackend(backend, 2);
        // Step 2 is removing the directory, which is best effort: the delete still reports done.
        expect(await library(other).deleteBranch('doc-1', 'b-1')).toEqual({
          ok: true,
          value: undefined,
        });
        expect(other.ops[2]).toBe('removeTree documents/doc-1/branches/b-1');
      }
    };
    const tab = library(racing);
    value(await tab.open('doc-1', 'b-1'));
    const branchHead = backend.files.get('documents/doc-1/branches/b-1/head.json');
    await expect(
      tab.save(named('Too late'), [renameEntry('Too late')], 'b-1'),
    ).rejects.toBeInstanceOf(BranchDeleted);
    expect(raced).toBe(true);
    // The branch's head was never moved onto the orphan's new revision.
    expect(backend.files.get('documents/doc-1/branches/b-1/head.json')).toEqual(branchHead);
    expect(value(await library(backend).listBranches('doc-1')).map((b) => b.id)).toEqual([
      MAIN_BRANCH,
    ]);
    expect(value(await library(backend).open('doc-1')).document.name).toBe('Two');
  });
});

describe('documents stored before branches', () => {
  /**
   * A document as a release from before versions and branches stored it: a head with neither
   * `versions` nor `branches`, two revisions, a log, and no list files.
   */
  async function oldStore() {
    const backend = new MemoryBackend();
    const lib = library(backend);
    await lib.save(named('One'));
    await lib.save(named('Two'), [renameEntry('Two')]);
    const path = 'documents/doc-1/head.json';
    const head = JSON.parse(new TextDecoder().decode(backend.files.get(path)!)) as Record<
      string,
      unknown
    >;
    delete head.versions;
    delete head.branches;
    backend.files.set(path, new TextEncoder().encode(JSON.stringify(head)));
    expect([...backend.files.keys()].filter((f) => /(versions|branches)-/.test(f))).toEqual([]);
    return backend;
  }

  it('opens as its main branch, unchanged, with no other branches', async () => {
    const backend = await oldStore();
    const before = tree(backend, 'documents/doc-1/');
    const lib = library(backend);
    const opened = value(await lib.open('doc-1'));
    expect(opened).toMatchObject({ revision: 2, recovered: false });
    expect(opened.document.name).toBe('Two');
    expect(value(await lib.open('doc-1', MAIN_BRANCH)).document.name).toBe('Two');
    expect(value(await lib.listBranches('doc-1'))).toEqual([
      expect.objectContaining({ id: MAIN_BRANCH, name: 'Main', fromVersion: null }),
    ]);
    expect(value(await lib.listVersions('doc-1'))).toEqual([]);
    expect(value(await lib.readHistory('doc-1')).map((r) => r.revision)).toEqual([2]);
    expect(await lib.open('doc-1', 'b-1')).toMatchObject({ ok: false, noBranch: true });
    // Reading it migrated nothing: every file is byte for byte what it was.
    expect(tree(backend, 'documents/doc-1/')).toEqual(before);
  });

  it('branches like any document, keeping its main files where they are', async () => {
    const backend = await oldStore();
    const snapshots = tree(backend, 'documents/doc-1/snapshot-');
    const lib = new DocumentLibrary(backend, { now, locks: null, newId: () => 'n-1' });
    value(await lib.open('doc-1'));
    const v = value(await lib.createVersion('doc-1', { name: 'Old' }));
    const b = value(await lib.createBranch('doc-1', v.id, 'New'));
    expect(tree(backend, 'documents/doc-1/snapshot-')).toEqual(snapshots);
    value(await lib.open('doc-1', b.id));
    await lib.save(named('On new'), [renameEntry('On new')], b.id);
    await lib.save(named('Main three'), [renameEntry('Main three')]);
    const reader = library(backend);
    expect(value(await reader.open('doc-1')).document.name).toBe('Main three');
    expect(value(await reader.open('doc-1', b.id)).document.name).toBe('On new');
    expect(value(await reader.listBranches('doc-1')).map((x) => x.name)).toEqual(['Main', 'New']);
  });
});
