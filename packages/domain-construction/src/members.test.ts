import { MAX_GROUP_MEMBERS } from '@manufakture/regen';
import { describe, expect, it } from 'vitest';
import { placementMatrix, toLocal, toWorld, type Placement } from './geom';
import { MEMBER_BUDGET, countByRole, memberCorners, shapeKey, type Member } from './members';
import { S2X4, S2X6 } from './test-helpers';

const P: Placement = { origin: [10, 20, 30], x: [0, 0, 1], y: [1, 0, 0] };
const stud = (over: Partial<Member> = {}): Member => ({
  id: 's1',
  owner: 'extension#3',
  role: 'stud',
  stock: S2X4,
  length: 2352.675,
  placement: P,
  cuts: [],
  ...over,
});

describe('member data', () => {
  it('budgets as many members per generator call as regen accepts in a group', () => {
    expect(MEMBER_BUDGET).toBe(MAX_GROUP_MEMBERS);
  });

  it('shares a shape between members that differ only in placement', () => {
    const a = stud();
    const b = stud({ id: 's2', placement: { ...P, origin: [500, 0, 0] } });
    expect(shapeKey(a)).toBe(shapeKey(b));
    expect(shapeKey(stud({ length: 2352.6751 }))).toBe(shapeKey(a));
    expect(shapeKey(stud({ length: 2353 }))).not.toBe(shapeKey(a));
    expect(shapeKey(stud({ stock: S2X6 }))).not.toBe(shapeKey(a));
    const cut = { kind: 'plane', n: [1, 0, 0], k: 2000 } as const;
    expect(shapeKey(stud({ cuts: [cut] }))).not.toBe(shapeKey(a));
  });

  it('maps local and world coordinates through the placement', () => {
    // x up, y along world x, so z = x cross y is world y.
    expect(toWorld(P, [1, 2, 3])).toEqual([12, 23, 31]);
    expect(toLocal(P, [12, 23, 31])).toEqual([1, 2, 3]);
    expect(placementMatrix(P)).toEqual([0, 0, 1, 0, 1, 0, 0, 0, 0, 1, 0, 0, 10, 20, 30, 1]);
    const corners = memberCorners(stud());
    expect(corners).toHaveLength(8);
    expect(corners).toContainEqual([10 + S2X4.width, 20 + S2X4.depth, 30 + 2352.675]);
  });

  it('counts members by role', () => {
    expect(countByRole([stud(), stud({ role: 'king' }), stud()])).toEqual({ king: 1, stud: 2 });
  });
});
