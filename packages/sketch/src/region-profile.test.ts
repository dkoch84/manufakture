import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { SketchEntity } from './model';
import { XY_PLANE, placementFromNormal, type SketchPlacement } from './placement';
import { regionProfile, type RegionProfile } from './region-profile';
import { SKETCHES, circle, rect } from './region-sketches';
import { detectRegions, type Region } from './regions';

function only(entities: SketchEntity[], id?: string): Region {
  const r = detectRegions(entities);
  const all = [...r.regions, ...r.voids];
  const found = id === undefined ? all : all.filter((x) => x.id === id);
  expect(found, `${id} in ${all.map((x) => x.id).join(', ')}`).toHaveLength(1);
  return found[0]!;
}

describe('regionProfile', () => {
  it('gives the kernel loops (outer first) with edge ids, and the placement as frame', () => {
    const placement = placementFromNormal([1, 2, 3], [0, 1, 1], [1, 0, 0]);
    const p = regionProfile(only(SKETCHES.rectWithHole(), 'l1/L+l2/L+l3/L+l4/L'), placement);
    expect(p.frame).toEqual({
      origin: placement.origin,
      xDir: placement.xDir,
      normal: placement.normal,
    });
    expect(p.loops.map((l) => l.entities.map((e) => [e.kind, e.id]))).toEqual([
      [
        ['line', 'l1'],
        ['line', 'l2'],
        ['line', 'l3'],
        ['line', 'l4'],
      ],
      [['circle', 'c1']],
    ]);
    expect(p.loops[1]!.entities[0]).toEqual({
      kind: 'circle',
      id: 'c1',
      center: [20, 15],
      radius: 5,
    });
    expect(p.edges).toEqual({
      l1: { entityId: 'l1', fragile: false },
      l2: { entityId: 'l2', fragile: false },
      l3: { entityId: 'l3', fragile: false },
      l4: { entityId: 'l4', fragile: false },
      c1: { entityId: 'c1', fragile: false },
    });
  });

  it('turns arcs traversed against the entity clockwise, and marks split pieces fragile', () => {
    // A circle biting into the rectangle's right side.
    const region = only(
      [...rect('l', 0, 0, 10, 10), circle('c1', [10, 5], 3)],
      'c1/R+l1/L+l2/L+l3/L+l4/L',
    );
    const p = regionProfile(region, XY_PLANE);
    const arc = p.loops[0]!.entities.find((e) => e.kind === 'arc')!;
    expect(arc).toMatchObject({ kind: 'arc', clockwise: true, center: [10, 5] });
    expect(Object.keys(p.edges).sort()).toEqual(['c1#1', 'l1', 'l2#1', 'l2#3', 'l3', 'l4']);
    expect(p.edges['l2#1']).toEqual({ entityId: 'l2', fragile: true });
    expect(region.area).toBeCloseTo(100 - Math.PI * 4.5, 9);
  });
});

// The kernel's end-to-end test (packages/kernel/src/regions.test.ts) builds
// these profiles in OCCT. The kernel must not depend on this package, so the
// profiles travel as a checked-in fixture, and this test keeps it in step:
// run with UPDATE_REGION_FIXTURES=1 to rewrite it, then format it with
// Prettier (the comparison ignores formatting; `make lint` does not).

const FIXTURE = new URL('../../kernel/src/fixtures/region-profiles.json', import.meta.url);

interface FixtureCase {
  name: string;
  regionId: string;
  area: number;
  profile: RegionProfile;
}

const tilted: SketchPlacement = placementFromNormal([10, -5, 3], [1, 2, 2], [0, 1, -1]);

function fixtureCases(): FixtureCase[] {
  const cases: [string, SketchEntity[], string, SketchPlacement][] = [
    ['rectangle with a hole', SKETCHES.rectWithHole(), 'l1/L+l2/L+l3/L+l4/L', XY_PLANE],
    ['overlap of two rectangles', SKETCHES.overlappingRects(), 'a2/L+a3/L+b1/L+b4/L', XY_PLANE],
    [
      'rectangle less an overlap',
      SKETCHES.overlappingRects(),
      'a1/L+a2/L+a3/L+a4/L+b1/R+b4/R',
      XY_PLANE,
    ],
    ['slot on a tilted plane', SKETCHES.slot(), 's1/L+s2/L+s3/L+s4/L', tilted],
    ['circle cap above a line', SKETCHES.circleAndLine(), 'c1/L+l1/L', XY_PLANE],
    ['annulus around an island', SKETCHES.island(), 'c1/L', XY_PLANE],
    ['half of a T-junction', SKETCHES.tJunction(), 'l1/L+l3/L+l4/L+m/L', XY_PLANE],
    [
      'rectangle bitten by a circle',
      [...rect('l', 0, 0, 10, 10), circle('c1', [10, 5], 3)],
      'c1/R+l1/L+l2/L+l3/L+l4/L',
      XY_PLANE,
    ],
  ];
  const round = (v: unknown): unknown =>
    typeof v === 'number'
      ? Math.round(v * 1e12) / 1e12 + 0
      : Array.isArray(v)
        ? v.map(round)
        : v !== null && typeof v === 'object'
          ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, round(x)]))
          : v;
  return cases.map(([name, entities, regionId, placement]) => {
    const region = only(entities, regionId);
    return round({
      name,
      regionId,
      area: region.area,
      profile: regionProfile(region, placement),
    }) as FixtureCase;
  });
}

describe('kernel fixture', () => {
  it('matches what regionProfile produces now', () => {
    const text = `${JSON.stringify(fixtureCases(), null, 2)}\n`;
    if (process.env.UPDATE_REGION_FIXTURES === '1') writeFileSync(FIXTURE, text);
    expect(existsSync(FIXTURE), 'missing fixture: run with UPDATE_REGION_FIXTURES=1').toBe(true);
    expect(JSON.parse(readFileSync(FIXTURE, 'utf8'))).toEqual(JSON.parse(text));
  });
});
