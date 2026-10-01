// What the app starts with. By default the kernel worker (with the regen engine) and an empty
// document: every body the viewport shows is regenerated from the document (model/model.ts).
// Three test scenes are only honoured where the test hooks are on (see testHooks.ts):
// `?scene=demo` opens the demo part as a document (model/demo.ts), and two kernel-free scenes
// serve tests: `?scene=test` (a named box, for the e2e pick check) and `?scene=perf&triangles=N`
// (a dense sphere, for frame time measurements).

import type { ManufaktureDocument } from '@manufakture/core';
import type { LoadProgress } from '@manufakture/kernel';
import type { KernelClientOptions } from '@manufakture/kernel/client';
import { spawnRegenWorker, type RegenClient } from '@manufakture/regen/client';
import type { Assembler } from '../assembly/assembly';
import { kernelExchange, type Exchanger, type KernelBody, type Referencer } from '../io/exchange';
import type { Measurer } from '../measure/measurer';
import { demoDocument } from '../model/demo';
import { kernelRegenerator } from '../model/kernelModel';
import type { Regenerator } from '../model/model';
import { testHooksEnabled } from '../testHooks';
import type { BodyInput } from './bodies';
import { fillPlaceholderNames } from './naming';
import { boxBody, denseSphereBody } from './testMeshes';

export interface LoadStatus {
  label: string;
  /** 0..1, or null when unknown. */
  fraction: number | null;
}

export interface SceneLoader {
  /**
   * Start loading (once) and resolve with the scene's fixed bodies (none for the kernel scenes,
   * whose bodies come from regen). May be called again, e.g. by a remounted component: it gets
   * the same promise. `onStatus` is called with the current status at once and with every
   * change until `signal` aborts.
   */
  load(onStatus: (status: LoadStatus) => void, signal?: AbortSignal): Promise<BodyInput[]>;
  dispose(): void;
  /** Regenerates documents in the kernel worker; absent for kernel-free scenes. */
  regenerator?: Regenerator;
  /** Exact measurements of the kernel's bodies; absent for kernel-free scenes. */
  measurer?: Measurer;
  /** Export and STEP import through the kernel; absent for kernel-free scenes. */
  exchanger?: Exchanger;
  /** Picking references to store (the kernel's minimal edge refs); absent for kernel-free scenes. */
  referencer?: Referencer;
  /** Assembly previews and drags in the regen worker; absent for kernel-free scenes. */
  assembler?: Assembler;
  /** A document the scene opens with (the demo scene); the app loads it once the scene is loaded. */
  initialDocument?: ManufaktureDocument;
}

/** Shared plumbing: one load, status fan-out, late subscribers get the latest status. */
function loaderFrom(
  initial: LoadStatus,
  run: (report: (status: LoadStatus) => void) => Promise<BodyInput[]>,
  dispose: () => void = () => {},
): SceneLoader {
  let status = initial;
  const listeners = new Set<(status: LoadStatus) => void>();
  const report = (s: LoadStatus) => {
    status = s;
    for (const l of listeners) l(s);
  };
  let result: Promise<BodyInput[]> | null = null;
  return {
    load(onStatus, signal) {
      if (!signal?.aborted) {
        listeners.add(onStatus);
        signal?.addEventListener('abort', () => listeners.delete(onStatus), { once: true });
      }
      onStatus(status);
      result ??= run(report);
      return result;
    },
    dispose() {
      listeners.clear();
      dispose();
    },
  };
}

const MB = 1024 * 1024;

/**
 * Splash text and progress for the kernel's load phases. Download is most of
 * a first visit; after it, runtime init dominates (ADR 0002).
 */
export function kernelLoadStatus(p: LoadProgress): LoadStatus {
  switch (p.phase) {
    case 'download': {
      const total = p.total;
      const loaded = `${(p.loaded / MB).toFixed(1)}`;
      if (total === null || total <= 0) {
        return { label: `Downloading the geometry kernel (${loaded} MB)`, fraction: null };
      }
      const f = Math.min(1, p.loaded / total);
      return {
        label: `Downloading the geometry kernel (${loaded} of ${(total / MB).toFixed(1)} MB)`,
        fraction: f * 0.7,
      };
    }
    case 'compile':
      return { label: 'Compiling the geometry kernel', fraction: 0.75 };
    case 'instantiate':
      return { label: 'Starting the geometry kernel', fraction: 0.8 };
    case 'init':
      return { label: 'Initialising the geometry kernel', fraction: 0.85 };
    case 'ready':
      return { label: 'Geometry kernel ready', fraction: 0.95 };
  }
}

/**
 * The kernel scene: starts the regen worker (the kernel and the regen engine, ADR 0007) with load
 * progress, and resolves with no fixed bodies once the kernel is ready; the part bodies come
 * from regenerating the document. The worker is spawned by the first `load`; call it at app
 * start-up so kernel loading overlaps UI start-up (ADR 0002).
 */
export function kernelLoader(
  spawn: (options: KernelClientOptions) => RegenClient,
  options: { initialDocument?: ManufaktureDocument } = {},
): SceneLoader {
  let client: RegenClient | null = null;
  // Viewport body id to kernel shape: the part bodies from regen, then imported STEP bodies.
  const registry = new Map<string, KernelBody>();
  const { exchanger, measurer, referencer } = kernelExchange(() => client, registry);
  const regenerator = kernelRegenerator(() => client, registry);
  const assembler: Assembler = {
    solve: (document, assemblyId) =>
      client === null ? Promise.resolve(null) : client.solveAssembly(document, assemblyId),
    drag: (assemblyId, instanceId, target) =>
      client === null ? Promise.resolve(null) : client.dragInstance(assemblyId, instanceId, target),
    endDrag: (assemblyId) => void client?.endDrag(assemblyId).catch(() => undefined),
  };
  const loader = loaderFrom(
    { label: 'Starting the geometry kernel', fraction: null },
    async (report) => {
      const c = spawn({
        onStatus: (s) => {
          if (s.type === 'loading') report(kernelLoadStatus(s.progress));
          // Every shape is gone: the document is regenerated again (and imports re-read).
          if (s.type === 'recycled') regenerator.invalidate();
        },
        // Likewise after a stuck worker was replaced.
        onRestarted: () => regenerator.invalidate(),
      });
      client = c;
      await c.ready;
      return [];
    },
    () => client?.terminate(),
  );
  return {
    ...loader,
    regenerator,
    measurer,
    exchanger,
    referencer,
    assembler,
    ...(options.initialDocument ? { initialDocument: options.initialDocument } : {}),
  };
}

/** A loader for bodies that need no kernel. */
export function staticLoader(label: string, make: () => BodyInput[]): SceneLoader {
  return loaderFrom({ label, fraction: null }, async () => {
    // Yield once, so the splash can paint before a large mesh is built.
    await new Promise((resolve) => setTimeout(resolve, 0));
    return make().map((b) => ({ ...b, names: fillPlaceholderNames(b.mesh, b.names) }));
  });
}

export type SceneName = 'default' | 'demo' | 'test' | 'perf';

export interface SceneChoice {
  scene: SceneName;
  triangles: number;
}

export const DEFAULT_PERF_TRIANGLES = 200_000;

export function sceneFromSearch(search: string): SceneChoice {
  const params = new URLSearchParams(search);
  const s = params.get('scene');
  const scene: SceneName = s === 'test' || s === 'perf' || s === 'demo' ? s : 'default';
  const t = Number(params.get('triangles'));
  const triangles =
    Number.isFinite(t) && t > 0 ? Math.min(Math.floor(t), 5_000_000) : DEFAULT_PERF_TRIANGLES;
  return { scene, triangles };
}

/** The test scene: a named 40 x 30 x 20 box standing on the origin. */
export const TEST_BOX = { id: 'test-box', min: [-20, -15, 0], size: [40, 30, 20] } as const;

export function testLoader(): SceneLoader {
  return staticLoader('Loading the test scene', () => [
    boxBody({ id: TEST_BOX.id, min: TEST_BOX.min, size: TEST_BOX.size }),
  ]);
}

export function perfLoader(triangles: number): SceneLoader {
  return staticLoader(`Building a ${triangles.toLocaleString('en')} triangle mesh`, () => [
    denseSphereBody(triangles),
  ]);
}

/**
 * The scene named in the page URL; the kernel with an empty document by default, and always
 * when `testScenes` is off.
 */
export function loaderForLocation(
  search: string = window.location.search,
  spawn: (options: KernelClientOptions) => RegenClient = spawnRegenWorker,
  testScenes: boolean = testHooksEnabled,
): SceneLoader {
  const choice: SceneChoice = testScenes
    ? sceneFromSearch(search)
    : { scene: 'default', triangles: 0 };
  if (choice.scene === 'test') return testLoader();
  if (choice.scene === 'perf') return perfLoader(choice.triangles);
  if (choice.scene === 'demo') return kernelLoader(spawn, { initialDocument: demoDocument() });
  return kernelLoader(spawn);
}
