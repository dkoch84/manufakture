// The synchronous kernel against the real libcascade, in Node. One instance
// for the whole file: init costs about half a second.

import { beforeAll, describe, expect, it } from 'vitest';
import { KernelError } from './errors';
import { DEFAULT_DEFLECTION, type Kernel } from './kernel';
import { tessellate } from './mesh';
import { createNodeKernel } from './node';
import { withScope } from './occt';
import { topologyOf } from './topology';
import {
  UNNAMED,
  type Frame,
  type HistoryEntry,
  type MeshData,
  type ProfileLoop,
  type ShapeId,
  type SubShapeKind,
  type Vec2,
  type Vec3,
} from './types';

let k: Kernel;

beforeAll(async () => {
  k = await createNodeKernel();
}, 60_000);

const XY: Frame = { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] };

function rect(x0: number, y0: number, x1: number, y1: number): ProfileLoop {
  const p: Vec2[] = [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
  return {
    entities: p.map((start, i) => ({ kind: 'line' as const, start, end: p[(i + 1) % 4]! })),
  };
}

function expectVec(actual: Vec3 | null, expected: Vec3, digits = 6): void {
  expect(actual).not.toBeNull();
  actual!.forEach((c, i) => expect(c).toBeCloseTo(expected[i]!, digits));
}

/** Catch the KernelError a call throws. */
function failure(fn: () => unknown): KernelError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(KernelError);
    return error as KernelError;
  }
  throw new Error('expected a KernelError');
}

/** Run `fn`, then release every shape it made; checks the arena is back where it was. */
function scoped<T>(fn: () => T): T {
  const mark = k.checkpoint();
  const before = k.shapeCount;
  try {
    return fn();
  } finally {
    k.releaseSince(mark);
    expect(k.shapeCount).toBe(before);
  }
}

function entry(history: HistoryEntry[], operand: number, kind: SubShapeKind, index: number) {
  const e = history.find(
    (h) => h.operand === operand && h.input.kind === kind && h.input.index === index,
  );
  expect(e, `history entry ${operand}:${kind}${index}`).toBeDefined();
  return e!;
}

describe('arena', () => {
  it('hands out increasing ids and releases them', () => {
    const a = k.box(1, 1, 1);
    const b = k.box(1, 1, 1);
    expect(b).toBeGreaterThan(a);
    expect(k.has(a)).toBe(true);
    expect(k.release(a)).toBe(true);
    expect(k.has(a)).toBe(false);
    expect(k.release(a)).toBe(false);
    expect(k.release(b)).toBe(true);
  });

  it('checkpoint and releaseSince free only what came after the mark', () => {
    const keep = k.box(1, 1, 1);
    const mark = k.checkpoint();
    k.box(1, 1, 1);
    k.cylinder(1, 1);
    expect(k.releaseSince(mark)).toBe(2);
    expect(k.has(keep)).toBe(true);
    k.release(keep);
  });

  it('records provenance for leak reports', () => {
    k.setContext({ featureId: 'box#1', generation: 7 });
    const id = k.box(1, 2, 3);
    k.setContext({});
    const other = k.box(1, 1, 1);
    const live = k.liveShapes();
    expect(live.find((r) => r.id === id)).toMatchObject({
      operation: 'box',
      featureId: 'box#1',
      generation: 7,
    });
    const plain = live.find((r) => r.id === other)!;
    expect(plain.featureId).toBeUndefined();
    expect(plain.stack).toBeUndefined();
    k.release(id);
    k.release(other);
  });

  it('records a creation stack in debug mode', async () => {
    const dk = new (k.constructor as typeof Kernel)(k.oc, { debug: true, firstId: 1_000_000 });
    const id = dk.box(1, 1, 1);
    expect(id).toBe(1_000_000);
    expect(dk.liveShapes()[0]!.stack).toContain('shape created');
    dk.release(id);
  });

  it('an unknown id is a structured error, naming the operation that asked', () => {
    const e = failure(() => k.properties(999_999 as ShapeId));
    expect(e.code).toBe('unknown-shape');
    expect(e.operation).toBe('properties');
    expect(failure(() => k.fillet(999_999 as ShapeId, [1], 0.1)).operation).toBe('fillet');
    expect(failure(() => k.extrude(999_999 as ShapeId, 1)).operation).toBe('extrude');
    expect(failure(() => k.mesh(999_999 as ShapeId)).operation).toBe('tessellate');
    const a = k.box(1, 1, 1);
    expect(failure(() => k.boolean('cut', a, [999_999 as ShapeId])).operation).toBe('cut');
    k.release(a);
  });

  it('a failure after the result is stored is not hidden by a failing release', () => {
    // Fail the second shape map a fillet makes (its result maps, after the
    // result is in the arena), and make releasing any shape throw as well.
    // Constructors are replaced rather than MapShapes: embind dispatches
    // overloaded functions through a table on the original function.
    const MAP = 'NCollection_IndexedMap_TopoDS_Shape_TopTools_ShapeMapHasher';
    const oc = k.oc as unknown as Record<string, unknown> & {
      TopoDS_Shape: { prototype: { Nullify: () => void } };
    };
    const RealMap = oc[MAP] as new () => object;
    const realNullify = oc.TopoDS_Shape.prototype.Nullify;
    const attempt = (thrown: () => Error) => {
      const dk = new (k.constructor as typeof Kernel)(k.oc, { firstId: 3_000_000 });
      const box = dk.box(1, 1, 1);
      let calls = 0;
      oc[MAP] = function () {
        if (++calls === 2) throw thrown();
        return new RealMap();
      };
      oc.TopoDS_Shape.prototype.Nullify = () => {
        throw new Error('release failed');
      };
      try {
        const e = failure(() => dk.fillet(box, [1], 0.1));
        return { e, dk };
      } finally {
        oc[MAP] = RealMap;
        oc.TopoDS_Shape.prototype.Nullify = realNullify;
      }
    };

    const plain = attempt(() => new Error('history broke'));
    expect(plain.e).toMatchObject({ code: 'kernel', operation: 'fillet' });
    expect(plain.e.message).toContain('history broke');
    // The fillet result is gone from the arena; the box is still there.
    expect(plain.dk.shapeCount).toBe(1);
    expect(plain.dk.lostReason).toBeNull();
    plain.dk.releaseSince(0);

    // A trap: nothing is released into the dead instance, and the trap is what is reported.
    const trapped = attempt(() => new WebAssembly.RuntimeError('unreachable'));
    expect(trapped.e).toMatchObject({ code: 'fatal', operation: 'fillet' });
    expect(trapped.dk.lostReason).toContain('wasm trap in fillet');
    expect(trapped.dk.liveShapes().map((r) => r.operation)).toEqual(['box']);
  });

  it('an abandoned kernel refuses work with a fatal error', () => {
    const dk = new (k.constructor as typeof Kernel)(k.oc, { firstId: 2_000_000 });
    const id = dk.box(1, 1, 1);
    expect(dk.abandon('test')).toBe(1);
    expect(dk.shapeCount).toBe(0);
    expect(dk.lostReason).toBe('test');
    const e = failure(() => dk.box(1, 1, 1));
    expect(e.code).toBe('fatal');
    expect(dk.release(id)).toBe(false);
  });
});

describe('primitives', () => {
  it('box: volume, counts, bounding box, validity', () =>
    scoped(() => {
      const p = k.properties(k.box(10, 20, 30, [1, 2, 3]));
      expect(p.volume).toBeCloseTo(6000, 6);
      expect(p.area).toBeCloseTo(2 * (200 + 600 + 300), 6);
      expect([p.faces, p.edges, p.vertices]).toEqual([6, 12, 8]);
      expect(p.valid).toBe(true);
      expectVec(p.boundingBox!.min, [1, 2, 3], 4);
      expectVec(p.boundingBox!.max, [11, 22, 33], 4);
    }));

  it('cylinder along an arbitrary axis', () =>
    scoped(() => {
      const id = k.cylinder(2, 5, [1, 1, 1], [1, 0, 0]);
      expect(k.properties(id).volume).toBeCloseTo(Math.PI * 4 * 5, 6);
      const t = k.topology(id);
      const side = t.faces.find((f) => f.surface === 'cylinder')!;
      expect(side.radius).toBeCloseTo(2, 9);
      expectVec(side.axis, [1, 0, 0]);
      expect(t.edges.filter((e) => e.seam)).toHaveLength(1);
    }));

  it('rejects non-positive and non-finite sizes without making a shape', () =>
    scoped(() => {
      for (const args of [
        [0, 1, 1],
        [1, -1, 1],
        [1, 1, Number.NaN],
        [1, Number.POSITIVE_INFINITY, 1],
      ] as const) {
        const e = failure(() => k.box(args[0], args[1], args[2]));
        expect(e.code).toBe('invalid-argument');
        expect(e.operation).toBe('box');
      }
      expect(failure(() => k.cylinder(1, 1, [0, 0, 0], [0, 0, 0])).code).toBe('invalid-argument');
    }));

  it('decodes an OCCT exception into the error', () =>
    scoped(() => {
      const e = failure(() => k.box(1e-12, 1, 1));
      expect(e.code).toBe('kernel');
      expect(e.operation).toBe('box');
      expect(e.occtType).toBe('Standard_DomainError');
      expect(e.toFailure('box#9')).toMatchObject({
        code: 'kernel',
        operation: 'box',
        occtType: 'Standard_DomainError',
        featureId: 'box#9',
      });
    }));
});

describe('profile and extrude', () => {
  it('extrudes a rectangle with caps and sides in entity order', () =>
    scoped(() => {
      const profile = k.profile(XY, [rect(0, 0, 10, 20)]);
      const r = k.extrude(profile, 5);
      const p = k.properties(r.shape);
      expect(p.volume).toBeCloseTo(1000, 6);
      expect(p.valid).toBe(true);
      const t = k.topology(r.shape);
      const face = (i: number) => t.faces[i - 1]!;
      expectVec(face(r.capStart).normal, [0, 0, -1]);
      expectVec(face(r.capEnd).normal, [0, 0, 1]);
      expect(face(r.capEnd).centroid[2]).toBeCloseTo(5, 6);
      expect(r.sides).toHaveLength(1);
      // Entity i runs from corner i to corner i + 1: bottom, right, top, left.
      const normals: Vec3[] = [
        [0, -1, 0],
        [1, 0, 0],
        [0, 1, 0],
        [-1, 0, 0],
      ];
      r.sides[0]!.forEach((f, i) => expectVec(face(f).normal, normals[i]!));
      expect(new Set([r.capStart, r.capEnd, ...r.sides[0]!]).size).toBe(6);
    }));

  it('reports the side face of every entity with an id in sideIds', () =>
    scoped(() => {
      const outer = rect(0, 0, 10, 20);
      const tagged: ProfileLoop = {
        entities: outer.entities.map((e, i) => (i === 1 ? e : { ...e, id: `e${i + 1}` })),
      };
      const hole: ProfileLoop = {
        entities: [{ kind: 'circle', center: [5, 10], radius: 2, id: 'c1' }],
      };
      const r = k.extrude(k.profile(XY, [tagged, hole]), 5);
      expect(r.sideIds).toEqual({
        e1: r.sides[0]![0],
        e3: r.sides[0]![2],
        e4: r.sides[0]![3],
        c1: r.sides[1]![0],
      });
      const t = k.topology(r.shape);
      expectVec(t.faces[r.sideIds.e1! - 1]!.normal, [0, -1, 0]);
      expect(t.faces[r.sideIds.c1! - 1]!.surface).toBe('cylinder');
      expect(k.extrude(k.profile(XY, [outer]), 1).sideIds).toEqual({});
    }));

  it('rejects an entity id used twice in one profile', () =>
    scoped(() => {
      const outer = rect(0, 0, 10, 10);
      const e = failure(() =>
        k.profile(XY, [{ entities: outer.entities.map((x) => ({ ...x, id: 'same' })) }]),
      );
      expect(e.code).toBe('invalid-argument');
      expect(e.message).toMatch(/'same' is used twice/);
    }));

  it('orients loops itself: a clockwise outer loop gives the same solid', () =>
    scoped(() => {
      const ccw = rect(0, 0, 10, 20);
      const cw: ProfileLoop = {
        entities: [...ccw.entities]
          .reverse()
          .map((e) => (e.kind === 'line' ? { kind: 'line', start: e.end, end: e.start } : e)),
      };
      const r = k.extrude(k.profile(XY, [cw]), 5);
      const p = k.properties(r.shape);
      expect(p.volume).toBeCloseTo(1000, 6);
      expect(p.valid).toBe(true);
    }));

  it('extrudes the other way with a negative distance, and along a vector', () =>
    scoped(() => {
      const profile = k.profile(XY, [rect(0, 0, 2, 3)]);
      const down = k.extrude(profile, -4);
      const pd = k.properties(down.shape);
      expect(pd.volume).toBeCloseTo(24, 6);
      expect(pd.valid).toBe(true);
      expect(pd.boundingBox!.min[2]).toBeCloseTo(-4, 4);
      const t = k.topology(down.shape);
      expect(t.faces[down.capEnd - 1]!.centroid[2]).toBeCloseTo(-4, 6);

      const slanted = k.extrude(profile, [0, 1, 2]);
      expect(k.properties(slanted.shape).volume).toBeCloseTo(12, 6);
    }));

  it('places the profile in a tilted frame', () =>
    scoped(() => {
      const frame: Frame = { origin: [5, 0, 0], xDir: [0, 1, 0], normal: [1, 0, 0] };
      const r = k.extrude(k.profile(frame, [rect(0, 0, 2, 3)]), 4);
      const p = k.properties(r.shape);
      expect(p.volume).toBeCloseTo(24, 6);
      expectVec(p.boundingBox!.min, [5, 0, 0], 4);
      expectVec(p.boundingBox!.max, [9, 2, 3], 4);
    }));

  it('a circular hole is its own loop with one side face', () =>
    scoped(() => {
      const hole: ProfileLoop = { entities: [{ kind: 'circle', center: [10, 10], radius: 3 }] };
      const r = k.extrude(k.profile(XY, [rect(0, 0, 20, 20), hole]), 2);
      const p = k.properties(r.shape);
      expect(p.volume).toBeCloseTo((400 - Math.PI * 9) * 2, 5);
      expect(p.valid).toBe(true);
      expect(r.sides.map((s) => s.length)).toEqual([4, 1]);
      const bore = k.topology(r.shape).faces[r.sides[1]![0]! - 1]!;
      expect(bore.surface).toBe('cylinder');
      expect(bore.radius).toBeCloseTo(3, 9);
    }));

  it('arcs bulge out counter-clockwise and cut in clockwise', () =>
    scoped(() => {
      const loop = (clockwise: boolean): ProfileLoop => ({
        entities: [
          { kind: 'line', start: [0, 0], end: [10, 0] },
          { kind: 'arc', center: [10, 5], start: [10, 0], end: [10, 10], clockwise },
          { kind: 'line', start: [10, 10], end: [0, 10] },
          { kind: 'line', start: [0, 10], end: [0, 0] },
        ],
      });
      const out = k.extrude(k.profile(XY, [loop(false)]), 1);
      expect(k.properties(out.shape).volume).toBeCloseTo(100 + (Math.PI * 25) / 2, 5);
      const arcFace = k.topology(out.shape).faces[out.sides[0]![1]! - 1]!;
      expect(arcFace.surface).toBe('cylinder');
      const inward = k.extrude(k.profile(XY, [loop(true)]), 1);
      const pi = k.properties(inward.shape);
      expect(pi.volume).toBeCloseTo(100 - (Math.PI * 25) / 2, 5);
      expect(pi.valid).toBe(true);
    }));

  it('reports kinded history for the profile face, edges and vertices', () =>
    scoped(() => {
      const r = k.extrude(k.profile(XY, [rect(0, 0, 1, 1)]), 1);
      expect(r.history).toHaveLength(1 + 4 + 4);
      expect(r.history.every((h) => h.operand === 0)).toBe(true);
      for (let e = 1; e <= 4; e++) {
        const h = entry(r.history, 0, 'edge', e);
        expect(h.generated.filter((g) => g.kind === 'face')).toHaveLength(1);
      }
      for (let v = 1; v <= 4; v++) {
        // A profile vertex sweeps into a vertical edge.
        expect(entry(r.history, 0, 'vertex', v).generated).toContainEqual(
          expect.objectContaining({ kind: 'edge' }),
        );
      }
      expect(k.extrude(k.profile(XY, [rect(0, 0, 1, 1)]), 1, { history: false }).history).toEqual(
        [],
      );
    }));

  it('rejects bad profiles and extrusions as invalid arguments', () =>
    scoped(() => {
      const open: ProfileLoop = {
        entities: [
          { kind: 'line', start: [0, 0], end: [1, 0] },
          { kind: 'line', start: [1, 0], end: [1, 1] },
        ],
      };
      const cases: Array<[string, () => unknown]> = [
        ['no loops', () => k.profile(XY, [])],
        ['open loop', () => k.profile(XY, [open])],
        ['empty loop', () => k.profile(XY, [{ entities: [] }])],
        ['zero normal', () => k.profile({ ...XY, normal: [0, 0, 0] }, [rect(0, 0, 1, 1)])],
        ['skew xDir', () => k.profile({ ...XY, xDir: [1, 0, 1] }, [rect(0, 0, 1, 1)])],
        [
          'circle plus line',
          () =>
            k.profile(XY, [
              {
                entities: [
                  { kind: 'circle', center: [0, 0], radius: 1 },
                  { kind: 'line', start: [0, 0], end: [1, 0] },
                ],
              },
            ]),
        ],
        ['zero extrusion', () => k.extrude(k.profile(XY, [rect(0, 0, 1, 1)]), 0)],
        ['not a profile', () => k.extrude(k.box(1, 1, 1), 1)],
      ];
      for (const [name, fn] of cases) {
        const e = failure(fn);
        expect(e.code, name).toBe('invalid-argument');
      }
    }));
});

describe('boolean', () => {
  it('cut: volume and history for both operands', () =>
    scoped(() => {
      const box = k.box(10, 10, 10);
      const tool = k.cylinder(2, 20, [5, 5, -5]);
      const r = k.boolean('cut', box, [tool]);
      const p = k.properties(r.shape);
      expect(p.volume).toBeCloseTo(1000 - Math.PI * 4 * 10, 5);
      expect(p.valid).toBe(true);
      // Every face, edge and vertex of both inputs: 6+12+8 and 3+3+2.
      expect(r.history).toHaveLength(26 + 8);
      const t = k.topology(r.shape);
      const bottomOrTop = t.faces.filter((f) => f.surface === 'plane');
      expect(bottomOrTop).toHaveLength(6);
      // The tool's cylindrical face becomes the bore.
      const toolFace = r.history.find(
        (h) => h.operand === 1 && h.input.kind === 'face' && h.modified.length > 0,
      )!;
      expect(toolFace).toBeDefined();
      const bore = t.faces[toolFace.modified[0]!.index - 1]!;
      expect(bore.surface).toBe('cylinder');
      // An untouched side face of the box passes through as is.
      const kept = r.history.filter(
        (h) => h.operand === 0 && h.input.kind === 'face' && h.kept > 0,
      );
      expect(kept.length).toBeGreaterThanOrEqual(4);
      // Outputs are sorted faces, edges, vertices, then by index.
      for (const h of r.history) {
        const order = { face: 0, edge: 1, vertex: 2 };
        const keys = h.modified.map((m) => order[m.kind] * 1e6 + m.index);
        expect(keys).toEqual([...keys].sort((a, b) => a - b));
      }
    }));

  it('cut with several tools in one call', () =>
    scoped(() => {
      const r = k.boolean('cut', k.box(10, 10, 2), [
        k.cylinder(1, 4, [3, 3, -1]),
        k.cylinder(1, 4, [7, 7, -1]),
      ]);
      expect(k.properties(r.shape).volume).toBeCloseTo(200 - 2 * Math.PI * 2, 5);
      expect(r.history.some((h) => h.operand === 2)).toBe(true);
    }));

  it('fuse, common, and fuse with simplify', () =>
    scoped(() => {
      const a = k.box(10, 10, 10);
      const b = k.box(10, 10, 10, [5, 0, 0]);
      expect(k.properties(k.boolean('fuse', a, [b]).shape).volume).toBeCloseTo(1500, 5);
      expect(k.properties(k.boolean('common', a, [b]).shape).volume).toBeCloseTo(500, 5);
      const plain = k.boolean('fuse', a, [b], { history: false });
      expect(plain.history).toEqual([]);
      expect(k.properties(plain.shape).faces).toBeGreaterThan(6);
      const simple = k.boolean('fuse', a, [b], { simplify: true });
      expect(k.properties(simple.shape).faces).toBe(6);
      // Merged faces show up as several inputs with one result.
      const tops = simple.history.filter(
        (h) => h.input.kind === 'face' && (h.modified.length > 0 || h.kept > 0),
      );
      expect(tops.length).toBeGreaterThan(6);
    }));

  it('needs a tool, and live shapes', () =>
    scoped(() => {
      const a = k.box(1, 1, 1);
      expect(failure(() => k.boolean('cut', a, [])).code).toBe('invalid-argument');
      const e = failure(() => k.boolean('cut', a, [123_456 as ShapeId]));
      expect(e.code).toBe('unknown-shape');
    }));
});

describe('fillet', () => {
  it('rounds one edge, with history naming the new face', () =>
    scoped(() => {
      const box = k.box(10, 10, 10);
      const before = k.topology(box);
      const r = k.fillet(box, [1], 2);
      const p = k.properties(r.shape);
      expect(p.faces).toBe(7);
      expect(p.volume).toBeCloseTo(1000 - (4 - Math.PI) * 10, 5);
      const t = k.topology(r.shape);
      const round = entry(r.history, 0, 'edge', 1).generated.filter((g) => g.kind === 'face');
      expect(round).toHaveLength(1);
      expect(t.faces[round[0]!.index - 1]!.surface).toBe('cylinder');
      // The two faces along the edge are trimmed, and the two end faces gain
      // an arc in their outline: all four are modified. The two faces that
      // do not touch the edge at all pass through unchanged.
      const edge = before.edges[0]!;
      const touching = new Set(edge.vertices.flatMap((v) => before.vertices[v - 1]!.faces));
      expect(touching.size).toBe(4);
      for (const f of before.faces) {
        const h = entry(r.history, 0, 'face', f.index);
        if (touching.has(f.index)) {
          expect(h.modified).toHaveLength(1);
          expect(h.kept).toBe(0);
        } else {
          expect(h.kept).toBeGreaterThan(0);
        }
      }
      expect(r.history).toHaveLength(6 + 12 + 8);
    }));

  it('fillets an edge of a cut result', () =>
    scoped(() => {
      const body = k.boolean('cut', k.box(10, 10, 10), [k.cylinder(2, 20, [5, 5, -5])]).shape;
      const t = k.topology(body);
      const rim = t.edges.find((e) => e.curve === 'circle')!;
      const r = k.fillet(body, [rim.index], 0.5);
      expect(k.properties(r.shape).valid).toBe(true);
    }));

  it('a fillet OCCT cannot build is a kernel error, and leaves nothing behind', () =>
    scoped(() => {
      const box = k.box(10, 10, 10);
      const count = k.shapeCount;
      const big = failure(() => k.fillet(box, [1], 50));
      expect(big.code).toBe('kernel');
      expect(big.message).toMatch(/fillet failed \(1 faulty contour\)/);
      const seam = k.topology(k.cylinder(5, 10)).edges.find((e) => e.seam)!;
      const cyl = k.checkpoint() - 1;
      const occt = failure(() => k.fillet(cyl as ShapeId, [seam.index], 1));
      expect(occt.occtType).toBe('Standard_Failure');
      expect(occt.occtMessage).toMatch(/no suitable edges/);
      expect(k.shapeCount).toBe(count + 1);
    }));

  it('rejects bad edge lists and radii', () =>
    scoped(() => {
      const box = k.box(1, 1, 1);
      for (const [edges, radius] of [
        [[], 0.1],
        [[13], 0.1],
        [[0], 0.1],
        [[1.5], 0.1],
        [[1], 0],
      ] as const) {
        expect(failure(() => k.fillet(box, [...edges], radius)).code).toBe('invalid-argument');
      }
    }));
});

describe('topology', () => {
  it('box: faces with outward normals, edge and vertex adjacency', () =>
    scoped(() => {
      const t = k.topology(k.box(2, 4, 6));
      expect(t.faces).toHaveLength(6);
      expect(t.edges).toHaveLength(12);
      expect(t.vertices).toHaveLength(8);
      for (const f of t.faces) {
        expect(f.surface).toBe('plane');
        // The normal points from the box centre towards the face.
        const d = f.centroid.map((c, i) => c - [1, 2, 3][i]!);
        expect(d[0]! * f.normal![0] + d[1]! * f.normal![1] + d[2]! * f.normal![2]).toBeGreaterThan(
          0,
        );
      }
      for (const e of t.edges) {
        expect(e.faces).toHaveLength(2);
        expect(e.seam).toBe(false);
        expect(e.curve).toBe('line');
        expect(e.vertices).toHaveLength(2);
        expect([2, 4, 6]).toContainEqual(Number(e.length.toFixed(9)));
      }
      for (const v of t.vertices) expect(v.faces).toHaveLength(3);
      expect(t.faces.map((f) => f.index)).toEqual([1, 2, 3, 4, 5, 6]);
    }));

  it('plane normals follow the surface for a left-handed frame, as the mesh normals do', () =>
    withScope(k.oc, (s) => {
      const oc = k.oc;
      /** Face normal from topology and from the first mesh vertex of each face. */
      const both = (shape: Parameters<typeof topologyOf>[2]) => {
        const t = topologyOf(oc, s, shape);
        const mesh = tessellate(oc, s, shape, DEFAULT_DEFLECTION);
        return t.faces.map((f, i) => {
          const v = mesh.indices[mesh.faceRanges[i * 2]!]!;
          const m: Vec3 = [
            mesh.normals[v * 3]!,
            mesh.normals[v * 3 + 1]!,
            mesh.normals[v * 3 + 2]!,
          ];
          return { face: f, mesh: m };
        });
      };

      // A plane whose frame is left-handed: X ^ Y is -Z although its axis is +Z.
      const ax3 = s.own(
        new oc.gp_Ax3(
          s.own(new oc.gp_Pnt(0, 0, 0)),
          s.own(new oc.gp_Dir(0, 0, 1)),
          s.own(new oc.gp_Dir(1, 0, 0)),
        ),
      );
      ax3.YReverse();
      const pln = s.own(new oc.gp_Pln(ax3));
      expect(pln.Direct()).toBe(false);
      const face = s.own(s.own(new oc.BRepBuilderAPI_MakeFace(pln, 0, 1, 0, 1)).Face());
      const [only] = both(face);
      expectVec(only!.face.normal, [0, 0, -1]);
      expectVec(only!.mesh, [0, 0, -1], 5);

      // A mirrored box: mirroring makes left-handed planes, and the normals
      // must still point out of the body and agree with the mesh.
      const box = s.own(
        s.own(new oc.BRepPrimAPI_MakeBox(s.own(new oc.gp_Pnt(0, 0, 0)), 2, 4, 6)).Shape(),
      );
      const mirror = s.own(new oc.gp_Trsf());
      mirror.SetMirror(
        s.own(new oc.gp_Ax2(s.own(new oc.gp_Pnt(0, 0, 0)), s.own(new oc.gp_Dir(1, 0, 0)))),
      );
      const mirrored = s.own(s.own(new oc.BRepBuilderAPI_Transform(box, mirror, true)).Shape());
      const faces = both(mirrored);
      expect(faces).toHaveLength(6);
      let leftHanded = 0;
      for (const { face: f, mesh } of faces) {
        const d = f.centroid.map((c, i) => c - [-1, 2, 3][i]!);
        expect(d[0]! * f.normal![0] + d[1]! * f.normal![1] + d[2]! * f.normal![2]).toBeGreaterThan(
          0,
        );
        expectVec(mesh, f.normal!, 5);
      }
      for (let i = 1; i <= 6; i++) {
        withScope(oc, (fs) => {
          const map = fs.own(new oc.NCollection_IndexedMap_TopoDS_Shape_TopTools_ShapeMapHasher());
          oc.TopExp.MapShapes(mirrored, oc.TopAbs_ShapeEnum.TopAbs_FACE, map);
          const f = fs.own(oc.TopoDS.Face(fs.own(map.FindKey(i))));
          const adaptor = fs.own(new oc.BRepAdaptor_Surface(f, true));
          if (!fs.own(adaptor.Plane()).Direct()) leftHanded++;
        });
      }
      // The case under test really occurs.
      expect(leftHanded).toBeGreaterThan(0);
    }));

  it('cylinder: a seam edge lists its face once, a closed edge has one vertex', () =>
    scoped(() => {
      const t = k.topology(k.cylinder(1, 2));
      const seam = t.edges.find((e) => e.seam)!;
      expect(seam.faces).toHaveLength(1);
      const circles = t.edges.filter((e) => e.curve === 'circle');
      expect(circles).toHaveLength(2);
      for (const c of circles) {
        expect(c.vertices).toHaveLength(1);
        expect(c.length).toBeCloseTo(2 * Math.PI, 9);
      }
    }));
});

describe('mesh', () => {
  function expectValidMesh(mesh: MeshData, faces: number, edges: number): void {
    const vertexCount = mesh.positions.length / 3;
    expect(mesh.normals.length).toBe(mesh.positions.length);
    expect(mesh.indices.length % 3).toBe(0);
    for (const index of mesh.indices) expect(index).toBeLessThan(vertexCount);
    for (let i = 0; i < vertexCount; i++) {
      const n = [mesh.normals[i * 3]!, mesh.normals[i * 3 + 1]!, mesh.normals[i * 3 + 2]!];
      expect(Math.hypot(n[0]!, n[1]!, n[2]!)).toBeCloseTo(1, 3);
    }
    // Face ranges tile the index buffer in face order, with no gaps.
    expect(mesh.faceRanges.length).toBe(faces * 2);
    let next = 0;
    for (let f = 0; f < faces; f++) {
      expect(mesh.faceRanges[f * 2]).toBe(next);
      expect(mesh.faceRanges[f * 2 + 1]).toBeGreaterThan(0);
      for (let t = next / 3; t < (next + mesh.faceRanges[f * 2 + 1]!) / 3; t++) {
        expect(mesh.triangleFaces[t]).toBe(f + 1);
      }
      next += mesh.faceRanges[f * 2 + 1]!;
    }
    expect(next).toBe(mesh.indices.length);
    expect(mesh.triangleFaces.length).toBe(mesh.indices.length / 3);
    // Edge ranges tile the point buffer in edge order.
    expect(mesh.edgeRanges.length).toBe(edges * 2);
    let point = 0;
    for (let e = 0; e < edges; e++) {
      expect(mesh.edgeRanges[e * 2]).toBe(point);
      point += mesh.edgeRanges[e * 2 + 1]!;
    }
    expect(point * 3).toBe(mesh.edgePositions.length);
    // Name slots are there for the regen engine, unnamed.
    expect([...mesh.faceNames]).toEqual(new Array(faces).fill(UNNAMED));
    expect([...mesh.edgeNames]).toEqual(new Array(edges).fill(UNNAMED));
    expect([...mesh.faceFragile, ...mesh.edgeFragile].every((x) => x === 0)).toBe(true);
  }

  const edgePoints = (mesh: MeshData, edge: number): Vec3[] => {
    const [first, count] = [mesh.edgeRanges[(edge - 1) * 2]!, mesh.edgeRanges[(edge - 1) * 2 + 1]!];
    return Array.from({ length: count }, (_, i) => {
      const o = (first + i) * 3;
      return [mesh.edgePositions[o]!, mesh.edgePositions[o + 1]!, mesh.edgePositions[o + 2]!];
    });
  };

  it('box: 12 triangles, outward normals, straight edges between the right vertices', () =>
    scoped(() => {
      const box = k.box(2, 4, 6);
      const mesh = k.mesh(box);
      expectValidMesh(mesh, 6, 12);
      expect(mesh.indices.length / 3).toBe(12);
      for (let i = 0; i < mesh.positions.length / 3; i++) {
        const d = [0, 1, 2].map((c) => mesh.positions[i * 3 + c]! - [1, 2, 3][c]!);
        const dot = d.reduce((acc, dc, c) => acc + dc * mesh.normals[i * 3 + c]!, 0);
        expect(dot).toBeGreaterThan(0);
      }
      // Triangles wind counter-clockwise seen from outside: their geometric
      // normal agrees with the vertex normals.
      for (let t = 0; t < mesh.indices.length / 3; t++) {
        const [a, b, c] = [0, 1, 2].map((j) => mesh.indices[t * 3 + j]!);
        const p = (v: number): Vec3 => [
          mesh.positions[v * 3]!,
          mesh.positions[v * 3 + 1]!,
          mesh.positions[v * 3 + 2]!,
        ];
        const [pa, pb, pc] = [p(a!), p(b!), p(c!)];
        const u = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]];
        const v = [pc[0] - pa[0], pc[1] - pa[1], pc[2] - pa[2]];
        const n = [
          u[1]! * v[2]! - u[2]! * v[1]!,
          u[2]! * v[0]! - u[0]! * v[2]!,
          u[0]! * v[1]! - u[1]! * v[0]!,
        ];
        expect(
          n[0]! * mesh.normals[a! * 3]! +
            n[1]! * mesh.normals[a! * 3 + 1]! +
            n[2]! * mesh.normals[a! * 3 + 2]!,
        ).toBeGreaterThan(0);
      }
      const t = k.topology(box);
      for (const e of t.edges) {
        const pts = edgePoints(mesh, e.index);
        expect(pts).toHaveLength(2);
        const ends = e.vertices.map((v) => t.vertices[v - 1]!.point);
        for (const p of pts) {
          expect(ends.some((q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) < 1e-5)).toBe(
            true,
          );
        }
      }
    }));

  it('curved faces: circle polylines lie on the circle, finer deflection gives more triangles', () =>
    scoped(() => {
      const cyl = k.cylinder(3, 2);
      const coarse = k.mesh(cyl, { linear: 0.5, angular: 0.5 });
      const fine = k.mesh(cyl, { linear: 0.01, angular: 0.1 });
      expectValidMesh(coarse, 3, 3);
      expectValidMesh(fine, 3, 3);
      expect(fine.indices.length).toBeGreaterThan(coarse.indices.length);
      const t = k.topology(cyl);
      for (const e of t.edges.filter((x) => x.curve === 'circle')) {
        const pts = edgePoints(fine, e.index);
        expect(pts.length).toBeGreaterThan(8);
        for (const p of pts) expect(Math.hypot(p[0], p[1])).toBeCloseTo(3, 4);
      }
    }));

  it('meshing again gives the same mesh: the triangulation is not left on the shape', () =>
    scoped(() => {
      const body = k.fillet(k.box(10, 10, 10), [1, 2, 3], 1).shape;
      const a = k.mesh(body, { linear: 0.05, angular: 0.3 });
      const b = k.mesh(body, { linear: 0.05, angular: 0.3 });
      expect(b.indices.length).toBe(a.indices.length);
      expect([...b.positions]).toEqual([...a.positions]);
      const coarse = k.mesh(body, { linear: 1, angular: 1 });
      expect(coarse.indices.length).toBeLessThan(a.indices.length);
    }));

  it('rejects a bad deflection, and reports OCCT meshing errors', () =>
    scoped(() => {
      const box = k.box(1, 1, 1);
      expect(failure(() => k.mesh(box, { linear: 0, angular: 0.5 })).code).toBe('invalid-argument');
      expect(failure(() => k.mesh(box, { linear: 0.1, angular: -1 })).code).toBe(
        'invalid-argument',
      );
      const e = failure(() => k.mesh(box, { linear: 1e-300, angular: 0.5 }));
      expect(e.operation).toBe('tessellate');
      expect(e.occtType).toBe('Standard_NumericError');
      // The kernel still works afterwards.
      expectValidMesh(k.mesh(box), 6, 12);
    }));
});
