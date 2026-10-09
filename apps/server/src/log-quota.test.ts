import { join } from 'node:path';
import type { SyncEntry } from '@manufakture/core';
import type { ServerMessage } from '@manufakture/sync';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AT,
  baseDocument,
  call,
  clientKey,
  createDoc,
  entry,
  hello,
  setVariable,
  start,
  submit,
  tempDir,
  type Running,
} from '../test/helpers';
import type { Limits } from './limits';

// The agent log quota (threat model N-2, F8): an agent token stores at most `maxAgentLogBytes` of
// log (entries and checkpoint snapshots) in a document, counted from what is stored, so neither a
// fresh client id with a full rate bucket nor a restart resets it. The owner has no such quota.

let tmp: ReturnType<typeof tempDir>;
let dbPath: string;
let server: Running;

const DOC = 'doc-1';
const V1 = '0b6f0d7e-5a3c-4d8e-9f21-6c7b8a9d0e1f';
const B1 = '2d8b2f90-7c5e-4fa0-9b43-8e9dac1f2a3b';
const B2 = '3e9c3fa1-8d6f-4ab1-8c54-9fa0bd2e3b4c';
const SESSION = '5abe51c3-af81-4cd3-8e76-b1c2df405d6e';

beforeEach(() => {
  tmp = tempDir();
  dbPath = join(tmp.dir, 'sync.db');
});

afterEach(async () => {
  await server.close();
  tmp.remove();
});

async function restart(limits: Partial<Limits>): Promise<void> {
  await server.close();
  server = await start(dbPath, { limits });
}

/** A document with a version of main to start from, and an agent token scoped to it. */
async function setUp(limits: Partial<Limits>): Promise<{ token: string }> {
  server = await start(dbPath, { limits });
  await createDoc(server);
  const v = await call(server, 'POST', `/documents/${DOC}/versions`, {
    body: {
      version: { id: V1, name: 'Start', description: '', branch: 'main', rev: 0, createdAt: AT },
    },
  });
  expect(v.status).toBe(201);
  const issued = await call<{ token: string }>(server, 'POST', '/agent-tokens', {
    body: { name: 'Claude Code', documents: [DOC] },
  });
  expect(issued.status).toBe(201);
  return issued.body;
}

async function makeAgentBranch(token: string, id: string): Promise<void> {
  const r = await call(server, 'POST', `/documents/${DOC}/branches`, {
    token,
    body: {
      branch: {
        id,
        name: `Agent session ${SESSION}`,
        fromVersion: V1,
        createdAt: AT,
        provenance: {
          origin: 'agent',
          sessionId: SESSION,
          clientName: 'Claude Code',
          review: 'open',
        },
      },
    },
  });
  expect(r.status).toBe(201);
}

/** `count` entries from one client, each setting its own variable, chained by `prevSeq`. */
function entries(clientId: string, count: number, from = 1): SyncEntry[] {
  const doc = baseDocument();
  return Array.from({ length: count }, (_, i) => {
    const seq = from + i;
    return entry(doc, setVariable(`v_${clientId.replace(/-/g, '_')}_${seq}`, '1'), {
      clientId,
      clientSeq: seq,
      ...(seq > 1 && { prevSeq: seq - 1 }),
    });
  });
}

const bytes = (list: SyncEntry[]) =>
  list.reduce((n, e) => n + Buffer.byteLength(JSON.stringify(e)), 0);

/**
 * One session on a branch: a fresh client id says hello, submits, and lets go of the branch so the
 * next client id can take it at once.
 */
async function session(
  token: string | undefined,
  branch: string,
  clientId: string,
  list: SyncEntry[],
): Promise<{ status: number; body: { code?: string; messages?: ServerMessage[] } }> {
  const key = clientKey();
  const q = branch === 'main' ? '' : `?branch=${branch}`;
  const auth = token === undefined ? {} : { token };
  const h = await call(server, 'POST', `/documents/${DOC}/hello${q}`, {
    ...auth,
    key,
    body: hello(clientId),
  });
  expect(h.status).toBe(200);
  const r = await call<{ code?: string; messages?: ServerMessage[] }>(
    server,
    'POST',
    `/documents/${DOC}/entries${q}`,
    { ...auth, key, body: submit(list, list[0]!.clientSeq) },
  );
  if (branch !== 'main') {
    const released = await call(server, 'POST', `/documents/${DOC}/release${q}`, {
      ...auth,
      key,
      body: { clientId },
    });
    expect(released.status).toBe(204);
  }
  return r;
}

const acked = (r: { body: { messages?: ServerMessage[] } }) =>
  (r.body.messages ?? []).filter((m) => m.type === 'ack').length;

describe('the agent log quota (N-2)', () => {
  it('an agent token writes at most its quota of log bytes, across client ids and restarts', async () => {
    const one = bytes(entries('agent-1', 1));
    // Room for three entries of this size (the client id's length is the same for all).
    const limits = { maxAgentLogBytes: 3 * one + one / 2 };
    const agent = await setUp(limits);
    await makeAgentBranch(agent.token, B1);

    for (const id of ['agent-1', 'agent-2', 'agent-3']) {
      const r = await session(agent.token, B1, id, entries(id, 1));
      expect(r.status).toBe(200);
      expect(acked(r)).toBe(1);
    }
    // A fourth client id, with a full rate bucket of its own, is refused all the same.
    const over = await session(agent.token, B1, 'agent-4', entries('agent-4', 1));
    expect(over.status).toBe(403);
    expect(over.body.code).toBe('log-quota');

    // The count comes from the store: a restart does not reset it.
    await restart(limits);
    const after = await session(agent.token, B1, 'agent-5', entries('agent-5', 1));
    expect(after.status).toBe(403);
    expect(after.body.code).toBe('log-quota');

    // The owner has no log quota, on main or on the agent's branch.
    const owner = await session(undefined, 'main', 'owner-1', entries('owner-1', 10));
    expect(owner.status).toBe(200);
    expect(acked(owner)).toBe(10);
    const onBranch = await session(undefined, B1, 'owner-2', entries('owner-2', 2));
    expect(onBranch.status).toBe(200);
    expect(acked(onBranch)).toBe(2);

    // A new branch of the same token shares the quota (it is per token and document); deleting
    // the full one makes room.
    await makeAgentBranch(agent.token, B2);
    const second = await session(agent.token, B2, 'agent-6', entries('agent-6', 1));
    expect(second.body.code).toBe('log-quota');
    expect(
      (await call(server, 'DELETE', `/documents/${DOC}/branches/${B1}?expected=open`)).status,
    ).toBe(204);
    const room = await session(agent.token, B2, 'agent-7', entries('agent-7', 1));
    expect(room.status).toBe(200);
    expect(acked(room)).toBe(1);
  });

  it('another agent token has a quota of its own', async () => {
    const one = bytes(entries('agent-1', 1));
    const limits = { maxAgentLogBytes: one + one / 2 };
    const agent = await setUp(limits);
    await makeAgentBranch(agent.token, B1);
    expect(acked(await session(agent.token, B1, 'agent-1', entries('agent-1', 1)))).toBe(1);
    expect((await session(agent.token, B1, 'agent-2', entries('agent-2', 1))).body.code).toBe(
      'log-quota',
    );
    const other = await call<{ token: string }>(server, 'POST', '/agent-tokens', {
      body: { name: 'Another agent', documents: [DOC] },
    });
    await makeAgentBranch(other.body.token, B2);
    expect(acked(await session(other.body.token, B2, 'agent-3', entries('agent-3', 1)))).toBe(1);
  });

  it('a submit is refused whole when its checkpoint snapshots would pass the quota', async () => {
    // Three hundred tiny entries cross three checkpoints, each storing the whole document: the
    // entries alone fit, the first snapshot does not, and nothing is written.
    const many = entries('agent-1', 300);
    const one = bytes(entries('agent-2', 1));
    const agent = await setUp({ maxAgentLogBytes: bytes(many) + one / 2 });
    await makeAgentBranch(agent.token, B1);
    const r = await session(agent.token, B1, 'agent-1', many);
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('log-quota');
    const head = await call<{ rev: number }>(
      server,
      'GET',
      `/documents/${DOC}/snapshot?branch=${B1}`,
    );
    expect(head.body.rev).toBe(0);
  });

  it('checkpoint snapshots count, exactly, after a restart and as submits land', async () => {
    const agent = await setUp({});
    await makeAgentBranch(agent.token, B1);
    const hundred = entries('agent-1', 100);
    expect(acked(await session(agent.token, B1, 'agent-1', hundred))).toBe(100);
    // The snapshot at revision 100 is the head now.
    const s = await call<{ rev: number; document: unknown; highWater: unknown }>(
      server,
      'GET',
      `/documents/${DOC}/snapshot?branch=${B1}`,
    );
    expect(s.body.rev).toBe(100);
    const snapshot =
      Buffer.byteLength(JSON.stringify(s.body.document)) +
      Buffer.byteLength(JSON.stringify(s.body.highWater));
    const one = bytes(entries('agent-2', 1));
    // Room for what is stored and one more entry, counted from the store after a restart.
    await restart({ maxAgentLogBytes: bytes(hundred) + snapshot + one + one / 2 });
    expect(acked(await session(agent.token, B1, 'agent-2', entries('agent-2', 1)))).toBe(1);
    expect((await session(agent.token, B1, 'agent-3', entries('agent-3', 1))).body.code).toBe(
      'log-quota',
    );
  });

  it('a resend of entries already answered is never refused by the quota', async () => {
    const one = bytes(entries('agent-1', 1));
    const agent = await setUp({ maxAgentLogBytes: one + one / 2 });
    await makeAgentBranch(agent.token, B1);
    const key = clientKey();
    const q = `?branch=${B1}`;
    const send = (list: SyncEntry[]) =>
      call<{ code?: string; messages?: ServerMessage[] }>(
        server,
        'POST',
        `/documents/${DOC}/entries${q}`,
        { token: agent.token, key, body: submit(list, 1) },
      );
    expect(
      (
        await call(server, 'POST', `/documents/${DOC}/hello${q}`, {
          token: agent.token,
          key,
          body: hello('agent-1'),
        })
      ).status,
    ).toBe(200);
    const list = entries('agent-1', 2);
    expect(acked(await send([list[0]!]))).toBe(1);
    expect((await send(list)).body.code).toBe('log-quota');
    // The quota is full, but the answer to entry 1 still comes back.
    const again = await send([list[0]!]);
    expect(again.status).toBe(200);
    expect(acked(again)).toBe(1);
  });
});
