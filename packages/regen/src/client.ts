// Main-thread side of the regen worker: the kernel client (batches for pick, measure, export,
// numbered by generation, ADR 0007 decision 4) plus `regen`. Every request of every kind takes
// its generation from the one sequence the client keeps, because the kernel service cancels by
// generation whoever sent the batch: a regen cancels the batches of older requests, and a pick
// or measure sent at the current generation never cancels a regen. Only a regen may take a new
// generation: any other batch that did would cancel the regen in flight, with nothing to report
// in its place.

import type { DragTarget } from '@manufakture/assembly';
import type { ManufaktureDocument } from '@manufakture/core';
import type { IfcBuildingInput } from '@manufakture/io';
import type { ShapeId } from '@manufakture/kernel';
import {
  KernelClient,
  type KernelClientOptions,
  type KernelEndpoint,
} from '@manufakture/kernel/kernel-client';
import * as Comlink from 'comlink';
import type { CamGeometryOptions, CamGeometryResult } from './cam';
import type { DrawingSheetResult, DrawingViewResult } from './drawing';
import type { EngineStats } from './engine';
import type { OrientedSizesOptions, OrientedSizesResult } from './oriented';
import type { ScriptRunEvent } from './scripted';
import type { FontReadReply, TextReply, TextRequest } from './text';
import type {
  AssemblyResult,
  DragResult,
  InstanceInterference,
  InterferenceReport,
  MemberBodiesResult,
  RegenResult,
} from './types';
import type { RegenWorkerApi, TextPreviewOptions } from './worker-api';
import type { InitReport } from '@manufakture/kernel';

/**
 * How long one script run may hold the regen worker before the client terminates and restarts it
 * (ADR 0010 amendment, item 4): `RECOMMENDED_HARD_TIMEOUT_MS` of `@manufakture/script`, copied
 * here so the main thread does not load the sandbox to read one number (a test checks they agree).
 */
export const SCRIPT_HARD_TIMEOUT_MS = 10_000;

/** The most runaway runs a client remembers (each a cache key the next worker refuses to run). */
const MAX_RUNAWAY = 1000;

export interface RegenClientOptions extends KernelClientOptions {
  /** The hard limit on one script run, in ms (default `SCRIPT_HARD_TIMEOUT_MS`). */
  scriptTimeoutMs?: number;
  /**
   * Told when the watchdog stopped a runaway script: the worker is being restarted, and
   * `onRestarted` follows once the new one is ready (the owner regenerates; the feature then
   * fails with `timeout` instead of running again).
   */
  onScriptTimeout?: (event: { featureId: string; key: string }) => void;
}

export class RegenClient extends KernelClient {
  readonly #scriptTimeoutMs: number;
  readonly #onScriptTimeout: RegenClientOptions['onScriptTimeout'];
  /** Cache keys of runs a worker was terminated for, handed to every new worker. */
  readonly #runaway = new Set<string>();
  /** The worker whose script events count; events from an older one are ignored. */
  #watching = 0;
  #timer: { key: string; featureId: string; handle: ReturnType<typeof setTimeout> } | null = null;

  constructor(connect: () => KernelEndpoint, options: RegenClientOptions = {}) {
    const ms = options.scriptTimeoutMs ?? SCRIPT_HARD_TIMEOUT_MS;
    // Checked before a worker is started for nothing.
    if (!(ms > 0)) throw new RangeError('scriptTimeoutMs must be above 0');
    super(connect, options);
    this.#scriptTimeoutMs = ms;
    this.#onScriptTimeout = options.onScriptTimeout;
    this.#watch();
  }

  /** Cache keys of the script runs the watchdog stopped so far. */
  get runawayScripts(): readonly string[] {
    return [...this.#runaway];
  }

  override restart(): Promise<InitReport> {
    this.#clearTimer();
    const ready = super.restart();
    this.#watch();
    return ready;
  }

  override terminate(): void {
    this.#clearTimer();
    this.#watching++;
    super.terminate();
  }

  /**
   * Listen to the current worker's script runs (and give it the runaway list) before anything
   * else is asked of it: a run that has not ended after the limit terminates the worker.
   */
  #watch(): void {
    const watching = ++this.#watching;
    const onRun = (event: ScriptRunEvent) => {
      if (watching !== this.#watching) return;
      if (event.phase === 'start') {
        this.#clearTimer();
        this.#timer = {
          key: event.key,
          featureId: event.featureId,
          handle: setTimeout(() => this.#runawayFired(watching), this.#scriptTimeoutMs),
        };
      } else if (this.#timer?.key === event.key) {
        this.#clearTimer();
      }
    };
    void Promise.resolve(
      this.worker<RegenWorkerApi>().watchScripts(Comlink.proxy(onRun), [...this.#runaway]),
    ).catch(() => undefined);
  }

  #runawayFired(watching: number): void {
    const timer = this.#timer;
    if (timer === null || watching !== this.#watching) return;
    this.#timer = null;
    if (this.#runaway.size >= MAX_RUNAWAY)
      this.#runaway.delete(this.#runaway.values().next().value!);
    this.#runaway.add(timer.key);
    void this.restart().catch(() => undefined);
    try {
      this.#onScriptTimeout?.({ featureId: timer.featureId, key: timer.key });
    } catch {
      // A broken listener must not stop the restart.
    }
  }

  #clearTimer(): void {
    if (this.#timer !== null) clearTimeout(this.#timer.handle);
    this.#timer = null;
  }

  /**
   * Regenerate `document` at a new generation. Resolves to null when a newer request superseded
   * it in the worker (a newer regen, or any batch submitted at a new generation), or when the
   * worker was stopped (`restart`, `terminate`) before it answered; after a restart the owner
   * hears of it through `onRestarted` and asks again. A regen that completed is always returned,
   * even when a newer request was made meanwhile: the engine reports each changed mesh once (to
   * the regen that built it), so a caller that drops a completed result must not rely on
   * `meshChanged` afterwards. `stored`: the document as stored when `document` has its active
   * configuration row applied (`RegenOptions.stored`).
   */
  regen(document: ManufaktureDocument, stored?: ManufaktureDocument): Promise<RegenResult | null> {
    const generation = this.nextGeneration();
    // Sent in one message, `stored` costs only what the row changed: parts and features the row
    // leaves alone are the same objects in both, and structured clone copies them once.
    return this.droppable(
      this.worker<RegenWorkerApi>().regen(
        document,
        stored === undefined ? { generation } : { generation, stored },
      ) as Promise<RegenResult | null>,
    ).then((result) => result ?? null);
  }

  /**
   * Solve an assembly of `document` for a preview, at the current generation (never cancelling
   * a regen). A mate dialog shows the result, then commits the mate and the solved poses of the
   * instances that `moved` in one `batch`. Null when superseded or when the worker was stopped.
   */
  solveAssembly(
    document: ManufaktureDocument,
    assemblyId: string,
    stored?: ManufaktureDocument,
  ): Promise<AssemblyResult | null> {
    const generation = this.latestGeneration;
    return this.droppable(
      this.worker<RegenWorkerApi>().solveAssembly(
        document,
        assemblyId,
        stored === undefined ? { generation } : { generation, stored },
      ) as Promise<AssemblyResult | null>,
    ).then((result) => result ?? null);
  }

  /**
   * One step of a pointer drag of an instance, at the current generation, from where the last
   * step left the assembly (after a regen: its solved poses). Send one per pointer move: the
   * worker coalesces them and answers only the latest (the others resolve to null). On release,
   * commit `setPoses` with the last result's `moved` instances.
   */
  dragInstance(
    assemblyId: string,
    instanceId: string,
    target: DragTarget,
  ): Promise<DragResult | null> {
    return this.droppable(
      this.worker<RegenWorkerApi>().dragInstance(assemblyId, instanceId, target, {
        generation: this.latestGeneration,
      }) as Promise<DragResult | null>,
    ).then((result) => result ?? null);
  }

  /**
   * A drag that ends without `setPoses` (cancelled, or nothing moved): the worker forgets where
   * its steps left the instances, so the next drag starts from what the screen shows.
   */
  endDrag(assemblyId: string): Promise<void> {
    return this.droppable(this.worker<RegenWorkerApi>().endDrag(assemblyId)).then(() => undefined);
  }

  /**
   * Which instances of an assembly overlap, and by how much, as the last regen (or a drag in
   * progress) placed them: on demand, never part of a regen. At the current generation, so it
   * never cancels a regen, and a newer regen supersedes it (null). `onPair` gets each overlapping
   * pair as it is found, with its mesh when `mesh` is set; the report then lists the pairs again
   * without meshes. Null too when the worker was stopped.
   */
  interference(
    assemblyId: string,
    options: {
      mesh?: boolean;
      tolerance?: number;
      onPair?: (pair: InstanceInterference) => void;
    } = {},
  ): Promise<InterferenceReport | null> {
    const { onPair, ...rest } = options;
    return this.droppable(
      this.worker<RegenWorkerApi>().interference(
        assemblyId,
        { ...rest, generation: this.latestGeneration },
        onPair ? Comlink.proxy(onPair) : undefined,
      ) as Promise<InterferenceReport | null>,
    ).then((result) => result ?? null);
  }

  /** Stop the running interference check of an assembly before its next pair. */
  cancelInterference(assemblyId: string): Promise<void> {
    return this.droppable(this.worker<RegenWorkerApi>().cancelInterference(assemblyId)).then(
      () => undefined,
    );
  }

  /**
   * One view of a drawing: its projected edges, its dimensions resolved on the current model and,
   * with `pick`, the picking data `pickInView` takes. On demand (the views on screen), at the
   * current generation, so it never cancels a regen; null when a newer regen superseded it or the
   * worker was stopped. `stored` as for `regen`.
   */
  drawingView(
    document: ManufaktureDocument,
    drawingId: string,
    viewId: string,
    options: { stored?: ManufaktureDocument; pick?: boolean } = {},
  ): Promise<DrawingViewResult | null> {
    return this.droppable(
      this.worker<RegenWorkerApi>().drawingView(document, drawingId, viewId, {
        ...options,
        generation: this.latestGeneration,
      }) as Promise<DrawingViewResult | null>,
    ).then((result) => result ?? null);
  }

  /** Every view of a sheet and the sheet's display list (for export, and the sheet on screen). */
  drawingSheet(
    document: ManufaktureDocument,
    drawingId: string,
    sheetId: string,
    options: { stored?: ManufaktureDocument; pick?: boolean } = {},
  ): Promise<DrawingSheetResult | null> {
    return this.droppable(
      this.worker<RegenWorkerApi>().drawingSheet(document, drawingId, sheetId, {
        ...options,
        generation: this.latestGeneration,
      }) as Promise<DrawingSheetResult | null>,
    ).then((result) => result ?? null);
  }

  /**
   * The oriented box sizes of a part's bodies, for the cut list (bodies that are not boards:
   * pass `skipExtensions: ['wood.board']`). On demand, at the current generation, so it never
   * cancels a regen; cached by body key in the worker, so asking again for unchanged bodies sends
   * nothing to the kernel. Null when a newer regen superseded it or the worker was stopped.
   */
  orientedSizes(
    document: ManufaktureDocument,
    partId: string,
    options: Omit<OrientedSizesOptions, 'generation'> = {},
  ): Promise<OrientedSizesResult | null> {
    return this.droppable(
      this.worker<RegenWorkerApi>().orientedSizes(document, partId, {
        ...options,
        generation: this.latestGeneration,
      }) as Promise<OrientedSizesResult | null>,
    ).then((result) => result ?? null);
  }

  /**
   * The geometry of one CAM setup, for the CAM worker: sources resolved on the final body,
   * expressions evaluated, depths in machine Z, and with `mesh` the body's CAM mesh. On demand,
   * at the current generation (never a new one, which would cancel the regen in flight); cached
   * in the worker, so an unchanged setup on an unchanged body sends nothing to the kernel. Null
   * when a newer regen superseded it or the worker was stopped.
   */
  camGeometry(
    document: ManufaktureDocument,
    setupId: string,
    options: Omit<CamGeometryOptions, 'generation'> = {},
  ): Promise<CamGeometryResult | null> {
    return this.droppable(
      this.worker<RegenWorkerApi>().camGeometry(document, setupId, {
        ...options,
        generation: this.latestGeneration,
      }) as Promise<CamGeometryResult | null>,
    ).then((result) => result ?? null);
  }

  /**
   * B-reps of framing members of the last regen (full ids), for a STEP export (`step: true`) or a
   * check of their volumes: built and released in the worker before it answers, never kept. At
   * the current generation, so it never cancels a regen. Null when a newer regen superseded it or
   * the worker was stopped.
   */
  memberBodies(
    partId: string,
    memberIds: readonly string[],
    options: {
      volumes?: boolean;
      step?: boolean;
      /** Bodies the kernel holds (layer bodies) to write into the STEP file first. */
      with?: readonly { shape: ShapeId; name: string }[];
    } = {},
  ): Promise<MemberBodiesResult | null> {
    return this.droppable(
      this.worker<RegenWorkerApi>().memberBodies(partId, memberIds, {
        ...options,
        generation: this.latestGeneration,
      }) as Promise<MemberBodiesResult | null>,
    ).then((result) => result ?? null);
  }

  /**
   * Lay out one text in the regen worker's text worker (under its watchdog), for the sketcher to
   * draw while the sketch is edited: never a regen, never a new generation. Null when the
   * worker was stopped before it answered.
   */
  outlineText(request: TextRequest, options?: TextPreviewOptions): Promise<TextReply | null> {
    return this.droppable(
      this.worker<RegenWorkerApi>().outlineText(request, options) as Promise<TextReply>,
    ).then((reply) => reply ?? null);
  }

  /**
   * Read a user font's names and permissions in the text worker (under its watchdog), for
   * **Add font**. The bytes are copied, not transferred: the caller keeps them for the document.
   * Null when the worker was stopped before it answered.
   */
  readFont(fileName: string, bytes: Uint8Array): Promise<FontReadReply | null> {
    return this.droppable(
      this.worker<RegenWorkerApi>().readFont(fileName, bytes) as Promise<FontReadReply>,
    ).then((reply) => reply ?? null);
  }

  /**
   * A building as an IFC4 file, written in the worker (web-ifc loads there on the first call).
   * Needs no kernel and takes no generation. Null when the worker was stopped before it answered.
   */
  exportIfc(building: IfcBuildingInput): Promise<Uint8Array | null> {
    return this.droppable(
      this.worker<RegenWorkerApi>().exportIfc(building) as Promise<Uint8Array>,
    ).then((bytes) => bytes ?? null);
  }

  regenStats(): Promise<EngineStats> {
    return this.worker<RegenWorkerApi>().regenStats() as Promise<EngineStats>;
  }
}

// The bundled fonts' metadata (ids, names, SHA-256), for the main thread: `@manufakture/text/bundled`
// loads no font parser, so this keeps opentype.js out of the app's bundle.
export {
  BUNDLED_FONTS,
  DEFAULT_FONT_ID,
  INTER_BOLD,
  bundledFont,
  type BundledFont,
} from '@manufakture/text/bundled';
