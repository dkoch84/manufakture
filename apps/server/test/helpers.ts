import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FORMAT_VERSION,
  applyCommand,
  createDocument,
  createdIds,
  type Command,
  type ManufaktureDocument,
  type SketchFeature,
  type SyncEntry,
} from '@manufakture/core';
import type { ServerMessage, SubmitMessage, SyncClient } from '@manufakture/sync';
import type { FastifyInstance } from 'fastify';
import { CLIENT_KEY_HEADER, SUBPROTOCOL, buildApp } from '../src/app';
import { DEFAULT_LIMITS, type Limits } from '../src/limits';
import { SyncService } from '../src/service';
import { SqliteStore } from '../src/sqlite';

/** Test-only helpers: a real server on an ephemeral port over a temp SQLite file. */

export const TOKEN = 'test-token-0123456789abcdefghijklmnopqrstuvwxyz';
export const ORIGIN = 'https://app.example.test';
export const PART = 'part#1';
export const AT = '2026-10-04T12:00:00.000Z';

export function tempDir(): { dir: string; remove: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'mfk-server-'));
  return { dir, remove: () => rmSync(dir, { recursive: true, force: true }) };
}

export function clientKey(): string {
  return randomBytes(32).toString('base64url');
}

export interface Running {
  readonly app: FastifyInstance;
  readonly store: SqliteStore;
  readonly url: string;
  readonly wsUrl: string;
  close(): Promise<void>;
}

export interface StartOptions {
  readonly limits?: Partial<Limits>;
  readonly now?: () => number;
}

export async function start(dbPath: string, options: StartOptions = {}): Promise<Running> {
  const store = new SqliteStore(dbPath);
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  const service = new SyncService(store, { limits, ...(options.now && { now: options.now }) });
  const app = await buildApp({ token: TOKEN, store, limits, origins: [ORIGIN], service });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (address === null || typeof address === 'string') throw new Error('no address');
  const url = `http://127.0.0.1:${address.port}/api`;
  return {
    app,
    store,
    url,
    wsUrl: url.replace(/^http/, 'ws'),
    async close() {
      await app.close();
      store.close();
    },
  };
}

export interface Response<T = unknown> {
  readonly status: number;
  readonly body: T;
  readonly headers: Headers;
}

export async function call<T = Record<string, unknown>>(
  server: Running,
  method: string,
  path: string,
  options: {
    body?: unknown;
    raw?: string | Uint8Array;
    token?: string | null;
    key?: string;
    headers?: Record<string, string>;
  } = {},
): Promise<Response<T>> {
  const headers: Record<string, string> = { ...options.headers };
  if (options.token !== null) headers.authorization = `Bearer ${options.token ?? TOKEN}`;
  if (options.key !== undefined) headers[CLIENT_KEY_HEADER] = options.key;
  let body: string | Uint8Array | undefined;
  if (options.body !== undefined) {
    body = JSON.stringify(options.body);
    headers['content-type'] ??= 'application/json';
  } else if (options.raw !== undefined) {
    body = options.raw;
  }
  const res = await fetch(server.url + path, {
    method,
    headers,
    ...(body !== undefined && { body }),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: res.status, body: parsed as T, headers: res.headers };
}

function ok<T>(r: { ok: true; value: T } | { ok: false; error: { message: string } }): T {
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

/** A document with one part and a variable. */
export function baseDocument(id = 'doc-1'): ManufaktureDocument {
  const doc = createDocument({ id, name: 'Bracket' });
  return ok(applyCommand(doc, setVariable('width', '40'))).document;
}

export function setVariable(name: string, source: string): Command {
  return {
    type: 'setVariable',
    name,
    expression: { source, lengthUnit: 'mm', angleUnit: 'deg' },
  } as Command;
}

/** The part's next sketch, a rectangle: creates `sketch#n`, four entities and two constraints. */
export function addSketch(doc: ManufaktureDocument, partId = PART): Command {
  const p = doc.parts.find((x) => x.id === partId)!;
  const n = p.nextIds.sketch ?? 1;
  const e = p.nextIds.e ?? 1;
  const k = p.nextIds.k ?? 1;
  const pts: [number, number][] = [
    [0, 0],
    [40, 0],
    [40, 20],
    [0, 20],
  ];
  const ids = [0, 1, 2, 3].map((i) => `e${e + i}`);
  const feature: SketchFeature = {
    id: `sketch#${n}`,
    kind: 'sketch',
    name: `Sketch ${n}`,
    suppressed: false,
    plane: { type: 'plane', origin: [0, 0, 0], normal: [0, 0, 1], xDir: [1, 0, 0] },
    entities: pts.map((pt, i) => ({
      id: ids[i]!,
      kind: 'line' as const,
      construction: false,
      start: pt,
      end: pts[(i + 1) % 4]!,
    })),
    constraints: [
      {
        id: `k${k}`,
        kind: 'coincident',
        a: { entity: ids[0]!, at: 'end' },
        b: { entity: ids[1]!, at: 'start' },
      },
      { id: `k${k + 1}`, kind: 'horizontal', line: ids[0]! },
    ],
  };
  return { type: 'addFeature', partId, feature } as Command;
}

/** A sync entry for `command` made on `doc`, with its created ids. */
export function entry(
  doc: ManufaktureDocument,
  command: Command,
  fields: { clientId: string; clientSeq: number; prevSeq?: number; baseRev?: number },
): SyncEntry {
  return {
    clientId: fields.clientId,
    clientSeq: fields.clientSeq,
    ...(fields.prevSeq !== undefined && { prevSeq: fields.prevSeq }),
    baseRev: fields.baseRev ?? 0,
    format: FORMAT_VERSION,
    cause: 'execute',
    label: command.type,
    command: command as SyncEntry['command'],
    created: ok(createdIds(doc, command)) as SyncEntry['created'],
    at: AT,
  };
}

export function submit(entries: SyncEntry[], floor: number): SubmitMessage {
  return { type: 'submit', entries, floor };
}

export function hello(clientId: string) {
  return { type: 'hello', protocol: 1, format: FORMAT_VERSION, clientId } as const;
}

export async function createDoc(server: Running, doc = baseDocument()): Promise<void> {
  const r = await call(server, 'POST', '/documents', { body: { document: doc } });
  if (r.status !== 201) throw new Error(`create: ${r.status} ${JSON.stringify(r.body)}`);
}

export async function helloHttp(server: Running, docId: string, clientId: string, key: string) {
  return call<{ messages: ServerMessage[] }>(server, 'POST', `/documents/${docId}/hello`, {
    body: hello(clientId),
    key,
  });
}

export async function submitHttp(
  server: Running,
  docId: string,
  key: string,
  message: unknown,
): Promise<Response<{ messages?: ServerMessage[]; code?: string; message?: string }>> {
  return call(server, 'POST', `/documents/${docId}/entries`, { body: message, key });
}

/** Waits until `check` holds, polling. */
export async function until(check: () => boolean, ms = 5_000, what = 'condition'): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** A raw WebSocket to a document, with every message it received. */
export class Socket {
  readonly received: ServerMessage[] = [];
  closed: { code: number; reason: string } | undefined;
  opened = false;
  failed = false;
  private readonly ws: WebSocket;

  constructor(
    server: Running,
    docId: string,
    options: { token?: string; key?: string; branch?: string } = {},
  ) {
    const protocols = [SUBPROTOCOL, `bearer.${options.token ?? TOKEN}`];
    if (options.key !== undefined) protocols.push(`client.${options.key}`);
    const query = options.branch === undefined ? '' : `?branch=${options.branch}`;
    this.ws = new WebSocket(`${server.wsUrl}/documents/${docId}/socket${query}`, protocols);
    this.ws.addEventListener('open', () => (this.opened = true));
    this.ws.addEventListener('error', () => (this.failed = true));
    this.ws.addEventListener('close', (e) => (this.closed = { code: e.code, reason: e.reason }));
    this.ws.addEventListener('message', (e) => {
      this.received.push(JSON.parse(String(e.data)) as ServerMessage);
    });
  }

  get protocol(): string {
    return this.ws.protocol;
  }

  async open(): Promise<void> {
    await until(() => this.opened || this.failed || this.closed !== undefined, 5_000, 'open');
    if (!this.opened) throw new Error('the socket did not open');
  }

  send(message: unknown): void {
    this.ws.send(typeof message === 'string' ? message : JSON.stringify(message));
  }

  /** Waits for a message matching `match` and returns it (removing it from `received`). */
  async next(match: (m: ServerMessage) => boolean = () => true): Promise<ServerMessage> {
    let found: ServerMessage | undefined;
    await until(() => (found = this.received.find(match)) !== undefined, 5_000, 'a message');
    this.received.splice(this.received.indexOf(found!), 1);
    return found!;
  }

  close(): void {
    this.ws.close();
  }
}

/** A `SyncClient` connected to the server over a WebSocket. */
export class Connected {
  readonly socket: Socket;
  readonly errors: string[] = [];

  constructor(
    readonly client: SyncClient,
    server: Running,
    docId: string,
    key = clientKey(),
  ) {
    this.socket = new Socket(server, docId, { key });
  }

  async open(): Promise<void> {
    await this.socket.open();
    this.socket.send(this.client.hello());
    await until(() => this.socket.received.some((m) => m.type === 'welcome'), 5_000, 'welcome');
  }

  /** Sends what the client wants to send and hands it everything received so far. */
  pump(): number {
    const out = this.client.takeOutgoing();
    for (const m of out) this.socket.send(m);
    const inbox = this.socket.received.splice(0);
    for (const m of inbox) {
      const r = this.client.handle(m);
      if (!r.ok) this.errors.push(r.error.message);
    }
    return out.length + inbox.length;
  }
}
