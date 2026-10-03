// Checks that the measurements rest on: realistic member counts, three meshers that agree on
// every member's volume, mesh sharing, and Manifold objects all deleted.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createNodeService } from '@manufakture/kernel/node';
import type { ShapeProperties } from '@manufakture/kernel';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildGroup } from './brep.ts';
import { clipMesh, meshVolume } from './clip.ts';
import { allMembers, fixture, type Fixture } from './fixtures.ts';
import { loadManifold, manifoldMesh, type ManifoldHandle } from './manifold.ts';
import { MemberSet, mesherFor } from './member-set.ts';
import { countByRole, shapeKey, type Member } from './members.ts';

const require = createRequire(import.meta.url);
let shed: Fixture;
let house: Fixture;
let h: ManifoldHandle;

beforeAll(async () => {
  shed = fixture('shed');
  house = fixture('house');
  h = await loadManifold(
    readFileSync(require.resolve('manifold-3d/manifold.wasm')),
    readFileSync(require.resolve('manifold-3d/manifold.js'), 'utf8'),
  );
});

const cutShapes = (ms: readonly Member[]) => {
  const by = new Map<string, Member>();
  for (const m of ms) if (m.cuts.length > 0 && !by.has(shapeKey(m))) by.set(shapeKey(m), m);
  return [...by.values()];
};

describe('fixtures', () => {
  it('have member counts in the range of the plan’s estimates', () => {
    // M6 plan, Part 1: a shed "on the order of 150", a 2,000 sq ft house "800 to 1,000".
    expect(allMembers(shed).length).toBeGreaterThan(120);
    expect(allMembers(shed).length).toBeLessThan(180);
    expect(allMembers(house).length).toBeGreaterThanOrEqual(800);
    expect(allMembers(house).length).toBeLessThanOrEqual(1000);
  });

  it('frame every opening with kings, jacks and a header', () => {
    const roles = countByRole(allMembers(house));
    expect(roles.king).toBe(20); // ten openings, two each
    expect(roles.jack).toBe(20);
    expect(roles['hip-rafter']).toBe(4);
    const ids = house.groups.get('wall-s')!.map((m) => m.id);
    expect(ids).toContain('opening#2:king-l');
    expect(ids).toContain('opening#2:header-1');
  });

  it('cut members are rafters, gable studs, ties and ceiling joists only', () => {
    const roles = new Set(
      [...allMembers(shed), ...allMembers(house)].filter((m) => m.cuts.length).map((m) => m.role),
    );
    expect([...roles].sort()).toEqual(
      [
        'ceiling-joist',
        'common-rafter',
        'gable-stud',
        'hip-rafter',
        'jack-rafter',
        'rafter-tie',
      ].sort(),
    );
  });

  it('identical members share one mesh; moving an opening changes only its wall', () => {
    const studs = shed.groups.get('wall-s')!.filter((m) => m.role === 'stud');
    expect(new Set(studs.map(shapeKey)).size).toBe(1);
    const before = house.groups.get('wall-s')!.map((m) => `${m.id} ${shapeKey(m)}`);
    const moved = house.regenDirty().map((m) => `${m.id} ${shapeKey(m)}`);
    expect(moved).not.toEqual(before);
    // The opening's kings, jacks and header keep their ids (its cripples follow the layout).
    const own = (xs: string[]) =>
      xs.map((x) => x.split(' ')[0]!).filter((x) => /^opening#2:(king|jack|header)/.test(x));
    expect(own(moved)).toEqual(own(before));
  });
});

describe('meshers', () => {
  it('own clip: a box is 12 triangles with its exact volume', () => {
    const m = allMembers(shed).find((x) => x.role === 'stud')!;
    const mesh = clipMesh(m);
    expect(mesh.indices.length / 3).toBe(12);
    const exact = m.length * m.stock.width * m.stock.depth;
    expect(Math.abs(meshVolume(mesh) - exact) / exact).toBeLessThan(1e-7);
  });

  it('own clip and Manifold agree on the volume of every cut shape', () => {
    for (const m of cutShapes([...allMembers(shed), ...allMembers(house)])) {
      const a = meshVolume(clipMesh(m));
      const b = meshVolume(manifoldMesh(h, m));
      expect(Math.abs(a - b) / a).toBeLessThan(1e-6);
      expect(a).toBeLessThan(m.length * m.stock.width * m.stock.depth);
    }
  });

  it('Manifold: every object made is deleted', () => {
    const count = { created: 0, deleted: 0 };
    for (const m of cutShapes(allMembers(house))) manifoldMesh(h, m, count);
    expect(count.created).toBeGreaterThan(0);
    expect(count.deleted).toBe(count.created);
  });

  it('the kernel’s B-rep of every cut shape has the meshers’ volume', async () => {
    const service = await createNodeService({ autoRecycle: false });
    const shapes = cutShapes([...allMembers(shed), ...allMembers(house)]);
    const built = await buildGroup(service, shapes, { mesh: false });
    expect(built.errors).toEqual([]);
    expect(built.shapes.length).toBe(shapes.length);
    const reply = await service.run({
      generation: 1,
      ops: built.shapes.map((shape) => ({ op: 'properties' as const, shape })),
    });
    reply.results.forEach((r, i) => {
      expect(r.ok).toBe(true);
      const v = (r as { value: ShapeProperties }).value.volume;
      const expected = meshVolume(clipMesh(shapes[i]!));
      expect(Math.abs(v - expected) / expected).toBeLessThan(1e-6);
    });
  });
});

describe('member set', () => {
  it('a warm regen meshes nothing new when the moved wall has no new shapes', () => {
    const set = new MemberSet(mesherFor(clipMesh));
    for (const [g, ms] of house.groups) set.setGroup(g, ms);
    const meshed = set.meshed;
    set.setGroup(house.dirty.wall, house.regenDirty());
    expect(set.meshed - meshed).toBe(0);
    const ids = set.instances().flatMap((l) => l.ids);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('generator', () => {
  it('no two uncut members overlap', () => {
    for (const f of [shed, house]) {
      const boxes = allMembers(f)
        .filter((m) => m.cuts.length === 0)
        .map((m) => {
          const mesh = clipMesh(m);
          const lo = [Infinity, Infinity, Infinity];
          const hi = [-Infinity, -Infinity, -Infinity];
          const p = m.placement;
          const z = [
            p.x[1] * p.y[2] - p.x[2] * p.y[1],
            p.x[2] * p.y[0] - p.x[0] * p.y[2],
            p.x[0] * p.y[1] - p.x[1] * p.y[0],
          ];
          for (let i = 0; i < mesh.positions.length; i += 3) {
            const l = [mesh.positions[i]!, mesh.positions[i + 1]!, mesh.positions[i + 2]!];
            for (let a = 0; a < 3; a++) {
              const w = p.origin[a]! + l[0]! * p.x[a]! + l[1]! * p.y[a]! + l[2]! * z[a]!;
              lo[a] = Math.min(lo[a]!, w);
              hi[a] = Math.max(hi[a]!, w);
            }
          }
          return { id: `${m.group}:${m.id}`, lo, hi };
        });
      const overlaps: string[] = [];
      for (let i = 0; i < boxes.length; i++)
        for (let j = i + 1; j < boxes.length; j++) {
          const a = boxes[i]!;
          const b = boxes[j]!;
          if (
            [0, 1, 2].every(
              (k) => Math.min(a.hi[k]!, b.hi[k]!) - Math.max(a.lo[k]!, b.lo[k]!) > 0.5,
            )
          )
            overlaps.push(`${a.id} / ${b.id}`);
        }
      expect(overlaps).toEqual([]);
    }
  });
});
