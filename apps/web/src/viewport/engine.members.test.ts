import type { InstancedMesh, LineSegments, Plane, Scene } from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { featureItem, createSelectionStore } from '../state/selection';
import { createViewSettingsStore } from '../state/viewSettings';
import { shedFixture } from './memberFixtures';
import { memberColor, memberPickId, memberRef, type MemberView } from './members';
import { encodePickId } from './picking';

// As engine.test.ts: jsdom has no WebGL, and the scene graph is plain JavaScript. The stub
// renderer leaves the pick buffer as the test fills it, which stands in for the GPU pick pass.
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

interface Internals {
  scene: Scene;
  pickScene: Scene;
  pickPixels: Uint8Array;
  pickSize: number;
  clipPlanes: Plane[];
  bodies: { hidden: boolean; meshes: { visible: boolean }[]; edges: { visible: boolean } }[];
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
  return { engine, internals: engine as unknown as Internals, selection, settings };
}

const instanced = (scene: Scene) =>
  scene.children.filter((o): o is InstancedMesh => (o as InstancedMesh).isInstancedMesh === true);
const lines = (scene: Scene) =>
  scene.children.filter(
    (o): o is LineSegments => (o as LineSegments).isLineSegments === true && o.renderOrder === 4,
  );

/** Fill the pick buffer as if the pick pass drew `id` under the cursor (and around it). */
function paintPick(internals: Internals, id: number) {
  const [r, g, b] = encodePickId(id);
  for (let p = 0; p < internals.pickSize ** 2; p++) internals.pickPixels.set([r, g, b, 255], p * 4);
}

describe('ViewportEngine members', () => {
  let engine: InstanceType<typeof ViewportEngine> | null = null;
  afterEach(() => engine?.dispose());

  it('draws one instanced mesh per shape, and one edge object per group', () => {
    const t = makeEngine();
    engine = t.engine;
    const shed = shedFixture();
    t.engine.setMembers(shed.view);
    const shapes = shed.view.meshes.size;
    const count = shed.view.sets.reduce((n, s) => n + s.members.length, 0);
    expect(instanced(t.internals.scene)).toHaveLength(shapes);
    expect(instanced(t.internals.pickScene)).toHaveLength(shapes);
    expect(instanced(t.internals.scene).reduce((n, m) => n + m.count, 0)).toBe(count);
    expect(lines(t.internals.scene)).toHaveLength(shed.view.sets.length);
    const info = t.engine.memberInfo();
    expect(info).toMatchObject({ sets: 4, members: count, shapes, visible: true });
    // Each instance's pick id is in the member range, consecutive within a batch.
    const at = instanced(t.internals.pickScene).findIndex((m) => m.count > 3);
    const pick = instanced(t.internals.pickScene)[at]!;
    const ids = [...(pick.geometry.getAttribute('pickId').array as Float32Array)];
    expect(ids.every((id) => id >= memberPickId(0))).toBe(true);
    expect(ids.slice(1).every((id, i) => id === ids[i]! + 1)).toBe(true);
    // The pick mesh shares the on-screen mesh's matrices.
    expect(pick.instanceMatrix).toBe(instanced(t.internals.scene)[at]!.instanceMatrix);
  });

  it('applies updates incrementally: unchanged batches and groups keep their objects', () => {
    const t = makeEngine();
    engine = t.engine;
    const shed = shedFixture();
    t.engine.setMembers(shed.view);
    const before = instanced(t.internals.scene);
    const edgesBefore = lines(t.internals.scene);
    // A regen that drops the east wall (its set) and every shape only it used.
    const sets = shed.view.sets.filter((s) => s.group !== 'wall-e');
    const used = new Set(sets.flatMap((s) => s.instances.map((l) => l.shape)));
    const meshes = new Map([...shed.view.meshes].filter(([k]) => used.has(k)));
    const next: MemberView = { meshes, sets };
    t.engine.setMembers(next);
    const after = instanced(t.internals.scene);
    expect(after).toHaveLength(meshes.size);
    // Batches the east wall never touched are the same objects.
    const eastShapes = new Set(
      shed.view.sets.find((s) => s.group === 'wall-e')!.instances.map((l) => l.shape),
    );
    const untouched = before.filter((m) =>
      [...shed.view.meshes].some(
        ([k, mesh]) =>
          !eastShapes.has(k) && m.geometry.getAttribute('position').array === mesh.positions,
      ),
    );
    expect(untouched.length).toBeGreaterThan(0);
    for (const m of untouched) expect(after).toContain(m);
    // Three of the four groups keep their edges.
    expect(lines(t.internals.scene).filter((l) => edgesBefore.includes(l))).toHaveLength(3);
    // The same view again changes nothing.
    t.engine.setMembers(next);
    expect(instanced(t.internals.scene)).toEqual(after);
    // No members: nothing left in either scene.
    t.engine.setMembers({ meshes: new Map(), sets: [] });
    expect(instanced(t.internals.scene)).toHaveLength(0);
    expect(instanced(t.internals.pickScene)).toHaveLength(0);
    expect(lines(t.internals.scene)).toHaveLength(0);
  });

  it('rebuilds only the batch of a kept shape a set grows on, and frees the old one', () => {
    const t = makeEngine();
    engine = t.engine;
    const shed = shedFixture();
    t.engine.setMembers(shed.view);
    // The south wall gains one more of its first shape: the meshes are the same map.
    const set = shed.view.sets.find((s) => s.group === 'wall-s')!;
    const list = set.instances[0]!;
    const matrices = new Float32Array(list.matrices.length + 16);
    matrices.set(list.matrices);
    matrices.set(list.matrices.subarray(0, 16), list.matrices.length);
    matrices[list.matrices.length + 12] = matrices[12]! + 400;
    const grown = {
      ...list,
      ids: [...list.ids, 'wall-s:extra'],
      roles: [...list.roles, list.roles[0]!],
      matrices,
    };
    const sets = shed.view.sets.map((s) =>
      s === set ? { ...s, instances: [grown, ...s.instances.slice(1)] } : s,
    );
    const mesh = shed.view.meshes.get(list.shape)!;
    const ofShape = (scene: Scene) =>
      instanced(scene).filter((m) => m.geometry.getAttribute('position').array === mesh.positions);
    const [oldShaded] = ofShape(t.internals.scene);
    const [oldPick] = ofShape(t.internals.pickScene);
    const others = instanced(t.internals.scene).filter((m) => m !== oldShaded);
    const pickDisposed = vi.fn();
    const liveDisposed = vi.fn();
    oldPick!.addEventListener('dispose', pickDisposed);
    oldShaded!.geometry.addEventListener('dispose', liveDisposed);

    t.engine.setMembers({ meshes: shed.view.meshes, sets });
    const [shaded] = ofShape(t.internals.scene);
    const [pick] = ofShape(t.internals.pickScene);
    expect(shaded).not.toBe(oldShaded);
    expect(shaded!.count).toBe(oldShaded!.count + 1);
    expect(pick!.count).toBe(shaded!.count);
    // The kept shape keeps its geometry; every other batch keeps its objects.
    expect(shaded!.geometry).toBe(oldShaded!.geometry);
    expect(liveDisposed).not.toHaveBeenCalled();
    for (const m of others) expect(instanced(t.internals.scene)).toContain(m);
    // The replaced batch's pick mesh is gone and disposed.
    expect(t.internals.pickScene.children).not.toContain(oldPick);
    expect(pickDisposed).toHaveBeenCalledTimes(1);
    // The pick geometry has attribute objects of its own over the shape's arrays.
    expect(pick!.geometry.getAttribute('position')).not.toBe(
      shaded!.geometry.getAttribute('position'),
    );
    expect(pick!.geometry.getIndex()).not.toBe(shaded!.geometry.getIndex());
    expect(pick!.geometry.getIndex()!.array).toBe(mesh.indices);
    // The new member is pickable by its own id.
    expect(t.engine.memberInfo().members).toBe(
      shed.view.sets.reduce((n, s) => n + s.members.length, 0) + 1,
    );
    const ids = pick!.geometry.getAttribute('pickId').array as Float32Array;
    paintPick(t.internals, ids[ids.length - 1]!);
    expect(t.engine.pickAt(400, 300)).toEqual(memberRef('wall-s:extra'));
  });

  it('picks a member as a whole by its instance id, and highlights it', () => {
    const t = makeEngine();
    engine = t.engine;
    const shed = shedFixture();
    t.engine.setMembers(shed.view);
    const stud = 'wall-s:s1';
    // Find the stud's pick id: try ids until the engine names it.
    let id = 0;
    for (let s = 0; s < 200 && id === 0; s++) {
      paintPick(t.internals, memberPickId(s));
      if (t.engine.pickAt(400, 300)?.id === stud) id = memberPickId(s);
    }
    expect(id).not.toBe(0);
    paintPick(t.internals, id);
    expect(t.engine.pickAt(400, 300)).toEqual(memberRef(stud));
    expect(t.engine.memberAt(400, 300)).toEqual(memberRef(stud));

    // Selected: drawn in the selection colour; others keep their role colour.
    t.selection.getState().click(memberRef(stud), 'replace');
    const selected = t.engine.memberColor(stud)!;
    expect(selected).not.toBe(memberColor('stud'));
    expect(t.engine.memberColor('wall-s:s2')).toBe(memberColor('stud'));
    // A feature hovered in the tree lights up every member it owns.
    t.selection.getState().setHovered(featureItem('door-1'));
    expect(t.engine.memberColor('door-1:king-l')).not.toBe(memberColor('king'));
    expect(t.engine.memberColor(stud)).toBe(selected);
    t.selection.getState().setHovered(null);
    expect(t.engine.memberColor('door-1:king-l')).toBe(memberColor('king'));

    // The selection filter can switch members off; the background picks nothing.
    t.selection.getState().setKindEnabled('member', false);
    expect(t.engine.pickAt(400, 300)).toBeNull();
    t.selection.getState().setKindEnabled('member', true);
    paintPick(t.internals, 0);
    expect(t.engine.pickAt(400, 300)).toBeNull();

    // A member a regen drops leaves the selection.
    t.engine.setMembers({ meshes: new Map(), sets: [] });
    expect(t.selection.getState().selected).toEqual([]);
  });

  it('hides wall layer bodies by layer, and members on request', () => {
    const t = makeEngine();
    engine = t.engine;
    const shed = shedFixture();
    t.engine.setBodies(shed.bodies);
    t.engine.setMembers(shed.view);
    expect(t.internals.bodies.every((b) => !b.hidden)).toBe(true);
    t.engine.setHiddenLayers(['sheathing']);
    expect(t.internals.bodies.every((b) => b.hidden)).toBe(true);
    expect(t.internals.bodies[0]!.meshes[2]!.visible).toBe(false);
    expect(t.internals.bodies[0]!.edges.visible).toBe(false);
    expect(t.engine.memberInfo().hiddenLayers).toEqual(['sheathing']);
    // New bodies of a hidden layer come hidden.
    t.engine.setBodies(shed.bodies);
    expect(t.internals.bodies[0]!.hidden).toBe(true);
    t.engine.setHiddenLayers([]);
    expect(t.internals.bodies[0]!.meshes[2]!.visible).toBe(true);
    expect(t.internals.bodies[0]!.edges.visible).toBe(true);

    t.engine.setMembersVisible(false);
    expect(instanced(t.internals.scene).every((m) => !m.visible)).toBe(true);
    expect(instanced(t.internals.pickScene).every((m) => !m.visible)).toBe(true);
    expect(t.engine.memberInfo().drawCalls).toBe(0);
    t.engine.setMembersVisible(true);
    expect(instanced(t.internals.scene).every((m) => m.visible)).toBe(true);
  });

  it('clips bodies and members with a level cut, with or without the section', () => {
    const t = makeEngine();
    engine = t.engine;
    const shed = shedFixture();
    t.engine.setBodies(shed.bodies);
    t.engine.setMembers(shed.view);
    expect(t.internals.clipPlanes).toHaveLength(0);
    t.engine.setLevelCut({ elevation: 0 });
    expect(t.internals.clipPlanes).toHaveLength(1);
    expect(
      t.internals.clipPlanes[0]!.distanceToPoint({ x: 0, y: 0, z: 1300 } as never),
    ).toBeLessThan(0);
    t.engine.setLevelCut({ elevation: 2500, below: 0, cutHeight: 1219.2 });
    expect(t.internals.clipPlanes).toHaveLength(2);
    t.settings.getState().setSection({ enabled: true });
    expect(t.internals.clipPlanes).toHaveLength(3);
    expect(t.engine.memberInfo().levelCut).toEqual({
      elevation: 2500,
      below: 0,
      cutHeight: 1219.2,
    });
    t.engine.setLevelCut(null);
    expect(t.internals.clipPlanes).toHaveLength(1);
  });

  it('turns member edges off when the stock is too thin on screen (the LOD rule)', () => {
    const t = makeEngine();
    engine = t.engine;
    const shed = shedFixture();
    t.engine.setMembers(shed.view);
    // Fitted, the shed's 2x4s span a few pixels at 600 px high: edges on.
    t.internals.frame(1000);
    expect(t.engine.memberInfo().edgesShown).toBe(4);
    t.engine.frameBox({ min: [-1e5, -1e5, 0], max: [1e5, 1e5, 1e5] }, false);
    t.internals.frame(1016);
    expect(t.engine.memberInfo().edgesShown).toBe(0);
    t.settings.getState().setShowEdges(false);
    t.engine.frameBox({ min: [0, 0, 0], max: [500, 500, 500] }, false);
    t.internals.frame(1032);
    expect(t.engine.memberInfo().edgesShown).toBe(0);
  });
});
