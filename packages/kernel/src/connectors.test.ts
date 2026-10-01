// Goldens for mate connector frames (`connectorFrame`): planar faces, circular edges, cylinders,
// straight edges and vertices, each checked against geometry computed by hand, plus the
// failures (lost, unsuitable), vertex references and the `connector` op through the service.
// One kernel for the file.

import { beforeAll, describe, expect, it } from 'vitest';
import {
  connectorFrame,
  pickVertex,
  resolveVertex,
  type ConnectorInference,
  type ConnectorOrigin,
  type ConnectorReport,
  type ExtrudeInput,
} from './features';
import { XY, atZ, build, circle, named, profile, rectangle } from './fixtures/parts';
import type { Kernel } from './kernel';
import { createNodeKernel, createNodeService } from './node';
import { validateOp } from './ops';
import type { KernelService } from './service';
import type { Frame, ShapeId, Vec3 } from './types';

let k: Kernel;

beforeAll(async () => {
  k = await createNodeKernel();
}, 60_000);

const TOP = 'extrude#1:cap:end';
const BOTTOM = 'extrude#1:cap:start';
const side = (id: string, f = 'extrude#1') => `${f}:side:${id}`;

/** The 40 x 30 x 20 block: rectangle e1 (front, y = 0), e2 (right), e3 (back), e4 (left). */
const block: ExtrudeInput = {
  kind: 'extrude',
  id: 'extrude#1',
  profile: profile(XY, rectangle(0, 0, 40, 30)),
  extent: { type: 'blind', distance: 20 },
  mode: 'new',
};

/** A 5 mm hole through the block at (20, 15), cut down from the top. */
const hole: ExtrudeInput = {
  kind: 'extrude',
  id: 'extrude#2',
  profile: profile(atZ(20), circle([20, 15], 5)),
  extent: { type: 'throughAll' },
  reverse: true,
  mode: 'subtract',
};

/** A 5 mm boss 10 high on the top at (20, 15). */
const boss: ExtrudeInput = {
  kind: 'extrude',
  id: 'extrude#2',
  profile: profile(atZ(20), circle([20, 15], 5)),
  extent: { type: 'blind', distance: 10 },
  mode: 'add',
};

function frame(
  shape: ShapeId,
  origin: ConnectorOrigin,
  inference: ConnectorInference,
): Extract<ConnectorReport, { ok: true }> {
  const r = connectorFrame(k, shape, origin, inference);
  expect(r, JSON.stringify(r)).toMatchObject({ ok: true });
  return r as Extract<ConnectorReport, { ok: true }>;
}

function expectFrame(actual: Frame, expected: Frame, tol = 1e-6): void {
  for (const key of ['origin', 'xDir', 'normal'] as const) {
    actual[key].forEach((v, i) => {
      expect(Math.abs(v - expected[key][i]!), `${key}[${i}] ${actual[key].join(',')}`).toBeLessThan(
        tol,
      );
    });
  }
  // Right-handed and orthonormal.
  const [a, b] = [actual.xDir, actual.normal];
  expect(Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2])).toBeLessThan(1e-9);
  expect(Math.hypot(...a)).toBeCloseTo(1, 12);
  expect(Math.hypot(...b)).toBeCloseTo(1, 12);
}

const X: Vec3 = [1, 0, 0];
const Y: Vec3 = [0, 1, 0];
const Z: Vec3 = [0, 0, 1];
const neg = (v: Vec3): Vec3 => [-v[0], -v[1], -v[2]];

describe('connector frames on planar faces', () => {
  it('sits at the centroid with z the outward normal and x from world X', () => {
    const { shape } = build(k, [block]);
    const top = frame(shape, { face: TOP }, 'centroid');
    expectFrame(top.frame, { origin: [20, 15, 20], xDir: X, normal: Z });
    expect(top).toMatchObject({ kind: 'face', via: 'exact', fragile: false, oriented: true });
    expectFrame(frame(shape, { face: BOTTOM }, 'centroid').frame, {
      origin: [20, 15, 0],
      xDir: X,
      normal: neg(Z),
    });
    expectFrame(frame(shape, { face: side('e1') }, 'centroid').frame, {
      origin: [20, 0, 10],
      xDir: X,
      normal: neg(Y),
    });
    // A face that faces X takes world Y for x.
    expectFrame(frame(shape, { face: side('e2') }, 'centroid').frame, {
      origin: [40, 15, 10],
      xDir: Y,
      normal: X,
    });
  });

  it('has no centre, and a centroid needs a face', () => {
    const { shape } = build(k, [block]);
    expect(connectorFrame(k, shape, { face: TOP }, 'centre')).toMatchObject({
      ok: false,
      status: 'unsuitable',
      message: expect.stringMatching(/has no centre/),
    });
    expect(connectorFrame(k, shape, { faces: [TOP, side('e1')] }, 'centroid')).toMatchObject({
      ok: false,
      status: 'unsuitable',
    });
  });
});

describe('connector frames on circular edges', () => {
  it('centres a hole rim with z out of the face it is drilled in', () => {
    const { shape } = build(k, [block, hole]);
    const top = frame(shape, { faces: [TOP, side('c1', 'extrude#2')] }, 'centre');
    expectFrame(top.frame, { origin: [20, 15, 20], xDir: X, normal: Z });
    expect(top).toMatchObject({ kind: 'edge', oriented: true });
    expectFrame(frame(shape, { faces: [BOTTOM, side('c1', 'extrude#2')] }, 'centre').frame, {
      origin: [20, 15, 0],
      xDir: X,
      normal: neg(Z),
    });
  });

  it("centres a boss's top rim with z up, and its midpoint lies on the circle", () => {
    const { shape } = build(k, [block, boss]);
    const rim = { faces: ['extrude#2:cap:end', side('c1', 'extrude#2')] };
    expectFrame(frame(shape, rim, 'centre').frame, { origin: [20, 15, 30], xDir: X, normal: Z });
    const mid = frame(shape, rim, 'midpoint').frame;
    expect(mid.origin[2]).toBeCloseTo(30, 9);
    expect(Math.hypot(mid.origin[0] - 20, mid.origin[1] - 15)).toBeCloseTo(5, 9);
    expectFrame({ ...mid, origin: [0, 0, 0] }, { origin: [0, 0, 0], xDir: X, normal: Z });
  });
});

describe('connector frames on cylinders', () => {
  it('centres a hole wall on its axis, halfway, with z toward the rim face that sorts first', () => {
    const { shape } = build(k, [block, hole]);
    const wall = { face: side('c1', 'extrude#2') };
    // Rims: extrude#1:cap:end sorts before extrude#1:cap:start, so the axis points up.
    const centre = frame(shape, wall, 'centre');
    expectFrame(centre.frame, { origin: [20, 15, 10], xDir: X, normal: Z });
    expect(centre.oriented).toBe(true);
    // A whole cylinder's centroid is on its axis too.
    expectFrame(frame(shape, wall, 'centroid').frame, {
      origin: [20, 15, 10],
      xDir: X,
      normal: Z,
    });
  });

  it("centres a boss's side with z toward the face it stands on (it sorts first)", () => {
    const { shape } = build(k, [block, boss]);
    expectFrame(frame(shape, { face: side('c1', 'extrude#2') }, 'centre').frame, {
      origin: [20, 15, 25],
      xDir: X,
      normal: neg(Z),
    });
  });
});

describe('connector frames on straight edges', () => {
  it('sits at the midpoint with z along the edge as the features orient it', () => {
    const { shape } = build(k, [block]);
    // cap:end then side:e1: +z x -y = +x.
    const front = frame(shape, { faces: [TOP, side('e1')] }, 'midpoint');
    expectFrame(front.frame, { origin: [20, 0, 20], xDir: Y, normal: X });
    // cap:end then side:e3 (back, +y): +z x +y = -x.
    expectFrame(frame(shape, { faces: [TOP, side('e3')] }, 'midpoint').frame, {
      origin: [20, 30, 20],
      xDir: Y,
      normal: neg(X),
    });
    // A vertical edge: side:e1 (-y) then side:e2 (+x): -y x +x = +z.
    expectFrame(frame(shape, { faces: [side('e1'), side('e2')] }, 'midpoint').frame, {
      origin: [40, 0, 10],
      xDir: X,
      normal: Z,
    });
    expect(connectorFrame(k, shape, { faces: [TOP, side('e1')] }, 'centre')).toMatchObject({
      ok: false,
      status: 'unsuitable',
    });
  });
});

describe('connector frames on vertices', () => {
  it('sits on the vertex with the world axes, found by the faces around it', () => {
    const { shape } = build(k, [block]);
    const corner = frame(shape, { faces: [TOP, side('e1'), side('e2')].sort() }, 'vertex');
    expectFrame(corner.frame, { origin: [40, 0, 20], xDir: X, normal: Z });
    expect(corner).toMatchObject({ kind: 'vertex', via: 'exact', oriented: true });
    // Face order does not matter.
    expectFrame(
      frame(shape, { faces: [side('e2'), TOP, side('e1')] }, 'vertex').frame,
      corner.frame,
    );
  });

  it('picks a vertex as its faces, and resolves the pick back to the same vertex', () => {
    const { shape } = build(k, [block]);
    const body = named(k, shape);
    for (const v of body.topology.vertices) {
      const ref = pickVertex(body.names, body.topology, v.index)!;
      expect(ref.faces).toHaveLength(3);
      expect(ref.ordinal).toBeUndefined();
      expect(resolveVertex(body.names, body.topology, ref)).toMatchObject({
        ok: true,
        index: v.index,
        via: 'exact',
      });
    }
  });

  it('is lost when a face is gone, or when its faces no longer meet', () => {
    const { shape } = build(k, [block]);
    expect(
      connectorFrame(k, shape, { faces: [TOP, 'extrude#9:side:e1', side('e2')] }, 'vertex'),
    ).toMatchObject({ ok: false, status: 'lost', missing: ['extrude#9:side:e1'] });
    expect(connectorFrame(k, shape, { faces: [TOP, BOTTOM] }, 'vertex')).toMatchObject({
      ok: false,
      status: 'lost',
      missing: [],
      message: expect.stringMatching(/no longer meet at a vertex/),
    });
    expect(connectorFrame(k, shape, { face: TOP }, 'vertex')).toMatchObject({
      ok: false,
      status: 'unsuitable',
    });
  });
});

describe('connector failures', () => {
  it('reports a lost face and a shape without names, never throwing', () => {
    const { shape } = build(k, [block]);
    expect(connectorFrame(k, shape, { face: 'extrude#7:cap:end' }, 'centroid')).toMatchObject({
      ok: false,
      status: 'lost',
      missing: ['extrude#7:cap:end'],
      message: expect.stringMatching(/extrude#7:cap:end is lost/),
    });
    const plain = k.box(1, 1, 1);
    expect(connectorFrame(k, plain, { face: TOP }, 'centroid')).toMatchObject({
      ok: false,
      status: 'no-body',
    });
    k.release(plain);
  });
});

describe('the connector op', () => {
  let service: KernelService;

  beforeAll(async () => {
    service = await createNodeService();
  }, 60_000);

  it('validates its shape', () => {
    expect(
      validateOp({
        op: 'connector',
        shape: 1,
        connectors: [
          { origin: { face: TOP }, inference: 'centroid' },
          { origin: { faces: [TOP, side('e1')], ordinal: 2 }, inference: 'vertex' },
        ],
      }),
    ).toBeNull();
    expect(
      validateOp({
        op: 'connector',
        shape: 1,
        connectors: [{ origin: { face: TOP }, inference: 'x' }],
      }),
    ).toMatch(/inference must be one of centroid, centre, midpoint, vertex/);
    expect(validateOp({ op: 'connector', shape: 1 })).toMatch(/connectors must be an array/);
  });

  it('answers one report per connector, a lost one as a report', async () => {
    const reply = await service.run({
      generation: 1,
      ops: [
        { op: 'feature', bodies: [], feature: block },
        {
          op: 'connector',
          shape: { result: 0 },
          connectors: [
            { origin: { face: TOP }, inference: 'centroid' },
            { origin: { face: 'extrude#3:cap:end' }, inference: 'centroid' },
          ],
        },
      ],
    });
    expect(reply.status).toBe('done');
    const r = reply.results[1]!;
    expect(r.ok).toBe(true);
    const [found, lost] = (r as { value: { results: ConnectorReport[] } }).value.results;
    expect(found!.ok).toBe(true);
    if (found!.ok) expectFrame(found!.frame, { origin: [20, 15, 20], xDir: X, normal: Z });
    expect(lost).toMatchObject({ ok: false, status: 'lost' });
  });
});
