import {
  boxMesh,
  memberInstances,
  type MemberData,
  type MemberSetResult,
} from '@manufakture/regen';
import { describe, expect, it } from 'vitest';
import { prepareBodies } from './bodies';
import { decodePickId, decodePickTarget, encodePickId } from './picking';
import {
  MAX_PICKABLE_MEMBERS,
  MEMBER_KIND,
  MEMBER_PICK_BASE,
  PLAN_CUT_HEIGHT,
  applyMeshUpdate,
  applySetResults,
  batchBounds,
  bodyLayer,
  describeCut,
  findMember,
  isMemberRef,
  layoutMembers,
  levelCutPlanes,
  levelCutRange,
  memberColor,
  memberEdgesVisible,
  memberPickId,
  memberRef,
  memberSlotOf,
  roleLabel,
  sameBatch,
  type MemberSetView,
  type MemberView,
} from './members';
import { boxBody } from './testMeshes';

const stock = { id: 'us-2x4', name: '2x4', width: 38.1, depth: 88.9 };

function stud(owner: string, id: string, x: number, length = 2352.675): MemberData {
  return {
    id,
    owner,
    role: 'stud',
    stock,
    length,
    placement: { origin: [x, 0, 38.1], x: [0, 0, 1], y: [1, 0, 0] },
    cuts: [],
  };
}

function setOf(group: string, members: MemberData[]): MemberSetView {
  return {
    group,
    namespace: 'construction',
    features: [group],
    members,
    instances: memberInstances(members),
  };
}

function viewOf(sets: MemberSetView[]): MemberView {
  const meshes = new Map(
    sets.flatMap((s) =>
      s.instances.map((l) => {
        const m = s.members.find((x) => `${x.owner}:${x.id}` === l.ids[0])!;
        return [l.shape, boxMesh(m.length, m.stock.width, m.stock.depth)] as const;
      }),
    ),
  );
  return { meshes, sets };
}

describe('member refs', () => {
  it('names a member by its full id, with the owner feature in front', () => {
    const ref = memberRef('opening#2:king-l');
    expect(ref).toEqual({ kind: MEMBER_KIND, id: 'opening#2:king-l', owner: 'opening#2' });
    expect(memberRef('extension#3:top1:2').owner).toBe('extension#3');
    expect(isMemberRef(ref)).toBe(true);
    expect(isMemberRef({ kind: 'face', id: 'x' })).toBe(false);
    expect(isMemberRef(null)).toBe(false);
  });
});

describe('member pick ids', () => {
  it('use a range of their own below 2^23, apart from body ids', () => {
    expect(memberPickId(0)).toBe(MEMBER_PICK_BASE);
    expect(memberSlotOf(memberPickId(41))).toBe(41);
    expect(memberSlotOf(MEMBER_PICK_BASE - 1)).toBeNull();
    expect(memberSlotOf(0)).toBeNull();
    // Past the range a member draws as the background.
    expect(memberPickId(MAX_PICKABLE_MEMBERS)).toBe(0);
    expect(memberPickId(-1)).toBe(0);
    // Every member id survives the RGB round trip.
    const top = memberPickId(MAX_PICKABLE_MEMBERS - 1);
    expect(decodePickId(...encodePickId(top))).toBe(top);
    // Below 2^23, so the pick shader's floor(id + 0.5) is exact in float32.
    expect(top).toBe(0x7fffff);
    expect(Math.fround(top + 0.5)).toBe(top + 0.5);
    expect(Math.fround(0x800001 + 0.5)).not.toBe(0x800001 + 0.5);
  });

  it('never decode as a body face, edge or vertex', () => {
    const bodies = prepareBodies([boxBody({ id: 'a' }), boxBody({ id: 'b' })]);
    const last = bodies[1]!.pickBase + bodies[1]!.pickCount - 1;
    expect(last).toBeLessThan(MEMBER_PICK_BASE);
    expect(decodePickTarget(bodies, memberPickId(0))).toBeNull();
    expect(decodePickTarget(bodies, memberPickId(3))).toBeNull();
    expect(memberSlotOf(last)).toBeNull();
  });
});

describe('member data updates', () => {
  it('adds and removes shape meshes, keeping the map when nothing changed', () => {
    const before = new Map([['a', boxMesh(1, 1, 1)]]);
    expect(applyMeshUpdate(before, undefined)).toBe(before);
    expect(applyMeshUpdate(before, { added: [], removed: [] })).toBe(before);
    const mesh = boxMesh(2, 1, 1);
    const after = applyMeshUpdate(before, { added: [{ key: 'b', ...mesh }], removed: ['a'] });
    expect([...after.keys()]).toEqual(['b']);
    expect(after.get('b')!.positions).toBe(mesh.positions);
    expect([...before.keys()]).toEqual(['a']);
  });

  it('keeps unchanged sets by group, takes changed ones, drops missing ones', () => {
    const wall1 = setOf('wall#1', [stud('wall#1', 's1', 0)]);
    const wall2 = setOf('wall#2', [stud('wall#2', 's1', 1000)]);
    const result = (set: MemberSetView, changed: boolean): MemberSetResult => ({
      group: set.group,
      namespace: set.namespace,
      features: [...set.features],
      setKey: `k-${set.group}`,
      cached: !changed,
      changed,
      members: changed ? [...set.members] : null,
      instances: changed ? [...set.instances] : null,
      count: set.members.length,
      ms: 0,
    });
    const first = applySetResults([], [result(wall1, true), result(wall2, true)]);
    expect(first.map((s) => s.group)).toEqual(['wall#1', 'wall#2']);
    // Nothing changed: the same array, so nothing downstream is rebuilt.
    expect(applySetResults(first, [result(wall1, false), result(wall2, false)])).toBe(first);
    // One wall changed: the other set is the same object.
    const moved = setOf('wall#2', [stud('wall#2', 's1', 1200)]);
    const second = applySetResults(first, [result(wall1, false), result(moved, true)]);
    expect(second[0]).toBe(first[0]);
    expect(second[1]).not.toBe(first[1]);
    expect(second[1]!.members[0]!.placement.origin[0]).toBe(1200);
    // A group missing from the result is gone; no result at all clears the part.
    expect(applySetResults(second, [result(wall1, false)]).map((s) => s.group)).toEqual(['wall#1']);
    expect(applySetResults(second, undefined)).toEqual([]);
    // An unchanged set the viewport never had cannot be drawn.
    expect(applySetResults([], [result(wall1, false)])).toEqual([]);
  });

  it('finds a member and its set by full id', () => {
    const view = viewOf([
      setOf('wall#1', [stud('wall#1', 's1', 0), stud('opening#2', 'king-l', 500)]),
    ]);
    expect(findMember(view, 'opening#2:king-l')?.member.id).toBe('king-l');
    expect(findMember(view, 'opening#2:king-l')?.set.group).toBe('wall#1');
    expect(findMember(view, 'wall#1:s9')).toBeNull();
  });
});

describe('instance bookkeeping', () => {
  it('batches instances per shape across sets, with consecutive pick slots', () => {
    const a = setOf('wall#1', [
      stud('wall#1', 's1', 0),
      stud('wall#1', 's2', 406.4),
      stud('opening#2', 'cripple1', 812.8, 600),
    ]);
    const b = setOf('wall#2', [stud('wall#2', 's1', 3000), stud('wall#2', 's2', 3406.4, 600)]);
    const layout = layoutMembers(viewOf([a, b]));
    expect(layout.batches.map((x) => x.ids)).toEqual([
      ['wall#1:s1', 'wall#1:s2', 'wall#2:s1'],
      ['opening#2:cripple1', 'wall#2:s2'],
    ]);
    expect(layout.batches.map((x) => x.slotBase)).toEqual([0, 3]);
    expect(layout.batches[0]!.sets).toEqual([0, 0, 1]);
    expect(layout.slots).toEqual([
      'wall#1:s1',
      'wall#1:s2',
      'wall#2:s1',
      'opening#2:cripple1',
      'wall#2:s2',
    ]);
    expect(layout.locate.get('wall#2:s2')).toEqual({ batch: 1, index: 1 });
    // Matrices are copied in instance order: the third stud of the first batch is wall#2's.
    expect(layout.batches[0]!.matrices[2 * 16 + 12]).toBeCloseTo(3000);
    expect(layout.missing).toEqual([]);
  });

  it('leaves out shapes it has no mesh for', () => {
    const set = setOf('wall#1', [stud('wall#1', 's1', 0)]);
    const layout = layoutMembers({ meshes: new Map(), sets: [set] });
    expect(layout.batches).toEqual([]);
    expect(layout.slots).toEqual([]);
    expect(layout.missing).toEqual([set.instances[0]!.shape]);
  });

  it('tells batches made from the same instance lists', () => {
    const a = setOf('wall#1', [stud('wall#1', 's1', 0)]);
    const b = setOf('wall#2', [stud('wall#2', 's1', 900)]);
    const one = layoutMembers(viewOf([a, b])).batches[0]!;
    const two = layoutMembers(viewOf([a, b])).batches[0]!;
    expect(sameBatch(one, two)).toBe(true);
    const moved = setOf('wall#2', [stud('wall#2', 's1', 950)]);
    expect(sameBatch(one, layoutMembers(viewOf([a, moved])).batches[0]!)).toBe(false);
  });

  it('bounds a batch in world coordinates', () => {
    const set = setOf('wall#1', [stud('wall#1', 's1', 0, 1000), stud('wall#1', 's2', 500, 1000)]);
    const view = viewOf([set]);
    const batch = layoutMembers(view).batches[0]!;
    const box = batchBounds(batch, view.meshes.get(batch.shape)!)!;
    // Length up (z), width along the wall (x), depth across it (y = up cross x).
    expect(box.min.map((v) => +v.toFixed(3))).toEqual([0, 0, 38.1]);
    expect(box.max.map((v) => +v.toFixed(3))).toEqual([538.1, 88.9, 1038.1]);
  });
});

describe('level cut', () => {
  it('cuts 4 ft above the level by default and keeps everything below', () => {
    expect(levelCutRange({ elevation: 0 })).toEqual({ min: null, max: PLAN_CUT_HEIGHT });
    expect(PLAN_CUT_HEIGHT).toBeCloseTo(48 * 25.4);
  });

  it('shows one level with `below`, and no top cut with a null height', () => {
    const range = levelCutRange({ elevation: 2700, below: 0, cutHeight: null });
    expect(range.max).toBeNull();
    expect(range.min).toBeCloseTo(2699.5);
    const planes = levelCutPlanes({ elevation: 2700, below: 300, cutHeight: 1000 });
    // three.js keeps normal . p + constant >= 0.
    const keeps = (z: number) => planes.every((p) => p.normal[2] * z + p.constant >= 0);
    expect(planes).toHaveLength(2);
    expect(keeps(2399)).toBe(false);
    expect(keeps(2401)).toBe(true);
    expect(keeps(3699)).toBe(true);
    expect(keeps(3701)).toBe(false);
    expect(levelCutPlanes(null)).toEqual([]);
  });
});

describe('layers, LOD, colours and labels', () => {
  it('reads the wall layer from a layer body id', () => {
    expect(bodyLayer('part#1/extension#3:layer/sheathing')).toBe('sheathing');
    expect(bodyLayer('extension#3:layer/drywall')).toBe('drywall');
    expect(bodyLayer('part#1/extrude#1')).toBeNull();
    expect(bodyLayer('part#1/extension#3:layer/')).toBeNull();
  });

  it('draws member edges only while the stock spans a few pixels', () => {
    expect(memberEdgesVisible(38.1, 1)).toBe(true);
    expect(memberEdgesVisible(38.1, 12.7)).toBe(true);
    expect(memberEdgesVisible(38.1, 13)).toBe(false);
    expect(memberEdgesVisible(38.1, 0)).toBe(false);
  });

  it('colours by role and names roles', () => {
    expect(memberColor('stud')).not.toBe(memberColor('header'));
    expect(memberColor('something-new')).toMatch(/^#[0-9a-f]{6}$/);
    expect(roleLabel('top-plate')).toBe('Top plate');
    expect(roleLabel('stud')).toBe('Stud');
  });

  it('describes cuts in the member frame', () => {
    expect(describeCut({ kind: 'plane', n: [1, 0, 0], k: 100 })).toEqual({ kind: 'end', angle: 0 });
    const plumb = describeCut({ kind: 'plane', n: [Math.cos(0.4636), Math.sin(0.4636), 0], k: 9 });
    expect(plumb.kind).toBe('end');
    expect(plumb.angle).toBeCloseTo(0.4636, 4);
    expect(describeCut({ kind: 'plane', n: [0, -1, 0], k: 0 }).kind).toBe('face');
    expect(
      describeCut({ kind: 'notch', a: { n: [1, 0, 0], k: 1 }, b: { n: [0, -1, 0], k: 0 } }).kind,
    ).toBe('notch');
  });
});
