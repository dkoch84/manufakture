import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyCommand } from '@manufakture/core';
import Database from 'better-sqlite3';
import { build } from 'vite';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ORIGIN,
  TOKEN,
  baseDocument,
  call,
  clientKey,
  createDoc,
  entry,
  helloHttp,
  setVariable,
  start,
  submit,
  submitHttp,
  tempDir,
  type Running,
} from './helpers';

const here = dirname(fileURLToPath(import.meta.url));
// Inside the app's node_modules, so the bundle's external imports (better-sqlite3, zod) resolve.
const outDir = join(here, '..', 'node_modules', '.test-build');
const DOC = 'doc-1';

let tmp: ReturnType<typeof tempDir>;
let dbPath: string;
let server: Running;

beforeAll(async () => {
  // The child runs plain Node, which cannot load the workspace's TypeScript: bundle it first.
  await build({
    configFile: false,
    root: join(here, '..'),
    logLevel: 'silent',
    build: {
      ssr: join(here, 'crash-child.ts'),
      outDir,
      emptyOutDir: true,
      target: 'node22',
      rollupOptions: { output: { entryFileNames: 'crash-child.js' } },
    },
    ssr: { noExternal: [/^@manufakture\//] },
  });
}, 60_000);

beforeEach(async () => {
  tmp = tempDir();
  dbPath = join(tmp.dir, 'sync.db');
  server = await start(dbPath);
});

afterEach(async () => {
  await server.close();
  tmp.remove();
});

function snapshotOf(path: string): string {
  const db = new Database(path, { readonly: true });
  try {
    const q = (sql: string) => db.prepare(sql).all();
    return JSON.stringify({
      branches: q('SELECT * FROM branches'),
      entries: q('SELECT * FROM entries'),
      outcomes: q('SELECT * FROM outcomes'),
      clients: q('SELECT document_id, client_id, floor, latest_accepted FROM clients'),
      snapshots: q('SELECT document_id, rev FROM snapshots'),
    });
  } finally {
    db.close();
  }
}

function ok<T>(r: { ok: true; value: T } | { ok: false; error: { message: string } }): T {
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

describe('torn writes', () => {
  it('a process killed mid-transaction leaves the store as it was; the submit then lands', async () => {
    await createDoc(server);
    const key = clientKey();
    expect((await helloHttp(server, DOC, 'a', key)).status).toBe(200);
    let doc = baseDocument();
    const entries = [];
    for (let i = 1; i <= 3; i++) {
      const command = setVariable(`v${i}`, String(i));
      entries.push(
        entry(doc, command, { clientId: 'a', clientSeq: i, ...(i > 1 && { prevSeq: i - 1 }) }),
      );
      doc = ok(applyCommand(doc, command)).document;
    }
    const message = submit(entries, 1);
    await server.close();
    const before = snapshotOf(dbPath);

    const input = join(tmp.dir, 'input.json');
    writeFileSync(input, JSON.stringify({ documentId: DOC, key, message }));
    const child = spawn(process.execPath, [join(outDir, 'crash-child.js'), dbPath, input], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stderr.on('data', (d: Buffer) => (err += d.toString()));
    const exited = new Promise<NodeJS.Signals | null>((resolve) =>
      child.on('exit', (_c, s) => resolve(s)),
    );
    await new Promise<void>((resolve, reject) => {
      child.stdout.on('data', (d: Buffer) => {
        out += d.toString();
        if (out.includes('ready')) resolve();
      });
      child.on('exit', () => reject(new Error(`child exited early: ${out} ${err}`)));
    });
    child.kill('SIGKILL');
    expect(await exited).toBe('SIGKILL');
    expect(out).not.toContain('finished');

    // SQLite rolls the open transaction back on the next open.
    expect(snapshotOf(dbPath)).toBe(before);
    const db = new Database(dbPath, { readonly: true });
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
    db.close();

    server = await start(dbPath);
    const r = await submitHttp(server, DOC, key, message);
    expect(r.body.messages).toEqual([
      { type: 'ack', clientSeq: 1, rev: 1 },
      { type: 'ack', clientSeq: 2, rev: 2 },
      { type: 'ack', clientSeq: 3, rev: 3 },
    ]);
    const snap = await call<{ rev: number; document: unknown }>(
      server,
      'GET',
      `/documents/${DOC}/snapshot`,
    );
    expect(snap.body).toMatchObject({ rev: 3, document: doc });
  });
});

describe('WebSocket origin', () => {
  it('refuses an upgrade from an origin that is not configured', async () => {
    await createDoc(server);
    const status = (origin: string) =>
      new Promise<number>((resolve, reject) => {
        const req = request(`${server.url.replace('/api', '')}/api/documents/${DOC}/socket`, {
          headers: {
            connection: 'Upgrade',
            upgrade: 'websocket',
            'sec-websocket-version': '13',
            'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
            'sec-websocket-protocol': `manufakture-sync, bearer.${TOKEN}`,
            origin,
          },
        });
        req.on('upgrade', (res, socket) => {
          socket.destroy();
          resolve(res.statusCode ?? 0);
        });
        req.on('response', (res) => resolve(res.statusCode ?? 0));
        req.on('error', reject);
        req.end();
      });
    expect(await status('https://evil.test')).toBe(403);
    expect(await status(ORIGIN)).toBe(101);
  });
});
