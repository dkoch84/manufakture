import { describe, expect, it } from 'vitest';
import { frameWall } from './framing/wall';
import { memberListing, type MemberListingSources } from './member-list';
import { S2X6, inch, straightWall, toInches } from './test-helpers';

const WALL = 'extension#3';
const WINDOW = 'extension#7';

// A 12' wall along +x with a 3' window centred at 48", sill 44". The wall nudges s1 by 2",
// deletes s3 (under the window, so lost) and names a member it never had.
const wallOverrides = [
  { id: 's1', move: inch(2) },
  { id: 's3', delete: true },
  { id: 'extra1', stock: S2X6 },
];
const window = {
  id: WINDOW,
  position: inch(48),
  width: inch(36),
  height: inch(36),
  sill: inch(44),
  overrides: [{ id: 'sill', stock: S2X6 }],
};
const input = straightWall(144, { openings: [window] }, {}, { overrides: wallOverrides });
const framed = frameWall(input);

const features: MemberListingSources['features'] = [
  {
    featureId: WALL,
    metadata: {
      kind: 'wall',
      points: [
        [0, 0],
        [inch(144), 0],
      ],
      closed: false,
      base: 0,
      layers: [],
      overrides: wallOverrides,
    } as never,
  },
  {
    featureId: WINDOW,
    metadata: {
      kind: 'opening',
      wall: WALL,
      segment: 1,
      position: inch(48),
      overrides: window.overrides,
    } as never,
  },
  { featureId: 'extrude#1' },
];
const sets = [{ group: WALL, members: framed.members, metadata: { overrides: framed.overrides } }];

describe('memberListing', () => {
  it("lists a wall's own members along it, with each override's status", () => {
    const l = memberListing({ owner: WALL, features, sets })!;
    expect(l).toMatchObject({ owner: WALL, kind: 'wall', group: WALL, framed: true });
    expect(l.count).toBe(framed.members.filter((m) => m.owner === WALL).length);
    expect(l.members.every((m) => m.id.startsWith(`${WALL}:`))).toBe(true);
    // Sorted along the wall.
    const centres = l.members.map((m) => m.along!.centre);
    expect(centres).toEqual([...centres].sort((a, b) => a - b));
    // s1 is centred on 16", nudged 2".
    const s1 = l.members.find((m) => m.local === 's1')!;
    expect(s1).toMatchObject({ id: `${WALL}:s1`, role: 'stud', stock: { id: 'us-2x4' } });
    expect(toInches(s1.along!.centre)).toBeCloseTo(18, 3);
    expect(toInches(s1.along!.to - s1.along!.from)).toBeCloseTo(1.5, 3);
    expect(s1.above!.from).toBeGreaterThan(0);
    expect(l.overrides).toEqual([
      { n: 1, id: 's1', member: `${WALL}:s1`, status: 'applied', move: inch(2) },
      { n: 2, id: 's3', member: `${WALL}:s3`, status: 'lost', delete: true },
      { n: 3, id: 'extra1', member: `${WALL}:extra1`, status: 'lost', stock: 'us-2x6' },
    ]);
  });

  it("lists an opening's members on its host wall; the studs under a window sit below its sill", () => {
    const l = memberListing({ owner: WINDOW, features, sets })!;
    expect(l).toMatchObject({ kind: 'opening', wall: WALL, segment: 1, group: WALL });
    const under = l.members.filter((m) => m.role === 'cripple' && m.above!.to <= inch(44) + 1e-6);
    expect(under.length).toBeGreaterThan(0);
    for (const m of under) {
      expect(m.local).toMatch(/^cripple-b\d+$/);
      expect(m.along!.centre).toBeGreaterThan(inch(48 - 18));
      expect(m.along!.centre).toBeLessThan(inch(48 + 18));
    }
    expect(l.members.find((m) => m.local === 'sill')!.stock.id).toBe('us-2x6');
    expect(l.overrides).toEqual([
      { n: 1, id: 'sill', member: `${WINDOW}:sill`, status: 'applied', stock: 'us-2x6' },
    ]);
  });

  it('says when the group is not framed, and refuses features that frame nothing', () => {
    const l = memberListing({ owner: WALL, features, sets: [] })!;
    expect(l).toMatchObject({ framed: false, count: 0, members: [] });
    expect(l.overrides.map((o) => o.status)).toEqual(['lost', 'lost', 'lost']);
    expect(memberListing({ owner: 'extrude#1', features, sets })).toBeUndefined();
    expect(memberListing({ owner: 'extension#99', features, sets })).toBeUndefined();
  });
});

describe('memberListing: added members', () => {
  // A wall of two segments, 12' along +x then 8' along +y, adding a doubled stud on its second
  // segment and a block on its first; a window on the first segment adds a stud of its own.
  const seg = (start: [number, number], end: [number, number]) => ({
    ...straightWall(144).segments[0]!,
    start,
    end,
  });
  const add = [
    { id: 'add1', role: 'stud' as const, at: inch(28), plies: 2, segment: 2 },
    { id: 'add2', role: 'blocking' as const, at: inch(20) },
  ];
  const windowAdd = [{ id: 'add1', role: 'stud' as const, at: inch(-24) }];
  const input = {
    ...straightWall(144),
    segments: [
      { ...seg([0, 0], [inch(144), 0]), openings: [{ ...window, overrides: [], add: windowAdd }] },
      seg([inch(144), 0], [inch(144), inch(96)]),
    ],
    add,
    overrides: [{ id: 'add1-2', stock: S2X6 }],
  };
  const r = frameWall(input);
  const feats: MemberListingSources['features'] = [
    {
      featureId: WALL,
      metadata: {
        kind: 'wall',
        points: [
          [0, 0],
          [inch(144), 0],
          [inch(144), inch(96)],
        ],
        closed: false,
        base: 0,
        layers: [],
        overrides: input.overrides,
        add,
      } as never,
    },
    {
      featureId: WINDOW,
      metadata: {
        kind: 'opening',
        wall: WALL,
        segment: 1,
        position: inch(48),
        overrides: [],
        add: windowAdd,
      } as never,
    },
  ];
  const s = [{ group: WALL, members: r.members, metadata: { overrides: r.overrides } }];

  it('lists added members with their role, where they are along the wall, and as added', () => {
    expect(r.warnings).toEqual([]);
    const l = memberListing({ owner: WALL, features: feats, sets: s })!;
    const added = l.members.filter((m) => m.added);
    expect(
      added.map((m) => [m.local, m.role, m.along!.segment, toInches(m.along!.centre)]),
    ).toEqual([
      ['add2', 'blocking', 1, 20],
      ['add1', 'stud', 2, 27.25],
      ['add1-2', 'stud', 2, 28.75],
    ]);
    expect(added.find((m) => m.local === 'add1-2')!.stock.id).toBe('us-2x6');
    expect(l.members.filter((m) => !m.added).every((m) => !('added' in m))).toBe(true);
    expect(l.overrides).toEqual([
      { n: 1, id: 'add1-2', member: `${WALL}:add1-2`, status: 'applied', stock: 'us-2x6' },
    ]);
  });

  it("lists an opening's added member, from the opening's centre line", () => {
    const l = memberListing({ owner: WINDOW, features: feats, sets: s })!;
    const m = l.members.find((x) => x.local === 'add1')!;
    expect(m).toMatchObject({ id: `${WINDOW}:add1`, role: 'stud', added: true });
    expect(toInches(m.along!.centre)).toBeCloseTo(24, 3);
  });
});
