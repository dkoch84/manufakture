// End to end: sketch regions as OCCT faces and extrusions. The profiles come
// from `regionProfile` in packages/sketch, as a checked-in fixture
// (fixtures/region-profiles.json) so this package does not depend on the
// sketch package; packages/sketch/src/region-profile.test.ts keeps the fixture
// in step with the code that makes it.

import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { applyFeature, validateFeature } from './features';
import type { Kernel } from './kernel';
import { sweepRegionOrder } from './naming';
import { createNodeKernel } from './node';
import type { Frame, ProfileEntity, ProfileLoop, ShapeId, Vec2, Vec3 } from './types';

interface FixtureCase {
  name: string;
  regionId: string;
  area: number;
  profile: {
    frame: Frame;
    loops: ProfileLoop[];
    edges: Record<string, { entityId: string; fragile: boolean }>;
  };
}

const cases = JSON.parse(
  readFileSync(new URL('./fixtures/region-profiles.json', import.meta.url), 'utf8'),
) as FixtureCase[];

let k: Kernel;

beforeAll(async () => {
  k = await createNodeKernel();
}, 60_000);

const HEIGHT = 5;

describe('sketch regions in the kernel', () => {
  it('has the fixture cases', () => {
    expect(cases.length).toBeGreaterThanOrEqual(8);
  });

  it.each(cases.map((c) => [c.name, c] as const))(
    '%s: profile, extrude, name the sides',
    (_, c) => {
      const made: ShapeId[] = [];
      try {
        const { frame, loops, edges } = c.profile;
        const profile = k.profile(frame, loops);
        made.push(profile);
        // The face is the region.
        const face = k.properties(profile);
        expect(face.valid).toBe(true);
        expect(face.area).toBeCloseTo(c.area, 6);

        const r = k.extrude(profile, HEIGHT);
        made.push(r.shape);
        const solid = k.properties(r.shape);
        expect(solid.valid).toBe(true);
        expect(solid.volume / (c.area * HEIGHT)).toBeCloseTo(1, 8);

        // Every edge id names exactly one side face, distinct from the caps.
        expect(Object.keys(r.sideIds).sort()).toEqual(Object.keys(edges).sort());
        const faces = Object.values(r.sideIds);
        expect(new Set([...faces, r.capStart, r.capEnd]).size).toBe(faces.length + 2);

        // Each side face has the shape of its sketch edge: planar for lines,
        // cylindrical with the curve's radius for arcs and circles.
        const topology = k.topology(r.shape);
        const n = frame.normal;
        for (const loop of loops) {
          for (const e of loop.entities) {
            const info = topology.faces[r.sideIds[e.id!]! - 1]!;
            if (e.kind === 'line') {
              expect(info.surface, e.id).toBe('plane');
              // Perpendicular to the sketch plane.
              expect(Math.abs(dot(info.normal!, n)), e.id).toBeLessThan(1e-9);
            } else {
              if (e.kind === 'bezier') throw new Error('the fixture has no Beziers');
              const radius =
                e.kind === 'circle'
                  ? e.radius
                  : Math.hypot(e.start[0] - e.center[0], e.start[1] - e.center[1]);
              expect(info.surface, e.id).toBe('cylinder');
              expect(info.radius!, e.id).toBeCloseTo(radius, 6);
            }
          }
        }
      } finally {
        for (const id of made) k.release(id);
      }
    },
  );
});

const XY: Frame = { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] };

/** The area of a profile made from `loops`, released again. */
function profileArea(loops: ProfileEntity[][]): number {
  const id = k.profile(
    XY,
    loops.map((entities) => ({ entities })),
  );
  try {
    const p = k.properties(id);
    expect(p.valid).toBe(true);
    return p.area;
  } finally {
    k.release(id);
  }
}

const square = (x0: number, y0: number, x1: number, y1: number): ProfileEntity[] => {
  const pts: Vec2[] = [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
  return pts.map((start, i) => ({ kind: 'line', start, end: pts[(i + 1) % 4]! }));
};

describe('Bezier profile entities', () => {
  it('a quadratic closed by a line bounds the parabolic segment', () => {
    const area = profileArea([
      [
        {
          kind: 'bezier',
          points: [
            [0, 0],
            [5, 10],
            [10, 0],
          ],
        },
        { kind: 'line', start: [10, 0], end: [0, 0] },
      ],
    ]);
    expect(area).toBeCloseTo(100 / 3, 9);
  });

  it('a single cubic that ends where it starts is a loop on its own', () => {
    const points: Vec2[] = [
      [0, 0],
      [12, 8],
      [-12, 8],
      [0, 0],
    ];
    const area = profileArea([[{ kind: 'bezier', points }]]);
    // x(t) = 36 t (1-t)(1-2t), y(t) = 24 t (1-t): the area is the integral of
    // x dy = 864 * integral of t (1-t)(1-2t)^2 dt = 864 / 30 (with u = 2t - 1,
    // the integral is 1/8 * integral of u^2 - u^4 over [-1, 1]).
    expect(area).toBeCloseTo(28.8, 9);
  });

  it('closes a gap inside the tolerance onto the next entity', () => {
    // At size 100 the closure tolerance is 1e-5, but an edge between two vertices needs about
    // 1e-7: the Bezier's last pole is moved onto the line's start.
    const gap = 5e-6;
    const area = profileArea([
      [
        {
          kind: 'bezier',
          points: [
            [0, 0],
            [50, 100],
            [100, 0],
          ],
        },
        { kind: 'line', start: [100 + gap, 0], end: [0, 0] },
      ],
    ]);
    expect(area / ((2 / 3) * 100 * 50)).toBeCloseTo(1, 6);
  });

  it('a single cubic that closes within the tolerance makes a valid face', () => {
    const points: Vec2[] = [
      [0, 0],
      [12, 8],
      [-12, 8],
      [5e-7, 0],
    ];
    expect(profileArea([[{ kind: 'bezier', points }]])).toBeCloseTo(28.8, 5);
  });

  it('a Bezier hole is oriented by the kernel, whatever its direction', () => {
    const hole: ProfileEntity[] = [
      {
        kind: 'bezier',
        points: [
          [2, 2],
          [5, 8],
          [8, 2],
        ],
      },
      { kind: 'line', start: [8, 2], end: [2, 2] },
    ];
    expect(profileArea([square(0, 0, 10, 10), hole])).toBeCloseTo(100 - 6 * 3 * (2 / 3), 9);
  });

  it('refuses malformed Beziers', () => {
    const loop = (points: Vec2[]): ProfileEntity[][] => [
      [
        { kind: 'bezier', points },
        { kind: 'line', start: points[points.length - 1] ?? [0, 0], end: points[0] ?? [0, 0] },
      ],
    ];
    expect(() => profileArea(loop([[0, 0]]))).toThrow(/2 to 4 control points/);
    expect(() =>
      profileArea(
        loop([
          [0, 0],
          [1, 1],
          [2, 1],
          [3, 1],
          [4, 0],
        ]),
      ),
    ).toThrow(/2 to 4 control points/);
    expect(() =>
      profileArea([
        [
          {
            kind: 'bezier',
            points: [
              [0, 0],
              [5, 5],
              [10, 0],
            ],
          },
        ],
      ]),
    ).toThrow(/a single bezier cannot close a loop/);
    // A closed quadratic goes out to its control point and back: no area.
    expect(() =>
      profileArea([
        [
          {
            kind: 'bezier',
            points: [
              [0, 0],
              [5, 5],
              [0, 0],
            ],
          },
        ],
      ]),
    ).toThrow(/a single bezier cannot close a loop/);
    expect(() =>
      profileArea([
        [
          {
            kind: 'bezier',
            points: [
              [0, 0],
              [5, 5],
              [10, 0],
            ],
          },
          { kind: 'line', start: [10, 1], end: [0, 0] },
        ],
      ]),
    ).toThrow(/does not end where/);
  });
});

describe('several regions', () => {
  it('orders regions by their outer loop edge ids, then all ids, then input order', () => {
    expect(sweepRegionOrder([[['e5', 'e6']], [['e2', 'e9']], [['e2', 'e1']]])).toEqual([2, 1, 0]);
    // Same outer loop: the holes decide, then the input order.
    expect(
      sweepRegionOrder([
        [['a'], ['h2']],
        [['a'], ['h1']],
        [['a'], ['h1']],
      ]),
    ).toEqual([1, 2, 0]);
    // A shorter list that is a prefix of a longer one sorts first.
    expect(sweepRegionOrder([[['a', 'b']], [['a']]])).toEqual([1, 0]);
  });

  it('names the region a bad loop is in', () => {
    const good = {
      loops: [
        { entities: [{ kind: 'circle' as const, id: 'c1', center: [0, 0] as Vec2, radius: 1 }] },
      ],
    };
    const bad = {
      loops: [
        {
          entities: square(5, 0, 7, 2).map((e, i): ProfileEntity => ({
            ...e,
            id: `e${i + 1}`,
            ...(i === 3 && e.kind === 'line' ? { end: [5, 1] as Vec2 } : {}),
          })),
        },
      ],
    };
    const out = applyFeature(k, [], {
      kind: 'extrude',
      id: 'extrude#1',
      mode: 'new',
      profile: { frame: XY, regions: [good, bad] },
      extent: { type: 'blind', distance: 1 },
    });
    expect(out.errors).toMatchObject([
      { code: 'invalid', message: expect.stringMatching(/^profile: region 1: loop 0: entity 3 /) },
    ]);
  });

  it('validates profiles of several regions', () => {
    const base = {
      kind: 'extrude',
      id: 'extrude#1',
      mode: 'new',
      extent: { type: 'blind', distance: 1 },
    };
    const loops = [{ entities: [{ kind: 'circle', id: 'c1', center: [0, 0], radius: 1 }] }];
    expect(validateFeature({ ...base, profile: { frame: XY, regions: [{ loops }] } })).toBeNull();
    expect(
      validateFeature({ ...base, profile: { frame: XY, loops, regions: [{ loops }] } }),
    ).toMatch(/both loops and regions/);
    expect(validateFeature({ ...base, profile: { frame: XY, regions: [] } })).toMatch(
      /profile.regions must be a non-empty array/,
    );
    expect(
      validateFeature({
        ...base,
        profile: { frame: XY, regions: [{ loops: [{ entities: [{}] }] }] },
      }),
    ).toMatch(/profile.regions\[0\].loops\[0\].entities\[0\]/);
  });
});

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
