import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSelectionStore } from '../state/selection';
import { createViewSettingsStore } from '../state/viewSettings';
import { boxBody } from './testMeshes';

// jsdom has no WebGL. The engine's scene graph is plain JavaScript, so a
// renderer that draws nothing is enough to test what the engine decides.
vi.mock('three', async (importOriginal) => {
  const three = await importOriginal<typeof import('three')>();
  class StubRenderer {
    localClippingEnabled = false;
    autoClear = true;
    constructor() {
      return new Proxy(this, {
        get: (target, key) => (key in target ? target[key as keyof StubRenderer] : () => undefined),
      });
    }
  }
  return { ...three, WebGLRenderer: StubRenderer };
});

const { ViewportEngine } = await import('./engine');
type Engine = InstanceType<typeof ViewportEngine>;

/** The engine's private state the tests look at. */
interface Internals {
  bodies: { edges: { visible: boolean } }[];
  raycaster: { intersectObjects: (...args: unknown[]) => unknown[] };
  frame: (now: number) => void;
}

let frames: FrameRequestCallback[] = [];

beforeEach(() => {
  frames = [];
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb));
  vi.stubGlobal('cancelAnimationFrame', () => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function makeEngine() {
  const canvas = document.createElement('canvas');
  Object.defineProperty(canvas, 'clientWidth', { value: 800 });
  Object.defineProperty(canvas, 'clientHeight', { value: 600 });
  document.body.append(canvas);
  const selection = createSelectionStore();
  const settings = createViewSettingsStore();
  const engine = new ViewportEngine(canvas, { selection, settings });
  const internals = engine as unknown as Internals;
  return { engine, internals, canvas, settings };
}

/** Run the animation frames queued so far. */
function runFrames(now = 1000) {
  const queued = frames;
  frames = [];
  for (const cb of queued) cb(now);
}

describe('ViewportEngine', () => {
  let engine: Engine | null = null;
  afterEach(() => engine?.dispose());

  it('applies Show edges to the edges of bodies set after it was switched off', () => {
    const t = makeEngine();
    engine = t.engine;
    t.engine.setBodies([boxBody()]);
    expect(t.internals.bodies[0]!.edges.visible).toBe(true);

    t.settings.getState().setShowEdges(false);
    expect(t.internals.bodies[0]!.edges.visible).toBe(false);
    // A new mesh (after a regeneration) must not bring the edges back.
    t.engine.setBodies([boxBody()]);
    expect(t.internals.bodies[0]!.edges.visible).toBe(false);

    t.settings.getState().setShowEdges(true);
    expect(t.internals.bodies[0]!.edges.visible).toBe(true);
  });

  it('raycasts for the wheel zoom pivot at most once per frame', () => {
    const t = makeEngine();
    engine = t.engine;
    t.engine.setBodies([boxBody({ min: [-20, -15, 0], size: [40, 30, 20] })]);
    runFrames();
    const raycast = vi.spyOn(t.internals.raycaster, 'intersectObjects');
    const before = t.engine.info().halfHeight;
    for (let i = 0; i < 5; i++) {
      t.canvas.dispatchEvent(
        new WheelEvent('wheel', { deltaY: -40, clientX: 400, clientY: 300, cancelable: true }),
      );
    }
    expect(raycast).not.toHaveBeenCalled();
    expect(t.engine.info().animating).toBe(true);
    runFrames(1016);
    expect(raycast).toHaveBeenCalledTimes(1);
    expect(t.engine.info().halfHeight).toBeLessThan(before);
    expect(t.engine.info().animating).toBe(false);

    // The five events zoom as far together as one event of five times the size.
    const single = makeEngine();
    const other = single.engine;
    try {
      other.setBodies([boxBody({ min: [-20, -15, 0], size: [40, 30, 20] })]);
      runFrames();
      single.canvas.dispatchEvent(
        new WheelEvent('wheel', { deltaY: -200, clientX: 400, clientY: 300, cancelable: true }),
      );
      runFrames(1016);
      expect(other.info().halfHeight).toBeCloseTo(t.engine.info().halfHeight, 6);
    } finally {
      other.dispose();
    }
  });
});
