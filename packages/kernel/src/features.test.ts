// Golden tests for the part features: each feature's volume, face count and
// bounding box against values computed by hand, and the names it gives.
// One kernel for the whole file.

import { beforeAll, describe, expect, it } from 'vitest';
import {
  MAX_PATTERN_COUNT,
  type ExtrudeInput,
  type FeatureInput,
  type RevolveInput,
} from './features';
import {
  apply,
  XY,
  atZ,
  build,
  circle,
  expectGolden,
  faceIndex,
  faceNames,
  named,
  near,
  polygon,
  profile,
  rectangle,
} from './fixtures/parts';
import { HOLE_SIZES, clearanceDiameter, holeSize } from './holes';
import type { Kernel } from './kernel';
import { createNodeKernel } from './node';
import type { Frame, ShapeId, Vec2 } from './types';

let k: Kernel;

beforeAll(async () => {
  k = await createNodeKernel();
}, 60_000);

const PI = Math.PI;
const DEG = PI / 180;

/** The 40 x 30 x 20 block most tests start from: rectangle e1 (front) .. e4, extruded up. */
const block = (id = 'extrude#1'): ExtrudeInput => ({
  kind: 'extrude',
  id,
  profile: profile(XY, rectangle(0, 0, 40, 30)),
  extent: { type: 'blind', distance: 20 },
  mode: 'new',
});

const TOP = 'extrude#1:cap:end';
const BOTTOM = 'extrude#1:cap:start';
const side = (id: string) => `extrude#1:side:${id}`;

describe('extrude', () => {
  it('blind: a 40 x 30 x 20 block with every face named by the sketch', () => {
    const { shape } = build(k, [block()]);
    expectGolden(k, shape, { volume: 24000, faces: 6, min: [0, 0, 0], max: [40, 30, 20] });
    const b = named(k, shape);
    expect(faceNames(b).sort()).toEqual(
      [BOTTOM, TOP, side('e1'), side('e2'), side('e3'), side('e4')].sort(),
    );
    expect(b.topology.faces[faceIndex(b, TOP) - 1]!.centroid[2]).toBeCloseTo(20, 9);
    expect(b.topology.faces[faceIndex(b, side('e1')) - 1]!.centroid[1]).toBeCloseTo(0, 9);
    expect(b.names.edges.map((e) => e.name)).toContain(`${side('e1')}|${side('e2')}`);
    expect(b.names.faces.every((f) => !f.fragile)).toBe(true);
  });

  it('reverse goes against the sketch normal; symmetric is centred on the sketch plane', () => {
    const rev = build(k, [{ ...block(), reverse: true }]).shape;
    expectGolden(k, rev, { volume: 24000, faces: 6, min: [0, 0, -20], max: [40, 30, 0] });
    const sym = build(k, [{ ...block(), extent: { type: 'symmetric', distance: 20 } }]).shape;
    expectGolden(k, sym, { volume: 24000, faces: 6, min: [0, 0, -10], max: [40, 30, 10] });
    // The start cap is the one at the start of the sweep, below the sketch plane.
    const b = named(k, sym);
    expect(b.topology.faces[faceIndex(b, BOTTOM) - 1]!.centroid[2]).toBeCloseTo(-10, 9);
  });

  it('add: a boss on the top face fuses, and the covered start cap is gone', () => {
    const boss: ExtrudeInput = {
      kind: 'extrude',
      id: 'extrude#2',
      profile: profile(atZ(20), circle([20, 15], 5)),
      extent: { type: 'blind', distance: 10 },
      mode: 'add',
    };
    const { shape } = build(k, [block(), boss]);
    expectGolden(k, shape, {
      volume: 24000 + PI * 25 * 10,
      faces: 8,
      min: [0, 0, 0],
      max: [40, 30, 30],
    });
    const names = faceNames(named(k, shape));
    expect(names).toContain('extrude#2:side:c1');
    expect(names).toContain('extrude#2:cap:end');
    expect(names).not.toContain('extrude#2:cap:start');
  });

  it('subtract through all: a hole sketched on the top, cut downward', () => {
    const hole: ExtrudeInput = {
      kind: 'extrude',
      id: 'extrude#2',
      profile: profile(atZ(20), circle([20, 15], 5)),
      extent: { type: 'throughAll' },
      reverse: true,
      mode: 'subtract',
    };
    const { shape } = build(k, [block(), hole]);
    expectGolden(k, shape, {
      volume: 24000 - PI * 25 * 20,
      faces: 7,
      min: [0, 0, 0],
      max: [40, 30, 20],
    });
    const b = named(k, shape);
    expect(faceNames(b)).toContain('extrude#2:side:c1');
    expect(b.names.edges.map((e) => e.name)).toContain('extrude#2:side:c1|extrude#2:side:c1');
  });

  it('intersect keeps the common part', () => {
    const cyl: ExtrudeInput = {
      kind: 'extrude',
      id: 'extrude#2',
      profile: profile(atZ(-10), circle([20, 15], 10)),
      extent: { type: 'blind', distance: 40 },
      mode: 'intersect',
    };
    const { shape } = build(k, [block(), cyl]);
    expectGolden(k, shape, {
      volume: PI * 100 * 20,
      faces: 3,
      min: [10, 5, 0],
      max: [30, 25, 20],
    });
    expect(faceNames(named(k, shape)).sort()).toEqual([BOTTOM, TOP, 'extrude#2:side:c1'].sort());
  });

  it('up to face: from a plane below the block to the plane of its top face', () => {
    const post: ExtrudeInput = {
      kind: 'extrude',
      id: 'extrude#2',
      profile: profile(atZ(-10), circle([20, 15], 5)),
      extent: { type: 'upToFace', face: { face: TOP } },
      mode: 'add',
    };
    const { shape, last } = build(k, [block(), post]);
    expectGolden(k, shape, {
      volume: 24000 + PI * 25 * 10,
      // Block (6, the top now split around the post's end cap), the post's side, both caps.
      faces: 9,
      min: [0, 0, -10],
      max: [40, 30, 20],
    });
    expect(last.resolved).toMatchObject([{ ref: 'extent', target: TOP, via: 'exact' }]);
    expect(last.warnings).toEqual([]);
  });

  it('draft tapers the sides: the volume of the frustum', () => {
    const angle = 5 * DEG;
    const { shape } = build(k, [{ ...block(), draft: angle }]);
    // A prismatoid: V = h/6 (A_bottom + A_top + 4 A_middle).
    const t = 20 * Math.tan(angle);
    const area = (s: number) => (40 - 2 * s) * (30 - 2 * s);
    const volume = (20 / 6) * (area(0) + area(t) + 4 * area(t / 2));
    expectGolden(k, shape, { volume, faces: 6, min: [0, 0, 0], max: [40, 30, 20] });
    const b = named(k, shape);
    expect(faceNames(b).sort()).toEqual(
      [BOTTOM, TOP, side('e1'), side('e2'), side('e3'), side('e4')].sort(),
    );
    // The front face leans back: its centroid is behind y = 0.
    const lean = b.topology.faces[faceIndex(b, side('e1')) - 1]!.centroid[1];
    expect(lean).toBeGreaterThan(0.4 * t);
    expect(lean).toBeLessThan(0.6 * t);
  });

  it('new with a body: a second body, named after its feature', () => {
    const second: ExtrudeInput = {
      ...block('extrude#2'),
      profile: profile(XY, rectangle(100, 0, 110, 10, ['f1', 'f2', 'f3', 'f4'])),
    };
    const { bodies, last } = build(k, [block(), second]);
    expect(bodies.map((b) => b.id)).toEqual(['extrude#1', 'extrude#2']);
    expect(last).toMatchObject({ created: ['extrude#2'], changed: [], consumed: [] });
    expectGolden(k, bodies[1]!.shape, {
      volume: 2000,
      faces: 6,
      min: [100, 0, 0],
      max: [110, 10, 20],
    });
    expect(faceNames(named(k, bodies[1]!.shape))).toContain('extrude#2:side:f3');
  });

  it('a profile with a hole names the hole wall too', () => {
    const f: ExtrudeInput = {
      ...block(),
      profile: profile(XY, rectangle(0, 0, 40, 30), circle([20, 15], 5)),
    };
    const { shape } = build(k, [f]);
    expectGolden(k, shape, {
      volume: 24000 - PI * 25 * 20,
      faces: 7,
      min: [0, 0, 0],
      max: [40, 30, 20],
    });
    expect(faceNames(named(k, shape))).toContain(side('c1'));
  });

  it('region edge ids: a positional piece (e2#1) gives a fragile name, a letter split does not', () => {
    const f: ExtrudeInput = {
      ...block(),
      profile: profile(XY, [
        { kind: 'line', id: 'e1', start: [0, 0], end: [40, 0] },
        { kind: 'line', id: 'e2#1', start: [40, 0], end: [40, 15] },
        { kind: 'line', id: 'e2#2', start: [40, 15], end: [40, 30] },
        { kind: 'line', id: 'e3#a', start: [40, 30], end: [0, 30] },
        { kind: 'line', id: 'e4', start: [0, 30], end: [0, 0] },
      ]),
    };
    const b = named(k, build(k, [f]).shape);
    const e21 = b.names.faces[faceIndex(b, side('e2#1')) - 1]!;
    expect(e21).toEqual({
      name: side('e2#1'),
      lineage: [side('e2#1'), side('e2')],
      fragile: true,
    });
    expect(b.names.faces[faceIndex(b, side('e3#a')) - 1]!.fragile).toBe(false);
  });
});

describe('revolve', () => {
  // A 5 x 20 rectangle, 5 to 10 from the Y axis, in the XY plane.
  const ring = (angle: number, extra: Partial<RevolveInput> = {}): RevolveInput => ({
    kind: 'revolve',
    id: 'revolve#1',
    profile: profile(XY, rectangle(5, 0, 10, 20, ['a', 'b', 'c', 'd'])),
    axis: { origin: [0, 0, 0], direction: [0, 1, 0] },
    angle,
    mode: 'new',
    ...extra,
  });

  it('a quarter turn about the Y axis: caps and sides named', () => {
    const { shape } = build(k, [ring(PI / 2)]);
    // Revolving from +X toward -Z (right-handed about +Y).
    expectGolden(k, shape, {
      volume: (PI / 4) * (100 - 25) * 20,
      faces: 6,
      min: [0, 0, -10],
      max: [10, 20, 0],
    });
    expect(faceNames(named(k, shape)).sort()).toEqual(
      [
        'revolve#1:cap:end',
        'revolve#1:cap:start',
        'revolve#1:side:a',
        'revolve#1:side:b',
        'revolve#1:side:c',
        'revolve#1:side:d',
      ].sort(),
    );
  });

  it('a full turn has no caps', () => {
    const { shape } = build(k, [ring(2 * PI)]);
    expectGolden(k, shape, {
      volume: PI * (100 - 25) * 20,
      faces: 4,
      min: [-10, 0, -10],
      max: [10, 20, 10],
    });
    const b = named(k, shape);
    expect(faceNames(b).sort()).toEqual(
      ['revolve#1:side:a', 'revolve#1:side:b', 'revolve#1:side:c', 'revolve#1:side:d'].sort(),
    );
    const outer = b.topology.faces[faceIndex(b, 'revolve#1:side:b') - 1]!;
    expect(outer.surface).toBe('cylinder');
    expect(outer.radius).toBeCloseTo(10, 9);
  });

  it('symmetric splits the angle to both sides of the sketch plane', () => {
    const { shape } = build(k, [ring(PI / 2, { symmetric: true })]);
    const s = 10 * Math.sin(PI / 4);
    expectGolden(k, shape, {
      volume: (PI / 4) * (100 - 25) * 20,
      faces: 6,
      min: [5 * Math.cos(PI / 4), 0, -s],
      max: [10, 20, s],
      boxTol: 1e-3,
    });
  });

  it('an entity on the axis sweeps no face: a solid cylinder', () => {
    const f: RevolveInput = {
      ...ring(2 * PI),
      profile: profile(XY, rectangle(0, 0, 10, 20, ['a', 'b', 'c', 'axis'])),
    };
    const { shape } = build(k, [f]);
    expectGolden(k, shape, {
      volume: PI * 100 * 20,
      faces: 3,
      min: [-10, 0, -10],
      max: [10, 20, 10],
    });
    expect(faceNames(named(k, shape))).not.toContain('revolve#1:side:axis');
  });

  it('subtract about an edge of the body: a groove turned round the top front edge', () => {
    // A 2 x 2 square on the front face's plane (y = 0) whose top side (g3)
    // lies on the top front edge. A full turn about that edge removes the
    // quarter of the swept cylinder that lies inside the block, whichever way
    // the edge runs: 2 x pi 2^2 / 4.
    const front: Frame = { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, -1, 0] };
    const groove: RevolveInput = {
      kind: 'revolve',
      id: 'revolve#2',
      profile: profile(front, rectangle(10, 18, 12, 20, ['g1', 'g2', 'g3', 'g4'])),
      axis: { edge: { faces: [TOP, side('e1')] } },
      angle: 2 * PI,
      mode: 'subtract',
    };
    const { shape, last } = build(k, [block(), groove]);
    expect(last.resolved).toMatchObject([{ ref: 'axis', via: 'exact', fragile: false }]);
    expectGolden(k, shape, {
      volume: 24000 - 2 * PI,
      faces: 9,
      min: [0, 0, 0],
      max: [40, 30, 20],
    });
    const b = named(k, shape);
    const round = b.topology.faces[faceIndex(b, 'revolve#2:side:g1') - 1]!;
    expect(round.surface).toBe('cylinder');
    expect(round.radius).toBeCloseTo(2, 9);
    expect(faceNames(b)).not.toContain('revolve#2:side:g3');
  });
});

describe('errors are per feature and never throw', () => {
  it('reports a malformed input, a missing body and missing edge ids', () => {
    const bad = apply(k, null, { ...block(), id: 'extrude-1' });
    expect(bad).toMatchObject({ ok: false, bodies: [], created: [], changed: [] });
    expect(bad.errors[0]).toMatchObject({ code: 'invalid' });

    const noBody = apply(k, null, { ...block(), mode: 'add' });
    expect(noBody.errors).toMatchObject([{ code: 'no-body', featureId: 'extrude#1' }]);

    const noIds = apply(k, null, {
      ...block(),
      profile: {
        frame: XY,
        loops: [{ entities: [{ kind: 'circle', center: [0, 0], radius: 1 }] }],
      },
    });
    expect(noIds.errors[0]).toMatchObject({ code: 'invalid' });
    expect(noIds.errors[0]!.message).toContain('id');
  });

  it('rejects sketch ids that would read as names or kernel splits', () => {
    for (const id of ['e1#2#a', 'e1:x', 'a|b', 'e1#', 'p/1', '?face3']) {
      const out = apply(k, null, {
        ...block(),
        profile: profile(XY, rectangle(0, 0, 1, 1, [id, 'e2', 'e3', 'e4'])),
      });
      expect(out.errors[0], id).toMatchObject({ code: 'invalid' });
    }
  });

  it('a failed feature passes the body through unchanged', () => {
    const { shape } = build(k, [block()]);
    const cut: FeatureInput = {
      kind: 'extrude',
      id: 'extrude#2',
      profile: profile(atZ(20), circle([20, 15], 5)),
      extent: { type: 'upToFace', face: { face: 'extrude#9:cap:end' } },
      mode: 'subtract',
    };
    const before = k.shapeCount;
    const out = apply(k, shape, cut);
    expect(out).toMatchObject({ ok: false, shape, created: [], changed: [], consumed: [] });
    expect(out.errors).toEqual([
      {
        featureId: 'extrude#2',
        code: 'lost',
        message: 'extrude#9:cap:end is lost: extrude#9:cap:end no longer exists',
        ref: 'extent',
        target: 'extrude#9:cap:end',
        missing: ['extrude#9:cap:end'],
      },
    ]);
    expect(out.bodies[0]!.names).toBe(k.named(shape)!.names);
    // Nothing leaked.
    expect(k.shapeCount).toBe(before);
  });

  it('an OCCT refusal or an empty result is an error, not an exception', () => {
    const { shape } = build(k, [block()]);
    const away: FeatureInput = {
      kind: 'extrude',
      id: 'extrude#2',
      profile: profile(atZ(100), circle([200, 200], 5)),
      extent: { type: 'blind', distance: 5 },
      mode: 'intersect',
    };
    const before = k.shapeCount;
    expect(apply(k, shape, away).errors).toMatchObject([{ code: 'empty' }]);
    const zero = apply(k, shape, { ...away, extent: { type: 'blind', distance: 0 } });
    expect(zero.errors).toMatchObject([{ code: 'invalid' }]);
    expect(k.shapeCount).toBe(before);
  });
});

describe('fillet', () => {
  const corner = { faces: [side('e1'), side('e2')] };

  it('rounds one vertical edge: a quarter round of radius 3 removed, named by its reference', () => {
    const { shape, last } = build(k, [
      block(),
      { kind: 'fillet', id: 'fillet#2', radius: 3, edges: [{ id: 'r1', ref: corner }] },
    ]);
    expectGolden(k, shape, {
      volume: 24000 - (9 - (9 * PI) / 4) * 20,
      faces: 7,
      min: [0, 0, 0],
      max: [40, 30, 20],
    });
    expect(last.resolved).toMatchObject([
      { ref: 'r1', kind: 'edge', via: 'exact', fragile: false },
    ]);
    const b = named(k, shape);
    const round = b.topology.faces[faceIndex(b, 'fillet#2:round:r1') - 1]!;
    expect(round.surface).toBe('cylinder');
    expect(round.radius).toBeCloseTo(3, 9);
    expect(Math.hypot(round.centroid[0] - 40, round.centroid[1])).toBeLessThan(3);
    expect(b.names.edges.map((e) => e.name)).not.toContain(`${side('e1')}|${side('e2')}`);
  });

  it('three edges at a corner make a corner blend named by the faces around the vertex', () => {
    const { shape } = build(k, [
      block(),
      {
        kind: 'fillet',
        id: 'fillet#2',
        radius: 3,
        edges: [
          { id: 'r1', ref: corner },
          { id: 'r2', ref: { faces: [TOP, side('e1')] } },
          { id: 'r3', ref: { faces: [TOP, side('e2')] } },
        ],
      },
    ]);
    const b = named(k, shape);
    expect(k.isValid(shape)).toBe(true);
    const name = `fillet#2:corner:${[TOP, side('e1'), side('e2')].sort().join('&')}`;
    const ball = b.topology.faces[faceIndex(b, name) - 1]!;
    expect(ball.surface).toBe('sphere');
    expect(ball.centroid[0]).toBeGreaterThan(37);
    expect(ball.centroid[1]).toBeLessThan(3);
    expect(ball.centroid[2]).toBeGreaterThan(17);
    expect(faceNames(b)).toEqual(
      expect.arrayContaining(['fillet#2:round:r1', 'fillet#2:round:r2', 'fillet#2:round:r3']),
    );
    expect(b.names.faces.every((f) => !f.name.startsWith('?'))).toBe(true);
  });

  it('a round OCCT carries along a tangent chain is named by the faces of the edge it replaced', () => {
    // After the corner is rounded, the top front edge, the top of the round
    // and the top right edge are one tangent chain: filleting one fillets all.
    const { shape } = build(k, [
      block(),
      { kind: 'fillet', id: 'fillet#2', radius: 5, edges: [{ id: 'r1', ref: corner }] },
      {
        kind: 'fillet',
        id: 'fillet#3',
        radius: 1,
        edges: [{ id: 'r1', ref: { faces: [TOP, side('e1')] } }],
      },
    ]);
    const names = faceNames(named(k, shape));
    expect(names).toContain('fillet#3:round:r1');
    expect(names).toContain(`fillet#3:round:${[TOP, 'fillet#2:round:r1'].sort().join('&')}`);
    expect(names).toContain(`fillet#3:round:${[TOP, side('e2')].sort().join('&')}`);
  });

  it('two references to one edge are an error', () => {
    const { shape } = build(k, [block()]);
    const out = apply(k, shape, {
      kind: 'fillet',
      id: 'fillet#2',
      radius: 1,
      edges: [
        { id: 'r1', ref: corner },
        { id: 'r2', ref: { faces: [side('e2'), side('e1')] } },
      ],
    });
    expect(out.errors).toMatchObject([{ code: 'invalid', ref: 'r2' }]);
  });
});

describe('chamfer', () => {
  const corner = { faces: [side('e1'), side('e2')] };
  const chamfer = (size: import('./types').ChamferSize, face?: string): FeatureInput => ({
    kind: 'chamfer',
    id: 'chamfer#2',
    size,
    edges: [{ id: 'r1', ref: corner, ...(face === undefined ? {} : { face: { face } }) }],
  });

  it('equal distances: a 2 x 2 triangle removed along the edge', () => {
    const { shape } = build(k, [block(), chamfer({ kind: 'distance', distance: 2 })]);
    expectGolden(k, shape, { volume: 24000 - 2 * 20, faces: 7, min: [0, 0, 0], max: [40, 30, 20] });
    const b = named(k, shape);
    const bevel = b.topology.faces[faceIndex(b, 'chamfer#2:bevel:r1') - 1]!;
    expect(bevel.surface).toBe('plane');
    expect(bevel.centroid[0]).toBeCloseTo(39, 9);
    expect(bevel.centroid[1]).toBeCloseTo(1, 9);
  });

  it('two distances: the first is measured on the reference face (by default the first name)', () => {
    const { shape } = build(k, [
      block(),
      chamfer({ kind: 'distances', distance: 2, distance2: 4 }),
    ]);
    expectGolden(k, shape, { volume: 24000 - 4 * 20, faces: 7, min: [0, 0, 0], max: [40, 30, 20] });
    const b = named(k, shape);
    // side:e1 (the front, y = 0) sorts first: 2 along it, 4 along the right side.
    const bevel = b.topology.faces[faceIndex(b, 'chamfer#2:bevel:r1') - 1]!;
    expect(bevel.centroid[0]).toBeCloseTo(39, 9);
    expect(bevel.centroid[1]).toBeCloseTo(2, 9);
    // With the right side as the reference face, the sizes swap.
    const swapped = named(
      k,
      build(k, [block(), chamfer({ kind: 'distances', distance: 2, distance2: 4 }, side('e2'))])
        .shape,
    );
    const other = swapped.topology.faces[faceIndex(swapped, 'chamfer#2:bevel:r1') - 1]!;
    expect(other.centroid[0]).toBeCloseTo(38, 9);
    expect(other.centroid[1]).toBeCloseTo(1, 9);
  });

  it('distance and angle: distance on the reference face, angle from it', () => {
    const angle = 30 * DEG;
    const { shape } = build(k, [block(), chamfer({ kind: 'distance-angle', distance: 2, angle })]);
    // 2 along the front face; the other leg is 2 tan(angle) along the right side.
    const other = 2 * Math.tan(angle);
    expectGolden(k, shape, {
      volume: 24000 - ((2 * other) / 2) * 20,
      faces: 7,
      min: [0, 0, 0],
      max: [40, 30, 20],
    });
  });

  it('a reference face that is not on the edge is an error', () => {
    const { shape } = build(k, [block()]);
    const out = apply(
      k,
      shape,
      chamfer({ kind: 'distances', distance: 1, distance2: 2 }, side('e3')),
    );
    expect(out.errors).toMatchObject([{ code: 'invalid', ref: 'r1.face' }]);
  });
});

describe('shell', () => {
  it('removes the top and leaves 2 mm walls; inner faces are named after the faces they offset', () => {
    const { shape } = build(k, [
      block(),
      { kind: 'shell', id: 'shell#2', thickness: 2, faces: [{ id: 'r1', ref: { face: TOP } }] },
    ]);
    expectGolden(k, shape, {
      volume: 24000 - 36 * 26 * 18,
      faces: 11,
      min: [0, 0, 0],
      max: [40, 30, 20],
    });
    const b = named(k, shape);
    expect(faceNames(b).sort()).toEqual(
      [
        BOTTOM,
        // The removed top's name passes to the rim OCCT leaves in its place.
        TOP,
        side('e1'),
        side('e2'),
        side('e3'),
        side('e4'),
        `shell#2:offset:${BOTTOM}`,
        `shell#2:offset:${side('e1')}`,
        `shell#2:offset:${side('e2')}`,
        `shell#2:offset:${side('e3')}`,
        `shell#2:offset:${side('e4')}`,
      ].sort(),
    );
    const floor = b.topology.faces[faceIndex(b, `shell#2:offset:${BOTTOM}`) - 1]!;
    expect(floor.centroid[2]).toBeCloseTo(2, 9);
    const rim = b.topology.faces[faceIndex(b, TOP) - 1]!;
    expect(rim.area).toBeCloseTo(40 * 30 - 36 * 26, 6);
  });

  it('outward grows the walls outside the original faces', () => {
    const { shape } = build(k, [
      block(),
      {
        kind: 'shell',
        id: 'shell#2',
        thickness: 2,
        outward: true,
        faces: [{ id: 'r1', ref: { face: TOP } }],
      },
    ]);
    expectGolden(k, shape, {
      volume: 44 * 34 * 22 - 24000,
      faces: 11,
      min: [-2, -2, -2],
      max: [42, 32, 20],
    });
  });
});

describe('closed hollow', () => {
  it('a shell that removes no face leaves an inner void, its walls named by offset', () => {
    const { shape } = build(k, [
      block(),
      { kind: 'shell', id: 'shell#2', thickness: 2, faces: [] },
    ]);
    expectGolden(k, shape, {
      volume: 24000 - 36 * 26 * 16,
      faces: 12,
      min: [0, 0, 0],
      max: [40, 30, 20],
    });
    const b = named(k, shape);
    expect(faceNames(b)).toEqual(
      expect.arrayContaining([
        TOP,
        BOTTOM,
        `shell#2:offset:${TOP}`,
        `shell#2:offset:${side('e3')}`,
      ]),
    );
    const inner = b.topology.faces[faceIndex(b, `shell#2:offset:${TOP}`) - 1]!;
    expect(inner.centroid[2]).toBeCloseTo(18, 9);
  });

  it('outward: the skin round the original body', () => {
    const { shape } = build(k, [
      block(),
      { kind: 'shell', id: 'shell#2', thickness: 2, outward: true, faces: [] },
    ]);
    expectGolden(k, shape, {
      volume: 44 * 34 * 24 - 24000,
      faces: 12,
      min: [-2, -2, -2],
      max: [42, 32, 22],
    });
    const b = named(k, shape);
    expect(b.topology.faces[faceIndex(b, `shell#2:offset:${TOP}`) - 1]!.centroid[2]).toBeCloseTo(
      22,
      9,
    );
    expect(b.topology.faces[faceIndex(b, TOP) - 1]!.centroid[2]).toBeCloseTo(20, 9);
  });
});

describe('known-hard fillets and shells error cleanly', () => {
  // Cases OCCT refuses or would mangle. Each must come back as a per-feature
  // error with the body passed through, nothing left in the arena, and the
  // kernel still usable.
  const cases: Array<[string, FeatureInput[]]> = [
    [
      'fillet radius wider than the faces beside the edge',
      [
        {
          kind: 'fillet',
          id: 'fillet#2',
          radius: 35,
          edges: [{ id: 'r1', ref: { faces: [side('e1'), side('e2')] } }],
        },
      ],
    ],
    [
      'fillet radius taller than the block on a top edge',
      [
        {
          kind: 'fillet',
          id: 'fillet#2',
          radius: 25,
          edges: [{ id: 'r1', ref: { faces: [TOP, side('e1')] } }],
        },
      ],
    ],
    [
      'chamfer larger than the faces',
      [
        {
          kind: 'chamfer',
          id: 'chamfer#2',
          size: { kind: 'distance', distance: 50 },
          edges: [{ id: 'r1', ref: { faces: [TOP, side('e1')] } }],
        },
      ],
    ],
    [
      'shell thicker than half the narrowest wall span',
      [{ kind: 'shell', id: 'shell#2', thickness: 16, faces: [{ id: 'r1', ref: { face: TOP } }] }],
    ],
    [
      'shell that removes every face',
      [
        {
          kind: 'shell',
          id: 'shell#2',
          thickness: 1,
          faces: [TOP, BOTTOM, side('e1'), side('e2'), side('e3'), side('e4')].map((face, i) => ({
            id: `r${i + 1}`,
            ref: { face },
          })),
        },
      ],
    ],
    [
      'fillet on a 0.2 mm step with a 2 mm radius',
      [
        {
          kind: 'extrude',
          id: 'extrude#2',
          profile: profile(atZ(20), rectangle(0, 0, 20, 30, ['s1', 's2', 's3', 's4'])),
          extent: { type: 'blind', distance: 0.2 },
          mode: 'add',
        },
        {
          kind: 'fillet',
          id: 'fillet#3',
          radius: 2,
          edges: [{ id: 'r1', ref: { faces: ['extrude#2:cap:end', 'extrude#2:side:s2'] } }],
        },
      ],
    ],
  ];

  for (const [title, features] of cases) {
    it(title, () => {
      const base = build(k, [block(), ...features.slice(0, -1)]).shape;
      const before = k.shapeCount;
      const out = apply(k, base, features.at(-1)!);
      expect(out.ok, `OCCT accepted: ${title}`).toBe(false);
      expect(out.errors.length).toBe(1);
      expect(['kernel', 'invalid-shape', 'invalid', 'empty']).toContain(out.errors[0]!.code);
      expect(out.errors[0]!.featureId).toBe(features.at(-1)!.id);
      expect(out.shape).toBe(base);
      expect(k.shapeCount).toBe(before);
      // The kernel still works.
      expect(k.properties(base).volume).toBeGreaterThan(0);
    });
  }
});

describe('hole', () => {
  const onTop: Frame = { origin: [0, 0, 20], xDir: [1, 0, 0], normal: [0, 0, 1] };
  const hole = (extra: Partial<import('./features').HoleInput> = {}): FeatureInput => ({
    kind: 'hole',
    id: 'hole#2',
    frame: onTop,
    points: [
      { id: 'e5', at: [10, 15] },
      { id: 'e6', at: [30, 15] },
    ],
    diameter: clearanceDiameter('M6', 'normal')!,
    extent: { type: 'throughAll' },
    head: { type: 'simple' },
    ...extra,
  });
  const r = 6.6 / 2;

  it('uses the ISO 273 / ASME B18.2.8 clearance tables', () => {
    expect(clearanceDiameter('M6', 'normal')).toBe(6.6);
    expect(clearanceDiameter('M3', 'close')).toBe(3.2);
    expect(clearanceDiameter('M12', 'loose')).toBe(14.5);
    expect(clearanceDiameter('1/4', 'close')).toBeCloseTo((17 / 64) * 25.4, 12);
    expect(clearanceDiameter('#10', 'loose')).toBeCloseTo(0.238 * 25.4, 12);
    expect(clearanceDiameter('M7')).toBeUndefined();
    for (const size of HOLE_SIZES) {
      expect(size.clearance.close).toBeLessThan(size.clearance.normal);
      expect(size.clearance.normal).toBeLessThan(size.clearance.loose);
      expect(size.clearance.close).toBeGreaterThan(size.nominal);
      expect(size.counterbore.diameter).toBeGreaterThan(size.clearance.loose);
      expect(size.countersink.diameter).toBeGreaterThan(size.clearance.loose);
      expect(size.verified.clearance).toBe(true);
    }
  });

  it('simple, through all: two M6 clearance holes, named by sketch point', () => {
    const { shape } = build(k, [block(), hole()]);
    expectGolden(k, shape, {
      volume: 24000 - 2 * PI * r * r * 20,
      faces: 8,
      min: [0, 0, 0],
      max: [40, 30, 20],
    });
    const b = named(k, shape);
    expect(faceNames(b)).toEqual(expect.arrayContaining(['hole#2:wall:e5', 'hole#2:wall:e6']));
    const wall = b.topology.faces[faceIndex(b, 'hole#2:wall:e6') - 1]!;
    expect(wall.surface).toBe('cylinder');
    expect(wall.radius).toBeCloseTo(r, 9);
    expect(wall.centroid[0]).toBeCloseTo(30, 6);
  });

  it('blind with a 118 degree drill point', () => {
    const { shape } = build(k, [block(), hole({ extent: { type: 'blind', depth: 10 } })]);
    const tip = r / Math.tan((59 * PI) / 180);
    expectGolden(k, shape, {
      volume: 24000 - 2 * (PI * r * r * 10 + (PI * r * r * tip) / 3),
      faces: 10,
      min: [0, 0, 0],
      max: [40, 30, 20],
    });
    const b = named(k, shape);
    expect(b.topology.faces[faceIndex(b, 'hole#2:tip:e5') - 1]!.surface).toBe('cone');
  });

  it('counterbore', () => {
    const size = holeSize('M6')!;
    const { shape } = build(k, [
      block(),
      hole({
        points: [{ id: 'e5', at: [20, 15] }],
        head: { type: 'counterbore', ...size.counterbore },
      }),
    ]);
    const R = size.counterbore.diameter / 2;
    const h = size.counterbore.depth;
    expectGolden(k, shape, {
      volume: 24000 - PI * R * R * h - PI * r * r * (20 - h),
      faces: 9,
      min: [0, 0, 0],
      max: [40, 30, 20],
    });
    const b = named(k, shape);
    expect(faceNames(b)).toEqual(
      expect.arrayContaining(['hole#2:cbore:e5', 'hole#2:cbore-floor:e5', 'hole#2:wall:e5']),
    );
    expect(b.topology.faces[faceIndex(b, 'hole#2:cbore-floor:e5') - 1]!.centroid[2]).toBeCloseTo(
      20 - h,
      9,
    );
  });

  it('countersink', () => {
    const size = holeSize('M6')!;
    const { shape } = build(k, [
      block(),
      hole({
        points: [{ id: 'e5', at: [20, 15] }],
        head: { type: 'countersink', ...size.countersink },
      }),
    ]);
    const R = size.countersink.diameter / 2;
    const h = (R - r) / Math.tan(size.countersink.angle / 2);
    expectGolden(k, shape, {
      volume: 24000 - (PI * h * (R * R + R * r + r * r)) / 3 - PI * r * r * (20 - h),
      faces: 8,
      min: [0, 0, 0],
      max: [40, 30, 20],
    });
    const b = named(k, shape);
    expect(b.topology.faces[faceIndex(b, 'hole#2:csink:e5') - 1]!.surface).toBe('cone');
  });

  it('a hole that misses the body is an error', () => {
    const { shape } = build(k, [block()]);
    const out = apply(k, shape, hole({ points: [{ id: 'e5', at: [100, 100] }] }));
    expect(out.errors).toMatchObject([{ code: 'invalid' }]);
    expect(out.errors[0]!.message).toContain('e5');
  });
});

describe('pattern and mirror', () => {
  const pin = (at: [number, number], id = 'extrude#2'): ExtrudeInput => ({
    kind: 'extrude',
    id,
    profile: profile(atZ(20), circle(at, 2)),
    extent: { type: 'throughAll' },
    reverse: true,
    mode: 'subtract',
  });

  it('linear pattern of a feature: instances named <pattern>:i<k>/<source name>', () => {
    const { shape } = build(k, [
      block(),
      pin([5, 15]),
      {
        kind: 'pattern',
        id: 'pattern#3',
        source: { type: 'features', features: [pin([5, 15])] },
        // The right face's normal: +x.
        layout: { type: 'linear', direction: { ref: { face: side('e2') } }, count: 4, spacing: 10 },
      },
    ]);
    expectGolden(k, shape, {
      volume: 24000 - 4 * PI * 4 * 20,
      faces: 10,
      min: [0, 0, 0],
      max: [40, 30, 20],
    });
    const b = named(k, shape);
    const walls = [
      'extrude#2:side:c1',
      ...[2, 3, 4].map((i) => `pattern#3:i${i}/extrude#2:side:c1`),
    ];
    expect(faceNames(b)).toEqual(expect.arrayContaining(walls));
    walls.forEach((name, i) => {
      expect(b.topology.faces[faceIndex(b, name) - 1]!.centroid[0]).toBeCloseTo(5 + 10 * i, 6);
    });
  });

  it('an instance face can be referenced by a later feature', () => {
    const { shape, last } = build(k, [
      block(),
      pin([5, 15]),
      {
        kind: 'pattern',
        id: 'pattern#3',
        source: { type: 'features', features: [pin([5, 15])] },
        layout: { type: 'linear', direction: [1, 0, 0], count: 2, spacing: 20 },
      },
      {
        kind: 'fillet',
        id: 'fillet#4',
        radius: 0.5,
        edges: [{ id: 'r1', ref: { faces: [TOP, 'pattern#3:i2/extrude#2:side:c1'] } }],
      },
    ]);
    expect(last.warnings).toEqual([]);
    const b = named(k, shape);
    const rim = b.topology.faces[faceIndex(b, 'fillet#4:round:r1') - 1]!;
    expect(rim.surface).toBe('torus');
    expect(rim.centroid[0]).toBeCloseTo(25, 6);
  });

  it('circular pattern about a cylindrical face: six bosses round a disc', () => {
    const disc: ExtrudeInput = {
      kind: 'extrude',
      id: 'extrude#1',
      profile: profile(XY, circle([0, 0], 20, 'rim')),
      extent: { type: 'blind', distance: 5 },
      mode: 'new',
    };
    const boss: ExtrudeInput = {
      kind: 'extrude',
      id: 'extrude#2',
      profile: profile(atZ(5), circle([15, 0], 2)),
      extent: { type: 'blind', distance: 5 },
      mode: 'add',
    };
    const { shape } = build(k, [
      disc,
      boss,
      {
        kind: 'pattern',
        id: 'pattern#3',
        source: { type: 'features', features: [boss] },
        layout: {
          type: 'circular',
          axis: { ref: { face: 'extrude#1:side:rim' } },
          count: 6,
          angle: 2 * PI,
        },
      },
    ]);
    expectGolden(k, shape, {
      volume: PI * 400 * 5 + 6 * PI * 4 * 5,
      faces: 3 + 6 * 2,
      min: [-20, -20, 0],
      max: [20, 20, 10],
      boxTol: 1e-3,
    });
    const b = named(k, shape);
    const cap = b.topology.faces[faceIndex(b, 'pattern#3:i4/extrude#2:cap:end') - 1]!;
    // Instance 4 is 3 x 60 degrees round: at (-15, 0), whichever way the axis points.
    expect(cap.centroid[0]).toBeCloseTo(-15, 6);
    expect(cap.centroid[1]).toBeCloseTo(0, 6);
  });

  it('pattern of the body: copies clear of it become bodies of their own', () => {
    const { bodies, last } = build(k, [
      block(),
      {
        kind: 'pattern',
        id: 'pattern#2',
        source: { type: 'body' },
        layout: { type: 'linear', direction: [1, 0, 0], count: 3, spacing: 50 },
      },
    ]);
    expect(bodies.map((b) => b.id)).toEqual(['extrude#1', 'pattern#2:i2', 'pattern#2:i3']);
    expect(last.warnings).toMatchObject([
      { code: 'detached', bodies: ['pattern#2:i2', 'pattern#2:i3'] },
    ]);
    expectGolden(k, bodies[2]!.shape, {
      volume: 24000,
      faces: 6,
      min: [100, 0, 0],
      max: [140, 30, 20],
    });
    expect(faceNames(named(k, bodies[2]!.shape))).toContain('pattern#2:i3/extrude#1:side:e1');
    // The original is untouched: same shape id.
    expect(bodies[0]!.shape).toBe(last.bodies[0]!.shape);
  });

  it('pattern of the body: overlapping copies fuse with it', () => {
    const { shape } = build(k, [
      block(),
      {
        kind: 'pattern',
        id: 'pattern#2',
        source: { type: 'body' },
        layout: { type: 'linear', direction: [1, 0, 0], count: 3, spacing: 30 },
      },
    ]);
    expect(k.properties(shape).volume).toBeCloseTo(24000 + 2 * 18000, 6);
  });

  it('a count of 1 changes nothing', () => {
    const base = build(k, [block()]).shape;
    const out = apply(k, base, {
      kind: 'pattern',
      id: 'pattern#2',
      source: { type: 'body' },
      layout: { type: 'linear', direction: [1, 0, 0], count: 1, spacing: 50 },
    });
    expect(out).toMatchObject({ ok: true, created: [], changed: [], shape: base, errors: [] });
  });

  it('mirror the body about a planar face: the halves fuse at the face', () => {
    const { shape } = build(k, [
      block(),
      { kind: 'mirror', id: 'mirror#2', source: { type: 'body' }, plane: { face: side('e4') } },
    ]);
    // The touching faces (e4 and its image) are gone.
    expectGolden(k, shape, { volume: 48000, faces: 10, min: [-40, 0, 0], max: [40, 30, 20] });
    const b = named(k, shape);
    expect(faceNames(b)).toContain('mirror#2:image/extrude#1:side:e2');
    expect(faceNames(b)).not.toContain(side('e4'));
    expect(
      b.topology.faces[faceIndex(b, 'mirror#2:image/extrude#1:side:e2') - 1]!.centroid[0],
    ).toBeCloseTo(-40, 9);
  });

  it('mirror a feature about a plane', () => {
    const { shape } = build(k, [
      block(),
      pin([10, 15]),
      {
        kind: 'mirror',
        id: 'mirror#3',
        source: { type: 'features', features: [pin([10, 15])] },
        plane: { origin: [20, 0, 0], normal: [1, 0, 0] },
      },
    ]);
    expectGolden(k, shape, {
      volume: 24000 - 2 * PI * 4 * 20,
      faces: 8,
      min: [0, 0, 0],
      max: [40, 30, 20],
    });
    const b = named(k, shape);
    expect(
      b.topology.faces[faceIndex(b, 'mirror#3:image/extrude#2:side:c1') - 1]!.centroid[0],
    ).toBeCloseTo(30, 6);
  });
});

describe('known-hard closed hollows are right or error cleanly', () => {
  // L-brackets with fillets. OCCT's outward offset of them came back as a
  // hollow reported ok that was only the enlarged solid, the cut having left
  // it untouched (0.5 mm), or a collapsed sliver of a few mm3 (3 mm, fillets
  // on e1|e2 and e3|e4). Whatever OCCT does, the result must be the offset
  // minus the body (inward: the body minus the offset), or a clean error.
  const bracket = (radius: number, corners: [string, string][]): FeatureInput[] => [
    {
      kind: 'extrude',
      id: 'extrude#1',
      profile: profile(
        XY,
        polygon(
          [
            [0, 0],
            [40, 0],
            [40, 10],
            [10, 10],
            [10, 30],
            [0, 30],
          ],
          ['e1', 'e2', 'e3', 'e4', 'e5', 'e6'],
        ),
      ),
      extent: { type: 'blind', distance: 20 },
      mode: 'new',
    },
    {
      kind: 'fillet',
      id: 'fillet#2',
      radius,
      edges: corners.map(([a, b], i) => ({
        id: `r${i + 1}`,
        ref: { faces: [side(a), side(b)] },
      })),
    },
  ];
  const brackets: Array<[string, FeatureInput[]]> = [
    [
      'inner and back corners filleted 3 mm',
      bracket(3, [
        ['e3', 'e4'],
        ['e1', 'e6'],
      ]),
    ],
    [
      'inner and front corners filleted 1 mm',
      bracket(1, [
        ['e1', 'e2'],
        ['e3', 'e4'],
      ]),
    ],
  ];

  for (const [title, features] of brackets) {
    for (const thickness of [0.5, 3]) {
      for (const outward of [true, false]) {
        it(`${title}: ${outward ? 'outward' : 'inward'}, ${thickness} mm`, () => {
          const base = build(k, features).shape;
          const before = k.shapeCount;
          const out = apply(k, base, {
            kind: 'shell',
            id: 'shell#3',
            thickness,
            outward,
            faces: [],
          });
          if (!out.ok) {
            expect(out.errors).toHaveLength(1);
            // Never a bare kernel error: a failed cut says what to try.
            expect(out.errors[0]!.code, out.errors[0]!.message).toBe('invalid-shape');
            expect(out.errors[0]!.message).toMatch(/OCCT could not hollow the body/);
            expect(out.shape).toBe(base);
            expect(k.shapeCount).toBe(before);
            return;
          }
          // OCCT managed it: the wall is exactly the difference of the two.
          const off = k.offset(base, outward ? thickness : -thickness).shape;
          const vOff = k.properties(off).volume;
          const vBody = k.properties(base).volume;
          k.release(off);
          expect(outward ? vOff > vBody : vOff < vBody).toBe(true);
          expect(k.properties(out.shape!).volume).toBeCloseTo(Math.abs(vOff - vBody), 3);
          const names = faceNames(named(k, out.shape!));
          expect(names).toContain(`shell#3:offset:${TOP}`);
          expect(names).toContain(TOP);
        });
      }
    }
  }
});

describe('directions taken from references are chosen by name', () => {
  // The same 40 x 30 x 20 block, its sketch started at another corner (the
  // edge ids go with the geometry, so every face keeps its name), plus an
  // unrelated through hole: OCCT orders edges and faces differently, and
  // must not change which way an edge runs.
  const edited = (start: number): FeatureInput[] => {
    const pts: Vec2[] = [
      [0, 0],
      [40, 0],
      [40, 30],
      [0, 30],
    ];
    const ids = ['e1', 'e2', 'e3', 'e4'];
    const turn = <T>(a: T[]) => [...a.slice(start), ...a.slice(0, start)];
    return [
      { ...block(), profile: profile(XY, polygon(turn(pts), turn(ids))) },
      {
        kind: 'extrude',
        id: 'extrude#9',
        profile: profile(atZ(20), circle([20, 15], 3, 'h1')),
        extent: { type: 'throughAll' },
        reverse: true,
        mode: 'subtract',
      },
    ];
  };
  const variants: Array<[string, FeatureInput[]]> = [
    ['the plain block', [block()]],
    ['started at corner 1, with a hole', edited(1)],
    ['started at corner 2, with a hole', edited(2)],
    ['started at corner 3, with a hole', edited(3)],
  ];
  const pin = (at: Vec2): ExtrudeInput => ({
    kind: 'extrude',
    id: 'extrude#2',
    profile: profile(atZ(20), circle(at, 2)),
    extent: { type: 'throughAll' },
    reverse: true,
    mode: 'subtract',
  });
  const instanceX = (shape: ShapeId) => {
    const b = named(k, shape);
    return b.topology.faces[faceIndex(b, 'pattern#3:i2/extrude#2:side:c1') - 1]!.centroid[0];
  };

  for (const [title, base] of variants) {
    it(`a linear pattern along the top front edge goes +x on ${title}`, () => {
      // Top (cap:end, normal +z) sorts before side:e1 (normal -y): +z x -y = +x.
      const pattern = (flip?: boolean): FeatureInput => ({
        kind: 'pattern',
        id: 'pattern#3',
        source: { type: 'features', features: [pin([20, 25])] },
        layout: {
          type: 'linear',
          direction: { ref: { faces: [TOP, side('e1')] }, ...(flip ? { flip } : {}) },
          count: 2,
          spacing: 10,
        },
      });
      const plain = build(k, [...base, pin([20, 25]), pattern()]);
      expect(plain.last.warnings).toEqual([]);
      expect(instanceX(plain.shape)).toBeCloseTo(30, 6);
      // `flip` turns it round.
      const flipped = build(k, [...base, pin([20, 25]), pattern(true)]);
      expect(instanceX(flipped.shape)).toBeCloseTo(10, 6);
    });

    it(`a quarter revolve about the top front edge cuts into the block on ${title}`, () => {
      // About +x, a square below the edge on the front plane sweeps into the
      // block (-z toward +y): a quarter of a 2 mm cylinder, 2 mm long.
      const front: Frame = { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, -1, 0] };
      const groove = (flip?: boolean): RevolveInput => ({
        kind: 'revolve',
        id: 'revolve#2',
        profile: profile(front, rectangle(10, 18, 12, 20, ['g1', 'g2', 'g3', 'g4'])),
        axis: { edge: { faces: [TOP, side('e1')] }, ...(flip ? { flip } : {}) },
        angle: PI / 2,
        mode: 'subtract',
      });
      const before = k.properties(build(k, base).shape).volume;
      const { shape } = build(k, [...base, groove()]);
      expect(k.properties(shape).volume).toBeCloseTo(before - 2 * PI, 6);
      // Flipped, it sweeps away from the block and cuts nothing.
      const away = apply(k, build(k, base).shape, groove(true));
      expect(k.properties(away.shape!).volume).toBeCloseTo(before, 6);
    });

    it(`a quarter-turn circular pattern about a vertical edge turns +z on ${title}`, () => {
      // side:e1 (normal -y) sorts before side:e2 (+x): -y x +x = +z. The
      // block turned +90 degrees about the edge at (40, 0) lands at y < 0.
      const { shape } = build(k, [
        ...base,
        {
          kind: 'pattern',
          id: 'pattern#3',
          source: { type: 'body' },
          layout: {
            type: 'circular',
            axis: { ref: { faces: [side('e1'), side('e2')] } },
            count: 2,
            angle: PI / 2,
          },
        },
      ]);
      const box = k.properties(shape).boundingBox!;
      expect(near(box.min, [0, -40, 0], 1e-4), box.min.join(',')).toBe(true);
      expect(near(box.max, [40, 30, 20], 1e-4), box.max.join(',')).toBe(true);
    });
  }

  it('a partial circular pattern about a hole wall turns toward the face that sorts first', () => {
    // The wall's neighbours: the top (extrude#1:cap:end) sorts before the
    // bottom, so the axis points up and +90 degrees takes (30, 15) to (20, 25).
    const disc: FeatureInput[] = [
      block(),
      {
        kind: 'extrude',
        id: 'extrude#9',
        profile: profile(atZ(20), circle([20, 15], 3, 'h1')),
        extent: { type: 'throughAll' },
        reverse: true,
        mode: 'subtract',
      },
    ];
    const boss: ExtrudeInput = {
      kind: 'extrude',
      id: 'extrude#2',
      profile: profile(atZ(20), circle([30, 15], 1)),
      extent: { type: 'blind', distance: 5 },
      mode: 'add',
    };
    const { shape } = build(k, [
      ...disc,
      boss,
      {
        kind: 'pattern',
        id: 'pattern#3',
        source: { type: 'features', features: [boss] },
        layout: {
          type: 'circular',
          axis: { ref: { face: 'extrude#9:side:h1' } },
          count: 2,
          angle: PI / 2,
        },
      },
    ]);
    const b = named(k, shape);
    const cap = b.topology.faces[faceIndex(b, 'pattern#3:i2/extrude#2:cap:end') - 1]!;
    expect(near(cap.centroid, [20, 25, 25], 1e-6), cap.centroid.join(',')).toBe(true);
  });

  // A round along the top front edge is tangent to the top and the front,
  // which run its whole length: their centroids move with unrelated edits
  // (a boss on the top), so only the side faces at its ends may orient it.
  // side:e2 (at x = 40) sorts before side:e4, so the axis points +x.
  for (const start of [0, 1, 2]) {
    for (const withBoss of [false, true]) {
      const title = `the holed block started at corner ${start}${withBoss ? ', with a boss on the top' : ''}`;
      it(`a partial circular pattern about a fillet round turns about +x on ${title}`, () => {
        const blind: ExtrudeInput = {
          kind: 'extrude',
          id: 'extrude#4',
          profile: profile(atZ(20), circle([10, 20], 2, 'b1')),
          extent: { type: 'blind', distance: 5 },
          reverse: true,
          mode: 'subtract',
        };
        const boss: ExtrudeInput = {
          kind: 'extrude',
          id: 'extrude#5',
          profile: profile(atZ(20), circle([30, 20], 3, 'p1')),
          extent: { type: 'blind', distance: 5 },
          mode: 'add',
        };
        const { shape, outcomes } = build(k, [
          ...edited(start),
          blind,
          {
            kind: 'fillet',
            id: 'fillet#3',
            radius: 3,
            edges: [{ id: 'r1', ref: { faces: [TOP, side('e1')] } }],
          },
          ...(withBoss ? [boss] : []),
          {
            kind: 'pattern',
            id: 'pattern#6',
            source: { type: 'body' },
            layout: {
              type: 'circular',
              axis: { ref: { face: 'fillet#3:round:r1' } },
              count: 2,
              angle: PI / 2,
            },
          },
        ]);
        expect(outcomes.flatMap((o) => o.warnings).filter((w) => w.code === 'direction')).toEqual(
          [],
        );
        // The axis runs through (y, z) = (3, 17). Turned +90 degrees about +x,
        // the block's back (y = 30) rises to z = 44; about -x it would sink to
        // z = -10.
        const box = k.properties(shape).boundingBox!;
        expect(box.min[2]).toBeCloseTo(0, 4);
        expect(box.max[2]).toBeCloseTo(44, 4);
      });
    }
  }

  it('a partial circular pattern about a countersink cone turns toward its rim face', () => {
    // The cone's end neighbours: the top (extrude#1:cap:end) at its rim sorts
    // before the hole wall at its narrow end, so the axis points up and +90
    // degrees takes (30, 15) to (20, 25). An off-centre blind hole moves the
    // top's centroid but decides nothing.
    const boss: ExtrudeInput = {
      kind: 'extrude',
      id: 'extrude#2',
      profile: profile(atZ(20), circle([30, 15], 1)),
      extent: { type: 'blind', distance: 5 },
      mode: 'add',
    };
    const { shape, outcomes } = build(k, [
      block(),
      {
        kind: 'hole',
        id: 'hole#9',
        frame: atZ(20),
        points: [{ id: 'h1', at: [20, 15] }],
        diameter: clearanceDiameter('M6', 'normal')!,
        extent: { type: 'throughAll' },
        head: { type: 'countersink', ...holeSize('M6')!.countersink },
      },
      {
        kind: 'extrude',
        id: 'extrude#4',
        profile: profile(atZ(20), circle([5, 25], 2, 'b1')),
        extent: { type: 'blind', distance: 5 },
        reverse: true,
        mode: 'subtract',
      },
      boss,
      {
        kind: 'pattern',
        id: 'pattern#3',
        source: { type: 'features', features: [boss] },
        layout: {
          type: 'circular',
          axis: { ref: { face: 'hole#9:csink:h1' } },
          count: 2,
          angle: PI / 2,
        },
      },
    ]);
    expect(outcomes.flatMap((o) => o.warnings).filter((w) => w.code === 'direction')).toEqual([]);
    const b = named(k, shape);
    const cap = b.topology.faces[faceIndex(b, 'pattern#3:i2/extrude#2:cap:end') - 1]!;
    expect(near(cap.centroid, [20, 25, 25], 1e-6), cap.centroid.join(',')).toBe(true);
  });
});

describe('placeholder names never escape into a body', () => {
  it('a drafted extrusion with a face its sweep did not name fails with unnamed', () => {
    const extrude = k.extrude;
    k.extrude = function (this: Kernel, ...args: Parameters<Kernel['extrude']>) {
      const r = extrude.apply(this, args);
      const { e3: _dropped, ...sideIds } = r.sideIds;
      void _dropped;
      return { ...r, sideIds };
    } as Kernel['extrude'];
    try {
      for (const draft of [undefined, 5 * DEG]) {
        const out = apply(k, null, { ...block(), ...(draft ? { draft } : {}) });
        expect(out.errors, `draft ${draft}`).toMatchObject([{ code: 'unnamed' }]);
        expect(out.shape).toBeNull();
      }
    } finally {
      k.extrude = extrude;
    }
  });

  it('an outward closed hollow with an offset face no history named fails with unnamed', () => {
    const base = build(k, [block()]).shape;
    const offset = k.offset;
    k.offset = function (this: Kernel, ...args: Parameters<Kernel['offset']>) {
      const r = offset.apply(this, args);
      // Forget what became of the first face.
      return {
        ...r,
        history: r.history.filter((h) => !(h.input.kind === 'face' && h.input.index === 1)),
      };
    } as Kernel['offset'];
    try {
      for (const outward of [true, false]) {
        const out = apply(k, base, {
          kind: 'shell',
          id: 'shell#2',
          thickness: 2,
          outward,
          faces: [],
        });
        expect(out.errors, `outward ${outward}`).toMatchObject([{ code: 'unnamed' }]);
        expect(out.shape).toBe(base);
      }
    } finally {
      k.offset = offset;
    }
  });

  it('references to a placeholder, however it is wrapped, are rejected', () => {
    const base = build(k, [block()]).shape;
    const out = apply(k, base, {
      kind: 'fillet',
      id: 'fillet#2',
      radius: 1,
      edges: [{ id: 'r1', ref: { faces: [TOP, 'shell#2:offset:?face3'] } }],
    });
    expect(out.errors).toMatchObject([{ code: 'invalid' }]);
  });
});

describe('pattern and mirror copies', () => {
  const pin = (at: Vec2): ExtrudeInput => ({
    kind: 'extrude',
    id: 'extrude#2',
    profile: profile(atZ(20), circle(at, 2)),
    extent: { type: 'throughAll' },
    reverse: true,
    mode: 'subtract',
  });

  it('a through-all cut stays through all in every copy, measured from where the copy is', () => {
    // A 40 x 60 x 20 block; a vertical through hole at (20, 10), turned 90
    // degrees about the x axis through (0, 10, 10): the copy starts on the
    // front face and must run the whole 60 mm, not the original's 21.
    const tall: ExtrudeInput = { ...block(), profile: profile(XY, rectangle(0, 0, 40, 60)) };
    const { shape } = build(k, [
      tall,
      pin([20, 10]),
      {
        kind: 'pattern',
        id: 'pattern#3',
        source: { type: 'features', features: [pin([20, 10])] },
        layout: {
          type: 'circular',
          axis: { origin: [0, 10, 10], direction: [1, 0, 0] },
          count: 2,
          angle: PI / 2,
        },
      },
    ]);
    // Two perpendicular r = 2 holes crossing: their common part is 16 r^3 / 3.
    // Each wall is cut in two where the other hole crosses it.
    expectGolden(k, shape, {
      volume: 48000 - PI * 4 * 20 - PI * 4 * 60 + (16 * 8) / 3,
      faces: 10,
      min: [0, 0, 0],
      max: [40, 60, 20],
      volumeTol: 1e-3,
    });
  });

  it('a mirrored through-all cut is measured from the image too', () => {
    // A 40 mm tall block. A cut sketched at z = 20 going down, mirrored about
    // z = 12.5, starts at z = 5 going up: it must reach the top (35 mm), not
    // stop after the original's 21 mm.
    const tall: ExtrudeInput = { ...block(), extent: { type: 'blind', distance: 40 } };
    const { shape } = build(k, [
      tall,
      pin([10, 15]),
      {
        kind: 'mirror',
        id: 'mirror#3',
        source: { type: 'features', features: [pin([30, 15])] },
        plane: { origin: [0, 0, 12.5], normal: [0, 0, 1] },
      },
    ]);
    // Original: z 0 to 20 at x = 10. Image of a cut at x = 30 from z = 20
    // down: from z = 5 up through the top at z = 40.
    expect(k.properties(shape).volume).toBeCloseTo(40 * 30 * 40 - PI * 4 * 20 - PI * 4 * 35, 3);
  });

  it('a subtracted copy that misses the body is a warning naming the instance', () => {
    const { last } = build(k, [
      block(),
      pin([5, 15]),
      {
        kind: 'pattern',
        id: 'pattern#3',
        source: { type: 'features', features: [pin([5, 15])] },
        layout: { type: 'linear', direction: [1, 0, 0], count: 5, spacing: 15 },
      },
    ]);
    // Instances at x = 20 and 35 hit; 50 and 65 are off the block.
    expect(last.ok).toBe(true);
    expect(last.warnings).toMatchObject([
      { code: 'missed', featureId: 'pattern#3', instances: ['pattern#3:i4', 'pattern#3:i5'] },
    ]);

    const mirrored = build(k, [
      block(),
      pin([5, 15]),
      {
        kind: 'mirror',
        id: 'mirror#3',
        source: { type: 'features', features: [pin([5, 15])] },
        plane: { origin: [-10, 0, 0], normal: [1, 0, 0] },
      },
    ]);
    expect(mirrored.last.warnings).toMatchObject([
      { code: 'missed', instances: ['mirror#3:image'] },
    ]);
  });

  it('pattern counts are capped', () => {
    const base = build(k, [block()]).shape;
    const out = apply(k, base, {
      kind: 'pattern',
      id: 'pattern#2',
      source: { type: 'body' },
      layout: { type: 'linear', direction: [1, 0, 0], count: MAX_PATTERN_COUNT + 1, spacing: 50 },
    });
    expect(out.errors).toMatchObject([{ code: 'invalid' }]);
    expect(out.errors[0]!.message).toContain(String(MAX_PATTERN_COUNT));
  });
});

describe('bodies', () => {
  /** A 40 x 30 x 20 block from x0, as its own body. */
  const boxAt = (id: string, x0: number, mode: ExtrudeInput['mode'] = 'new'): ExtrudeInput => ({
    ...block(id),
    profile: profile(XY, rectangle(x0, 0, x0 + 40, 30)),
    mode,
  });
  const volumeOf = (shape: ShapeId) => k.properties(shape).volume;
  const ids = (bodies: readonly { id: string }[]) => bodies.map((b) => b.id);

  it('two overlapping new boxes are two bodies, each with its own exact volume', () => {
    const { bodies, last } = build(k, [block(), boxAt('extrude#2', 20)]);
    expect(ids(bodies)).toEqual(['extrude#1', 'extrude#2']);
    // Not 48,000 for one compound counting the shared 12,000 twice: 24,000 plus 24,000.
    expect(volumeOf(bodies[0]!.shape)).toBeCloseTo(24000, 6);
    expect(volumeOf(bodies[1]!.shape)).toBeCloseTo(24000, 6);
    expect(last.bodies.map((b) => b.solids)).toEqual([1, 1]);
    // Names stay unique across the overlapping bodies.
    const all = bodies.flatMap((b) => faceNames(named(k, b.shape)));
    expect(new Set(all).size).toBe(all.length);
  });

  it('a new solid that only touches the body is a second body', () => {
    const { bodies } = build(k, [
      block(),
      {
        ...block('extrude#2'),
        profile: profile(XY, rectangle(40, 0, 50, 30, ['f1', 'f2', 'f3', 'f4'])),
      },
    ]);
    expect(ids(bodies)).toEqual(['extrude#1', 'extrude#2']);
    expect(volumeOf(bodies[1]!.shape)).toBeCloseTo(6000, 6);
  });

  it('a new body takes the id it is given, and may not reuse one', () => {
    const { bodies } = build(k, [block(), { ...boxAt('extrude#2', 100), body: 'extrude#2:b' }]);
    expect(ids(bodies)).toEqual(['extrude#1', 'extrude#2:b']);
    const clash = apply(k, bodies, { ...boxAt('extrude#3', 200), body: 'extrude#1' });
    expect(clash.errors).toMatchObject([{ code: 'invalid' }]);
    expect(clash.bodies).toMatchObject(bodies);
  });

  it('an add touching both bodies merges them under the first id, fused', () => {
    const base = build(k, [block(), boxAt('extrude#2', 60)]).bodies;
    const out = apply(k, base, boxAt('extrude#3', 30, 'add'));
    expect(out.errors).toEqual([]);
    expect(ids(out.bodies)).toEqual(['extrude#1']);
    expect(out).toMatchObject({ created: [], changed: ['extrude#1'], consumed: ['extrude#2'] });
    expect(volumeOf(out.shape!)).toBeCloseTo(60000, 6);
    expect(out.bodies[0]!.solids).toBe(1);
    // Names of all three stay unique through the merge.
    const names = faceNames(named(k, out.shape!));
    expect(new Set(names).size).toBe(names.length);
    expect(names.some((n) => n.startsWith('extrude#2:'))).toBe(true);
  });

  it('an add touching one body leaves the other alone, shape id and all', () => {
    const base = build(k, [block(), boxAt('extrude#2', 100)]).bodies;
    const out = apply(k, base, boxAt('extrude#3', 20, 'add'));
    expect(ids(out.bodies)).toEqual(['extrude#1', 'extrude#2']);
    expect(out.changed).toEqual(['extrude#1']);
    expect(out.bodies[1]!.shape).toBe(base[1]!.shape);
    expect(volumeOf(out.bodies[0]!.shape)).toBeCloseTo(36000, 6);
  });

  it('an add touching no body is a body of its own, under the add feature id, with a warning', () => {
    const base = build(k, [block()]).bodies;
    const out = apply(k, base, boxAt('extrude#2', 100, 'add'));
    expect(out.errors).toEqual([]);
    expect(ids(out.bodies)).toEqual(['extrude#1', 'extrude#2']);
    expect(out.created).toEqual(['extrude#2']);
    expect(out.warnings).toMatchObject([{ code: 'detached', bodies: ['extrude#2'] }]);
    expect(out.bodies[0]!.shape).toBe(base[0]!.shape);
  });

  it('an add with a scope ignores bodies outside it', () => {
    const base = build(k, [block(), boxAt('extrude#2', 60)]).bodies;
    const out = apply(k, base, { ...boxAt('extrude#3', 30, 'add'), scope: ['extrude#2'] });
    expect(ids(out.bodies)).toEqual(['extrude#1', 'extrude#2']);
    expect(out.changed).toEqual(['extrude#2']);
    expect(out.bodies[0]!.shape).toBe(base[0]!.shape);
    expect(volumeOf(out.bodies[1]!.shape)).toBeCloseTo(24000 + 30 * 30 * 20, 6);
  });

  it('a scope naming a body that does not exist is a lost reference', () => {
    const base = build(k, [block()]).bodies;
    const out = apply(k, base, { ...boxAt('extrude#2', 30, 'add'), scope: ['extrude#7'] });
    expect(out.errors).toMatchObject([
      { code: 'lost', ref: 'scope', missing: ['extrude#7'], target: 'extrude#7' },
    ]);
    expect(out.bodies).toMatchObject(base);
  });

  it('a cut through two bodies cuts both, and one through a body splits it into two solids', () => {
    const base = build(k, [block(), boxAt('extrude#2', 60)]).bodies;
    const slot: ExtrudeInput = {
      kind: 'extrude',
      id: 'extrude#3',
      profile: profile(atZ(20), rectangle(20, 10, 80, 20, ['s1', 's2', 's3', 's4'])),
      extent: { type: 'throughAll' },
      reverse: true,
      mode: 'subtract',
    };
    const cut = apply(k, base, slot);
    expect(cut.errors).toEqual([]);
    expect(cut.changed).toEqual(['extrude#1', 'extrude#2']);
    for (const b of cut.bodies) expect(volumeOf(b.shape)).toBeCloseTo(24000 - 20 * 10 * 20, 6);

    const split = apply(k, base.slice(0, 1), {
      ...slot,
      id: 'extrude#4',
      profile: profile(atZ(20), rectangle(15, -1, 25, 31, ['s1', 's2', 's3', 's4'])),
    });
    expect(split.errors).toEqual([]);
    expect(ids(split.bodies)).toEqual(['extrude#1']);
    expect(split.bodies[0]!.solids).toBe(2);
    expect(volumeOf(split.shape!)).toBeCloseTo(24000 - 10 * 30 * 20, 6);
  });

  it('a cut with a scope, or one that misses a body, leaves that body alone', () => {
    const base = build(k, [block(), boxAt('extrude#2', 60)]).bodies;
    const pinAt = (x: number, extra: Partial<ExtrudeInput> = {}): ExtrudeInput => ({
      kind: 'extrude',
      id: 'extrude#3',
      profile: profile(atZ(20), circle([x, 15], 2)),
      extent: { type: 'throughAll' },
      reverse: true,
      mode: 'subtract',
      ...extra,
    });
    const scoped = apply(k, base, {
      ...pinAt(20, { profile: profile(atZ(20), rectangle(20, 10, 80, 20)) }),
      scope: ['extrude#2'],
    });
    expect(scoped.changed).toEqual(['extrude#2']);
    expect(scoped.bodies[0]!.shape).toBe(base[0]!.shape);
    const missed = apply(k, base, pinAt(80));
    expect(missed.changed).toEqual(['extrude#2']);
    expect(missed.bodies[0]!.shape).toBe(base[0]!.shape);
    const nowhere = apply(k, base, pinAt(50));
    expect(nowhere).toMatchObject({ ok: true, changed: [], created: [] });
    expect(nowhere.bodies).toMatchObject(base);
  });

  it('an intersect acts on each body it reaches; reaching none leaves nothing', () => {
    const base = build(k, [block(), boxAt('extrude#2', 100)]).bodies;
    const common = apply(k, base, boxAt('extrude#3', 20, 'intersect'));
    expect(common.changed).toEqual(['extrude#1']);
    expect(volumeOf(common.bodies[0]!.shape)).toBeCloseTo(12000, 6);
    expect(common.bodies[1]!.shape).toBe(base[1]!.shape);
    const none = apply(k, base, boxAt('extrude#3', 200, 'intersect'));
    expect(none.errors).toMatchObject([{ code: 'empty' }]);
  });

  it('a fillet on an edge of body 2 leaves body 1 unchanged, shape id and all', () => {
    const base = build(k, [block(), boxAt('extrude#2', 20)]).bodies;
    const out = apply(k, base, {
      kind: 'fillet',
      id: 'fillet#3',
      radius: 2,
      edges: [{ id: 'r1', ref: { faces: ['extrude#2:cap:end', 'extrude#2:side:e1'] } }],
    });
    expect(out.errors).toEqual([]);
    expect(out.changed).toEqual(['extrude#2']);
    expect(out.bodies[0]!.shape).toBe(base[0]!.shape);
    expect(faceNames(named(k, out.bodies[1]!.shape))).toContain('fillet#3:round:r1');
    expect(volumeOf(out.bodies[1]!.shape)).toBeCloseTo(24000 - (4 - PI) * 40, 6);
  });

  it('a fillet with edges on two bodies blends both; one edge between two bodies is invalid', () => {
    const base = build(k, [block(), boxAt('extrude#2', 100)]).bodies;
    const both = apply(k, base, {
      kind: 'fillet',
      id: 'fillet#3',
      radius: 2,
      edges: [
        { id: 'r1', ref: { faces: [TOP, side('e1')] } },
        { id: 'r2', ref: { faces: ['extrude#2:cap:end', 'extrude#2:side:e1'] } },
      ],
    });
    expect(both.errors).toEqual([]);
    expect(both.changed).toEqual(['extrude#1', 'extrude#2']);
    const spans = apply(k, base, {
      kind: 'fillet',
      id: 'fillet#3',
      radius: 2,
      edges: [{ id: 'r1', ref: { faces: [TOP, 'extrude#2:side:e1'] } }],
    });
    expect(spans.errors).toMatchObject([{ code: 'invalid', ref: 'r1' }]);
    expect(spans.errors[0]!.message).toContain('extrude#1 and extrude#2');
    // A name on neither body is still lost, not spanning.
    const lost = apply(k, base, {
      kind: 'fillet',
      id: 'fillet#3',
      radius: 2,
      edges: [{ id: 'r1', ref: { faces: [TOP, 'extrude#9:side:e1'] } }],
    });
    expect(lost.errors).toMatchObject([{ code: 'lost', missing: ['extrude#9:side:e1'] }]);
  });

  it('a shell acts on the body that owns its faces', () => {
    const base = build(k, [block(), boxAt('extrude#2', 100)]).bodies;
    const out = apply(k, base, {
      kind: 'shell',
      id: 'shell#3',
      thickness: 2,
      faces: [{ id: 'r1', ref: { face: 'extrude#2:cap:end' } }],
    });
    expect(out.errors).toEqual([]);
    expect(out.changed).toEqual(['extrude#2']);
    expect(out.bodies[0]!.shape).toBe(base[0]!.shape);
    expect(volumeOf(out.bodies[1]!.shape)).toBeCloseTo(24000 - 36 * 26 * 18, 4);
  });

  it('a new body pattern gives one body per instance', () => {
    const { bodies, last } = build(k, [
      block(),
      {
        kind: 'pattern',
        id: 'pattern#2',
        source: { type: 'body', mode: 'new' },
        layout: { type: 'linear', direction: [1, 0, 0], count: 3, spacing: 20 },
      },
    ]);
    // Overlapping copies stay separate bodies.
    expect(ids(bodies)).toEqual(['extrude#1', 'pattern#2:i2', 'pattern#2:i3']);
    expect(last.created).toEqual(['pattern#2:i2', 'pattern#2:i3']);
    for (const b of bodies) expect(volumeOf(b.shape)).toBeCloseTo(24000, 6);
    expect(faceNames(named(k, bodies[2]!.shape))).toContain('pattern#2:i3/extrude#1:cap:end');
  });

  it('a body pattern with a scope copies only those bodies; several get /<body id> ids', () => {
    const base = build(k, [block(), boxAt('extrude#2', 100)]).bodies;
    const pattern = (scope?: string[]): FeatureInput => ({
      kind: 'pattern',
      id: 'pattern#3',
      ...(scope ? { scope } : {}),
      source: { type: 'body', mode: 'new' },
      layout: { type: 'linear', direction: [0, 1, 0], count: 2, spacing: 50 },
    });
    expect(ids(apply(k, base, pattern(['extrude#2'])).bodies)).toEqual([
      'extrude#1',
      'extrude#2',
      'pattern#3:i2',
    ]);
    expect(ids(apply(k, base, pattern()).bodies)).toEqual([
      'extrude#1',
      'extrude#2',
      'pattern#3:i2/extrude#1',
      'pattern#3:i2/extrude#2',
    ]);
  });

  it('a mirror of a new feature makes a body named after the image', () => {
    const { bodies } = build(k, [
      block(),
      {
        kind: 'mirror',
        id: 'mirror#2',
        source: { type: 'features', features: [boxAt('extrude#1', 0)] },
        plane: { origin: [-10, 0, 0], normal: [1, 0, 0] },
      },
    ]);
    expect(ids(bodies)).toEqual(['extrude#1', 'mirror#2:image']);
    expectGolden(k, bodies[1]!.shape, {
      volume: 24000,
      faces: 6,
      min: [-60, 0, 0],
      max: [-20, 30, 20],
    });
  });

  it('a hole drills every body in scope it reaches, and fails only when it misses them all', () => {
    const base = build(k, [block(), boxAt('extrude#2', 20)]).bodies;
    const hole: FeatureInput = {
      kind: 'hole',
      id: 'hole#3',
      frame: atZ(20),
      points: [{ id: 'p1', at: [30, 15] }],
      diameter: 4,
      extent: { type: 'throughAll' },
      head: { type: 'simple' },
    };
    const out = apply(k, base, hole);
    expect(out.errors).toEqual([]);
    expect(out.changed).toEqual(['extrude#1', 'extrude#2']);
    const one = apply(k, base, { ...hole, scope: ['extrude#2'] });
    expect(one.changed).toEqual(['extrude#2']);
    const miss = apply(k, base, { ...hole, points: [{ id: 'p1', at: [300, 15] }] });
    expect(miss.errors).toMatchObject([{ code: 'invalid' }]);
  });

  it('join returns the bodies as one compound under the first id', () => {
    const base = build(k, [block()]).bodies;
    const out = apply(k, base, boxAt('extrude#2', 20), { join: true });
    expect(out.errors).toEqual([]);
    expect(ids(out.bodies)).toEqual(['extrude#1']);
    expect(out).toMatchObject({ created: [], changed: ['extrude#1'], consumed: [] });
    expect(out.bodies[0]!.solids).toBe(2);
    const names = faceNames(named(k, out.shape!));
    expect(names).toContain('extrude#2:cap:end');
    expect(names).toContain(TOP);
  });

  it('refuses a malformed body set', () => {
    const base = build(k, [block()]).bodies;
    const twice = apply(k, [...base, base[0]!], boxAt('extrude#2', 100));
    expect(twice.errors).toMatchObject([{ code: 'invalid' }]);
    const unknown = apply(
      k,
      [{ id: 'extrude#1', shape: 999_999 as ShapeId }],
      boxAt('extrude#2', 100),
    );
    expect(unknown.errors).toMatchObject([{ code: 'no-body' }]);
    expect(unknown.bodies).toMatchObject([{ id: 'extrude#1', names: null, solids: 0 }]);
    const badScope = apply(k, base, { ...boxAt('extrude#2', 100, 'add'), scope: ['x', 'x'] });
    expect(badScope.errors).toMatchObject([{ code: 'invalid' }]);
  });
});
