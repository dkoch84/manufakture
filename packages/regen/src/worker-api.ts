// The Comlink-facing API of the regen worker: the kernel worker's API (loading, batches, release,
// cancel, recycle, stats) plus `regen`, with the engine running next to the kernel service in the
// same worker (ADR 0007 decisions 1 and 3). Like the kernel's, it has no dependency on a real
// worker, so tests expose it on a MessageChannel with the Node kernel.
//
// The sketch solver runs in this worker too, in-process (see README, "The worker"): the engine
// awaits every solve before its next kernel op, so a solver in another worker would add a round
// trip per sketch and a dependency on that worker's lifetime, and buy no parallelism.

import type { DragTarget } from '@manufakture/assembly';
import type { ManufaktureDocument } from '@manufakture/core';
import type { IfcBuildingInput } from '@manufakture/io';
import {
  createKernelWorkerApi,
  meshBuffers,
  type KernelService,
  type KernelWorkerApi,
  type ShapeId,
  type WorkerApiOptions,
} from '@manufakture/kernel';
import { createSolverService } from '@manufakture/sketch';
import * as Comlink from 'comlink';
import {
  RegenEngine,
  type EngineStats,
  type InterferenceCheckOptions,
  type RegenEngineOptions,
} from './engine';
import { camTransferables, type CamGeometryOptions, type CamGeometryResult } from './cam';
import type { DrawingSheetResult, DrawingViewResult } from './drawing';
import type { OrientedSizesOptions, OrientedSizesResult } from './oriented';
import type { RegenSolver } from './sketches';
import {
  TextBudget,
  lazyTextOutliner,
  unreadableFont,
  type FontReader,
  type FontReadReply,
  type TextOutliner,
  type TextReply,
  type TextRequest,
} from './text';
import type { ParamSpec } from '@manufakture/script';
import {
  DENY_ALL_SCRIPTS,
  checkScriptPolicy,
  type ScriptPolicy,
  type ScriptRunEvent,
  type ScriptStats,
} from './scripted';
import { memberBodiesTransferables, regenTransferables } from './transfer';
import type {
  AssemblyResult,
  DragResult,
  InstanceInterference,
  InterferenceReport,
  MemberBodiesResult,
  RegenError,
  RegenResult,
} from './types';

/** A script as `scriptDeclarations` reads it (the document's stored fields that count). */
export interface ScriptDeclarationSource {
  /** Its id in the document's library: what the policy's grants name. */
  id: string;
  source: string;
  language: 'js' | 'ts';
  apiVersion: number;
}

/** What `scriptDeclarations` answers: the parameters, or why they could not be read. */
export type ScriptDeclarationsReply =
  { ok: true; params: ParamSpec[] } | { ok: false; error: RegenError };

export interface RegenWorkerApi extends KernelWorkerApi {
  /**
   * Regenerate `document` at `generation` (from the main thread's client, which numbers every
   * request of every kind in one sequence). Resolves to null when a newer regen superseded it;
   * mesh buffers are transferred. Waits for the kernel to load.
   */
  regen(
    document: ManufaktureDocument,
    options: { generation: number; stored?: ManufaktureDocument },
  ): Promise<RegenResult | null>;
  /**
   * Solve an assembly of `document` for a preview (a mate dialog, before OK), at the client's
   * current generation so it never cancels a regen. The parts are built through the cache; no
   * meshes. Null when a newer regen superseded it.
   */
  solveAssembly(
    document: ManufaktureDocument,
    assemblyId: string,
    options: { generation: number; stored?: ManufaktureDocument },
  ): Promise<AssemblyResult | null>;
  /**
   * One step of dragging an instance of an assembly of the last regen, at the client's current
   * generation. Coalesced: a step not started when a newer one arrives resolves to null, and
   * only the latest target is solved. Null too when a newer regen was requested.
   */
  dragInstance(
    assemblyId: string,
    instanceId: string,
    target: DragTarget,
    options: { generation: number },
  ): Promise<DragResult | null>;
  /** A drag that was not committed: the next one starts from the last regen again. */
  endDrag(assemblyId: string): Promise<void>;
  /**
   * Which instances of an assembly of the last regen overlap, on demand, at the client's current
   * generation (a newer regen supersedes it: null). `onPair` (a `Comlink.proxy`, so a top-level
   * argument: Comlink does not look for proxies inside objects) gets each pair as it is found,
   * its mesh transferred; the report's pairs then carry no mesh. Without `onPair` the report's
   * meshes are transferred with it.
   */
  interference(
    assemblyId: string,
    options: { generation: number; mesh?: boolean; tolerance?: number },
    onPair?: (pair: InstanceInterference) => unknown,
  ): Promise<InterferenceReport | null>;
  /** Stop a running interference check of an assembly before its next pair (a `cancelled` report). */
  cancelInterference(assemblyId: string): Promise<void>;
  /**
   * One view of a drawing of `document` (`RegenEngine.drawingView`): projected edges, dimensions
   * and, with `pick`, picking data. At the client's current generation; null when a newer regen
   * superseded it.
   */
  drawingView(
    document: ManufaktureDocument,
    drawingId: string,
    viewId: string,
    options: { generation: number; stored?: ManufaktureDocument; pick?: boolean },
  ): Promise<DrawingViewResult | null>;
  /** Every view of a sheet and the sheet laid out (`RegenEngine.drawingSheet`). */
  drawingSheet(
    document: ManufaktureDocument,
    drawingId: string,
    sheetId: string,
    options: { generation: number; stored?: ManufaktureDocument; pick?: boolean },
  ): Promise<DrawingSheetResult | null>;
  /**
   * The oriented box sizes of a part's bodies (`RegenEngine.orientedSizes`), for the cut list's
   * bodies that are not boards: cached by body key, at the client's current generation; null
   * when a newer regen superseded it.
   */
  orientedSizes(
    document: ManufaktureDocument,
    partId: string,
    options: OrientedSizesOptions & { generation: number },
  ): Promise<OrientedSizesResult | null>;
  /**
   * The geometry of one CAM setup of `document` (`RegenEngine.camGeometry`): references resolved
   * on the final body, expressions evaluated, loops, points and depths, and the CAM mesh when
   * asked for (transferred). At the client's current generation; null when a newer regen
   * superseded it.
   */
  camGeometry(
    document: ManufaktureDocument,
    setupId: string,
    options: CamGeometryOptions & { generation: number },
  ): Promise<CamGeometryResult | null>;
  /**
   * B-reps of framing members of the last regen (`RegenEngine.memberBodies`), built per owner,
   * measured and exported to one STEP file as asked (transferred), and released before the
   * reply. At the client's current generation; null when a newer regen superseded it.
   */
  memberBodies(
    partId: string,
    memberIds: readonly string[],
    options: {
      generation: number;
      volumes?: boolean;
      step?: boolean;
      with?: readonly { shape: ShapeId; name: string }[];
    },
  ): Promise<MemberBodiesResult | null>;
  /** Cumulative engine counters. */
  regenStats(): Promise<EngineStats>;
  /**
   * Lay out and outline one text for the sketcher, as a regen would (the same outliner, so the
   * text worker under its watchdog in the browser): the glyph regions in the text's own frame,
   * for the sketcher to place at the anchor it is dragging. Needs no kernel.
   *
   * The sketcher lays its texts out in passes (`TextPreviewOptions.pass`): the texts of one pass
   * share a `TextBudget`, as a regen's do, and are laid out one after another, so a hostile font
   * whose every text takes just under the time limit costs a pass about twice the limit, not
   * the limit once per text. A call with no pass has a budget of its own.
   */
  outlineText(request: TextRequest, options?: TextPreviewOptions): Promise<TextReply>;
  /**
   * Read a user font's names and embedding permissions for **Add font**, in the text worker
   * under its watchdog (never in this worker or on the main thread: ADR 0011's amendment). A
   * host without the watchdog refuses.
   */
  readFont(fileName: string, bytes: Uint8Array): Promise<FontReadReply>;
  /**
   * A building as an IFC4 file (`writeIfc` of `@manufakture/io`, T6.6a), its bytes transferred.
   * web-ifc and its `.wasm` load on the first call only, in this worker; nothing else here
   * imports them. Needs no kernel. Rejects with the writer's `IfcExportError` message when the
   * building is malformed or too large.
   */
  exportIfc(building: IfcBuildingInput): Promise<Uint8Array>;
  /**
   * The watchdog channel for scripted features (ADR 0010 amendment, item 4): `onRun` (a
   * `Comlink.proxy`) hears of every script run's start and end with the feature's cache key, so
   * the main thread can terminate this worker when one runs too long; `runaway` lists the keys
   * of runs an earlier worker was terminated for, which fail with `timeout` instead of running
   * again. The client calls it on every worker it starts, before anything else.
   */
  watchScripts(
    onRun: ((event: ScriptRunEvent) => unknown) | null,
    runaway: readonly string[],
  ): Promise<void>;
  /**
   * Which documents' scripts may run (`ScriptPolicy`, the app's opt-in). Fails closed: until a
   * policy arrives no script runs, and anything that is not a policy (null included) denies
   * every script and rejects. Kept for the engine made later; applies from the next regen.
   */
  setScriptPolicy(policy: ScriptPolicy): Promise<void>;
  /**
   * A script's parameter declarations, for the feature dialog (`RegenEngine.scriptDeclarations`):
   * its top-level code runs here, under the limits and the watchdog, and only when the policy
   * lets this script of `documentId` run. Waits for the kernel.
   */
  scriptDeclarations(
    script: ScriptDeclarationSource,
    documentId: string,
  ): Promise<ScriptDeclarationsReply>;
  /** What scripted features cost so far (null without scripts); waits for the kernel. */
  scriptStats(): Promise<ScriptStats | null>;
}

/** What a sketcher's `outlineText` call says besides the request. */
export interface TextPreviewOptions {
  /** The sketcher's pass this text belongs to: the same number for every text of one pass. */
  pass?: number;
}

/**
 * How many preview passes keep their budgets, so the map stays small. A text takes its pass's
 * budget when it is asked for, and the sketcher asks for all of a pass's texts at once with pass
 * numbers that only grow, so a pass that falls out has no texts still to come; those it queued
 * keep the budget they took.
 */
const PREVIEW_PASSES_KEPT = 8;

export interface RegenWorkerApiOptions extends WorkerApiOptions {
  /** The sketch solver; default: planegcs in this worker, loaded on the first solve. */
  solver?: RegenSolver;
  /** Passed to the engine (cache, tessellation, build identities). */
  engine?: Omit<RegenEngineOptions, 'kernel' | 'solver'>;
  /** Makes the budget of a preview pass (`outlineText`); default a `TextBudget` with its defaults. */
  previewBudget?: () => TextBudget;
  /**
   * Where `web-ifc.wasm` is (a bundler's asset URL; `worker.ts` passes Vite's). Absent: web-ifc
   * finds its own file (Node).
   */
  ifcWasmUrl?: string;
}

/** Build the API object; `worker.ts` passes it to `Comlink.expose`. */
export function createRegenWorkerApi(options: RegenWorkerApiOptions): RegenWorkerApi & {
  /** The engine, once the kernel has loaded; for tests. */
  readonly engine: RegenEngine | null;
} {
  const kernelApi = createKernelWorkerApi(options);
  // Set by `watchScripts`, possibly before the engine exists.
  let scriptMonitor: ((event: ScriptRunEvent) => void) | null = null;
  const runawayScripts = new Set<string>();
  // Set by `setScriptPolicy`, possibly before the engine exists.
  // Fail closed: nothing runs until the host says what may.
  let scriptPolicy: ScriptPolicy = DENY_ALL_SCRIPTS;
  const solver = options.solver ?? createSolverService();
  let engine: RegenEngine | null = null;
  // The engine's outliner when the host passed one (the regen worker's watchdog outliner),
  // else an in-process one for bundled fonts, as the engine would make.
  const given: (TextOutliner & Partial<FontReader>) | undefined = options.engine?.text;
  let outliner: TextOutliner | undefined = given;
  // The budgets of the last few preview passes, and the queue that lays previews out one at a
  // time (the text worker runs one request at a time anyway), so that a pass's budget is
  // checked when each of its texts starts, not when they were all asked for at once.
  const passes = new Map<number, TextBudget>();
  let previews: Promise<unknown> = Promise.resolve();
  const newBudget = options.previewBudget ?? (() => new TextBudget());
  const passBudget = (pass: number | undefined): TextBudget => {
    if (pass === undefined) return newBudget();
    let budget = passes.get(pass);
    if (!budget) {
      passes.set(pass, (budget = newBudget()));
      while (passes.size > PREVIEW_PASSES_KEPT) passes.delete(passes.keys().next().value!);
    }
    return budget;
  };

  const engineFor = async (): Promise<RegenEngine> => {
    await kernelApi.init();
    const service = kernelApi.service as KernelService;
    // After a recycle every cached body is gone. The main thread hears of it through the
    // kernel's `recycled` status and asks for a regen of its current document; the engine only
    // forgets here (its hook runs inside the service's queue, where nothing may be submitted).
    if (engine === null) {
      engine = new RegenEngine({ ...options.engine, kernel: service, solver });
      if (scriptMonitor !== null) engine.setScriptMonitor(scriptMonitor);
      engine.addRunawayScripts([...runawayScripts]);
      engine.setScriptPolicy(scriptPolicy);
    }
    return engine;
  };

  return {
    get engine() {
      return engine;
    },
    init: (config, onStatus) => kernelApi.init(config, onStatus),
    run: (request) => kernelApi.run(request),
    release: (shapes) => kernelApi.release(shapes),
    cancel: (generation) => kernelApi.cancel(generation),
    recycle: () => kernelApi.recycle(),
    stats: () => kernelApi.stats(),
    leaks: () => kernelApi.leaks(),

    async regen(document, { generation, stored }) {
      const result = await (
        await engineFor()
      ).regen(document, stored === undefined ? { generation } : { generation, stored });
      return result === null ? null : Comlink.transfer(result, regenTransferables(result));
    },

    async solveAssembly(document, assemblyId, { generation, stored }) {
      return (await engineFor()).solveAssembly(
        document,
        assemblyId,
        stored === undefined ? { generation } : { generation, stored },
      );
    },

    async dragInstance(assemblyId, instanceId, target, { generation }) {
      return (await engineFor()).drag(assemblyId, instanceId, target, { generation });
    },

    async endDrag(assemblyId) {
      (await engineFor()).endDrag(assemblyId);
    },

    async interference(assemblyId, { generation, mesh, tolerance }, onPair) {
      const engine = await engineFor();
      const options: InterferenceCheckOptions = { generation };
      if (mesh !== undefined) options.mesh = mesh;
      if (tolerance !== undefined) options.tolerance = tolerance;
      if (onPair !== undefined) {
        // Awaited by the engine: the callback's port is not the reply's, so only waiting for it
        // keeps every pair ahead of the report. A main thread that went away fails nothing.
        options.onPair = (pair) =>
          Promise.resolve(
            onPair(Comlink.transfer(pair, pair.mesh ? meshBuffers(pair.mesh) : [])),
          ).catch(() => undefined);
      }
      try {
        const report = await engine.interference(assemblyId, options);
        if (report === null) return null;
        const buffers = report.pairs.flatMap((p) => (p.mesh ? meshBuffers(p.mesh) : []));
        return Comlink.transfer(report, buffers);
      } finally {
        // The main thread's callback: let its proxy go.
        const remote = onPair as { [Comlink.releaseProxy]?: () => void } | undefined;
        remote?.[Comlink.releaseProxy]?.();
      }
    },

    async cancelInterference(assemblyId) {
      (await engineFor()).cancelInterference(assemblyId);
    },

    async drawingView(document, drawingId, viewId, options) {
      return (await engineFor()).drawingView(document, drawingId, viewId, options);
    },

    async drawingSheet(document, drawingId, sheetId, options) {
      return (await engineFor()).drawingSheet(document, drawingId, sheetId, options);
    },

    async orientedSizes(document, partId, options) {
      return (await engineFor()).orientedSizes(document, partId, options);
    },

    async camGeometry(document, setupId, options) {
      const result = await (await engineFor()).camGeometry(document, setupId, options);
      return result === null ? null : Comlink.transfer(result, camTransferables(result));
    },

    async memberBodies(partId, memberIds, options) {
      const result = await (await engineFor()).memberBodies(partId, memberIds, options);
      return result === null ? null : Comlink.transfer(result, memberBodiesTransferables(result));
    },

    async regenStats() {
      return (await engineFor()).stats;
    },

    outlineText(request, options = {}) {
      const text = (outliner ??= lazyTextOutliner());
      const budget = passBudget(options.pass);
      const reply = previews.then(() => text.outline(request, { budget }));
      previews = reply.catch(() => undefined);
      return reply;
    },

    async exportIfc(building) {
      // The writer and web-ifc load here, on the first export: their own chunks and `.wasm`.
      const { writeIfc } = await import('@manufakture/io/ifc');
      const url = options.ifcWasmUrl;
      const bytes = await writeIfc(
        building,
        url === undefined ? {} : { locateFile: (path) => (path.endsWith('.wasm') ? url : path) },
      );
      return Comlink.transfer(bytes, [bytes.buffer]);
    },

    async watchScripts(onRun, runaway) {
      if (!Array.isArray(runaway)) throw new TypeError('runaway must be a list of cache keys');
      for (const key of runaway.slice(0, 10_000))
        if (typeof key === 'string') runawayScripts.add(key);
      // Fire and forget: a script run holds this worker, so nothing here may wait for the reply.
      scriptMonitor =
        typeof onRun === 'function'
          ? (event) => void Promise.resolve(onRun(event)).catch(() => undefined)
          : null;
      if (engine !== null) {
        engine.setScriptMonitor(scriptMonitor);
        engine.addRunawayScripts([...runawayScripts]);
      }
    },

    async setScriptPolicy(policy) {
      const checked = checkScriptPolicy(policy);
      scriptPolicy = checked ?? DENY_ALL_SCRIPTS;
      engine?.setScriptPolicy(scriptPolicy);
      if (checked === null) throw new TypeError('not a script policy: every script is denied');
    },

    async scriptDeclarations(script, documentId) {
      const s = script as Partial<ScriptDeclarationSource> | null;
      if (typeof documentId !== 'string') throw new TypeError('not a document id');
      if (
        s === null ||
        typeof s !== 'object' ||
        typeof s.id !== 'string' ||
        typeof s.source !== 'string' ||
        (s.language !== 'js' && s.language !== 'ts') ||
        typeof s.apiVersion !== 'number'
      ) {
        throw new TypeError('not a script');
      }
      return (await engineFor()).scriptDeclarations(
        { id: s.id, source: s.source, language: s.language, apiVersion: s.apiVersion },
        documentId,
      );
    },

    async scriptStats() {
      return (await engineFor()).scriptStats;
    },

    async readFont(fileName, bytes) {
      if (!given?.readFont) {
        return {
          ok: false,
          message: unreadableFont(
            fileName,
            'user fonts are read only in the text worker, under a time limit, and this host has none',
          ),
        };
      }
      return given.readFont(fileName, bytes);
    },
  };
}
