// No leaks: every embind object an operation creates is deleted, every shape
// is gone after release, and repeated regens do not grow the heap. Uses an
// instrumented instance of its own (the tracker mutates the instance).

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { KernelError } from './errors';
import { applyFeature, type DeriveInput, type FeatureBody, type FeatureInput } from './features';
import { Kernel } from './kernel';
import { createNodeInstance } from './node';
import { track, type Tracker } from './track';
import type { Frame, ProfileLoop, ShapeId } from './types';

let tracker: Tracker;
let k: Kernel;

beforeAll(async () => {
  tracker = track(await createNodeInstance());
  k = new Kernel(tracker.oc);
}, 60_000);

beforeEach(() => {
  tracker.reset();
});

const XY: Frame = { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] };

const outline: ProfileLoop = {
  entities: [
    { kind: 'line', start: [0, 0], end: [20, 0] },
    { kind: 'arc', center: [20, 10], start: [20, 0], end: [20, 20] },
    { kind: 'line', start: [20, 20], end: [0, 20] },
    { kind: 'line', start: [0, 20], end: [0, 0] },
  ],
};
const hole: ProfileLoop = { entities: [{ kind: 'circle', center: [8, 10], radius: 3 }] };

/** A small feature tree: profile, extrude, cut, fillet, then every query. */
function regen(): ShapeId[] {
  const made: ShapeId[] = [];
  const keep = <T extends ShapeId>(id: T) => (made.push(id), id);
  const profile = keep(k.profile(XY, [outline, hole]));
  const body = keep(k.extrude(profile, 8).shape);
  const tool = keep(k.cylinder(2, 20, [4, 4, -5]));
  const cut = keep(k.boolean('cut', body, [tool], { simplify: true }).shape);
  const edges = k.topology(cut).edges.filter((e) => e.curve === 'line' && e.faces.length === 2);
  const filleted = keep(k.fillet(cut, [edges[0]!.index], 0.5).shape);
  k.topology(filleted);
  k.properties(filleted);
  k.mesh(filleted, { linear: 0.1, angular: 0.5 });
  return made;
}

describe('embind objects', () => {
  it('the tracker sees objects that are not deleted (control)', () => {
    const p = new tracker.oc.gp_Pnt(1, 2, 3);
    expect(tracker.live()).toBe(1);
    p.delete();
    expect(tracker.live()).toBe(0);
  });

  it('a full regen deletes every temporary; releasing its shapes deletes the rest', () => {
    const made = regen();
    expect(tracker.created()).toBeGreaterThan(1000);
    // Only the arena's shapes (and a profile's edges) are alive.
    const live = tracker.liveNames();
    expect(new Set(live)).toEqual(new Set(['TopoDS_Shape', 'TopoDS_Face', 'TopoDS_Edge']));
    for (const id of made) expect(k.release(id)).toBe(true);
    expect(tracker.liveNames()).toEqual([]);
    expect(k.shapeCount).toBe(0);
  });

  it('feature operations delete every temporary, on success and on failure', () => {
    const top: Frame = { origin: [0, 0, 8], xDir: [1, 0, 0], normal: [0, 0, 1] };
    const pin: FeatureInput = {
      kind: 'extrude',
      id: 'extrude#2',
      profile: {
        frame: top,
        loops: [{ entities: [{ kind: 'circle', id: 'c1', center: [4, 4], radius: 1 }] }],
      },
      extent: { type: 'throughAll' },
      reverse: true,
      mode: 'subtract',
    };
    const side = (id: string) => `extrude#1:side:${id}`;
    const features: FeatureInput[] = [
      {
        kind: 'extrude',
        id: 'extrude#1',
        profile: {
          frame: XY,
          loops: [
            { entities: outline.entities.map((e, i) => ({ ...e, id: `e${i + 1}` })) },
            { entities: hole.entities.map((e) => ({ ...e, id: 'h1' })) },
          ],
        },
        extent: { type: 'blind', distance: 8 },
        mode: 'new',
      },
      {
        kind: 'shell',
        id: 'shell#8',
        thickness: 1,
        faces: [{ id: 'r1', ref: { face: 'extrude#1:cap:start' } }],
      },
      pin,
      {
        kind: 'pattern',
        id: 'pattern#3',
        source: { type: 'features', features: [pin] },
        layout: { type: 'linear', direction: [0, 1, 0], count: 2, spacing: 12 },
      },
      {
        kind: 'mirror',
        id: 'mirror#4',
        source: { type: 'body' },
        plane: { origin: [-5, 0, 0], normal: [1, 0, 0] },
      },
      {
        kind: 'fillet',
        id: 'fillet#5',
        radius: 0.5,
        edges: [{ id: 'r1', ref: { faces: ['extrude#1:cap:end', side('e3')] } }],
      },
      {
        kind: 'chamfer',
        id: 'chamfer#6',
        size: { kind: 'distance-angle', distance: 0.5, angle: 0.5 },
        edges: [{ id: 'r1', ref: { faces: ['extrude#1:cap:end', side('e4')] } }],
      },
      {
        kind: 'hole',
        id: 'hole#7',
        frame: top,
        points: [{ id: 'e9', at: [14, 14] }],
        diameter: 2,
        extent: { type: 'blind', depth: 3 },
        head: { type: 'countersink', diameter: 4, angle: Math.PI / 2 },
      },
      {
        kind: 'extrude',
        id: 'extrude#11',
        profile: {
          frame: XY,
          loops: [{ entities: [{ kind: 'circle', id: 'c1', center: [40, 0], radius: 3 }] }],
        },
        extent: { type: 'symmetric', distance: 4 },
        draft: 0.05,
        mode: 'add',
      },
      {
        kind: 'revolve',
        id: 'revolve#12',
        profile: {
          frame: { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 1, 0] },
          // Clear of the body: a new solid must not overlap it.
          loops: [{ entities: [{ kind: 'circle', id: 'c1', center: [80, 0], radius: 1 }] }],
        },
        axis: { origin: [70, 0, 0], direction: [0, 0, 1] },
        angle: Math.PI,
        mode: 'new',
      },
      // Fails: the reference is gone; and OCCT refuses a huge fillet.
      {
        kind: 'fillet',
        id: 'fillet#9',
        radius: 1,
        edges: [{ id: 'r1', ref: { faces: [side('e9'), side('e1')] } }],
      },
      {
        kind: 'fillet',
        id: 'fillet#10',
        radius: 50,
        edges: [{ id: 'r1', ref: { faces: ['extrude#1:cap:start', side('e4')] } }],
      },
    ];
    const bodies = chain(features);
    expect(bodies.errors).toEqual(['fillet#9: lost', 'fillet#10: kernel']);
    // The block, its mirror image (clear of it), the detached boss and the revolved ring.
    expect(bodies.set.map((b) => b.id)).toEqual([
      'extrude#1',
      'mirror#4:image',
      'extrude#11',
      'revolve#12',
    ]);
    expect(k.shapeCount).toBe(4);
    for (const b of bodies.set) expect(k.release(b.shape)).toBe(true);
    expect(tracker.liveNames()).toEqual([]);
  });

  it('features on several bodies leave only the bodies, merged, cut or blended', () => {
    const slab = (id: string, x: number, mode: 'new' | 'add' | 'subtract'): FeatureInput => ({
      kind: 'extrude',
      id,
      profile: {
        frame: XY,
        loops: [
          {
            entities: [
              { kind: 'line', id: 'e1', start: [x, 0], end: [x + 20, 0] },
              { kind: 'line', id: 'e2', start: [x + 20, 0], end: [x + 20, 10] },
              { kind: 'line', id: 'e3', start: [x + 20, 10], end: [x, 10] },
              { kind: 'line', id: 'e4', start: [x, 10], end: [x, 0] },
            ],
          },
        ],
      },
      extent: { type: 'blind', distance: mode === 'subtract' ? 3 : 5 },
      mode,
    });
    const features: FeatureInput[] = [
      slab('extrude#1', 0, 'new'),
      slab('extrude#2', 10, 'new'),
      slab('extrude#3', 40, 'new'),
      // Cuts the two overlapping bodies, misses the third.
      slab('extrude#4', 5, 'subtract'),
      {
        kind: 'fillet',
        id: 'fillet#5',
        radius: 1,
        edges: [{ id: 'r1', ref: { faces: ['extrude#3:cap:end', 'extrude#3:side:e2'] } }],
      },
      // Spans two bodies: the feature fails and nothing leaks.
      {
        kind: 'fillet',
        id: 'fillet#6',
        radius: 1,
        edges: [{ id: 'r1', ref: { faces: ['extrude#1:cap:end', 'extrude#3:side:e2'] } }],
      },
      {
        kind: 'pattern',
        id: 'pattern#7',
        scope: ['extrude#3'],
        source: { type: 'body', mode: 'new' },
        layout: { type: 'linear', direction: [0, 1, 0], count: 3, spacing: 20 },
      },
      // Touches extrude#1 and extrude#2: merges them.
      slab('extrude#8', 15, 'add'),
    ];
    const run = chain(features);
    expect(run.errors).toEqual(['fillet#6: invalid']);
    expect(run.set.map((b) => b.id)).toEqual([
      'extrude#1',
      'extrude#3',
      'pattern#7:i2',
      'pattern#7:i3',
    ]);
    expect(k.shapeCount).toBe(4);
    for (const b of run.set) expect(k.release(b.shape)).toBe(true);
    expect(tracker.liveNames()).toEqual([]);
  });

  it('derive copies, fuses and cuts without leaking; the sources are left alone', () => {
    const block = (id: string, x: number, mode: 'new' | 'add' | 'subtract'): FeatureInput => ({
      kind: 'extrude',
      id,
      profile: {
        frame: XY,
        loops: [
          {
            entities: [
              { kind: 'line', id: 'e1', start: [x, 0], end: [x + 20, 0] },
              { kind: 'line', id: 'e2', start: [x + 20, 0], end: [x + 20, 10] },
              { kind: 'line', id: 'e3', start: [x + 20, 10], end: [x, 10] },
              { kind: 'line', id: 'e4', start: [x, 10], end: [x, 0] },
            ],
          },
        ],
      },
      extent: { type: 'blind', distance: 5 },
      mode,
    });
    // The source part, as a nested regen would build it.
    const source = chain([
      block('extrude#1', 0, 'new'),
      {
        kind: 'fillet',
        id: 'fillet#2',
        radius: 1,
        edges: [{ id: 'r1', ref: { faces: ['extrude#1:cap:end', 'extrude#1:side:e2'] } }],
      },
      block('extrude#3', 40, 'new'),
    ]);
    const derive = (
      id: string,
      mode: 'new' | 'add' | 'subtract',
      translation: [number, number, number],
    ): DeriveInput => ({
      kind: 'derive',
      id,
      sources: source.set,
      rotation: [0.3, 0, 0.5],
      translation,
      mode,
    });
    const before = tracker.liveNames().length;
    const run = chain([
      block('extrude#1', 0, 'new'),
      derive('derived#2', 'new', [0, 100, 0]),
      derive('derived#3', 'add', [5, 2, 0]),
      derive('derived#4', 'subtract', [-5, -2, 3]),
      // Fails: a scope naming no body; and a source that is gone.
      { ...derive('derived#5', 'add', [0, 0, 0]), scope: ['extrude#9'] },
      {
        kind: 'derive',
        id: 'derived#6',
        sources: [{ id: 'x', shape: 999_999 as ShapeId }],
        rotation: [0, 0, 0],
        translation: [0, 0, 0],
        mode: 'new',
      },
    ]);
    expect(run.errors).toEqual(['derived#5: lost', 'derived#6: no-body']);
    expect(run.set.map((b) => b.id)).toEqual([
      'extrude#1',
      'derived#2:from/extrude#1',
      'derived#2:from/extrude#3',
      // The add's second copy touches no body: detached, a body of its own.
      'derived#3:from/extrude#3',
    ]);
    expect(k.shapeCount).toBe(source.set.length + run.set.length);
    for (const b of run.set) expect(k.release(b.shape)).toBe(true);
    // Only the sources' shapes are left, exactly as many objects as before the part.
    expect(tracker.liveNames().length).toBe(before);
    for (const b of source.set) expect(k.release(b.shape)).toBe(true);
    expect(tracker.liveNames()).toEqual([]);
  });

  /** Apply features as regen would, releasing every shape a feature replaced. */
  function chain(features: readonly FeatureInput[]): { set: FeatureBody[]; errors: string[] } {
    let set: FeatureBody[] = [];
    const errors: string[] = [];
    for (const f of features) {
      const out = applyFeature(k, set, f);
      errors.push(...out.errors.map((e) => `${e.featureId}: ${e.code}`));
      const live = new Set(out.bodies.map((b) => b.shape));
      for (const b of set) if (!live.has(b.shape)) k.release(b.shape);
      set = out.bodies.map((b) => ({ id: b.id, shape: b.shape }));
    }
    return { set, errors };
  }

  it('each operation on its own leaves only its result', () => {
    const box = k.box(10, 10, 10);
    const ops: Array<[string, () => unknown]> = [
      ['topology', () => k.topology(box)],
      ['properties', () => k.properties(box)],
      ['mesh', () => k.mesh(box)],
      ['count', () => k.count(box, 'edge')],
      [
        'measure',
        () =>
          k.measure(
            box,
            [
              { kind: 'face', index: 1 },
              { kind: 'edge', index: 5 },
              { kind: 'vertex', index: 2 },
            ],
            { body: true },
          ),
      ],
      [
        'measure a distance and an angle',
        () =>
          k.measure(box, [
            { kind: 'face', index: 1 },
            { kind: 'face', index: 2 },
          ]),
      ],
    ];
    for (const [name, fn] of ops) {
      tracker.reset();
      fn();
      expect(tracker.liveNames(), name).toEqual([]);
    }
    k.release(box);
  });

  it('failures delete everything too: argument errors, OCCT exceptions, builder failures', () => {
    const box = k.box(10, 10, 10);
    const cyl = k.cylinder(5, 10);
    const seam = k.topology(cyl).edges.find((e) => e.seam)!.index;
    tracker.reset();
    const failing: Array<[string, () => unknown]> = [
      ['OCCT exception in a constructor', () => k.box(1e-12, 1, 1)],
      ['OCCT exception mid-operation', () => k.fillet(cyl, [seam], 1)],
      ['builder not done', () => k.fillet(box, [1], 50)],
      ['OCCT exception while meshing', () => k.mesh(box, { linear: 1e-300, angular: 0.5 })],
      [
        'bad profile',
        () => k.profile(XY, [{ entities: [{ kind: 'line', start: [0, 0], end: [1, 0] }] }]),
      ],
      [
        'profile edge OCCT refuses, after other edges were built',
        () =>
          // A line shorter than OCCT's vertex tolerance passes our checks but
          // makes no edge; loop 0's edges exist by then and must be freed.
          k.profile(XY, [
            outline,
            {
              entities: [
                { kind: 'line', start: [5, 5], end: [6, 5] },
                { kind: 'line', start: [6, 5], end: [6, 5 + 1e-9] },
                { kind: 'line', start: [6, 5 + 1e-9], end: [5, 5] },
              ],
            },
          ]),
      ],
      ['unknown tool', () => k.boolean('cut', box, [999_999 as ShapeId])],
    ];
    const count = k.shapeCount;
    for (const [name, fn] of failing) {
      expect(fn, name).toThrow(KernelError);
      expect(tracker.liveNames(), name).toEqual([]);
    }
    expect(k.shapeCount).toBe(count);
    k.release(box);
    k.release(cyl);
    expect(tracker.liveNames()).toEqual([]);
  });

  it('releaseSince frees a whole regen', () => {
    const mark = k.checkpoint();
    regen();
    expect(k.releaseSince(mark)).toBe(5);
    expect(tracker.liveNames()).toEqual([]);
  });
});

describe('heap', () => {
  it('repeated regens with release do not grow the wasm heap', () => {
    // T0.2: with release-before-delete, a regen of this size leaks well under
    // a MiB, so thirty of them fit in the initial 128 MiB heap.
    for (const id of regen()) k.release(id);
    const before = k.heapBytes();
    for (let i = 0; i < 30; i++) for (const id of regen()) k.release(id);
    expect(k.shapeCount).toBe(0);
    expect(k.heapBytes()).toBe(before);
  }, 60_000);
});
