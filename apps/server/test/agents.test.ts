import { join } from 'node:path';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { applyCommand, type ManufaktureDocument } from '@manufakture/core';
import { AGENT_TOKEN, type ServerBranch, type ServerMessage } from '@manufakture/sync';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { DEFAULT_LIMITS } from '../src/limits';
import { DEFAULT_SHARE_CONFIG, SqliteShareStore } from '../src/shares';
import { SqliteStore, STORE_SCHEMA_VERSION } from '../src/sqlite';
import { AgentTokenStore } from '../src/tokens';
import {
  AT,
  Socket,
  TOKEN,
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
  until,
  type Running,
} from './helpers';

// Agent tokens (ADR 0016 decision 12, T8.4b): issued and revoked by the owner, scoped to
// documents; they make agent branches and write only those, never main, never approve, merge or
// write an approved or rejected branch, and set only the review states the ADR allows. Every
// refusal is a 403, on HTTP and on the WebSocket.

let tmp: ReturnType<typeof tempDir>;
let dbPath: string;
let server: Running;
let clock = 1_000_000;

beforeEach(async () => {
  tmp = tempDir();
  dbPath = join(tmp.dir, 'sync.db');
  clock = 1_000_000;
  server = await start(dbPath, { now: () => clock });
});

afterEach(async () => {
  await server.close();
  tmp.remove();
});

const DOC = 'doc-1';
const OTHER = 'doc-2';
const V1 = '0b6f0d7e-5a3c-4d8e-9f21-6c7b8a9d0e1f';
const B1 = '2d8b2f90-7c5e-4fa0-9b43-8e9dac1f2a3b';
const B2 = '3e9c3fa1-8d6f-4ab1-8c54-9fa0bd2e3b4c';
const PERSON = '4fad40b2-9e70-4bc2-9d65-a0b1ce3f4c5d';
const SESSION = '5abe51c3-af81-4cd3-8e76-b1c2df405d6e';

interface Issued {
  token: string;
  id: string;
}

async function issue(documents = [DOC], name = 'Claude Code'): Promise<Issued> {
  const r = await call<Issued & { documents: string[] }>(server, 'POST', '/agent-tokens', {
    body: { name, documents },
  });
  expect(r.status).toBe(201);
  return r.body;
}

function agentBranch(id = B1, fields: Partial<ServerBranch> = {}): ServerBranch {
  return {
    id,
    name: `Agent session ${SESSION}`,
    fromVersion: V1,
    createdAt: AT,
    provenance: { origin: 'agent', sessionId: SESSION, clientName: 'Claude Code', review: 'open' },
    ...fields,
  };
}

/** Documents `DOC` and `OTHER`, a version of DOC's main, and an agent token for DOC. */
async function setUp(): Promise<Issued> {
  await createDoc(server);
  await createDoc(server, baseDocument(OTHER));
  const v = await call(server, 'POST', `/documents/${DOC}/versions`, {
    body: {
      version: { id: V1, name: 'Start', description: '', branch: 'main', rev: 0, createdAt: AT },
    },
  });
  expect(v.status).toBe(201);
  return issue();
}

async function makeAgentBranch(agent: Issued, id = B1): Promise<void> {
  const r = await call(server, 'POST', `/documents/${DOC}/branches`, {
    token: agent.token,
    body: { branch: agentBranch(id) },
  });
  expect(r.status).toBe(201);
}

async function helloOn(token: string, branch: string, clientId: string, key: string) {
  const q = branch === 'main' ? '' : `?branch=${branch}`;
  return call<{ code?: string; messages?: ServerMessage[] }>(
    server,
    'POST',
    `/documents/${DOC}/hello${q}`,
    { token, key, body: hello(clientId) },
  );
}

async function submitOn(
  token: string,
  branch: string,
  key: string,
  doc: ManufaktureDocument,
  fields: { clientId: string; clientSeq: number; prevSeq?: number },
  command = setVariable('height', '10'),
) {
  const q = branch === 'main' ? '' : `?branch=${branch}`;
  return call<{ code?: string; messages?: ServerMessage[] }>(
    server,
    'POST',
    `/documents/${DOC}/entries${q}`,
    { token, key, body: submit([entry(doc, command, fields)], fields.clientSeq) },
  );
}

async function review(
  token: string | undefined,
  branch: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: { code?: string; branch?: ServerBranch } }> {
  return call(server, 'POST', `/documents/${DOC}/branches/${branch}/review`, {
    ...(token === undefined ? {} : { token }),
    body,
  });
}

describe('issuing and revoking agent tokens', () => {
  it('only the owner issues, lists and revokes; the secret is shown once and stored hashed', async () => {
    const agent = await setUp();
    expect(agent.token).toMatch(AGENT_TOKEN);
    const listed = await call<{ tokens: Record<string, unknown>[] }>(
      server,
      'GET',
      '/agent-tokens',
    );
    expect(listed.status).toBe(200);
    expect(listed.body.tokens).toEqual([
      expect.objectContaining({
        id: agent.id,
        name: 'Claude Code',
        documents: [DOC],
        revokedAt: null,
      }),
    ]);
    expect(JSON.stringify(listed.body)).not.toContain(agent.token.split('.')[2]);
    // The database holds the secret's SHA-256, never the secret.
    const secret = agent.token.split('.')[2]!;
    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare('SELECT * FROM agent_tokens').get() as Record<string, unknown>;
    db.close();
    expect(JSON.stringify(row)).not.toContain(secret);
    expect((row.secret_hash as Buffer).equals(createHash('sha256').update(secret).digest())).toBe(
      true,
    );

    // An agent token may do none of it.
    const t = { token: agent.token };
    expect(
      (await call(server, 'POST', '/agent-tokens', { ...t, body: { name: 'x', documents: [DOC] } }))
        .status,
    ).toBe(403);
    expect((await call(server, 'GET', '/agent-tokens', t)).status).toBe(403);
    expect((await call(server, 'DELETE', `/agent-tokens/${agent.id}`, t)).status).toBe(403);
  });

  it('refuses tokens for documents the server does not have, and bad names', async () => {
    await createDoc(server);
    for (const body of [
      { name: 'x', documents: ['nope'] },
      { name: 'x', documents: [] },
      { name: ' padded ', documents: [DOC] },
      { name: 'bidi‮', documents: [DOC] },
      { name: 'x', documents: [DOC], extra: 1 },
    ]) {
      expect((await call(server, 'POST', '/agent-tokens', { body })).status).toBe(400);
    }
  });

  it('a revoked token fails at once, on HTTP and on an open WebSocket', async () => {
    const agent = await setUp();
    await makeAgentBranch(agent);
    const key = clientKey();
    const socket = new Socket(server, DOC, { token: agent.token, key, branch: B1 });
    await socket.open();
    socket.send(hello('agent-1'));
    await socket.next((m) => m.type === 'welcome');
    expect(
      (await call(server, 'GET', `/documents/${DOC}/snapshot`, { token: agent.token })).status,
    ).toBe(200);

    expect((await call(server, 'DELETE', `/agent-tokens/${agent.id}`)).status).toBe(204);
    await until(() => socket.closed !== undefined, 5_000, 'the socket to close');
    // Terminated, not closed: no close handshake, so the peer sees an abnormal closure.
    expect(socket.closed?.code).toBe(1006);
    expect(
      (await call(server, 'GET', `/documents/${DOC}/snapshot`, { token: agent.token })).status,
    ).toBe(401);
    expect((await call(server, 'GET', '/documents', { token: agent.token })).status).toBe(401);
    // Revoked twice: nothing to revoke.
    expect((await call(server, 'DELETE', `/agent-tokens/${agent.id}`)).status).toBe(404);
    // A token with a valid shape but a wrong secret, or an unknown id, is no token.
    const [, id] = agent.token.split('.');
    expect(
      (await call(server, 'GET', '/documents', { token: `agent.${id}.${'A'.repeat(43)}` })).status,
    ).toBe(401);
    expect(
      (
        await call(server, 'GET', '/documents', {
          token: `agent.${'B'.repeat(22)}.${'A'.repeat(43)}`,
        })
      ).status,
    ).toBe(401);
  });
});

describe('what an agent token reads', () => {
  it('only the documents it is scoped to', async () => {
    const agent = await setUp();
    const t = { token: agent.token };
    const docs = await call<{ documents: { id: string }[] }>(server, 'GET', '/documents', t);
    expect(docs.body.documents.map((d) => d.id)).toEqual([DOC]);
    for (const path of ['/snapshot', '/versions', '/branches', '/entries?since=0']) {
      expect((await call(server, 'GET', `/documents/${DOC}${path}`, t)).status).toBe(200);
      expect((await call(server, 'GET', `/documents/${OTHER}${path}`, t)).status).toBe(403);
    }
    expect((await call(server, 'GET', `/documents/${DOC}/versions/${V1}`, t)).status).toBe(200);
    const socket = new Socket(server, OTHER, { token: agent.token, key: clientKey() });
    await until(() => socket.closed !== undefined || socket.failed, 5_000, 'refusal');
    expect(socket.opened).toBe(false);
  });

  it('never the owner-only routes: new documents, blob reads, shares', async () => {
    const agent = await setUp();
    const t = { token: agent.token };
    expect(
      (
        await call(server, 'POST', '/documents', {
          ...t,
          body: { document: baseDocument('doc-3') },
        })
      ).status,
    ).toBe(403);
    const bytes = new TextEncoder().encode('png');
    const sha = createHash('sha256').update(bytes).digest('hex');
    // An agent stores a bundle's images, but reads no blob.
    expect(
      (
        await call(server, 'PUT', `/blobs/${sha}`, {
          ...t,
          raw: bytes,
          headers: { 'content-type': 'application/octet-stream' },
        })
      ).status,
    ).toBe(201);
    expect((await call(server, 'GET', `/blobs/${sha}`, t)).status).toBe(403);
  });

  it('never the share routes', async () => {
    await server.close();
    const store = new SqliteStore(dbPath);
    const app = await buildApp({
      token: TOKEN,
      agentTokens: new AgentTokenStore(store.database),
      store,
      limits: DEFAULT_LIMITS,
      origins: [],
      shares: { store: new SqliteShareStore(store.database), config: DEFAULT_SHARE_CONFIG },
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (address === null || typeof address === 'string') throw new Error('no address');
    server = {
      app,
      store,
      url: `http://127.0.0.1:${address.port}/api`,
      wsUrl: '',
      close: async () => {
        await app.close();
        store.close();
      },
    };
    const agent = await setUp();
    const t = { token: agent.token };
    expect((await call(server, 'GET', '/shares', t)).status).toBe(403);
    expect((await call(server, 'GET', '/shares')).status).toBe(200);
    expect(
      (
        await call(server, 'POST', '/shares?name=x', {
          ...t,
          raw: new Uint8Array([1, 2, 3]),
          headers: { 'content-type': 'application/vnd.manufakture.view+zip' },
        })
      ).status,
    ).toBe(403);
  });
});

describe('main is never written by an agent token', () => {
  it('hello, submit, a merge, deleting or reviewing main: 403 over HTTP', async () => {
    const agent = await setUp();
    const key = clientKey();
    const hi = await helloOn(agent.token, 'main', 'agent-1', key);
    expect(hi.status).toBe(403);
    expect(hi.body.code).toBe('main-refused');
    // The owner claimed this client on main; the agent's submit is refused before the key.
    const ownerKey = clientKey();
    expect((await helloOn(TOKEN, 'main', 'c1', ownerKey)).status).toBe(200);
    const doc = baseDocument();
    const write = await submitOn(agent.token, 'main', ownerKey, doc, {
      clientId: 'c1',
      clientSeq: 1,
    });
    expect(write.status).toBe(403);
    // A merge is a replaceDocument on main: refused like any write.
    const merged = applyCommand(doc, setVariable('merged', '1'));
    if (!merged.ok) throw new Error('setup');
    const merge = await submitOn(
      agent.token,
      'main',
      ownerKey,
      doc,
      { clientId: 'c1', clientSeq: 2 },
      {
        type: 'replaceDocument',
        document: merged.value.document,
      } as never,
    );
    expect(merge.status).toBe(403);
    expect((await review(agent.token, 'main', { review: 'approved' })).status).toBe(403);
    expect(
      (await call(server, 'DELETE', `/documents/${DOC}/branches/main`, { token: agent.token }))
        .status,
    ).toBe(403);
    const snap = await call<{ rev: number }>(server, 'GET', `/documents/${DOC}/snapshot`);
    expect(snap.body.rev).toBe(0);
  });

  it('hello on main over the WebSocket is refused and closes the socket', async () => {
    const agent = await setUp();
    const socket = new Socket(server, DOC, { token: agent.token, key: clientKey() });
    await socket.open();
    socket.send(hello('agent-1'));
    await until(() => socket.closed !== undefined, 5_000, 'the socket to close');
    expect(socket.closed?.code).toBe(4403);
  });
});

describe('agent branches', () => {
  it('an agent token makes agent branches only, open and without a comment', async () => {
    const agent = await setUp();
    const t = { token: agent.token };
    const person = { id: PERSON, name: 'Mine', fromVersion: V1, createdAt: AT };
    expect(
      (await call(server, 'POST', `/documents/${DOC}/branches`, { ...t, body: { branch: person } }))
        .status,
    ).toBe(403);
    for (const provenance of [
      { ...agentBranch().provenance!, review: 'submitted' },
      { ...agentBranch().provenance!, review: 'approved' },
      { ...agentBranch().provenance!, comment: 'forged comment' },
    ]) {
      const r = await call(server, 'POST', `/documents/${DOC}/branches`, {
        ...t,
        body: { branch: agentBranch(B1, { provenance: provenance as never }) },
      });
      expect(r.status).toBe(400);
    }
    // Provenance is parsed strictly: an unknown field or a bidi override in the client name.
    for (const provenance of [
      { ...agentBranch().provenance!, extra: 1 },
      { ...agentBranch().provenance!, clientName: 'Claude‮' },
      { ...agentBranch().provenance!, origin: 'person' },
    ]) {
      const r = await call(server, 'POST', `/documents/${DOC}/branches`, {
        ...t,
        body: { branch: agentBranch(B1, { provenance: provenance as never }) },
      });
      expect(r.status).toBe(400);
    }
    await makeAgentBranch(agent);
    const listed = await call<{ branches: ServerBranch[] }>(
      server,
      'GET',
      `/documents/${DOC}/branches`,
    );
    expect(listed.body.branches).toEqual([agentBranch()]);
    // A resend is a resend; the same id as a person's branch (or another token's) is a conflict.
    expect(
      (
        await call(server, 'POST', `/documents/${DOC}/branches`, {
          ...t,
          body: { branch: agentBranch() },
        })
      ).status,
    ).toBe(200);
    const asPerson: ServerBranch = { ...agentBranch() };
    delete asPerson.provenance;
    expect(
      (await call(server, 'POST', `/documents/${DOC}/branches`, { body: { branch: asPerson } }))
        .status,
    ).toBe(409);
    const other = await issue();
    expect(
      (
        await call(server, 'POST', `/documents/${DOC}/branches`, {
          token: other.token,
          body: { branch: agentBranch() },
        })
      ).status,
    ).toBe(409);
  });

  it('an agent token writes its own agent branch, and no other branch', async () => {
    const agent = await setUp();
    await makeAgentBranch(agent);
    const key = clientKey();
    expect((await helloOn(agent.token, B1, 'agent-1', key)).status).toBe(200);
    const doc = baseDocument();
    const ok = await submitOn(agent.token, B1, key, doc, { clientId: 'agent-1', clientSeq: 1 });
    expect(ok.status).toBe(200);
    expect(ok.body.messages).toEqual([{ type: 'ack', clientSeq: 1, rev: 1 }]);

    // A person's branch made by the owner.
    expect(
      (
        await call(server, 'POST', `/documents/${DOC}/branches`, {
          body: { branch: { id: PERSON, name: 'Mine', fromVersion: V1, createdAt: AT } },
        })
      ).status,
    ).toBe(201);
    const onPerson = await helloOn(agent.token, PERSON, 'agent-2', clientKey());
    expect(onPerson.status).toBe(403);
    expect(onPerson.body.code).toBe('not-agent-branch');

    // Another agent token's branch of the same document, even with the same session id.
    const other = await issue();
    await makeAgentBranch(other, B2);
    const theirs = await helloOn(agent.token, B2, 'agent-3', clientKey());
    expect(theirs.status).toBe(403);
    expect(theirs.body.code).toBe('not-own-branch');
    expect((await review(agent.token, B2, { review: 'submitted' })).status).toBe(403);
    expect(
      (await call(server, 'DELETE', `/documents/${DOC}/branches/${B2}`, { token: agent.token }))
        .status,
    ).toBe(403);

    // Other documents.
    const other2 = await call(server, 'POST', `/documents/${OTHER}/hello`, {
      token: agent.token,
      key: clientKey(),
      body: hello('agent-4'),
    });
    expect(other2.status).toBe(403);
  });

  it('allowed review moves pass; approving, rejecting, requesting changes and comments are refused', async () => {
    const agent = await setUp();
    await makeAgentBranch(agent);
    const t = agent.token;
    for (const target of ['approved', 'rejected', 'changes-requested']) {
      const r = await review(t, B1, { review: target });
      expect(r.status).toBe(403);
      expect(r.body.code).toBe('review-refused');
    }
    expect((await review(t, B1, { review: 'submitted', comment: 'me' })).status).toBe(403);
    // open to submitted.
    const sub = await review(t, B1, { review: 'submitted', expected: 'open' });
    expect(sub.status).toBe(200);
    expect(sub.body.branch?.provenance?.review).toBe('submitted');
    // Compare-and-set.
    expect((await review(t, B1, { review: 'open', expected: 'open' })).status).toBe(409);
    for (const target of ['approved', 'rejected', 'changes-requested']) {
      expect((await review(t, B1, { review: target })).status).toBe(403);
    }
    // submitted to open (a write), then back (the write failed: nothing landed).
    expect((await review(t, B1, { review: 'open', expected: 'submitted' })).status).toBe(200);
    expect((await review(t, B1, { review: 'submitted', expected: 'open' })).status).toBe(200);

    // The reviewer requests changes with a comment.
    const asked = await review(undefined, B1, {
      review: 'changes-requested',
      expected: 'submitted',
      comment: 'Make it taller.\nThanks',
    });
    expect(asked.status).toBe(200);
    // changes-requested to open, then the restore is allowed while nothing was written...
    expect((await review(t, B1, { review: 'open', expected: 'changes-requested' })).status).toBe(
      200,
    );
    expect((await review(t, B1, { review: 'changes-requested', expected: 'open' })).status).toBe(
      200,
    );
    // ...and refused once a write landed after the reopen.
    expect((await review(t, B1, { review: 'open', expected: 'changes-requested' })).status).toBe(
      200,
    );
    const key = clientKey();
    expect((await helloOn(t, B1, 'agent-1', key)).status).toBe(200);
    expect(
      (await submitOn(t, B1, key, baseDocument(), { clientId: 'agent-1', clientSeq: 1 })).status,
    ).toBe(200);
    const late = await review(t, B1, { review: 'changes-requested', expected: 'open' });
    expect(late.status).toBe(403);
    // The comment survived every move the agent made.
    const listed = await call<{ branches: ServerBranch[] }>(
      server,
      'GET',
      `/documents/${DOC}/branches`,
      { token: t },
    );
    expect(listed.body.branches[0]!.provenance).toEqual({
      origin: 'agent',
      sessionId: SESSION,
      clientName: 'Claude Code',
      review: 'open',
      comment: 'Make it taller.\nThanks',
    });
    // A comment of the owner's that is not text is refused too.
    expect((await review(undefined, B1, { review: 'open', comment: 'bad\u0007' })).status).toBe(
      400,
    );
  });

  for (const closed of ['approved', 'rejected'] as const) {
    it(`a branch the reviewer ${closed} takes no more writes, review moves, bundles or deletion`, async () => {
      const agent = await setUp();
      await makeAgentBranch(agent);
      const key = clientKey();
      expect((await helloOn(agent.token, B1, 'agent-1', key)).status).toBe(200);
      expect((await review(agent.token, B1, { review: 'submitted' })).status).toBe(200);
      expect((await review(undefined, B1, { review: closed, expected: 'submitted' })).status).toBe(
        200,
      );
      const write = await submitOn(agent.token, B1, key, baseDocument(), {
        clientId: 'agent-1',
        clientSeq: 1,
      });
      expect(write.status).toBe(403);
      expect(write.body.code).toBe('branch-closed');
      expect((await helloOn(agent.token, B1, 'agent-1', key)).status).toBe(403);
      for (const target of ['open', 'submitted', 'changes-requested', 'approved', 'rejected']) {
        expect((await review(agent.token, B1, { review: target })).status).toBe(403);
      }
      const bundle = await call(server, 'PUT', `/documents/${DOC}/branches/${B1}/bundle`, {
        token: agent.token,
        body: {
          revision: 1,
          record: { format: 'manufakture-review-bundle', documentId: DOC, branch: B1, revision: 1 },
        },
      });
      expect(bundle.status).toBe(403);
      expect(
        (await call(server, 'DELETE', `/documents/${DOC}/branches/${B1}`, { token: agent.token }))
          .status,
      ).toBe(403);
    });
  }

  it('the WebSocket checks every submit: a branch closed while connected refuses the next one', async () => {
    const agent = await setUp();
    await makeAgentBranch(agent);
    const key = clientKey();
    const socket = new Socket(server, DOC, { token: agent.token, key, branch: B1 });
    await socket.open();
    socket.send(hello('agent-1'));
    await socket.next((m) => m.type === 'welcome');
    const doc = baseDocument();
    socket.send(
      submit([entry(doc, setVariable('h', '1'), { clientId: 'agent-1', clientSeq: 1 })], 1),
    );
    expect(await socket.next((m) => m.type === 'ack')).toEqual({
      type: 'ack',
      clientSeq: 1,
      rev: 1,
    });
    expect((await review(undefined, B1, { review: 'approved' })).status).toBe(200);
    socket.send(
      submit(
        [entry(doc, setVariable('w', '2'), { clientId: 'agent-1', clientSeq: 2, prevSeq: 1 })],
        2,
      ),
    );
    const refused = await socket.next((m) => m.type === 'error');
    expect(refused).toMatchObject({ type: 'error', code: 'invalid-message' });
    expect((refused as { message: string }).message).toContain('branch-closed');
    socket.close();
  });

  it('one writer per agent branch: another client is refused until the lease runs out', async () => {
    const agent = await setUp();
    await makeAgentBranch(agent);
    const k1 = clientKey();
    const k2 = clientKey();
    expect((await helloOn(agent.token, B1, 'agent-1', k1)).status).toBe(200);
    const busy = await helloOn(agent.token, B1, 'agent-2', k2);
    expect(busy.status).toBe(409);
    expect(busy.body.code).toBe('branch-busy');
    // The owner too: the branch has one writer at a time.
    expect((await helloOn(TOKEN, B1, 'owner-1', clientKey())).status).toBe(409);
    clock += 121_000;
    expect((await helloOn(agent.token, B1, 'agent-2', k2)).status).toBe(200);
    // The first one, back, finds it taken now.
    const back = await submitOn(agent.token, B1, k1, baseDocument(), {
      clientId: 'agent-1',
      clientSeq: 1,
    });
    expect(back.status).toBe(409);
    expect(back.body.code).toBe('branch-busy');
  });

  it('a client lets go of the branch it holds (its session closed); nobody else can', async () => {
    const agent = await setUp();
    await makeAgentBranch(agent);
    const k1 = clientKey();
    expect((await helloOn(agent.token, B1, 'agent-1', k1)).status).toBe(200);
    const release = (key: string, clientId = 'agent-1') =>
      call(server, 'POST', `/documents/${DOC}/release?branch=${B1}`, {
        token: agent.token,
        key,
        body: { clientId },
      });
    // Another key, or another token's request, does not free it.
    expect((await release(clientKey())).status).toBe(403);
    expect((await helloOn(agent.token, B1, 'agent-2', clientKey())).status).toBe(409);
    const other = await issue();
    const theirs = await call(server, 'POST', `/documents/${DOC}/release?branch=${B1}`, {
      token: other.token,
      key: k1,
      body: { clientId: 'agent-1' },
    });
    expect(theirs.status).toBe(403);
    expect((await release(k1)).status).toBe(204);
    expect((await helloOn(agent.token, B1, 'agent-2', clientKey())).status).toBe(200);
  });

  it('carries a comment over only from the same session, and never from the request', async () => {
    const agent = await setUp();
    await makeAgentBranch(agent);
    expect((await review(agent.token, B1, { review: 'submitted' })).status).toBe(200);
    expect(
      (await review(undefined, B1, { review: 'changes-requested', comment: 'Wider, please' }))
        .status,
    ).toBe(200);
    const made = await call<{ branch: ServerBranch }>(
      server,
      'POST',
      `/documents/${DOC}/branches`,
      {
        token: agent.token,
        body: { branch: agentBranch(B2, { name: 'Updated' }), commentFrom: B1 },
      },
    );
    expect(made.status).toBe(201);
    expect(made.body.branch.provenance).toMatchObject({ review: 'open', comment: 'Wider, please' });
    // Another session's branch: no.
    const third = '6bcf62d4-b092-4de4-9f87-c2d3e0516e7f';
    const stranger = await call(server, 'POST', `/documents/${DOC}/branches`, {
      token: agent.token,
      body: {
        branch: agentBranch(third, {
          provenance: {
            origin: 'agent',
            sessionId: 'other-session',
            clientName: 'Claude Code',
            review: 'open',
          },
        }),
        commentFrom: B1,
      },
    });
    expect(stranger.status).toBe(400);
  });

  it('deletes its own branch (an update from Main), compare-and-set, never one versions name', async () => {
    const agent = await setUp();
    await makeAgentBranch(agent);
    await makeAgentBranch(agent, B2);
    const t = { token: agent.token };
    expect(
      (await call(server, 'DELETE', `/documents/${DOC}/branches/${B1}?expected=submitted`, t))
        .status,
    ).toBe(409);
    expect(
      (await call(server, 'DELETE', `/documents/${DOC}/branches/${B1}?expected=open`, t)).status,
    ).toBe(204);
    expect((await call(server, 'GET', `/documents/${DOC}/snapshot?branch=${B1}`, t)).status).toBe(
      404,
    );
    // A version names B2: it stays.
    const v = await call(server, 'POST', `/documents/${DOC}/versions`, {
      ...t,
      body: {
        version: { id: 'v-on-b2', name: 'Mid', description: '', branch: B2, rev: 0, createdAt: AT },
      },
    });
    expect(v.status).toBe(201);
    expect((await call(server, 'DELETE', `/documents/${DOC}/branches/${B2}`, t)).status).toBe(409);
  });

  it('stores and serves review bundles of its own open branch', async () => {
    const agent = await setUp();
    await makeAgentBranch(agent);
    const t = { token: agent.token };
    const record = (revision: number) => ({
      format: 'manufakture-review-bundle',
      documentId: DOC,
      branch: B1,
      revision,
      note: 'Taller',
      bundle: { any: 'thing' },
    });
    const path = `/documents/${DOC}/branches/${B1}/bundle`;
    expect((await call(server, 'GET', path, t)).status).toBe(404);
    expect(
      (await call(server, 'PUT', path, { ...t, body: { revision: 1, record: record(1) } })).status,
    ).toBe(201);
    // Not this branch's head, or another branch's record.
    expect(
      (await call(server, 'PUT', path, { ...t, body: { revision: 5, record: record(5) } })).status,
    ).toBe(400);
    expect(
      (
        await call(server, 'PUT', path, {
          ...t,
          body: { revision: 1, record: { ...record(1), branch: B2 } },
        })
      ).status,
    ).toBe(400);
    const got = await call<{ revision: number; record: unknown }>(server, 'GET', path);
    expect(got.body).toEqual({ revision: 1, record: record(1) });
  });
});

describe('the store schema', () => {
  it("upgrades a version 2 database: branches made before are a person's", async () => {
    await createDoc(server);
    await call(server, 'POST', `/documents/${DOC}/versions`, {
      body: {
        version: { id: V1, name: 'Start', description: '', branch: 'main', rev: 0, createdAt: AT },
      },
    });
    await call(server, 'POST', `/documents/${DOC}/branches`, {
      body: { branch: { id: PERSON, name: 'Mine', fromVersion: V1, createdAt: AT } },
    });
    await server.close();
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE old AS SELECT document_id, branch, name, from_version, created_at FROM branch_records;
      DROP TABLE branch_records;
      CREATE TABLE branch_records (
        document_id TEXT NOT NULL, branch TEXT NOT NULL, name TEXT NOT NULL,
        from_version TEXT NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY (document_id, branch)) STRICT;
      INSERT INTO branch_records SELECT * FROM old;
      DROP TABLE old;
    `);
    // Version 2 had no agent tables or attribution columns either.
    db.exec(`
      DROP TABLE review_bundles;
      DROP TABLE agent_tokens;
      ALTER TABLE versions DROP COLUMN created_by;
      ALTER TABLE versions DROP COLUMN start_of;
      ALTER TABLE blobs DROP COLUMN created_by;
    `);
    db.prepare("UPDATE meta SET value = '2' WHERE key = 'schema'").run();
    db.close();
    const store = new SqliteStore(dbPath);
    expect(store.listBranches(DOC)).toEqual([
      { id: PERSON, name: 'Mine', fromVersion: V1, createdAt: AT },
    ]);
    store.close();
    const check = new Database(dbPath, { readonly: true });
    expect(check.prepare("SELECT value FROM meta WHERE key = 'schema'").pluck().get()).toBe(
      String(STORE_SCHEMA_VERSION),
    );
    // The tables and columns T8.4b adds are there (`agent_tokens` comes with the token store,
    // below: the token issued there works).
    const tables = check
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .pluck()
      .all() as string[];
    expect(tables).toContain('review_bundles');
    const columns = (table: string) =>
      (check.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
    expect(columns('branch_records')).toEqual(
      expect.arrayContaining(['provenance', 'created_by', 'reopened_from', 'reopened_head']),
    );
    expect(columns('versions')).toEqual(expect.arrayContaining(['created_by', 'start_of']));
    expect(columns('blobs')).toContain('created_by');
    check.close();
    server = await start(dbPath);
    const agent = await issue();
    expect((await helloOn(agent.token, PERSON, 'a', clientKey())).status).toBe(403);
    const after = new Database(dbPath, { readonly: true });
    expect(
      after.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").pluck().all(),
    ).toContain('agent_tokens');
    after.close();
  });

  it("a damaged stored provenance never reads as a person's branch", async () => {
    const agent = await setUp();
    await makeAgentBranch(agent);
    await server.close();
    const db = new Database(dbPath);
    db.prepare('UPDATE branch_records SET provenance = \'{"origin":"agent"}\'').run();
    db.close();
    server = await start(dbPath);
    const listed = await call<{ branches: ServerBranch[] }>(
      server,
      'GET',
      `/documents/${DOC}/branches`,
    );
    expect(listed.body.branches).toEqual([]);
    expect((await helloOn(agent.token, B1, 'agent-1', clientKey())).status).toBe(404);
  });
});

describe('quotas, attribution and leases (the security audit)', () => {
  const restart = async (limits: Partial<typeof DEFAULT_LIMITS>) => {
    await server.close();
    server = await start(dbPath, { now: () => clock, limits });
  };
  const versions = async () =>
    (
      await call<{ versions: Record<string, unknown>[] }>(
        server,
        'GET',
        `/documents/${DOC}/versions`,
      )
    ).body.versions;
  const startVersion = (id: string, rev = 0) => ({
    id,
    name: 'Agent session start',
    description: '',
    branch: 'main',
    rev,
    createdAt: AT,
  });

  it('an agent token adds no version to main; a start version comes with its branch, attributed', async () => {
    const agent = await setUp();
    const t = { token: agent.token };
    const onMain = await call(server, 'POST', `/documents/${DOC}/versions`, {
      ...t,
      body: { version: startVersion('v-main') },
    });
    expect(onMain.status).toBe(403);
    expect((onMain.body as { code: string }).code).toBe('main-refused');
    // Nobody says who made a version: the server records it.
    const forged = await call(server, 'POST', `/documents/${DOC}/versions`, {
      body: { version: { ...startVersion('v-forged'), createdBy: agent.id } },
    });
    expect(forged.status).toBe(400);

    // The branch and its start version, in one request.
    const made = await call(server, 'POST', `/documents/${DOC}/branches`, {
      ...t,
      body: {
        branch: agentBranch(B1, { fromVersion: 'v-start' }),
        startVersion: startVersion('v-start'),
      },
    });
    expect(made.status).toBe(201);
    expect(await versions()).toEqual([
      expect.objectContaining({ id: V1 }),
      { ...startVersion('v-start'), createdBy: agent.id },
    ]);
    expect((await versions())[0]).not.toHaveProperty('createdBy');
    // A resend is a resend; a start version that is not the branch's, or not of main, is refused.
    expect(
      (
        await call(server, 'POST', `/documents/${DOC}/branches`, {
          ...t,
          body: {
            branch: agentBranch(B1, { fromVersion: 'v-start' }),
            startVersion: startVersion('v-start'),
          },
        })
      ).status,
    ).toBe(200);
    for (const body of [
      { branch: agentBranch(B2, { fromVersion: 'v-x' }), startVersion: startVersion('v-y') },
      {
        branch: agentBranch(B2, { fromVersion: 'v-x' }),
        startVersion: { ...startVersion('v-x'), branch: B1 },
      },
      {
        branch: agentBranch(B2, { fromVersion: 'v-x' }),
        startVersion: { ...startVersion('v-x'), rev: 7 },
      },
    ]) {
      expect(
        (await call(server, 'POST', `/documents/${DOC}/branches`, { ...t, body })).status,
      ).toBe(400);
    }
    // Deleting the branch (an update from Main) takes its start version along.
    expect(
      (await call(server, 'DELETE', `/documents/${DOC}/branches/${B1}?expected=open`, t)).status,
    ).toBe(204);
    expect((await versions()).map((v) => v.id)).toEqual([V1]);
    // The owner's own versions of main stay as they were.
    const mine = await call(server, 'POST', `/documents/${DOC}/versions`, {
      body: { version: startVersion('v-owner') },
    });
    expect(mine.status).toBe(201);
    expect((await versions()).find((v) => v.id === 'v-owner')).not.toHaveProperty('createdBy');
  });

  it('a start version another branch starts from stays when its own branch goes', async () => {
    const agent = await setUp();
    const t = { token: agent.token };
    expect(
      (
        await call(server, 'POST', `/documents/${DOC}/branches`, {
          ...t,
          body: {
            branch: agentBranch(B1, { fromVersion: 'v-start' }),
            startVersion: startVersion('v-start'),
          },
        })
      ).status,
    ).toBe(201);
    // A second session reuses it (Main's head has a version already).
    await makeAgentBranch(agent, B2);
    const second = await call(server, 'POST', `/documents/${DOC}/branches`, {
      ...t,
      body: { branch: agentBranch(PERSON, { fromVersion: 'v-start' }) },
    });
    expect(second.status).toBe(201);
    expect((await call(server, 'DELETE', `/documents/${DOC}/branches/${B1}`, t)).status).toBe(204);
    expect((await versions()).map((v) => v.id)).toContain('v-start');
  });

  it('an agent token keeps at most its quota of agent branches under way (M1)', async () => {
    await restart({ maxAgentBranchesPerToken: 2 });
    const agent = await setUp();
    await makeAgentBranch(agent, B1);
    await makeAgentBranch(agent, B2);
    const third = await call(server, 'POST', `/documents/${DOC}/branches`, {
      token: agent.token,
      body: { branch: agentBranch(PERSON) },
    });
    expect(third.status).toBe(403);
    expect((third.body as { code: string }).code).toBe('branch-quota');
    // Another token has its own quota; the owner has none.
    const other = await issue();
    await makeAgentBranch(other, PERSON);
    // A branch the reviewer closed no longer counts.
    expect((await review(agent.token, B1, { review: 'submitted' })).status).toBe(200);
    expect((await review(undefined, B1, { review: 'rejected' })).status).toBe(200);
    const fourth = '7cd073e5-c1a3-4ef5-a098-d3e4f1627f80';
    await makeAgentBranch(agent, fourth);
  });

  it('an agent token makes at most its quota of versions (M1, M2)', async () => {
    await restart({ maxAgentVersionsPerToken: 2 });
    const agent = await setUp();
    const t = { token: agent.token };
    await call(server, 'POST', `/documents/${DOC}/branches`, {
      ...t,
      body: {
        branch: agentBranch(B1, { fromVersion: 'v-start' }),
        startVersion: startVersion('v-start'),
      },
    });
    const onBranch = (id: string) =>
      call(server, 'POST', `/documents/${DOC}/versions`, {
        ...t,
        body: {
          version: { id, name: 'Mid', description: '', branch: B1, rev: 0, createdAt: AT },
        },
      });
    expect((await onBranch('v-1')).status).toBe(201);
    const over = await onBranch('v-2');
    expect(over.status).toBe(403);
    expect((over.body as { code: string }).code).toBe('version-quota');
    // The start version of a new branch counts too.
    const refused = await call(server, 'POST', `/documents/${DOC}/branches`, {
      ...t,
      body: {
        branch: agentBranch(B2, { fromVersion: 'v-start-2' }),
        startVersion: startVersion('v-start-2'),
      },
    });
    expect(refused.status).toBe(403);
    expect((refused.body as { code: string }).code).toBe('version-quota');
  });

  it('the owner deletes an agent branch with the versions agents made on it, never the owner’s', async () => {
    const agent = await setUp();
    const t = { token: agent.token };
    await makeAgentBranch(agent, B1);
    await makeAgentBranch(agent, B2);
    const version = (id: string, branch: string) => ({
      version: { id, name: 'Mid', description: '', branch, rev: 0, createdAt: AT },
    });
    expect(
      (await call(server, 'POST', `/documents/${DOC}/versions`, { ...t, body: version('a1', B1) }))
        .status,
    ).toBe(201);
    const path = `/documents/${DOC}/branches/${B1}`;
    expect((await call(server, 'DELETE', path)).status).toBe(409);
    // Only the owner may take versions along.
    expect((await call(server, 'DELETE', `${path}?withVersions=true`, t)).status).toBe(403);
    expect((await call(server, 'DELETE', `${path}?withVersions=maybe`)).status).toBe(400);
    expect((await call(server, 'DELETE', `${path}?withVersions=true`)).status).toBe(204);
    expect((await versions()).map((v) => v.id)).toEqual([V1]);

    // A version the owner made on an agent branch keeps it.
    expect(
      (await call(server, 'POST', `/documents/${DOC}/versions`, { body: version('o1', B2) }))
        .status,
    ).toBe(201);
    expect(
      (await call(server, 'DELETE', `/documents/${DOC}/branches/${B2}?withVersions=true`)).status,
    ).toBe(409);
    // And a person's branch takes no versions along.
    expect(
      (
        await call(server, 'POST', `/documents/${DOC}/branches`, {
          body: { branch: { id: PERSON, name: 'Mine', fromVersion: V1, createdAt: AT } },
        })
      ).status,
    ).toBe(201);
    expect(
      (await call(server, 'DELETE', `/documents/${DOC}/branches/${PERSON}?withVersions=true`))
        .status,
    ).toBe(400);
  });

  it('an agent token stores at most its quota of blob bytes (L1)', async () => {
    await restart({ maxAgentBlobBytes: 10 });
    const agent = await setUp();
    const put = (bytes: Uint8Array, token?: string) =>
      call(server, 'PUT', `/blobs/${createHash('sha256').update(bytes).digest('hex')}`, {
        ...(token === undefined ? {} : { token }),
        raw: bytes,
        headers: { 'content-type': 'application/octet-stream' },
      });
    expect((await put(new Uint8Array(6).fill(1), agent.token)).status).toBe(201);
    const over = await put(new Uint8Array(6).fill(2), agent.token);
    expect(over.status).toBe(403);
    expect((over.body as { code: string }).code).toBe('blob-quota');
    // A blob that is there already costs nothing; the owner has no quota.
    expect((await put(new Uint8Array(6).fill(1), agent.token)).status).toBe(200);
    expect((await put(new Uint8Array(6).fill(2))).status).toBe(201);
    expect((await put(new Uint8Array(6).fill(2), agent.token)).status).toBe(200);
  });

  it('review bundles: a body limit of their own, a cap per document, and a cheap look (M3)', async () => {
    await restart({ maxBundleBytes: 4096, maxBundleBytesPerDocument: 6000 });
    const agent = await setUp();
    await makeAgentBranch(agent, B1);
    await makeAgentBranch(agent, B2);
    const t = { token: agent.token };
    const record = (branch: string, revision: number, size: number) => ({
      format: 'manufakture-review-bundle',
      documentId: DOC,
      branch,
      revision,
      pad: 'x'.repeat(size),
    });
    const put = (branch: string, size: number, revision = 1) =>
      call(server, 'PUT', `/documents/${DOC}/branches/${branch}/bundle`, {
        ...t,
        body: { revision, record: record(branch, revision, size) },
      });
    const meta = `/documents/${DOC}/branches/${B1}/bundle/meta`;
    expect((await call(server, 'GET', meta, t)).status).toBe(404);
    expect((await put(B1, 3000)).status).toBe(201);
    const looked = await call<{ revision: number; bytes: number }>(server, 'GET', meta, t);
    expect(looked.status).toBe(200);
    expect(looked.body.revision).toBe(1);
    expect(looked.body.bytes).toBe(JSON.stringify(record(B1, 1, 3000)).length);
    // Larger than the route takes.
    expect((await put(B1, 5000)).status).toBe(413);
    // Past the document's cap with the other branch's bundle; replacing its own is fine.
    const full = await put(B2, 3500);
    expect(full.status).toBe(507);
    expect((full.body as { code: string }).code).toBe('bundle-storage-full');
    expect((await put(B1, 3200)).status).toBe(201);
    expect((await put(B2, 2000)).status).toBe(201);
  });

  it('leases end when the reviewer closes a branch or the token is revoked (L2)', async () => {
    const agent = await setUp();
    await makeAgentBranch(agent, B1);
    expect((await helloOn(agent.token, B1, 'agent-1', clientKey())).status).toBe(200);
    // The owner gets no way around a live lease.
    expect((await helloOn(TOKEN, B1, 'owner-1', clientKey())).status).toBe(409);
    expect((await review(agent.token, B1, { review: 'submitted' })).status).toBe(200);
    expect((await review(undefined, B1, { review: 'approved' })).status).toBe(200);
    expect((await helloOn(TOKEN, B1, 'owner-1', clientKey())).status).toBe(200);

    await makeAgentBranch(agent, B2);
    expect((await helloOn(agent.token, B2, 'agent-2', clientKey())).status).toBe(200);
    expect((await helloOn(TOKEN, B2, 'owner-2', clientKey())).status).toBe(409);
    expect((await call(server, 'DELETE', `/agent-tokens/${agent.id}`)).status).toBe(204);
    expect((await helloOn(TOKEN, B2, 'owner-2', clientKey())).status).toBe(200);
  });
});

describe('start versions, bundle quotas and submitted branches (the security re-audit)', () => {
  const restart = async (limits: Partial<typeof DEFAULT_LIMITS>) => {
    await server.close();
    server = await start(dbPath, { now: () => clock, limits });
  };
  const ids = async () =>
    (
      await call<{ versions: { id: string }[] }>(server, 'GET', `/documents/${DOC}/versions`)
    ).body.versions.map((v) => v.id);
  const startVersion = (id: string) => ({
    id,
    name: 'Agent session start',
    description: '',
    branch: 'main',
    rev: 0,
    createdAt: AT,
  });
  const withStart = (token: string | undefined, branch: string, version: string) =>
    call(server, 'POST', `/documents/${DOC}/branches`, {
      ...(token === undefined ? {} : { token }),
      body: {
        branch: agentBranch(branch, { fromVersion: version }),
        startVersion: startVersion(version),
      },
    });
  const from = (token: string | undefined, branch: string, version: string) =>
    call(server, 'POST', `/documents/${DOC}/branches`, {
      ...(token === undefined ? {} : { token }),
      body: { branch: agentBranch(branch, { fromVersion: version }) },
    });
  const del = (token: string | undefined, path: string) =>
    call<{ code?: string }>(server, 'DELETE', path, token === undefined ? {} : { token });
  /** An agent-made start version whose branch is gone, as an older server could leave one. */
  const orphan = async (version: string, tokenId: string) => {
    await server.close();
    const db = new Database(dbPath);
    db.prepare(
      `INSERT INTO versions
         (document_id, id, branch, rev, name, description, created_at, created_by, start_of)
       VALUES (?, ?, 'main', 0, 'Agent session start', '', ?, ?, 'gone-branch')`,
    ).run(DOC, version, AT, tokenId);
    db.close();
    server = await start(dbPath, { now: () => clock });
  };

  it('a start version goes with the last branch that starts from it, whichever made it', async () => {
    const agent = await setUp();
    expect((await withStart(agent.token, B1, 'v-s')).status).toBe(201);
    // Y starts from X's start version, with none of its own.
    expect((await from(agent.token, B2, 'v-s')).status).toBe(201);
    expect((await del(agent.token, `/documents/${DOC}/branches/${B1}`)).status).toBe(204);
    expect(await ids()).toContain('v-s');
    expect((await del(agent.token, `/documents/${DOC}/branches/${B2}`)).status).toBe(204);
    expect(await ids()).toEqual([V1]);

    // The same through a branch of the owner's: the owner may start from it, and it still goes.
    expect((await withStart(agent.token, B1, 'v-t')).status).toBe(201);
    expect((await from(undefined, PERSON, 'v-t')).status).toBe(201);
    expect((await del(agent.token, `/documents/${DOC}/branches/${B1}`)).status).toBe(204);
    expect((await del(undefined, `/documents/${DOC}/branches/${PERSON}`)).status).toBe(204);
    expect(await ids()).toEqual([V1]);

    // A version the owner made stays when a branch from it goes.
    expect((await from(agent.token, B1, V1)).status).toBe(201);
    expect((await del(agent.token, `/documents/${DOC}/branches/${B1}`)).status).toBe(204);
    expect(await ids()).toEqual([V1]);
  });

  it("an agent token never starts a branch from another token's version", async () => {
    const agent = await setUp();
    const other = await issue();
    expect((await withStart(agent.token, B1, 'v-s')).status).toBe(201);
    const refused = await from(other.token, B2, 'v-s');
    expect(refused.status).toBe(403);
    expect((refused.body as { code: string }).code).toBe('not-own-version');
    // Not by naming it as its own start version either.
    const named = await withStart(other.token, B2, 'v-s');
    expect(named.status).toBe(403);
    expect((named.body as { code: string }).code).toBe('not-own-version');
    // Its own, and the owner's, are fine.
    expect((await from(agent.token, B2, 'v-s')).status).toBe(201);
    expect((await from(other.token, PERSON, V1)).status).toBe(201);
  });

  it("an agent token starts a branch only from a version of main, never of an owner's other branch (N-3)", async () => {
    const agent = await setUp();
    // The owner's own branch, with a change of the owner's on it, and a version there.
    expect((await from(undefined, PERSON, V1)).status).toBe(201);
    const key = clientKey();
    expect((await helloOn(TOKEN, PERSON, 'owner-1', key)).status).toBe(200);
    const wrote = await submitOn(TOKEN, PERSON, key, baseDocument(), {
      clientId: 'owner-1',
      clientSeq: 1,
    });
    expect(wrote.status).toBe(200);
    const onPerson = await call(server, 'POST', `/documents/${DOC}/versions`, {
      body: {
        version: {
          id: 'v-person',
          name: 'Owner work',
          description: '',
          branch: PERSON,
          rev: 1,
          createdAt: AT,
        },
      },
    });
    expect(onPerson.status).toBe(201);

    // A branch from it would hold the owner's change, and its merge preview would carry the
    // owner's commands into main, which the agent branch's log never shows.
    const refused = await from(agent.token, B1, 'v-person');
    expect(refused.status).toBe(403);
    expect((refused.body as { code: string }).code).toBe('not-main-version');
    // Nor from a version on the agent's own branch.
    expect((await from(agent.token, B1, V1)).status).toBe(201);
    const onAgent = await call(server, 'POST', `/documents/${DOC}/versions`, {
      token: agent.token,
      body: {
        version: {
          id: 'v-agent',
          name: 'Agent work',
          description: '',
          branch: B1,
          rev: 0,
          createdAt: AT,
        },
      },
    });
    expect(onAgent.status).toBe(201);
    const ownBranch = await from(agent.token, B2, 'v-agent');
    expect(ownBranch.status).toBe(403);
    expect((ownBranch.body as { code: string }).code).toBe('not-main-version');
    // Nothing was made, and the owner is unaffected.
    const branches = await call<{ branches: { id: string }[] }>(
      server,
      'GET',
      `/documents/${DOC}/branches`,
    );
    expect(branches.body.branches.map((b) => b.id).sort()).toEqual([B1, PERSON].sort());
    expect((await from(undefined, B2, 'v-person')).status).toBe(201);
  });

  it('revoking a token sweeps the start versions it made that no branch starts from', async () => {
    const agent = await setUp();
    const other = await issue();
    expect((await withStart(agent.token, B1, 'v-live')).status).toBe(201);
    await orphan('v-orphan', agent.id);
    await orphan('v-theirs', other.id);
    // A version the agent made on its own branch is not a start version: it stays.
    expect(
      (
        await call(server, 'POST', `/documents/${DOC}/versions`, {
          token: agent.token,
          body: {
            version: {
              id: 'v-mid',
              name: 'Mid',
              description: '',
              branch: B1,
              rev: 0,
              createdAt: AT,
            },
          },
        })
      ).status,
    ).toBe(201);
    expect((await call(server, 'DELETE', `/agent-tokens/${agent.id}`)).status).toBe(204);
    // The orphan goes; the start version its branch still starts from, its version on that
    // branch, and another token's orphan stay.
    expect(await ids()).toEqual([V1, 'v-live', 'v-theirs', 'v-mid']);
  });

  it('the owner deletes an agent-made version no branch starts from, and nothing else', async () => {
    await restart({ maxVersionsPerDocument: 3 });
    const agent = await setUp();
    expect((await withStart(agent.token, B1, 'v-live')).status).toBe(201);
    await orphan('v-orphan', agent.id);
    await restart({ maxVersionsPerDocument: 3 });
    // The document is full: the owner is locked out of new versions.
    const full = await call(server, 'POST', `/documents/${DOC}/versions`, {
      body: { version: startVersion('v-owner') },
    });
    expect(full.status).toBe(403);
    const path = (v: string) => `/documents/${DOC}/versions/${v}`;
    // Never an agent token's to do, even on its own version.
    const byAgent = await del(agent.token, path('v-orphan'));
    expect(byAgent.status).toBe(403);
    expect(byAgent.body.code).toBe('owner-only');
    const kept = await del(undefined, path(V1));
    expect(kept.status).toBe(409);
    expect(kept.body.code).toBe('version-kept');
    const referenced = await del(undefined, path('v-live'));
    expect(referenced.status).toBe(409);
    expect(referenced.body.code).toBe('version-referenced');
    expect((await del(undefined, path('v-nope'))).status).toBe(404);
    expect((await del(undefined, `/documents/doc-none/versions/v-orphan`)).status).toBe(404);
    expect((await del(undefined, path('v-orphan'))).status).toBe(204);
    expect((await del(undefined, path('v-orphan'))).status).toBe(404);
    expect(await ids()).toEqual([V1, 'v-live']);
    // Room again.
    expect(
      (
        await call(server, 'POST', `/documents/${DOC}/versions`, {
          body: { version: startVersion('v-owner') },
        })
      ).status,
    ).toBe(201);
  });

  it('review bundles count against a quota per agent token and a total for the instance', async () => {
    await restart({
      maxBundleBytes: 4096,
      maxBundleBytesPerDocument: 100_000,
      maxAgentBundleBytes: 5000,
      maxBundleTotalBytes: 9000,
    });
    const agent = await setUp();
    const other = await issue();
    await makeAgentBranch(agent, B1);
    await makeAgentBranch(agent, B2);
    await makeAgentBranch(other, PERSON);
    const put = (token: string | undefined, branch: string, size: number, revision = 1) =>
      call<{ code?: string }>(server, 'PUT', `/documents/${DOC}/branches/${branch}/bundle`, {
        ...(token === undefined ? {} : { token }),
        body: {
          revision,
          record: {
            format: 'manufakture-review-bundle',
            documentId: DOC,
            branch,
            revision,
            pad: 'x'.repeat(size),
          },
        },
      });
    expect((await put(agent.token, B1, 3000)).status).toBe(201);
    // Past the token's own quota on its other branch; replacing its bundle is fine.
    const over = await put(agent.token, B2, 3000);
    expect(over.status).toBe(403);
    expect(over.body.code).toBe('bundle-quota');
    expect((await put(agent.token, B1, 3500)).status).toBe(201);
    // Another token has its own quota, within the instance's total.
    expect((await put(other.token, PERSON, 3500)).status).toBe(201);
    // The owner has no token quota, but the instance's total holds for everyone.
    const total = await put(undefined, B2, 3000);
    expect(total.status).toBe(507);
    expect(total.body.code).toBe('bundle-storage-full');
    expect((await put(undefined, B2, 1000)).status).toBe(201);
  });

  it('an agent token writes only an open branch: a submitted one is reopened first', async () => {
    const agent = await setUp();
    await makeAgentBranch(agent);
    const key = clientKey();
    expect((await helloOn(agent.token, B1, 'agent-1', key)).status).toBe(200);
    expect((await review(agent.token, B1, { review: 'submitted', expected: 'open' })).status).toBe(
      200,
    );
    // A hello (the session's keep-alive) is still fine; a write is not.
    expect((await helloOn(agent.token, B1, 'agent-1', key)).status).toBe(200);
    const doc = baseDocument();
    const refused = await submitOn(agent.token, B1, key, doc, {
      clientId: 'agent-1',
      clientSeq: 1,
    });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('branch-not-open');
    const stored = await call<{ branches: ServerBranch[] }>(
      server,
      'GET',
      `/documents/${DOC}/branches`,
    );
    expect(stored.body.branches[0]!.provenance!.review).toBe('submitted');
    // So with changes requested.
    expect(
      (await review(undefined, B1, { review: 'changes-requested', expected: 'submitted' })).status,
    ).toBe(200);
    expect(
      (await submitOn(agent.token, B1, key, doc, { clientId: 'agent-1', clientSeq: 1 })).status,
    ).toBe(409);
    // Reopened (as the session does before it writes), the write lands.
    expect(
      (await review(agent.token, B1, { review: 'open', expected: 'changes-requested' })).status,
    ).toBe(200);
    const ok = await submitOn(agent.token, B1, key, doc, { clientId: 'agent-1', clientSeq: 2 });
    expect(ok.status).toBe(200);
    expect(ok.body.messages).toEqual([{ type: 'ack', clientSeq: 2, rev: 1 }]);
    // And with work landed since it reopened, putting the old state back is refused.
    expect((await review(agent.token, B1, { review: 'changes-requested' })).status).toBe(403);
  });
});

describe('revocation, start versions and evidence under review (the third audit)', () => {
  const ids = async () =>
    (
      await call<{ versions: { id: string }[] }>(server, 'GET', `/documents/${DOC}/versions`)
    ).body.versions.map((v) => v.id);
  const startVersion = (id: string) => ({
    id,
    name: 'Agent session start',
    description: '',
    branch: 'main',
    rev: 0,
    createdAt: AT,
  });
  const withStart = (token: string | undefined, branch: string, version: string) =>
    call(server, 'POST', `/documents/${DOC}/branches`, {
      ...(token === undefined ? {} : { token }),
      body: {
        branch: agentBranch(branch, { fromVersion: version }),
        startVersion: startVersion(version),
      },
    });
  const from = (token: string | undefined, branch: string, version: string, person = false) =>
    call(server, 'POST', `/documents/${DOC}/branches`, {
      ...(token === undefined ? {} : { token }),
      body: {
        branch: person
          ? { id: branch, name: 'Mine', fromVersion: version, createdAt: AT }
          : agentBranch(branch, { fromVersion: version }),
      },
    });
  const del = (token: string | undefined, path: string) =>
    call<{ code?: string }>(server, 'DELETE', path, token === undefined ? {} : { token });
  const startOf = (version: string): string | null => {
    const db = new Database(dbPath, { readonly: true });
    const row = db
      .prepare('SELECT start_of FROM versions WHERE document_id = ? AND id = ?')
      .pluck()
      .get(DOC, version) as string | null;
    db.close();
    return row;
  };
  const bundle = (branch: string, revision = 1) => ({
    revision,
    record: { format: 'manufakture-review-bundle', documentId: DOC, branch, revision },
  });
  const version = (id: string, branch: string) => ({
    version: { id, name: 'Mid', description: '', branch, rev: 0, createdAt: AT },
  });

  it('an agent never deletes a start version the owner made, under a reused branch id (H-1)', async () => {
    const agent = await setUp();
    // The owner makes agent branch X with its start version V; the agent makes Y from V.
    expect((await withStart(undefined, B1, 'v-owner')).status).toBe(201);
    expect(startOf('v-owner')).toBe(B1);
    expect((await from(agent.token, B2, 'v-owner')).status).toBe(201);
    // The owner deletes X: V stays (Y starts from it), and no longer names X.
    expect((await del(undefined, `/documents/${DOC}/branches/${B1}`)).status).toBe(204);
    expect(await ids()).toContain('v-owner');
    expect(startOf('v-owner')).toBe('');
    // The agent makes a new X from V, then deletes Y and X: V is the owner's, so it stays.
    expect((await from(agent.token, B1, 'v-owner')).status).toBe(201);
    expect((await del(agent.token, `/documents/${DOC}/branches/${B2}`)).status).toBe(204);
    expect((await del(agent.token, `/documents/${DOC}/branches/${B1}`)).status).toBe(204);
    expect(await ids()).toEqual([V1, 'v-owner']);
    // Nothing starts from it now: the owner may delete it on its own, unlike a version of theirs
    // that is no start version.
    const path = (v: string) => `/documents/${DOC}/versions/${v}`;
    expect((await del(undefined, path(V1))).body.code).toBe('version-kept');
    expect((await del(agent.token, path('v-owner'))).status).toBe(403);
    expect((await del(undefined, path('v-owner'))).status).toBe(204);
    expect(await ids()).toEqual([V1]);
  });

  it("the owner's start version goes with the owner's last branch from it, never an agent's", async () => {
    const agent = await setUp();
    // Through a branch of the owner's: deleting the last one takes the start version along.
    expect((await withStart(undefined, B1, 'v-a')).status).toBe(201);
    expect((await from(undefined, PERSON, 'v-a', true)).status).toBe(201);
    expect((await del(undefined, `/documents/${DOC}/branches/${B1}`)).status).toBe(204);
    expect(startOf('v-a')).toBe('');
    expect((await del(undefined, `/documents/${DOC}/branches/${PERSON}`)).status).toBe(204);
    expect(await ids()).toEqual([V1]);
    // Through an agent's branch, even one the owner deletes: it stays.
    expect((await withStart(undefined, B1, 'v-b')).status).toBe(201);
    expect((await from(agent.token, B2, 'v-b')).status).toBe(201);
    expect((await del(undefined, `/documents/${DOC}/branches/${B1}`)).status).toBe(204);
    expect((await del(undefined, `/documents/${DOC}/branches/${B2}`)).status).toBe(204);
    expect(await ids()).toEqual([V1, 'v-b']);
    // An agent's start version still goes with the last branch, whoever deletes it.
    expect((await withStart(agent.token, B1, 'v-c')).status).toBe(201);
    expect((await del(undefined, `/documents/${DOC}/branches/${B1}`)).status).toBe(204);
    expect(await ids()).toEqual([V1, 'v-b']);
  });

  it('a request let in before its token was revoked is refused when it is handled (R-2)', async () => {
    const agent = await setUp();
    await makeAgentBranch(agent);
    const key = clientKey();
    expect((await helloOn(agent.token, B1, 'agent-1', key)).status).toBe(200);
    // The service hears of the revocation while the token store still has the token, as for a
    // request already past onRequest when the owner revokes it.
    server.service!.revoked(agent.id);
    const t = { token: agent.token };
    const refused = [
      await helloOn(agent.token, B1, 'agent-1', key),
      await submitOn(agent.token, B1, key, baseDocument(), { clientId: 'agent-1', clientSeq: 1 }),
      await call(server, 'POST', `/documents/${DOC}/branches`, {
        ...t,
        body: { branch: agentBranch(B2) },
      }),
      await call(server, 'POST', `/documents/${DOC}/versions`, { ...t, body: version('v-x', B1) }),
      await call(server, 'PUT', `/documents/${DOC}/branches/${B1}/bundle`, {
        ...t,
        body: bundle(B1),
      }),
      await review(agent.token, B1, { review: 'submitted', expected: 'open' }),
      await call(server, 'DELETE', `/documents/${DOC}/branches/${B1}`, t),
      await call(server, 'PUT', `/blobs/${createHash('sha256').update('x').digest('hex')}`, {
        ...t,
        raw: 'x',
        headers: { 'content-type': 'application/octet-stream' },
      }),
    ];
    expect(refused.map((r) => r.status)).toEqual([401, 401, 401, 401, 401, 401, 401, 401]);
    // Nothing it sent landed.
    expect(await ids()).toEqual([V1]);
    const branches = await call<{ branches: ServerBranch[] }>(
      server,
      'GET',
      `/documents/${DOC}/branches`,
    );
    expect(branches.body.branches.map((b) => [b.id, b.provenance?.review])).toEqual([[B1, 'open']]);
    expect((await call(server, 'GET', `/documents/${DOC}/branches/${B1}/bundle`)).status).toBe(404);
    // The owner is untouched.
    expect((await review(undefined, B1, { review: 'submitted', expected: 'open' })).status).toBe(
      200,
    );
  });

  it('a revoked token writes nothing more over a WebSocket it has open (R-1)', async () => {
    const agent = await setUp();
    await makeAgentBranch(agent);
    const socket = new Socket(server, DOC, { token: agent.token, key: clientKey(), branch: B1 });
    await socket.open();
    socket.send(hello('agent-1'));
    await socket.next((m) => m.type === 'welcome');
    // Revoked as far as the service knows, with the socket still in the transport's set: the
    // next message is dropped and the socket terminated.
    server.service!.revoked(agent.id);
    socket.send(
      submit(
        [entry(baseDocument(), setVariable('h', '1'), { clientId: 'agent-1', clientSeq: 1 })],
        1,
      ),
    );
    await until(() => socket.closed !== undefined, 5_000, 'the socket to close');
    expect(socket.closed?.code).toBe(1006);
    expect(socket.received.filter((m) => m.type === 'ack')).toEqual([]);
    const log = await call<{ messages: { entries: unknown[] }[] }>(
      server,
      'GET',
      `/documents/${DOC}/entries?since=0&branch=${B1}`,
    );
    expect(log.status).toBe(200);
    expect(log.body.messages[0]!.entries).toEqual([]);

    // Through the route: the socket is terminated at once, and a submit sent after cannot land.
    const other = await issue();
    await makeAgentBranch(other, B2);
    const second = new Socket(server, DOC, { token: other.token, key: clientKey(), branch: B2 });
    await second.open();
    second.send(hello('agent-2'));
    await second.next((m) => m.type === 'welcome');
    expect((await call(server, 'DELETE', `/agent-tokens/${other.id}`)).status).toBe(204);
    await until(() => second.closed !== undefined, 5_000, 'the socket to close');
    expect(second.closed?.code).toBe(1006);
    const after = await call<{ messages: { entries: unknown[] }[] }>(
      server,
      'GET',
      `/documents/${DOC}/entries?since=0&branch=${B2}`,
    );
    expect(after.body.messages[0]!.entries).toEqual([]);
  });

  it('an agent adds a review bundle or a version only to an open branch of its own', async () => {
    const agent = await setUp();
    await makeAgentBranch(agent);
    const t = { token: agent.token };
    const put = (token: string | undefined, revision = 1) =>
      call<{ code?: string }>(server, 'PUT', `/documents/${DOC}/branches/${B1}/bundle`, {
        ...(token === undefined ? {} : { token }),
        body: bundle(B1, revision),
      });
    const mid = (token: string | undefined, id: string) =>
      call<{ code?: string }>(server, 'POST', `/documents/${DOC}/versions`, {
        ...(token === undefined ? {} : { token }),
        body: version(id, B1),
      });
    // The session's order: the bundle first, then submitted.
    expect((await put(agent.token)).status).toBe(201);
    expect((await mid(agent.token, 'v-open')).status).toBe(201);
    expect((await review(agent.token, B1, { review: 'submitted', expected: 'open' })).status).toBe(
      200,
    );
    for (const state of ['submitted', 'changes-requested']) {
      if (state === 'changes-requested') {
        expect(
          (await review(undefined, B1, { review: 'changes-requested', expected: 'submitted' }))
            .status,
        ).toBe(200);
      }
      const swapped = await put(agent.token);
      expect(swapped.status).toBe(409);
      expect(swapped.body.code).toBe('branch-not-open');
      const added = await mid(agent.token, `v-${state}`);
      expect(added.status).toBe(409);
      expect(added.body.code).toBe('branch-not-open');
    }
    // A resend of a version it stored while open is still answered as such.
    expect((await mid(agent.token, 'v-open')).status).toBe(200);
    // The stored bundle is the one it submitted; the owner is not held to this.
    expect((await put(undefined, 1)).status).toBe(201);
    expect((await mid(undefined, 'v-owner')).status).toBe(201);
    // Reopened, the agent writes again.
    expect(
      (await review(agent.token, B1, { review: 'open', expected: 'changes-requested' })).status,
    ).toBe(200);
    expect((await put(agent.token)).status).toBe(201);
    expect((await call(server, 'GET', `/documents/${DOC}/versions`, t)).status).toBe(200);
  });
});
