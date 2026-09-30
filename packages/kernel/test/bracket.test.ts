// Golden test for the M1 bracket (docs/m1-acceptance.md), at the kernel: the same features the
// UI walkthrough makes, applied with `applyFeature`, with each feature's volume, face count and
// bounding box against values computed by hand, for two wall thicknesses. The second
// thickness is the topological naming regression of the walkthrough: the hole sketch's face and
// the fillet's edge are stored by name and must resolve exactly, on the same faces, after the
// walls change.
//
// An L-profile on Front (XZ) (sketch x = world X, sketch y = world Z, normal -Y): a foot 50
// long, an upright 40 high, walls t thick, extruded 30 symmetric about the plane. Two M4
// counterbored holes (4.5 through, 8 x 4.4 counterbore) at X = 25 and X = 40 through the foot,
// drilled from its top face; a 4 mm fillet in the inside corner.

import { beforeAll, describe, expect, it } from 'vitest';
import { type FeatureInput } from '../src/features';
import {
  apply,
  build,
  expectGolden,
  faceIndex,
  faceNames,
  named,
  neighbours,
  polygon,
  profile,
} from '../src/fixtures/parts';
import { holeSize } from '../src/holes';
import type { Kernel } from '../src/kernel';
import { createNodeKernel } from '../src/node';
import type { Frame, Vec3 } from '../src/types';

let k: Kernel;

beforeAll(async () => {
  k = await createNodeKernel();
}, 60_000);

const PI = Math.PI;
const L = 50;
const H = 40;
const W = 30;
const R = 4;
const M4 = holeSize('M4')!;
const d = M4.clearance.normal;
const cb = M4.counterbore;

const FRONT: Frame = { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, -1, 0] };
const TOP = 'extrude#1:side:e3';
const INSIDE = 'extrude#1:side:e4';
const MIN: Vec3 = [0, -W / 2, 0];
const MAX: Vec3 = [L, W / 2, H];

function bracket(t: number): FeatureInput[] {
  return [
    {
      kind: 'extrude',
      id: 'extrude#1',
      profile: profile(
        FRONT,
        polygon(
          [
            [0, 0],
            [L, 0],
            [L, t],
            [t, t],
            [t, H],
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
      // The foot's top face, as regen resolves a sketch on it: origin over the world origin.
      frame: { origin: [0, 0, t], xDir: [1, 0, 0], normal: [0, 0, 1] },
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
}

const volumes = (t: number) => {
  const extruded = W * (L * t + (H - t) * t);
  const hole = PI * ((cb.diameter / 2) ** 2 * cb.depth + (d / 2) ** 2 * (t - cb.depth));
  const holed = extruded - 2 * hole;
  return { extruded, holed, filleted: holed + W * R * R * (1 - PI / 4) };
};

describe.each([6, 8])('the M1 bracket with %d mm walls', (t) => {
  const v = volumes(t);

  it('each feature: volume, face count and bounding box', () => {
    const features = bracket(t);
    const extruded = build(k, features.slice(0, 1)).shape;
    expectGolden(k, extruded, { volume: v.extruded, faces: 8, min: MIN, max: MAX });
    const holed = build(k, features.slice(1, 2), extruded).shape;
    expectGolden(k, holed, { volume: v.holed, faces: 14, min: MIN, max: MAX });
    const filleted = build(k, features.slice(2), holed).shape;
    expectGolden(k, filleted, { volume: v.filleted, faces: 15, min: MIN, max: MAX });
  });

  it('keeps the fillet on the inside corner and both holes, resolved exactly by name', () => {
    const { shape, outcomes } = build(k, bracket(t));
    for (const o of outcomes) {
      expect(o.warnings).toEqual([]);
      for (const r of o.resolved) expect(r).toMatchObject({ via: 'exact', fragile: false });
    }
    const b = named(k, shape);
    const round = b.topology.faces[faceIndex(b, 'fillet#1:round:r2') - 1]!;
    expect(round.surface).toBe('cylinder');
    expect(round.radius).toBeCloseTo(R, 9);
    expect(neighbours(b, faceIndex(b, 'fillet#1:round:r2'))).toEqual(
      ['extrude#1:cap:end', 'extrude#1:cap:start', TOP, INSIDE].sort(),
    );
    const names = faceNames(b);
    expect(names.filter((n) => n.startsWith('hole#1:wall:')).sort()).toEqual([
      'hole#1:wall:e7',
      'hole#1:wall:e8',
    ]);
    for (const p of ['e7', 'e8']) {
      const floor = b.topology.faces[faceIndex(b, `hole#1:cbore-floor:${p}`) - 1]!;
      expect(floor.centroid[2]).toBeCloseTo(t - cb.depth, 6);
    }
  });
});

it('a hole outside the foot is an error, not a silent no-op', () => {
  const features = bracket(6);
  const extruded = build(k, features.slice(0, 1)).shape;
  const out = apply(k, extruded, {
    ...(features[1] as Extract<FeatureInput, { kind: 'hole' }>),
    points: [{ id: 'e7', at: [80, 0] }],
  });
  expect(out.ok).toBe(false);
  expect(out.errors.map((e) => e.code)).toEqual(['invalid']);
});
