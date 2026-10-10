// The wall around a hole (#1210): bosses, plates near an edge, an off-centre hole, a slanted
// outside face, pattern copies, and the op through the service.

import { beforeAll, describe, expect, it } from 'vitest';
import type { ExtrudeInput, FeatureInput, HoleInput } from './features';
import { atZ, build, circle, polygon, profile, rectangle, XY } from './fixtures/parts';
import type { Kernel } from './kernel';
import { createNodeKernel, createNodeService } from './node';
import type { HoleWall } from './walls';

let k: Kernel;

beforeAll(async () => {
  k = await createNodeKernel();
}, 60_000);

const plate = (w = 40, d = 30, h = 4): ExtrudeInput => ({
  kind: 'extrude',
  id: 'extrude#1',
  profile: profile(XY, rectangle(0, 0, w, d)),
  extent: { type: 'blind', distance: h },
  mode: 'new',
});

/** Round bosses of `radius` from the plate's top (z = 4) up to z = 14, one per centre. */
const bosses = (radius: number, centres: [number, number][]): ExtrudeInput => ({
  kind: 'extrude',
  id: 'extrude#2',
  profile: {
    frame: atZ(4),
    regions: centres.map((c, i) => ({ loops: [{ entities: circle(c, radius, `c${i + 1}`) }] })),
  },
  extent: { type: 'blind', distance: 10 },
  mode: 'add',
});

const hole = (
  points: { id: string; at: [number, number] }[],
  extra: Partial<HoleInput> = {},
): HoleInput => ({
  kind: 'hole',
  id: 'hole#3',
  frame: atZ(14),
  points,
  diameter: 4,
  extent: { type: 'blind', depth: 6.5, tipAngle: Math.PI },
  head: { type: 'simple' },
  ...extra,
});

function walls(features: FeatureInput[], holes = ['hole#3'], range?: number): HoleWall[] {
  const { shape } = build(k, features);
  return k.holeWalls(shape, holes, range === undefined ? {} : { range });
}

describe('holeWalls', () => {
  it('reads the wall of an insert hole in a 7 mm boss as 1.5 mm, and of an 8 mm boss as 2 mm', () => {
    const thin = walls([plate(), bosses(3.5, [[8, 8]]), hole([{ id: 'p1', at: [8, 8] }])]);
    expect(thin).toHaveLength(1);
    const w = thin[0]!;
    expect([w.hole, w.point, w.face, w.radius, w.toFace]).toEqual([
      'hole#3',
      'p1',
      'hole#3:wall:p1',
      2,
      'extrude#2:side:c1',
    ]);
    expect(w.wall).toBeCloseTo(1.5, 9);
    // The witness points: on the hole wall and on the boss, 1.5 mm apart, radially.
    const rFrom = Math.hypot(w.from![0] - 8, w.from![1] - 8);
    const rTo = Math.hypot(w.to![0] - 8, w.to![1] - 8);
    expect([rFrom, rTo].map((r) => Math.round(r * 1e9) / 1e9)).toEqual([2, 3.5]);
    const wide = walls([plate(), bosses(4, [[8, 8]]), hole([{ id: 'p1', at: [8, 8] }])]);
    expect(wide[0]!.wall).toBeCloseTo(2, 9);
  });

  it('measures every point of a hole, each against its own boss', () => {
    const r = walls([
      plate(),
      bosses(3.5, [
        [8, 8],
        [30, 20],
      ]),
      hole([
        { id: 'p1', at: [8, 8] },
        // Off centre by 0.5 mm: the wall is 1 mm on one side, 2 mm on the other.
        { id: 'p2', at: [30.5, 20] },
      ]),
    ]);
    expect(r.map((w) => w.point)).toEqual(['p1', 'p2']);
    expect(r[0]!.wall).toBeCloseTo(1.5, 9);
    expect(r[1]!.wall).toBeCloseTo(1, 6);
    expect(r[1]!.to![0]).toBeCloseTo(33.5, 4);
  });

  it('finds the thin wall between a through hole and the plate edge, and to a slanted edge', () => {
    const near = walls([
      plate(),
      hole([{ id: 'p1', at: [3, 15] }], { frame: atZ(4), extent: { type: 'throughAll' } }),
    ]);
    expect(near[0]!.wall).toBeCloseTo(1, 9);
    expect(near[0]!.toFace).toBe('extrude#1:side:e4');
    // A plate whose left edge runs at 30 degrees off the y axis: the thinnest wall is square to
    // that edge, between two of the grid's rays; the search finds it.
    const t = Math.tan(Math.PI / 6);
    const slanted: ExtrudeInput = {
      ...plate(),
      profile: profile(
        XY,
        polygon(
          [
            [0, 0],
            [40, 0],
            [40, 30],
            [30 * t, 30],
          ],
          ['e1', 'e2', 'e3', 'e4'],
        ),
      ),
    };
    const centre: [number, number] = [10, 12];
    // Distance from the centre to the line x = y tan 30, less the radius.
    const expected = (centre[0] - centre[1] * t) * Math.cos(Math.PI / 6) - 2;
    const r = walls([
      slanted,
      hole([{ id: 'p1', at: centre }], { frame: atZ(4), extent: { type: 'throughAll' } }),
    ]);
    expect(r[0]!.toFace).toBe('extrude#1:side:e4');
    expect(Math.abs(r[0]!.wall! - expected)).toBeLessThan(1e-6);
  });

  it('reads no wall beyond the range, and leaves out holes it was not asked about', () => {
    const features = [
      plate(),
      hole([{ id: 'p1', at: [20, 15] }], { frame: atZ(4), extent: { type: 'throughAll' } }),
    ];
    // The nearest edge is 13 mm from the hole wall: more than the default range of 10 mm.
    expect(walls(features, ['hole#3'], 20)[0]!.wall).toBeCloseTo(13, 9);
    const short = walls(features)[0]!;
    expect([short.wall, short.from, short.to, short.toFace]).toEqual([null, null, null, null]);
    expect(walls(features, ['hole#9'])).toEqual([]);
  });

  it('finds the walls of pattern copies, by the hole and point they copy', () => {
    const drill = hole([{ id: 'p1', at: [3, 10] }], {
      frame: atZ(4),
      extent: { type: 'throughAll' },
    });
    const r = walls([
      plate(),
      drill,
      {
        kind: 'pattern',
        id: 'pattern#4',
        source: { type: 'features', features: [drill] },
        layout: { type: 'linear', direction: [1, 0, 0], count: 2, spacing: 30 },
      },
    ]);
    expect(r.map((w) => [w.face, w.point])).toEqual([
      ['hole#3:wall:p1', 'p1'],
      ['pattern#4:i2/hole#3:wall:p1', 'p1'],
    ]);
    // The original is 1 mm from the left edge; the copy at x = 33 is 5 mm from the right one.
    expect(r.map((w) => Math.round(w.wall! * 1e9) / 1e9)).toEqual([1, 5]);
  });

  it('reads a hole breaking out of the plate edge as a wall of 0, through that edge', () => {
    for (const x of [1.5, 1.9]) {
      const r = walls([
        plate(),
        hole([{ id: 'p1', at: [x, 15] }], { frame: atZ(4), extent: { type: 'throughAll' } }),
      ]);
      expect(r.length, `x = ${x}`).toBeGreaterThan(0);
      for (const w of r) {
        // The plate's edge is split in two by the hole: one of its pieces.
        expect([w.point, w.wall, w.breakout]).toEqual(['p1', 0, true]);
        expect(w.toFace).toMatch(/^extrude#1:side:e4#[12]$/);
        // The point is on the plate's edge, where the hole opens through it.
        expect(w.from![0]).toBeCloseTo(0, 9);
        expect(w.to).toEqual(w.from);
      }
    }
  });

  it('reads an insert hole breaking out of the side of its boss as a wall of 0', () => {
    // 1.7 mm off the centre of a 7 mm boss: the 4 mm hole reaches 3.7 mm out, past the boss side.
    const r = walls([plate(), bosses(3.5, [[8, 8]]), hole([{ id: 'p1', at: [9.7, 8] }])]);
    expect(r.length).toBeGreaterThan(0);
    expect(r.map((w) => [w.wall, w.breakout, w.toFace])).toEqual(
      r.map(() => [0, true, 'extrude#2:side:c1']),
    );
  });

  it('reads no wall of about 0 for a hole drilled radially into a rod', () => {
    // A rod of radius 10 along x, a 4 mm flat-bottomed hole 6 mm deep drilled down into its top.
    // Near the mouth the rod's surface falls away from the wall: rays from just under the edge
    // leave through the face the hole was drilled into, which is not a wall around the hole.
    const rod: ExtrudeInput = {
      kind: 'extrude',
      id: 'extrude#1',
      profile: profile(
        { origin: [0, 0, 0], xDir: [0, 1, 0], normal: [1, 0, 0] },
        circle([0, 0], 10),
      ),
      extent: { type: 'blind', distance: 40 },
      mode: 'new',
    };
    const r = walls([rod, hole([{ id: 'p1', at: [20, 0] }], { frame: atZ(10) })]);
    expect(r).toHaveLength(1);
    // Along the rod the ends are 18 mm away, past the range; across it the rays leave through
    // the rod's own side, the face the hole opens into.
    expect(r[0]!.wall).toBeNull();
  });

  it('reads the true wall of a hole drilled into a 30 degree slope, not about 0', () => {
    // A wedge 40 long, 10 wide (y from 0 to -10), its top rising at 30 degrees from z = 10, and a
    // vertical 4 mm hole at x = 20 in the middle of its width: 3 mm to either side face.
    const t = Math.tan(Math.PI / 6);
    const wedge: ExtrudeInput = {
      kind: 'extrude',
      id: 'extrude#1',
      profile: profile(
        { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, -1, 0] },
        polygon(
          [
            [0, 0],
            [40, 0],
            [40, 10 + 40 * t],
            [0, 10],
          ],
          ['e1', 'e2', 'e3', 'e4'],
        ),
      ),
      extent: { type: 'blind', distance: 10 },
      mode: 'new',
    };
    const top = 10 + 20 * t;
    const r = walls([
      wedge,
      hole([{ id: 'p1', at: [20, -5] }], {
        frame: atZ(40),
        extent: { type: 'blind', depth: 40 - top + 6, tipAngle: Math.PI },
      }),
    ]);
    expect(r).toHaveLength(1);
    expect(r[0]!.wall).toBeCloseTo(3, 6);
    expect(['extrude#1:cap:start', 'extrude#1:cap:end']).toContain(r[0]!.toFace);
  });

  it('runs as an op through the service, and refuses a bad range', async () => {
    const service = await createNodeService();
    const reply = await service.run({
      generation: 1,
      ops: [
        {
          op: 'feature',
          bodies: [],
          feature: {
            kind: 'extrude',
            id: 'extrude#1',
            profile: profile(XY, rectangle(0, 0, 20, 20)),
            extent: { type: 'blind', distance: 5 },
            mode: 'new',
          },
          keep: false,
        },
        {
          op: 'feature',
          bodies: { result: 0 },
          feature: hole([{ id: 'p1', at: [10, 4] }], {
            frame: atZ(5),
            extent: { type: 'throughAll' },
          }),
          keep: false,
        },
        { op: 'holeWalls', shape: { result: 1 }, holes: ['hole#3'] },
        { op: 'holeWalls', shape: { result: 1 }, holes: ['hole#3'], range: -1 },
      ],
    });
    expect(reply.status).toBe('done');
    const walls = reply.results[2]!;
    expect(walls.ok).toBe(true);
    const value = (walls as { value: { walls: HoleWall[] } }).value.walls;
    expect(value.map((w) => [w.point, Math.round(w.wall! * 1e9) / 1e9])).toEqual([['p1', 2]]);
    expect(reply.results[3]).toMatchObject({ ok: false, error: { code: 'invalid-argument' } });
    expect(service.kernel.shapeCount).toBe(0);
  });
});
