// The worker engine: each session's regen engine and kernel in a worker thread of its own. A
// session runs on it as on the in-process engine; a regen that does not stop when cancelled ends
// its worker, and a kernel whose heap passed the threshold is replaced by a new worker. Scripted
// features run there (the branch's own scripts only, under the hard limit), and texts in user
// fonts are laid out in a text worker of the session's worker.

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  applyCommand,
  createDocument,
  type Command,
  type ManufaktureDocument,
} from '@manufakture/core';
import { MAIN_BRANCH, type DocumentLibrary } from '@manufakture/library';
import { NodeBranchLocks } from '@manufakture/library/node';
import { nodeLoader } from '@manufakture/kernel/node';
import { createRegenWorkerApi, sourceSha256, type RegenResult } from '@manufakture/regen';
import { nodeScriptEngine } from '@manufakture/script/node';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BackendBundleStore, type BundleBuilder } from './bundles';
import { WorkerEngine, type EngineApi } from './engine';
import { sessionLimits } from './limits';
import { SessionManager } from './manager';
import { Session } from './session';
import { PART, bracketDocument, shedDocument } from './test/fixtures';
import { ok, seeded } from './test/setup';

const open: Session[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.close()));
});

describe('the worker engine', () => {
  it("sends the worker's stdout to the host's stderr", async () => {
    const out = vi.spyOn(process.stdout, 'write');
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const engine = await WorkerEngine.start({
      heapThresholdBytes: 1024 ** 3,
      url: new URL('./test/chatty-entry.ts', import.meta.url),
    });
    try {
      await vi.waitFor(() =>
        expect(err.mock.calls.map((c) => String(c[0])).join('')).toContain('chatty worker'),
      );
      expect(out.mock.calls.map((c) => String(c[0])).join('')).not.toContain('chatty worker');
    } finally {
      await engine.close();
      out.mockRestore();
      err.mockRestore();
    }
  }, 120_000);

  it('runs a session on the shed, and rolls back a regen it had to end', async () => {
    const seed = await seeded(shedDocument(), { engine: 'worker' });
    const s = ok(await seed.manager.open({ documentId: seed.documentId, clientName: 'Worker' }));
    open.push(s);
    expect(seed.manager.limits.sessionsPerProcess).toBe(4);
    const info = await s.info();
    expect([info.engine, info.kernelReplaced]).toEqual(['worker', 0]);
    const tree = ok(await s.tree());
    expect(tree.parts[0]!.features.every((f) => f.status === 'ok')).toBe(true);
    const walls = ok(await s.findGeometry({ normal: [0, -1, 0], limit: 5 }));
    expect(walls.length).toBeGreaterThan(0);

    const door = s.document.parts[0]!.features.find((f) => f.id === 'extension#7')!;
    const move = (inches: number) => ({
      type: 'editFeature',
      partId: PART,
      feature: {
        ...door,
        expressions: {
          ...(door as { expressions: Record<string, unknown> }).expressions,
          position: { source: String(inches), lengthUnit: 'in', angleUnit: 'deg' },
        },
      },
    });
    // A regen given 1 ms, and 1 ms to stop: the worker is terminated and a new one started.
    seed.manager.limits.regenMsPerBatch = 1;
    seed.manager.limits.regenStopMs = 1;
    const r = await s.apply({ label: 'Move the door', commands: [move(60)] });
    seed.manager.limits.regenMsPerBatch = 30_000;
    seed.manager.limits.regenStopMs = 5_000;
    expect(r).toEqual({ ok: false, error: expect.objectContaining({ code: 'regen-timeout' }) });
    expect((await s.info()).revision).toBe(1);
    expect((await s.info()).kernelReplaced).toBeGreaterThanOrEqual(1);
    // The new worker serves the session as before.
    const again = ok(await s.apply({ label: 'Move the door', commands: [move(60)] }));
    expect(again.revision).toBe(2);
    expect(again.errors).toEqual([]);
    const q = ok(await s.quantities());
    expect(q.takeoffs).toHaveLength(1);
    // Two workers started, two full regens of the shed and a terminate: several seconds alone,
    // far more on a loaded machine.
  }, 180_000);

  it('is replaced by a new worker once its heap passes the threshold', async () => {
    // Below the first instance's 128 MiB: replaced at the first check.
    const engine = await WorkerEngine.start({ heapThresholdBytes: 64 * 1024 * 1024 });
    try {
      expect(await engine.wantsRestart()).toBe(true);
      const old = engine.api;
      await engine.restart();
      expect(engine.replaced).toBe(1);
      expect(engine.api).not.toBe(old);
      // The terminated worker answers no more; the new one does.
      await expect(async () => old.stats()).rejects.toThrow();
      const r = await engine.api.regen(createDocument({ id: 'd', name: 'D' }), { generation: 1 });
      expect(r?.parts).toHaveLength(1);
    } finally {
      await engine.close();
    }
  }, 120_000);
});

// Scripts and user fonts ------------------------------------------------------------------------

const mm = (source: string) => ({ source, lengthUnit: 'mm', angleUnit: 'deg' });

/** The authoring guide's pin: a 2 mm radius circle at (25, 0) extruded `height`. */
const PIN_SOURCE =
  "export const params = { height: { kind: 'length', default: 10 } };\n" +
  'export function run(ctx, p) {\n' +
  "  const s = ctx.sketch('base', { plane: 'XY', loops: [[{ kind: 'circle', id: 'rim', center: [25, 0], radius: 2 }]] });\n" +
  "  ctx.extrude('pin', s, { distance: p.height });\n" +
  '}\n';

function scriptCommands(sym: string, source: string, height = '12 mm'): [Command, Command] {
  return [
    {
      type: 'setScript',
      script: { id: `script#$${sym}_s`, name: sym, language: 'js', apiVersion: 1, source },
    } as unknown as Command,
    {
      type: 'addFeature',
      partId: PART,
      feature: {
        id: `scripted#$${sym}`,
        kind: 'scripted',
        name: sym,
        suppressed: false,
        script: `script#$${sym}_s`,
        params: { height: { kind: 'expression', expression: mm(height) } },
        seed: 0,
        dependsOn: [],
      },
    } as unknown as Command,
  ];
}

/** `doc` with the pin script and its scripted feature already in it (as Main has them). */
function withMainScript(doc: ManufaktureDocument): ManufaktureDocument {
  const commands = [
    {
      type: 'setScript',
      script: {
        id: 'script#1',
        name: 'Main pin',
        language: 'js',
        apiVersion: 1,
        source: PIN_SOURCE,
      },
    },
    {
      type: 'addFeature',
      partId: PART,
      feature: {
        id: 'scripted#1',
        kind: 'scripted',
        name: 'Main pin',
        suppressed: false,
        script: 'script#1',
        params: { height: { kind: 'expression', expression: mm('5 mm') } },
        seed: 0,
        dependsOn: [],
      },
    },
  ] as unknown as Command[];
  let out = doc;
  for (const command of commands) {
    const r = applyCommand(out, command);
    if (!r.ok) throw new Error(r.error.message);
    out = r.value.document;
  }
  return out;
}

type Volumes = Record<string, number>;

/** The volume of every body of a regen, by part and body id, to 6 significant digits. */
async function volumes(
  api: Pick<EngineApi, 'run'>,
  result: RegenResult,
  generation: number,
): Promise<Volumes> {
  const out: Volumes = {};
  for (const part of result.parts) {
    for (const body of part.bodies) {
      const reply = await api.run({ generation, ops: [{ op: 'properties', shape: body.shape }] });
      const r = reply.results[0]!;
      if (!r.ok) throw new Error(r.error.message);
      out[`${part.partId}/${body.bodyId}`] = Number(
        (r.value as { volume: number }).volume.toPrecision(6),
      );
    }
  }
  return out;
}

/**
 * The reviewer's regen of `doc` with its scripts allowed, as the app does it: the regen worker API
 * with QuickJS, and **Run scripts** granting every script of the branch head by its source.
 */
async function reviewerRegen(doc: ManufaktureDocument): Promise<Volumes> {
  const api = createRegenWorkerApi({
    source: { module: await (await nodeLoader()).compile() },
    engine: { scripts: { engine: nodeScriptEngine } },
  });
  await api.init();
  await api.setScriptPolicy({
    auto: false,
    documents: [],
    scripts: await Promise.all(
      (doc.scripts ?? []).map(async (s) => ({
        document: doc.id,
        script: s.id,
        sha256: await sourceSha256(s.source),
      })),
    ),
  });
  const result = await api.regen(doc, { generation: 1 });
  if (result === null) throw new Error('superseded');
  const errors = result.parts.flatMap((p) => p.features.flatMap((f) => f.errors));
  expect(errors).toEqual([]);
  return volumes(api, result, 1);
}

describe('scripts in a worker session', () => {
  it("runs the branch's own scripted feature with its bodies; the bundle matches the reviewer's regen", async () => {
    const seed = await seeded(bracketDocument(), { engine: 'worker' });
    const s = ok(await seed.manager.open({ documentId: seed.documentId, clientName: 'Scripts' }));
    open.push(s);
    const report = ok(
      await s.apply({ label: 'Add a pin', commands: scriptCommands('pin', PIN_SOURCE) }),
    );
    expect(report.errors).toEqual([]);
    const pin = report.symbols['$pin']!;
    const made = report.measured.filter((b) => b.bodyId.startsWith(pin));
    expect(made).toHaveLength(1);
    // A 2 mm radius, 12 mm tall cylinder.
    expect(made[0]!.volume).toBeCloseTo(Math.PI * 4 * 12, 3);
    const tree = ok(await s.tree());
    expect(tree.parts[0]!.features.find((f) => f.id === pin)?.status).toBe('ok');

    // The bundle builder's engine (started from the context) runs the same script.
    let bundled: Volumes | null = null;
    const builder: BundleBuilder = async (_base, head, context) => {
      const engine = await context.engine();
      try {
        const r = await engine.api.regen(head.document, { generation: 1 });
        if (r === null) throw new Error('superseded');
        bundled = await volumes(engine.api, r, 1);
        return { volumes: bundled };
      } finally {
        await engine.close();
      }
    };
    ok(await s.submit(builder, 'A pin'));
    expect(bundled).not.toBeNull();
    expect(Object.keys(bundled!).some((k) => k.includes(pin))).toBe(true);
    expect(bundled).toEqual(await reviewerRegen(s.document));
  }, 240_000);

  it('does not run a script already on Main, and runs one the branch changed', async () => {
    const seed = await seeded(withMainScript(bracketDocument()), { engine: 'worker' });
    const s = ok(await seed.manager.open({ documentId: seed.documentId, clientName: 'Scripts' }));
    open.push(s);
    const before = ok(await s.tree());
    expect(before.parts[0]!.features.find((f) => f.id === 'scripted#1')?.status).toBe('error');
    const errors = ok(await s.errors());
    expect(errors).toContainEqual(
      expect.objectContaining({ featureId: 'scripted#1', code: 'script' }),
    );
    // The agent edits Main's script: now it is the branch's own, shown in full in the review.
    const edited = {
      type: 'setScript',
      script: {
        id: 'script#1',
        name: 'Main pin',
        language: 'js',
        apiVersion: 1,
        source: PIN_SOURCE.replace('radius: 2', 'radius: 3'),
      },
    } as unknown as Command;
    const report = ok(await s.apply({ label: 'Thicker pin', commands: [edited] }));
    expect(report.errors).toEqual([]);
    const pin = report.measured.find((b) => b.bodyId.startsWith('scripted#1'));
    expect(pin?.volume).toBeCloseTo(Math.PI * 9 * 5, 3);
  }, 240_000);

  it('stops a run past the hard limit, and fails it on the next worker without running it again', async () => {
    const seed = await seeded(bracketDocument());
    const host = {
      library: seed.library,
      locks: new NodeBranchLocks(seed.root),
      limits: sessionLimits({ sessionsPerProcess: 2 }),
      bundles: new BackendBundleStore(seed.backend),
      engine: () => WorkerEngine.start({ heapThresholdBytes: 1024 ** 3, scriptTimeoutMs: 300 }),
    };
    const s = ok(await Session.open(host, { documentId: seed.documentId, clientName: 'Loop' }));
    open.push(s);
    // The soft limit (2 s) would stop it too, but the hard limit comes first.
    const spin = PIN_SOURCE.replace('{\n', '{\n  for (let i = 0; i < 1e10; i++) {}\n');
    const t0 = performance.now();
    const report = ok(
      await s.apply({ label: 'A pin that spins', commands: scriptCommands('spin', spin) }),
    );
    const id = report.symbols['$spin']!;
    expect(report.errors).toContainEqual(
      expect.objectContaining({ featureId: id, code: 'script' }),
    );
    expect(report.errors.find((e) => e.featureId === id)?.message).toMatch(/still running/);
    expect((await s.info()).kernelReplaced).toBe(1);
    // Once: the next regen fails the run at once instead of running it again.
    ok(await s.apply({ label: 'Rename', commands: [{ type: 'renameDocument', name: 'B' }] }));
    expect((await s.info()).kernelReplaced).toBe(1);
    expect(performance.now() - t0).toBeLessThan(60_000);
  }, 240_000);
  it("takes Main's head as the base on an update: a script Main absorbed stops running; a failed update keeps the base", async () => {
    const seed = await seeded(withMainScript(bracketDocument()));
    let refuseDelete: string | null = null;
    const library = new Proxy(seed.library, {
      get(target, key) {
        if (key === 'deleteBranch') {
          return (id: string, branch: string) =>
            branch === refuseDelete
              ? Promise.resolve({ ok: false, message: 'The disk said no.' })
              : target.deleteBranch(id, branch);
        }
        const value = Reflect.get(target, key) as unknown;
        return typeof value === 'function'
          ? (value as (...args: unknown[]) => unknown).bind(target)
          : value;
      },
    }) as DocumentLibrary;
    const host = {
      library,
      locks: new NodeBranchLocks(seed.root),
      limits: sessionLimits({ sessionsPerProcess: 2 }),
      bundles: new BackendBundleStore(seed.backend),
      engine: () => WorkerEngine.start({ heapThresholdBytes: 1024 ** 3 }),
    };
    const s = ok(await Session.open(host, { documentId: seed.documentId, clientName: 'Update' }));
    open.push(s);
    const status = async () =>
      ok(await s.tree()).parts[0]!.features.find((f) => f.id === 'scripted#1')?.status;
    // The agent changes Main's script: its own now, so it runs.
    const edit = {
      type: 'setScript',
      script: {
        id: 'script#1',
        name: 'Main pin',
        language: 'js',
        apiVersion: 1,
        source: PIN_SOURCE.replace('radius: 2', 'radius: 3'),
      },
    } as unknown as Command;
    ok(await s.apply({ label: 'Thicker pin', commands: [edit] }));
    expect(await status()).toBe('ok');

    // A person makes the same change on Main.
    const main = ok(await seed.library.open(seed.documentId, MAIN_BRANCH)).document;
    const next = applyCommand(main, edit);
    if (!next.ok) throw new Error(next.error.message);
    await seed.library.save(next.value.document, [
      { cause: 'execute', label: 'Thicker pin', command: edit, at: new Date().toISOString() },
    ]);

    // An update that fails at its commit leaves the base as it was: the script still runs.
    refuseDelete = s.branch;
    const failed = await s.updateFromMain();
    refuseDelete = null;
    expect(failed).toEqual({ ok: false, error: expect.objectContaining({ code: 'storage' }) });
    expect(await status()).toBe('ok');
    ok(await s.apply({ label: 'Rename', commands: [{ type: 'renameDocument', name: 'B' }] }));
    expect(await status()).toBe('ok');

    // The update that commits: Main has the script as the branch does, so it is not the branch's
    // own any more and does not run.
    expect(ok(await s.updateFromMain()).changed).toBe(true);
    expect(await status()).toBe('error');
    expect(ok(await s.errors())).toContainEqual(
      expect.objectContaining({ featureId: 'scripted#1', code: 'script' }),
    );
  }, 240_000);
});

describe('user fonts in a session', () => {
  const inter = readFileSync(new URL('../../text/fonts/Inter-Bold.ttf', import.meta.url));

  const fontCommands = (bytes: Buffer, fileName: string): Command[] => [
    {
      type: 'addFont',
      font: {
        id: 'font#1',
        family: 'Mine',
        style: 'Bold',
        source: {
          kind: 'file',
          fileName,
          size: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          data: bytes.toString('base64'),
        },
      },
    } as unknown as Command,
    {
      type: 'addFeature',
      partId: PART,
      feature: {
        id: 'sketch#$ts',
        kind: 'sketch',
        name: 'Label',
        suppressed: false,
        plane: { type: 'plane', origin: [0, 0, -20], normal: [0, 0, 1], xDir: [1, 0, 0] },
        entities: [
          {
            id: 'e$label',
            kind: 'outline',
            construction: false,
            anchor: [20, 15],
            angle: 0,
            source: {
              kind: 'text',
              text: 'OK',
              font: 'font#1',
              size: mm('8'),
              align: { horizontal: 'center', vertical: 'middle' },
            },
          },
        ],
        constraints: [],
      },
    } as unknown as Command,
    {
      type: 'addFeature',
      partId: PART,
      feature: {
        id: 'extrude#$t',
        kind: 'extrude',
        name: 'Letters',
        suppressed: false,
        profile: { sketch: 'sketch#$ts' },
        operation: 'new',
        extent: { type: 'blind', distance: mm('1') },
        reverse: false,
      },
    } as unknown as Command,
  ];

  for (const engine of ['worker', 'in-process'] as const) {
    it(`lays out a text in a user font in a text worker (${engine})`, async () => {
      const seed = await seeded(bracketDocument(), { engine });
      const s = ok(await seed.manager.open({ documentId: seed.documentId, clientName: 'Fonts' }));
      open.push(s);
      const report = ok(
        await s.apply({ label: 'Label', commands: fontCommands(inter, 'mine.ttf') }),
      );
      expect(report.errors).toEqual([]);
      const letters = report.measured.filter((b) => b.bodyId.startsWith(report.symbols['$t']!));
      expect(letters.length).toBeGreaterThan(0);
      expect(letters.every((b) => b.volume > 0)).toBe(true);

      // A file that is not a font fails its sketch, as data.
      const junk = Buffer.from('this is not a font');
      const s2 = ok(await seed.manager.open({ documentId: seed.documentId, clientName: 'Junk' }));
      open.push(s2);
      const broken = ok(
        await s2.apply({ label: 'Junk', commands: fontCommands(junk, 'junk.ttf') }),
      );
      expect(broken.errors).toContainEqual(
        expect.objectContaining({
          code: 'font',
          message: expect.stringMatching(/^This font could not be read \(junk\.ttf\)/),
        }),
      );
    }, 240_000);
  }

  // A text worker that runs out of memory, or exits, as soon as it is asked to read a font.
  const hostile = (body: string) =>
    'data:text/javascript,' +
    encodeURIComponent(
      "import { parentPort } from 'node:worker_threads';\n" +
        'parentPort.postMessage({ ready: true });\n' +
        `parentPort.on('message', () => { ${body} });\n`,
    );
  const OOM = 'const a = []; for (;;) a.push(new Array(1e5).fill(Math.random()));';
  const EXIT = 'process.exit(3);';

  for (const [what, body] of [
    ['runs out of memory', OOM],
    ['crashes', EXIT],
  ] as const) {
    it(`fails the text, as data, when the font worker ${what}; the session goes on`, async () => {
      const seed = await seeded(bracketDocument());
      const manager = new SessionManager({
        library: seed.library,
        locks: new NodeBranchLocks(seed.root),
        bundles: new BackendBundleStore(seed.backend),
        engine: 'in-process',
        textWorker: { url: hostile(body), heapMb: 32 },
      });
      const s = ok(await manager.open({ documentId: seed.documentId, clientName: 'Fonts' }));
      open.push(s);
      const report = ok(
        await s.apply({ label: 'Label', commands: fontCommands(inter, 'mine.ttf') }),
      );
      expect(report.errors).toContainEqual(
        expect.objectContaining({
          code: 'font',
          message: expect.stringMatching(/mine\.ttf.*ran out of memory or crashed/),
        }),
      );
      // The session, its kernel and its other features are fine.
      const tree = ok(await s.tree());
      expect(tree.parts[0]!.features.find((f) => f.id === 'extrude#1')?.status).toBe('ok');
      ok(await s.apply({ label: 'Rename', commands: [{ type: 'renameDocument', name: 'B' }] }));
      expect((await s.info()).revision).toBe(3);
    }, 120_000);
  }
});
