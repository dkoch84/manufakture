// Golden tests for profiles shaped the way text outlines reach the kernel (T3.2c): loops that
// `outlineRegions` splits where a hole touches its outline (the pinched loop it gave before is
// refused), and a contour of one closed Bezier cut into two halves, each with glyph edge ids
// (`<entity>.g<glyph>.c<contour>.s<command>#<piece>`), whose faces are positional and so fragile.

import { beforeAll, describe, expect, it } from 'vitest';
import { applyFeature, type SketchProfile } from '../src/features';
import { XY } from '../src/fixtures/parts';
import type { Kernel } from '../src/kernel';
import { createNodeKernel } from '../src/node';
import type { ProfileEntity, Vec2 } from '../src/types';

let k: Kernel;

beforeAll(async () => {
  k = await createNodeKernel();
}, 60_000);

/** A closed polyline as line entities named `<prefix>.s<i>#1`. */
function lines(points: Vec2[], prefix: string): ProfileEntity[] {
  return points.map((start, i) => ({
    kind: 'line',
    id: `${prefix}.s${i}#1`,
    start,
    end: points[(i + 1) % points.length]!,
  }));
}

function extrude(profile: SketchProfile, distance: number) {
  return applyFeature(k, [], {
    kind: 'extrude',
    id: 'extrude#1',
    mode: 'new',
    profile,
    extent: { type: 'blind', distance },
  });
}

/** Splits a Bezier at `t` (de Casteljau). */
function split(points: Vec2[], t: number): [Vec2[], Vec2[]] {
  const left: Vec2[] = [];
  const right: Vec2[] = [];
  let level = points;
  while (level.length > 0) {
    left.push(level[0]!);
    right.unshift(level[level.length - 1]!);
    level = level
      .slice(0, -1)
      .map((p, i): Vec2 => [
        p[0] + (level[i + 1]![0] - p[0]) * t,
        p[1] + (level[i + 1]![1] - p[1]) * t,
      ]);
  }
  return [left, right];
}

describe('text-shaped profiles', () => {
  it('extrudes a region whose hole touches its outline at a point once it is split into simple loops', () => {
    // A 10 x 10 square with a diamond hole whose corner touches the bottom edge at (5, 0).
    // As one pinched loop (the way outlineRegions chained it before T3.2c) the wire is refused.
    const pinched = lines(
      [
        [0, 0],
        [5, 0],
        [3, 3],
        [5, 6],
        [7, 3],
        [5, 0],
        [10, 0],
        [10, 10],
        [0, 10],
      ],
      'e5.g0.c0',
    );
    const refused = extrude({ frame: XY, loops: [{ entities: pinched }] }, 2);
    expect(refused.errors.map((e) => e.code)).toEqual(['kernel']);
    expect(refused.bodies).toEqual([]);

    // Split at the touching point, as outlineRegions now gives it: the outer loop (its bottom
    // edge cut at (5, 0)) counter-clockwise, the hole clockwise.
    const outer = lines(
      [
        [0, 0],
        [5, 0],
        [10, 0],
        [10, 10],
        [0, 10],
      ],
      'e5.g0.c0',
    );
    const hole = lines(
      [
        [5, 0],
        [3, 3],
        [5, 6],
        [7, 3],
      ],
      'e5.g0.c1',
    );
    const out = extrude({ frame: XY, loops: [{ entities: outer }, { entities: hole }] }, 2);
    expect(out.errors).toEqual([]);
    const body = out.bodies[0]!;
    try {
      const props = k.properties(body.shape);
      expect(props.volume).toBeCloseTo((100 - 12) * 2, 9);
      // The solid is built, but it is non-manifold along the line where the hole touches the
      // outline, and BRepCheck says so: which is why outlineRegions warns `touching` (and
      // detectRegions likewise for sketch loops). Where it prints is up to the slicer.
      expect(props.valid).toBe(false);
      const faces = body.names!.faces;
      const side = faces.find((f) => f.name === 'extrude#1:side:e5.g0.c1.s0#1')!;
      expect(side.fragile).toBe(true);
      expect(side.lineage).toEqual(['extrude#1:side:e5.g0.c1.s0#1', 'extrude#1:side:e5.g0.c1.s0']);
      expect(faces.filter((f) => f.name.startsWith('extrude#1:side:'))).toHaveLength(9);
    } finally {
      k.release(body.shape);
    }
  });

  it('extrudes a contour of one closed Bezier, cut into two halves', () => {
    // A teardrop: the cubic from the origin back to it through (10, 10) and (-10, 10).
    const [a, b] = split(
      [
        [0, 0],
        [10, 10],
        [-10, 10],
        [0, 0],
      ],
      0.5,
    );
    const out = extrude(
      {
        frame: XY,
        loops: [
          {
            entities: [
              { kind: 'bezier', id: 'e5.g0.c0.s0#1', points: a },
              { kind: 'bezier', id: 'e5.g0.c0.s0#2', points: b },
            ],
          },
        ],
      },
      3,
    );
    expect(out.errors).toEqual([]);
    const body = out.bodies[0]!;
    try {
      const props = k.properties(body.shape);
      expect(props.valid).toBe(true);
      // A closed cubic from the origin encloses 3/20 (x1 y2 - x2 y1).
      expect(props.volume).toBeCloseTo((3 / 20) * (10 * 10 + 10 * 10) * 3, 6);
      expect(body.names!.faces.map((f) => f.name).sort()).toEqual([
        'extrude#1:cap:end',
        'extrude#1:cap:start',
        'extrude#1:side:e5.g0.c0.s0#1',
        'extrude#1:side:e5.g0.c0.s0#2',
      ]);
    } finally {
      k.release(body.shape);
    }
  });
});
