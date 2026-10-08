// A prototype of the headless session (docs/plans/agent-surface.md, "The headless session
// model"): one agent on one branch of one document, in this Node process. Not the design of
// `packages/session` (T8.1c); the least that exercises every step the plan names, so the spike can
// time each one and find what breaks.
//
// open:   read Main's head from the library, record it as a version ("Agent session <id>
//         start"), branch from that version, lock the branch, open it into a core
//         DocumentStore, full regen.
// apply:  one batch = one `store.execute` (one undo step), regen (cached by input hash), save as
//         one revision of the branch with one log entry, answer with what changed and a short
//         measurement summary. A batch over the command limit is refused before it runs; a regen
//         over the time limit is cancelled and the batch rolled back (undo plus a regen of the
//         document before it, which the cache serves).
// undo:   the store's undo, saved as a new revision.
// close:  release the engine's bodies and the branch lock.

import {
  DocumentStore,
  type ChangeEvent,
  type Command,
  type ManufaktureDocument,
} from '../../../packages/core/src/index';
import type { KernelService, KernelStatus } from '../../../packages/kernel/src/index';
import type { RegenResult } from '../../../packages/regen/src/types';
import { RegenEngine } from '../../../packages/regen/src/engine';
import type { RegenSolver } from '../../../packages/regen/src/sketches';
import type { TextOutliner } from '../../../packages/regen/src/text';
import type { ExtensionRegistry } from '../../../packages/regen/src/extensions';
import { lockBranch } from './fs-backend';
import type { Batch } from './fixtures';
import { MAIN_BRANCH, type DocumentLibrary } from './vendor/persistence/library';

/** The plan's starting values; the spike's report tunes them. */
export interface SessionLimits {
  commandsPerBatch: number;
  batchesPerSession: number;
  regenMsPerBatch: number;
}

export const PLAN_LIMITS: SessionLimits = {
  commandsPerBatch: 500,
  batchesPerSession: 2000,
  regenMsPerBatch: 60_000,
};

export interface SessionHost {
  library: DocumentLibrary;
  /** The library's root directory, for the branch lock. */
  root: string;
  service: KernelService;
  solver: RegenSolver;
  text: TextOutliner;
  extensions: ExtensionRegistry;
}

export interface BodyLine {
  body: string;
  volume: number;
  box: [number[], number[]] | null;
}

export type BatchReport =
  | {
      ok: true;
      revision: number;
      /** Features whose status changed, `id: before -> after`. */
      statusChanges: string[];
      errors: string[];
      /** Bodies whose shape changed in this batch. */
      measured: BodyLine[];
      ms: { execute: number; regen: number; measure: number; save: number; total: number };
      counters: RegenResult['counters'];
      /** Kernel recycles that ran during the batch (the regen was then redone). */
      recycles: number;
    }
  | { ok: false; code: string; message: string; ms: number };

/** Every command a command holds, counting the commands inside batches (not the batch itself). */
export function commandCount(command: Command): number {
  if (command.type !== 'batch') return 1;
  return (command as { commands: Command[] }).commands.reduce((n, c) => n + commandCount(c), 0);
}

const now = () => performance.now();

export class HeadlessSession {
  readonly id: string;
  readonly documentId: string;
  readonly branch: string;
  readonly host: SessionHost;
  readonly limits: SessionLimits;
  readonly store: DocumentStore;
  readonly engine: RegenEngine;
  /** The last completed regen. */
  last: RegenResult;
  batches = 0;
  recycles = 0;
  #unlock: () => Promise<void>;
  #revision: number;
  #events: ChangeEvent[] = [];
  #offStatus: () => void;
  /** Bumped by every recycle; a regen started before a bump has lost its shapes. */
  #instance = 0;

  private constructor(fields: {
    id: string;
    documentId: string;
    branch: string;
    host: SessionHost;
    limits: SessionLimits;
    store: DocumentStore;
    engine: RegenEngine;
    last: RegenResult;
    unlock: () => Promise<void>;
    revision: number;
  }) {
    this.id = fields.id;
    this.documentId = fields.documentId;
    this.branch = fields.branch;
    this.host = fields.host;
    this.limits = fields.limits;
    this.store = fields.store;
    this.engine = fields.engine;
    this.last = fields.last;
    this.#unlock = fields.unlock;
    this.#revision = fields.revision;
    this.store.subscribe((e) => this.#events.push(e));
    this.#offStatus = fields.host.service.onStatus((s: KernelStatus) => {
      if (s.type === 'recycled') {
        this.recycles++;
        this.#instance++;
      }
    });
  }

  /**
   * Open a session on a new agent branch made from Main's head, or `resume` an existing branch.
   * Returns the session and how long each step took.
   */
  static async open(
    host: SessionHost,
    documentId: string,
    options: { sessionId: string; resume?: string; limits?: SessionLimits },
  ): Promise<{ session: HeadlessSession; ms: Record<string, number> }> {
    const ms: Record<string, number> = {};
    const lib = host.library;
    let t = now();
    let branch: string;
    if (options.resume !== undefined) {
      branch = options.resume;
    } else {
      const main = await lib.open(documentId, MAIN_BRANCH);
      if (!main.ok) throw new Error(main.message);
      ms.readMain = now() - t;
      t = now();
      const version = await lib.createVersion(documentId, {
        name: `Agent session ${options.sessionId} start`,
      });
      if (!version.ok) throw new Error(version.message);
      ms.version = now() - t;
      t = now();
      const made = await lib.createBranch(
        documentId,
        version.value.id,
        `Agent ${options.sessionId}`,
      );
      if (!made.ok) throw new Error(made.message);
      branch = made.value.id;
      ms.branch = now() - t;
    }
    t = now();
    const unlock = await lockBranch(host.root, documentId, branch, options.sessionId);
    ms.lock = now() - t;
    t = now();
    const opened = await lib.open(documentId, branch);
    if (!opened.ok) {
      await unlock();
      throw new Error(opened.message);
    }
    ms.readBranch = now() - t;
    t = now();
    const store = DocumentStore.create(opened.value.document);
    if (!store.ok) {
      await unlock();
      throw new Error(store.error.message);
    }
    ms.store = now() - t;
    const engine = new RegenEngine({
      kernel: host.service,
      solver: host.solver,
      text: host.text,
      extensions: host.extensions,
    });
    t = now();
    const first = await engine.regen(store.value.document);
    if (first === null) throw new Error('the first regen was superseded');
    ms.firstRegen = now() - t;
    const session = new HeadlessSession({
      id: options.sessionId,
      documentId,
      branch,
      host,
      limits: options.limits ?? PLAN_LIMITS,
      store: store.value,
      engine,
      last: first,
      unlock,
      revision: opened.value.revision,
    });
    return { session, ms };
  }

  get document(): ManufaktureDocument {
    return this.store.document;
  }

  get revision(): number {
    return this.#revision;
  }

  /** Apply one batch (or any single command) with its label. Errors are data, never thrown. */
  async apply(batch: Batch): Promise<BatchReport> {
    const t0 = now();
    const refuse = (code: string, message: string): BatchReport => ({
      ok: false,
      code,
      message,
      ms: now() - t0,
    });
    if (this.batches >= this.limits.batchesPerSession) {
      return refuse(
        'session-limit',
        `a session takes at most ${this.limits.batchesPerSession} batches`,
      );
    }
    const count = commandCount(batch.command);
    if (count > this.limits.commandsPerBatch) {
      return refuse(
        'batch-limit',
        `a batch holds at most ${this.limits.commandsPerBatch} commands; this one has ${count}`,
      );
    }
    const before = this.last;
    const executed = this.store.execute(batch.command, batch.label);
    if (!executed.ok) return refuse(executed.error.code, executed.error.message);
    const tExec = now() - t0;
    if (executed.value.empty) {
      return refuse('no-change', 'the batch changes nothing');
    }
    const event = this.#events.at(-1)!;

    const t1 = now();
    const regen = await this.#regenWithin(() => this.engine.update(event));
    if (regen === 'timeout') {
      // Roll back: the store's undo, and a regen of the document before (from the cache).
      this.store.undo();
      const back = await this.engine.update(this.#events.at(-1)!);
      if (back !== null) this.last = back;
      this.#events.length = 0;
      return refuse(
        'regen-timeout',
        `the regen took longer than ${this.limits.regenMsPerBatch} ms; the batch was rolled back`,
      );
    }
    let result = regen;
    const tRegen = now() - t1;

    const t2 = now();
    let { lines, lost } = await this.#measure(result);
    let recycled = 0;
    // A recycle at the end of the regen (the kernel recycles at an idle point once its heap is
    // over the threshold) drops every shape the result names: regen again, then measure.
    while (lost && recycled < 2) {
      recycled++;
      const again = await this.engine.regen(this.store.document);
      if (again === null) break;
      result = again;
      ({ lines, lost } = await this.#measure(result));
    }
    const tMeasure = now() - t2;

    const t3 = now();
    const saved = await this.host.library.save(
      this.store.document,
      [
        {
          cause: 'execute',
          label: batch.label,
          command: batch.command,
          at: new Date().toISOString(),
        },
      ],
      this.branch,
    );
    this.#revision = saved.revision;
    const tSave = now() - t3;

    this.batches++;
    this.#events.length = 0;
    const statusChanges = diffStatuses(before, result);
    this.last = result;
    return {
      ok: true,
      revision: saved.revision,
      statusChanges,
      errors: result.parts.flatMap((p) =>
        p.features.flatMap((f) => f.errors.map((e) => `${f.featureId}: ${e.code}: ${e.message}`)),
      ),
      measured: lines,
      ms: {
        execute: tExec,
        regen: tRegen,
        measure: tMeasure,
        save: tSave,
        total: now() - t0,
      },
      counters: result.counters,
      recycles: recycled,
    };
  }

  /** Undo the last batch, saved as a new revision. */
  async undo(): Promise<BatchReport> {
    const t0 = now();
    const undone = this.store.undo();
    if (!undone.ok)
      return { ok: false, code: undone.error.code, message: undone.error.message, ms: 0 };
    const event = this.#events.at(-1)!;
    const result = await this.engine.update(event);
    if (result === null) throw new Error('superseded');
    const saved = await this.host.library.save(
      this.store.document,
      [
        {
          cause: 'undo',
          label: event.label,
          command: event.command!,
          at: new Date().toISOString(),
        },
      ],
      this.branch,
    );
    this.#revision = saved.revision;
    this.#events.length = 0;
    const statusChanges = diffStatuses(this.last, result);
    this.last = result;
    return {
      ok: true,
      revision: saved.revision,
      statusChanges,
      errors: [],
      measured: [],
      ms: { execute: 0, regen: 0, measure: 0, save: 0, total: now() - t0 },
      counters: result.counters,
      recycles: 0,
    };
  }

  async close(): Promise<void> {
    this.#offStatus();
    await this.engine.dispose();
    await this.#unlock();
  }

  async #regenWithin(run: () => Promise<RegenResult | null>): Promise<RegenResult | 'timeout'> {
    const budget = this.limits.regenMsPerBatch;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), budget);
    });
    const running = run();
    const first = await Promise.race([running, timeout]);
    clearTimeout(timer);
    if (first === 'timeout') {
      // Stop the kernel at its next op; the engine then resolves the regen to null or to a result
      // with cancelled features. Either way the batch is refused.
      this.host.service.cancel(this.engine.generation);
      await running.catch(() => null);
      return 'timeout';
    }
    if (first === null) throw new Error('a session regen was superseded');
    return first;
  }

  /** Volume and box of every body whose shape changed; `lost` when a recycle dropped them. */
  async #measure(result: RegenResult): Promise<{ lines: BodyLine[]; lost: boolean }> {
    const changed = result.parts.flatMap((p) => p.bodies.filter((b) => b.meshChanged));
    if (changed.length === 0) return { lines: [], lost: false };
    const reply = await this.host.service.run({
      generation: this.engine.generation,
      ops: changed.map((b) => ({
        op: 'measure' as const,
        shape: b.shape,
        targets: [],
        body: true,
      })),
    });
    if (reply.status !== 'done') return { lines: [], lost: true };
    const lines: BodyLine[] = [];
    for (const [i, r] of reply.results.entries()) {
      if (!r.ok) return { lines: [], lost: true };
      const body = (
        r.value as {
          body: { volume: number; boundingBox: { min: number[]; max: number[] } | null };
        }
      ).body;
      lines.push({
        body: changed[i]!.bodyId,
        volume: body.volume,
        box: body.boundingBox ? [body.boundingBox.min, body.boundingBox.max] : null,
      });
    }
    return { lines, lost: false };
  }
}

function diffStatuses(before: RegenResult, after: RegenResult): string[] {
  const was = new Map(
    before.parts.flatMap((p) => p.features.map((f) => [`${p.partId}/${f.featureId}`, f.status])),
  );
  const out: string[] = [];
  for (const p of after.parts) {
    for (const f of p.features) {
      const key = `${p.partId}/${f.featureId}`;
      const old = was.get(key);
      if (old !== f.status) out.push(`${key}: ${old ?? 'new'} -> ${f.status}`);
    }
  }
  return out;
}
