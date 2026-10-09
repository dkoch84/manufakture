// Sessions over sync (T8.4b) against a real sync server with an agent token: the start version and
// the agent branch on the server, batches as entries of the branch's server log, the bundle with
// the branch, the reviewer's decisions taken in before every write, an update from Main that picks
// up the owner's edits and carries the comment over, a resume in another process, one writer per
// branch, and a revoked token.

import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FORMAT_VERSION,
  createdIds,
  type Command,
  type StoredExpression,
  type SyncEntry,
} from '@manufakture/core';
import { ServerApiError, type ServerApi } from '@manufakture/sync';
import { MemoryBundleStore, type BundleBuilder } from './bundles';
import { SessionManager } from './manager';
import type { Session } from './session';
import { SyncBundleStore, SyncedLibrary } from './sync';
import { PART, bracketDocument } from './test/fixtures';
import { ok } from './test/setup';
import { startSyncServer, type TestSyncServer } from './test/sync-server';

const mm = (v: number): StoredExpression => ({
  source: `${v} mm`,
  lengthUnit: 'mm',
  angleUnit: 'deg',
});

const BOSS: unknown[] = [
  {
    type: 'addFeature',
    partId: PART,
    feature: {
      id: 'sketch#$bossSketch',
      kind: 'sketch',
      name: 'Boss sketch',
      suppressed: false,
      plane: { type: 'plane', origin: [0, 0, 40], normal: [0, 0, 1], xDir: [1, 0, 0] },
      entities: [
        { id: 'e$circle', kind: 'circle', construction: false, center: [3, 0], radius: 2 },
      ],
      constraints: [],
    },
  },
  {
    type: 'addFeature',
    partId: PART,
    feature: {
      id: 'extrude#$boss',
      kind: 'extrude',
      name: 'Boss',
      suppressed: false,
      profile: { sketch: 'sketch#$bossSketch' },
      operation: 'add',
      extent: { type: 'blind', distance: mm(5) },
      reverse: false,
    },
  },
];

/** A stub builder: one image, and the two revisions it compares. */
const builder: BundleBuilder = async (base, head, context) => ({
  base: base.versionId,
  head: head.revision,
  image: { sha256: await context.putBlob(new Uint8Array([137, 80, 78, 71, 1, 2, 3])) },
});

let server: TestSyncServer;
let agent: { id: string; token: string };
const DOC = bracketDocument().id;
const sessions: Session[] = [];

function manager(
  token = agent.token,
  options: { keepAliveMs?: number } = {},
): { manager: SessionManager; library: SyncedLibrary } {
  const library = new SyncedLibrary(server.as(token), options);
  return {
    library,
    manager: new SessionManager({
      library,
      locks: library.locks,
      bundles: new SyncBundleStore(new MemoryBundleStore(), library.api),
      engine: 'in-process',
    }),
  };
}

async function open(m = manager().manager): Promise<Session> {
  const s = ok(await m.open({ documentId: DOC, clientName: 'Claude Code' }));
  sessions.push(s);
  return s;
}

/**
 * Another client of the same token on `branch`: its hello (taking the server's lease), and a
 * submit of one rename on top of the branch's head.
 */
async function rawClient(api: ServerApi, branch: string) {
  const writer = {
    clientId: `raw-${randomBytes(4).toString('hex')}`,
    key: randomBytes(32).toString('base64url'),
  };
  await api.hello(DOC, branch, writer);
  return {
    async submit() {
      const snap = await api.snapshot(DOC, branch);
      const command: Command = { type: 'renameDocument', name: 'Raw' };
      const created = createdIds(snap!.document, command);
      if (!created.ok) throw new Error(created.error.message);
      const entry: SyncEntry = {
        clientId: writer.clientId,
        clientSeq: 1,
        baseRev: snap!.rev,
        format: FORMAT_VERSION,
        cause: 'execute',
        label: 'Rename',
        command: command as unknown as SyncEntry['command'],
        created: created.value as SyncEntry['created'],
        at: new Date().toISOString(),
      };
      return api.submit(DOC, branch, writer.key, { type: 'submit', entries: [entry], floor: 1 });
    },
  };
}

beforeEach(async () => {
  server = await startSyncServer();
  await server.create(bracketDocument());
  agent = await server.issue([DOC]);
});

afterEach(async () => {
  for (const s of sessions.splice(0)) await s.close();
  await server.close();
});

describe('a session over sync', () => {
  it('makes its start version and agent branch on the server, and writes batches there', async () => {
    const s = await open();
    const branches = await server.owner.listBranches(DOC);
    expect(branches).toEqual([
      expect.objectContaining({
        id: s.branch,
        provenance: {
          origin: 'agent',
          sessionId: s.id,
          clientName: 'Claude Code',
          review: 'open',
        },
      }),
    ]);
    // The start version came with the branch, recorded as the agent token's.
    const versions = await server.owner.listVersions(DOC);
    expect(versions).toEqual([
      expect.objectContaining({
        name: `Agent session ${s.id} start`,
        branch: 'main',
        rev: 0,
        createdBy: agent.id,
      }),
    ]);
    expect(branches[0]!.fromVersion).toBe(versions[0]!.id);

    const report = ok(await s.apply({ label: 'Add a boss', commands: BOSS }));
    expect(report.revision).toBe(2);
    const log = await server.owner.pull(DOC, s.branch, 0);
    expect(log.map((p) => [p.rev, p.entry.label, p.entry.cause])).toEqual([
      [1, 'Add a boss', 'execute'],
    ]);
    // The server's copy of the branch is the session's document.
    const head = await server.owner.snapshot(DOC, s.branch);
    expect(head?.document.parts[0]!.features.map((f) => f.id)).toEqual(
      s.document.parts[0]!.features.map((f) => f.id),
    );
    // Undo is a batch like any other.
    ok(await s.undo());
    expect((await server.owner.pull(DOC, s.branch, 0)).map((p) => p.entry.cause)).toEqual([
      'execute',
      'undo',
    ]);
    // Main on the server is untouched.
    expect((await server.owner.snapshot(DOC))?.rev).toBe(0);
  });

  it('uploads the bundle and its images with the branch, then takes the reviewer’s decisions in', async () => {
    const s = await open();
    ok(await s.apply({ label: 'Add a boss', commands: BOSS }));
    expect(ok(await s.submit(builder, 'Taller boss')).review).toBe('submitted');
    const bundle = await server.owner.getBundle(DOC, s.branch);
    expect(bundle?.revision).toBe(2);
    expect(bundle?.record).toMatchObject({ branch: s.branch, revision: 2, note: 'Taller boss' });
    const sha = (bundle?.record.bundle as { image: { sha256: string } }).image.sha256;
    expect(await server.owner.getBlob(sha)).toEqual(new Uint8Array([137, 80, 78, 71, 1, 2, 3]));
    expect((await server.owner.listBranches(DOC))[0]!.provenance!.review).toBe('submitted');

    // The reviewer requests changes in the app (the owner, through the server).
    await server.owner.setReview(DOC, s.branch, {
      review: 'changes-requested',
      expected: 'submitted',
      comment: 'Make the boss taller.',
    });
    expect((await s.info()).review).toBe('submitted');
    // The next write sees it and reopens the branch on the server; the comment stays.
    ok(await s.apply({ label: 'Taller', commands: [{ type: 'renameDocument', name: 'Taller' }] }));
    const after = (await server.owner.listBranches(DOC))[0]!.provenance!;
    expect(after).toMatchObject({ review: 'open', comment: 'Make the boss taller.' });
    expect((await s.info()).bundle?.stale).toBe(true);

    // Approved meanwhile: the session writes nothing more.
    ok(await s.submit(builder));
    await server.owner.setReview(DOC, s.branch, { review: 'approved', expected: 'submitted' });
    const refused = await s.apply({
      label: 'Late',
      commands: [{ type: 'renameDocument', name: 'Late' }],
    });
    expect(refused.ok).toBe(false);
    expect(refused).toMatchObject({ ok: false, error: { kind: 'session', code: 'branch-state' } });
    expect((await server.owner.pull(DOC, s.branch, 0)).map((p) => p.entry.label)).toEqual([
      'Add a boss',
      'Taller',
    ]);
  });

  it('update from Main picks up the owner’s concurrent edits on a new branch, comment kept', async () => {
    const s = await open();
    ok(await s.apply({ label: 'Add a boss', commands: BOSS }));
    expect(ok(await s.updateFromMain()).changed).toBe(false);
    ok(await s.submit(builder));
    await server.owner.setReview(DOC, s.branch, {
      review: 'changes-requested',
      comment: 'Thicker, please.',
    });
    // A person edits Main on another device meanwhile.
    const fillet: Command = { type: 'deleteFeature', partId: PART, featureId: 'fillet#1' };
    expect(await server.editMain(DOC, fillet)).toBe(1);

    const old = s.branch;
    const report = ok(await s.updateFromMain());
    expect(report.changed).toBe(true);
    expect(report.previousBranch).toBe(old);
    expect(report.applied).toEqual(['Add a boss']);
    expect(s.branch).toBe(report.branch);
    const features = s.document.parts[0]!.features.map((f) => f.id);
    expect(features).not.toContain('fillet#1');
    expect(features).toContain('extrude#2');
    // On the server: the old branch is gone, the new one open with the comment carried over, made
    // from a version of Main's revision 1, with the replayed batch in its log.
    const branches = await server.owner.listBranches(DOC);
    expect(branches.map((b) => b.id)).toEqual([report.branch]);
    expect(branches[0]!.provenance).toMatchObject({
      review: 'open',
      comment: 'Thicker, please.',
      sessionId: s.id,
    });
    const from = (await server.owner.listVersions(DOC)).find(
      (v) => v.id === branches[0]!.fromVersion,
    );
    expect(from).toMatchObject({ branch: 'main', rev: 1 });
    expect((await server.owner.pull(DOC, report.branch, 0)).map((p) => p.entry.label)).toEqual([
      'Add a boss',
    ]);
    // And work goes on there.
    ok(await s.apply({ label: 'Rename', commands: [{ type: 'renameDocument', name: 'B2' }] }));
    expect((await server.owner.pull(DOC, report.branch, 0)).length).toBe(2);
  });

  it('resumes in another process from the server, with its whole log', async () => {
    const first = manager();
    const s = await open(first.manager);
    ok(await s.apply({ label: 'Add a boss', commands: BOSS }));
    ok(await s.apply({ label: 'Rename', commands: [{ type: 'renameDocument', name: 'B2' }] }));
    const branch = s.branch;
    await s.close();

    const second = manager();
    ok(await second.library.materialize(DOC, branch));
    const resumed = ok(await second.manager.resume({ documentId: DOC, branch }));
    sessions.push(resumed);
    expect(resumed.id).toBe(s.id);
    expect(resumed.document.name).toBe('B2');
    expect(ok(await resumed.history()).map((h) => h.label)).toEqual(['Add a boss', 'Rename']);
    ok(await resumed.undo());
    expect(resumed.document.name).not.toBe('B2');
    expect((await server.owner.pull(DOC, branch, 0)).map((p) => p.entry.cause)).toEqual([
      'execute',
      'execute',
      'undo',
    ]);
  });

  it('one writer per branch: a second process cannot take a branch a live session holds', async () => {
    const s = await open();
    ok(await s.apply({ label: 'Add a boss', commands: BOSS }));
    const other = manager();
    const taken = await other.library.materialize(DOC, s.branch);
    expect(taken).toMatchObject({ ok: false, busy: true });
  });

  it('starts from a version of Main’s head the server has, adding none', async () => {
    const at = new Date().toISOString();
    await server.owner.createVersion(DOC, {
      id: 'owner-head',
      name: 'Release 1',
      description: '',
      branch: 'main',
      rev: 0,
      createdAt: at,
    });
    const s = await open();
    expect((await server.owner.listBranches(DOC))[0]!.fromVersion).toBe('owner-head');
    expect((await server.owner.listVersions(DOC)).map((v) => v.id)).toEqual(['owner-head']);
    ok(await s.apply({ label: 'Add a boss', commands: BOSS }));
    expect((await server.owner.pull(DOC, s.branch, 0)).length).toBe(1);
    // An update from Main onto a head with a version of its own starts from that one too.
    const fillet: Command = { type: 'deleteFeature', partId: PART, featureId: 'fillet#1' };
    expect(await server.editMain(DOC, fillet)).toBe(1);
    await server.owner.createVersion(DOC, {
      id: 'owner-head-2',
      name: 'Release 2',
      description: '',
      branch: 'main',
      rev: 1,
      createdAt: at,
    });
    const report = ok(await s.updateFromMain());
    expect(report.changed).toBe(true);
    const branches = await server.owner.listBranches(DOC);
    expect(branches.map((b) => [b.id, b.fromVersion])).toEqual([[report.branch, 'owner-head-2']]);
    expect((await server.owner.listVersions(DOC)).map((v) => v.id)).toEqual([
      'owner-head',
      'owner-head-2',
    ]);
    expect(s.document.parts[0]!.features.map((f) => f.id)).not.toContain('fillet#1');
  });

  it('a session that ends its branch takes the start version along on the server', async () => {
    const s = await open();
    const old = s.branch;
    const fillet: Command = { type: 'deleteFeature', partId: PART, featureId: 'fillet#1' };
    await server.editMain(DOC, fillet);
    ok(await s.updateFromMain());
    // The old branch went with its start version; the new one has its own.
    const versions = await server.owner.listVersions(DOC);
    const branches = await server.owner.listBranches(DOC);
    expect(branches.map((b) => b.id)).not.toContain(old);
    expect(versions.map((v) => v.id)).toEqual([branches[0]!.fromVersion]);
  });

  it('reuses its own start version of Main’s head, never another token’s', async () => {
    const first = await open();
    const second = await open();
    const other = await server.issue([DOC], 'Another agent');
    const third = await open(manager(other.token).manager);
    const from = new Map(
      (await server.owner.listBranches(DOC)).map((b) => [b.id, b.fromVersion] as const),
    );
    // The same token's second session starts from its first's start version; another token
    // makes its own, which the server records as that token's.
    expect(from.get(second.branch)).toBe(from.get(first.branch));
    expect(from.get(third.branch)).not.toBe(from.get(first.branch));
    const versions = await server.owner.listVersions(DOC);
    expect(versions.find((v) => v.id === from.get(third.branch))?.createdBy).toBe(other.id);
    ok(await third.apply({ label: 'Add a boss', commands: BOSS }));
  });
});

describe('refusals of a submit over sync', () => {
  it('a submit to a submitted branch is refused as branch-not-open, not as a damaged answer', async () => {
    const s = await open();
    ok(await s.apply({ label: 'Add a boss', commands: BOSS }));
    ok(await s.submit(builder));
    const branch = s.branch;
    await s.close();
    const raw = await rawClient(server.as(agent.token), branch);
    const refused = await raw.submit().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(refused).toBeInstanceOf(ServerApiError);
    expect(refused).toMatchObject({ status: 409, code: 'branch-not-open' });
  });
});

describe('the writer lease over sync', () => {
  beforeEach(async () => {
    await server.close();
    server = await startSyncServer({ writerLeaseMs: 400 });
    await server.create(bracketDocument());
    agent = await server.issue([DOC]);
  });

  it('is renewed while the session is open, though the agent writes nothing', async () => {
    const s = await open(manager(agent.token, { keepAliveMs: 100 }).manager);
    // Think for longer than the lease, writing nothing.
    await new Promise((r) => setTimeout(r, 1_200));
    const other = manager();
    expect(await other.library.materialize(DOC, s.branch)).toMatchObject({ ok: false, busy: true });
    ok(await s.apply({ label: 'Add a boss', commands: BOSS }));
    // Closed: let go of at once.
    await s.close();
    ok(await other.library.materialize(DOC, s.branch));
  });

  it('a write refused as branch-busy reaches the session as the busy wording', async () => {
    // No keep-alive within the test: the lease runs out while the agent thinks.
    const s = await open(manager(agent.token, { keepAliveMs: 60_000 }).manager);
    ok(await s.apply({ label: 'Add a boss', commands: BOSS }));
    await new Promise((r) => setTimeout(r, 600));
    // Another client of the same token takes the branch's lease.
    await rawClient(server.as(agent.token), s.branch);
    const r = await s.apply({ label: 'More', commands: [{ type: 'renameDocument', name: 'X' }] });
    expect(r).toMatchObject({
      ok: false,
      error: {
        kind: 'session',
        message: expect.stringMatching(/Another client is writing this branch/),
      },
    });
    expect((await server.owner.pull(DOC, s.branch, 0)).length).toBe(1);
  });

  it('a revoked token ends the work: writes fail with the server’s refusal', async () => {
    const s = await open();
    ok(await s.apply({ label: 'Add a boss', commands: BOSS }));
    await server.revoke(agent.id);
    const r = await s.apply({ label: 'More', commands: [{ type: 'renameDocument', name: 'X' }] });
    expect(r.ok).toBe(false);
    expect(r).toMatchObject({
      ok: false,
      error: { kind: 'session', message: expect.stringMatching(/did not accept the token/) },
    });
    expect((await server.owner.pull(DOC, s.branch, 0)).length).toBe(1);
  });

  it('a token scoped to other documents opens no session here', async () => {
    const other = bracketDocument();
    other.id = 'doc-other';
    await server.create(other);
    const narrow = await server.issue(['doc-other']);
    const r = await manager(narrow.token).manager.open({ documentId: DOC, clientName: 'X' });
    expect(r.ok).toBe(false);
    expect(await server.owner.listBranches(DOC)).toEqual([]);
  });
});
