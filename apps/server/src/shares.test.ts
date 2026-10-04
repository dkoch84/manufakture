import { request as httpRequest } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from './app';
import { loadConfig } from './config';
import { DEFAULT_LIMITS } from './limits';
import {
  DEFAULT_SHARE_CONFIG,
  SHARE_ID,
  SHARE_MIME,
  SqliteShareStore,
  cleanName,
  newShareId,
  parseExpiry,
  type ShareConfig,
  type ShareInfo,
} from './shares';
import { SqliteStore } from './sqlite';

const TOKEN = 'share-test-token-0123456789abcdefghijklmnopqrstuvwxyz';
const APP = 'https://app.example.test';
const VIEWER = 'https://view.example.test';
const DAY = 24 * 60 * 60 * 1000;

/** A tiny stand-in bundle: a zip's local file header and some bytes (the server checks no more). */
function bundle(size = 64): Buffer {
  const b = Buffer.alloc(size, 7);
  b.writeUInt32LE(0x04034b50, 0);
  return b;
}

interface Server {
  app: FastifyInstance;
  url: string;
  port: number;
  clock: { t: number };
  close(): Promise<void>;
}

let dir: string;
let server: Server;

async function start(config: Partial<ShareConfig> = {}): Promise<Server> {
  const store = new SqliteStore(join(dir, `s-${Math.random()}.db`));
  const clock = { t: Date.parse('2026-10-04T12:00:00Z') };
  const app = await buildApp({
    token: TOKEN,
    store,
    limits: DEFAULT_LIMITS,
    origins: [APP],
    shares: {
      store: new SqliteShareStore(store.database),
      config: { ...DEFAULT_SHARE_CONFIG, viewerOrigins: [VIEWER], ...config },
      now: () => clock.t,
    },
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (address === null || typeof address === 'string') throw new Error('no address');
  return {
    app,
    port: address.port,
    url: `http://127.0.0.1:${address.port}/api`,
    clock,
    async close() {
      await app.close();
      store.close();
    },
  };
}

function auth(token = TOKEN) {
  return { authorization: `Bearer ${token}` };
}

async function create(
  query = '',
  body: Buffer = bundle(),
  headers: Record<string, string> = { ...auth(), 'content-type': SHARE_MIME },
): Promise<{ status: number; body: ShareInfo & { code?: string } }> {
  const res = await fetch(`${server.url}/shares${query}`, {
    method: 'POST',
    headers,
    body: new Uint8Array(body),
  });
  return { status: res.status, body: (await res.json()) as ShareInfo & { code?: string } };
}

async function list(): Promise<{ shares: ShareInfo[]; limits: Record<string, unknown> }> {
  const res = await fetch(`${server.url}/shares`, { headers: auth() });
  expect(res.status).toBe(200);
  return (await res.json()) as { shares: ShareInfo[]; limits: Record<string, unknown> };
}

const read = (id: string, headers: Record<string, string> = {}) =>
  fetch(`${server.url}/shares/${id}`, { headers });

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mfk-shares-'));
  server = await start();
});

afterEach(async () => {
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('share ids', () => {
  it('are 128 random bits, base64url, never repeated', () => {
    const ids = Array.from({ length: 4000 }, newShareId);
    expect(new Set(ids).size).toBe(ids.length);
    let ones = 0;
    for (const id of ids) {
      expect(id).toMatch(SHARE_ID);
      const raw = Buffer.from(id, 'base64url');
      expect(raw.length).toBe(16);
      for (const byte of raw) for (let b = byte; b; b >>= 1) ones += b & 1;
    }
    // Half of the 512,000 bits are set, within far less than 1% (about 0.3% is 4 sigma).
    expect(Math.abs(ones / (ids.length * 128) - 0.5)).toBeLessThan(0.005);
  });
});

describe('creating and reading', () => {
  it('stores a bundle and serves it to anyone with the link, safely labelled', async () => {
    const body = bundle(1000);
    const c = await create('?name=Bracket');
    expect(c.status).toBe(201);
    expect(c.body.id).toMatch(SHARE_ID);
    expect(c.body).toMatchObject({ name: 'Bracket', size: 64 });
    const c2 = await create('', body);
    expect(c2.body.id).not.toBe(c.body.id);

    const res = await read(c2.body.id);
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).equals(body)).toBe(true);
    expect(res.headers.get('content-type')).toBe(SHARE_MIME);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-disposition')).toMatch(/^attachment/);
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('set-cookie')).toBeNull();

    const head = await fetch(`${server.url}/shares/${c2.body.id}`, { method: 'HEAD' });
    expect(head.status).toBe(200);
  });

  it('needs the token for everything but the download', async () => {
    const c = await create();
    const noToken = { 'content-type': SHARE_MIME };
    expect((await create('', bundle(), noToken)).status).toBe(401);
    expect(
      (await create('', bundle(), { ...auth('x'.repeat(48)), 'content-type': SHARE_MIME })).status,
    ).toBe(401);
    expect((await fetch(`${server.url}/shares`)).status).toBe(401);
    const del = await fetch(`${server.url}/shares/${c.body.id}`, { method: 'DELETE' });
    expect(del.status).toBe(401);
    expect((await read(c.body.id)).status).toBe(200);
  });

  it('answers unknown and malformed ids with the same 404', async () => {
    for (const id of [newShareId(), 'short', 'a'.repeat(23), '..%2F..%2Fx', `${newShareId()}.x`]) {
      const res = await read(id);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ code: 'not-found', message: 'No such share' });
    }
  });

  it('refuses anything but a bundle', async () => {
    expect((await create('', Buffer.from('<html>hi</html>'))).status).toBe(400);
    expect((await create('', bundle(), { ...auth(), 'content-type': 'text/html' })).status).toBe(
      415,
    );
    expect((await list()).shares).toHaveLength(0);
  });

  it('keeps names short and plain', () => {
    expect(cleanName('  a\u0000b\nc  ')).toBe('a b c');
    expect(cleanName('')).toBe('Shared view');
    expect([...cleanName('x'.repeat(500))]).toHaveLength(200);
  });
});

describe('expiry', () => {
  it('defaults to 30 days and is enforced on read and in the list', async () => {
    const c = await create();
    expect(Date.parse(c.body.expiresAt!) - Date.parse(c.body.createdAt)).toBe(30 * DAY);
    server.clock.t += 30 * DAY - 1;
    expect((await read(c.body.id)).status).toBe(200);
    server.clock.t += 1;
    expect((await read(c.body.id)).status).toBe(404);
    expect((await list()).shares).toHaveLength(0);
  });

  it('takes a number of days, or never', async () => {
    const week = await create('?expires=7');
    const never = await create('?expires=never');
    expect(Date.parse(week.body.expiresAt!) - Date.parse(week.body.createdAt)).toBe(7 * DAY);
    expect(never.body.expiresAt).toBeNull();
    server.clock.t += 100 * 365 * DAY;
    expect((await read(week.body.id)).status).toBe(404);
    expect((await read(never.body.id)).status).toBe(200);
    expect((await list()).shares.map((s) => s.id)).toEqual([never.body.id]);
  });

  it('refuses bad values, and never when the server does not allow it', async () => {
    for (const q of ['0', '-1', '3651', '1.5', 'soon', '1e3']) {
      expect((await create(`?expires=${q}`)).status, q).toBe(400);
    }
    await server.close();
    server = await start({ allowNever: false, defaultExpiryDays: 2 });
    expect((await create('?expires=never')).status).toBe(400);
    const c = await create();
    expect(Date.parse(c.body.expiresAt!) - Date.parse(c.body.createdAt)).toBe(2 * DAY);
    expect(parseExpiry(undefined, { defaultExpiryDays: 5, allowNever: true })).toEqual({
      ok: true,
      days: 5,
    });
  });
});

describe('limits', () => {
  it('caps active shares per token, counting only unexpired ones', async () => {
    await server.close();
    server = await start({ maxShares: 2 });
    const a = await create('?expires=1');
    await create();
    const full = await create();
    expect(full.status).toBe(409);
    expect(full.body.code).toBe('too-many-shares');
    // An expired share frees its place.
    server.clock.t += DAY;
    expect((await create()).status).toBe(201);
    expect((await read(a.body.id)).status).toBe(404);
    expect((await create()).status).toBe(409);
    // So does a revoked one.
    const [first] = (await list()).shares;
    await fetch(`${server.url}/shares/${first!.id}`, { method: 'DELETE', headers: auth() });
    expect((await create()).status).toBe(201);
    expect((await list()).limits).toMatchObject({ maxShares: 2, maxBytes: 50 * 1024 * 1024 });
  });

  it('refuses a bundle over the size cap, declared or streamed', async () => {
    await server.close();
    server = await start({ maxBytes: 1000 });
    expect((await create('', bundle(1000))).status).toBe(201);
    const over = await create('', bundle(1001));
    expect(over.status).toBe(413);
    expect(over.body.code).toBe('too-large');
    expect((await list()).shares).toHaveLength(1);
  });

  it('answers 413 while a chunked body is still arriving, without waiting for its end', async () => {
    await server.close();
    server = await start({ maxBytes: 1000 });
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port: server.port,
          method: 'POST',
          path: '/api/shares',
          headers: { ...auth(), 'content-type': SHARE_MIME, 'transfer-encoding': 'chunked' },
        },
        (res) => {
          resolve(res.statusCode ?? 0);
          res.resume();
          req.destroy();
        },
      );
      req.on('error', (e) => (e.message.includes('socket hang up') ? undefined : reject(e)));
      // 2 KB now, and a promise of much more that never comes: only a streaming check answers.
      req.write(bundle(2048));
    });
    expect(status).toBe(413);
    expect((await list()).shares).toHaveLength(0);
  });

  it('checks the count before taking the upload', async () => {
    await server.close();
    server = await start({ maxShares: 1, maxBytes: 1000 });
    await create();
    // Over the count and over the size: the count answers, so the body was never read.
    const r = await create('', bundle(5000));
    expect(r.status).toBe(409);
  });
});

describe('revoking', () => {
  it('removes the share for good', async () => {
    const c = await create();
    const del = await fetch(`${server.url}/shares/${c.body.id}`, {
      method: 'DELETE',
      headers: auth(),
    });
    expect(del.status).toBe(204);
    expect((await read(c.body.id)).status).toBe(404);
    expect((await list()).shares).toHaveLength(0);
    const again = await fetch(`${server.url}/shares/${c.body.id}`, {
      method: 'DELETE',
      headers: auth(),
    });
    expect(again.status).toBe(404);
  });
});

describe('CORS', () => {
  it('lets only the viewer origin read a share', async () => {
    const c = await create();
    const fromViewer = await read(c.body.id, { origin: VIEWER });
    expect(fromViewer.headers.get('access-control-allow-origin')).toBe(VIEWER);
    expect(fromViewer.headers.get('access-control-allow-credentials')).toBeNull();
    for (const origin of [APP, 'https://evil.example.test']) {
      const r = await read(c.body.id, { origin });
      expect(r.status).toBe(200);
      expect(r.headers.get('access-control-allow-origin')).toBeNull();
    }
  });

  it('lets only the app origin manage shares, DELETE included', async () => {
    const pre = (origin: string, method: string, path = '/shares') =>
      fetch(`${server.url}${path}`, {
        method: 'OPTIONS',
        headers: {
          origin,
          'access-control-request-method': method,
          'access-control-request-headers': 'authorization',
        },
      });
    const del = await pre(APP, 'DELETE', `/shares/${newShareId()}`);
    expect(del.headers.get('access-control-allow-origin')).toBe(APP);
    expect(del.headers.get('access-control-allow-methods')).toContain('DELETE');
    expect((await pre(VIEWER, 'POST')).headers.get('access-control-allow-origin')).toBeNull();
    expect(
      (await pre(VIEWER, 'DELETE', `/shares/${newShareId()}`)).headers.get(
        'access-control-allow-origin',
      ),
    ).toBeNull();
    const get = await pre(VIEWER, 'GET', `/shares/${newShareId()}`);
    expect(get.headers.get('access-control-allow-origin')).toBe(VIEWER);
    expect(get.headers.get('access-control-allow-headers') ?? '').not.toMatch(/authorization/i);
  });
});

describe('without shares', () => {
  it('has no share routes', async () => {
    const store = new SqliteStore(join(dir, 'plain.db'));
    const app = await buildApp({ token: TOKEN, store, limits: DEFAULT_LIMITS, origins: [APP] });
    const r = await app.inject({ method: 'GET', url: `/api/shares/${newShareId()}` });
    expect(r.statusCode).toBe(404);
    const listed = await app.inject({ method: 'GET', url: '/api/shares', headers: auth() });
    expect(listed.statusCode).toBe(404);
    await app.close();
    store.close();
  });
});

describe('configuration', () => {
  const base = { MANUFAKTURE_TOKEN: 'a'.repeat(40), MANUFAKTURE_ORIGINS: APP };

  it('ships the decided defaults, with the viewer on the app origins', () => {
    expect(loadConfig(base).shares).toEqual({
      maxBytes: 50 * 1024 * 1024,
      maxShares: 100,
      defaultExpiryDays: 30,
      allowNever: true,
      maxConcurrentReads: 8,
      viewerOrigins: [APP],
    });
  });

  it('reads every setting, and can switch shares off', () => {
    expect(
      loadConfig({
        ...base,
        MANUFAKTURE_SHARE_MAX_BYTES: '1000',
        MANUFAKTURE_SHARE_MAX_COUNT: '3',
        MANUFAKTURE_SHARE_EXPIRY_DAYS: '7',
        MANUFAKTURE_SHARE_ALLOW_NEVER: 'off',
        MANUFAKTURE_SHARE_MAX_CONCURRENT_READS: '2',
        MANUFAKTURE_VIEWER_ORIGINS: VIEWER,
      }).shares,
    ).toEqual({
      maxBytes: 1000,
      maxShares: 3,
      defaultExpiryDays: 7,
      allowNever: false,
      maxConcurrentReads: 2,
      viewerOrigins: [VIEWER],
    });
    expect(loadConfig({ ...base, MANUFAKTURE_SHARES: 'off' }).shares).toBeNull();
    expect(() => loadConfig({ ...base, MANUFAKTURE_SHARE_MAX_COUNT: '0' })).toThrow(
      /MANUFAKTURE_SHARE_MAX_COUNT/,
    );
    expect(() => loadConfig({ ...base, MANUFAKTURE_SHARE_EXPIRY_DAYS: '9999' })).toThrow(
      /MANUFAKTURE_SHARE_EXPIRY_DAYS/,
    );
    expect(() => loadConfig({ ...base, MANUFAKTURE_VIEWER_ORIGINS: '*' })).toThrow(
      /MANUFAKTURE_VIEWER_ORIGINS/,
    );
    expect(() => loadConfig({ ...base, MANUFAKTURE_SHARES: 'maybe' })).toThrow(
      /MANUFAKTURE_SHARES/,
    );
  });
});
