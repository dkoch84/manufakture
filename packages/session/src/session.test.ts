// Sessions on the M1 bracket with the kernel in this thread (the worker engine has its own file):
// open, apply with symbolic ids, refusals that leave the branch as it was, undo, resume, Main
// refused, update from Main, submit, and every limit ending in its typed error.

import {
  serialize,
  type Command,
  type ManufaktureDocument,
  type StoredExpression,
} from '@manufakture/core';
import { MAIN_BRANCH } from '@manufakture/library';
import { NodeBranchLocks } from '@manufakture/library/node';
import { afterEach, describe, expect, it } from 'vitest';
import type { Session } from './session';
import { PART, bracketDocument } from './test/fixtures';
import { ok, seeded, type Seeded } from './test/setup';

const mm = (v: number): StoredExpression => ({
  source: `${v} mm`,
  lengthUnit: 'mm',
  angleUnit: 'deg',
});

/** A boss on the bracket's upright, by symbolic ids, and a fillet round its top. */
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

/** The bracket's extrusion made `width` mm wide: everything after it rebuilds. */
function widen(doc: ManufaktureDocument, width: number): Command {
  const extrude = doc.parts[0]!.features.find((f) => f.id === 'extrude#1')!;
  return {
    type: 'editFeature',
    partId: PART,
    feature: { ...extrude, extent: { type: 'symmetric', distance: mm(width) } } as never,
  };
}

const open: Session[] = [];
let seed: Seeded;

async function start(
  doc: ManufaktureDocument = bracketDocument(),
  options: Parameters<typeof seeded>[1] = {},
): Promise<Session> {
  seed = await seeded(doc, options);
  const session = ok(
    await seed.manager.open({ documentId: seed.documentId, clientName: 'Test client' }),
  );
  open.push(session);
  return session;
}

afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.close()));
});

describe('open and apply', () => {
  it('opens on a new agent branch from a version of Main, fully regenerated', async () => {
    const s = await start();
    const info = await s.info();
    expect(info.branch).not.toBe(MAIN_BRANCH);
    expect([info.revision, info.review, info.engine]).toEqual([1, 'open', 'in-process']);
    const branches = ok(await seed.library.listBranches(seed.documentId));
    const branch = branches.find((b) => b.id === info.branch)!;
    expect(branch.provenance).toEqual({
      origin: 'agent',
      sessionId: s.id,
      clientName: 'Test client',
      review: 'open',
    });
    const versions = ok(await seed.library.listVersions(seed.documentId));
    expect(versions.map((v) => v.name)).toEqual([`Agent session ${s.id} start`]);
    const tree = ok(await s.tree());
    expect(tree.parts[0]!.features.every((f) => f.status === 'ok')).toBe(true);
    expect(tree.parts[0]!.bodies.map((b) => b.bodyId)).toEqual(['extrude#1']);
  });

  it('lands a batch with symbolic ids under real ids and returns the table', async () => {
    const s = await start();
    const report = ok(await s.apply({ label: 'Add a boss', commands: BOSS }));
    expect(report.symbols).toEqual({
      $bossSketch: 'sketch#3',
      $circle: 'e9',
      $boss: 'extrude#2',
    });
    expect(report.created).toEqual({ 'part:part#1': ['e9', 'extrude#2', 'sketch#3'] });
    expect(report.revision).toBe(2);
    expect(report.statusChanges).toEqual([
      { partId: PART, featureId: 'sketch#3', before: null, after: 'ok' },
      { partId: PART, featureId: 'extrude#2', before: null, after: 'ok' },
    ]);
    expect(report.errors).toEqual([]);
    // The bracket's one body grew by the boss: pi * 2^2 * 5.
    const body = report.measured.find((b) => b.bodyId === 'extrude#1')!;
    expect(body.volume).toBeGreaterThan(14_000);
    const features = s.document.parts[0]!.features;
    expect(features.map((f) => f.id)).toContain('extrude#2');
    expect(JSON.stringify(features)).not.toContain('$');
    // Saved on the branch, Main untouched.
    const reopened = ok(await seed.library.open(seed.documentId, s.branch));
    expect(reopened.revision).toBe(2);
    expect(serialize(reopened.document)).toBe(serialize(s.document));
    expect(ok(await seed.library.open(seed.documentId, MAIN_BRANCH)).revision).toBe(1);
    expect(ok(await s.history())).toEqual([
      expect.objectContaining({ revision: 2, cause: 'execute', label: 'Add a boss' }),
    ]);

    // The boss's faces by query; the next batch names them with the real ids.
    const born = ok(await s.findGeometry({ bornBy: 'extrude#2', kind: 'face' }));
    expect(born.length).toBeGreaterThan(0);
    const side = ok(await s.findGeometry({ bornBy: 'extrude#2', radius: 2 }));
    expect(side).toHaveLength(1);
    expect(side[0]!.surface).toBe('cylinder');
    const top = ok(await s.findGeometry({ normal: [0, 0, 1], nearest: [3, 0, 45], limit: 1 }));
    expect(top[0]!.centroid![2]).toBeCloseTo(45, 6);
    expect(top[0]!.name).toMatch(/^extrude#2:/);
  });

  it('measures the body with its mass when the part has a material', async () => {
    const s = await start();
    ok(
      await s.apply({
        label: 'Aluminium',
        commands: [{ type: 'setMaterial', partId: PART, material: 'aluminium-6061' }],
      }),
    );
    const m = ok(await s.measure({ kind: 'body', partId: PART, bodyId: 'extrude#1' })) as {
      volume: number;
      mass: number;
    };
    expect(m.volume).toBeGreaterThan(14_000);
    expect(m.mass).toBeCloseTo((m.volume * 2700) / 1e6, 6);
  });

  it('a dry run regenerates and reports without saving', async () => {
    const s = await start();
    const before = serialize(s.document);
    const report = ok(await s.apply({ label: 'Try a boss', commands: BOSS, dryRun: true }));
    expect(report.dryRun).toBe(true);
    expect(report.symbols.$boss).toBe('extrude#2');
    expect(report.revision).toBe(1);
    expect(serialize(s.document)).toBe(before);
    expect(ok(await s.history())).toEqual([]);
    const tree = ok(await s.tree());
    expect(tree.parts[0]!.features.map((f) => f.id)).not.toContain('extrude#2');
  });
});

describe('refusals leave the branch unchanged', () => {
  it('a batch core refuses', async () => {
    const s = await start();
    const before = serialize(s.document);
    const r = await s.apply({
      label: 'Delete the profile',
      commands: [{ type: 'deleteFeature', partId: PART, featureId: 'sketch#1' }],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('core');
    expect(serialize(s.document)).toBe(before);
    expect(ok(await seed.library.open(seed.documentId, s.branch)).revision).toBe(1);
    expect(ok(await s.history())).toEqual([]);
  });

  it('a batch whose regen runs over the budget is rolled back', async () => {
    const s = await start();
    const before = serialize(s.document);
    seed.manager.limits.regenMsPerBatch = 1;
    const r = await s.apply({ label: 'Wider', commands: [widen(s.document, 32)] });
    seed.manager.limits.regenMsPerBatch = 30_000;
    expect(r).toEqual({
      ok: false,
      error: expect.objectContaining({ kind: 'session', code: 'regen-timeout', limit: 1 }),
    });
    expect(serialize(s.document)).toBe(before);
    expect(ok(await seed.library.open(seed.documentId, s.branch)).revision).toBe(1);
    // The session goes on from the state before.
    const tree = ok(await s.tree());
    expect(tree.parts[0]!.features.every((f) => f.status === 'ok')).toBe(true);
    ok(await s.apply({ label: 'Wider', commands: [widen(s.document, 32)] }));
  });

  it('a symbol no command creates', async () => {
    const s = await start();
    const r = await s.apply({
      label: 'Suppress nothing',
      commands: [
        { type: 'suppressFeature', partId: PART, featureId: 'fillet#$ghost', suppressed: true },
      ],
    });
    expect(r).toEqual({ ok: false, error: expect.objectContaining({ code: 'symbol' }) });
  });
});

describe('undo and resume', () => {
  it('undoes the last batch as a new revision, and again after a resume', async () => {
    const s = await start();
    const original = s.document.parts[0]!.features;
    ok(await s.apply({ label: 'Add a boss', commands: BOSS }));
    ok(
      await s.apply({
        label: 'Thicker',
        commands: [{ type: 'setVariable', name: 'thickness', expression: mm(8) }],
      }),
    );
    const undone = ok(await s.undo());
    expect([undone.revision, undone.label]).toEqual([4, 'Thicker']);
    expect(s.document.variables[0]!.expression.source).toBe('6 mm');
    expect(ok(await s.history()).map((h) => [h.revision, h.cause, h.label])).toEqual([
      [2, 'execute', 'Add a boss'],
      [3, 'execute', 'Thicker'],
      [4, 'undo', 'Thicker'],
    ]);

    // Close, resume on the same branch: the undo reaches the boss from the library's log.
    const branch = s.branch;
    await s.close();
    const resumed = ok(await seed.manager.resume({ documentId: seed.documentId, branch }));
    open.push(resumed);
    expect(resumed.id).toBe(s.id);
    expect(serialize(resumed.document)).toBe(serialize(s.document));
    ok(await resumed.undo());
    expect(resumed.document.parts[0]!.features).toEqual(original);
    const nothing = await resumed.undo();
    expect(nothing).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'nothing-to-undo' }),
    });
  });

  it('refuses to resume a branch another session holds', async () => {
    const s = await start();
    const second = await seed.manager.resume({ documentId: seed.documentId, branch: s.branch });
    expect(second).toEqual({ ok: false, error: expect.objectContaining({ code: 'locked' }) });
    // Across processes too: the lock is a file.
    const other = await new NodeBranchLocks(seed.root).acquire(seed.documentId, s.branch, 'other');
    expect(other).toBeNull();
  });
});

describe('Main is never written', () => {
  it("refuses to resume Main, or a person's branch", async () => {
    const s = await start();
    void s;
    const main = await seed.manager.resume({ documentId: seed.documentId, branch: MAIN_BRANCH });
    expect(main).toEqual({ ok: false, error: expect.objectContaining({ code: 'main-refused' }) });
    const versions = ok(await seed.library.listVersions(seed.documentId));
    const person = ok(await seed.library.createBranch(seed.documentId, versions[0]!.id, 'Mine'));
    const r = await seed.manager.resume({ documentId: seed.documentId, branch: person.id });
    expect(r).toEqual({ ok: false, error: expect.objectContaining({ code: 'branch-state' }) });
  });

  it('refuses writes once the branch was approved or rejected', async () => {
    const s = await start();
    ok(await seed.library.setBranchReview(seed.documentId, s.branch, 'approved'));
    const r = await s.apply({ label: 'More', commands: [{ type: 'renameDocument', name: 'X' }] });
    expect(r).toEqual({ ok: false, error: expect.objectContaining({ code: 'branch-state' }) });
    expect(ok(await seed.library.open(seed.documentId, MAIN_BRANCH)).document.name).toBe('Bracket');
  });
});

describe('update from Main', () => {
  it("replays the branch onto Main's head and reports the batch that no longer applies", async () => {
    const s = await start();
    ok(
      await s.apply({
        label: 'Bigger fillet',
        commands: [
          {
            type: 'editFeature',
            partId: PART,
            feature: {
              ...s.document.parts[0]!.features.find((f) => f.id === 'fillet#1')!,
              radius: mm(5),
            },
          },
        ],
      }),
    );
    ok(await s.apply({ label: 'Add a boss', commands: BOSS }));
    expect(ok(await s.updateFromMain()).changed).toBe(false);

    // A person deletes the fillet on Main meanwhile.
    const main = ok(await seed.library.open(seed.documentId, MAIN_BRANCH)).document;
    const command: Command = { type: 'deleteFeature', partId: PART, featureId: 'fillet#1' };
    const { applyCommand } = await import('@manufakture/core');
    const next = applyCommand(main, command);
    if (!next.ok) throw new Error(next.error.message);
    await seed.library.save(next.value.document, [
      { cause: 'execute', label: 'No fillet', command, at: new Date().toISOString() },
    ]);

    const old = s.branch;
    const report = ok(await s.updateFromMain());
    expect(report.changed).toBe(true);
    expect(report.previousBranch).toBe(old);
    expect(report.branch).not.toBe(old);
    expect(report.dropped.map((d) => d.label)).toEqual(['Bigger fillet']);
    expect(report.applied).toEqual(['Add a boss']);
    expect(s.branch).toBe(report.branch);
    const features = s.document.parts[0]!.features.map((f) => f.id);
    expect(features).toContain('extrude#2');
    expect(features).not.toContain('fillet#1');
    // The old branch is gone; the new one is an open agent branch with one revision per batch.
    const branches = ok(await seed.library.listBranches(seed.documentId));
    expect(branches.map((b) => b.id)).not.toContain(old);
    expect(branches.find((b) => b.id === report.branch)!.provenance?.review).toBe('open');
    expect(ok(await s.history()).map((h) => h.label)).toEqual(['Add a boss']);
    // Main is as the person left it.
    expect(ok(await seed.library.open(seed.documentId, MAIN_BRANCH)).revision).toBe(2);
    // Work goes on, and the undo reaches the replayed batch.
    ok(await s.undo());
    expect(s.document.parts[0]!.features.map((f) => f.id)).not.toContain('extrude#2');
  });
});

describe('submit', () => {
  it('stores the bundle with the branch, and a later write makes it stale', async () => {
    const s = await start();
    expect(await s.submit(async () => ({}))).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'branch-state' }),
    });
    ok(await s.apply({ label: 'Add a boss', commands: BOSS }));
    const seen: unknown[] = [];
    const submitted = ok(
      await s.submit(async (base, head) => {
        seen.push(base.versionId, head.revision, head.regen !== null);
        return { summary: 'one boss' };
      }, 'Added a boss on the upright.'),
    );
    expect(submitted).toEqual({ revision: 2, review: 'submitted' });
    expect(seen).toEqual([(await s.info()).baseVersion, 2, true]);
    const branches = ok(await seed.library.listBranches(seed.documentId));
    expect(branches.find((b) => b.id === s.branch)!.provenance!.review).toBe('submitted');
    expect((await s.info()).bundle).toEqual({ revision: 2, stale: false });
    // A submitted branch is not resumed by another session (it would race the reviewer).
    ok(
      await s.apply({
        label: 'Thicker',
        commands: [{ type: 'setVariable', name: 'thickness', expression: mm(8) }],
      }),
    );
    const info = await s.info();
    expect(info.review).toBe('open');
    expect(info.bundle).toEqual({ revision: 2, stale: true });
  });
});

describe('limits end in typed errors', () => {
  it('commands per batch', async () => {
    const s = await start(undefined, { limits: { commandsPerBatch: 3 } });
    const commands = [1, 2, 3, 4].map((i) => ({
      type: 'setVariable',
      name: `v${i}`,
      expression: mm(i),
    }));
    expect(await s.apply({ label: 'Many', commands })).toEqual({
      ok: false,
      error: { kind: 'session', code: 'too-many-commands', message: expect.any(String), limit: 3 },
    });
    // Nested batches count by their commands.
    expect(await s.apply({ label: 'Nested', commands: [{ type: 'batch', commands }] })).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'too-many-commands' }),
    });
  });

  it('batches per session', async () => {
    const s = await start(undefined, { limits: { batchesPerSession: 2 } });
    ok(await s.apply({ label: 'One', commands: [{ type: 'renameDocument', name: 'One' }] }));
    ok(await s.apply({ label: 'Two', commands: [{ type: 'renameDocument', name: 'Two' }] }));
    expect(
      await s.apply({ label: 'Three', commands: [{ type: 'renameDocument', name: 'Three' }] }),
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'too-many-batches', limit: 2 }),
    });
    expect(await s.undo()).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'too-many-batches' }),
    });
  });

  it('document size', async () => {
    const s = await start(undefined, {
      limits: { documentBytes: serialize(bracketDocument()).length + 100 },
    });
    const r = await s.apply({
      label: 'Long name',
      commands: [{ type: 'renameDocument', name: 'x'.repeat(200) }],
    });
    expect(r).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'document-too-large' }),
    });
  });

  it('sessions per process', async () => {
    const s = await start(undefined, { limits: { sessionsPerProcess: 1 } });
    void s;
    const second = await seed.manager.open({ documentId: seed.documentId, clientName: 'Second' });
    expect(second).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'too-many-sessions', limit: 1 }),
    });
  });

  it('an idle session closes itself and releases its branch', async () => {
    const s = await start(undefined, { limits: { idleMs: 50 } });
    await new Promise((r) => setTimeout(r, 300));
    expect(s.closed).toBe(true);
    expect(seed.manager.list()).toEqual([]);
    expect(
      await s.apply({ label: 'Late', commands: [{ type: 'renameDocument', name: 'Late' }] }),
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'closed' }),
    });
    const resumed = ok(
      await seed.manager.resume({ documentId: seed.documentId, branch: s.branch }),
    );
    open.push(resumed);
  });

  it('labels', async () => {
    const s = await start();
    for (const label of ['', ' ', 'x'.repeat(201), 'a‮b', 'a\u0000b']) {
      const r = await s.apply({ label, commands: [{ type: 'renameDocument', name: 'X' }] });
      expect(r).toEqual({ ok: false, error: expect.objectContaining({ code: 'invalid-label' }) });
    }
  });
});
