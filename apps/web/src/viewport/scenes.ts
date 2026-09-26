// What the viewport shows at start-up. Until documents and the regen engine
// exist, the app asks the kernel for a demo part. Two kernel-free scenes serve
// tests: `?scene=test` (a named box, for the e2e pick check) and
// `?scene=perf&triangles=N` (a dense sphere, for frame time measurements).
// They are only honoured where the test hooks are on (see testHooks.ts).

import {
  spawnKernelWorker,
  type KernelClient,
  type KernelClientOptions,
} from '@manufakture/kernel/client';
import type { KernelOp, LoadProgress, MeshData, Topology } from '@manufakture/kernel';
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
   * Start loading (once) and resolve with the bodies. May be called again,
   * e.g. by a remounted component: it gets the same promise. `onStatus` is
   * called with the current status at once and with every change until
   * `signal` aborts.
   */
  load(onStatus: (status: LoadStatus) => void, signal?: AbortSignal): Promise<BodyInput[]>;
  dispose(): void;
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

export const DEMO_BODY_ID = 'demo-part';

/**
 * The demo part: a 60 x 40 x 20 mm block with every edge filleted and a
 * through hole, as one batch (one round trip, ADR 0007 decision 3).
 */
export function demoPartOps() {
  return [
    { op: 'box', size: [60, 40, 20], at: [-30, -20, 0], featureId: 'block', keep: false },
    {
      op: 'fillet',
      shape: { result: 0 },
      edges: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
      radius: 3,
      featureId: 'fillet',
      keep: false,
      history: false,
    },
    { op: 'cylinder', radius: 8, height: 30, at: [0, 0, -5], featureId: 'hole', keep: false },
    {
      op: 'boolean',
      kind: 'cut',
      shape: { result: 1 },
      tools: [{ result: 2 }],
      featureId: 'hole',
      history: false,
    },
    { op: 'tessellate', shape: { result: 3 } },
    { op: 'topology', shape: { result: 3 } },
  ] as const satisfies readonly KernelOp[];
}

/**
 * Loads the demo part from a kernel worker, reporting load progress. The
 * worker is spawned by the first `load`; call it at app start-up so kernel
 * loading overlaps UI start-up (ADR 0002).
 */
export function kernelDemoLoader(
  spawn: (options: KernelClientOptions) => KernelClient,
): SceneLoader {
  let client: KernelClient | null = null;
  return loaderFrom(
    { label: 'Starting the geometry kernel', fraction: null },
    async (report) => {
      const c = spawn({
        onStatus: (s) => {
          if (s.type === 'loading') report(kernelLoadStatus(s.progress));
        },
      });
      client = c;
      await c.ready;
      report({ label: 'Building the demo part', fraction: 0.97 });
      const reply = await c.submit(demoPartOps());
      if (reply === null || reply.status !== 'done') {
        throw new Error('The kernel dropped the request.');
      }
      for (const r of reply.results) {
        if (!r.ok) throw new Error(`Kernel ${r.op} failed: ${r.error.message}`);
      }
      const mesh = reply.results[4];
      const topology = reply.results[5];
      if (!mesh.ok || !topology.ok) throw new Error('The demo part has no mesh.');
      return [demoBody(mesh.value, reply.names, topology.value)];
    },
    () => client?.terminate(),
  );
}

export function demoBody(mesh: MeshData, names: readonly string[], topology: Topology): BodyInput {
  return { id: DEMO_BODY_ID, mesh, names: fillPlaceholderNames(mesh, names), topology };
}

/** A loader for bodies that need no kernel. */
export function staticLoader(label: string, make: () => BodyInput[]): SceneLoader {
  return loaderFrom({ label, fraction: null }, async () => {
    // Yield once, so the splash can paint before a large mesh is built.
    await new Promise((resolve) => setTimeout(resolve, 0));
    return make().map((b) => ({ ...b, names: fillPlaceholderNames(b.mesh, b.names) }));
  });
}

export type SceneName = 'demo' | 'test' | 'perf';

export interface SceneChoice {
  scene: SceneName;
  triangles: number;
}

export const DEFAULT_PERF_TRIANGLES = 200_000;

export function sceneFromSearch(search: string): SceneChoice {
  const params = new URLSearchParams(search);
  const s = params.get('scene');
  const scene: SceneName = s === 'test' || s === 'perf' ? s : 'demo';
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
 * The scene named in the page URL; the kernel demo part by default, and
 * always when `testScenes` is off.
 */
export function loaderForLocation(
  search: string = window.location.search,
  spawn: (options: KernelClientOptions) => KernelClient = spawnKernelWorker,
  testScenes: boolean = testHooksEnabled,
): SceneLoader {
  const choice: SceneChoice = testScenes
    ? sceneFromSearch(search)
    : { scene: 'demo', triangles: 0 };
  if (choice.scene === 'test') return testLoader();
  if (choice.scene === 'perf') return perfLoader(choice.triangles);
  return kernelDemoLoader(spawn);
}
