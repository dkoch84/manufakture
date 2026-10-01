// The checks on real kernel output (plan T3.1c): meshes and topology from the Node kernel, with
// the names the feature operations give. The M1 bracket at 6 mm has no thickness issues, a
// 0.8 mm tube wall reads as 0.8 on the `fine` export mesh, the bracket's holes come out of its
// topology (and need teardrops once it is laid on its side), and a modelled M5 thread in a
// horizontal hole is recognised by its axis.

import {
  applyFeature,
  holeSize,
  threadSize,
  type FeatureBody,
  type FeatureInput,
  type FeatureOutcome,
  type Frame,
  type Kernel,
  type ProfileEntity,
  type SketchProfile,
  type Vec2,
  type Vec3,
} from '@manufakture/kernel';
import { createNodeKernel } from '@manufakture/kernel/node';
import { beforeAll, describe, expect, it } from 'vitest';
import { analyzeHoles, type FaceNameSource } from './features';
import { quatFromAxisAngle } from './geometry';
import { analyzeThickness } from './thickness';
import { printThresholds } from './thresholds';

let k: Kernel;

beforeAll(async () => {
  k = await createNodeKernel();
}, 60_000);

/** The export tolerances of `packages/io` (`EXPORT_TOLERANCES`): chordal mm, angular rad. */
const NORMAL = { linear: 0.02, angular: 0.25 };
const FINE = { linear: 0.005, angular: 0.1 };

const XY: Frame = { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] };
const FRONT: Frame = { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, -1, 0] };

function polygon(points: readonly Vec2[], ids: readonly string[]): ProfileEntity[] {
  return points.map((start, i) => ({
    kind: 'line' as const,
    id: ids[i]!,
    start,
    end: points[(i + 1) % points.length]!,
  }));
}

function profile(frame: Frame, ...loops: ProfileEntity[][]): SketchProfile {
  return { frame, loops: loops.map((entities) => ({ entities })) };
}

/** Apply features in order; the one body at the end, with its topology and face names. */
function build(features: readonly FeatureInput[]) {
  let bodies: FeatureBody[] = [];
  let last: FeatureOutcome | null = null;
  for (const f of features) {
    last = applyFeature(k, bodies, f);
    expect(last.errors, `${f.id}`).toEqual([]);
    bodies = last.bodies.map((b) => ({ id: b.id, shape: b.shape }));
  }
  expect(last!.bodies).toHaveLength(1);
  const body = last!.bodies[0]!;
  const names: FaceNameSource = {
    names: body.names!.faces.map((f) => f.name),
    faceNames: Uint32Array.from(body.names!.faces, (_, i) => i),
  };
  return { shape: body.shape, topology: k.topology(body.shape), names };
}

/** The M1 bracket (packages/kernel/test/bracket.test.ts) with walls t thick. */
function bracket(t: number): FeatureInput[] {
  const M4 = holeSize('M4')!;
  return [
    {
      kind: 'extrude',
      id: 'extrude#1',
      profile: profile(
        FRONT,
        polygon(
          [
            [0, 0],
            [50, 0],
            [50, t],
            [t, t],
            [t, 40],
            [0, 40],
          ],
          ['e1', 'e2', 'e3', 'e4', 'e5', 'e6'],
        ),
      ),
      extent: { type: 'symmetric', distance: 30 },
      mode: 'new',
    },
    {
      kind: 'hole',
      id: 'hole#1',
      frame: { origin: [0, 0, t], xDir: [1, 0, 0], normal: [0, 0, 1] },
      points: [
        { id: 'e7', at: [25, 0] },
        { id: 'e8', at: [40, 0] },
      ],
      diameter: M4.clearance.normal,
      extent: { type: 'throughAll' },
      head: { type: 'counterbore', diameter: M4.counterbore.diameter, depth: M4.counterbore.depth },
    },
    {
      kind: 'fillet',
      id: 'fillet#1',
      radius: 4,
      edges: [{ id: 'r2', ref: { faces: ['extrude#1:side:e3', 'extrude#1:side:e4'] } }],
    },
  ];
}

describe('on kernel meshes', () => {
  it('the M1 bracket at 6 mm has no thickness issues', () => {
    const b = build(bracket(6));
    const mesh = k.mesh(b.shape, NORMAL);
    const r = analyzeThickness([{ mesh }], { thresholds: printThresholds(0.4) });
    expect(r.issues).toEqual([]);
    // The thinnest wall is under the counterbores: 6 - 4.4 = 1.6 mm.
    const min = Math.min(...r.bodies[0]!.faces.map((f) => f.minThickness));
    expect(min).toBeCloseTo(1.6, 2);
    k.release(b.shape);
  }, 60_000);

  it('a 0.8 mm tube wall reads as 0.8 on the fine mesh, and is thin', () => {
    const tube = build([
      {
        kind: 'extrude',
        id: 'extrude#1',
        profile: profile(
          XY,
          [{ kind: 'circle', id: 'c1', center: [0, 0], radius: 5 }],
          [{ kind: 'circle', id: 'c2', center: [0, 0], radius: 4.2 }],
        ),
        extent: { type: 'blind', distance: 10 },
        mode: 'new',
      },
    ]);
    const mesh = k.mesh(tube.shape, FINE);
    const r = analyzeThickness([{ mesh }]);
    const cylinders = tube.topology.faces.filter((f) => f.surface === 'cylinder');
    expect(cylinders).toHaveLength(2);
    for (const f of cylinders) {
      const face = r.bodies[0]!.faces[f.index - 1]!;
      // Both walls are inscribed polygons, 0.005 mm chordal: the wall reads within 0.01.
      expect(Math.abs(face.minThickness - 0.8)).toBeLessThan(0.011);
      // Every triangle of the curved wall found the other side (enough samples per facet).
      const values = [...r.bodies[0]!.thickness].filter(
        (_, t) => mesh.triangleFaces[t] === f.index,
      );
      for (const v of values) expect(Math.abs(v - 0.8)).toBeLessThan(0.011);
      expect(r.issues.find((i) => i.face === f.index)?.kind).toBe('thinWall');
      expect(r.issues.find((i) => i.face === f.index)!.area).toBeCloseTo(f.area, 0);
    }
    expect(analyzeHoles(tube.topology).groups.map((g) => `${g.side} ${g.diameter}`)).toEqual(
      expect.arrayContaining(['pin 10', 'hole 8.4']),
    );
    k.release(tube.shape);
  }, 60_000);

  it("the bracket's holes from its topology: vertical as modelled, teardrops on its side", () => {
    const b = build(bracket(6));
    const flat = analyzeHoles(b.topology, { names: b.names });
    const holes = flat.groups.filter((g) => g.side === 'hole');
    // Two through holes of 4.5 and two counterbores of 8, each its own group.
    expect(holes.map((g) => g.diameter.toFixed(3)).sort()).toEqual([
      '4.500',
      '4.500',
      '8.000',
      '8.000',
    ]);
    expect(holes.every((g) => !g.horizontal)).toBe(true);
    // The fillet's round is a horizontal cylinder too, a quarter of one, whose normal points
    // toward its axis: it would read as an 8 mm horizontal hole, but it goes only a quarter of the
    // way round, so it is partial and not checked.
    expect(flat.partial.map((g) => g.faces.map((f) => b.names.names[f - 1]))).toEqual([
      ['fillet#1:round:r2'],
    ]);
    expect(flat.partial[0]).toMatchObject({ side: 'hole', horizontal: true });
    expect(flat.issues).toEqual([]);
    // Laid on its back (the upright's outside face down), the holes run horizontally.
    const onBack = analyzeHoles(b.topology, {
      names: b.names,
      placement: { rotation: quatFromAxisAngle([0, 1, 0], Math.PI / 2), translation: [0, 0, 0] },
    });
    const flagged = onBack.issues.filter((i) => i.kind === 'teardrop').map((i) => i.diameter);
    expect(flagged.map((d) => d.toFixed(3)).sort()).toEqual(['4.500', '4.500', '8.000', '8.000']);
    k.release(b.shape);
  }, 60_000);

  it('a modelled M5 thread in a horizontal hole is neither a small hole nor a teardrop', () => {
    const M5 = threadSize('iso-metric', 'M5')!;
    const X: Vec3 = [1, 0, 0];
    // A block with a hole along x at the M5 minor diameter, and a plain 4.5 mm hole beside it.
    const side: Frame = { origin: [0, 0, 0], xDir: [0, 1, 0], normal: X };
    const b = build([
      {
        kind: 'extrude',
        id: 'hole#3',
        profile: profile(
          side,
          polygon(
            [
              [-6, -6],
              [16, -6],
              [16, 6],
              [-6, 6],
            ],
            ['e1', 'e2', 'e3', 'e4'],
          ),
          [{ kind: 'circle', id: 'h1', center: [0, 0], radius: M5.minor / 2 }],
          [{ kind: 'circle', id: 'h2', center: [10, 0], radius: 2.25 }],
        ),
        extent: { type: 'blind', distance: 8 },
        mode: 'new',
      },
      {
        kind: 'thread',
        id: 'thread#5',
        axis: { origin: [0, 0, 0], direction: X },
        side: 'internal',
        radius: M5.minor / 2,
        major: M5.major,
        pitch: M5.pitch,
        length: 8,
      },
    ]);
    const r = analyzeHoles(b.topology, { names: b.names });
    // The crest strips (named after the hole) and the thread's roots are one threaded hole...
    expect(r.threaded).toHaveLength(1);
    expect(r.threaded[0]!.diameter).toBeCloseTo(M5.minor, 9);
    expect(
      r.threaded[0]!.faces.every((f) => b.names.names[f - 1]!.startsWith('hole#3:side:h1')),
    ).toBe(true);
    // ...and the plain hole beside it is checked: horizontal, 4.5 mm, a teardrop.
    expect(r.groups.filter((g) => g.side === 'hole').map((g) => g.diameter)).toEqual([4.5]);
    expect(r.issues.map((i) => `${i.kind} ${i.diameter}`)).toEqual(['teardrop 4.5']);
    k.release(b.shape);
  }, 60_000);
});
