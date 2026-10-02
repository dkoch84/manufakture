// Golden tests for the oriented bounding box (M4 plan, T4.3b): boxes axis-aligned, turned about z
// and about an oblique axis, a cylinder on an oblique axis, and a board with a dado (still the
// blank's size), against sizes, axes and centres computed by hand. Plus the normalisation rules
// on their own, the axis-aligned fallback, and the `obb` op through the service.

import { beforeAll, describe, expect, it } from 'vitest';
import { KernelError } from '../src/errors';
import type { Kernel } from '../src/kernel';
import { createNodeKernel, createNodeService } from '../src/node';
import { normaliseBox, orientedBoxOf, type OrientedBox } from '../src/obb';
import { withScope } from '../src/occt';
import type { Axis, ShapeId, Vec3 } from '../src/types';

let k: Kernel;

beforeAll(async () => {
  k = await createNodeKernel();
}, 60_000);

const DEG = Math.PI / 180;
/** Sizes, centres and axes are exact to this (mm, or unit-vector components). */
const TOL = 1e-6;

function near(actual: number, expected: number, tol = TOL): void {
  expect(Math.abs(actual - expected), `${actual} vs ${expected}`).toBeLessThanOrEqual(tol);
}

function nearVec(actual: Vec3, expected: Vec3, tol = TOL): void {
  expected.forEach((c, i) => near(actual[i]!, c, tol));
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const crossV = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

/** Rodrigues: `v` turned by `angle` about the unit axis `u` through the origin. */
function rotate(v: Vec3, u: Vec3, angle: number): Vec3 {
  const c = Math.cos(angle);
  const sn = Math.sin(angle);
  const k = crossV(u, v);
  const d = dot(u, v) * (1 - c);
  return [
    v[0] * c + k[0] * sn + u[0] * d,
    v[1] * c + k[1] * sn + u[1] * d,
    v[2] * c + k[2] * sn + u[2] * d,
  ];
}

function unit(v: Vec3): Vec3 {
  const n = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / n, v[1] / n, v[2] / n];
}

/** Every invariant of a normalised box: unit, orthogonal, right-handed, sorted, signed. */
function expectNormalised(box: OrientedBox): void {
  for (const a of box.axes) near(Math.hypot(a[0], a[1], a[2]), 1, 1e-12);
  near(dot(box.axes[0], box.axes[1]), 0, 1e-12);
  nearVec(crossV(box.axes[0], box.axes[1]), box.axes[2], 1e-12);
  expect(box.sizes[0]).toBeGreaterThanOrEqual(box.sizes[1]);
  expect(box.sizes[1]).toBeGreaterThanOrEqual(box.sizes[2]);
  box.sizes.forEach((size, i) => expect(size).toBe(2 * box.halfSizes[i]!));
  for (const a of box.axes.slice(0, 2)) {
    const largest = a.reduce((m, c) => (Math.abs(c) > Math.abs(m) + 1e-9 ? c : m), 0);
    expect(largest, `axis ${a.join(',')}`).toBeGreaterThan(0);
  }
}

/** `actual` and `expected` are the same line (either direction). */
function parallel(actual: Vec3, expected: Vec3): void {
  near(Math.abs(dot(actual, unit(expected))), 1);
}

function turned(shape: ShapeId, axis: Axis, angle: number): ShapeId {
  return k.transform(shape, { kind: 'rotate', axis, angle }).shape;
}

describe('an axis-aligned box', () => {
  it('gives its own sizes and the world axes, longest first', () => {
    const box = k.box(40, 100, 10, [5, 6, 7]);
    const r = k.orientedBox(box);
    expectNormalised(r);
    nearVec(r.sizes, [100, 40, 10]);
    nearVec(r.halfSizes, [50, 20, 5]);
    nearVec(r.center, [25, 56, 12]);
    expect(r.axes).toEqual([
      [0, 1, 0],
      [1, 0, 0],
      [0, 0, -1],
    ]);
    k.release(box);
  });

  it('orders a square section by its axes: nearest world x first', () => {
    const bar = k.box(20, 20, 300);
    const r = k.orientedBox(bar);
    nearVec(r.sizes, [300, 20, 20]);
    expect(r.axes).toEqual([
      [0, 0, 1],
      [1, 0, 0],
      [0, 1, 0],
    ]);
    k.release(bar);
  });
});

describe('a 100 x 40 x 10 box turned 30 degrees about z', () => {
  let box: ShapeId;
  let rotated: ShapeId;
  beforeAll(() => {
    box = k.box(100, 40, 10);
    rotated = turned(box, { origin: [0, 0, 0], direction: [0, 0, 1] }, 30 * DEG);
  });

  it('gives its exact sizes, turned axes and centre', () => {
    const r = k.orientedBox(rotated);
    expectNormalised(r);
    expect(r.source).toBe('obb');
    nearVec(r.sizes, [100, 40, 10]);
    const c = Math.cos(30 * DEG);
    const sn = Math.sin(30 * DEG);
    nearVec(r.axes[0], [c, sn, 0]);
    nearVec(r.axes[1], [-sn, c, 0]);
    nearVec(r.axes[2], [0, 0, 1]);
    nearVec(r.center, [50 * c - 20 * sn, 50 * sn + 20 * c, 5]);
    // The axis-aligned box of the same body is much bigger.
    const aabb = k.measure(rotated, [], { body: true }).body!.boundingBox!;
    near(aabb.max[0] - aabb.min[0], 100 * c + 40 * sn);
  });

  it('gives the same sizes without the optimal mode', () => {
    const r = k.orientedBox(rotated, { optimal: false });
    expectNormalised(r);
    nearVec(r.sizes, [100, 40, 10]);
  });

  it('is the same after the body has been meshed (the mesh is not used)', () => {
    k.mesh(rotated, { linear: 5, angular: 1 });
    nearVec(k.orientedBox(rotated).sizes, [100, 40, 10]);
  });
});

describe('a box turned 40 degrees about an oblique axis', () => {
  it('gives its exact sizes, and axes along the turned edges', () => {
    const u = unit([1, 2, 3]);
    const box = k.box(120, 50, 18, [-10, 4, 2]);
    const rotated = turned(box, { origin: [0, 0, 0], direction: u }, 40 * DEG);
    const r = k.orientedBox(rotated);
    expectNormalised(r);
    nearVec(r.sizes, [120, 50, 18]);
    parallel(r.axes[0], rotate([1, 0, 0], u, 40 * DEG));
    parallel(r.axes[1], rotate([0, 1, 0], u, 40 * DEG));
    parallel(r.axes[2], rotate([0, 0, 1], u, 40 * DEG));
    nearVec(r.center, rotate([50, 29, 11], u, 40 * DEG));
    for (const id of [box, rotated]) k.release(id);
  });
});

describe('a cylinder', () => {
  it('on z: its length, then its diameter twice', () => {
    const cyl = k.cylinder(10, 50);
    const r = k.orientedBox(cyl);
    expectNormalised(r);
    nearVec(r.sizes, [50, 20, 20]);
    nearVec(r.axes[0], [0, 0, 1]);
    nearVec(r.center, [0, 0, 25]);
    k.release(cyl);
  });

  it('on an oblique axis: the same sizes, the long axis along the cylinder', () => {
    const axis = unit([1, -1, 2]);
    const cyl = k.cylinder(12.5, 80, [3, 4, 5], axis);
    const r = k.orientedBox(cyl);
    expectNormalised(r);
    nearVec(r.sizes, [80, 25, 25]);
    parallel(r.axes[0], axis);
    nearVec(r.center, [3 + 40 * axis[0], 4 + 40 * axis[1], 5 + 40 * axis[2]]);
    k.release(cyl);
  });
});

describe('a board with a dado', () => {
  // A 600 x 300 x 19 board (length along x, width along y), with a 19.05 mm dado 6 mm deep across
  // its width, 200 mm from one end, cut from its top face.
  let board: ShapeId;
  let dadoed: ShapeId;
  beforeAll(() => {
    board = k.box(600, 300, 19);
    const tool = k.box(19.05, 320, 10, [200, -10, 13]);
    dadoed = k.boolean('cut', board, [tool]).shape;
    k.release(tool);
    near(k.properties(dadoed).volume, 600 * 300 * 19 - 19.05 * 300 * 6, 1e-6);
  });

  it('still reports the blank size', () => {
    const r = k.orientedBox(dadoed);
    expectNormalised(r);
    nearVec(r.sizes, [600, 300, 19]);
    nearVec(r.center, [300, 150, 9.5]);
    expect(r.axes).toEqual([
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ]);
  });

  it('still reports the blank size when the board stands turned in space', () => {
    const u = unit([0, 1, 1]);
    const standing = turned(dadoed, { origin: [10, 20, 30], direction: u }, 65 * DEG);
    const spun = turned(standing, { origin: [0, 0, 0], direction: [0, 0, 1] }, 17 * DEG);
    for (const optimal of [true, false]) {
      const r = k.orientedBox(spun, { optimal });
      expectNormalised(r);
      nearVec(r.sizes, [600, 300, 19]);
    }
    for (const id of [standing, spun]) k.release(id);
  });
});

describe('normaliseBox', () => {
  it('sorts by size, signs the first two axes and makes the frame right-handed', () => {
    const r = normaliseBox(
      [1, 2, -0],
      [
        [[0, 0, -1], 3],
        [[-0.6, 0, -0.8], 10],
        [[0.8, 0, -0.6], 5],
      ],
      'obb',
    );
    expect(r.halfSizes).toEqual([10, 5, 3]);
    expect(r.sizes).toEqual([20, 10, 6]);
    expect(r.axes[0]).toEqual([0.6, 0, 0.8]);
    expect(r.axes[1]).toEqual([0.8, 0, -0.6]);
    nearVec(r.axes[2], [0, 1, 0], 1e-15);
    expect(Object.is(r.center[2], -0)).toBe(false);
    expectNormalised(r);
  });

  it('breaks a tie in largest component by x, then y', () => {
    const h = Math.SQRT1_2;
    const r = normaliseBox(
      [0, 0, 0],
      [
        [[-h, h, 0], 4],
        [[0, -h, -h], 2],
        [[h, h, 0], 1],
      ],
      'obb',
    );
    nearVec(r.axes[0], [h, -h, 0], 1e-15);
    nearVec(r.axes[1], [0, h, h], 1e-15);
  });

  it('gives the same box whatever order and signs the axes come in', () => {
    const parts: [Vec3, number][] = [
      [[1, 0, 0], 7],
      [[0, 1, 0], 7],
      [[0, 0, 1], 2],
    ];
    const a = normaliseBox([0, 0, 0], parts, 'obb');
    const b = normaliseBox(
      [0, 0, 0],
      [
        [[0, 0, -1], 2],
        [[0, -1, 0], 7],
        [[-1, 0, 0], 7],
      ],
      'obb',
    );
    expect(b).toEqual(a);
    expect(a.axes).toEqual([
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ]);
  });
});

describe('fallback and failure', () => {
  it('uses the tight axis-aligned box when the OBB throws', () => {
    const box = k.box(30, 80, 5, [1, 1, 1]);
    const lib = k.oc.BRepBndLib as unknown as { AddOBB: (...args: unknown[]) => void };
    const original = lib.AddOBB;
    lib.AddOBB = () => {
      throw new Error('no OBB today');
    };
    let r: OrientedBox;
    try {
      r = k.orientedBox(box);
    } finally {
      lib.AddOBB = original;
    }
    expect(r.source).toBe('aabb');
    expectNormalised(r);
    nearVec(r.sizes, [80, 30, 5]);
    nearVec(r.center, [16, 41, 3.5]);
    expect(k.orientedBox(box).source).toBe('obb');
    k.release(box);
  });

  it('refuses an empty shape', () => {
    const oc = k.oc;
    const error = withScope(oc, (s) => {
      const empty = s.own(new oc.TopoDS_Compound());
      s.own(new oc.BRep_Builder()).MakeCompound(empty);
      try {
        orientedBoxOf(oc, s, empty, {}, (e) => new KernelError('obb', String(e)));
        return null;
      } catch (e) {
        return e;
      }
    });
    expect(error).toBeInstanceOf(KernelError);
    expect((error as KernelError).code).toBe('invalid-argument');
  });

  it('reports an unknown shape', () => {
    expect(() => k.orientedBox(987654 as ShapeId)).toThrow(
      expect.objectContaining({ code: 'unknown-shape', operation: 'obb' }),
    );
  });
});

describe('the obb op through the service', () => {
  it('sizes a cylinder made earlier in the batch, and reports bad ops as invalid-op', async () => {
    const service = await createNodeService();
    const reply = await service.run({
      generation: 1,
      ops: [
        { op: 'cylinder', radius: 5, height: 40, axis: [1, 1, 0], keep: false },
        { op: 'obb', shape: { result: 0 } },
        { op: 'obb', shape: { result: 0 }, optimal: false },
        { op: 'obb', shape: { result: 0 }, optimal: 'yes' } as never,
      ],
    });
    expect(reply.status).toBe('done');
    for (const i of [1, 2]) {
      const result = reply.results[i]!;
      expect(result.ok).toBe(true);
      const box = (result as { value: OrientedBox }).value;
      nearVec(box.sizes, [40, 10, 10]);
      parallel(box.axes[0], [1, 1, 0]);
    }
    expect(reply.results[3]).toMatchObject({ ok: false, error: { code: 'invalid-op' } });
    expect(service.kernel.shapeCount).toBe(0);
  });
});
