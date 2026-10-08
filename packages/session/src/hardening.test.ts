// The session under hostile or unlucky conditions (the T8.1c security review): kernel calls that
// hang end in `kernel-timeout` and a new kernel, a stuck call never keeps a session from closing,
// a reviewer's decision made while a batch regenerates is never overwritten, a batch's shape is
// checked before anything parses it, and storage or worker errors reach the agent only in general
// terms. The kernel runs in this thread, wrapped so that chosen calls hang.

import { applyCommand, type ManufaktureDocument } from '@manufakture/core';
import { importSource } from '@manufakture/io';
import { DEFAULT_HEAP_THRESHOLD } from '@manufakture/kernel';
import { MAIN_BRANCH, type DocumentLibrary, type ReviewState } from '@manufakture/library';
import { NodeBranchLocks } from '@manufakture/library/node';
import { afterEach, describe, expect, it } from 'vitest';
import { BackendBundleStore } from './bundles';
import { InProcessEngine, KernelTimeout, type Engine, type EngineApi } from './engine';
import { References } from './imports';
import { sessionLimits, type SessionLimits } from './limits';
import { Session, type SessionHost, type SessionLogEvent } from './session';
import { MAX_BATCH_DEPTH, MAX_JSON_DEPTH, PLACEHOLDER_BASE, resolveSymbols } from './symbols';
import { PART, bracketDocument } from './test/fixtures';
import { ok, seeded, type Seeded } from './test/setup';

const never = <T>() => new Promise<T>(() => undefined);

/** An in-process engine whose API calls go through `patch`; `kill` restarts it (as a worker). */
class Patched implements Engine {
  readonly kind = 'in-process' as const;
  kills = 0;
  constructor(
    readonly inner: Engine,
    readonly patch: (api: EngineApi) => EngineApi,
  ) {}
  get api(): EngineApi {
    return this.patch(this.inner.api);
  }
  get replaced(): number {
    return this.inner.replaced + this.kills;
  }
  restart(): Promise<void> {
    return this.inner.restart();
  }
  async kill(): Promise<boolean> {
    this.kills++;
    await this.inner.restart();
    return true;
  }
  wantsRestart(): Promise<boolean> {
    return this.inner.wantsRestart();
  }
  close(): Promise<void> {
    return this.inner.close();
  }
}

/** A library whose methods `overrides` replace (the rest is `library`'s). */
function libraryWith(
  library: DocumentLibrary,
  overrides: Partial<Record<keyof DocumentLibrary, unknown>>,
): DocumentLibrary {
  return new Proxy(library, {
    get(target, key) {
      const own = (overrides as Record<string | symbol, unknown>)[key];
      if (own !== undefined) return own;
      const v = Reflect.get(target, key) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}

interface Harness {
  seed: Seeded;
  host: SessionHost;
  engines: Patched[];
  logged: SessionLogEvent[];
}

async function harness(
  options: {
    doc?: ManufaktureDocument;
    patch?: (api: EngineApi) => EngineApi;
    limits?: Partial<SessionLimits>;
    library?: (library: DocumentLibrary) => DocumentLibrary;
    engine?: () => Promise<Engine>;
    locks?: SessionHost['locks'];
    isOpen?: (id: string) => boolean;
  } = {},
): Promise<Harness> {
  const seed = await seeded(options.doc ?? bracketDocument());
  const engines: Patched[] = [];
  const logged: SessionLogEvent[] = [];
  const host: SessionHost = {
    library: options.library ? options.library(seed.library) : seed.library,
    locks: options.locks ?? new NodeBranchLocks(seed.root),
    limits: sessionLimits({ sessionsPerProcess: 2, ...options.limits }),
    bundles: new BackendBundleStore(seed.backend),
    engine:
      options.engine ??
      (async () => {
        const inner = await InProcessEngine.start({ heapThresholdBytes: DEFAULT_HEAP_THRESHOLD });
        const e = new Patched(inner, options.patch ?? ((api) => api));
        engines.push(e);
        return e;
      }),
    log: (event) => logged.push(event),
    ...(options.isOpen ? { isOpen: options.isOpen } : {}),
  };
  return { seed, host, engines, logged };
}

const open: Session[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.close()));
});

async function opened(h: Harness): Promise<Session> {
  const s = ok(await Session.open(h.host, { documentId: h.seed.documentId, clientName: 'Test' }));
  open.push(s);
  return s;
}

const rename = (name: string) => ({ label: name, commands: [{ type: 'renameDocument', name }] });
const hasMeasure = (ops: readonly { op: string }[]) => ops.some((o) => o.op === 'measure');

describe('kernel calls have a deadline', () => {
  it('a measurement that hangs ends the kernel with kernel-timeout; the next call works', async () => {
    let hangs = 1;
    const h = await harness({
      limits: { kernelMsPerCall: 200 },
      patch: (api) => ({
        ...api,
        run: ((request) =>
          hasMeasure(request.ops) && hangs-- > 0 ? never() : api.run(request)) as EngineApi['run'],
      }),
    });
    const s = await opened(h);
    const t0 = performance.now();
    const r = await s.measure({ kind: 'body', partId: PART, bodyId: 'extrude#1' });
    expect(r).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'kernel-timeout', limit: 200 }),
    });
    expect(performance.now() - t0).toBeLessThan(10_000);
    expect(h.engines[0]!.kills).toBe(1);
    const again = ok(await s.measure({ kind: 'body', partId: PART, bodyId: 'extrude#1' })) as {
      volume: number;
    };
    expect(again.volume).toBeGreaterThan(0);
  });

  it('a batch whose measurement hangs is saved, measured as nothing, on a new kernel', async () => {
    let hangs = 0;
    const h = await harness({
      limits: { kernelMsPerCall: 200 },
      patch: (api) => ({
        ...api,
        run: ((request) =>
          hasMeasure(request.ops) && hangs-- > 0 ? never() : api.run(request)) as EngineApi['run'],
      }),
    });
    const s = await opened(h);
    const doc = s.document;
    const extrude = doc.parts[0]!.features.find((f) => f.id === 'extrude#1')!;
    hangs = 1;
    const report = ok(
      await s.apply({
        label: 'Wider',
        commands: [
          {
            type: 'editFeature',
            partId: PART,
            feature: {
              ...extrude,
              extent: {
                type: 'symmetric',
                distance: { source: '37 mm', lengthUnit: 'mm', angleUnit: 'deg' },
              },
            },
          },
        ],
      }),
    );
    expect([report.revision, report.measured]).toEqual([2, []]);
    expect(h.engines[0]!.kills).toBe(1);
    // The new kernel holds the saved document's shapes.
    const tree = ok(await s.tree());
    expect(tree.parts[0]!.features.every((f) => f.status === 'ok')).toBe(true);
    ok(await s.measure({ kind: 'body', partId: PART, bodyId: 'extrude#1' }));
  });

  it('a STEP reference that hangs is kept as its error and not read again', async () => {
    let reads = 0;
    const r = applyCommand(bracketDocument(), {
      type: 'addFeature',
      partId: PART,
      feature: {
        id: 'import#1',
        kind: 'import',
        name: 'Slow',
        suppressed: false,
        source: await importSource('step', 'slow.step', new TextEncoder().encode('ISO-10303-21;')),
        operation: 'reference',
      },
    } as never);
    if (!r.ok) throw new Error(r.error.message);
    const h = await harness({
      doc: r.value.document,
      limits: { kernelMsPerCall: 200 },
      patch: (api) => ({
        ...api,
        run: ((request) => {
          if (request.ops.some((o) => o.op === 'importStep')) {
            reads++;
            return never();
          }
          return api.run(request);
        }) as EngineApi['run'],
      }),
    });
    const s = await opened(h);
    expect(reads).toBe(1);
    expect(h.engines[0]!.kills).toBe(1);
    const errors = ok(await s.errors());
    expect(JSON.stringify(errors)).toContain('took too long to read');
    ok(await s.apply(rename('Still here')));
    expect(reads).toBe(1);
  });

  it('References.sync records a STEP read that ran over as the body error', async () => {
    const r = applyCommand(bracketDocument(), {
      type: 'addFeature',
      partId: PART,
      feature: {
        id: 'import#1',
        kind: 'import',
        name: 'Slow',
        suppressed: false,
        source: await importSource('step', 's.step', new Uint8Array([1, 2, 3])),
        operation: 'reference',
      },
    } as never);
    if (!r.ok) throw new Error(r.error.message);
    const refs = new References();
    let steps = 0;
    const api = {
      run: async (request: { ops: { op: string }[] }) => {
        if (request.ops.some((o) => o.op === 'importStep')) {
          steps++;
          throw new KernelTimeout(5);
        }
        return { status: 'done', instance: 1, results: [] };
      },
      release: async () => undefined,
    } as unknown as EngineApi;
    await expect(refs.sync(r.value.document, api, 1)).rejects.toBeInstanceOf(KernelTimeout);
    expect(refs.list()[0]!.error).toMatch(/too long/);
    await refs.sync(r.value.document, api, 1);
    expect(steps).toBe(1);
  });
});

describe('a stuck call does not keep a session open', () => {
  it('close ends a session whose queue is stuck, and later calls answer closed at once', async () => {
    let stuck = false;
    const h = await harness({
      limits: { regenStopMs: 100 },
      library: (lib) =>
        libraryWith(lib, {
          listBranches: (...a: Parameters<DocumentLibrary['listBranches']>) =>
            stuck ? never() : lib.listBranches(...a),
        }),
    });
    const s = await opened(h);
    stuck = true;
    const pending = s.apply(rename('Never'));
    void pending;
    const t0 = performance.now();
    await s.close();
    expect(performance.now() - t0).toBeLessThan(5_000);
    expect(s.closed).toBe(true);
    expect(await s.tree()).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'closed' }),
    });
    // The branch lock is free.
    const lock = await new NodeBranchLocks(h.seed.root).acquire(h.seed.documentId, s.branch, 'x');
    expect(lock).not.toBeNull();
    await lock!.release();
  });

  it('an idle session with a stuck call closes itself', async () => {
    let stuck = false;
    const h = await harness({
      limits: { regenStopMs: 50, idleMs: 100 },
      library: (lib) =>
        libraryWith(lib, {
          listBranches: (...a: Parameters<DocumentLibrary['listBranches']>) =>
            stuck ? never() : lib.listBranches(...a),
        }),
    });
    const s = await opened(h);
    stuck = true;
    void s.apply(rename('Never'));
    await new Promise((r) => setTimeout(r, 600));
    expect(s.closed).toBe(true);
  });
});

describe('the review state is compared when it is set', () => {
  /** A harness whose next regen first runs `reviewer` (a reviewer acting mid-batch). */
  async function withReviewer() {
    let reviewer: (() => Promise<unknown>) | null = null;
    const h = await harness({
      patch: (api) => ({
        ...api,
        regen: async (document, options) => {
          const act = reviewer;
          reviewer = null;
          if (act) await act();
          return api.regen(document, options);
        },
      }),
    });
    const s = await opened(h);
    const set = (review: ReviewState) => async () =>
      ok(await h.seed.library.setBranchReview(h.seed.documentId, s.branch, review));
    const review = async () =>
      ok(await h.seed.library.listBranches(h.seed.documentId)).find((b) => b.id === s.branch)!
        .provenance!.review;
    const head = async () => ok(await h.seed.library.open(h.seed.documentId, s.branch)).revision;
    return { h, s, set, review, head, act: (f: () => Promise<unknown>) => (reviewer = f) };
  }

  it('a batch does not overwrite an approval or rejection made while it regenerated', async () => {
    for (const decision of ['approved', 'rejected'] as const) {
      const { s, set, review, head, act } = await withReviewer();
      ok(await s.apply(rename('One')));
      ok(await s.submit(async () => ({})));
      act(set(decision));
      const r = await s.apply(rename('Two'));
      expect(r).toEqual({ ok: false, error: expect.objectContaining({ code: 'branch-state' }) });
      expect(await review()).toBe(decision);
      expect(await head()).toBe(2);
      expect(s.document.name).toBe('One');
    }
  });

  it('a batch on a branch with changes requested still reopens it', async () => {
    const { s, set, review, act } = await withReviewer();
    ok(await s.apply(rename('One')));
    ok(await s.submit(async () => ({})));
    await set('changes-requested')();
    // The reviewer asks again for changes meanwhile: the same state, so the batch lands.
    act(set('changes-requested'));
    ok(await s.apply(rename('Two')));
    expect(await review()).toBe('open');
  });

  it('submit does not overwrite a decision made while the bundle was built', async () => {
    const { s, set, review } = await withReviewer();
    ok(await s.apply(rename('One')));
    const r = await s.submit(async () => {
      await set('rejected')();
      return {};
    });
    expect(r).toEqual({ ok: false, error: expect.objectContaining({ code: 'branch-state' }) });
    expect(await review()).toBe('rejected');
  });

  it('submits only an open branch', async () => {
    const { s, set } = await withReviewer();
    ok(await s.apply(rename('One')));
    await set('changes-requested')();
    expect(await s.submit(async () => ({}))).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'branch-state' }),
    });
    ok(await s.apply(rename('Two')));
    ok(await s.submit(async () => ({})));
    expect(await s.submit(async () => ({}))).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'branch-state' }),
    });
  });

  it('an update from Main is not committed over a decision made meanwhile', async () => {
    const { h, s, set, review, act } = await withReviewer();
    ok(await s.apply(rename('One')));
    const main = ok(await h.seed.library.open(h.seed.documentId, MAIN_BRANCH)).document;
    const command = { type: 'setVariable', name: 'thickness', expression: mm(7) } as const;
    const next = applyCommand(main, command as never);
    if (!next.ok) throw new Error(next.error.message);
    await h.seed.library.save(next.value.document, [
      { cause: 'execute', label: 'Main', command: command as never, at: new Date().toISOString() },
    ]);
    const old = s.branch;
    act(set('rejected'));
    const r = await s.updateFromMain();
    expect(r).toEqual({ ok: false, error: expect.objectContaining({ code: 'branch-state' }) });
    expect(s.branch).toBe(old);
    expect(await review()).toBe('rejected');
    const branches = ok(await h.seed.library.listBranches(h.seed.documentId));
    expect(branches.map((b) => b.id).sort()).toEqual([MAIN_BRANCH, old].sort());
  });
});

const mm = (v: number) => ({ source: `${v} mm`, lengthUnit: 'mm', angleUnit: 'deg' });

describe('the shape of a batch is checked first', () => {
  it('refuses batches nested too deep without recursing', async () => {
    const h = await harness();
    const s = await opened(h);
    let nested: unknown = { type: 'renameDocument', name: 'Deep' };
    for (let i = 0; i < 200_000; i++) nested = { type: 'batch', commands: [nested] };
    expect(await s.apply({ label: 'Deep', commands: [nested] })).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'too-deep', limit: MAX_JSON_DEPTH }),
    });
    let shallow: unknown = { type: 'renameDocument', name: 'Nine' };
    for (let i = 0; i < MAX_BATCH_DEPTH; i++) shallow = { type: 'batch', commands: [shallow] };
    expect(await s.apply({ label: 'Nine', commands: [shallow] })).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'too-deep', limit: MAX_BATCH_DEPTH }),
    });
    let deepJson: unknown = 'x';
    for (let i = 0; i < 100_000; i++) deepJson = [deepJson];
    expect(
      await s.apply({ label: 'Json', commands: [{ type: 'renameDocument', name: deepJson }] }),
    ).toEqual({ ok: false, error: expect.objectContaining({ code: 'too-deep' }) });
    expect(resolveSymbols(bracketDocument(), { type: 'batch', commands: [nested] })).toEqual({
      ok: false,
      problem: expect.objectContaining({ kind: 'too-deep' }),
    });
  });

  it('counts nested commands before anything parses them', async () => {
    const h = await harness({ limits: { commandsPerBatch: 5 } });
    const s = await opened(h);
    const junk = Array.from({ length: 6 }, () => ({ type: 'noSuchCommand' }));
    expect(
      await s.apply({ label: 'Nested', commands: [{ type: 'batch', commands: junk }] }),
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'too-many-commands', limit: 5 }),
    });
  });

  it('resolves a string of 10,000 symbols in one scan', () => {
    const name = Array.from({ length: 10_000 }, (_, i) => `e$s${i}`).join(' ');
    const t0 = performance.now();
    const r = resolveSymbols(bracketDocument(), {
      type: 'batch',
      commands: [{ type: 'renameDocument', name }],
    });
    if (!r.ok) throw new Error(JSON.stringify(r.problem));
    expect((r.value.command as { commands: { name: string }[] }).commands[0]!.name).toBe(name);
    expect(performance.now() - t0).toBeLessThan(2_000);
  });

  it('refuses a literal id numbered where placeholders are', () => {
    for (const id of [`sketch#${PLACEHOLDER_BASE}`, `sketch#${PLACEHOLDER_BASE + 3}`]) {
      const r = resolveSymbols(bracketDocument(), {
        type: 'batch',
        commands: [{ type: 'deleteFeature', partId: PART, featureId: id }],
      });
      expect(r).toEqual({
        ok: false,
        problem: { kind: 'symbol', message: expect.stringMatching(/at or above/) },
      });
    }
  });
});

describe('errors reach the agent in general terms', () => {
  it('a storage error keeps its code and loses its path; the log has it all', async () => {
    const secret = Object.assign(
      new Error("ENOSPC: no space left on device, write '/srv/secret/library/doc/x.json'"),
      { code: 'ENOSPC' },
    );
    const h = await harness({
      library: (lib) => libraryWith(lib, { save: () => Promise.reject(secret) }),
    });
    const s = await opened(h);
    const r = await s.apply(rename('Full'));
    expect(r).toEqual({ ok: false, error: expect.objectContaining({ code: 'storage' }) });
    const text = JSON.stringify(r);
    expect(text).not.toContain('/srv');
    expect(text).toContain('ENOSPC');
    expect(h.logged.map((e) => e.error)).toContain(secret);
  });

  it('a worker error that stops the engine from starting is not passed on', async () => {
    const h = await harness({
      engine: () => Promise.reject(new Error('worker failed at /home/someone/entry.ts:12')),
    });
    const r = await Session.open(h.host, { documentId: h.seed.documentId, clientName: 'T' });
    expect(r).toEqual({ ok: false, error: expect.objectContaining({ code: 'kernel' }) });
    expect(JSON.stringify(r)).not.toContain('/home');
    expect(h.logged).toHaveLength(1);
  });
});

describe('open and resume clean up after themselves', () => {
  it('a session that cannot take its lock or start its engine leaves no branch', async () => {
    const locked = await harness({
      locks: { acquire: async () => null } as unknown as SessionHost['locks'],
    });
    const a = await Session.open(locked.host, {
      documentId: locked.seed.documentId,
      clientName: 'T',
    });
    expect(a).toEqual({ ok: false, error: expect.objectContaining({ code: 'locked' }) });
    const listed = ok(await locked.seed.library.listBranches(locked.seed.documentId));
    expect(listed.map((b) => b.id)).toEqual([MAIN_BRANCH]);

    const broken = await harness({ engine: () => Promise.reject(new Error('no')) });
    const b = await Session.open(broken.host, {
      documentId: broken.seed.documentId,
      clientName: 'T',
    });
    expect(b).toEqual({ ok: false, error: expect.objectContaining({ code: 'kernel' }) });
    const after = ok(await broken.seed.library.listBranches(broken.seed.documentId));
    expect(after.map((x) => x.id)).toEqual([MAIN_BRANCH]);
  });

  it('resume refuses the id of a session that is open', async () => {
    const ids = new Set<string>();
    const h = await harness({ isOpen: (id) => ids.has(id) });
    const s = await opened(h);
    const branch = s.branch;
    await s.close();
    ids.add(s.id);
    expect(await Session.resume(h.host, { documentId: h.seed.documentId, branch })).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'locked' }),
    });
    ids.clear();
    open.push(ok(await Session.resume(h.host, { documentId: h.seed.documentId, branch })));
  });

  it('an update from Main whose old branch cannot be deleted is undone', async () => {
    let refuseDelete: string | null = null;
    const h = await harness({
      library: (lib) =>
        libraryWith(lib, {
          deleteBranch: (...a: Parameters<DocumentLibrary['deleteBranch']>) =>
            refuseDelete === a[1]
              ? Promise.resolve({ ok: false, message: 'The disk said no.' })
              : lib.deleteBranch(...a),
        }),
    });
    const s = await opened(h);
    ok(await s.apply(rename('One')));
    const main = ok(await h.seed.library.open(h.seed.documentId, MAIN_BRANCH)).document;
    const command = { type: 'setVariable', name: 'thickness', expression: mm(7) };
    const next = applyCommand(main, command as never);
    if (!next.ok) throw new Error(next.error.message);
    await h.seed.library.save(next.value.document, [
      { cause: 'execute', label: 'Main', command: command as never, at: new Date().toISOString() },
    ]);
    const old = s.branch;
    const name = ok(await h.seed.library.listBranches(h.seed.documentId)).find(
      (b) => b.id === old,
    )!.name;
    refuseDelete = old;
    const r = await s.updateFromMain();
    refuseDelete = null;
    expect(r).toEqual({ ok: false, error: expect.objectContaining({ code: 'storage' }) });
    expect(s.branch).toBe(old);
    const branches = ok(await h.seed.library.listBranches(h.seed.documentId));
    // The new branch is gone again; the old one is as it was.
    expect(branches.map((b) => b.id).sort()).toEqual([MAIN_BRANCH, old].sort());
    expect(branches.find((b) => b.id === old)?.name).toBe(name);
    ok(await s.apply(rename('Two')));
  });
});
