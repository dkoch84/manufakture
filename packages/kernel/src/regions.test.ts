// End to end: sketch regions as OCCT faces and extrusions. The profiles come
// from `regionProfile` in packages/sketch, as a checked-in fixture
// (fixtures/region-profiles.json) so this package does not depend on the
// sketch package; packages/sketch/src/region-profile.test.ts keeps the fixture
// in step with the code that makes it.

import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Kernel } from './kernel';
import { createNodeKernel } from './node';
import type { Frame, ProfileLoop, ShapeId, Vec3 } from './types';

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

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
