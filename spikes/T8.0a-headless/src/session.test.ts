// The session model on the three fixtures: open on a new agent branch, apply each fixture's
// batches, undo one, save, close, reopen from disk with a new library (as a new process would),
// and check that the reopened branch regenerates to exactly what the closed session held. Then
// the limits and the lock, each ending in a typed refusal with the branch unchanged.
//
// Writes results/session.json.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Command } from '../../../packages/core/src/index';
import {
  bracketVolume,
  engraveBatch,
  FIXTURES,
  longRunBatch,
  storyBatches,
  type FixtureName,
} from './fixtures';
import { BranchLocked } from './fs-backend';
import { nodeHost, type NodeHost } from './host';
import { nodeSummary } from './node-summary';
import { libraryAt, openFixture } from './open';
import { memory, round, writeResult } from './results';
import { HeadlessSession, PLAN_LIMITS, type BatchReport } from './session';
import { compareSummaries } from './summary';
import { MAIN_BRANCH } from './vendor/persistence/library';

let host: NodeHost;
const out: Record<string, unknown> = {};

beforeAll(async () => {
  host = await nodeHost();
});

afterAll(() => {
  writeResult('session', out);
});

const brief = (r: BatchReport) =>
  r.ok
    ? {
        ok: true,
        revision: r.revision,
        ms: Object.fromEntries(Object.entries(r.ms).map(([k, v]) => [k, round(v)])),
        counters: r.counters,
        statusChanges: r.statusChanges,
        errors: r.errors,
        measured: r.measured.length,
      }
    : { ok: false, code: r.code, message: r.message, ms: round(r.ms) };

describe('a session per fixture: open, batches, undo, save, reopen', () => {
  it.each(FIXTURES)('%s', async (name: FixtureName) => {
    const o = await openFixture(name, { host, dir: `session-${name}`, sessionId: `s1-${name}` });
    const { session, library } = o;
    const failing = session.last.parts.flatMap((p) => p.features.filter((f) => f.status !== 'ok'));
    expect(failing.map((f) => f.featureId)).toEqual([]);
    if (name === 'bracket') {
      const shape = session.last.parts[0]!.bodies[0]!.shape;
      const reply = await host.service.run({
        generation: session.engine.generation,
        ops: [{ op: 'measure', shape, targets: [], body: true }],
      });
      const r = reply.results[0]!;
      expect(r.ok).toBe(true);
      if (r.ok)
        expect((r.value as { body: { volume: number } }).body.volume).toBeCloseTo(
          bracketVolume(6),
          3,
        );
    }

    const reports: BatchReport[] = [];
    for (const make of storyBatches(name)) {
      const report = await session.apply(make(session.document));
      expect(report.ok, JSON.stringify(report)).toBe(true);
      if (report.ok) expect(report.errors).toEqual([]);
      reports.push(report);
    }
    // Incremental regens: the long run's first ten edits, the first one dropped (it may load
    // something lazily, as the first text does).
    const incremental: number[] = [];
    for (let i = 0; i < 11; i++) {
      const report = await session.apply(longRunBatch(name, session.document, i));
      expect(report.ok, JSON.stringify(report)).toBe(true);
      if (report.ok && i > 0) incremental.push(report.ms.regen);
    }
    const undone = await session.undo();
    expect(undone.ok).toBe(true);
    const head = session.document;
    const revision = session.revision;
    const before = await nodeSummary({ ...host }, head);
    await session.close();

    // Main is as the person left it: revision 1, with the session's start version.
    const main = await library.open(head.id, MAIN_BRANCH);
    expect(main.ok && main.value.revision).toBe(1);
    const versions = await library.listVersions(head.id);
    expect(versions.ok && versions.value.map((v) => v.name)).toEqual([
      `Agent session s1-${name} start`,
    ]);
    const history = await library.readHistory(head.id, session.branch);
    expect(history.ok && history.value.length).toBe(revision - 1);

    // Reopen from disk with a new library, as a new process would, and resume the branch.
    const again = libraryAt(o.root);
    const t = performance.now();
    const { session: resumed, ms: resumeMs } = await HeadlessSession.open(
      { library: again.library, root: o.root, ...host },
      head.id,
      { sessionId: `s2-${name}`, resume: session.branch },
    );
    const reopenMs = performance.now() - t;
    expect(resumed.revision).toBe(revision);
    expect(resumed.document).toEqual(head);
    const after = await nodeSummary({ ...host }, resumed.document);
    expect(compareSummaries(before.summary, after.summary)).toEqual([]);
    await resumed.close();

    out[name] = {
      open: Object.fromEntries(Object.entries(o.ms).map(([k, v]) => [k, round(v)])),
      features: session.last.parts.reduce((n, p) => n + p.features.length, 0),
      bodies: before.summary.bodies.length,
      members: before.summary.members.reduce((n, m) => n + m.count, 0),
      triangles: before.summary.bodies.reduce((n, b) => n + b.triangles, 0),
      story: reports.map(brief),
      incrementalRegenMs: {
        median: round(median(incremental)),
        min: round(Math.min(...incremental)),
        max: round(Math.max(...incremental)),
      },
      fullRegenOfHeadMs: round(before.regenMs),
      reopen: {
        totalMs: round(reopenMs),
        steps: Object.fromEntries(Object.entries(resumeMs).map(([k, v]) => [k, round(v)])),
      },
      revisions: revision,
      disk: o.backend.counts,
      memory: memory(),
      kernelHeapMiB: round(host.service.stats().heapBytes / 2 ** 20),
    };
  });
});

describe('limits and the lock: typed refusals, the branch unchanged', () => {
  it('refuses a batch over the command limit before running it', async () => {
    const o = await openFixture('bracket', { host, dir: 'limit-commands' });
    const doc = o.session.document;
    const many: Command = {
      type: 'batch',
      commands: Array.from({ length: PLAN_LIMITS.commandsPerBatch + 1 }, (_, i) => ({
        type: 'setVariable',
        name: `v${i}`,
        expression: { source: String(i), lengthUnit: 'mm', angleUnit: 'deg' },
      })),
    } as Command;
    const t = performance.now();
    const r = await o.session.apply({ label: 'Too many', command: many });
    const refuseMs = performance.now() - t;
    expect(r).toMatchObject({ ok: false, code: 'batch-limit' });
    expect(o.session.document).toBe(doc);
    expect(o.session.revision).toBe(1);

    // The largest allowed batch: 500 variables in one command, timed (core applies, validates
    // and diffs the whole document once).
    const allowed: Command = {
      type: 'batch',
      commands: (many as { commands: Command[] }).commands.slice(0, PLAN_LIMITS.commandsPerBatch),
    } as Command;
    const big = await o.session.apply({ label: '500 variables', command: allowed });
    expect(big.ok).toBe(true);
    // A core error is data too: an unknown feature in an edit.
    const bad = await o.session.apply({
      label: 'Bad edit',
      command: { type: 'deleteFeature', partId: 'part#1', featureId: 'extrude#99' } as Command,
    });
    expect(bad.ok).toBe(false);
    await o.session.close();
    out.limits = {
      ...(out.limits as object),
      overLimit: brief(r),
      overLimitRefuseMs: round(refuseMs, 2),
      fiveHundredCommands: brief(big),
      coreError: brief(bad),
    };
  });

  it('rolls back a batch whose regen runs over the time limit', async () => {
    const o = await openFixture('bookshelf', {
      host,
      dir: 'limit-regen',
      // Far under a width change's regen, so the cancel path runs.
      limits: { ...PLAN_LIMITS, regenMsPerBatch: 50 },
    });
    const doc = o.session.document;
    const t = performance.now();
    const r = await o.session.apply(longRunBatch('bookshelf', doc, 1));
    const ms = performance.now() - t;
    expect(r).toMatchObject({ ok: false, code: 'regen-timeout' });
    expect(o.session.document).toEqual(doc);
    expect(o.session.revision).toBe(1);
    // The session still works after the rollback.
    const next = await o.session.apply({
      label: 'Rename',
      command: {
        type: 'renameFeature',
        partId: 'part#1',
        featureId: 'extension#11',
        name: 'Top',
      } as Command,
    });
    expect(next.ok).toBe(true);
    await o.session.close();
    out.limits = {
      ...(out.limits as object),
      regenTimeout: brief(r),
      regenTimeoutWallMs: round(ms),
    };
  });

  it('ends a session at its batch limit', async () => {
    const o = await openFixture('bracket', {
      host,
      dir: 'limit-batches',
      limits: { ...PLAN_LIMITS, batchesPerSession: 2 },
    });
    for (let i = 0; i < 2; i++) {
      expect((await o.session.apply(longRunBatch('bracket', o.session.document, i))).ok).toBe(true);
    }
    const r = await o.session.apply(longRunBatch('bracket', o.session.document, 2));
    expect(r).toMatchObject({ ok: false, code: 'session-limit' });
    await o.session.close();
  });

  it('lets one session at a time hold a branch', async () => {
    const o = await openFixture('bracket', { host, dir: 'lock' });
    await expect(
      HeadlessSession.open({ library: o.library, root: o.root, ...host }, o.session.document.id, {
        sessionId: 'second',
        resume: o.session.branch,
      }),
    ).rejects.toBeInstanceOf(BranchLocked);
    // A second session on the same document gets a branch of its own.
    const other = await HeadlessSession.open(
      { library: o.library, root: o.root, ...host },
      o.session.document.id,
      { sessionId: 'second' },
    );
    expect(other.session.branch).not.toBe(o.session.branch);
    await other.session.close();
    await o.session.close();
  });

  it('engraves text with the bundled font, the only asset a session fetches', async () => {
    const o = await openFixture('bracket', { host, dir: 'text' });
    const r = await o.session.apply(engraveBatch('ÅBC-123'));
    expect(r.ok && r.errors).toEqual([]);
    expect(r.ok && r.measured[0]!.volume).toBeLessThan(bracketVolume(6) - 10);
    await o.session.close();
  });
});

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? NaN : s[Math.floor(s.length / 2)]!;
}
