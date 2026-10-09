// Tests only: a real sync server (apps/server, in this process, on a free port over a temp SQLite
// file, with agent tokens), and what its owner does in the tests: create documents, issue and
// revoke agent tokens, edit Main and decide reviews. Sessions over sync (`sync.test.ts`), the MCP
// server over sync (apps/mcp) and the app's reviewer side (apps/web) are tested against it.

import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FORMAT_VERSION,
  createdIds,
  type Command,
  type ManufaktureDocument,
  type SyncEntry,
} from '@manufakture/core';
import { ServerApi } from '@manufakture/sync';
import { buildApp } from '../../../../apps/server/src/app';
import { DEFAULT_LIMITS } from '../../../../apps/server/src/limits';
import { SqliteStore } from '../../../../apps/server/src/sqlite';
import { AgentTokenStore } from '../../../../apps/server/src/tokens';

/** The instance's own token (the owner's). */
export const OWNER_TOKEN = 'sync-test-owner-token-0123456789abcdefghijklmnopqrstuvwxyz';

export interface TestSyncServer {
  /** `http://127.0.0.1:<port>` (no `/api`). */
  url: string;
  /** The server's client with the owner's token. */
  owner: ServerApi;
  /** A client with another token. */
  as(token: string): ServerApi;
  /** Creates a document on the server, as the owner. */
  create(doc: ManufaktureDocument): Promise<void>;
  /** Issues an agent token scoped to `documents`. */
  issue(documents: string[], name?: string): Promise<{ id: string; token: string }>;
  revoke(tokenId: string): Promise<void>;
  /** Applies `command` to Main's head as one of the owner's devices would: its new revision. */
  editMain(documentId: string, command: Command): Promise<number>;
  close(): Promise<void>;
}

export async function startSyncServer(
  options: { writerLeaseMs?: number } = {},
): Promise<TestSyncServer> {
  const dir = mkdtempSync(join(tmpdir(), 'mfk-sync-session-'));
  const store = new SqliteStore(join(dir, 'server.db'));
  const app = await buildApp({
    token: OWNER_TOKEN,
    agentTokens: new AgentTokenStore(store.database),
    store,
    limits: {
      ...DEFAULT_LIMITS,
      writerLeaseMs: options.writerLeaseMs ?? DEFAULT_LIMITS.writerLeaseMs,
    },
    origins: [],
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (address === null || typeof address === 'string') throw new Error('no address');
  const url = `http://127.0.0.1:${address.port}`;
  const owner = new ServerApi({ url, token: OWNER_TOKEN });
  const ownerClient = {
    clientId: `owner-${randomUUID()}`,
    key: randomBytes(32).toString('base64url'),
  };
  // One owner client per document's main log: its sequence and latest accepted entry.
  const clients = new Map<string, { seq: number; latest?: number }>();

  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${url}/api${path}`, {
      method,
      headers: {
        authorization: `Bearer ${OWNER_TOKEN}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return { status: res.status, body: text.length > 0 ? (JSON.parse(text) as unknown) : null };
  };

  return {
    url,
    owner,
    as: (token) => new ServerApi({ url, token }),
    async create(doc) {
      const r = await call('POST', '/documents', { document: doc });
      if (r.status !== 201) throw new Error(`create: ${r.status} ${JSON.stringify(r.body)}`);
    },
    async issue(documents, name = 'Test agent') {
      const r = await call('POST', '/agent-tokens', { name, documents });
      if (r.status !== 201) throw new Error(`issue: ${r.status} ${JSON.stringify(r.body)}`);
      return r.body as { id: string; token: string };
    },
    async revoke(tokenId) {
      const r = await call('DELETE', `/agent-tokens/${tokenId}`);
      if (r.status !== 204) throw new Error(`revoke: ${r.status}`);
    },
    async editMain(documentId, command) {
      let c = clients.get(documentId);
      if (c === undefined) {
        await owner.hello(documentId, 'main', ownerClient);
        clients.set(documentId, (c = { seq: 0 }));
      }
      const snap = await owner.snapshot(documentId);
      if (snap === null) throw new Error('no document');
      const created = createdIds(snap.document, command);
      if (!created.ok) throw new Error(created.error.message);
      const seq = ++c.seq;
      const entry: SyncEntry = {
        clientId: ownerClient.clientId,
        clientSeq: seq,
        ...(c.latest === undefined ? {} : { prevSeq: c.latest }),
        baseRev: snap.rev,
        format: FORMAT_VERSION,
        cause: 'execute',
        label: command.type,
        command: command as unknown as SyncEntry['command'],
        created: created.value as SyncEntry['created'],
        at: new Date().toISOString(),
      };
      const answers = await owner.submit(documentId, 'main', ownerClient.key, {
        type: 'submit',
        entries: [entry],
        floor: seq,
      });
      const ack = answers.find((m) => m.type === 'ack');
      if (ack?.type !== 'ack') throw new Error(`main edit: ${JSON.stringify(answers)}`);
      c.latest = seq;
      return ack.rev;
    },
    async close() {
      await app.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
