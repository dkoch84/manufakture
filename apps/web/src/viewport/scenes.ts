// What the app starts with. By default the kernel worker (with the regen engine) and an empty
// document: every body the viewport shows is regenerated from the document (model/model.ts).
// Three test scenes are only honoured where the test hooks are on (see testHooks.ts):
// `?scene=demo` opens the demo part as a document (model/demo.ts), and two kernel-free scenes
// serve tests: `?scene=test` (a named box, for the e2e pick check) and `?scene=perf&triangles=N`
// (a dense sphere, for frame time measurements). `?scene=framing&fixture=shed|house` shows a
// framing fixture's layer bodies and members (memberFixtures.ts), with no kernel.

import type { ManufaktureDocument } from '@manufakture/core';
import type { LoadProgress } from '@manufakture/kernel';
import type { ScriptDeclarationsReply, ScriptStats } from '@manufakture/regen';
import type { RegenClient, RegenClientOptions } from '@manufakture/regen/client';
import type { Assembler } from '../assembly/assembly';
import type { CamGeometer } from '../cam/geometer';
import type { Drawer } from '../drawing/drawer';
import { kernelExchange, type Exchanger, type KernelBody, type Referencer } from '../io/exchange';
import type { IfcExporter } from '../io/ifcExport';
import type { Measurer } from '../measure/measurer';
import { kernelRegenerator } from '../model/kernelModel';
import { buildable, type Regenerator } from '../model/model';
import { scriptGrantsStore, type ScriptGrantsStore } from '../scripts/policy';
import type { Texter } from '../sketcher/text';
import type { Sizer } from '../wood/cutlist/sizer';
import { testHooksEnabled } from '../testHooks';
import type { BodyInput } from './bodies';
import type { MemberFixtureName } from './memberFixtures';
import { memberStore } from './memberStore';
import { fillPlaceholderNames } from './naming';
import { spawnAppRegenWorker } from './regen-spawn';
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
  /** Text layout and font reading for the sketcher, in the regen worker; absent for kernel-free scenes. */
  texter?: Texter;
  /** Oriented box sizes for the cut list, in the regen worker; absent for kernel-free scenes. */
  sizer?: Sizer;
  /** Drawing views, dimensions and sheets in the regen worker; absent for kernel-free scenes. */
  drawer?: Drawer;
  /** The CAM geometry of a setup, in the regen worker; absent for kernel-free scenes. */
  camGeometer?: CamGeometer;
  /** IFC export of a building, in the regen worker (T6.6a); absent for kernel-free scenes. */
  ifcExporter?: IfcExporter;
  /** Scripts' declarations and run counts, in the regen worker; absent for kernel-free scenes. */
  scripter?: Scripter;
  /**
   * A document the scene opens with (the demo scene); the app loads it once the scene is loaded.
   * Its presence says at once that the scene brings a document (so the app opens none from the
   * library); the document itself may come later, as the demo's module loads on demand.
   */
  initialDocument?: Promise<ManufaktureDocument>;
}

/** What the app asks of the regen worker's script host (T7.2d). */
export interface Scripter {
  /**
   * A script's parameter declarations, for the scripted feature's dialog; the worker reads them
   * only when the policy lets this script of `documentId` run.
   */
  declarations(
    script: { id: string; source: string; language: 'js' | 'ts'; apiVersion: number },
    documentId: string,
  ): Promise<ScriptDeclarationsReply | null>;
  /** How many declaration reads and runs the worker made (for tests and the stats page). */
  stats(): Promise<ScriptStats | null>;
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
  spawn: (options: RegenClientOptions) => RegenClient,
  options: {
    initialDocument?: Promise<ManufaktureDocument>;
    scriptGrants?: ScriptGrantsStore;
  } = {},
): SceneLoader {
  let client: RegenClient | null = null;
  // Which scripts may run (scripts/policy.ts): sent to the worker before its first regen and on
  // every change; the app regenerates after a change.
  const grants = options.scriptGrants ?? scriptGrantsStore;
  let unwatchGrants: (() => void) | null = null;
  // Viewport body id to kernel shape: the part bodies from regen, then imported STEP bodies.
  const registry = new Map<string, KernelBody>();
  const { exchanger, measurer, referencer } = kernelExchange(() => client, registry);
  const regenerator = kernelRegenerator(() => client, registry, memberStore);
  const assembler: Assembler = {
    // Built as a regen builds it: in the active configuration row, rows of instances from the
    // stored document.
    solve: (document, assemblyId) => {
      if (client === null) return Promise.resolve(null);
      const built = buildable(document).document;
      return built === document
        ? client.solveAssembly(document, assemblyId)
        : client.solveAssembly(built, assemblyId, document);
    },
    drag: (assemblyId, instanceId, target) =>
      client === null ? Promise.resolve(null) : client.dragInstance(assemblyId, instanceId, target),
    endDrag: (assemblyId) => void client?.endDrag(assemblyId).catch(() => undefined),
    interference: (assemblyId, onPair) =>
      client === null
        ? Promise.resolve(null)
        : client.interference(assemblyId, { mesh: true, onPair }),
    cancelInterference: (assemblyId) =>
      void client?.cancelInterference(assemblyId).catch(() => undefined),
  };
  // Drawings are built as a regen builds the document: in its active configuration row.
  const drawer: Drawer = {
    sheet: (document, drawingId, sheetId, options = {}) => {
      if (client === null) return Promise.resolve(null);
      const built = buildable(document).document;
      return built === document
        ? client.drawingSheet(document, drawingId, sheetId, options)
        : client.drawingSheet(built, drawingId, sheetId, { ...options, stored: document });
    },
  };
  // CAM geometry is built as a regen builds the document: in its active configuration row.
  const camGeometer: CamGeometer = {
    geometry: (document, setupId, options = {}) => {
      if (client === null) return Promise.resolve(null);
      const built = buildable(document).document;
      return built === document
        ? client.camGeometry(document, setupId, options)
        : client.camGeometry(built, setupId, { ...options, stored: document });
    },
  };
  // Texts and fonts go to the regen worker's text worker (under its watchdog); they need no kernel.
  const texter: Texter = {
    outline: (request, options) =>
      client === null ? Promise.resolve(null) : client.outlineText(request, options),
    readFont: (fileName, bytes) =>
      client === null ? Promise.resolve(null) : client.readFont(fileName, bytes),
  };
  // Sizes of bodies that are not boards, for the cut list: built as a regen builds them.
  const sizer: Sizer = {
    orientedSizes: (document, partId, options) => {
      if (client === null) return Promise.resolve(null);
      const built = buildable(document).document;
      return client.orientedSizes(
        built,
        partId,
        built === document ? options : { ...options, stored: document },
      );
    },
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
        // Given at spawn, so the worker has it before anything else (and it fails closed anyway).
        scriptPolicy: grants.getState().policy(),
      });
      client = c;
      unwatchGrants = grants.subscribe((now, before) => {
        if (now.revision === before.revision) return;
        void client
          ?.setScriptPolicy(now.policy())
          .catch((e: unknown) => console.error('The regen worker refused the script policy:', e));
      });
      await c.ready;
      return [];
    },
    () => {
      unwatchGrants?.();
      client?.terminate();
    },
  );
  const scripter: Scripter = {
    declarations: (script, documentId) =>
      client === null ? Promise.resolve(null) : client.scriptDeclarations(script, documentId),
    stats: () => (client === null ? Promise.resolve(null) : client.scriptStats()),
  };
  return {
    ...loader,
    regenerator,
    measurer,
    exchanger,
    referencer,
    assembler,
    texter,
    drawer,
    sizer,
    camGeometer,
    scripter,
    ifcExporter: {
      async exportIfc(building) {
        const bytes = client === null ? null : await client.exportIfc(building);
        if (bytes === null) throw new Error('the geometry worker is not running');
        return bytes;
      },
    },
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

export type SceneName = 'default' | 'demo' | 'test' | 'perf' | 'framing';

export interface SceneChoice {
  scene: SceneName;
  triangles: number;
  /** The framing scene's fixture. */
  fixture?: MemberFixtureName;
}

export const DEFAULT_PERF_TRIANGLES = 200_000;

export function sceneFromSearch(search: string): SceneChoice {
  const params = new URLSearchParams(search);
  const s = params.get('scene');
  const scene: SceneName =
    s === 'test' || s === 'perf' || s === 'demo' || s === 'framing' ? s : 'default';
  const t = Number(params.get('triangles'));
  const triangles =
    Number.isFinite(t) && t > 0 ? Math.min(Math.floor(t), 5_000_000) : DEFAULT_PERF_TRIANGLES;
  if (scene !== 'framing') return { scene, triangles };
  return { scene, triangles, fixture: params.get('fixture') === 'house' ? 'house' : 'shed' };
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
 * A framing fixture: its layer bodies as the scene's bodies, its members loaded into the member
 * store for the viewport (the fixture code loads on demand, so it stays out of the main chunk).
 */
export function framingLoader(fixture: MemberFixtureName, members = memberStore): SceneLoader {
  return loaderFrom({ label: `Framing the ${fixture}`, fraction: null }, async () => {
    const { memberFixture } = await import('./memberFixtures');
    const f = memberFixture(fixture);
    members.getState().load(f.partId, f.view);
    return f.bodies.map((b) => ({ ...b, names: fillPlaceholderNames(b.mesh, b.names) }));
  });
}

/**
 * The scene named in the page URL; the kernel with an empty document by default, and always
 * when `testScenes` is off.
 */
export function loaderForLocation(
  search: string = window.location.search,
  spawn: (options: RegenClientOptions) => RegenClient = spawnAppRegenWorker,
  testScenes: boolean = testHooksEnabled,
): SceneLoader {
  const choice: SceneChoice = testScenes
    ? sceneFromSearch(search)
    : { scene: 'default', triangles: 0 };
  if (choice.scene === 'test') return testLoader();
  if (choice.scene === 'perf') return perfLoader(choice.triangles);
  if (choice.scene === 'framing') return framingLoader(choice.fixture ?? 'shed');
  if (choice.scene === 'demo') {
    // On demand, so the demo (test tooling) stays out of the production bundle's main chunk. It
    // starts loading now, beside the kernel, and is long there when the kernel is ready.
    const initialDocument = import('../model/demo').then((m) => m.demoDocument());
    return kernelLoader(spawn, { initialDocument });
  }
  return kernelLoader(spawn);
}
