// Golden tests for planar face loops and plane sections (T5.1e): the outline of a planar face as
// exact lines and arcs in a frame's 2D coordinates, tagged with edge names, and the section of a
// body by a plane, nested into regions. Values are computed by hand from the models.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FeatureInput } from '../src/features';
import { XY, build, circle, named, polygon, profile, rectangle } from '../src/fixtures/parts';
import { holeSize } from '../src/holes';
import type { Kernel } from '../src/kernel';
import type { FaceLoopsReport, Loop, LoopSegment, SectionLoops } from '../src/loops';
import { createNodeKernel, createNodeService } from '../src/node';
import type { KernelOp } from '../src/ops';
import type { KernelService } from '../src/service';
import type { Frame, ShapeId, Vec2 } from '../src/types';

let k: Kernel;
let service: KernelService;
let generation = 0;

beforeAll(async () => {
  k = await createNodeKernel();
  service = await createNodeService();
}, 60_000);

const PI = Math.PI;
const EPS = 1e-9;

type Found = Extract<FaceLoopsReport, { ok: true }>;

function found(report: FaceLoopsReport): Found {
  expect(report.ok, JSON.stringify(report)).toBe(true);
  return report as Found;
}

const kinds = (loop: Loop) => loop.segments.map((c) => c.kind);
const startOf = (c: LoopSegment): Vec2 => (c.kind === 'polyline' ? c.points[0]! : c.start);
const endOf = (c: LoopSegment): Vec2 => (c.kind === 'polyline' ? c.points.at(-1)! : c.end);

/** Every segment starts exactly where the one before ends, the last closing on the first. */
function expectChained(loop: Loop): void {
  loop.segments.forEach((c, i) => {
    const before = loop.segments.at(i - 1)!;
    expect(startOf(c)).toEqual(endOf(before));
  });
}

/** Arcs' ends are on their circle, at the angle their sweep says. */
function expectArcsConsistent(loop: Loop): void {
  for (const c of loop.segments) {
    if (c.kind !== 'arc') continue;
    for (const q of [c.start, c.end]) {
      expect(Math.hypot(q[0] - c.center[0], q[1] - c.center[1])).toBeCloseTo(c.radius, 6);
    }
    const a0 = Math.atan2(c.start[1] - c.center[1], c.start[0] - c.center[0]);
    const t = a0 + c.sweep;
    expect(c.center[0] + c.radius * Math.cos(t)).toBeCloseTo(c.end[0], 6);
    expect(c.center[1] + c.radius * Math.sin(t)).toBeCloseTo(c.end[1], 6);
  }
}

function expectLoop(loop: Loop, area: number, ccw: boolean): void {
  expectChained(loop);
  expectArcsConsistent(loop);
  expect(loop.area).toBeCloseTo(ccw ? area : -area, 6);
}

const block: FeatureInput = {
  kind: 'extrude',
  id: 'extrude#1',
  profile: profile(XY, rectangle(0, 0, 40, 30)),
  extent: { type: 'blind', distance: 20 },
  mode: 'new',
};

const holed: FeatureInput = {
  ...block,
  profile: profile(XY, rectangle(0, 0, 40, 30), circle([12, 15], 5, 'h1')),
};

describe('the bindings', () => {
  it('BRepTools.OuterWire and BRepTools_WireExplorer are bound and follow the wire', () => {
    const oc = k.oc;
    const box = k.box(10, 20, 30);
    // Through the raw bindings, as faceLoops uses them: the top face's outer wire, explored.
    const top = k.faceLoops(box, { index: 6 }, XY);
    expect(found(top).height).toBeCloseTo(30, 12);
    const shape = new oc.BRepPrimAPI_MakeBox(10, 20, 30);
    const solid = shape.Shape();
    const faces = new oc.NCollection_IndexedMap_TopoDS_Shape_TopTools_ShapeMapHasher();
    oc.TopExp.MapShapes(solid, oc.TopAbs_ShapeEnum.TopAbs_FACE, faces);
    const face = oc.TopoDS.Face(faces.FindKey(1));
    const wire = oc.BRepTools.OuterWire(face);
    expect(wire.IsNull()).toBe(false);
    const explorer = new oc.BRepTools_WireExplorer(wire, face);
    const ends: [number, number, number][][] = [];
    for (; explorer.More(); explorer.Next()) {
      const edge = explorer.Current();
      const a = oc.BRep_Tool.Pnt(explorer.CurrentVertex());
      ends.push([[a.X(), a.Y(), a.Z()]]);
      a.delete();
      edge.Nullify();
      edge.delete();
    }
    expect(ends).toHaveLength(4);
    // The vertices the explorer reports are the four distinct corners of a rectangle.
    expect(new Set(ends.map((e) => e[0]!.join(','))).size).toBe(4);
    for (const x of [explorer, wire, face, solid, faces, shape]) {
      if ('Nullify' in x) (x as { Nullify(): void }).Nullify();
      x.delete();
    }
    k.release(box);
  });
});

describe('face loops', () => {
  it('a box top face: four lines, counter-clockwise, every edge named', () => {
    const body = build(k, [block]).shape;
    const r = found(k.faceLoops(body, { name: 'extrude#1:cap:end' }, XY));
    expect(r.face).toEqual({ index: expect.any(Number), name: 'extrude#1:cap:end' });
    expect(r.height).toBeCloseTo(20, 12);
    expect(r.facing).toBe(true);
    expect(kinds(r.outer)).toEqual(['line', 'line', 'line', 'line']);
    expect(r.holes).toEqual([]);
    expectLoop(r.outer, 1200, true);
    const corners = r.outer.segments.map((c) =>
      startOf(c)
        .map((v) => Math.round(v))
        .join(','),
    );
    expect(new Set(corners)).toEqual(new Set(['0,0', '40,0', '40,30', '0,30']));
    // Each line is tagged with its edge: an index and the naming layer's name.
    const b = named(k, body);
    for (const c of r.outer.segments) {
      expect(c.edge!.name).toBe(b.names.edges[c.edge!.index - 1]!.name);
      expect(c.edge!.name).toMatch(/extrude#1:cap:end/);
    }
    expect(new Set(r.outer.segments.map((c) => c.edge!.name)).size).toBe(4);
    k.release(body);
  });

  it('the same face by index, and the bottom face seen from above (stored reversed)', () => {
    const box = k.box(40, 30, 20);
    const topology = k.topology(box);
    const at = (z: number) =>
      topology.faces.find((f) => f.surface === 'plane' && Math.abs(f.centroid[2] - z) < EPS)!;
    const top = found(k.faceLoops(box, { index: at(20).index }, XY));
    expect(top.face).toEqual({ index: at(20).index, name: null });
    expect(top.outer.segments.every((c) => c.edge!.name === null)).toBe(true);
    expectLoop(top.outer, 1200, true);
    const bottom = found(k.faceLoops(box, { index: at(0).index }, XY));
    // Its outward normal points down, against the frame; the loop still runs counter-clockwise.
    expect(bottom.facing).toBe(false);
    expect(bottom.height).toBeCloseTo(0, 12);
    expectLoop(bottom.outer, 1200, true);
    // Seen from below (normal -Z, x kept): counter-clockwise in that frame too.
    const below: Frame = { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, -1] };
    const flipped = found(k.faceLoops(box, { index: at(20).index }, below));
    expect(flipped.facing).toBe(false);
    expect(flipped.height).toBeCloseTo(-20, 12);
    expectLoop(flipped.outer, 1200, true);
    // y = normal x x = -Y, so the corners land at negated y.
    const ys = flipped.outer.segments.map((c) => Math.round(startOf(c)[1]));
    expect(new Set(ys)).toEqual(new Set([0, -30]));
    k.release(box);
  });

  it('a face with a through hole: an outer loop and one clockwise circle', () => {
    const body = build(k, [holed]).shape;
    const frame: Frame = { origin: [5, 5, 0], xDir: [1, 0, 0], normal: [0, 0, 1] };
    const r = found(k.faceLoops(body, { name: 'extrude#1:cap:end' }, frame));
    expect(kinds(r.outer)).toEqual(['line', 'line', 'line', 'line']);
    expectLoop(r.outer, 1200, true);
    expect(r.holes).toHaveLength(1);
    const hole = r.holes[0]!;
    expect(kinds(hole)).toEqual(['arc']);
    expectLoop(hole, 25 * PI, false);
    const arc = hole.segments[0] as Extract<LoopSegment, { kind: 'arc' }>;
    expect(arc.center[0]).toBeCloseTo(7, 9);
    expect(arc.center[1]).toBeCloseTo(10, 9);
    expect(arc.radius).toBeCloseTo(5, 9);
    expect(arc.sweep).toBeCloseTo(-2 * PI, 9);
    expect(arc.start).toEqual(arc.end);
    expect(arc.edge!.name).toMatch(/side:h1/);
    k.release(body);
  });

  it('refuses faces that are missing, not planar or not parallel, and bad frames', () => {
    const body = build(k, [holed]).shape;
    expect(k.faceLoops(body, { name: 'extrude#1:cap:middle' }, XY)).toMatchObject({
      ok: false,
      status: 'not-found',
    });
    expect(k.faceLoops(body, { index: 99 }, XY)).toMatchObject({ ok: false, status: 'not-found' });
    expect(k.faceLoops(body, { name: 'extrude#1:side:h1' }, XY)).toMatchObject({
      ok: false,
      status: 'not-planar',
      message: 'extrude#1:side:h1 is not planar',
    });
    expect(k.faceLoops(body, { name: 'extrude#1:side:e1' }, XY)).toMatchObject({
      ok: false,
      status: 'not-parallel',
    });
    const bad: Frame = { origin: [0, 0, 0], xDir: [0, 0, 2], normal: [0, 0, 1] };
    expect(() => k.faceLoops(body, { index: 1 }, bad)).toThrow(/xDir must not be parallel/);
    expect(() => k.faceLoops(body, { index: 1 }, XY, 0)).toThrow(/deflection/);
    expect(() => k.section(body, XY, Number.NaN)).toThrow(/height/);
    k.release(body);
  });
});

// The M1 bracket (test/bracket.test.ts): an L on Front, two counterbored M4 holes through the
// foot from its top, a 4 mm fillet in the inside corner.
const L = 50;
const H = 40;
const W = 30;
const R = 4;
const T = 6;
const M4 = holeSize('M4')!;
const d = M4.clearance.normal;
const cb = M4.counterbore;
const FRONT: Frame = { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, -1, 0] };
const TOP = 'extrude#1:side:e3';
const INSIDE = 'extrude#1:side:e4';

const bracket: FeatureInput[] = [
  {
    kind: 'extrude',
    id: 'extrude#1',
    profile: profile(
      FRONT,
      polygon(
        [
          [0, 0],
          [L, 0],
          [L, T],
          [T, T],
          [T, H],
          [0, H],
        ],
        ['e1', 'e2', 'e3', 'e4', 'e5', 'e6'],
      ),
    ),
    extent: { type: 'symmetric', distance: W },
    mode: 'new',
  },
  {
    kind: 'hole',
    id: 'hole#1',
    frame: { origin: [0, 0, T], xDir: [1, 0, 0], normal: [0, 0, 1] },
    points: [
      { id: 'e7', at: [25, 0] },
      { id: 'e8', at: [40, 0] },
    ],
    diameter: d,
    extent: { type: 'throughAll' },
    head: { type: 'counterbore', diameter: cb.diameter, depth: cb.depth },
  },
  {
    kind: 'fillet',
    id: 'fillet#1',
    radius: R,
    edges: [{ id: 'r2', ref: { faces: [TOP, INSIDE] } }],
  },
];

describe('the M1 bracket', () => {
  let body: ShapeId;
  beforeAll(() => {
    body = build(k, bracket).shape;
  });
  afterAll(() => {
    k.release(body);
  });

  it("the foot's top: a rectangle with the two counterbores as circular holes", () => {
    const r = found(k.faceLoops(body, { name: TOP }, XY));
    expect(r.height).toBeCloseTo(T, 9);
    expect(kinds(r.outer)).toEqual(['line', 'line', 'line', 'line']);
    expectLoop(r.outer, (L - T - R) * W, true);
    const xs = r.outer.segments.map((c) => startOf(c)[0]);
    expect(Math.min(...xs)).toBeCloseTo(T + R, 9);
    expect(Math.max(...xs)).toBeCloseTo(L, 9);
    // The fillet's boundary line is tagged with the edge the round shares with the foot's top.
    const names = r.outer.segments.map((c) => c.edge!.name!);
    expect(names.some((n) => n.includes('fillet#1:round:r2'))).toBe(true);
    expect(r.holes).toHaveLength(2);
    const centres = r.holes.map((h) => {
      expect(kinds(h)).toEqual(['arc']);
      expectLoop(h, PI * (cb.diameter / 2) ** 2, false);
      const arc = h.segments[0] as Extract<LoopSegment, { kind: 'arc' }>;
      expect(arc.radius).toBeCloseTo(cb.diameter / 2, 9);
      expect(arc.edge!.name).toMatch(/hole#1:cbore:e[78]/);
      return arc.center;
    });
    const sorted = centres.map((c) => [Math.round(c[0] * 1e6) / 1e6, Math.round(c[1] * 1e6) / 1e6]);
    sorted.sort((a, b) => a[0]! - b[0]!);
    expect(sorted).toEqual([
      [25, 0],
      [40, 0],
    ]);
  });

  it("a filleted edge's neighbour face: lines meeting an arc", () => {
    // The end cap at y = -15 faces -Y, along FRONT's normal.
    const caps = ['extrude#1:cap:start', 'extrude#1:cap:end'].map((name) =>
      found(k.faceLoops(body, { name }, FRONT)),
    );
    const near = caps.find((c) => c.facing)!;
    expect(near.height).toBeCloseTo(W / 2, 9);
    const r = near.outer;
    expect(kinds(r).filter((x) => x === 'line')).toHaveLength(6);
    expect(kinds(r).filter((x) => x === 'arc')).toHaveLength(1);
    expectLoop(r, L * T + (H - T) * T + R * R * (1 - PI / 4), true);
    const i = r.segments.findIndex((c) => c.kind === 'arc');
    const arc = r.segments[i] as Extract<LoopSegment, { kind: 'arc' }>;
    expect(arc.radius).toBeCloseTo(R, 9);
    expect(arc.center[0]).toBeCloseTo(T + R, 9);
    expect(arc.center[1]).toBeCloseTo(T + R, 9);
    // The inside corner is concave: the counter-clockwise outline turns clockwise round it.
    expect(arc.sweep).toBeCloseTo(-PI / 2, 9);
    // Tangent to the lines either side: each meets the arc at its end and is perpendicular to the radius.
    for (const [line, at] of [
      [r.segments.at(i - 1)!, arc.start],
      [r.segments[(i + 1) % r.segments.length]!, arc.end],
    ] as const) {
      expect(line.kind).toBe('line');
      const l = line as Extract<LoopSegment, { kind: 'line' }>;
      const dir = [l.end[0] - l.start[0], l.end[1] - l.start[1]];
      const radial = [at[0] - arc.center[0], at[1] - arc.center[1]];
      expect(dir[0]! * radial[0]! + dir[1]! * radial[1]!).toBeCloseTo(0, 9);
    }
    expect(near.holes).toEqual([]);
    // The far cap from the same side: the same outline, still counter-clockwise in the frame.
    const far = caps.find((c) => !c.facing)!;
    expect(far.height).toBeCloseTo(-W / 2, 9);
    expectLoop(far.outer, L * T + (H - T) * T + R * R * (1 - PI / 4), true);
  });

  it('sections: through the foot below the counterbores, and across the fillet', () => {
    const low = k.section(body, XY, 1);
    expect(low.open).toEqual([]);
    expect(low.regions).toHaveLength(1);
    const foot = low.regions[0]!;
    expect(kinds(foot.outer)).toEqual(['line', 'line', 'line', 'line']);
    expectLoop(foot.outer, L * W, true);
    expect(foot.holes).toHaveLength(2);
    for (const h of foot.holes) {
      expect(kinds(h).every((x) => x === 'arc')).toBe(true);
      expectLoop(h, PI * (d / 2) ** 2, false);
      for (const c of h.segments) expect(c.face!.name).toMatch(/^hole#1:wall:e[78]$/);
    }
    const walls = new Set(foot.outer.segments.map((c) => c.face!.name));
    expect(walls).toEqual(
      new Set([
        'extrude#1:side:e2',
        'extrude#1:side:e6',
        'extrude#1:cap:start',
        'extrude#1:cap:end',
      ]),
    );

    // Two millimetres above the foot the plane crosses the round: a rectangle to its far line.
    const z = T + 2;
    const reach = T + R - Math.sqrt(R * R - (R - 2) ** 2);
    const up = k.section(body, XY, z);
    expect(up.height).toBe(z);
    expect(up.regions).toHaveLength(1);
    expectLoop(up.regions[0]!.outer, reach * W, true);
    const round = up.regions[0]!.outer.segments.filter((c) => c.face?.name === 'fillet#1:round:r2');
    expect(round).toHaveLength(1);
    const line = round[0] as Extract<LoopSegment, { kind: 'line' }>;
    expect(line.start[0]).toBeCloseTo(reach, 6);
    expect(line.end[0]).toBeCloseTo(reach, 6);
  });

  it('a section through the hole axes: the L with both counterbored holes notched out', () => {
    const s = k.section(body, FRONT, 0);
    const area =
      L * T +
      (H - T) * T +
      R * R * (1 - PI / 4) -
      2 * (cb.diameter * cb.depth + d * (T - cb.depth));
    const total = s.regions.reduce(
      (sum, r) => sum + r.outer.area + r.holes.reduce((a, h) => a + h.area, 0),
      0,
    );
    expect(total).toBeCloseTo(area, 6);
    for (const r of s.regions) expectLoop(r.outer, r.outer.area, true);
    // The holes split the foot: three pieces of foot, the first joined to the upright.
    expect(s.regions).toHaveLength(3);
    expect(s.open).toEqual([]);
  });

  it('a plane that misses the body gives no loops', () => {
    expect(k.section(body, XY, H + 1)).toEqual({ height: H + 1, regions: [], open: [] });
  });
});

describe('curves that are not lines or circles', () => {
  // A cubic Bezier side: (20, 0) out to x = 30 and back to (20, 20).
  const bezier: Vec2[] = [
    [20, 0],
    [30, 5],
    [30, 15],
    [20, 20],
  ];
  const bezierAt = (t: number): Vec2 => {
    const u = 1 - t;
    const w = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
    return [
      w.reduce((s, c, i) => s + c * bezier[i]![0], 0),
      w.reduce((s, c, i) => s + c * bezier[i]![1], 0),
    ];
  };
  const toSegment = (p: Vec2, a: Vec2, b: Vec2) => {
    const ab = [b[0] - a[0], b[1] - a[1]];
    const len2 = ab[0]! ** 2 + ab[1]! ** 2;
    const t =
      len2 === 0
        ? 0
        : Math.max(0, Math.min(1, ((p[0] - a[0]) * ab[0]! + (p[1] - a[1]) * ab[1]!) / len2));
    return Math.hypot(p[0] - a[0] - t * ab[0]!, p[1] - a[1] - t * ab[1]!);
  };
  const toPolyline = (p: Vec2, points: readonly Vec2[]) => {
    let best = Infinity;
    for (let i = 1; i < points.length; i++)
      best = Math.min(best, toSegment(p, points[i - 1]!, points[i]!));
    return best;
  };
  const dense = Array.from({ length: 4001 }, (_, i) => bezierAt(i / 4000));

  it.each([0.1, 0.01, 0.001])('a Bezier edge is flattened within %f mm', (deflection) => {
    const body = build(k, [
      {
        kind: 'extrude',
        id: 'extrude#1',
        profile: profile(XY, [
          { kind: 'line', id: 'e1', start: [0, 0], end: [20, 0] },
          { kind: 'bezier', id: 'b1', points: bezier },
          { kind: 'line', id: 'e2', start: [20, 20], end: [0, 20] },
          { kind: 'line', id: 'e3', start: [0, 20], end: [0, 0] },
        ]),
        extent: { type: 'blind', distance: 5 },
        mode: 'new',
      },
    ]).shape;
    const r = found(k.faceLoops(body, { name: 'extrude#1:cap:end' }, XY, deflection));
    expectChained(r.outer);
    expect(kinds(r.outer).sort()).toEqual(['line', 'line', 'line', 'polyline']);
    const poly = r.outer.segments.find((c) => c.kind === 'polyline') as Extract<
      LoopSegment,
      { kind: 'polyline' }
    >;
    expect(poly.edge!.name).toMatch(/side:b1/);
    // Every vertex is on the curve, and every point of the curve is within the deflection.
    for (const q of poly.points) expect(toPolyline(q, dense)).toBeLessThan(1e-5);
    let worst = 0;
    for (const q of dense) worst = Math.max(worst, toPolyline(q, poly.points));
    expect(worst).toBeLessThanOrEqual(deflection * 1.0001);
    // Area: the square's 400 plus the Bezier's bulge (Green's theorem over the dense curve), less
    // what the chords cut off, which the deflection bounds.
    let bulge = 0;
    for (let i = 1; i < dense.length; i++) {
      bulge += (dense[i - 1]![0] * dense[i]![1] - dense[i]![0] * dense[i - 1]![1]) / 2;
    }
    bulge += (bezier[3]![0] * bezier[0]![1] - bezier[0]![0] * bezier[3]![1]) / 2;
    expect(r.outer.area).toBeLessThanOrEqual(400 + bulge + 1e-6);
    expect(r.outer.area).toBeGreaterThan(400 + bulge - 25 * deflection);
    k.release(body);
  });
});

describe('sections nested into regions', () => {
  it('a ring with an island in its hole: two regions, the island on its own', () => {
    const ring = build(k, [
      {
        kind: 'extrude',
        id: 'extrude#1',
        profile: profile(
          XY,
          rectangle(0, 0, 40, 40),
          rectangle(10, 10, 30, 30, ['h1', 'h2', 'h3', 'h4']),
        ),
        extent: { type: 'blind', distance: 10 },
        mode: 'new',
      },
      {
        kind: 'extrude',
        id: 'extrude#2',
        profile: profile(XY, circle([20, 20], 5, 'c1')),
        extent: { type: 'blind', distance: 10 },
        mode: 'add',
      },
    ]);
    const shapes = ring.bodies.map((b) => b.shape);
    const all = shapes.length === 1 ? shapes[0]! : k.compound(shapes).shape;
    const s = k.section(all, XY, 5);
    expect(s.regions).toHaveLength(2);
    const [outer, island] = s.regions;
    expectLoop(outer!.outer, 1600, true);
    expect(outer!.holes).toHaveLength(1);
    expectLoop(outer!.holes[0]!, 400, false);
    expect(kinds(island!.outer)).toEqual(['arc']);
    expectLoop(island!.outer, 25 * PI, true);
    expect(island!.holes).toEqual([]);
    if (shapes.length > 1) k.release(all);
    for (const id of shapes) k.release(id);
  });
});

describe('through the service', () => {
  const run = (ops: readonly KernelOp[]) => service.run({ generation: ++generation, ops });

  it('faceLoops and section ops on a named body made in the same batch', async () => {
    const reply = await run([
      { op: 'feature', bodies: [], feature: holed, keep: false },
      {
        op: 'faceLoops',
        shape: { result: 0 },
        target: { name: 'extrude#1:cap:end' },
        frame: XY,
      },
      { op: 'faceLoops', shape: { result: 0 }, target: { name: 'nope' }, frame: XY },
      { op: 'section', shape: { result: 0 }, frame: XY, height: 10, deflection: 0.05 },
      { op: 'faceLoops', shape: { result: 0 }, target: { index: 1 }, frame: XY, deflection: -1 },
      {
        op: 'section',
        shape: { result: 0 },
        frame: { origin: [0, 0, 0], xDir: [1, 0, 0] },
      } as unknown as KernelOp,
    ]);
    expect(reply.status).toBe('done');
    const loops = reply.results[1]!;
    expect(loops.ok).toBe(true);
    const r = (loops as { value: FaceLoopsReport }).value as Found;
    expect(r.height).toBeCloseTo(20, 12);
    expect(r.holes).toHaveLength(1);
    expect(r.outer.segments).toHaveLength(4);
    expect(reply.results[2]).toMatchObject({ ok: true, value: { ok: false, status: 'not-found' } });
    const s = (reply.results[3] as { value: SectionLoops }).value;
    expect(s.regions).toHaveLength(1);
    expect(s.regions[0]!.holes).toHaveLength(1);
    expect(s.regions[0]!.outer.area).toBeCloseTo(1200, 6);
    expect(reply.results[4]).toMatchObject({ ok: false, error: { code: 'invalid-argument' } });
    expect(reply.results[5]).toMatchObject({ ok: false, error: { code: 'invalid-op' } });
    // Neither op made a shape; keep: false released the body.
    expect(service.leaks()).toEqual([]);
  });
});
