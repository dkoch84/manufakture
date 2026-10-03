import {
  boxMesh,
  memberInstances,
  type MemberData,
  type MemberSetResult,
} from '@manufakture/regen';
import { describe, expect, it } from 'vitest';
import { EMPTY_MEMBER_VIEW } from './members';
import { createMemberStore, shownMemberView } from './memberStore';

const stock = { id: 'us-2x4', name: '2x4', width: 38.1, depth: 88.9 };

const stud = (owner: string, id: string, x: number): MemberData => ({
  id,
  owner,
  role: 'stud',
  stock,
  length: 2352.675,
  placement: { origin: [x, 0, 38.1], x: [0, 0, 1], y: [1, 0, 0] },
  cuts: [],
});

function changed(group: string, members: MemberData[]): MemberSetResult {
  return {
    group,
    namespace: 'construction',
    features: [group],
    setKey: `${group}:${members.length}`,
    cached: false,
    changed: true,
    members,
    instances: memberInstances(members),
    count: members.length,
    ms: 1,
  };
}

const unchanged = (r: MemberSetResult): MemberSetResult => ({
  ...r,
  cached: true,
  changed: false,
  members: null,
  instances: null,
});

describe('member store', () => {
  it('accumulates meshes and sets from regens, and shows the active part', () => {
    const store = createMemberStore();
    const wall = changed('wall#1', [stud('wall#1', 's1', 0), stud('wall#1', 's2', 406.4)]);
    const shape = wall.instances![0]!.shape;
    store.getState().applyRegen({
      parts: [{ partId: 'part#1', members: [wall] }, { partId: 'part#2' }],
      memberMeshes: { added: [{ key: shape, ...boxMesh(2352.675, 38.1, 88.9) }], removed: [] },
    });
    expect(shownMemberView(store.getState())).toBe(EMPTY_MEMBER_VIEW);
    store.getState().show('part#1');
    const first = shownMemberView(store.getState());
    expect(first.sets.map((s) => s.group)).toEqual(['wall#1']);
    expect([...first.meshes.keys()]).toEqual([shape]);
    // The same view object while nothing changes.
    expect(shownMemberView(store.getState())).toBe(first);

    // A regen that changes nothing leaves the state alone.
    const state = store.getState();
    store.getState().applyRegen({ parts: [{ partId: 'part#1', members: [unchanged(wall)] }] });
    expect(store.getState()).toBe(state);

    // A second wall: the first set object stays.
    const wall2 = changed('wall#2', [stud('wall#2', 's1', 5000)]);
    store
      .getState()
      .applyRegen({ parts: [{ partId: 'part#1', members: [unchanged(wall), wall2] }] });
    const second = shownMemberView(store.getState());
    expect(second.sets[0]).toBe(first.sets[0]);
    expect(second.sets.map((s) => s.group)).toEqual(['wall#1', 'wall#2']);

    // The walls are deleted: the sets go, and regen drops the mesh.
    store.getState().applyRegen({
      parts: [{ partId: 'part#1' }],
      memberMeshes: { added: [], removed: [shape] },
    });
    expect(store.getState().parts.size).toBe(0);
    expect(store.getState().meshes.size).toBe(0);
    expect(shownMemberView(store.getState())).toBe(EMPTY_MEMBER_VIEW);
  });

  it('loads a fixture for a part and clears', () => {
    const store = createMemberStore();
    const members = [stud('wall#1', 's1', 0)];
    const instances = memberInstances(members);
    store.getState().load('p', {
      meshes: new Map([[instances[0]!.shape, boxMesh(2352.675, 38.1, 88.9)]]),
      sets: [
        { group: 'wall#1', namespace: 'construction', features: ['wall#1'], members, instances },
      ],
    });
    expect(store.getState().shown).toBe('p');
    expect(shownMemberView(store.getState()).sets).toHaveLength(1);
    store.getState().clear();
    expect(store.getState().shown).toBeNull();
    expect(store.getState().meshes.size).toBe(0);
  });
});
