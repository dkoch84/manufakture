// The M6 shed for the IFC tests, framed by the construction domain's own generators: a 12' x 16'
// floor of 2x6 joists with 23/32" subfloor, four 2x4 walls with 7/16" sheathing (a 36" x 80" door
// on a 12' end, two 24" x 36" windows on a 16' side), and a 6/12 gable of 2x6 rafters and a 2x8
// ridge; drywall on the two walls without openings. The walls are four separate walls, each
// framed with free ends; the IFC writer does not care how the corners are framed. Built here as
// the writer's input directly, without regen (`ifc.regen.test.ts` goes through regen).

import type {
  IfcBuildingInput,
  IfcOpeningInput,
  IfcSheetInput,
  IfcVec2,
  IfcWallInput,
} from '@manufakture/io';
import { frameFloor } from '../framing/floor';
import { frameRoof } from '../framing/roof';
import { frameWall, type FrameWallInput, type WallOpening } from '../framing/wall';
import type { Member, StockRef } from '../members';

const IN = 25.4;
const inch = (v: number) => v * IN;

const S2X4: StockRef = { id: 'us-2x4', name: '2x4', width: inch(1.5), depth: inch(3.5) };
const S2X6: StockRef = { id: 'us-2x6', name: '2x6', width: inch(1.5), depth: inch(5.5) };
const S2X8: StockRef = { id: 'us-2x8', name: '2x8', width: inch(1.5), depth: inch(7.25) };
const PLY: StockRef = {
  id: 'us-ply-15-32',
  name: '1/2" plywood',
  width: inch(0.5),
  depth: inch(48),
};

export const SHED_DISCLAIMER =
  'Not an engineering tool: manufakture lays out framing by rules you choose. It does no ' +
  'structural calculation and no load, span, bracing or building code check.';

const FLOOR = 'extension#1';
const ROOF = 'extension#20';
const SUBFLOOR = inch(23 / 32);
const JOIST_TOP = inch(5.5);
const BASE = JOIST_TOP + SUBFLOOR;
const HEIGHT = inch(1.5 + 92.625 + 3);
const PITCH = Math.atan(6 / 12);

interface ShedWall {
  id: string;
  from: IfcVec2;
  to: IfcVec2;
  openings: IfcOpeningInput[];
}

const rect = (w: number, l: number): IfcVec2[] => [
  [0, 0],
  [w, 0],
  [w, l],
  [0, l],
];

export interface Shed {
  building: IfcBuildingInput;
  /** Members by owner kind, for the expected counts. */
  members: Member[];
}

/** The shed as the IFC writer takes it. `name` and `documentId` vary it for the tests. */
export function shed(name = 'Shed', documentId = 'doc-shed'): Shed {
  // Floor: 12' along x (the joists' span), 16' along y.
  const floor = frameFloor({
    floor: FLOOR,
    outline: rect(inch(144), inch(192)),
    direction: [1, 0],
    settings: { joistStock: S2X6 },
  });

  // Walls, counter-clockwise, so the interior is on the left (`justification: 'left'`).
  const [x1, y1] = [inch(144), inch(192)];
  const walls: ShedWall[] = [
    {
      id: 'extension#2',
      from: [0, 0],
      to: [x1, 0],
      openings: [
        {
          id: 'extension#6',
          name: 'Door',
          wall: 'extension#2',
          type: 'door',
          segment: 1,
          position: inch(72),
          width: inch(38),
          height: inch(82.5),
          sill: 0,
        },
      ],
    },
    {
      id: 'extension#3',
      from: [x1, 0],
      to: [x1, y1],
      openings: [
        {
          id: 'extension#7',
          name: 'Window 1',
          wall: 'extension#3',
          type: 'window',
          segment: 1,
          position: inch(48),
          width: inch(25.5),
          height: inch(37.5),
          sill: inch(42),
        },
        {
          id: 'extension#8',
          name: "Window 2 'east' \\ ü",
          wall: 'extension#3',
          type: 'window',
          segment: 1,
          position: inch(144),
          width: inch(25.5),
          height: inch(37.5),
          sill: inch(42),
        },
      ],
    },
    { id: 'extension#4', from: [x1, y1], to: [0, y1], openings: [] },
    { id: 'extension#5', from: [0, y1], to: [0, 0], openings: [] },
  ];
  const wallMembers = walls.flatMap((w) => {
    const input: FrameWallInput = {
      wall: w.id,
      segments: [
        {
          start: w.from,
          end: w.to,
          base: BASE,
          height: HEIGHT,
          thickness: inch(3.5),
          justification: 'left',
          openings: w.openings.map((o): WallOpening => ({
            id: o.id,
            position: o.position,
            width: o.width,
            height: o.height,
            sill: o.sill,
          })),
        },
      ],
      settings: {
        studStock: S2X4,
        defaultHeader: { stock: S2X8, plies: 2, spacer: PLY, jacks: 1 },
      },
    };
    return frameWall(input).members;
  });

  const roof = frameRoof({
    roof: ROOF,
    kind: 'gable',
    pitch: PITCH,
    footprint: {
      origin: [0, 0],
      direction: Math.PI / 2,
      length: y1,
      width: x1,
      plate: BASE + HEIGHT,
      wallThickness: inch(3.5),
    },
    settings: { rafterStock: S2X6, ridgeStock: S2X8 },
  });

  // Roof sheathing: one sheet per slope, 7/16" on the rafters' tops (approximate: the tests
  // only count them).
  const cos = Math.cos(PITCH);
  const sin = Math.sin(PITCH);
  const slope = x1 / 2 / cos;
  const top = BASE + HEIGHT + roof.geometry.heightAbovePlate;
  const sheets: IfcSheetInput[] = [
    {
      id: 'slope-1',
      placement: { origin: [0, 0, top], x: [0, 1, 0], y: [cos, 0, sin] },
      outline: rect(y1, slope),
      thickness: inch(7 / 16),
    },
    {
      id: 'slope-2',
      placement: { origin: [x1, y1, top], x: [0, -1, 0], y: [-cos, 0, sin] },
      outline: rect(y1, slope),
      thickness: inch(7 / 16),
    },
  ];

  const wallInputs: IfcWallInput[] = walls.map((w, i) => ({
    id: w.id,
    name: `Wall ${i + 1}`,
    level: 'level-1',
    base: BASE,
    height: HEIGHT,
    points: [w.from, w.to],
    closed: false,
    thickness: inch(3.5),
    layers: [
      { id: 'sheathing', kind: 'sheathing', t: [-inch(7 / 16), 0] },
      { id: 'framing', kind: 'framing', t: [0, inch(3.5)] },
      // Drywall on the two walls without openings only, so the tests see both kinds.
      ...(i >= 2
        ? [{ id: 'drywall', kind: 'drywall' as const, t: [inch(3.5), inch(4)] as const }]
        : []),
    ],
  }));

  const members = [...floor.members, ...wallMembers, ...roof.members];
  return {
    members,
    building: {
      documentId,
      name,
      unit: 'ft',
      disclaimer: SHED_DISCLAIMER,
      levels: [{ id: 'level-1', name: 'Level 1', elevation: 0 }],
      walls: wallInputs,
      openings: walls.flatMap((w) => w.openings),
      floors: [
        {
          id: FLOOR,
          name: 'Floor',
          level: 'level-1',
          outline: rect(x1, y1),
          top: BASE,
          thickness: SUBFLOOR,
        },
      ],
      roofs: [{ id: ROOF, name: 'Roof', level: 'level-1', kind: 'gable', sheets }],
      members,
    },
  };
}
