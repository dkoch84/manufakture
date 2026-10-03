import type { MemberData } from '@manufakture/regen';
import { describe, expect, it } from 'vitest';
import { houseFixture, onCentres, shedFixture } from './memberFixtures';
import { bodyLayer, layoutMembers } from './members';

/** A member's world box (uncut members are boxes; the fixtures place them axis-aligned or not). */
function box(m: MemberData): { min: number[]; max: number[] } {
  const { origin, x, y } = m.placement;
  const z = [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]];
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let c = 0; c < 8; c++) {
    const a = c & 1 ? m.length : 0;
    const b = c & 2 ? m.stock.width : 0;
    const d = c & 4 ? m.stock.depth : 0;
    for (let k = 0; k < 3; k++) {
      const v = origin[k]! + a * x[k]! + b * y[k]! + d * z[k]!;
      min[k] = Math.min(min[k]!, v);
      max[k] = Math.max(max[k]!, v);
    }
  }
  return { min, max };
}

/** Pairs of axis-aligned members whose boxes overlap by more than a hair (they would z-fight). */
function overlaps(members: readonly MemberData[]): string[] {
  const aligned = members.filter((m) =>
    [m.placement.x, m.placement.y].every((v) => v.filter((c) => Math.abs(c) > 1e-9).length === 1),
  );
  const boxes = aligned.map(box);
  const out: string[] = [];
  for (let i = 0; i < aligned.length; i++) {
    for (let j = i + 1; j < aligned.length; j++) {
      const a = boxes[i]!;
      const b = boxes[j]!;
      const inside = [0, 1, 2].every(
        (k) => Math.min(a.max[k]!, b.max[k]!) - Math.max(a.min[k]!, b.min[k]!) > 0.01,
      );
      if (inside)
        out.push(`${aligned[i]!.owner}:${aligned[i]!.id} ${aligned[j]!.owner}:${aligned[j]!.id}`);
    }
  }
  return out;
}

describe('framing fixtures', () => {
  it('lays out members on 16" centres without overlapping the end one', () => {
    expect(onCentres(16 * 12 * 25.4, 38.1).map((a) => +(a / 25.4).toFixed(3))).toEqual([
      0, 16, 32, 48, 64, 80, 96, 112, 128, 144, 160, 176, 190.5,
    ]);
    expect(onCentres(10, 38.1)).toEqual([]);
  });

  it('frames the shed: four walls, a door, a window, sheathing as layer bodies', () => {
    const shed = shedFixture();
    const members = shed.view.sets.flatMap((s) => s.members);
    expect(shed.view.sets.map((s) => s.group)).toEqual(['wall-s', 'wall-e', 'wall-n', 'wall-w']);
    const roles = new Map<string, number>();
    for (const m of members) roles.set(m.role, (roles.get(m.role) ?? 0) + 1);
    expect(Object.fromEntries(roles)).toMatchObject({
      'top-plate': 8,
      'bottom-plate': 5,
      king: 4,
      jack: 4,
      header: 4,
      'rough-sill': 1,
    });
    expect(roles.get('stud')).toBeGreaterThan(30);
    expect(roles.get('cripple')).toBeGreaterThan(2);
    // Full ids are unique, and an opening's members belong to the opening.
    const ids = members.map((m) => `${m.owner}:${m.id}`);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('door-1:king-l');
    expect(ids).toContain('window-1:sill');
    expect(overlaps(members)).toEqual([]);
    // Every shape has a mesh; studs share one.
    const layout = layoutMembers(shed.view);
    expect(layout.missing).toEqual([]);
    expect(layout.slots).toHaveLength(members.length);
    expect(layout.batches.length).toBeLessThan(members.length / 2);
    expect(shed.bodies.map((b) => bodyLayer(b.id))).toEqual([
      'sheathing',
      'sheathing',
      'sheathing',
      'sheathing',
    ]);
  });

  it('frames a two-storey house in the hundreds of members and few shapes', () => {
    const house = houseFixture();
    const members = house.view.sets.flatMap((s) => s.members);
    expect(members.length).toBeGreaterThan(500);
    expect(house.view.meshes.size).toBeLessThan(120);
    expect(house.levels).toHaveLength(2);
    const ids = members.map((m) => `${m.owner}:${m.id}`);
    expect(new Set(ids).size).toBe(ids.length);
    expect(overlaps(members)).toEqual([]);
  });
});
