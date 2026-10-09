// Golden tests for the measure op: values from the exact B-rep against values
// computed by hand for boxes, cylinders and a slanted prism. One kernel for
// the whole file, plus the op through the service.

import { beforeAll, describe, expect, it } from 'vitest';
import type { ExtrudeInput } from './features';
import { XY, build, faceIndex, named, polygon, profile } from './fixtures/parts';
import type { Kernel } from './kernel';
import {
  measuredDistance,
  type MeasureItemReport,
  type MeasureResult,
  type MeasuredEdge,
  type MeasuredFace,
} from './measure';
import { createNodeKernel, createNodeService } from './node';
import type { ShapeId, Topology, Vec3 } from './types';

let k: Kernel;

beforeAll(async () => {
  k = await createNodeKernel();
}, 60_000);

const PI = Math.PI;
const DEG = PI / 180;
const TOL = 1e-6;

function near(actual: number, expected: number, tol = TOL): void {
  expect(Math.abs(actual - expected), `${actual} vs ${expected}`).toBeLessThanOrEqual(tol);
}

function nearVec(actual: Vec3 | null | undefined, expected: Vec3, tol = TOL): void {
  expect(actual).not.toBeNull();
  expected.forEach((c, i) => near(actual![i]!, c, tol));
}

function ok<T extends MeasureItemReport['kind']>(
  r: MeasureItemReport | undefined,
  kind: T,
): Extract<MeasureItemReport, { ok: true; kind: T }> {
  expect(r?.ok, JSON.stringify(r)).toBe(true);
  expect(r!.kind).toBe(kind);
  return r as Extract<MeasureItemReport, { ok: true; kind: T }>;
}

/** The 1-based index of the planar face with this outward normal and a point on it. */
function planeFace(t: Topology, normal: Vec3, at: number): number {
  const axis = normal.findIndex((c) => c !== 0);
  const f = t.faces.find(
    (x) =>
      x.normal !== null &&
      x.normal.every((c, i) => Math.abs(c - normal[i]!) < 1e-9) &&
      Math.abs(x.centroid[axis]! - at) < 1e-9,
  );
  expect(f, `face ${normal.join(',')} at ${at}`).toBeDefined();
  return f!.index;
}

/** The straight edge through both points (in either direction). */
function lineEdge(t: Topology, a: Vec3, b: Vec3): number {
  const mid: Vec3 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
  const e = t.edges.find(
    (x) => x.curve === 'line' && x.midpoint.every((c, i) => Math.abs(c - mid[i]!) < 1e-9),
  );
  expect(e, `edge through ${a} and ${b}`).toBeDefined();
  return e!.index;
}

function vertexAt(t: Topology, p: Vec3): number {
  const v = t.vertices.find((x) => x.point.every((c, i) => Math.abs(c - p[i]!) < 1e-9));
  expect(v, `vertex at ${p}`).toBeDefined();
  return v!.index;
}

describe('a 40 x 30 x 20 box at the origin', () => {
  let box: ShapeId;
  let t: Topology;
  beforeAll(() => {
    box = k.box(40, 30, 20);
    t = k.topology(box);
  });

  it('body: volume, area, centre of mass and a tight bounding box', () => {
    const r = k.measure(box, [], { body: true });
    near(r.body!.volume, 40 * 30 * 20);
    near(r.body!.area, 2 * (40 * 30 + 40 * 20 + 30 * 20));
    nearVec(r.body!.centerOfMass, [20, 15, 10]);
    nearVec(r.body!.boundingBox!.min, [0, 0, 0]);
    nearVec(r.body!.boundingBox!.max, [40, 30, 20]);
    expect(r.items).toEqual([]);
    expect(r.distance).toBeNull();
    expect(r.angle).toBeNull();
  });

  it('without body: true, no body properties', () => {
    expect(k.measure(box, []).body).toBeNull();
  });

  it('face-face: the front and back are 30 apart, parallel, normals opposite', () => {
    const front = planeFace(t, [0, -1, 0], 0);
    const back = planeFace(t, [0, 1, 0], 30);
    const r = k.measure(box, [
      { kind: 'face', index: front },
      { kind: 'face', index: back },
    ]);
    const f = ok(r.items[0], 'face');
    expect(f.surface).toBe('plane');
    near(f.area, 40 * 20);
    nearVec(f.centroid, [20, 0, 10]);
    nearVec(f.normal, [0, -1, 0]);
    near(r.distance!.value, 30);
    // Parallel planar faces: the distance between their planes too.
    near(r.distance!.planes!, 30);
    near(measuredDistance(r)!, 30);
    near(r.distance!.from[1], 0);
    near(r.distance!.to[1], 30);
    // The witness pair is the one nearest the middle of all solutions: square to both faces.
    near(r.distance!.from[0], r.distance!.to[0]);
    near(r.distance!.from[2], r.distance!.to[2]);
    expect(r.angle).toMatchObject({ between: 'planes' });
    near(r.angle!.value, 0);
    near(r.angle!.normals!, PI);
  });

  it('adjacent faces touch (distance 0) at 90 degrees', () => {
    const r = k.measure(box, [
      { kind: 'face', index: planeFace(t, [0, 0, 1], 20) },
      { kind: 'face', index: planeFace(t, [0, -1, 0], 0) },
    ]);
    near(r.distance!.value, 0);
    expect(r.distance!.planes).toBeNull();
    near(r.angle!.value, 90 * DEG);
    near(r.angle!.normals!, 90 * DEG);
  });

  it('vertex-face: a bottom corner is 20 below the top face, witness straight above', () => {
    const r = k.measure(box, [
      { kind: 'vertex', index: vertexAt(t, [40, 0, 0]) },
      { kind: 'face', index: planeFace(t, [0, 0, 1], 20) },
    ]);
    nearVec(ok(r.items[0], 'vertex').point, [40, 0, 0]);
    near(r.distance!.value, 20);
    nearVec(r.distance!.from, [40, 0, 0]);
    nearVec(r.distance!.to, [40, 0, 20]);
    expect(r.angle).toBeNull();
  });

  it('edge length and direction, and the angle between a line and a plane', () => {
    const vertical = lineEdge(t, [40, 0, 0], [40, 0, 20]);
    const r = k.measure(box, [
      { kind: 'edge', index: vertical },
      { kind: 'face', index: planeFace(t, [0, 0, 1], 20) },
    ]);
    const e = ok(r.items[0], 'edge');
    expect(e.curve).toBe('line');
    near(e.length, 20);
    near(Math.abs(e.direction![2]), 1);
    nearVec(e.midpoint, [40, 0, 10]);
    expect(r.angle).toMatchObject({ between: 'line-plane', normals: null });
    near(r.angle!.value, 90 * DEG);
    near(r.distance!.value, 0);
  });

  it('reports a target that is not on the body, and measures no pair then', () => {
    const r = k.measure(box, [
      { kind: 'face', index: 99 },
      { kind: 'face', index: 1 },
    ]);
    expect(r.items[0]).toMatchObject({ ok: false, kind: 'face', status: 'not-found' });
    expect(r.items[1]!.ok).toBe(true);
    expect(r.distance).toBeNull();
    const named = k.measure(box, [{ kind: 'face', name: 'extrude#1:cap:end' }]);
    expect(named.items[0]).toMatchObject({ ok: false, status: 'not-found' });
  });
});

describe('two boxes, one compound', () => {
  // A: 40 x 30 x 20 at the origin. B: 10 x 20 x 10 at (15, 25, 30), above A's back edge.
  let body: ShapeId;
  let t: Topology;
  beforeAll(() => {
    const a = k.box(40, 30, 20);
    const b = k.box(10, 20, 10, [15, 25, 30]);
    body = k.compound([a, b]).shape;
    k.release(a);
    k.release(b);
    t = k.topology(body);
  });

  it('edge-edge, skew: A top back edge (along x) and B bottom left edge (along y) are 10 apart', () => {
    const aEdge = lineEdge(t, [0, 30, 20], [40, 30, 20]);
    const bEdge = lineEdge(t, [15, 25, 30], [15, 45, 30]);
    const r = k.measure(body, [
      { kind: 'edge', index: aEdge },
      { kind: 'edge', index: bEdge },
    ]);
    // The closest points are inside both edges, not at an end.
    near(r.distance!.value, 10);
    nearVec(r.distance!.from, [15, 30, 20]);
    nearVec(r.distance!.to, [15, 30, 30]);
    expect(r.distance!.solutions).toBe(1);
    expect(r.angle).toMatchObject({ between: 'lines', normals: null });
    near(r.angle!.value, 90 * DEG);
  });

  it('vertex-face off the face: the nearest point is on its boundary', () => {
    // B's corner (25, 45, 40) projects outside A's top face (y <= 30): nearest (25, 30, 20).
    const r = k.measure(body, [
      { kind: 'vertex', index: vertexAt(t, [25, 45, 40]) },
      { kind: 'face', index: planeFace(t, [0, 0, 1], 20) },
    ]);
    near(r.distance!.value, Math.hypot(15, 20));
    nearVec(r.distance!.to, [25, 30, 20]);
  });

  it('face-face over a partial overlap: A top to B bottom is 10', () => {
    const r = k.measure(body, [
      { kind: 'face', index: planeFace(t, [0, 0, 1], 20) },
      { kind: 'face', index: planeFace(t, [0, 0, -1], 30) },
    ]);
    near(r.distance!.value, 10);
    near(r.distance!.from[2], 20);
    near(r.distance!.to[2], 30);
    // Inside the overlap: x in [15, 25], y in [25, 30].
    expect(r.distance!.from[0]).toBeGreaterThanOrEqual(15 - TOL);
    expect(r.distance!.from[0]).toBeLessThanOrEqual(25 + TOL);
    expect(r.distance!.from[1]).toBeGreaterThanOrEqual(25 - TOL);
    expect(r.distance!.from[1]).toBeLessThanOrEqual(30 + TOL);
  });

  it('the body adds up both boxes', () => {
    const r = k.measure(body, [], { body: true });
    near(r.body!.volume, 24000 + 2000);
    // Centre of mass: (24000 * (20, 15, 10) + 2000 * (20, 35, 35)) / 26000.
    nearVec(r.body!.centerOfMass, [
      20,
      (24000 * 15 + 2000 * 35) / 26000,
      (24000 * 10 + 2000 * 35) / 26000,
    ]);
    nearVec(r.body!.boundingBox!.min, [0, 0, 0]);
    nearVec(r.body!.boundingBox!.max, [40, 45, 40]);
  });
});

describe('a cylinder, radius 5, height 12', () => {
  let cyl: ShapeId;
  let t: Topology;
  beforeAll(() => {
    cyl = k.cylinder(5, 12);
    t = k.topology(cyl);
  });

  it('body: volume pi r2 h, area 2 pi r h + 2 pi r2, centre of mass on the axis at h / 2', () => {
    const r = k.measure(cyl, [], { body: true });
    near(r.body!.volume, PI * 25 * 12);
    near(r.body!.area, 2 * PI * 5 * 12 + 2 * PI * 25);
    nearVec(r.body!.centerOfMass, [0, 0, 6]);
    nearVec(r.body!.boundingBox!.min, [-5, -5, 0]);
    nearVec(r.body!.boundingBox!.max, [5, 5, 12]);
  });

  it('the side face: radius, axis, area', () => {
    const side = t.faces.find((f) => f.surface === 'cylinder')!.index;
    const f: MeasuredFace = ok(k.measure(cyl, [{ kind: 'face', index: side }]).items[0], 'face');
    expect(f.surface).toBe('cylinder');
    near(f.radius!, 5);
    near(f.area, 2 * PI * 5 * 12);
    near(Math.abs(f.axis!.direction[2]), 1);
    near(f.axis!.origin[0], 0);
    near(f.axis!.origin[1], 0);
  });

  it('a rim: a full circle, radius 5, length 2 pi r, sweep 2 pi', () => {
    const rim = t.edges.find((e) => e.curve === 'circle' && Math.abs(e.midpoint[2] - 12) < 1e-9)!;
    const e: MeasuredEdge = ok(
      k.measure(cyl, [{ kind: 'edge', index: rim.index }]).items[0],
      'edge',
    );
    expect(e.curve).toBe('circle');
    near(e.circle!.radius, 5);
    nearVec(e.circle!.center, [0, 0, 12]);
    near(Math.abs(e.circle!.axis[2]), 1);
    near(e.circle!.sweep, 2 * PI);
    near(e.length, 2 * PI * 5);
  });

  it('the rims are 12 apart; the axis is square to the caps', () => {
    const [bottom, top] = t.edges
      .filter((e) => e.curve === 'circle')
      .sort((a, b) => a.midpoint[2] - b.midpoint[2]);
    const r = k.measure(cyl, [
      { kind: 'edge', index: bottom!.index },
      { kind: 'edge', index: top!.index },
    ]);
    near(r.distance!.value, 12);
    const side = t.faces.find((f) => f.surface === 'cylinder')!.index;
    const cap = t.faces.find((f) => f.surface === 'plane')!.index;
    const a = k.measure(cyl, [
      { kind: 'face', index: side },
      { kind: 'face', index: cap },
    ]);
    expect(a.angle).toMatchObject({ between: 'line-plane' });
    near(a.angle!.value, 90 * DEG);
  });
});

describe('a named body: a prism with a slanted side and a and named faces', () => {
  // Profile: (0,0) e1 (40,0) e2 (40,10) e3 (0,30) e4 back to (0,0); extruded 10 up.
  const prism: ExtrudeInput = {
    kind: 'extrude',
    id: 'extrude#1',
    profile: profile(
      XY,
      polygon(
        [
          [0, 0],
          [40, 0],
          [40, 10],
          [0, 30],
        ],
        ['e1', 'e2', 'e3', 'e4'],
      ),
    ),
    extent: { type: 'blind', distance: 10 },
    mode: 'new',
  };
  let shape: ShapeId;
  beforeAll(() => {
    shape = build(k, [prism]).shape;
  });

  it('measures by name: faces and edges of the naming layer', () => {
    const r = k.measure(shape, [
      { kind: 'face', name: 'extrude#1:side:e1' },
      { kind: 'face', name: 'extrude#1:side:e3' },
    ]);
    const a = ok(r.items[0], 'face');
    expect(a.name).toBe('extrude#1:side:e1');
    expect(a.index).toBe(faceIndex(named(k, shape), 'extrude#1:side:e1'));
    near(a.area, 40 * 10);
    // e3 runs (40,10) to (0,30): 20 * sqrt(5) long, outward normal (1, 2, 0) / sqrt(5).
    near(ok(r.items[1], 'face').area, 20 * Math.sqrt(5) * 10);
    // Normals (0,-1,0) and (1,2,0)/sqrt(5): cos = -2 / sqrt(5).
    near(r.angle!.normals!, Math.acos(-2 / Math.sqrt(5)));
    near(r.angle!.value, Math.atan(1 / 2));
  });

  it('edges by name: the angle between the bottom edges of e1 and e3 is atan(1/2)', () => {
    const r = k.measure(shape, [
      { kind: 'edge', name: 'extrude#1:cap:start|extrude#1:side:e1' },
      { kind: 'edge', name: 'extrude#1:cap:start|extrude#1:side:e3' },
    ]);
    near(ok(r.items[0], 'edge').length, 40);
    near(ok(r.items[1], 'edge').length, 20 * Math.sqrt(5));
    near(r.angle!.value, Math.atan(1 / 2));
    // They do not meet: e2 lies between them. The nearest points are (40, 0) and (40, 10).
    near(r.distance!.value, 10);
  });

  it('vertices by the names of the faces around them; unknown names are reported', () => {
    const r = k.measure(shape, [
      { kind: 'vertex', name: 'extrude#1:cap:end&extrude#1:side:e1&extrude#1:side:e2' },
      { kind: 'edge', name: 'no|such' },
    ]);
    nearVec(ok(r.items[0], 'vertex').point, [40, 0, 10]);
    expect(r.items[1]).toMatchObject({ ok: false, kind: 'edge', status: 'not-found' });
  });

  it('body: the trapezoid area times the height', () => {
    const r = k.measure(shape, [], { body: true });
    near(r.body!.volume, ((10 + 30) / 2) * 40 * 10);
  });
});

describe('an arc edge', () => {
  it('a rounded slot end: an arc of radius 10 spanning pi', () => {
    const slot: ExtrudeInput = {
      kind: 'extrude',
      id: 'extrude#1',
      profile: profile(XY, [
        { kind: 'line', id: 'e1', start: [0, 0], end: [30, 0] },
        { kind: 'arc', id: 'a1', center: [30, 10], start: [30, 0], end: [30, 20] },
        { kind: 'line', id: 'e2', start: [30, 20], end: [0, 20] },
        { kind: 'line', id: 'e3', start: [0, 20], end: [0, 0] },
      ]),
      extent: { type: 'blind', distance: 5 },
      mode: 'new',
    };
    const shape = build(k, [slot]).shape;
    const r = k.measure(shape, [
      { kind: 'edge', name: 'extrude#1:cap:end|extrude#1:side:a1' },
      { kind: 'face', name: 'extrude#1:side:a1' },
    ]);
    const e = ok(r.items[0], 'edge');
    near(e.circle!.radius, 10);
    near(e.circle!.sweep, PI);
    nearVec(e.circle!.center, [30, 10, 5]);
    near(e.length, PI * 10);
    const f = ok(r.items[1], 'face');
    near(f.radius!, 10);
    near(f.area, PI * 10 * 5);
    const body = k.measure(shape, [], { body: true }).body!;
    near(body.volume, (30 * 20 + (PI * 100) / 2) * 5);
    // Centroid of a half disc: 4r / (3 pi) beyond its diameter.
    const cx = (600 * 15 + ((PI * 100) / 2) * (30 + 40 / (3 * PI))) / (600 + (PI * 100) / 2);
    nearVec(body.centerOfMass, [cx, 10, 2.5]);
  });
});

describe('faces of two bodies', () => {
  // Two named slabs 10 thick, side by side in the same coordinates: extrude#1 from x 0 to 40,
  // extrude#2 from x 60 to 80, both y 0 to 30. Then two unnamed boxes, one offset sideways.
  const slab = (id: string, x0: number, x1: number): ExtrudeInput => ({
    kind: 'extrude',
    id,
    profile: profile(
      XY,
      polygon(
        [
          [x0, 0],
          [x1, 0],
          [x1, 30],
          [x0, 30],
        ],
        ['e1', 'e2', 'e3', 'e4'],
      ),
    ),
    extent: { type: 'blind', distance: 10 },
    mode: 'new',
  });
  let a: ShapeId;
  let b: ShapeId;
  beforeAll(() => {
    a = build(k, [slab('extrude#1', 0, 40)]).shape;
    b = build(k, [slab('extrude#2', 60, 80)]).shape;
  });

  it('facing sides by name: 20 apart, parallel, whichever body is measured', () => {
    // e2 runs up x = 40 on the first (normal +x); e4 runs down x = 60 on the second (normal -x).
    const r = k.measure(a, [
      { kind: 'face', name: 'extrude#1:side:e2' },
      { kind: 'face', name: 'extrude#2:side:e4', shape: b },
    ]);
    nearVec(ok(r.items[0], 'face').normal, [1, 0, 0]);
    const far = ok(r.items[1], 'face');
    expect(far.name).toBe('extrude#2:side:e4');
    expect(far.index).toBe(faceIndex(named(k, b), 'extrude#2:side:e4'));
    nearVec(far.normal, [-1, 0, 0]);
    near(r.distance!.value, 20);
    near(r.distance!.planes!, 20);
    near(r.distance!.from[0], 40);
    near(r.distance!.to[0], 60);
    expect(r.angle).toMatchObject({ between: 'planes' });
    near(r.angle!.value, 0);
    near(r.angle!.normals!, PI);
    // The same with the second body measured and the first named on its own shape.
    const back = k.measure(b, [
      { kind: 'face', name: 'extrude#2:side:e4' },
      { kind: 'face', name: 'extrude#1:side:e2', shape: a },
    ]);
    near(back.distance!.value, 20);
    near(back.distance!.planes!, 20);
  });

  it("a name looks only on its own body: the other body's names are not found", () => {
    const r = k.measure(a, [
      { kind: 'face', name: 'extrude#2:side:e4' },
      { kind: 'face', name: 'extrude#1:side:e2', shape: b },
    ]);
    expect(r.items[0]).toMatchObject({ ok: false, status: 'not-found' });
    expect(r.items[1]).toMatchObject({ ok: false, status: 'not-found' });
    expect(r.distance).toBeNull();
    expect(r.angle).toBeNull();
  });

  it('a top and a side across bodies: the minimum distance at 90 degrees, no plane distance', () => {
    const r = k.measure(a, [
      { kind: 'face', name: 'extrude#1:cap:end' },
      { kind: 'face', name: 'extrude#2:side:e4', shape: b },
    ]);
    // The top (z = 10, x up to 40) and the side (x = 60, z 0 to 10) meet nowhere: 20 apart.
    near(r.distance!.value, 20);
    expect(r.distance!.planes).toBeNull();
    near(measuredDistance(r)!, 20);
    near(r.angle!.value, 90 * DEG);
  });

  it('parallel faces offset sideways: the planes are nearer than the faces', () => {
    const p = k.box(10, 10, 10);
    const q = k.box(10, 10, 10, [30, 20, 0]);
    const tp = k.topology(p);
    const tq = k.topology(q);
    const r = k.measure(p, [
      { kind: 'face', index: planeFace(tp, [1, 0, 0], 10) },
      { kind: 'face', index: planeFace(tq, [-1, 0, 0], 30), shape: q },
    ]);
    near(r.distance!.value, Math.hypot(20, 10));
    near(r.distance!.planes!, 20);
    near(measuredDistance(r)!, 20);
    // The body measure is of the measured shape only.
    const body = k.measure(p, [{ kind: 'vertex', index: 1, shape: q }], { body: true });
    near(body.body!.volume, 1000);
    nearVec(body.body!.boundingBox!.max, [10, 10, 10]);
    expect(ok(body.items[0], 'vertex').point[1]).toBeGreaterThanOrEqual(20 - TOL);
    k.release(p);
    k.release(q);
  });
});

describe('the measure op through the service', () => {
  it('measures a box made earlier in the batch, and reports bad ops as invalid-op', async () => {
    const service = await createNodeService();
    const reply = await service.run({
      generation: 1,
      ops: [
        { op: 'box', size: [10, 20, 30], keep: false },
        { op: 'measure', shape: { result: 0 }, targets: [{ kind: 'face', index: 1 }], body: true },
        { op: 'measure', shape: { result: 0 }, targets: [{ kind: 'solid', index: 1 }] } as never,
      ],
    });
    expect(reply.status).toBe('done');
    const measured = reply.results[1]!;
    expect(measured.ok).toBe(true);
    const value = (measured as { value: MeasureResult }).value;
    near(value.body!.volume, 6000);
    expect(value.items[0]!.ok).toBe(true);
    expect(reply.results[2]).toMatchObject({ ok: false, error: { code: 'invalid-op' } });
    expect(service.kernel.shapeCount).toBe(0);
  });

  it('measures between two boxes of the batch, a target naming its own shape', async () => {
    const service = await createNodeService();
    const reply = await service.run({
      generation: 1,
      ops: [
        { op: 'box', size: [10, 10, 10], keep: false },
        { op: 'box', size: [10, 10, 10], at: [0, 0, 25], keep: false },
        {
          op: 'measure',
          shape: { result: 0 },
          targets: [
            { kind: 'vertex', index: 1 },
            { kind: 'vertex', index: 1, shape: { result: 1 } },
          ],
        },
        {
          op: 'measure',
          shape: { result: 0 },
          targets: [{ kind: 'face', index: 1, shape: 'box' }],
        } as never,
      ],
    });
    expect(reply.status).toBe('done');
    const value = (reply.results[2] as { value: MeasureResult }).value;
    near(value.distance!.value, 25);
    expect(reply.results[3]).toMatchObject({ ok: false, error: { code: 'invalid-op' } });
    expect(service.kernel.shapeCount).toBe(0);
  });
});
