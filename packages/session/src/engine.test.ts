// The worker engine's lifecycle: a close that lands while a restart is starting its new worker
// (a regen timeout's kill, say, with the session closing meanwhile) leaves no worker running. And
// which scripts a session runs: its branch's own, and in an in-process engine none.

import { applyCommand, type Command, type ManufaktureDocument } from '@manufakture/core';
import { DENY_ALL_SCRIPTS, sourceSha256 } from '@manufakture/regen';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EngineLost, InProcessEngine, WorkerEngine, sessionScriptPolicy } from './engine';
import { PART, bracketDocument } from './test/fixtures';

// Every worker the engine starts, and whether it has exited.
const workers = vi.hoisted(() => [] as { exited: boolean }[]);
vi.mock('node:worker_threads', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:worker_threads')>();
  class Tracked extends original.Worker {
    constructor(...args: ConstructorParameters<typeof original.Worker>) {
      super(...args);
      const record = { exited: false };
      workers.push(record);
      this.on('exit', () => {
        record.exited = true;
      });
    }
  }
  return { ...original, Worker: Tracked };
});

const gate = new BroadcastChannel('engine-gate');
afterEach(() => {
  gate.onmessage = null;
  workers.splice(0);
});

/** Resolves on the next worker's `started`; `answer` decides whether it is let go at once. */
function nextStart(answer: boolean): Promise<void> {
  return new Promise((resolve) => {
    gate.onmessage = (event) => {
      if ((event as MessageEvent).data !== 'started') return;
      gate.onmessage = null;
      if (answer) gate.postMessage('go');
      resolve();
    };
  });
}

describe('the worker engine', () => {
  it('stops a worker a restart started after the engine closed, and rejects', async () => {
    const options = {
      heapThresholdBytes: 1024 ** 3,
      url: new URL('./test/gated-entry.ts', import.meta.url),
    };
    const first = nextStart(true);
    const engine = await WorkerEngine.start(options);
    await first;
    expect(workers).toHaveLength(1);

    // The restart stops the first worker and starts a second, held in its `init`.
    const held = nextStart(false);
    const restart = engine.restart();
    const settled = restart.catch((e: unknown) => e);
    await held;
    expect(workers).toHaveLength(2);
    expect(workers[0]!.exited).toBe(true);

    // The session closes now, then the new worker finishes starting.
    await engine.close();
    gate.postMessage('go');
    const error = await settled;
    expect(error).toBeInstanceOf(EngineLost);
    expect((error as Error).message).toBe('The session is closed.');
    expect(workers.map((w) => w.exited)).toEqual([true, true]);
    expect(engine.replaced).toBe(0);
  }, 120_000);

  it('refuses a restart once closed', async () => {
    const first = nextStart(true);
    const engine = await WorkerEngine.start({
      heapThresholdBytes: 1024 ** 3,
      url: new URL('./test/gated-entry.ts', import.meta.url),
    });
    await first;
    await engine.close();
    await expect(engine.restart()).rejects.toThrow(EngineLost);
    expect(workers.map((w) => w.exited)).toEqual([true]);
  }, 120_000);
});

const script = (id: string, source: string) => ({
  id,
  name: id,
  language: 'js' as const,
  apiVersion: 1,
  source,
});

function withScripts(
  doc: ManufaktureDocument,
  scripts: NonNullable<ManufaktureDocument['scripts']>,
): ManufaktureDocument {
  return { ...doc, scripts };
}

describe("a session's script policy", () => {
  const base = withScripts(bracketDocument(), [
    script('script#1', 'export function run() {}'),
    script('script#2', 'export function run() { /* two */ }'),
  ]);

  it('runs nothing without a base', async () => {
    expect(await sessionScriptPolicy(base, null)).toEqual(DENY_ALL_SCRIPTS);
  });

  it("grants the branch's own scripts by source, and nothing else", async () => {
    const changed = 'export function run() { /* changed */ }';
    const added = 'export function run() { /* added */ }';
    const head = withScripts(base, [
      base.scripts![0]!,
      script('script#2', changed),
      script('script#3', added),
    ]);
    expect(await sessionScriptPolicy(head, base)).toEqual({
      auto: false,
      documents: [],
      scripts: [
        { document: base.id, script: 'script#2', sha256: await sourceSha256(changed) },
        { document: base.id, script: 'script#3', sha256: await sourceSha256(added) },
      ],
    });
    // The base itself: nothing is the branch's own.
    expect(await sessionScriptPolicy(base, base)).toEqual(DENY_ALL_SCRIPTS);
  });
});

describe('the in-process engine', () => {
  it("runs no script, the branch's own included (it could not end a run)", async () => {
    const commands = [
      { type: 'setScript', script: script('script#1', 'export function run(ctx) {}') },
      {
        type: 'addFeature',
        partId: PART,
        feature: {
          id: 'scripted#1',
          kind: 'scripted',
          name: 'S',
          suppressed: false,
          script: 'script#1',
          params: {},
          seed: 0,
          dependsOn: [],
        },
      },
    ] as unknown as Command[];
    let head = bracketDocument();
    for (const c of commands) {
      const r = applyCommand(head, c);
      if (!r.ok) throw new Error(r.error.message);
      head = r.value.document;
    }
    const engine = await InProcessEngine.start({ heapThresholdBytes: 1024 ** 3 });
    try {
      engine.scriptBase = bracketDocument();
      const r = await engine.api.regen(head, { generation: 1 });
      const f = r!.parts[0]!.features.find((x) => x.featureId === 'scripted#1');
      expect(f?.status).toBe('error');
      expect(f?.errors).toEqual([expect.objectContaining({ code: 'unsupported' })]);
    } finally {
      await engine.close();
    }
  }, 120_000);
});
