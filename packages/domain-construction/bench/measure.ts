// The measurements of the T6.5d house bench (`house.bench.ts`), each on a fresh kernel instance
// and a fresh regen engine, as the T6.5a spike measured its representations
// (docs/spikes/T6.5a-framing.md, "Method"):
//
// - **cold**: create the kernel service (timed apart: "kernel instance start", excluded from the
//   budget), then regenerate the whole house with an empty cache and a Manifold module loaded on
//   the first cut member, as the regen worker does after a page load;
// - **warm**: after a cold regen, move the south wall's window 12" and back, alternately, and
//   regenerate (the spike's warm case). Each move also shifts the window by a further 1/64", so
//   no position repeats: regen's feature cache keeps earlier results, and an exact 12" and back
//   would be served from it after the first two moves, rebuilding nothing;
// - **leak**: N full regens on one instance (a new engine each time, disposed after, so every body
//   is built and released), then `heapInUse` (`@manufakture/kernel/testing`, the T0.2 probe as
//   T6.5a ported it) once at the end. Compare two N on fresh instances (T6.5a rule 5).
//
// "Framing" is what the member stage reports per group (`MemberSetResult.ms`: framing and meshing,
// Manifold's load included where it happens), summed over the groups. "Whole regen" is
// `RegenResult.ms` in the engine: features, layer bodies, members, meshes; transfer to the main
// thread and the viewport update are the e2e spec's (`apps/web/e2e/perf-house.spec.ts`).

import { applyCommand, createDocument, type ManufaktureDocument } from '@manufakture/core';
import type { KernelService } from '@manufakture/kernel';
import { createNodeService } from '@manufakture/kernel/node';
import { heapInUse, occtAllocator } from '@manufakture/kernel/testing';
import {
  ExtensionRegistry,
  RegenEngine,
  type RegenResult,
  type RegenSolver,
} from '@manufakture/regen';
import { registerConstruction } from '../src/domain';
import { HOUSE_IDS, MOVED_POSITION_IN, houseCommands, movedWindow } from '../src/fixtures/house';

export const PART = 'part#1';

/**
 * T6.5a's budgets for the house (report section "4. Budgets for T6.5d (revised)"), ms. Node
 * numbers here; draw calls and frame time are the e2e spec's.
 */
export const HOUSE_BUDGETS = {
  /** Framing, cold (generate, mesh with Manifold load, instance lists). Spike: 52 ms. */
  framingCold: 150,
  /** Framing, warm after moving one opening. Spike: 0.63 ms. */
  framingWarm: 10,
  /** Whole regen, cold, kernel instance start excluded. The plan's 5 s lowered to 3 s. */
  regenCold: 3_000,
  /** Whole regen, warm after moving one opening. The plan's 300 ms lowered to 150 ms. */
  regenWarm: 150,
} as const;

const noSolver: RegenSolver = {
  solve: () => {
    throw new Error('the house has no sketches');
  },
};

function apply(doc: ManufaktureDocument, command: Parameters<typeof applyCommand>[1]) {
  const r = applyCommand(doc, command);
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value.document;
}

/** The house as a document: one part, `part#1`. */
export function houseDocument(): ManufaktureDocument {
  return apply(createDocument({ id: 'house', name: 'House' }), houseCommands(PART));
}

/** The house with the moved window at `position` inches. */
export function houseWithWindowAt(doc: ManufaktureDocument, position: number): ManufaktureDocument {
  return apply(doc, { type: 'editFeature', partId: PART, feature: movedWindow(position) });
}

export function engineFor(service: KernelService): RegenEngine {
  const extensions = new ExtensionRegistry();
  registerConstruction(extensions);
  return new RegenEngine({ kernel: service, solver: noSolver, extensions });
}

export async function regen(
  engine: RegenEngine,
  service: KernelService,
  doc: ManufaktureDocument,
): Promise<RegenResult> {
  const s = service.stats();
  const generation = Math.max(engine.generation, s.generation, s.cancelledThrough) + 1;
  const result = await engine.regen(doc, { generation });
  if (result === null) throw new Error('the regen was superseded');
  return result;
}

/** Throws unless every feature of the house built. */
export function checkOk(result: RegenResult): void {
  const bad = result.parts[0]!.features.filter((f) => f.status !== 'ok');
  if (bad.length > 0) {
    throw new Error(
      `features failed: ${bad.map((f) => `${f.featureId} ${JSON.stringify(f.errors)}`).join('; ')}`,
    );
  }
}

const framingMs = (result: RegenResult): number =>
  (result.parts[0]!.members ?? []).reduce((t, s) => t + s.ms, 0);

export interface ColdSample {
  /** Creating the kernel service on a fresh instance (excluded from the budget). */
  instanceStartMs: number;
  regenMs: number;
  framingMs: number;
  /** Wall-clock time of the `regen` call, for comparison with `regenMs`. */
  wallMs: number;
  members: number;
  roles: Record<string, number>;
  groups: number;
  shapes: number;
  bodies: number;
  /** Shape meshes added for the main thread, their bytes and the instance matrices' bytes. */
  meshBytes: number;
  matrixBytes: number;
  manifoldCreated: number;
  manifoldDeleted: number;
}

export async function cold(): Promise<ColdSample> {
  const t0 = performance.now();
  const service = await createNodeService();
  const instanceStartMs = performance.now() - t0;
  const engine = engineFor(service);
  const doc = houseDocument();
  const t1 = performance.now();
  const result = await regen(engine, service, doc);
  const wallMs = performance.now() - t1;
  checkOk(result);
  const sets = result.parts[0]!.members ?? [];
  const roles: Record<string, number> = {};
  for (const s of sets) for (const m of s.members ?? []) roles[m.role] = (roles[m.role] ?? 0) + 1;
  const added = result.memberMeshes?.added ?? [];
  const meshBytes = added.reduce(
    (t, m) => t + m.positions.byteLength + m.normals.byteLength + m.indices.byteLength,
    0,
  );
  const matrixBytes = sets
    .flatMap((s) => s.instances ?? [])
    .reduce((t, l) => t + l.matrices.byteLength, 0);
  const stats = engine.memberStats;
  const sample: ColdSample = {
    instanceStartMs,
    regenMs: result.ms,
    framingMs: framingMs(result),
    wallMs,
    members: sets.reduce((t, s) => t + s.count, 0),
    roles: Object.fromEntries(Object.entries(roles).sort(([a], [b]) => a.localeCompare(b))),
    groups: sets.length,
    shapes: stats.meshes,
    bodies: result.parts[0]!.bodies.length,
    meshBytes,
    matrixBytes,
    manifoldCreated: stats.manifoldCreated,
    manifoldDeleted: stats.manifoldDeleted,
  };
  await engine.dispose();
  await service.idle();
  const leaks = service.leaks();
  if (leaks.length > 0) throw new Error(`${leaks.length} shapes left alive after dispose`);
  return sample;
}

export interface WarmSamples {
  regenMs: number[];
  framingMs: number[];
  /** The moved window's wall group: its own framing time. */
  movedGroupMs: number[];
  /** Groups the member stage framed again per warm regen (the rest were cached). */
  reframed: number[];
  /** Features rebuilt per warm regen (not served from the cache). */
  rebuilt: number[];
}

/** `runs` warm regens after one cold regen, the window moved about 12" and back alternately. */
export async function warm(runs: number): Promise<WarmSamples> {
  const service = await createNodeService();
  const engine = engineFor(service);
  const base = houseDocument();
  checkOk(await regen(engine, service, base));
  const out: WarmSamples = {
    regenMs: [],
    framingMs: [],
    movedGroupMs: [],
    reframed: [],
    rebuilt: [],
  };
  const host = HOUSE_IDS.exterior[0];
  for (let i = 0; i < runs; i++) {
    const at = MOVED_POSITION_IN + (i % 2 === 0 ? 12 : 0) + (i + 1) / 64;
    const result = await regen(engine, service, houseWithWindowAt(base, at));
    checkOk(result);
    const sets = result.parts[0]!.members ?? [];
    out.regenMs.push(result.ms);
    out.framingMs.push(framingMs(result));
    out.movedGroupMs.push(sets.find((s) => s.group === host)?.ms ?? NaN);
    out.reframed.push(sets.filter((s) => !s.cached).length);
    out.rebuilt.push(result.parts[0]!.features.filter((f) => !f.cached).length);
  }
  await engine.dispose();
  await service.idle();
  return out;
}

export interface LeakSample {
  n: number;
  /** `heapInUse` after n full regens, bytes. */
  heapInUse: number;
  /** The wasm memory's size, bytes. */
  heapBytes: number;
  /** The kernel instance number at the end: 1 unless it recycled (the probe is then void). */
  instance: number;
  msPerRegen: number;
}

/** n full regens on one fresh instance, then the heap probe (call once per process). */
export async function leak(n: number): Promise<LeakSample> {
  // No recycle in the middle of the measurement: the probe reads the instance it ran on.
  const service = await createNodeService({ heapThresholdBytes: 3.5 * 1024 ** 3 });
  const doc = houseDocument();
  const t0 = performance.now();
  for (let i = 0; i < n; i++) {
    const engine = engineFor(service);
    checkOk(await regen(engine, service, doc));
    await engine.dispose();
    await service.idle();
  }
  const msPerRegen = (performance.now() - t0) / n;
  const heapBytes = service.stats().heapBytes;
  const instance = service.instance;
  return {
    n,
    heapInUse: heapInUse(occtAllocator(service.kernel.oc)),
    heapBytes,
    instance,
    msPerRegen,
  };
}

export const median = (xs: readonly number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const h = s.length >> 1;
  return s.length % 2 ? s[h]! : (s[h - 1]! + s[h]!) / 2;
};

export const percentile = (xs: readonly number[], p: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
};
