import { join } from 'node:path';
import Database from 'better-sqlite3';
import { applyCommand, type ManufaktureDocument } from '@manufakture/core';
import type { ServerBranch, ServerMessage, ServerVersion } from '@manufakture/sync';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS } from '../src/limits';
import { SyncService } from '../src/service';
import { SqliteStore, STORE_SCHEMA_VERSION } from '../src/sqlite';
import {
  AT,
  Socket,
  addSketch,
  baseDocument,
  call,
  clientKey,
  createDoc,
  entry,
  hello,
  helloHttp,
  setVariable,
  start,
  submit,
  submitHttp,
  tempDir,
  type Running,
} from './helpers';

// Named versions and branches on the server (T7.1e): records beside the logs, a branch's own log
// from a version, and the hardening of the new routes (token, schema, fixed messages, caps).

let tmp: ReturnType<typeof tempDir>;
let dbPath: string;
let server: Running;

beforeEach(async () => {
  tmp = tempDir();
  dbPath = join(tmp.dir, 'sync.db');
  server = await start(dbPath);
});

afterEach(async () => {
  await server.close();
  tmp.remove();
});

const DOC = 'doc-1';
const V1 = '0b6f0d7e-5a3c-4d8e-9f21-6c7b8a9d0e1f';
const V2 = '1c7a1e8f-6b4d-4e9f-8a32-7d8c9b0e1f2a';
const B1 = '2d8b2f90-7c5e-4fa0-9b43-8e9dac1f2a3b';

function version(fields: Partial<ServerVersion> = {}): ServerVersion {
  return {
    id: V1,
    name: 'First',
    description: 'Before the walls',
    branch: 'main',
    rev: 0,
    createdAt: AT,
    ...fields,
  };
}

function branch(fields: Partial<ServerBranch> = {}): ServerBranch {
  return { id: B1, name: 'Taller', fromVersion: V1, createdAt: AT, ...fields };
}

/** Submits `n` variable settings to main through HTTP, as one client. */
async function addVariables(n: number, clientId = 'c1'): Promise<void> {
  const key = clientKey();
  expect((await helloHttp(server, DOC, clientId, key)).status).toBe(200);
  const doc = baseDocument();
  const entries = [];
  for (let i = 1; i <= n; i++) {
    entries.push(
      entry(doc, setVariable(`v${i}`, String(i)), {
        clientId,
        clientSeq: i,
        ...(i > 1 && { prevSeq: i - 1 }),
      }),
    );
  }
  expect((await submitHttp(server, DOC, key, submit(entries, 1))).status).toBe(200);
}

function ok<T>(r: { ok: true; value: T } | { ok: false; error: { message: string } }): T {
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

const variables = (doc: ManufaktureDocument) => doc.variables.map((v) => v.name);

describe('versions', () => {
  beforeEach(() => createDoc(server));

  it('need the token', async () => {
    for (const [method, path] of [
      ['GET', `/documents/${DOC}/versions`],
      ['POST', `/documents/${DOC}/versions`],
      ['GET', `/documents/${DOC}/versions/${V1}`],
      ['GET', `/documents/${DOC}/branches`],
      ['POST', `/documents/${DOC}/branches`],
    ] as const) {
      const r = await call(server, method, path, {
        token: null,
        ...(method === 'POST' && { body: { version: version() } }),
      });
      expect(r.status, `${method} ${path}`).toBe(401);
    }
    expect(server.store.listVersions(DOC)).toEqual([]);
  });

  it('are stored once, listed, and read back with the document of their revision', async () => {
    await addVariables(3);
    const made = await call(server, 'POST', `/documents/${DOC}/versions`, {
      body: { version: version({ rev: 1 }) },
    });
    expect(made.status).toBe(201);
    expect(made.body).toEqual({ version: version({ rev: 1 }) });
    const second = version({ id: V2, name: 'Head', rev: 3, description: '' });
    expect(
      (await call(server, 'POST', `/documents/${DOC}/versions`, { body: { version: second } }))
        .status,
    ).toBe(201);

    const list = await call(server, 'GET', `/documents/${DOC}/versions`);
    expect(list.status).toBe(200);
    expect(list.headers.get('cache-control')).toBe('no-store');
    expect(list.body).toEqual({ versions: [version({ rev: 1 }), second] });

    const read = await call<{ version: ServerVersion; document: ManufaktureDocument }>(
      server,
      'GET',
      `/documents/${DOC}/versions/${V1}`,
    );
    expect(read.status).toBe(200);
    expect(read.body.version).toEqual(version({ rev: 1 }));
    expect(variables(read.body.document)).toEqual(['width', 'v1']);
    // The version's revision is kept as a snapshot, so reading it replays nothing.
    expect(server.store.snapshotAt(DOC, 'main', 1)?.rev).toBe(1);
    const head = await call<{ document: ManufaktureDocument }>(
      server,
      'GET',
      `/documents/${DOC}/versions/${V2}`,
    );
    expect(variables(head.body.document)).toEqual(['width', 'v1', 'v2', 'v3']);
  });

  it('answer a resend as stored, and refuse another record under the same id', async () => {
    const path = `/documents/${DOC}/versions`;
    expect((await call(server, 'POST', path, { body: { version: version() } })).status).toBe(201);
    expect((await call(server, 'POST', path, { body: { version: version() } })).status).toBe(200);
    const other = await call(server, 'POST', path, {
      body: { version: version({ name: 'Renamed' }) },
    });
    expect(other.status).toBe(409);
    expect(other.body).toEqual({ code: 'version-exists', message: 'Another version has this id' });
    expect(server.store.listVersions(DOC)).toEqual([version()]);
  });

  it.each([
    ['no record', {}],
    ['an extra field', { version: { ...version(), extra: true } }],
    ['a name too long', { version: version({ name: 'x'.repeat(201) }) }],
    ['an id with a slash', { version: version({ id: 'a/b' }) }],
    ['a negative revision', { version: version({ rev: -1 }) }],
    ['a branch that is not an id', { version: version({ branch: '../x' }) }],
  ])('refuse %s with a fixed message', async (_what, body) => {
    const r = await call(server, 'POST', `/documents/${DOC}/versions`, { body });
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ code: 'invalid-version', message: 'The version record is invalid' });
  });

  it('refuse a revision not reached yet, an unknown branch and an unknown document', async () => {
    const r = await call(server, 'POST', `/documents/${DOC}/versions`, {
      body: { version: version({ rev: 1 }) },
    });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ code: 'no-revision' });
    const b = await call(server, 'POST', `/documents/${DOC}/versions`, {
      body: { version: version({ branch: B1 }) },
    });
    expect(b.status).toBe(400);
    expect(b.body).toMatchObject({ code: 'no-branch' });
    const d = await call(server, 'POST', `/documents/nope/versions`, {
      body: { version: version() },
    });
    expect(d.status).toBe(404);
    expect((await call(server, 'GET', `/documents/nope/versions`)).status).toBe(404);
    expect((await call(server, 'GET', `/documents/${DOC}/versions/${V2}`)).status).toBe(404);
    expect((await call(server, 'GET', `/documents/${DOC}/versions/a.b`)).status).toBe(404);
  });

  it('cap the body and the count', async () => {
    const big = await call(server, 'POST', `/documents/${DOC}/versions`, {
      body: { version: version({ description: 'x'.repeat(20_000) }) },
    });
    expect(big.status).toBe(413);
    await server.close();
    server = await start(dbPath, { limits: { maxVersionsPerDocument: 1 } });
    const path = `/documents/${DOC}/versions`;
    expect((await call(server, 'POST', path, { body: { version: version() } })).status).toBe(201);
    const over = await call(server, 'POST', path, {
      body: { version: version({ id: V2 }) },
    });
    expect(over.status).toBe(403);
    expect(over.body).toMatchObject({ code: 'too-many-versions' });
  });

  it('survive a restart', async () => {
    await addVariables(2);
    await call(server, 'POST', `/documents/${DOC}/versions`, {
      body: { version: version({ rev: 2 }) },
    });
    await server.close();
    server = await start(dbPath);
    const read = await call<{ document: ManufaktureDocument }>(
      server,
      'GET',
      `/documents/${DOC}/versions/${V1}`,
    );
    expect(variables(read.body.document)).toEqual(['width', 'v1', 'v2']);
  });
});

describe('branches', () => {
  beforeEach(async () => {
    await createDoc(server);
    await addVariables(2);
    const r = await call(server, 'POST', `/documents/${DOC}/versions`, {
      body: { version: version({ rev: 1 }) },
    });
    expect(r.status).toBe(201);
  });

  it('start from a version, with a log of their own', async () => {
    const made = await call(server, 'POST', `/documents/${DOC}/branches`, {
      body: { branch: branch() },
    });
    expect(made.status).toBe(201);
    expect(made.body).toEqual({ branch: branch() });
    expect((await call(server, 'GET', `/documents/${DOC}/branches`)).body).toEqual({
      branches: [branch()],
    });

    const snap = await call<{ rev: number; document: ManufaktureDocument }>(
      server,
      'GET',
      `/documents/${DOC}/snapshot?branch=${B1}`,
    );
    expect(snap.status).toBe(200);
    expect(snap.body.rev).toBe(0);
    expect(variables(snap.body.document)).toEqual(['width', 'v1']);

    // Its own log: a submit to the branch moves it, not main.
    const key = clientKey();
    expect(
      (
        await call(server, 'POST', `/documents/${DOC}/hello?branch=${B1}`, {
          body: hello('b'),
          key,
        })
      ).status,
    ).toBe(200);
    const branched = snap.body.document;
    const r = await call<{ messages: ServerMessage[] }>(
      server,
      'POST',
      `/documents/${DOC}/entries?branch=${B1}`,
      {
        body: submit(
          [entry(branched, setVariable('tall', '9'), { clientId: 'b', clientSeq: 1 })],
          1,
        ),
        key,
      },
    );
    expect(r.status).toBe(200);
    expect(r.body.messages).toEqual([{ type: 'ack', clientSeq: 1, rev: 1 }]);
    const after = await call<{ document: ManufaktureDocument }>(
      server,
      'GET',
      `/documents/${DOC}/snapshot?branch=${B1}`,
    );
    expect(variables(after.body.document)).toEqual(['width', 'v1', 'tall']);
    const main = await call<{ rev: number; document: ManufaktureDocument }>(
      server,
      'GET',
      `/documents/${DOC}/snapshot`,
    );
    expect(main.body.rev).toBe(2);
    expect(variables(main.body.document)).toEqual(['width', 'v1', 'v2']);
    const pulled = await call<{ messages: { entries: unknown[] }[] }>(
      server,
      'GET',
      `/documents/${DOC}/entries?since=0&branch=${B1}`,
    );
    expect(pulled.body.messages[0]!.entries).toHaveLength(1);

    // A version of the branch names its revision.
    const v = version({ id: V2, name: 'Tall', branch: B1, rev: 1 });
    expect(
      (await call(server, 'POST', `/documents/${DOC}/versions`, { body: { version: v } })).status,
    ).toBe(201);
    const read = await call<{ document: ManufaktureDocument }>(
      server,
      'GET',
      `/documents/${DOC}/versions/${V2}`,
    );
    expect(variables(read.body.document)).toEqual(['width', 'v1', 'tall']);

    // The client claim is per branch: the branch's client is unknown on main.
    const onMain = await submitHttp(
      server,
      DOC,
      key,
      submit([entry(branched, setVariable('x', '1'), { clientId: 'b', clientSeq: 2 })], 1),
    );
    expect(onMain.status).toBe(403);
  });

  it('push to the connections of their own branch only', async () => {
    await call(server, 'POST', `/documents/${DOC}/branches`, { body: { branch: branch() } });
    const onMain = new Socket(server, DOC, { key: clientKey() });
    const onBranch = new Socket(server, DOC, { key: clientKey(), branch: B1 });
    await onMain.open();
    await onBranch.open();
    onMain.send(hello('m'));
    onBranch.send(hello('b'));
    expect(await onMain.next((m) => m.type === 'welcome')).toMatchObject({ head: 2 });
    expect(await onBranch.next((m) => m.type === 'welcome')).toMatchObject({ head: 0 });
    const snap = await call<{ document: ManufaktureDocument }>(
      server,
      'GET',
      `/documents/${DOC}/snapshot?branch=${B1}`,
    );
    onBranch.send(
      submit(
        [entry(snap.body.document, setVariable('tall', '9'), { clientId: 'b', clientSeq: 1 })],
        1,
      ),
    );
    expect(await onBranch.next((m) => m.type === 'ack')).toEqual({
      type: 'ack',
      clientSeq: 1,
      rev: 1,
    });
    await onBranch.next((m) => m.type === 'push');
    await new Promise((r) => setTimeout(r, 100));
    expect(onMain.received.filter((m) => m.type === 'push')).toEqual([]);
    onMain.close();
    onBranch.close();
  });

  it('answer a resend as stored, refuse a conflict, an unknown version and a bad branch query', async () => {
    const path = `/documents/${DOC}/branches`;
    expect((await call(server, 'POST', path, { body: { branch: branch() } })).status).toBe(201);
    expect((await call(server, 'POST', path, { body: { branch: branch() } })).status).toBe(200);
    const other = await call(server, 'POST', path, {
      body: { branch: branch({ name: 'Wider' }) },
    });
    expect(other.status).toBe(409);
    expect(other.body).toEqual({ code: 'branch-exists', message: 'Another branch has this id' });
    const missing = await call(server, 'POST', path, {
      body: { branch: branch({ id: V2, fromVersion: V2 }) },
    });
    expect(missing.status).toBe(400);
    expect(missing.body).toMatchObject({ code: 'no-version' });
    const main = await call(server, 'POST', path, { body: { branch: branch({ id: 'main' }) } });
    expect(main.status).toBe(400);
    expect(main.body).toEqual({ code: 'invalid-branch', message: 'The branch record is invalid' });
    for (const q of ['?branch=../x', '?branch=', `?branch=${'x'.repeat(200)}`]) {
      expect((await call(server, 'GET', `/documents/${DOC}/snapshot${q}`)).status).toBe(400);
    }
    expect((await call(server, 'GET', `/documents/${DOC}/snapshot?branch=${V2}`)).status).toBe(404);
    const bad = new Socket(server, DOC, { key: clientKey(), branch: V2 });
    await bad.open().catch(() => undefined);
    await new Promise((r) => setTimeout(r, 100));
    expect(bad.closed?.code ?? 4404).toBe(4404);
  });

  it('cap the count', async () => {
    await server.close();
    server = await start(dbPath, { limits: { maxBranchesPerDocument: 1 } });
    const path = `/documents/${DOC}/branches`;
    expect((await call(server, 'POST', path, { body: { branch: branch() } })).status).toBe(201);
    const over = await call(server, 'POST', path, {
      body: { branch: branch({ id: V2, name: 'Second' }) },
    });
    expect(over.status).toBe(403);
    expect(over.body).toMatchObject({ code: 'too-many-branches' });
  });
});

describe('the store schema', () => {
  it('upgrades a version 1 database on open', async () => {
    await createDoc(server);
    await server.close();
    const db = new Database(dbPath);
    db.exec('DROP TABLE branch_records; DROP TABLE versions;');
    db.prepare("UPDATE meta SET value = '1' WHERE key = 'schema'").run();
    db.close();
    const store = new SqliteStore(dbPath);
    expect(store.listVersions(DOC)).toEqual([]);
    store.close();
    const check = new Database(dbPath, { readonly: true });
    expect(check.prepare("SELECT value FROM meta WHERE key = 'schema'").pluck().get()).toBe(
      String(STORE_SCHEMA_VERSION),
    );
    check.close();
    server = await start(dbPath);
    expect(
      (await call(server, 'POST', `/documents/${DOC}/versions`, { body: { version: version() } }))
        .status,
    ).toBe(201);
  });
});

describe('records stored meanwhile', () => {
  it('a second identical upload that loses the race is a resend (200), another record a conflict', async () => {
    await createDoc(server);
    await server.close();
    const store = new SqliteStore(dbPath);
    // The store says "not here" at the first look, as if the other upload had not committed yet.
    let hide = true;
    const racing = new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === 'version') {
          return (doc: string, id: string) => {
            if (hide) {
              hide = false;
              return undefined;
            }
            return target.version(doc, id);
          };
        }
        const v = Reflect.get(target, prop, receiver) as unknown;
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    const service = new SyncService(racing, { limits: DEFAULT_LIMITS });
    expect(service.createVersion(DOC, { version: version() })).toMatchObject({ status: 201 });
    hide = true;
    expect(service.createVersion(DOC, { version: version() })).toMatchObject({
      ok: true,
      status: 200,
    });
    hide = true;
    expect(service.createVersion(DOC, { version: version({ name: 'Other' }) })).toMatchObject({
      ok: false,
      status: 409,
    });
    store.close();
    server = await start(dbPath);
  });

  it("a branch starts with its version's branch high-water mark, deleted parts included", async () => {
    await createDoc(server);
    const key = clientKey();
    expect((await helloHttp(server, DOC, 'c1', key)).status).toBe(200);
    const doc = baseDocument();
    const add = { type: 'addPart', partId: 'part#2', name: 'Two' } as never;
    const withPart = ok(applyCommand(doc, add)).document;
    const sketch = addSketch(withPart, 'part#2');
    const withSketch = ok(applyCommand(withPart, sketch)).document;
    const del = { type: 'deletePart', partId: 'part#2' } as never;
    const r = await submitHttp(
      server,
      DOC,
      key,
      submit(
        [
          entry(doc, add, { clientId: 'c1', clientSeq: 1 }),
          entry(withPart, sketch, { clientId: 'c1', clientSeq: 2, prevSeq: 1 }),
          entry(withSketch, del, { clientId: 'c1', clientSeq: 3, prevSeq: 2 }),
        ],
        1,
      ),
    );
    expect(r.status).toBe(200);
    await call(server, 'POST', `/documents/${DOC}/versions`, {
      body: { version: version({ rev: 3 }) },
    });
    await call(server, 'POST', `/documents/${DOC}/branches`, { body: { branch: branch() } });
    const snap = await call<{ document: ManufaktureDocument; highWater: Record<string, unknown> }>(
      server,
      'GET',
      `/documents/${DOC}/snapshot?branch=${B1}`,
    );
    expect(snap.body.document.parts.map((p) => p.id)).toEqual(['part#1']);
    // The document's own counters say nothing of part#2's sketches; the mark remembers them.
    expect(JSON.stringify(snap.body.highWater)).toContain('part#2');
  });
});
