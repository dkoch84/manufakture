import { createHash } from 'node:crypto';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { FORMAT_VERSION, applyCommand, type ManufaktureDocument } from '@manufakture/core';
import { SyncClient, type ServerMessage } from '@manufakture/sync';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CHECKPOINT_EVERY } from '../src/store';
import {
  AT,
  Connected,
  ORIGIN,
  PART,
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
  TOKEN,
  start,
  submit,
  submitHttp,
  tempDir,
  until,
  type Running,
} from './helpers';

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

function ok<T>(r: { ok: true; value: T } | { ok: false; error: { message: string } }): T {
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

const DOC = 'doc-1';

/** Everything that tells whether state changed: head, rows, clients, blobs. */
function stateOf(path: string) {
  const db = new Database(path, { readonly: true });
  try {
    const q = (sql: string) => db.prepare(sql).all();
    return JSON.stringify({
      branches: q('SELECT * FROM branches'),
      entries: q('SELECT document_id, rev FROM entries'),
      outcomes: q('SELECT * FROM outcomes'),
      clients: q('SELECT document_id, client_id, floor, latest_accepted FROM clients'),
      blobs: q('SELECT sha256 FROM blobs'),
      documents: q('SELECT id FROM documents'),
    });
  } finally {
    db.close();
  }
}

function rows(path: string, clientId: string): number[] {
  const db = new Database(path, { readonly: true });
  try {
    return (
      db
        .prepare('SELECT client_seq FROM outcomes WHERE client_id = ? ORDER BY client_seq')
        .pluck()
        .all(clientId) as number[]
    ).map(Number);
  } finally {
    db.close();
  }
}

function floorOf(path: string, clientId: string): number {
  const db = new Database(path, { readonly: true });
  try {
    return db
      .prepare('SELECT floor FROM clients WHERE client_id = ?')
      .pluck()
      .get(clientId) as number;
  } finally {
    db.close();
  }
}

/** Creates the document and claims `clientId` over HTTP; returns the key. */
async function ready(clientId = 'a'): Promise<string> {
  await createDoc(server);
  const key = clientKey();
  const h = await helloHttp(server, DOC, clientId, key);
  expect(h.status).toBe(200);
  return key;
}

describe('auth and CORS', () => {
  it('refuses requests without the token, or with a wrong one, and answers health without', async () => {
    expect((await call(server, 'GET', '/documents', { token: null })).status).toBe(401);
    expect((await call(server, 'GET', '/documents', { token: 'x'.repeat(48) })).status).toBe(401);
    const short = await call(server, 'GET', '/documents', {
      headers: { authorization: 'Basic abc' },
      token: null,
    });
    expect(short.status).toBe(401);
    expect((await call(server, 'GET', '/documents')).status).toBe(200);
    const health = await call(server, 'GET', '/health', { token: null });
    expect(health).toMatchObject({ status: 200, body: { ok: true } });
  });

  it('serves only under /api', async () => {
    const res = await fetch(server.url.replace(/\/api$/, '') + '/documents', {
      headers: { authorization: 'Bearer x' },
    });
    expect(res.status).toBe(404);
  });

  it('sends CORS headers for the configured origin only, without credentials', async () => {
    const pre = await fetch(server.url + '/documents', {
      method: 'OPTIONS',
      headers: {
        origin: ORIGIN,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization,content-type,manufakture-client-key',
      },
    });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(pre.headers.get('access-control-allow-credentials')).toBeNull();
    expect(pre.headers.get('access-control-allow-headers')).toMatch(/manufakture-client-key/i);
    const other = await call(server, 'GET', '/documents', {
      headers: { origin: 'https://evil.test' },
    });
    expect(other.headers.get('access-control-allow-origin')).toBeNull();
    const mine = await call(server, 'GET', '/documents', { headers: { origin: ORIGIN } });
    expect(mine.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(mine.headers.get('set-cookie')).toBeNull();
    expect(mine.headers.get('cache-control')).toBe('no-store');
  });

  it('refuses a WebSocket without the token', async () => {
    await createDoc(server);
    const s = new Socket(server, DOC, { token: 'wrong-token-0123456789abcdefghijklmnop' });
    await until(() => s.failed || s.closed !== undefined, 5_000, 'refusal');
    expect(s.opened).toBe(false);
  });

  it('speaks its subprotocol and never echoes the token', async () => {
    await createDoc(server);
    const s = new Socket(server, DOC, { key: clientKey() });
    await s.open();
    expect(s.protocol).toBe('manufakture-sync');
    s.close();
  });
});

describe('documents', () => {
  it('creates, lists and snapshots a document; refuses a duplicate and an invalid one', async () => {
    const doc = baseDocument();
    const created = await call(server, 'POST', '/documents', { body: { document: doc } });
    expect(created).toMatchObject({ status: 201, body: { id: DOC, head: 0 } });
    const again = await call(server, 'POST', '/documents', { body: { document: doc } });
    expect(again).toMatchObject({ status: 409, body: { code: 'exists' } });
    const bad = await call(server, 'POST', '/documents', {
      body: { document: { ...doc, parts: [] } },
    });
    expect(bad).toMatchObject({ status: 400, body: { code: 'invalid-document' } });
    const badId = await call(server, 'POST', '/documents', {
      body: { document: { ...doc, id: '../etc' } },
    });
    expect(badId.status).toBe(400);
    const list = await call<{ documents: { id: string; head: number }[] }>(
      server,
      'GET',
      '/documents',
    );
    expect(list.body.documents).toEqual([
      expect.objectContaining({ id: DOC, name: 'Bracket', head: 0 }),
    ]);
    const snap = await call<{ rev: number; document: ManufaktureDocument }>(
      server,
      'GET',
      `/documents/${DOC}/snapshot`,
    );
    expect(snap.body.rev).toBe(0);
    expect(snap.body.document).toEqual(doc);
    expect((await call(server, 'GET', '/documents/nope/snapshot')).status).toBe(404);
  });
});

describe('client claims', () => {
  it('binds a clientId to the key of its first hello', async () => {
    const key = await ready('a');
    const other = clientKey();
    const stolen = await helloHttp(server, DOC, 'a', other);
    expect(stolen).toMatchObject({ status: 403, body: { code: 'client-key' } });
    const doc = baseDocument();
    const e = entry(doc, setVariable('x', '1'), { clientId: 'a', clientSeq: 1 });
    const before = stateOf(dbPath);
    const forged = await submitHttp(server, DOC, other, submit([e], 1));
    expect(forged).toMatchObject({ status: 403, body: { code: 'client-key' } });
    const noHello = await submitHttp(server, DOC, key, submit([{ ...e, clientId: 'b' }], 1));
    expect(noHello).toMatchObject({ status: 403, body: { code: 'hello-first' } });
    expect(stateOf(dbPath)).toBe(before);
    expect((await submitHttp(server, DOC, key, submit([e], 1))).status).toBe(200);
  });

  it("a WebSocket submits only for its hello's client and cannot raise another client's floor", async () => {
    const keyB = await ready('b');
    const doc = baseDocument();
    // b has entries 1 and 2 in flight with floor 1.
    const b1 = entry(doc, setVariable('x', '1'), { clientId: 'b', clientSeq: 1 });
    expect((await submitHttp(server, DOC, keyB, submit([b1], 1))).status).toBe(200);
    const s = new Socket(server, DOC, { key: clientKey() });
    await s.open();
    s.send(hello('a'));
    await s.next((m) => m.type === 'welcome');
    const before = stateOf(dbPath);
    const forged = entry(doc, setVariable('y', '2'), { clientId: 'b', clientSeq: 5 });
    s.send(submit([forged], 5));
    const err = await s.next((m) => m.type === 'error');
    expect(err).toMatchObject({ code: 'invalid-message' });
    expect((err as { message: string }).message).toMatch(/client-mismatch/);
    expect(stateOf(dbPath)).toBe(before);
    expect(floorOf(dbPath, 'b')).toBe(1);
    s.close();
  });

  it('limits the number of clients per document', async () => {
    await server.close();
    server = await start(dbPath, { limits: { maxClientsPerDocument: 2 } });
    await createDoc(server);
    expect((await helloHttp(server, DOC, 'a', clientKey())).status).toBe(200);
    expect((await helloHttp(server, DOC, 'b', clientKey())).status).toBe(200);
    const third = await helloHttp(server, DOC, 'c', clientKey());
    expect(third).toMatchObject({ status: 403, body: { code: 'too-many-clients' } });
  });
});

describe('sync over HTTP and WebSocket', () => {
  it('two clients over WebSockets converge, the loser of a concurrent add renamed', async () => {
    await createDoc(server);
    const snap = (
      await call<{ rev: number; document: ManufaktureDocument }>(
        server,
        'GET',
        `/documents/${DOC}/snapshot`,
      )
    ).body;
    const a = new Connected(
      new SyncClient(snap.document, snap.rev, { clientId: 'a', now: () => AT }),
      server,
      DOC,
    );
    const b = new Connected(
      new SyncClient(snap.document, snap.rev, { clientId: 'b', now: () => AT }),
      server,
      DOC,
    );
    await a.open();
    await b.open();
    // Both add sketch#1 at once.
    ok(a.client.submit({ command: addSketch(a.client.document), label: 'A sketch' }));
    ok(b.client.submit({ command: addSketch(b.client.document), label: 'B sketch' }));
    ok(a.client.submit({ command: setVariable('depth', '10'), label: 'Depth' }));
    a.pump();
    b.pump();
    const settled = () => {
      const pa = a.client.pending.length;
      const pb = b.client.pending.length;
      return (
        pa === 0 && pb === 0 && a.client.confirmedRevision === 3 && b.client.confirmedRevision === 3
      );
    };
    for (let i = 0; i < 500 && !settled(); i++) {
      a.pump();
      b.pump();
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(a.errors).toEqual([]);
    expect(b.errors).toEqual([]);
    expect(settled()).toBe(true);
    expect(a.client.document).toEqual(b.client.document);
    const head = (
      await call<{ rev: number; document: ManufaktureDocument }>(
        server,
        'GET',
        `/documents/${DOC}/snapshot`,
      )
    ).body;
    expect(head.rev).toBe(3);
    expect(head.document).toEqual(a.client.document);
    const sketches = head.document.parts[0]!.features.filter((f) => f.kind === 'sketch').map(
      (f) => f.id,
    );
    expect(sketches.sort()).toEqual(['sketch#1', 'sketch#2']);
    a.socket.close();
    b.socket.close();
  });

  it('pushes entries accepted over HTTP to open sockets', async () => {
    const key = await ready('a');
    const s = new Socket(server, DOC, { key: clientKey() });
    await s.open();
    s.send(hello('watcher'));
    await s.next((m) => m.type === 'welcome');
    const e = entry(baseDocument(), setVariable('x', '1'), { clientId: 'a', clientSeq: 1 });
    const r = await submitHttp(server, DOC, key, submit([e], 1));
    expect(r.body.messages).toEqual([{ type: 'ack', clientSeq: 1, rev: 1 }]);
    const push = await s.next((m) => m.type === 'push');
    expect(push).toEqual({ type: 'push', entries: [{ rev: 1, entry: e }] });
    const pulled = await call<{ messages: ServerMessage[] }>(
      server,
      'GET',
      `/documents/${DOC}/entries?since=0`,
    );
    expect(pulled.body.messages).toEqual([push]);
    s.send({ type: 'pull', since: 0 });
    expect(await s.next()).toEqual(push);
    expect((await call(server, 'GET', `/documents/${DOC}/entries?since=-1`)).status).toBe(400);
    s.close();
  });

  it('an entry before its predecessor gets the retryable answer, writes no row, then its verdict', async () => {
    const key = await ready('a');
    const doc = baseDocument();
    const a1 = entry(doc, setVariable('x', '1'), { clientId: 'a', clientSeq: 1 });
    const after = ok(applyCommand(doc, a1.command as never)).document;
    const a2 = entry(after, setVariable('y', '2'), { clientId: 'a', clientSeq: 2, prevSeq: 1 });
    const early = await submitHttp(server, DOC, key, submit([a2], 1));
    expect(early.status).toBe(409);
    expect(early.body).toMatchObject({
      code: 'predecessor-unknown',
      messages: [{ type: 'predecessor-unknown', clientSeq: 2 }],
    });
    expect(rows(dbPath, 'a')).toEqual([]);
    expect((await submitHttp(server, DOC, key, submit([a1], 1))).body.messages).toEqual([
      { type: 'ack', clientSeq: 1, rev: 1 },
    ]);
    const late = await submitHttp(server, DOC, key, submit([a2], 1));
    expect(late).toMatchObject({
      status: 200,
      body: { messages: [{ type: 'ack', clientSeq: 2, rev: 2 }] },
    });
  });

  it('a restart loses nothing; resubmissions get the recorded outcome, a refusal included', async () => {
    const key = await ready('a');
    const keyB = clientKey();
    expect((await helloHttp(server, DOC, 'b', keyB)).status).toBe(200);
    const doc = baseDocument();
    // a and b both add sketch#1; b's is refused as id-reused.
    const a1 = entry(doc, addSketch(doc), { clientId: 'a', clientSeq: 1 });
    const b1 = entry(doc, addSketch(doc), { clientId: 'b', clientSeq: 1 });
    expect((await submitHttp(server, DOC, key, submit([a1], 1))).body.messages![0]).toMatchObject({
      type: 'ack',
    });
    const refused = (await submitHttp(server, DOC, keyB, submit([b1], 1))).body.messages![0];
    expect(refused).toMatchObject({
      type: 'refuse',
      clientSeq: 1,
      error: { code: 'id-reused' },
      headRev: 1,
    });
    const head = (await call(server, 'GET', `/documents/${DOC}/snapshot`)).body;

    await server.close();
    server = await start(dbPath);
    expect((await call(server, 'GET', `/documents/${DOC}/snapshot`)).body).toEqual(head);
    expect((await submitHttp(server, DOC, key, submit([a1], 1))).body.messages).toEqual([
      { type: 'ack', clientSeq: 1, rev: 1 },
    ]);
    expect((await submitHttp(server, DOC, keyB, submit([b1], 1))).body.messages).toEqual([refused]);
    // The claims survive too.
    expect((await helloHttp(server, DOC, 'a', clientKey())).status).toBe(403);
    const pulled = await call<{ messages: { entries: unknown[] }[] }>(
      server,
      'GET',
      `/documents/${DOC}/entries?since=0`,
    );
    expect(pulled.body.messages[0]!.entries).toHaveLength(1);
  });

  it('writes a snapshot every CHECKPOINT_EVERY revisions and loads from it after a restart', async () => {
    const key = await ready('a');
    let doc = baseDocument();
    const entries = [];
    for (let i = 1; i <= CHECKPOINT_EVERY + 20; i++) {
      const command = setVariable(`v${i}`, String(i));
      entries.push(
        entry(doc, command, { clientId: 'a', clientSeq: i, ...(i > 1 && { prevSeq: i - 1 }) }),
      );
      doc = ok(applyCommand(doc, command)).document;
    }
    const r = await submitHttp(server, DOC, key, submit(entries, 1));
    expect(r.body.messages).toHaveLength(CHECKPOINT_EVERY + 20);
    const db = new Database(dbPath, { readonly: true });
    const revs = db.prepare('SELECT rev FROM snapshots ORDER BY rev').pluck().all();
    db.close();
    expect(revs).toEqual([0, CHECKPOINT_EVERY]);
    await server.close();
    server = await start(dbPath);
    const snap = (
      await call<{ rev: number; document: ManufaktureDocument }>(
        server,
        'GET',
        `/documents/${DOC}/snapshot`,
      )
    ).body;
    expect(snap.rev).toBe(CHECKPOINT_EVERY + 20);
    expect(snap.document).toEqual(doc);
  });
});

describe('retention floor', () => {
  /** Accepts entries 1..n for client a, each naming the previous. */
  async function acceptChain(key: string, n: number, floor = 1) {
    let doc = baseDocument();
    const entries = [];
    for (let i = 1; i <= n; i++) {
      const command = setVariable(`v${i}`, String(i));
      entries.push(
        entry(doc, command, { clientId: 'a', clientSeq: i, ...(i > 1 && { prevSeq: i - 1 }) }),
      );
      doc = ok(applyCommand(doc, command)).document;
    }
    const r = await submitHttp(server, DOC, key, submit(entries, floor));
    expect(r.status).toBe(200);
    return { doc, entries };
  }

  it('pruning keeps the latest accepted entry and every outcome a correct client can ask for', async () => {
    const key = await ready('a');
    const { doc, entries } = await acceptChain(key, 4);
    expect(rows(dbPath, 'a')).toEqual([1, 2, 3, 4]);
    // Entry 5 names 4 (the latest accepted); its floor is 5.
    const e5 = entry(doc, setVariable('v5', '5'), { clientId: 'a', clientSeq: 5, prevSeq: 4 });
    expect((await submitHttp(server, DOC, key, submit([e5], 5))).status).toBe(200);
    expect(rows(dbPath, 'a')).toEqual([5]);
    // Entry 4 below the floor is gone, so a late copy of it is a protocol error, nothing judged.
    const before = stateOf(dbPath);
    const late = await submitHttp(server, DOC, key, submit([entries[3]!], 4));
    expect(late).toMatchObject({ status: 400, body: { code: 'below-floor' } });
    expect(late.body.messages).toEqual([
      expect.objectContaining({ type: 'error', code: 'below-floor', clientSeq: 4 }),
    ]);
    expect(stateOf(dbPath)).toBe(before);
    // The recorded outcome of the kept latest accepted entry is still answered.
    expect((await submitHttp(server, DOC, key, submit([e5], 5))).body.messages).toEqual([
      { type: 'ack', clientSeq: 5, rev: 5 },
    ]);
  });

  it('keeps the latest accepted entry below the floor so a new entry may name it', async () => {
    const key = await ready('a');
    const { doc } = await acceptChain(key, 3);
    // Entry 4 was refused (a dependency error) and resolved; the client now sends 5 naming 3.
    const bad = entry(doc, setVariable('v1', '1'), { clientId: 'a', clientSeq: 4, prevSeq: 3 });
    const broken = {
      ...bad,
      command: { type: 'deleteFeature', partId: PART, featureId: 'nope#1' },
    };
    const r4 = await submitHttp(server, DOC, key, submit([broken as never], 4));
    expect(r4.body.messages![0]).toMatchObject({ type: 'refuse', clientSeq: 4 });
    // Floor 4 pruned rows 1 and 2; 3, the latest accepted, stays.
    expect(rows(dbPath, 'a')).toEqual([3, 4]);
    const e5 = entry(doc, setVariable('v9', '9'), { clientId: 'a', clientSeq: 5, prevSeq: 3 });
    const r5 = await submitHttp(server, DOC, key, submit([e5], 5));
    expect(r5.body.messages).toEqual([{ type: 'ack', clientSeq: 5, rev: 4 }]);
    expect(rows(dbPath, 'a')).toEqual([5]);
  });

  it('A refused and B lost: the floor stays 1, row 1 survives, and B gets predecessor-refused', async () => {
    const key = await ready('a');
    const keyB = clientKey();
    expect((await helloHttp(server, DOC, 'b', keyB)).status).toBe(200);
    const doc = baseDocument();
    // b takes sketch#1 first, so a's A (adding sketch#1) is refused as id-reused.
    const theirs = entry(doc, addSketch(doc), { clientId: 'b', clientSeq: 1 });
    expect((await submitHttp(server, DOC, keyB, submit([theirs], 1))).status).toBe(200);
    const A = entry(doc, addSketch(doc), { clientId: 'a', clientSeq: 1 });
    const afterA = ok(applyCommand(doc, A.command as never)).document;
    const B = entry(afterA, setVariable('x', '1'), { clientId: 'a', clientSeq: 2, prevSeq: 1 });
    // A and B are sent; B's submit is lost. A is refused.
    const rA = await submitHttp(server, DOC, key, submit([A], 1));
    expect(rA.body.messages![0]).toMatchObject({ type: 'refuse', error: { code: 'id-reused' } });
    // B is still in flight, so every submit carries floor 1 (here A' is resent as 3).
    const head = ok(applyCommand(doc, theirs.command as never)).document;
    const A2 = entry(head, addSketch(head), { clientId: 'a', clientSeq: 3 });
    expect((await submitHttp(server, DOC, key, submit([A2], 1))).body.messages![0]).toMatchObject({
      type: 'ack',
    });
    expect(floorOf(dbPath, 'a')).toBe(1);
    expect(rows(dbPath, 'a')).toEqual([1, 3]);
    const rB = await submitHttp(server, DOC, key, submit([B], 1));
    expect(rB).toMatchObject({
      status: 200,
      body: {
        messages: [{ type: 'refuse', clientSeq: 2, error: { code: 'predecessor-refused' } }],
      },
    });
  });

  it('a lower floor arriving after a higher one does not lower the stored floor', async () => {
    const key = await ready('a');
    const { doc } = await acceptChain(key, 3);
    const e4 = entry(doc, setVariable('v4', '4'), { clientId: 'a', clientSeq: 4, prevSeq: 3 });
    expect((await submitHttp(server, DOC, key, submit([e4], 4))).status).toBe(200);
    expect(floorOf(dbPath, 'a')).toBe(4);
    // An overtaken submit with floor 2 arrives late (a resend of entry 4).
    const late = await submitHttp(server, DOC, key, submit([e4], 2));
    expect(late.body.messages).toEqual([{ type: 'ack', clientSeq: 4, rev: 4 }]);
    expect(floorOf(dbPath, 'a')).toBe(4);
    expect(rows(dbPath, 'a')).toEqual([4]);
  });

  it('refuses a floor above the entries of its own submit', async () => {
    const key = await ready('a');
    const e = entry(baseDocument(), setVariable('x', '1'), { clientId: 'a', clientSeq: 1 });
    const r = await submitHttp(server, DOC, key, submit([e], 2));
    expect(r).toMatchObject({ status: 400, body: { code: 'invalid-message' } });
    expect(rows(dbPath, 'a')).toEqual([]);
  });
});

describe('hostile inputs and limits', () => {
  it('refuses malformed, oversized, deep and stale input with 4xx and no state change', async () => {
    const key = await ready('a');
    const e = entry(baseDocument(), setVariable('x', '1'), { clientId: 'a', clientSeq: 1 });
    const before = stateOf(dbPath);
    const path = `/documents/${DOC}/entries`;
    const malformed = await call(server, 'POST', path, {
      raw: '{"type":"submit",',
      key,
      headers: { 'content-type': 'application/json' },
    });
    expect(malformed.status).toBe(400);
    const proto = await call(server, 'POST', path, {
      raw: '{"type":"submit","__proto__":{"x":1}}',
      key,
      headers: { 'content-type': 'application/json' },
    });
    expect(proto.status).toBe(400);
    const wrongShape = await submitHttp(server, DOC, key, {
      type: 'submit',
      entries: [{ ...e, extra: 1 }],
      floor: 1,
    });
    expect(wrongShape).toMatchObject({ status: 400, body: { code: 'invalid-message' } });
    let deep: unknown = 1;
    for (let i = 0; i < 10_000; i++) deep = [deep];
    const tooDeep = await submitHttp(
      server,
      DOC,
      key,
      submit([{ ...e, command: { type: 'batch', deep } as never }], 1),
    );
    expect(tooDeep).toMatchObject({ status: 413, body: { code: 'too-complex' } });
    const newer = await submitHttp(
      server,
      DOC,
      key,
      submit([{ ...e, format: FORMAT_VERSION + 1 }], 1),
    );
    expect(newer).toMatchObject({ status: 400, body: { code: 'format-version' } });
    const stale = await helloHttp(server, DOC, 'a', key);
    expect(stale.status).toBe(200);
    const oldProtocol = await call(server, 'POST', `/documents/${DOC}/hello`, {
      body: { ...hello('a'), protocol: 0 },
      key,
    });
    expect(oldProtocol).toMatchObject({ status: 400, body: { code: 'protocol-version' } });
    expect((oldProtocol.body as { messages: { message: string }[] }).messages[0]!.message).toMatch(
      /update the app/,
    );
    const unknownDoc = await submitHttp(server, DOC + 'x', key, submit([e], 1));
    expect(unknownDoc.status).toBe(404);
    expect(stateOf(dbPath)).toBe(before);
  });

  it('refuses a body over the limit and too many created ids', async () => {
    await server.close();
    server = await start(dbPath, {
      limits: { maxBodyBytes: 64 * 1024, maxEntryBytes: 8 * 1024, maxCreatedIdsPerSubmit: 5 },
    });
    const key = await ready('a');
    const doc = baseDocument();
    const before = stateOf(dbPath);
    const e = entry(doc, setVariable('x', '1'), { clientId: 'a', clientSeq: 1 });
    const padded = (n: number) => ({ ...e, command: { ...e.command, pad: 'x'.repeat(n) } });
    const body = await submitHttp(server, DOC, key, submit([padded(70_000)], 1));
    expect(body).toMatchObject({ status: 413, body: { code: 'too-large' } });
    // A sketch creates seven ids: sketch#1, e1 to e4, k1 and k2.
    const ids = await submitHttp(
      server,
      DOC,
      key,
      submit([entry(doc, addSketch(doc), { clientId: 'a', clientSeq: 1 })], 1),
    );
    expect(ids).toMatchObject({ status: 413, body: { code: 'too-many-ids' } });
    expect(stateOf(dbPath)).toBe(before);
  });

  it('refuses an entry over its limit on its own, typed, and judges the entries after it', async () => {
    await server.close();
    server = await start(dbPath, { limits: { maxEntryBytes: 8 * 1024 } });
    const key = await ready('a');
    const doc = baseDocument();
    const small = entry(doc, setVariable('x', '1'), { clientId: 'a', clientSeq: 1 });
    const big = entry(doc, setVariable('y', '1'), { clientId: 'a', clientSeq: 2 });
    const padded = { ...big, label: 'big', command: { ...big.command, pad: 'x'.repeat(10_000) } };
    // Built on the big one: refused as its successor, as for any refusal.
    const after = entry(doc, setVariable('z', '1'), { clientId: 'a', clientSeq: 3, prevSeq: 2 });
    const r = await submitHttp(server, DOC, key, submit([small, padded, after], 1));
    expect(r).toMatchObject({
      status: 200,
      body: {
        messages: [
          { type: 'ack', clientSeq: 1, rev: 1 },
          { type: 'refuse', clientSeq: 2, error: { code: 'entry-too-large' }, headRev: 1 },
          { type: 'refuse', clientSeq: 3, error: { code: 'predecessor-refused' } },
        ],
      },
    });
    // Recorded: a resend gets the same answer, not a protocol error.
    const again = await submitHttp(server, DOC, key, submit([padded], 1));
    expect(again.body.messages).toEqual([
      expect.objectContaining({
        type: 'refuse',
        error: expect.objectContaining({ code: 'entry-too-large' }),
      }),
    ]);
  });

  it('answers an oversized entry on a WebSocket with a refusal the client drops, then syncs on', async () => {
    await server.close();
    server = await start(dbPath, { limits: { maxEntryBytes: 8 * 1024 } });
    await createDoc(server);
    const snap = (
      await call<{ rev: number; document: ManufaktureDocument }>(
        server,
        'GET',
        `/documents/${DOC}/snapshot`,
      )
    ).body;
    // The app's own limit is the default (12 MiB): the server's lower one refuses the entry.
    const a = new Connected(
      new SyncClient(snap.document, snap.rev, { clientId: 'a', now: () => AT }),
      server,
      DOC,
    );
    const dropped: string[] = [];
    a.client.on('dropped', ({ drops }) => {
      for (const d of drops) dropped.push(`${d.label}: ${d.error.code}`);
    });
    await a.open();
    ok(a.client.submit({ command: setVariable('small', '1'), label: 'small' }));
    const long = `1.${'0'.repeat(9000)}`;
    ok(a.client.submit({ command: setVariable('big', long), label: 'big' }));
    ok(a.client.submit({ command: setVariable('later', '2'), label: 'later' }));
    const settled = () => a.client.pending.length === 0 && a.client.confirmedRevision === 2;
    for (let i = 0; i < 500 && !settled(); i++) {
      a.pump();
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(a.errors).toEqual([]);
    expect(settled()).toBe(true);
    expect(dropped).toEqual(['big: entry-too-large']);
    const names = a.client.document.variables.map((v) => v.name);
    expect(names).toEqual(expect.arrayContaining(['small', 'later']));
    expect(names).not.toContain('big');
    a.socket.close();
  });

  it('limits the rows a client keeps and the entries it sends per minute', async () => {
    await server.close();
    server = await start(dbPath, { limits: { maxRowsPerClient: 3, entriesPerMinute: 5 } });
    const key = await ready('a');
    let doc = baseDocument();
    const chain = [];
    for (let i = 1; i <= 6; i++) {
      const command = setVariable(`v${i}`, String(i));
      chain.push(
        entry(doc, command, { clientId: 'a', clientSeq: i, ...(i > 1 && { prevSeq: i - 1 }) }),
      );
      doc = ok(applyCommand(doc, command)).document;
    }
    expect((await submitHttp(server, DOC, key, submit(chain.slice(0, 3), 1))).status).toBe(200);
    const before = stateOf(dbPath);
    // Floor 1 keeps rows 1 to 3: a fourth row is one too many.
    const tooMany = await submitHttp(server, DOC, key, submit([chain[3]!], 1));
    expect(tooMany).toMatchObject({ status: 429, body: { code: 'too-many-rows' } });
    expect(stateOf(dbPath)).toBe(before);
    // Raising the floor resolves it.
    expect((await submitHttp(server, DOC, key, submit([chain[3]!], 4))).status).toBe(200);
    expect((await submitHttp(server, DOC, key, submit([chain[4]!], 5))).status).toBe(200);
    // Five entries were sent this minute; the sixth waits.
    const limited = await submitHttp(server, DOC, key, submit([chain[5]!], 6));
    expect(limited).toMatchObject({ status: 429, body: { code: 'rate-limited' } });
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
  });

  it('stops judging a submit when its time budget is spent; the rest stay unanswered', async () => {
    await server.close();
    let t = 0;
    server = await start(dbPath, { limits: { validationBudgetMs: 15 }, now: () => (t += 10) });
    const key = await ready('a');
    let doc = baseDocument();
    const chain = [];
    for (let i = 1; i <= 4; i++) {
      const command = setVariable(`v${i}`, String(i));
      chain.push(
        entry(doc, command, { clientId: 'a', clientSeq: i, ...(i > 1 && { prevSeq: i - 1 }) }),
      );
      doc = ok(applyCommand(doc, command)).document;
    }
    const r = await submitHttp(server, DOC, key, submit(chain, 1));
    expect(r.status).toBe(200);
    expect(r.body.messages!.length).toBeGreaterThanOrEqual(1);
    expect(r.body.messages!.length).toBeLessThan(4);
    const answered = r.body.messages!.length;
    expect(rows(dbPath, 'a')).toEqual(chain.slice(0, answered).map((e) => e.clientSeq));
    // Resending gets the rest judged.
    const again = await submitHttp(server, DOC, key, submit(chain.slice(answered), answered + 1));
    expect(again.body.messages![0]).toMatchObject({ type: 'ack', clientSeq: answered + 1 });
  });

  it('WebSocket: refuses binary frames, answers bad JSON, and closes a socket that never says hello', async () => {
    await server.close();
    server = await start(dbPath, { limits: { helloTimeoutMs: 100 } });
    await createDoc(server);
    const quiet = new Socket(server, DOC, { key: clientKey() });
    await quiet.open();
    await until(() => quiet.closed !== undefined, 5_000, 'hello timeout');
    expect(quiet.closed!.code).toBe(4408);
    const s = new Socket(server, DOC, { key: clientKey() });
    await s.open();
    s.send('{nope');
    expect(await s.next()).toMatchObject({ type: 'error', code: 'invalid-message' });
    s.send({ type: 'pull', since: 0 });
    expect(await s.next()).toMatchObject({ type: 'error', message: 'Send a hello first' });
    s.send({ ...hello('a'), protocol: 99 });
    expect(await s.next()).toMatchObject({ type: 'error', code: 'protocol-version' });
    await until(() => s.closed !== undefined, 5_000, 'close');
    const nodoc = new Socket(server, 'missing', { key: clientKey() });
    await until(() => nodoc.closed !== undefined || nodoc.failed, 5_000, 'close');
  });

  it('stores and serves blobs by hash; refuses a wrong hash, an unknown blob and an oversized one', async () => {
    const bytes = new TextEncoder().encode('ISO-10303-21; a small STEP file');
    const sha = createHash('sha256').update(bytes).digest('hex');
    const put = (name: string, body: Uint8Array) =>
      call(server, 'PUT', `/blobs/${name}`, {
        raw: body,
        headers: { 'content-type': 'application/octet-stream' },
      });
    expect((await put(sha, bytes)).status).toBe(201);
    expect((await put(sha, bytes)).status).toBe(200);
    const res = await fetch(`${server.url}/blobs/${sha}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
    const before = stateOf(dbPath);
    const wrong = await put('0'.repeat(64), bytes);
    expect(wrong).toMatchObject({ status: 400, body: { code: 'hash-mismatch' } });
    expect((await put('NOT-A-HASH', bytes)).status).toBe(400);
    expect((await call(server, 'GET', `/blobs/${'1'.repeat(64)}`)).status).toBe(404);
    const json = await call(server, 'PUT', `/blobs/${sha}`, { body: { x: 1 } });
    expect(json.status).toBe(415);
    await server.close();
    server = await start(dbPath, { limits: { maxBlobBytes: 8 } });
    const tooBig = await put(sha, bytes);
    expect(tooBig.status).toBe(413);
    expect(stateOf(dbPath)).toBe(before);
  });
});
