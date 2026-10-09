// Base and head regenerated on an engine of the bundle's own (never the session's: its kernel and
// caches stay as they are), one after the other, and everything the bundle needs read from each
// while its shapes are live: the meshes to draw, each body's measurements, the interference of
// each assembly at its stored poses, the quantities, and the regen errors. The head is
// regenerated after the base on the same engine, so what the branch did not change comes from
// the cache; bodies and member sets a regen reports unchanged keep the meshes the base sent.

import type { ManufaktureDocument } from '@manufakture/core';
import type { MemberInstances, MemberMesh, RegenResult } from '@manufakture/regen';
import { buildScene, type CachedBodyMesh, type Scene } from '@manufakture/render';
import {
  ModelState,
  References,
  errorsOf,
  measure,
  quantities,
  type Engine,
  type EngineApi,
  type ErrorLine,
  type Quantities,
  type QueryContext,
  type Refusal,
} from '@manufakture/session';
import { assemblyScene, type AssemblyAt, type AssemblySceneResult } from './assembly';
import { round, shown } from './text';
import { LIMITS, type BodyMeasurement, type InterferencePair } from './types';

export interface WorkbenchLimits {
  /** One regen. */
  regenMs: number;
  /** Any other kernel call. */
  kernelMs: number;
}

export interface MeasuredBody {
  partId: string;
  bodyId: string;
  name: string;
  measurement: BodyMeasurement | null;
  error?: string;
}

export interface SideReport {
  document: ManufaktureDocument;
  result: RegenResult;
  /** What the renderer draws, or why it cannot. */
  scene: { ok: true; value: Scene } | { ok: false; message: string };
  /** Per view asked for with an assembly (`side`'s `assemblies`), its scene at the pose. */
  assemblyScenes: (AssemblySceneResult | undefined)[];
  bodies: MeasuredBody[];
  /** Bodies left unmeasured past `LIMITS.bodies`. */
  bodiesOmitted: number;
  interference: Map<string, { pairs: InterferencePair[] } | { error: string }>;
  quantities: Quantities;
  errors: ErrorLine[];
}

/** A kernel call that took too long: the bundle is not built. */
export class WorkbenchTimeout extends Error {
  constructor(what: string, ms: number) {
    super(`${what} took longer than ${ms} ms.`);
    this.name = 'WorkbenchTimeout';
  }
}

async function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new WorkbenchTimeout(what, ms)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** The message of a refusal: a session error's, or core's. */
const refusalText = (e: Refusal): string => ('message' in e ? e.message : e.error.message);

const measurement = (v: Record<string, unknown>): BodyMeasurement => {
  const box = v.boundingBox as { min: number[]; max: number[] } | null | undefined;
  return {
    volume: round(v.volume as number),
    area: round(v.area as number),
    mass: typeof v.mass === 'number' ? round(v.mass) : null,
    material: typeof v.material === 'string' ? shown(v.material) : null,
    boundingBox: box ? { min: box.min.map(round), max: box.max.map(round) } : null,
  };
};

export class Workbench {
  readonly #engine: Engine;
  readonly #limits: WorkbenchLimits;
  #generation = 0;
  readonly #model = new ModelState();
  readonly #references = new References();
  readonly #bodyMeshes = new Map<string, CachedBodyMesh>();
  readonly #memberInstances = new Map<string, readonly MemberInstances[]>();
  readonly #memberMeshes = new Map<string, MemberMesh>();

  constructor(engine: Engine, limits: WorkbenchLimits) {
    this.#engine = engine;
    this.#limits = limits;
  }

  /** The engine's API with every call but a regen under the kernel limit. */
  #api(): EngineApi {
    const api = this.#engine.api;
    const ms = this.#limits.kernelMs;
    return {
      regen: (doc, options) => api.regen(doc, options),
      run: (batch) => within(api.run(batch), ms, 'A kernel call'),
      release: (shapes) => within(api.release(shapes), ms, 'A kernel call'),
      cancel: (generation) => api.cancel(generation),
      stats: () => within(api.stats(), ms, 'A kernel call'),
      interference: (...args) => within(api.interference(...args), ms, 'An interference check'),
      orientedSizes: (...args) => within(api.orientedSizes(...args), ms, 'A kernel call'),
    } as EngineApi;
  }

  #forget(): void {
    this.#model.reset();
    this.#references.forget();
    this.#bodyMeshes.clear();
    this.#memberInstances.clear();
    this.#memberMeshes.clear();
  }

  async #regen(document: ManufaktureDocument): Promise<RegenResult> {
    const api = this.#api();
    for (let attempt = 0; attempt < 3; attempt++) {
      if (await within(this.#engine.wantsRestart(), this.#limits.kernelMs, 'A kernel check')) {
        await this.#engine.restart();
        this.#forget();
      }
      const before = (await api.stats()).instance;
      const generation = ++this.#generation;
      const result = await within(
        this.#engine.api.regen(document, { generation }),
        this.#limits.regenMs,
        'A regen',
      );
      if (result === null) throw new Error('The regen was superseded.');
      // An in-process kernel that recycled right after the regen dropped its shapes: again.
      if ((await api.stats()).instance !== before) {
        this.#forget();
        continue;
      }
      this.#keep(result);
      return result;
    }
    throw new Error('The kernel kept recycling.');
  }

  /** Keep what a later regen reports unchanged without sending again. */
  #keep(result: RegenResult): void {
    this.#model.update(result);
    for (const part of result.parts) {
      for (const body of part.bodies) {
        if (body.mesh) this.#bodyMeshes.set(body.bodyKey, { mesh: body.mesh, names: result.names });
      }
      for (const set of part.members ?? []) {
        if (set.instances) this.#memberInstances.set(set.setKey, set.instances);
      }
    }
    for (const source of result.sources) {
      for (const body of source.bodies) {
        if (body.mesh) this.#bodyMeshes.set(body.bodyKey, { mesh: body.mesh, names: result.names });
      }
    }
    for (const m of result.memberMeshes?.added ?? []) this.#memberMeshes.set(m.key, m);
    for (const k of result.memberMeshes?.removed ?? []) this.#memberMeshes.delete(k);
  }

  #scene(document: ManufaktureDocument, result: RegenResult): SideReport['scene'] {
    const bodyMeshes = new Map<string, CachedBodyMesh>();
    const memberInstances = new Map<string, readonly MemberInstances[]>();
    for (const part of result.parts) {
      for (const body of part.bodies) {
        const cached = this.#bodyMeshes.get(body.bodyKey);
        if (!body.mesh && cached) bodyMeshes.set(`${part.partId}/${body.bodyId}`, cached);
      }
      for (const set of part.members ?? []) {
        const cached = this.#memberInstances.get(set.setKey);
        if (!set.instances && cached) memberInstances.set(`${part.partId}/${set.group}`, cached);
      }
    }
    const scene = buildScene({
      result,
      memberMeshes: this.#memberMeshes,
      document,
      bodyMeshes,
      memberInstances,
    });
    return scene.ok ? scene : { ok: false, message: scene.error.message };
  }

  /** Assembly scenes at the poses `assemblies` ask for (one per view; undefined for others). */
  #assemblyScenes(
    document: ManufaktureDocument,
    result: RegenResult,
    assemblies: readonly (AssemblyAt | undefined)[],
  ): SideReport['assemblyScenes'] {
    if (assemblies.every((a) => a === undefined)) return assemblies.map(() => undefined);
    // Meshes of bodies this regen reports unchanged, by part (or source) and body.
    const bodyMeshes = new Map<string, CachedBodyMesh>();
    const add = (owner: string, body: { bodyId: string; bodyKey: string; mesh: unknown }) => {
      const cached = this.#bodyMeshes.get(body.bodyKey);
      if (!body.mesh && cached) bodyMeshes.set(`${owner}/${body.bodyId}`, cached);
    };
    for (const part of result.parts) for (const body of part.bodies) add(part.partId, body);
    for (const source of result.sources) for (const body of source.bodies) add(source.key, body);
    return assemblies.map((at) =>
      at === undefined ? undefined : assemblyScene(document, result, at, bodyMeshes),
    );
  }

  /**
   * Regenerate `document` and read everything the bundle needs of it; with `assemblies`, the
   * scene of each view that asks for an assembly too.
   */
  async side(
    document: ManufaktureDocument,
    assemblies: readonly (AssemblyAt | undefined)[] = [],
  ): Promise<SideReport> {
    const result = await this.#regen(document);
    const api = this.#api();
    await this.#references.sync(document, api, this.#generation);
    const ctx: QueryContext = {
      document,
      model: this.#model,
      api,
      generation: this.#generation,
      references: this.#references,
    };

    const all = result.parts.flatMap((p) => p.bodies.map((b) => ({ partId: p.partId, body: b })));
    const bodies: MeasuredBody[] = [];
    for (const { partId, body } of all.slice(0, LIMITS.bodies)) {
      const part = document.parts.find((p) => p.id === partId);
      const name =
        part?.bodies.find((b) => b.id === body.bodyId)?.name ??
        body.inherited?.name ??
        (body.bodyId === body.creator
          ? part?.features.find((f) => f.id === body.creator)?.name
          : undefined) ??
        body.bodyId;
      const r = await measure(ctx, { kind: 'body', partId, bodyId: body.bodyId });
      bodies.push(
        r.ok
          ? {
              partId,
              bodyId: body.bodyId,
              name,
              measurement: measurement(r.value as Record<string, unknown>),
            }
          : { partId, bodyId: body.bodyId, name, measurement: null, error: refusalText(r.error) },
      );
    }

    const interference: SideReport['interference'] = new Map();
    for (const assembly of document.assemblies.slice(0, LIMITS.assemblies)) {
      const poses = Object.fromEntries(assembly.instances.map((i) => [i.id, i.pose]));
      const r = await measure(ctx, { kind: 'interference', assemblyId: assembly.id, poses });
      if (!r.ok) {
        interference.set(assembly.id, { error: refusalText(r.error) });
        continue;
      }
      const v = r.value as { pairs: { a: string; b: string; volume: number }[] };
      interference.set(assembly.id, {
        pairs: v.pairs
          .slice(0, LIMITS.pairs)
          .map((p) => ({ a: shown(p.a), b: shown(p.b), volume: round(p.volume) })),
      });
    }

    return {
      document,
      result,
      scene: this.#scene(document, result),
      assemblyScenes: this.#assemblyScenes(document, result, assemblies),
      bodies,
      bodiesOmitted: Math.max(0, all.length - LIMITS.bodies),
      interference,
      quantities: quantities(ctx),
      errors: errorsOf(result, this.#references),
    };
  }
}
