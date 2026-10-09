// @vitest-environment node
//
// An agent's session and a reviewer's browser on one sync server (T8.4b, ADR 0016 decision 10):
// the session (packages/session, kernel in this thread) works with an agent token; the browser's
// library follows the document with the owner's token through `RecordSync`, as the app does. The
// agent branch, its batches and its review bundle reach the reviewer, who reads it with the Review
// view's own loader; the reviewer's decisions reach the agent; approving merges into Main here;
// an update from Main replaces the branch on both sides.
//
// Checked by e2e/tsconfig.json (it starts the server from its sources, a Node module).

import { serialize } from '@manufakture/core';
import { DocumentLibrary, MAIN_BRANCH, MemoryBackend, type Branch } from '@manufakture/library';
import { bundleBuilder } from '@manufakture/review';
import {
  MemoryBundleStore as SessionBundles,
  SessionManager,
  SyncBundleStore,
  SyncedLibrary,
  type Session,
} from '@manufakture/session';
import { bracketDocument } from '@manufakture/session/test-fixtures';
import {
  OWNER_TOKEN,
  startSyncServer,
  type TestSyncServer,
} from '@manufakture/session/test-sync-server';
import { SyncClient } from '@manufakture/sync';
import type { SyncUploads } from '@manufakture/library';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadReview, type AgentBranch } from '../review/review';
import { RecordSync } from './records';

const mm = (v: number) => ({ source: `${v} mm`, lengthUnit: 'mm', angleUnit: 'deg' });
const BOSS: unknown[] = [
  {
    type: 'addFeature',
    partId: 'part#1',
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
    partId: 'part#1',
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

function value<T>(r: { ok: true; value: T } | { ok: false; message?: string; error?: unknown }): T {
  if (!r.ok) throw new Error(JSON.stringify(r));
  return r.value;
}

let server: TestSyncServer;
let session: Session;
let browser: DocumentLibrary;
let records: RecordSync;
const warnings: string[] = [];
const DOC = bracketDocument().id;
/** What the tab saved with its sync state last (`RecordSync.uploads()` when it asked to save). */
let saved: SyncUploads | undefined;
/** Every request the browser's sync of records sent, as `METHOD url`. */
const requests: string[] = [];

/** The browser following the document, as a tab does after a load with `uploads` saved. */
function follow(uploads: SyncUploads | undefined): RecordSync {
  const r: RecordSync = new RecordSync({
    library: browser,
    documentId: DOC,
    server: { url: server.url, token: OWNER_TOKEN },
    client: new SyncClient(bracketDocument(), 0, { clientId: 'browser' }),
    uploads,
    save: () => {
      saved = r.uploads();
    },
    fetch: (input, init) => {
      requests.push(`${init?.method ?? 'GET'} ${String(input)}`);
      return fetch(input, init);
    },
    pollMs: 0,
    warn: (m) => warnings.push(m),
  });
  return r;
}

/** The tab reloads: it stops, and a new one starts from what was saved. */
async function reload(between?: () => Promise<void>): Promise<void> {
  records.stop();
  await between?.();
  records = follow(saved);
  await records.start();
}

beforeEach(async () => {
  server = await startSyncServer();
  const doc = bracketDocument();
  await server.create(doc);
  const agent = await server.issue([DOC], 'Claude Code on this machine');

  // The agent's side: the MCP server's set-up over sync.
  const library = new SyncedLibrary(server.as(agent.token));
  const manager = new SessionManager({
    library,
    locks: library.locks,
    bundles: new SyncBundleStore(new SessionBundles(), library.api),
    engine: 'in-process',
  });
  session = value(await manager.open({ documentId: DOC, clientName: 'Claude Code' }));

  // The reviewer's browser: the document syncing, with the owner's token.
  browser = new DocumentLibrary(new MemoryBackend(), { locks: null, warn: () => undefined });
  await browser.save(doc, []);
  warnings.length = 0;
  requests.length = 0;
  saved = undefined;
  records = follow(undefined);
  await records.start();
}, 60_000);

afterEach(async () => {
  records.stop();
  await session.close();
  await server.close();
});

async function agentBranch(): Promise<AgentBranch> {
  const b = value(await browser.listBranches(DOC)).find((x: Branch) => x.id === session.branch);
  expect(b?.provenance).toBeDefined();
  return b as AgentBranch;
}

describe('an agent branch over sync, seen by the reviewer', () => {
  it('arrives with its batches, provenance and bundle, which the Review view reads', async () => {
    value(await session.apply({ label: 'Add a boss', commands: BOSS }));
    value(await session.submit(bundleBuilder(), 'A boss on the upright.'));
    await records.run();

    const branch = await agentBranch();
    expect(branch.provenance).toEqual({
      origin: 'agent',
      sessionId: session.id,
      clientName: 'Claude Code',
      review: 'submitted',
    });
    // The agent's batch is in the branch's history here, and its head is the session's.
    const history = value(await browser.readHistory(DOC, branch.id));
    expect(history.flatMap((r) => r.entries.map((e) => e.label))).toEqual(['Add a boss']);
    const head = value(await browser.open(DOC, branch.id));
    expect(serialize(head.document)).toBe(serialize(session.document));

    // The bundle, as the Review view loads it: for this branch and head, not stale.
    const loaded = await loadReview(browser, DOC, branch);
    expect(loaded.kind).toBe('ready');
    if (loaded.kind !== 'ready') return;
    expect(loaded.stale).toBe(false);
    expect(loaded.note).toBe('A boss on the upright.');
    // Its images came along, checked against their names.
    const images = loaded.bundle.renders.flatMap((v) =>
      [v.base, v.head].flatMap((i) => (i === null ? [] : [i.sha256])),
    );
    expect(images.length).toBeGreaterThan(0);
    for (const sha of images) expect(await browser.reviewImage(DOC, sha)).not.toBeNull();
    // The merge preview the Review view requires drops nothing, though the branch was made from
    // a version this browser only has from the server.
    const plan = value(await browser.previewMerge(DOC, branch.id, MAIN_BRANCH));
    expect(plan.dropped).toEqual([]);
    expect(warnings).toEqual([]);
  }, 120_000);

  it('the reviewer’s decisions reach the agent, and the agent’s writes come back', async () => {
    value(await session.apply({ label: 'Add a boss', commands: BOSS }));
    value(await session.submit(bundleBuilder()));
    await records.run();

    // Request changes in History, with a comment.
    value(
      await browser.setBranchReview(DOC, session.branch, 'changes-requested', {
        expected: 'submitted',
        comment: 'Make the boss taller.',
      }),
    );
    await records.run();
    expect((await server.owner.listBranches(DOC))[0]!.provenance).toMatchObject({
      review: 'changes-requested',
      comment: 'Make the boss taller.',
    });

    // The agent writes: the branch reopens on the server and here, with the new batch.
    value(
      await session.apply({ label: 'Rename', commands: [{ type: 'renameDocument', name: 'B2' }] }),
    );
    await records.run();
    const branch = await agentBranch();
    expect(branch.provenance).toMatchObject({ review: 'open', comment: 'Make the boss taller.' });
    expect(value(await browser.open(DOC, branch.id)).document.name).toBe('B2');

    // Submitted again, then approved here: the merge into Main, and the state on the server.
    value(await session.submit(bundleBuilder()));
    await records.run();
    const plan = value(await browser.mergeBranch(DOC, session.branch, MAIN_BRANCH));
    expect(plan.plan.dropped).toEqual([]);
    value(
      await browser.setBranchReview(DOC, session.branch, 'approved', { expected: 'submitted' }),
    );
    await records.run();
    expect((await server.owner.listBranches(DOC))[0]!.provenance!.review).toBe('approved');
    const main = value(await browser.open(DOC, MAIN_BRANCH)).document;
    expect(main.name).toBe('B2');
    expect(main.parts[0]!.features.some((f) => f.name === 'Boss')).toBe(true);
    // The agent can write no more.
    const late = await session.apply({
      label: 'Late',
      commands: [{ type: 'renameDocument', name: 'Late' }],
    });
    expect(late.ok).toBe(false);
  }, 120_000);

  it('when both sides moved, the server’s state stands, unless approved here', async () => {
    value(await session.apply({ label: 'Add a boss', commands: BOSS }));
    value(await session.submit(bundleBuilder()));
    await records.run();
    // The agent writes again (reopening the branch on the server) before this browser hears of
    // it; meanwhile the reviewer here requests changes on the submitted branch it shows.
    value(
      await session.apply({ label: 'Rename', commands: [{ type: 'renameDocument', name: 'B3' }] }),
    );
    value(
      await browser.setBranchReview(DOC, session.branch, 'changes-requested', {
        expected: 'submitted',
        comment: 'Too late.',
      }),
    );
    await records.run();
    expect((await server.owner.listBranches(DOC))[0]!.provenance).toMatchObject({
      review: 'open',
    });
    expect((await agentBranch()).provenance).toMatchObject({ review: 'open' });
    expect(warnings.some((w) => /changed on the server/.test(w))).toBe(true);
  }, 120_000);

  it('an update from Main replaces the branch here too, comment carried over', async () => {
    value(await session.apply({ label: 'Add a boss', commands: BOSS }));
    value(await session.submit(bundleBuilder()));
    await records.run();
    value(
      await browser.setBranchReview(DOC, session.branch, 'changes-requested', {
        comment: 'Follow the new Main.',
      }),
    );
    await records.run();
    const old = session.branch;
    await server.editMain(DOC, { type: 'deleteFeature', partId: 'part#1', featureId: 'fillet#1' });
    const report = value(await session.updateFromMain());
    expect(report.changed).toBe(true);
    await records.run();
    const ids = value(await browser.listBranches(DOC)).map((b) => b.id);
    expect(ids).not.toContain(old);
    expect(ids).toContain(report.branch);
    const fresh = await agentBranch();
    expect(fresh.provenance).toMatchObject({ review: 'open', comment: 'Follow the new Main.' });
  }, 120_000);

  it('a reload keeps a sent decision sent: the agent’s resubmission stands', async () => {
    value(await session.apply({ label: 'Add a boss', commands: BOSS }));
    value(await session.submit(bundleBuilder()));
    await records.run();
    value(
      await browser.setBranchReview(DOC, session.branch, 'changes-requested', {
        expected: 'submitted',
        comment: 'Make the boss taller.',
      }),
    );
    await records.run();
    expect((await server.owner.listBranches(DOC))[0]!.provenance!.review).toBe('changes-requested');
    // The tab reloads while the agent works on the changes and submits again.
    await reload(async () => {
      value(
        await session.apply({
          label: 'Taller',
          commands: [{ type: 'renameDocument', name: 'Taller' }],
        }),
      );
      value(await session.submit(bundleBuilder()));
    });
    // The resubmission stands on the server, and is taken in here.
    expect((await server.owner.listBranches(DOC))[0]!.provenance).toMatchObject({
      review: 'submitted',
      comment: 'Make the boss taller.',
    });
    expect((await agentBranch()).provenance).toMatchObject({ review: 'submitted' });
    expect(value(await browser.open(DOC, session.branch)).document.name).toBe('Taller');
    expect(warnings).toEqual([]);
  }, 120_000);

  it('a reload keeps a decision not sent yet, and sends it', async () => {
    value(await session.apply({ label: 'Add a boss', commands: BOSS }));
    value(await session.submit(bundleBuilder()));
    await records.run();
    // Decided here; the tab reloads before it is sent.
    value(
      await browser.setBranchReview(DOC, session.branch, 'changes-requested', {
        expected: 'submitted',
        comment: 'Wider.',
      }),
    );
    await reload();
    expect((await server.owner.listBranches(DOC))[0]!.provenance).toMatchObject({
      review: 'changes-requested',
      comment: 'Wider.',
    });
  }, 120_000);

  it('agent branches replaced while the tab was closed go, except closed ones', async () => {
    value(await session.apply({ label: 'Add a boss', commands: BOSS }));
    value(await session.submit(bundleBuilder()));
    await records.run();
    const old = session.branch;
    // The tab closes; Main moves and the agent updates its branch from it meanwhile.
    records.stop();
    await server.editMain(DOC, { type: 'deleteFeature', partId: 'part#1', featureId: 'fillet#1' });
    const report = value(await session.updateFromMain());
    expect(report.changed).toBe(true);
    // A tab whose sync state knew nothing of the agent's branches.
    records = follow(undefined);
    await records.start();
    const ids = value(await browser.listBranches(DOC)).map((b) => b.id);
    expect(ids).not.toContain(old);
    expect(ids).toContain(report.branch);

    // Approved here, then deleted on the server by the owner: it stays here.
    value(await session.submit(bundleBuilder()));
    await records.run();
    value(await browser.mergeBranch(DOC, session.branch, MAIN_BRANCH));
    value(
      await browser.setBranchReview(DOC, session.branch, 'approved', { expected: 'submitted' }),
    );
    await records.run();
    const approved = session.branch;
    await session.close();
    await server.owner.deleteBranch(DOC, approved, 'approved', { withVersions: true });
    await records.run();
    expect(value(await browser.listBranches(DOC)).map((b) => b.id)).toContain(approved);
  }, 120_000);

  it('approved here while the server moved: sent again only while the branch is what was approved', async () => {
    value(await session.apply({ label: 'Add a boss', commands: BOSS }));
    value(await session.submit(bundleBuilder()));
    await records.run();
    const merge = async () => {
      value(await browser.mergeBranch(DOC, session.branch, MAIN_BRANCH));
      value(
        await browser.setBranchReview(DOC, session.branch, 'approved', { expected: 'submitted' }),
      );
    };
    // The review state moved on the server (another device of the owner's), with no write.
    await merge();
    await server.owner.setReview(DOC, session.branch, {
      review: 'changes-requested',
      expected: 'submitted',
      comment: 'From the laptop.',
    });
    await records.run();
    expect((await server.owner.listBranches(DOC))[0]!.provenance!.review).toBe('approved');
    expect(warnings).toEqual([]);
  }, 120_000);

  it('approved here after the agent wrote again: the server keeps its state, and the reviewer is told', async () => {
    value(await session.apply({ label: 'Add a boss', commands: BOSS }));
    value(await session.submit(bundleBuilder()));
    await records.run();
    value(await browser.mergeBranch(DOC, session.branch, MAIN_BRANCH));
    value(
      await browser.setBranchReview(DOC, session.branch, 'approved', { expected: 'submitted' }),
    );
    // Before this browser sends it, the agent writes (reopening the branch on the server).
    value(
      await session.apply({ label: 'Late', commands: [{ type: 'renameDocument', name: 'Late' }] }),
    );
    await records.run();
    expect((await server.owner.listBranches(DOC))[0]!.provenance!.review).toBe('open');
    expect(warnings.some((w) => /approved here was written to on the server/.test(w))).toBe(true);
    // Here it stays approved, without the agent's later batch.
    const branch = await agentBranch();
    expect(branch.provenance!.review).toBe('approved');
    expect(value(await browser.open(DOC, branch.id)).document.name).not.toBe('Late');
    // A closed branch is left alone from then on: no request about it at all, and no resend.
    requests.length = 0;
    await records.run();
    expect(requests.filter((r) => r.includes(branch.id))).toEqual([]);
    expect((await server.owner.listBranches(DOC))[0]!.provenance!.review).toBe('open');
  }, 120_000);
});
