// Golden tests for the interference check (M2 plan, T2.3d): overlap volumes of placed boxes and
// cylinders against volumes computed by hand, touching bodies left out, the bounding-box
// prefilter keeping every boolean away from a grid of spaced instances, and the op through the
// service. Leaks are covered in leaks.test.ts.

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { KernelError } from './errors';
import type { Kernel } from './kernel';
import { createNodeKernel, createNodeService } from './node';
import { collectTransferables } from './service';
import type { InterferenceResult, Placement, ShapeId, Vec3 } from './types';

let k: Kernel;
const made: ShapeId[] = [];

beforeAll(async () => {
  k = await createNodeKernel();
}, 60_000);

afterEach(() => {
  for (const id of made.splice(0)) k.release(id);
  expect(k.shapeCount).toBe(0);
});

const box = (size: Vec3, at?: Vec3): ShapeId => {
  const id = k.box(size[0], size[1], size[2], at);
  made.push(id);
  return id;
};

const at = (translation: Vec3): Placement => ({ translation, rotation: [0, 0, 0, 1] });

/** A turn of `angle` radians about the unit `axis`, then a translation. */
function turned(axis: Vec3, angle: number, translation: Vec3 = [0, 0, 0]): Placement {
  const s = Math.sin(angle / 2);
  return { translation, rotation: [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(angle / 2)] };
}

const PI = Math.PI;

describe('interference', () => {
  it('two overlapping boxes: the common volume, one boolean', () => {
    const a = box([10, 10, 10]);
    const r = k.interference([{ shapes: [a] }, { shapes: [a], transform: at([5, 5, 5]) }]);
    expect(r.candidates).toEqual([[0, 1]]);
    expect(r.booleans).toBe(1);
    expect(r.failures).toEqual([]);
    expect(r.pairs).toHaveLength(1);
    expect(r.pairs[0]).toMatchObject({ a: 0, b: 1 });
    expect(r.pairs[0]!.volume).toBeCloseTo(125, 6);
    expect(r.pairs[0]!.mesh).toBeUndefined();
  });

  it('places by the quaternion: a quarter turn about Z, then a shift', () => {
    const a = box([10, 10, 10]);
    // Turned a quarter about Z the box spans x -10..0, y 0..10; shifted 5 along X, x -5..5.
    const r = k.interference([
      { shapes: [a] },
      { shapes: [a], transform: turned([0, 0, 1], PI / 2, [5, 0, 0]) },
    ]);
    expect(r.pairs).toHaveLength(1);
    expect(r.pairs[0]!.volume).toBeCloseTo(500, 6);
  });

  it('a box and a cylinder: a quarter of the cylinder', () => {
    const a = box([10, 10, 10]);
    const c = k.cylinder(5, 10);
    made.push(c);
    const r = k.interference([{ shapes: [a] }, { shapes: [c] }]);
    expect(r.pairs[0]!.volume).toBeCloseTo((PI * 25 * 10) / 4, 6);
  });

  it('the same body at the same place overlaps by its whole volume', () => {
    const a = box([10, 20, 30]);
    const r = k.interference([{ shapes: [a] }, { shapes: [a] }]);
    expect(r.pairs[0]!.volume).toBeCloseTo(6000, 6);
  });

  it('touching boxes give nothing, and send no boolean', () => {
    const a = box([10, 10, 10]);
    const r = k.interference([
      { shapes: [a] },
      { shapes: [a], transform: at([10, 0, 0]) },
      { shapes: [a], transform: at([0, 0, 10]) },
      { shapes: [a], transform: at([10, 10, 10]) },
    ]);
    expect(r).toEqual({ candidates: [], booleans: 0, pairs: [], failures: [] });
  });

  it('touching boxes turned 45 degrees give nothing, though their boxes overlap', () => {
    const a = box([10, 10, 10]);
    const c = Math.SQRT1_2 * 10;
    // Both turned 45 degrees about Z; the second one box length further along the turned X.
    const r = k.interference([
      { shapes: [a], transform: turned([0, 0, 1], PI / 4) },
      { shapes: [a], transform: turned([0, 0, 1], PI / 4, [c, c, 0]) },
    ]);
    expect(r.candidates).toEqual([[0, 1]]);
    expect(r.booleans).toBe(1);
    expect(r.pairs).toEqual([]);
  });

  it('a 3 by 3 grid of spaced instances sends no boolean at all', () => {
    const a = box([10, 10, 10]);
    const items = [];
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) items.push({ shapes: [a], transform: at([i * 15, j * 15, 0]) });
    }
    const r = k.interference(items);
    expect(r).toEqual({ candidates: [], booleans: 0, pairs: [], failures: [] });
  });

  it('only pairs whose boxes overlap reach a boolean: a grid with one intruder', () => {
    const a = box([10, 10, 10]);
    const items = [];
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) items.push({ shapes: [a], transform: at([i * 15, j * 15, 0]) });
    }
    // A small block reaching 1 mm into the middle instance (x 15..25, y 15..25) from below.
    const small = box([4, 4, 4]);
    items.push({ shapes: [small], transform: at([18, 18, -3]) });
    const r = k.interference(items);
    expect(r.candidates).toEqual([[4, 9]]);
    expect(r.booleans).toBe(1);
    expect(r.pairs.map((p) => [p.a, p.b])).toEqual([[4, 9]]);
    expect(r.pairs[0]!.volume).toBeCloseTo(16, 6);
  });

  it('an item of several bodies: the volumes of its bodies add up; its own bodies are not checked', () => {
    // Two overlapping blocks in one item (one instance of a two-body part).
    const left = box([10, 10, 10]);
    const right = box([10, 10, 10], [5, 0, 0]);
    const bar = box([30, 2, 2], [-5, 4, 4]);
    const r = k.interference([{ shapes: [left, right] }, { shapes: [bar] }]);
    expect(r.candidates).toEqual([[0, 1]]);
    expect(r.booleans).toBe(2);
    // The bar crosses both blocks: 10 x 2 x 2 in each, overlapping where they do.
    expect(r.pairs[0]!.volume).toBeCloseTo(80, 6);
  });

  it('meshes the overlap on request, in world coordinates', () => {
    const a = box([10, 10, 10]);
    const r = k.interference([{ shapes: [a] }, { shapes: [a], transform: at([5, 5, 5]) }], {
      mesh: true,
    });
    const mesh = r.pairs[0]!.mesh!;
    expect(mesh.faceRanges.length / 2).toBe(6);
    for (let i = 0; i < mesh.positions.length; i++) {
      expect(mesh.positions[i]).toBeGreaterThanOrEqual(5 - 1e-6);
      expect(mesh.positions[i]).toBeLessThanOrEqual(10 + 1e-6);
    }
  });

  it('a tolerance above the overlap reports nothing; pairs and prefilterOnly choose the work', () => {
    const a = box([10, 10, 10]);
    const items = [
      { shapes: [a] },
      { shapes: [a], transform: at([5, 5, 5]) },
      { shapes: [a], transform: at([8, 0, 0]) },
    ];
    // 0-1 overlaps by 125, 0-2 by 2 x 10 x 10 = 200, 1-2 by 7 x 5 x 5 = 175: none above 250, so
    // not even their boxes are candidates.
    const big = k.interference(items, { tolerance: 250 });
    expect(big.pairs).toEqual([]);
    expect(big.candidates).toEqual([]);
    const only = k.interference(items, { pairs: [[2, 1]] });
    expect(only.pairs.map((p) => [p.a, p.b, Math.round(p.volume * 1e6) / 1e6])).toEqual([
      [2, 1, 175],
    ]);
    const pre = k.interference(items, { prefilterOnly: true });
    expect(pre).toEqual({
      candidates: [
        [0, 1],
        [0, 2],
        [1, 2],
      ],
      booleans: 0,
      pairs: [],
      failures: [],
    });
  });

  it('refuses bad placements, pairs and tolerances, and unknown shapes', () => {
    const a = box([10, 10, 10]);
    const bad: [string, () => unknown][] = [
      [
        'a zero quaternion',
        () =>
          k.interference([
            { shapes: [a] },
            { shapes: [a], transform: { translation: [0, 0, 0], rotation: [0, 0, 0, 0] } },
          ]),
      ],
      [
        'a translation that is not finite',
        () => k.interference([{ shapes: [a], transform: at([Number.NaN, 0, 0]) }]),
      ],
      ['a pair of one item', () => k.interference([{ shapes: [a] }], { pairs: [[0, 0]] })],
      ['a pair out of range', () => k.interference([{ shapes: [a] }], { pairs: [[0, 1]] })],
      ['a negative tolerance', () => k.interference([{ shapes: [a] }], { tolerance: -1 })],
    ];
    for (const [name, fn] of bad) {
      let error: unknown = null;
      try {
        fn();
      } catch (e) {
        error = e;
      }
      expect(error, name).toBeInstanceOf(KernelError);
      expect((error as KernelError).code, name).toBe('invalid-argument');
    }
    expect(() => k.interference([{ shapes: [999_999 as ShapeId] }])).toThrow(/unknown shape/);
    expect(k.interference([])).toEqual({ candidates: [], booleans: 0, pairs: [], failures: [] });
  });

  it('runs as an op through the service, taking shapes of earlier ops; meshes are transferred', async () => {
    const service = await createNodeService();
    const reply = await service.run({
      generation: 1,
      ops: [
        { op: 'box', size: [10, 10, 10], keep: false },
        {
          op: 'interference',
          items: [
            { shapes: [{ result: 0 }] },
            { shapes: [{ result: 0 }], transform: at([5, 5, 5]) },
          ],
          mesh: true,
        },
        {
          op: 'interference',
          items: [{ shapes: [{ result: 0 }], transform: { translation: [0, 0, 0] } }],
        } as never,
      ],
    });
    expect(reply.status).toBe('done');
    const r = reply.results[1]!;
    expect(r.ok).toBe(true);
    const value = (r as { value: InterferenceResult }).value;
    expect(value.pairs[0]!.volume).toBeCloseTo(125, 6);
    expect(collectTransferables(reply)).toContain(value.pairs[0]!.mesh!.positions.buffer);
    const malformed = reply.results[2]!;
    expect(malformed.ok).toBe(false);
    expect((malformed as { error: { code: string } }).error.code).toBe('invalid-op');
    expect(service.kernel.shapeCount).toBe(0);
  });
});
