import { applyCommand, serialize, type Command, type ManufaktureDocument } from '@manufakture/core';
import { describe, expect, it } from 'vitest';
import {
  DocumentLibrary,
  MAIN_BRANCH,
  type LibraryChange,
  type RemoteVersion,
  type Version,
} from './library';
import { partDocument, newBackend } from './test-fixtures';

// Versions and branches that came from the sync server (T7.1e): kept here with their documents
// although they name no revision saved in this browser, listed and read like any version, a
// branch made from one, pins resolved through the server when the version is not here, and the
// change notices the sync controller and the History panel follow.

let clock = 0;
const now = () => new Date(Date.UTC(2026, 9, 4, 12, 0, clock++));

function library(backend = newBackend()) {
  let n = 0;
  return new DocumentLibrary(backend, {
    now,
    locks: null,
    newId: () => `id-${++n}`,
    warn: () => undefined,
  });
}

function value<T>(r: { ok: true; value: T } | { ok: false; message: string }): T {
  if (!r.ok) throw new Error(r.message);
  return r.value;
}

const named = (doc: ManufaktureDocument, name: string): ManufaktureDocument => ({ ...doc, name });

function remote(fields: Partial<RemoteVersion> = {}): RemoteVersion {
  return {
    id: 'server-v1',
    name: 'From the other browser',
    description: 'Made elsewhere',
    createdAt: '2026-10-04T11:00:00.000Z',
    branch: MAIN_BRANCH,
    serverRev: 4,
    ...fields,
  };
}

describe('versions from the sync server', () => {
  it('are kept with their document, listed after the local ones, and read back', async () => {
    const backend = newBackend();
    const lib = library(backend);
    const doc = partDocument();
    await lib.save(doc, []);
    const local = value(await lib.createVersion('doc-1', { name: 'Local' }));
    const theirs = named(doc, 'Their name');
    const kept = value(await lib.adoptVersion('doc-1', remote(), theirs));
    expect(kept).toMatchObject({ id: 'server-v1', revision: 0, serverRev: 4 });
    expect(kept.branch).toBeUndefined();
    expect(backend.files.has('documents/doc-1/remote-server-v1.json')).toBe(true);
    expect(value(await lib.listVersions('doc-1')).map((v) => v.id)).toEqual([local.id, kept.id]);
    // A fresh library reads it back, checked against its SHA-256.
    const read = value(await library(backend).readVersion('doc-1', 'server-v1'));
    expect(serialize(read.document)).toBe(serialize(theirs));
    // Adopting it again changes nothing.
    expect(value(await lib.adoptVersion('doc-1', remote({ name: 'Other' }), doc))).toEqual(kept);
  });

  it('keep the mark of a version an agent made on the server, and read it back (T8.4b)', async () => {
    const backend = newBackend();
    const lib = library(backend);
    const doc = partDocument();
    await lib.save(doc, []);
    const kept = value(await lib.adoptVersion('doc-1', remote({ madeByAgent: true }), doc));
    expect(kept.madeByAgent).toBe(true);
    value(await lib.adoptVersion('doc-1', remote({ id: 'server-v2', madeByAgent: false }), doc));
    const listed = value(await library(backend).listVersions('doc-1'));
    expect(listed.map((v) => [v.id, v.madeByAgent])).toEqual([
      ['server-v1', true],
      ['server-v2', undefined],
    ]);
  });

  it('refuse another document, an invalid record, and a damaged copy', async () => {
    const backend = newBackend();
    const lib = library(backend);
    const doc = partDocument();
    await lib.save(doc, []);
    expect((await lib.adoptVersion('doc-1', remote(), partDocument('doc-2'))).ok).toBe(false);
    for (const bad of [
      remote({ name: '' }),
      remote({ name: ' padded ' }),
      remote({ id: 'a/b' }),
      remote({ serverRev: -1 }),
      remote({ createdAt: 'never' }),
      remote({ branch: '../x' }),
    ]) {
      expect((await lib.adoptVersion('doc-1', bad, doc)).ok, JSON.stringify(bad)).toBe(false);
    }
    value(await lib.adoptVersion('doc-1', remote(), doc));
    backend.files.set('documents/doc-1/remote-server-v1.json', new TextEncoder().encode('{}'));
    const r = await library(backend).readVersion('doc-1', 'server-v1');
    expect(r.ok).toBe(false);
  });

  it('can be branched from; such a branch merges into main from that version (T8.4b)', async () => {
    const lib = library();
    const doc = partDocument();
    await lib.save(doc, []);
    value(await lib.adoptVersion('doc-1', remote(), named(doc, 'Theirs')));
    const branch = value(await lib.createBranch('doc-1', 'server-v1', 'Try'));
    const opened = value(await lib.open('doc-1', branch.id));
    expect(opened.document.name).toBe('Theirs');
    // A command on the branch, as an agent's synced batch arrives in the reviewer's browser.
    const command = {
      type: 'setVariable',
      name: 'depth',
      expression: { source: '12', lengthUnit: 'mm', angleUnit: 'deg' },
    } as Command;
    const applied = applyCommand(opened.document, command);
    if (!applied.ok) throw new Error(applied.error.message);
    await lib.save(
      applied.value.document,
      [{ cause: 'execute', label: 'Depth', command, at: '2026-10-04T12:00:00.000Z' }],
      branch.id,
    );
    // Main moved meanwhile (a person's edit): the branch's command is rebased onto it.
    const mainEdit = { ...command, name: 'width' } as Command;
    const mainNow = applyCommand(doc, mainEdit);
    if (!mainNow.ok) throw new Error(mainNow.error.message);
    await lib.save(mainNow.value.document, [
      { cause: 'execute', label: 'Width', command: mainEdit, at: '2026-10-04T12:00:00.000Z' },
    ]);
    const plan = value(await lib.previewMerge('doc-1', branch.id, MAIN_BRANCH));
    expect(plan.dropped).toEqual([]);
    expect(plan.fork).toEqual({ branch: MAIN_BRANCH, revision: 0 });
    const merged = value(await lib.mergeBranch('doc-1', branch.id, MAIN_BRANCH));
    expect(merged.saved).not.toBeNull();
    const main = value(await lib.open('doc-1'));
    expect(main.document.variables.map((v) => v.name).sort()).toEqual(['depth', 'width']);
    // Into another branch it is still refused: that history is not here.
    const other = value(await lib.createVersion('doc-1', { name: 'Here' }));
    const second = value(await lib.createBranch('doc-1', other.id, 'Second'));
    const into = await lib.previewMerge('doc-1', branch.id, second.id);
    expect(into.ok).toBe(false);
    if (!into.ok) expect(into.message).toContain('sync server');
  });

  it('a branch made from a server version of another branch still says where to merge it', async () => {
    const lib = library();
    const doc = partDocument();
    await lib.save(doc, []);
    value(await lib.adoptVersion('doc-1', remote({ branch: 'server-b9' }), named(doc, 'Theirs')));
    const branch = value(await lib.createBranch('doc-1', 'server-v1', 'Try'));
    const merge = await lib.previewMerge('doc-1', branch.id, MAIN_BRANCH);
    expect(merge.ok).toBe(false);
    if (!merge.ok) expect(merge.message).toContain('sync server');
  });

  it('go into a .mfk with its versions and come back as revisions of the imported copy', async () => {
    const lib = library();
    const doc = partDocument();
    await lib.save(doc, []);
    value(await lib.adoptVersion('doc-1', remote(), named(doc, 'Theirs')));
    const file = value(await lib.exportMfk('doc-1', { versions: true }));
    const other = library();
    const imported = value(await other.importMfk(file.bytes));
    const versions = value(await other.listVersions(imported.summary.id));
    expect(versions).toHaveLength(1);
    expect(versions[0]!.revision).toBeGreaterThan(0);
    expect(versions[0]!.serverRev).toBeUndefined();
    const read = value(await other.readVersion(imported.summary.id, 'server-v1'));
    expect(read.document.name).toBe('Theirs');
  });
});

describe('a kept version that is not committed', () => {
  it('leaves no file behind, and a leftover one is swept under locks', async () => {
    const backend = newBackend();
    const lib = library(backend);
    const doc = partDocument();
    await lib.save(doc, []);
    // The list is full: the commit is refused, and the document file goes again.
    for (let i = 0; i < 500; i++) value(await lib.createVersion('doc-1', { name: `v${i}` }));
    expect((await lib.adoptVersion('doc-1', remote(), doc)).ok).toBe(false);
    expect([...backend.files.keys()].some((k) => k.includes('remote-'))).toBe(false);

    // A crash between the write and the commit leaves a file no list names.
    const other = newBackend();
    const locked = new DocumentLibrary(other, {
      now,
      newId: () => crypto.randomUUID(),
      warn: () => undefined,
      locks: { request: <T>(_name: string, op: () => Promise<T>) => op() },
    });
    await locked.save(doc, []);
    other.files.set('documents/doc-1/remote-left-over.json', new TextEncoder().encode('{}'));
    value(await locked.adoptVersion('doc-1', remote(), doc));
    expect(other.files.has('documents/doc-1/remote-left-over.json')).toBe(false);
    expect(other.files.has('documents/doc-1/remote-server-v1.json')).toBe(true);
  });
});

describe('branches from the sync server', () => {
  it('are made from their version under their own id, time and a free name', async () => {
    const lib = library();
    const doc = partDocument();
    await lib.save(doc, []);
    value(await lib.adoptVersion('doc-1', remote(), named(doc, 'Theirs')));
    value(await lib.createBranch('doc-1', 'server-v1', 'Taller'));
    const record = {
      id: 'server-b1',
      name: 'Taller',
      fromVersion: 'server-v1',
      createdAt: '2026-10-04T11:30:00.000Z',
    };
    const kept = value(await lib.adoptBranch('doc-1', record));
    expect(kept).toEqual({ ...record, name: 'Taller (2)' });
    expect(value(await lib.open('doc-1', 'server-b1')).document.name).toBe('Theirs');
    // Again: the branch that is here.
    expect(value(await lib.adoptBranch('doc-1', record))).toEqual(kept);
    expect(
      (await lib.adoptBranch('doc-1', { ...record, id: 'server-b2', fromVersion: 'missing' })).ok,
    ).toBe(false);
    expect((await lib.adoptBranch('doc-1', { ...record, id: 'main' })).ok).toBe(false);
  });

  it("keep an agent branch's provenance, review state and comment (T8.4b)", async () => {
    const lib = library();
    const doc = partDocument();
    await lib.save(doc, []);
    value(await lib.adoptVersion('doc-1', remote(), named(doc, 'Theirs')));
    const provenance = {
      origin: 'agent' as const,
      sessionId: 'session-1',
      clientName: 'Claude Code',
      review: 'changes-requested' as const,
      comment: 'Wider, please.\nThanks',
    };
    const record = {
      id: 'server-agent',
      name: 'Agent session',
      fromVersion: 'server-v1',
      createdAt: '2026-10-04T11:30:00.000Z',
      provenance,
    };
    expect(value(await lib.adoptBranch('doc-1', record))).toEqual(record);
    const listed = value(await lib.listBranches('doc-1')).find((b) => b.id === 'server-agent');
    expect(listed?.provenance).toEqual(provenance);
    // Its review state then moves as the server's does.
    value(await lib.setBranchReview('doc-1', 'server-agent', 'open', { comment: null }));
    expect(
      value(await lib.listBranches('doc-1')).find((b) => b.id === 'server-agent')?.provenance,
    ).toEqual({ ...provenance, review: 'open', comment: undefined });
  });

  it('refuse a forged or damaged provenance, and never turn one kind of branch into the other', async () => {
    const lib = library();
    const doc = partDocument();
    await lib.save(doc, []);
    value(await lib.adoptVersion('doc-1', remote(), named(doc, 'Theirs')));
    const base = {
      name: 'B',
      fromVersion: 'server-v1',
      createdAt: '2026-10-04T11:30:00.000Z',
    };
    const good = { origin: 'agent', sessionId: 's1', clientName: 'Claude Code', review: 'open' };
    for (const provenance of [
      { ...good, origin: 'person' },
      { ...good, review: 'merged' },
      { ...good, clientName: 'Claude\u202e' },
      { ...good, clientName: '' },
      { ...good, sessionId: '../x' },
      { ...good, comment: 'bell\u0007' },
      { ...good, comment: '' },
    ]) {
      const r = await lib.adoptBranch('doc-1', {
        ...base,
        id: 'forged',
        provenance: provenance as never,
      });
      expect(r.ok).toBe(false);
    }
    expect(value(await lib.listBranches('doc-1')).map((b) => b.id)).toEqual(['main']);
    // A person's branch here stays a person's when the server's record says agent, and the
    // reverse.
    const person = value(await lib.adoptBranch('doc-1', { ...base, id: 'p1' }));
    expect(person.provenance).toBeUndefined();
    const again = value(
      await lib.adoptBranch('doc-1', { ...base, id: 'p1', provenance: good as never }),
    );
    expect(again.provenance).toBeUndefined();
    const agent = value(
      await lib.adoptBranch('doc-1', { ...base, name: 'A', id: 'a1', provenance: good as never }),
    );
    expect(agent.provenance?.origin).toBe('agent');
    const back = value(await lib.adoptBranch('doc-1', { ...base, name: 'A', id: 'a1' }));
    expect(back.provenance).toEqual(good);
  });
});

describe('the library tells its subscribers', () => {
  it('when versions or branches change, and only when they did', async () => {
    const lib = library();
    const doc = partDocument();
    await lib.save(doc, []);
    const seen: LibraryChange[] = [];
    const stop = lib.subscribe((c) => seen.push(c));
    const v = value(await lib.createVersion('doc-1', { name: 'One' }));
    value(await lib.renameVersion('doc-1', v.id, 'Uno'));
    const b = value(await lib.createBranch('doc-1', v.id, 'B'));
    value(await lib.renameBranch('doc-1', b.id, 'Bee'));
    value(await lib.deleteBranch('doc-1', b.id));
    value(await lib.adoptVersion('doc-1', remote(), doc));
    expect((await lib.createVersion('doc-1', { name: '' })).ok).toBe(false);
    stop();
    value(await lib.createVersion('doc-1', { name: 'Unheard' }));
    expect(seen).toEqual([
      { id: 'doc-1', kind: 'versions' },
      { id: 'doc-1', kind: 'versions' },
      { id: 'doc-1', kind: 'branches' },
      { id: 'doc-1', kind: 'branches' },
      { id: 'doc-1', kind: 'branches' },
      { id: 'doc-1', kind: 'versions' },
    ]);
  });
});

describe('pins resolved through the server', () => {
  it('a version not here is looked up, kept when its document is here, and used offline after', async () => {
    const lib = library();
    const doc = partDocument();
    await lib.save(doc, []);
    let calls = 0;
    lib.setRemoteVersions(async (documentId, versionId) => {
      calls++;
      if (documentId !== 'doc-1' || versionId !== 'server-v1') return null;
      return { version: remote(), document: named(doc, 'Pinned') };
    });
    const read = value(await lib.readVersion('doc-1', 'server-v1'));
    expect(read.document.name).toBe('Pinned');
    expect(read.version).toMatchObject({ id: 'server-v1', revision: 0, serverRev: 4 });
    expect(value(await lib.listVersions('doc-1')).map((v) => v.id)).toEqual(['server-v1']);
    lib.setRemoteVersions(null);
    expect(value(await lib.readVersion('doc-1', 'server-v1')).document.name).toBe('Pinned');
    expect(calls).toBe(1);
    expect((await lib.readVersion('doc-1', 'nope')).ok).toBe(false);
  });

  it('a version of a document not here is read from the server and not kept', async () => {
    const lib = library();
    const other = partDocument('doc-9', 'Elsewhere');
    lib.setRemoteVersions(async () => ({ version: remote(), document: other }));
    const read = value(await lib.readVersion('doc-9', 'server-v1'));
    expect(read.document.name).toBe('Elsewhere');
    const version: Version = read.version;
    expect(version.revision).toBe(0);
    expect(await lib.has('doc-9')).toBe(false);
  });

  it('a server answer for another document or version is not used', async () => {
    const lib = library();
    await lib.save(partDocument(), []);
    lib.setRemoteVersions(async () => ({
      version: remote(),
      document: partDocument('doc-2'),
    }));
    expect((await lib.readVersion('doc-1', 'server-v1')).ok).toBe(false);
    lib.setRemoteVersions(async () => ({
      version: remote({ id: 'other' }),
      document: partDocument(),
    }));
    expect((await lib.readVersion('doc-1', 'server-v1')).ok).toBe(false);
    lib.setRemoteVersions(async () => {
      throw new Error('offline');
    });
    expect((await lib.readVersion('doc-1', 'server-v1')).ok).toBe(false);
  });
});
