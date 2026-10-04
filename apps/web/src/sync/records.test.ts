import { applyCommand, type Command, type ManufaktureDocument } from '@manufakture/core';
import {
  ReferenceServer,
  SyncClient,
  type ServerBranch,
  type ServerVersion,
} from '@manufakture/sync';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryBackend } from '../persistence/backend';
import { DocumentLibrary, type SyncUploads } from '../persistence/library';
import { partDocument } from '../persistence/test-fixtures';
import { RecordSync } from './records';
import { flushPromises } from './test-hub';

// Versions and branches on the server (T7.1e) from the app's side: what is made here goes up,
// naming the server revision that holds it; what the server has comes down into the library.

const SERVER = { url: 'https://sync.example', token: 't'.repeat(40) };
const DOC = 'doc-1';

/** The server's records over HTTP, in memory, with the reference server's log for documents. */
class FakeRecords {
  readonly versions: ServerVersion[] = [];
  readonly branches: ServerBranch[] = [];
  readonly documents = new Map<string, ManufaktureDocument>();
  /** Status to answer every record POST with instead (a refusal, the server away). */
  postStatus: number | null = null;
  reachable = true;
  /** GETs of single versions, by id. */
  readonly reads = new Map<string, number>();

  constructor(private readonly log: ReferenceServer) {}

  fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!this.reachable) throw new TypeError('Failed to fetch');
    const url = new URL(String(input));
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    const path = url.pathname.replace(`/api/documents/${DOC}`, '');
    if (init?.method === 'POST') {
      if (this.postStatus !== null) {
        return json(this.postStatus, { code: 'x', message: 'Refused' });
      }
      const body = JSON.parse(String(init.body)) as {
        version?: ServerVersion;
        branch?: ServerBranch;
      };
      if (path === '/versions' && body.version) {
        if (!this.versions.some((v) => v.id === body.version!.id)) {
          this.versions.push(body.version);
          this.documents.set(body.version.id, this.at(body.version.rev));
        }
        return json(201, { version: body.version });
      }
      if (path === '/branches' && body.branch) {
        this.branches.push(body.branch);
        return json(201, { branch: body.branch });
      }
    }
    if (path === '/versions') return json(200, { versions: this.versions });
    if (path === '/branches') return json(200, { branches: this.branches });
    const m = /^\/versions\/(.+)$/.exec(path);
    if (m) {
      this.reads.set(m[1]!, (this.reads.get(m[1]!) ?? 0) + 1);
      const version = this.versions.find((v) => v.id === m[1]);
      if (!version) return json(404, { code: 'not-found', message: 'No such version' });
      return json(200, { version, document: this.documents.get(version.id) });
    }
    return json(404, { code: 'not-found', message: 'Not found' });
  }) as typeof fetch;

  /** The log's document at `rev`. */
  at(rev: number): ManufaktureDocument {
    let doc = this.start;
    for (const p of this.log.log.slice(0, rev)) {
      doc = applyOrThrow(doc, p.entry.command as Command);
    }
    return doc;
  }

  start: ManufaktureDocument = partDocument();
}

function applyOrThrow(doc: ManufaktureDocument, command: Command): ManufaktureDocument {
  const r = applyCommand(doc, command);
  if (!r.ok) throw new Error(r.error.message);
  return r.value.document;
}

function value<T>(r: { ok: true; value: T } | { ok: false; message: string }): T {
  if (!r.ok) throw new Error(r.message);
  return r.value;
}

const setVariable = (name: string): Command => ({
  type: 'setVariable',
  name,
  expression: { source: '5', lengthUnit: 'mm', angleUnit: 'deg' },
});

/** Hands the client's messages to the server and every answer back. */
function pump(client: SyncClient, server: ReferenceServer): void {
  for (let i = 0; i < 20; i++) {
    const out = client.takeOutgoing();
    if (out.length === 0) return;
    for (const m of out) {
      const handled = server.handle(m);
      for (const r of [...handled.replies, ...(handled.push ? [handled.push] : [])]) {
        client.handle(r);
      }
    }
  }
}

const running: RecordSync[] = [];
afterEach(() => {
  for (const r of running.splice(0)) r.stop();
});

async function setup(options: { uploads?: SyncUploads; now?: () => number } = {}) {
  const doc = partDocument();
  const library = new DocumentLibrary(new MemoryBackend(), { locks: null, warn: () => undefined });
  await library.save(doc, []);
  const log = new ReferenceServer(doc);
  const client = new SyncClient(doc, 0, { clientId: 'here' });
  const server = new FakeRecords(log);
  let saves = 0;
  const warnings: string[] = [];
  const records = new RecordSync({
    library,
    documentId: DOC,
    server: SERVER,
    client,
    ...(options.uploads && { uploads: options.uploads }),
    save: () => saves++,
    fetch: server.fetch,
    pollMs: 0,
    warn: (m) => warnings.push(m),
    ...(options.now && { now: options.now }),
  });
  running.push(records);
  await records.start();
  /** An edit made here, saved like autosave would. */
  const edit = async (name: string) => {
    const r = client.submit({ command: setVariable(name), label: name });
    if (!r.ok) throw new Error(r.error.message);
    await library.save(client.document, []);
  };
  return {
    library,
    log,
    client,
    server,
    records,
    warnings,
    saves: () => saves,
    edit,
    settle: async () => {
      for (let i = 0; i < 5; i++) {
        await records.run();
        await flushPromises();
      }
    },
  };
}

describe('versions made here', () => {
  it('go to the server naming the confirmed revision when nothing waits', async () => {
    const t = await setup();
    await t.edit('a');
    pump(t.client, t.log);
    const v = value(await t.library.createVersion(DOC, { name: 'Synced', description: 'd' }));
    await t.settle();
    expect(t.server.versions).toEqual([
      {
        id: v.id,
        name: 'Synced',
        description: 'd',
        branch: 'main',
        rev: 1,
        createdAt: v.createdAt,
      },
    ]);
    expect(t.records.uploads()).toBeUndefined();
    expect(t.saves()).toBeGreaterThan(0);
  });

  it('wait for the change they hold to land, and name the revision it landed at', async () => {
    const t = await setup();
    // Another device's change lands first.
    const other = new SyncClient(partDocument(), 0, { clientId: 'other' });
    other.submit({ command: setVariable('theirs'), label: 'theirs' });
    pump(other, t.log);
    await t.edit('mine');
    const v = value(await t.library.createVersion(DOC, { name: 'Offline' }));
    await t.settle();
    expect(t.server.versions).toEqual([]);
    expect(t.records.uploads()).toEqual({ versions: [{ id: v.id, after: 1 }], branches: [] });
    pump(t.client, t.log);
    await t.settle();
    expect(t.server.versions.map((x) => [x.id, x.rev])).toEqual([[v.id, 2]]);
    expect(t.server.at(2).variables.map((x) => x.name)).toContain('mine');
    expect(t.records.uploads()).toBeUndefined();
  });

  it('carry on from what was saved with the sync state', async () => {
    const doc = partDocument();
    const t = await setup({ uploads: { versions: [], branches: [] } });
    const v = value(await t.library.createVersion(DOC, { name: 'Before reload' }));
    await t.settle();
    expect(t.server.versions).toHaveLength(1);
    // A second tab of the same browser, after a reload: the upload saved before it is sent.
    const again = new RecordSync({
      library: t.library,
      documentId: DOC,
      server: SERVER,
      client: new SyncClient(doc, 0, { clientId: 'here' }),
      uploads: { versions: [{ id: v.id, rev: 0 }], branches: [] },
      save: () => undefined,
      fetch: t.server.fetch,
      pollMs: 0,
    });
    running.push(again);
    t.server.versions.splice(0);
    await again.start();
    expect(t.server.versions.map((x) => x.id)).toEqual([v.id]);
  });

  it('stay here when the server refuses them, and wait while it is away', async () => {
    const t = await setup();
    t.server.reachable = false;
    value(await t.library.createVersion(DOC, { name: 'Later' }));
    await t.settle();
    expect(t.records.uploads()?.versions).toHaveLength(1);
    t.server.reachable = true;
    t.server.postStatus = 409;
    await t.settle();
    expect(t.records.uploads()).toBeUndefined();
    expect(t.warnings.join()).toContain('stays in this browser');
  });

  it('made by sync itself (keeping dropped work) stay here', async () => {
    const t = await setup();
    await t.records.keep(async () => {
      const v = value(await t.library.createVersion(DOC, { name: 'Kept' }));
      value(await t.library.createBranch(DOC, v.id, 'Kept from sync'));
    });
    await t.settle();
    expect(t.server.versions).toEqual([]);
    expect(t.server.branches).toEqual([]);
  });
});

describe('branches made here', () => {
  it('go to the server once the version they were made from is there', async () => {
    const t = await setup();
    t.server.reachable = false;
    const v = value(await t.library.createVersion(DOC, { name: 'Base' }));
    const b = value(await t.library.createBranch(DOC, v.id, 'Wider'));
    await t.settle();
    expect(t.records.uploads()).toEqual({
      versions: [{ id: v.id, rev: 0 }],
      branches: [b.id],
    });
    t.server.reachable = true;
    await t.settle();
    expect(t.server.branches).toEqual([
      { id: b.id, name: 'Wider', fromVersion: v.id, createdAt: b.createdAt },
    ]);
    expect(t.records.uploads()).toBeUndefined();
  });

  it('made from a version the server will never have stay here', async () => {
    const t = await setup();
    t.server.reachable = false;
    // Made before this tab synced: known, so never sent.
    const old = value(await t.library.createVersion(DOC, { name: 'Old' }));
    t.records.stop();
    const fresh = new RecordSync({
      library: t.library,
      documentId: DOC,
      server: SERVER,
      client: t.client,
      save: () => undefined,
      fetch: t.server.fetch,
      pollMs: 0,
      warn: () => undefined,
    });
    running.push(fresh);
    await fresh.start();
    value(await t.library.createBranch(DOC, old.id, 'From old'));
    t.server.reachable = true;
    for (let i = 0; i < 3; i++) await fresh.run();
    expect(t.server.branches).toEqual([]);
    expect(fresh.uploads()).toBeUndefined();
  });
});

describe('what the server has', () => {
  it('is kept in the library: versions with their documents, then branches', async () => {
    const t = await setup();
    const other = new SyncClient(partDocument(), 0, { clientId: 'other' });
    other.submit({ command: setVariable('theirs'), label: 'theirs' });
    pump(other, t.log);
    t.server.versions.push({
      id: 'their-v',
      name: 'Theirs',
      description: '',
      branch: 'main',
      rev: 1,
      createdAt: '2026-10-04T10:00:00.000Z',
    });
    t.server.documents.set('their-v', t.server.at(1));
    t.server.branches.push({
      id: 'their-b',
      name: 'Their branch',
      fromVersion: 'their-v',
      createdAt: '2026-10-04T10:01:00.000Z',
    });
    await t.settle();
    const versions = value(await t.library.listVersions(DOC));
    expect(versions.map((v) => [v.id, v.revision, v.serverRev])).toEqual([['their-v', 0, 1]]);
    const read = value(await t.library.readVersion(DOC, 'their-v'));
    expect(read.document.variables.map((v) => v.name)).toContain('theirs');
    const branches = value(await t.library.listBranches(DOC));
    expect(branches.map((b) => b.name)).toEqual(['Main', 'Their branch']);
    // Kept from the server: not sent back.
    expect(t.records.uploads()).toBeUndefined();
    expect(t.server.versions).toHaveLength(1);
    expect(t.server.branches).toHaveLength(1);
  });
});

describe('races and retries', () => {
  it('a change that lands before the version is noted still names its revision', async () => {
    const t = await setup();
    await t.edit('mine');
    // The landing arrives right after the version is made, before its queued step runs.
    const stop = t.library.subscribe((c) => {
      if (c.kind === 'versions') pump(t.client, t.log);
    });
    const v = value(await t.library.createVersion(DOC, { name: 'Raced' }));
    stop();
    expect(t.client.pending).toHaveLength(0);
    // A later edit: the version can no longer be matched with the confirmed document.
    await t.edit('later');
    pump(t.client, t.log);
    await t.settle();
    expect(t.server.versions.map((x) => [x.id, x.rev])).toEqual([[v.id, 1]]);
    expect(t.warnings).toEqual([]);
  });

  it('a server record that cannot be kept is tried again later, not on every run', async () => {
    let clock = 0;
    const t = await setup({ now: () => clock });
    t.server.versions.push({
      id: 'broken',
      name: 'Broken',
      description: '',
      branch: 'main',
      rev: 0,
      createdAt: '2026-10-04T10:00:00.000Z',
    });
    t.server.documents.set('broken', partDocument('doc-2'));
    await t.settle();
    expect(t.server.reads.get('broken')).toBe(1);
    clock += 9_000;
    await t.settle();
    expect(t.server.reads.get('broken')).toBe(1);
    clock += 2_000;
    await t.settle();
    expect(t.server.reads.get('broken')).toBe(2);
    // Twice as long the second time.
    clock += 15_000;
    await t.settle();
    expect(t.server.reads.get('broken')).toBe(2);
    clock += 10_000;
    await t.settle();
    expect(t.server.reads.get('broken')).toBe(3);
    expect(value(await t.library.listVersions(DOC))).toEqual([]);
  });
});
