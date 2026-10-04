import { readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { applyCommand } from '@manufakture/core';
import type { ServerMessage } from '@manufakture/sync';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SUBPROTOCOL, splitPush } from '../src/app';
import { DEFAULT_LIMITS, checkJsonShape } from '../src/limits';
import { SyncService } from '../src/service';
import { SqliteStore } from '../src/sqlite';
import {
  ORIGIN,
  Socket,
  TOKEN,
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
  until,
  type Running,
} from './helpers';

/**
 * The mitigations the M7 threat model (T7.6a) cites: timeouts, poisoned keys, the Origin check on
 * upgrades, fixed error messages, the pull byte cap and idle eviction of cached heads.
 */

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

function ok<T>(r: { ok: true; value: T } | { ok: false; error: { message: string } }): T {
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

/** `n` chained entries of client `a`, each setting its own variable to a `pad`-long value. */
function chain(n: number, pad = 0) {
  let doc = baseDocument();
  const out = [];
  for (let i = 1; i <= n; i++) {
    const command = setVariable(`v${i}`, String(i));
    const e = entry(doc, command, {
      clientId: 'a',
      clientSeq: i,
      ...(i > 1 && { prevSeq: i - 1 }),
    });
    out.push({ ...e, label: 'x'.repeat(pad) });
    doc = ok(applyCommand(doc, command)).document;
  }
  return out;
}

/** An upgrade request by hand, so the test controls the Origin header. */
function upgrade(origin: string | undefined): Promise<number> {
  const address = server.app.server.address();
  if (address === null || typeof address === 'string') throw new Error('no address');
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      // A fresh connection each time: a refused upgrade closes its connection.
      agent: false,
      host: '127.0.0.1',
      port: address.port,
      path: `/api/documents/${DOC}/socket`,
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': Buffer.from('0123456789abcdef').toString('base64'),
        'sec-websocket-protocol': `${SUBPROTOCOL}, bearer.${TOKEN}, client.${clientKey()}`,
        ...(origin !== undefined && { origin }),
      },
    });
    req.on('response', (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('upgrade', (res, socket) => {
      socket.destroy();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
}

describe('timeouts', () => {
  it('sets request, connection and keep-alive timeouts from the limits', async () => {
    await server.close();
    server = await start(dbPath, {
      limits: { requestTimeoutMs: 7_000, connectionTimeoutMs: 9_000, keepAliveTimeoutMs: 3_000 },
    });
    expect(server.app.server.requestTimeout).toBe(7_000);
    expect(server.app.server.timeout).toBe(9_000);
    expect(server.app.server.keepAliveTimeout).toBe(3_000);
    expect(DEFAULT_LIMITS.requestTimeoutMs).toBeGreaterThan(0);
    expect(DEFAULT_LIMITS.connectionTimeoutMs).toBeGreaterThan(0);
  });

  it('does not cut a WebSocket that is quiet for longer than the connection timeout', async () => {
    await server.close();
    server = await start(dbPath, { limits: { connectionTimeoutMs: 200 } });
    await createDoc(server);
    const s = new Socket(server, DOC, { key: clientKey() });
    await s.open();
    s.send(hello('a'));
    expect(await s.next()).toMatchObject({ type: 'welcome' });
    await new Promise((r) => setTimeout(r, 600));
    expect(s.closed).toBeUndefined();
    s.send({ type: 'pull', since: 0 });
    expect(await s.next()).toMatchObject({ type: 'push', entries: [] });
    s.close();
  });
});

describe('poisoned keys', () => {
  it('are found at any depth, as Fastify finds them in bodies', () => {
    const limits = [64, 1_000] as const;
    expect(checkJsonShape(JSON.parse('{"a":[{"__proto__":{"x":1}}]}'), ...limits)).toMatchObject({
      ok: false,
      forbiddenKey: true,
    });
    expect(
      checkJsonShape(JSON.parse('{"constructor":{"prototype":{"x":1}}}'), ...limits),
    ).toMatchObject({ ok: false, forbiddenKey: true });
    // Plain data: a parameter may be called constructor or prototype.
    expect(checkJsonShape({ constructor: 1, prototype: { a: 1 } }, ...limits)).toEqual({
      ok: true,
    });
  });

  it('are refused in WebSocket messages, before and after the hello, and change nothing', async () => {
    await createDoc(server);
    const s = new Socket(server, DOC, { key: clientKey() });
    await s.open();
    const helloText = JSON.stringify(hello('a'));
    s.send(helloText.replace('{', '{"__proto__":{"polluted":true},'));
    expect(await s.next()).toEqual({
      type: 'error',
      code: 'invalid-message',
      message: 'The message holds a forbidden key',
    });
    s.send(hello('a'));
    expect(await s.next()).toMatchObject({ type: 'welcome' });
    const e = chain(1)[0]!;
    const text = JSON.stringify(submit([e], 1)).replace(
      '"command":{',
      '"command":{"constructor":{"prototype":{"polluted":true}},',
    );
    s.send(text);
    expect(await s.next()).toMatchObject({
      type: 'error',
      message: 'The message holds a forbidden key',
    });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    const snap = await call<{ rev: number }>(server, 'GET', `/documents/${DOC}/snapshot`);
    expect(snap.body.rev).toBe(0);
    s.close();
  });

  it('are refused in HTTP bodies with a 400', async () => {
    await createDoc(server);
    const key = clientKey();
    expect((await helloHttp(server, DOC, 'a', key)).status).toBe(200);
    const r = await call(server, 'POST', `/documents/${DOC}/entries`, {
      raw: '{"type":"submit","constructor":{"prototype":{"x":1}}}',
      key,
      headers: { 'content-type': 'application/json' },
    });
    expect(r.status).toBe(400);
  });
});

describe('WebSocket origin', () => {
  it('refuses an upgrade from an origin that is not configured, with the token', async () => {
    await createDoc(server);
    expect(await upgrade('https://evil.example.test')).toBe(403);
    expect(await upgrade('null')).toBe(403);
    expect(await upgrade(ORIGIN)).toBe(101);
    // No Origin at all: not a browser, so the token alone decides.
    expect(await upgrade(undefined)).toBe(101);
  });
});

describe('error messages', () => {
  const MARK = 'ECHO_MARK_7f3a';

  it('never quote the request', async () => {
    await createDoc(server);
    const key = clientKey();
    expect((await helloHttp(server, DOC, 'a', key)).status).toBe(200);
    const path = `/documents/${DOC}/entries`;
    const syntax = await call(server, 'POST', path, {
      raw: `{"type":"submit",${MARK}`,
      key,
      headers: { 'content-type': 'application/json' },
    });
    expect(syntax.status).toBe(400);
    const extraKey = await submitHttp(server, DOC, key, {
      ...submit(chain(1), 1),
      [MARK]: 1,
    });
    expect(extraKey.status).toBe(400);
    const badDoc = await call(server, 'POST', '/documents', {
      body: { document: { ...baseDocument('doc-2'), name: 5, [MARK]: MARK } },
    });
    expect(badDoc.status).toBe(400);
    const media = await call(server, 'POST', path, {
      raw: MARK,
      key,
      headers: { 'content-type': `text/${MARK}` },
    });
    expect(media.status).toBe(415);
    for (const r of [syntax, extraKey, badDoc, media]) {
      expect(JSON.stringify(r.body)).not.toContain(MARK);
    }

    const s = new Socket(server, DOC, { key: clientKey() });
    await s.open();
    s.send(hello('b'));
    expect(await s.next()).toMatchObject({ type: 'welcome' });
    s.send({ type: MARK });
    s.send({ type: 'pull', since: MARK });
    s.send(`{"type":"submit",${MARK}`);
    const answers: ServerMessage[] = [await s.next(), await s.next(), await s.next()];
    expect(answers.every((m) => m.type === 'error')).toBe(true);
    expect(JSON.stringify(answers)).not.toContain(MARK);
    s.close();
  });
});

describe('pull byte cap', () => {
  it('answers a pull with entries up to the cap, at least one, and the rest on the next pull', async () => {
    // Five entries of about 1 KB each, and a cap of two and a half of them.
    const entries = chain(5, 900);
    const size = Buffer.byteLength(JSON.stringify(entries[0]));
    await server.close();
    server = await start(dbPath, { limits: { maxPullBytes: Math.floor(size * 2.5) } });
    await createDoc(server);
    const key = clientKey();
    expect((await helloHttp(server, DOC, 'a', key)).status).toBe(200);
    const r = await submitHttp(server, DOC, key, submit(entries, 1));
    expect(r.body.messages!.filter((m) => m.type === 'ack')).toHaveLength(5);
    const revs: number[] = [];
    let since = 0;
    let pulls = 0;
    for (; pulls < 10 && since < 5; pulls++) {
      const p = await call<{ messages: ServerMessage[] }>(
        server,
        'GET',
        `/documents/${DOC}/entries?since=${since}`,
      );
      const push = p.body.messages[0]!;
      if (push.type !== 'push') throw new Error('expected a push');
      expect(push.entries.length).toBeGreaterThanOrEqual(1);
      expect(push.entries.length).toBeLessThanOrEqual(2);
      revs.push(...push.entries.map((e) => e.rev));
      since = push.entries.at(-1)!.rev;
    }
    expect(revs).toEqual([1, 2, 3, 4, 5]);
    expect(pulls).toBe(3);

    // An entry larger than the cap still comes, alone.
    await server.close();
    server = await start(dbPath, { limits: { maxPullBytes: 10 } });
    const one = await call<{ messages: ServerMessage[] }>(
      server,
      'GET',
      `/documents/${DOC}/entries?since=0`,
    );
    expect(one.body.messages[0]).toMatchObject({ type: 'push', entries: [{ rev: 1 }] });
  });
});

describe('what the app can receive', () => {
  /** The app's `MAX_INBOUND_BYTES`, read from its source (the server does not depend on the app). */
  function appInboundBytes(): number {
    const source = readFileSync(
      new URL('../../web/src/sync/transport.ts', import.meta.url),
      'utf8',
    );
    const m = /export const MAX_INBOUND_BYTES = ([\d\s*]+);/.exec(source);
    if (m === null) throw new Error('MAX_INBOUND_BYTES not found in the app');
    return m[1]!.split('*').reduce((a, b) => a * Number(b.trim()), 1);
  }

  it('the default entry and pull caps leave headroom under the app inbound limit', () => {
    const inbound = appInboundBytes();
    expect(inbound).toBe(16 * 1024 * 1024);
    // The wrapper of a full pull: under 40 bytes per entry, 1000 entries.
    const wrapper = 40 * 1000 + 64;
    expect(DEFAULT_LIMITS.maxPullBytes).toBeLessThanOrEqual(inbound / 2);
    expect(DEFAULT_LIMITS.maxPullBytes + wrapper).toBeLessThan(inbound);
    expect(DEFAULT_LIMITS.maxEntryBytes + wrapper).toBeLessThan(inbound);
  });

  it('cuts a large push into pushes no bigger than the pull cap', () => {
    const entries = chain(6, 900).map((entry, i) => ({ rev: i + 1, entry }));
    const size = Buffer.byteLength(JSON.stringify(entries[0]!.entry));
    const parts = splitPush({ type: 'push', entries }, Math.floor(size * 2.5));
    expect(parts.map((p) => p.entries.map((e) => e.rev))).toEqual([
      [1, 2],
      [3, 4],
      [5, 6],
    ]);
    // One entry over the cap still goes, alone; an empty push stays one push.
    expect(splitPush({ type: 'push', entries }, 1)).toHaveLength(6);
    expect(splitPush({ type: 'push', entries: [] }, 1)).toEqual([{ type: 'push', entries: [] }]);
  });
});

describe('idle eviction', () => {
  it('drops heads and rate buckets unused for the idle time, and loads them again on use', async () => {
    await createDoc(server);
    const key = clientKey();
    expect((await helloHttp(server, DOC, 'a', key)).status).toBe(200);
    expect((await submitHttp(server, DOC, key, submit(chain(2), 1))).status).toBe(200);
    await server.close();

    const store = new SqliteStore(dbPath);
    let loads = 0;
    const load = store.loadBranch.bind(store);
    store.loadBranch = (documentId, branch) => {
      loads += 1;
      return load(documentId, branch);
    };
    let t = 1_000_000;
    const service = new SyncService(store, {
      limits: DEFAULT_LIMITS,
      now: () => t,
      idleEvictMs: 60_000,
    });
    try {
      expect(service.snapshot(DOC)?.rev).toBe(2);
      expect(service.cached()).toEqual({ branches: 1, buckets: 0 });
      expect(loads).toBe(1);
      t += 30_000;
      expect(service.snapshot(DOC)?.rev).toBe(2);
      expect(loads).toBe(1); // still cached, and its idle time starts again
      t += 50_000;
      expect(service.snapshot(DOC)?.rev).toBe(2);
      expect(loads).toBe(1);
      // A minute with no use, then any request: the sweep drops it.
      t += 61_000;
      service.snapshot('missing');
      expect(service.cached().branches).toBe(0);
      expect(service.snapshot(DOC)?.rev).toBe(2);
      expect(loads).toBe(3); // `missing` tried the store too; DOC was loaded again
      expect(service.cached().branches).toBe(1);
    } finally {
      store.close();
    }
  });

  it('keeps answering correctly after an eviction, with nothing lost', async () => {
    await server.close();
    let t = 5_000_000;
    const store = new SqliteStore(dbPath);
    const { buildApp } = await import('../src/app');
    const service = new SyncService(store, {
      limits: DEFAULT_LIMITS,
      now: () => t,
      idleEvictMs: 1_000,
    });
    const app = await buildApp({
      token: TOKEN,
      store,
      limits: DEFAULT_LIMITS,
      origins: [],
      service,
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (address === null || typeof address === 'string') throw new Error('no address');
    const url = `http://127.0.0.1:${address.port}/api`;
    server = {
      app,
      store,
      url,
      wsUrl: url.replace(/^http/, 'ws'),
      async close() {
        await app.close();
        store.close();
      },
    };
    await createDoc(server);
    const key = clientKey();
    expect((await helloHttp(server, DOC, 'a', key)).status).toBe(200);
    const entries = chain(3);
    expect((await submitHttp(server, DOC, key, submit(entries.slice(0, 2), 1))).status).toBe(200);
    expect(service.cached()).toEqual({ branches: 1, buckets: 1 });
    t += 5_000;
    service.snapshot('missing');
    expect(service.cached()).toEqual({ branches: 0, buckets: 0 });
    const r = await submitHttp(server, DOC, key, submit([entries[2]!], 1));
    expect(r.body.messages).toEqual([{ type: 'ack', clientSeq: 3, rev: 3 }]);
    await until(() => service.cached().branches === 1, 1_000, 'reload');
  });
});
