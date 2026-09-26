// No leaks: every embind object an operation creates is deleted, every shape
// is gone after release, and repeated regens do not grow the heap. Uses an
// instrumented instance of its own (the tracker mutates the instance).

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { KernelError } from './errors';
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

  it('each operation on its own leaves only its result', () => {
    const box = k.box(10, 10, 10);
    const ops: Array<[string, () => unknown]> = [
      ['topology', () => k.topology(box)],
      ['properties', () => k.properties(box)],
      ['mesh', () => k.mesh(box)],
      ['count', () => k.count(box, 'edge')],
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
