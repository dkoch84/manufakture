// A small building for the IFC tests, as plain data (this package imports no domain; the
// construction domain's own tests export the framed M6 shed). One level; a 4 m wall with a door
// and a window and sheathing outside its framing; a 3 m wall with sheathing and drywall; studs on
// both, a header over the door; a floor slab with two joists; a gable roof of two rafters and a
// ridge with one sheathing sheet.

import type {
  IfcBuildingInput,
  IfcMemberInput,
  IfcPlaneInput,
  IfcVec3,
  IfcWallInput,
} from './model';

export const TEST_DISCLAIMER =
  'Not an engineering tool: this layout does no structural calculation and no code check.';

const BASE = 200;
const HEIGHT = 2400;
const STUD = { name: '2x4', width: 38, depth: 89 };
const JOIST = { name: '2x8', width: 38, depth: 184 };

const cross = (a: IfcVec3, b: IfcVec3): IfcVec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

/** The eight corners of a member's blank, mm. */
export function blankCorners(m: IfcMemberInput): IfcVec3[] {
  const { origin: o, x, y } = m.placement;
  const z = cross(x, y);
  const out: IfcVec3[] = [];
  for (const a of [0, m.length])
    for (const b of [0, m.stock.width])
      for (const c of [0, m.stock.depth])
        out.push(
          [0, 1, 2].map((k) => o[k]! + a * x[k]! + b * y[k]! + c * z[k]!) as unknown as IfcVec3,
        );
  return out;
}

const member = (
  owner: string,
  id: string,
  role: string,
  stock: IfcMemberInput['stock'],
  length: number,
  placement: IfcPlaneInput,
): IfcMemberInput => ({ owner, id, role, stock, length, placement });

const UP: IfcVec3 = [0, 0, 1];

export function testBuilding(name = 'Test building', documentId = 'doc-test'): IfcBuildingInput {
  const walls: IfcWallInput[] = [
    {
      id: 'wall-a',
      name: 'Wall A',
      level: 'level-1',
      base: BASE,
      height: HEIGHT,
      points: [
        [0, 0],
        [4000, 0],
      ],
      closed: false,
      thickness: 89,
      layers: [
        { id: 'sheathing', kind: 'sheathing', t: [-11, 0] },
        { id: 'framing', kind: 'framing', t: [0, 89] },
      ],
    },
    {
      id: 'wall-b',
      name: 'Wall B',
      level: 'level-1',
      base: BASE,
      height: HEIGHT,
      points: [
        [4000, 0],
        [4000, 3000],
      ],
      closed: false,
      thickness: 89,
      layers: [
        { id: 'sheathing', kind: 'sheathing', t: [-11, 0] },
        { id: 'framing', kind: 'framing', t: [0, 89] },
        { id: 'drywall', kind: 'drywall', t: [89, 102] },
      ],
    },
  ];
  const members: IfcMemberInput[] = [];
  // Studs along wall A (x along the wall, y up) and wall B (along +y).
  for (let i = 0; i < 10; i++) {
    members.push(
      member('wall-a', `s${i}`, 'stud', STUD, HEIGHT, {
        origin: [i * 400 + 38, 0, BASE],
        x: UP,
        y: [-1, 0, 0],
      }),
    );
  }
  for (let i = 0; i < 8; i++) {
    members.push(
      member('wall-b', `s${i}`, 'stud', STUD, HEIGHT, {
        origin: [4000 - 89, i * 400, BASE],
        x: UP,
        y: [0, 1, 0],
      }),
    );
  }
  members.push(
    member('wall-a', 'bottom1', 'bottom-plate', STUD, 4000, {
      origin: [0, 89, BASE],
      x: [1, 0, 0],
      y: [0, 0, 1],
    }),
    member('door', 'header', 'header', JOIST, 1000, {
      origin: [500, 89, BASE + 2100],
      x: [1, 0, 0],
      y: [0, -1, 0],
    }),
    member('floor', 'j1', 'joist', JOIST, 3000, { origin: [0, 0, 0], x: [0, 1, 0], y: [-1, 0, 0] }),
    member('floor', 'j2', 'joist', JOIST, 3000, {
      origin: [2000, 0, 0],
      x: [0, 1, 0],
      y: [-1, 0, 0],
    }),
    member('roof', 'r1', 'common-rafter', STUD, 2300, {
      origin: [0, 0, BASE + HEIGHT],
      x: [0, 0.8944271909999159, 0.4472135954999579],
      y: [1, 0, 0],
    }),
    member('roof', 'r2', 'common-rafter', STUD, 2300, {
      origin: [2000, 0, BASE + HEIGHT],
      x: [0, 0.8944271909999159, 0.4472135954999579],
      y: [1, 0, 0],
    }),
    member('roof', 'ridge', 'ridge', JOIST, 4000, {
      origin: [0, 1500, BASE + HEIGHT + 750],
      x: [1, 0, 0],
      y: [0, 0, 1],
    }),
  );
  return {
    documentId,
    name,
    unit: 'mm',
    disclaimer: TEST_DISCLAIMER,
    levels: [{ id: 'level-1', name: 'Level 1', elevation: 0 }],
    walls,
    openings: [
      {
        id: 'door',
        name: 'Door',
        wall: 'wall-a',
        type: 'door',
        segment: 1,
        position: 1000,
        width: 900,
        height: 2050,
        sill: 0,
      },
      {
        id: 'window',
        name: 'Window',
        wall: 'wall-a',
        type: 'window',
        segment: 1,
        position: 3000,
        width: 600,
        height: 900,
        sill: 1000,
      },
    ],
    floors: [
      {
        id: 'floor',
        name: 'Floor',
        level: 'level-1',
        outline: [
          [0, 0],
          [4000, 0],
          [4000, 3000],
          [0, 3000],
        ],
        top: BASE,
        thickness: 18,
      },
    ],
    roofs: [
      {
        id: 'roof',
        name: 'Roof',
        level: 'level-1',
        kind: 'gable',
        sheets: [
          {
            id: 'slope-1',
            placement: {
              origin: [0, 0, BASE + HEIGHT + 100],
              x: [1, 0, 0],
              y: [0, 0.8944271909999159, 0.4472135954999579],
            },
            outline: [
              [0, 0],
              [4000, 0],
              [4000, 1700],
              [0, 1700],
            ],
            thickness: 11,
          },
        ],
      },
    ],
    members,
  };
}
