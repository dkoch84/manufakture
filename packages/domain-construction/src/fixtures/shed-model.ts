// @manufakture/domain-construction/fixtures/shed-model: the 12' x 16' shed of T6.3a's fixture
// (`src/takeoff/shed.test.ts`) as a regen reports it: a document with its walls, openings, floor
// and roof features, the feature results with the metadata their translators return (paths on the
// framing's outside face, sheathing outside it, the roof's gable fills), and the member sets
// framed by the same generators with the same inputs. So the takeoff's rows can be checked against
// T6.3a's hand counts without a kernel, here and in the app's Takeoff panel tests.

import {
  applyCommand,
  createDocument,
  type Command,
  type ExtensionFeature,
  type ManufaktureDocument,
} from '@manufakture/core';
import type { FeatureResult, MemberData, MemberInstances } from '@manufakture/regen';
import type { OpeningMetadata, WallMetadata } from '../features/common';
import type { FloorMetadata } from '../features/floor';
import type { RoofMetadata } from '../features/roof';
import { frameFloor, type FrameFloorInput } from '../framing/floor';
import { frameRoof, type FrameRoofInput } from '../framing/roof';
import { frameWall, type HeaderSpec, type WallOpening } from '../framing/wall';
import type { StockRef } from '../members';

/** A framing group's members as regen sends them for a part, and as the app's viewport keeps them. */
export interface ShedMemberSet {
  group: string;
  namespace: string;
  features: string[];
  members: MemberData[];
  instances: MemberInstances[];
}

export const IN = 25.4;
const inch = (v: number) => v * IN;
export const PART = 'part#1';
const OSB = 'us-osb-7-16';
const HEIGHT = inch(1.5 + 92.625 + 3);

const S2X4: StockRef = { id: 'us-2x4', name: '2x4', width: inch(1.5), depth: inch(3.5) };
const S2X6: StockRef = { id: 'us-2x6', name: '2x6', width: inch(1.5), depth: inch(5.5) };
const S2X8: StockRef = { id: 'us-2x8', name: '2x8', width: inch(1.5), depth: inch(7.25) };
const S4X6: StockRef = { id: 'us-4x6', name: '4x6', width: inch(3.5), depth: inch(5.5) };
const OSB_23_32: StockRef = {
  id: 'us-osb-23-32',
  name: '3/4" OSB',
  width: inch(23 / 32),
  depth: inch(48),
};
const HEADER: HeaderSpec = { stock: S2X6, plies: 2, jacks: 1 };
const L_JOIN = { kind: 'L' as const, otherThickness: inch(3.5) };

// Walls A (front, two windows) and C (back) 16' and running through; B (the door) and D 12' and
// butting between them. B and D are the gable ends.
export const A = 'extension#3';
export const B = 'extension#4';
export const C = 'extension#5';
export const D = 'extension#6';
export const FLOOR = 'extension#2';
export const ROOF = 'extension#10';
export const WINDOWS = ['extension#7', 'extension#8'];
export const DOOR = 'extension#9';

function framed(id: string, lengthIn: number, through: boolean, openings: WallOpening[] = []) {
  return frameWall({
    wall: id,
    segments: [
      {
        start: [0, 0],
        end: [inch(lengthIn), 0],
        height: HEIGHT,
        thickness: inch(3.5),
        justification: 'left',
        joins: { start: { ...L_JOIN, through }, end: { ...L_JOIN, through } },
        openings,
      },
    ],
    settings: {
      studStock: S2X4,
      defaultHeader: HEADER,
      headerRules: [{ maxWidth: inch(48), header: HEADER }],
    },
  });
}

const windowAt = (id: string, at: number): WallOpening => ({
  id,
  position: inch(at),
  width: inch(24),
  height: inch(36),
  sill: inch(44),
});

const FLOOR_INPUT: FrameFloorInput = {
  floor: FLOOR,
  outline: [
    [0, 0],
    [inch(144), 0],
    [inch(144), inch(192)],
    [0, inch(192)],
  ],
  direction: [1, 0],
  settings: { joistStock: S2X6, skids: { stock: S4X6, count: 3 }, subfloor: OSB_23_32 },
};

export const ROOF_INPUT: FrameRoofInput = {
  roof: ROOF,
  kind: 'gable',
  pitch: Math.atan(6 / 12),
  footprint: {
    origin: [0, 0],
    length: inch(192),
    width: inch(144),
    plate: HEIGHT,
    wallThickness: inch(3.5),
  },
  settings: {
    rafterStock: S2X6,
    ridgeStock: S2X8,
    overhang: inch(12),
    rakeOverhang: inch(12),
    ties: { kind: 'rafter-ties', stock: S2X4, every: 2, height: inch(24) },
    gableStuds: { stock: S2X4, spacing: inch(16) },
  },
};

/** Every member of the shed, by owner group. */
export function shedMembers(): Map<string, MemberData[]> {
  const groups = new Map<string, MemberData[]>();
  const add = (group: string, members: readonly unknown[]) =>
    groups.set(group, members as MemberData[]);
  add(A, framed(A, 192, true, [windowAt(WINDOWS[0]!, 48), windowAt(WINDOWS[1]!, 144)]).members);
  add(
    B,
    framed(B, 137, false, [
      { id: DOOR, position: inch(68.5), width: inch(36), height: inch(80), sill: 0 },
    ]).members,
  );
  add(C, framed(C, 192, true).members);
  add(D, framed(D, 137, false).members);
  add(FLOOR, frameFloor(FLOOR_INPUT).members);
  add(ROOF, frameRoof(ROOF_INPUT).members);
  return groups;
}

export function shedSets(): ShedMemberSet[] {
  return [...shedMembers()].map(([group, members]) => ({
    group,
    namespace: 'construction',
    features: [group],
    members,
    instances: [],
  }));
}

const P = (x: number, y: number) => [inch(x), inch(y)] as const;

function wallMeta(points: readonly (readonly [number, number])[]): WallMetadata {
  return {
    kind: 'wall',
    level: 'level-1',
    base: 0,
    height: HEIGHT,
    points,
    closed: false,
    justification: 'left',
    thickness: inch(3.5),
    free: { start: false, end: false },
    layers: [
      { id: 'sheathing', kind: 'sheathing', body: null, t: [-inch(7 / 16), 0] },
      { id: 'framing', kind: 'framing', body: null, t: [0, inch(3.5)] },
    ],
    settings: {} as WallMetadata['settings'],
    overrides: [],
  };
}

function withBody(id: string, meta: WallMetadata): WallMetadata {
  return {
    ...meta,
    layers: meta.layers.map((l) =>
      l.kind === 'sheathing' ? { ...l, body: `${id}:layer/sheathing` } : l,
    ),
  };
}

function openingMeta(
  wall: string,
  type: 'door' | 'window',
  position: number,
  width: number,
  height: number,
  sill: number,
): OpeningMetadata {
  return {
    kind: 'opening',
    wall,
    type,
    segment: 1,
    position: inch(position),
    width: inch(width),
    height: inch(height),
    sill: inch(sill),
    header: { kind: 'auto' },
    overrides: [],
    cuts: [],
  };
}

/** The feature results regen would give, with their metadata. */
export function shedFeatures(): FeatureResult[] {
  const meta: [string, unknown][] = [
    [
      FLOOR,
      {
        kind: 'floor',
        level: 'level-1',
        input: FLOOR_INPUT,
        top: 0,
        subfloor: `${FLOOR}:layer/subfloor`,
      } satisfies FloorMetadata,
    ],
    // Counter-clockwise, exterior to the right, the path on the framing's outside face.
    [A, withBody(A, wallMeta([P(0, 0), P(192, 0)]))],
    [B, withBody(B, wallMeta([P(192, 0), P(192, 144)]))],
    [C, withBody(C, wallMeta([P(192, 144), P(0, 144)]))],
    [D, withBody(D, wallMeta([P(0, 144), P(0, 0)]))],
    [WINDOWS[0]!, openingMeta(A, 'window', 48, 24, 36, 44)],
    [WINDOWS[1]!, openingMeta(A, 'window', 144, 24, 36, 44)],
    [DOOR, openingMeta(B, 'door', 72, 36, 80, 0)],
    [
      ROOF,
      {
        kind: 'roof',
        level: 'level-1',
        walls: [A, C, B, D],
        input: ROOF_INPUT,
        sheathing: {
          stock: OSB,
          thickness: inch(7 / 16),
          bodies: [`${ROOF}:layer/sheathing-e1`, `${ROOF}:layer/sheathing-e3`],
        },
        gables: [
          { edge: 2, wall: B, body: `${ROOF}:layer/gable-e2-sheathing` },
          { edge: 4, wall: D, body: `${ROOF}:layer/gable-e4-sheathing` },
        ],
      } satisfies RoofMetadata,
    ],
  ];
  return meta.map(([featureId, metadata], index) => ({
    featureId,
    kind: 'extension',
    index,
    status: 'ok',
    errors: [],
    warnings: [],
    references: [],
    cached: false,
    ms: 0,
    metadata: metadata as NonNullable<FeatureResult['metadata']>,
  }));
}

const CONSTRUCTION = {
  levels: [
    {
      id: 'level-1',
      name: 'Level 1',
      elevation: { source: '0', lengthUnit: 'in', angleUnit: 'deg' },
      height: { source: '97.125', lengthUnit: 'in', angleUnit: 'deg' },
    },
  ],
  wallTypes: [
    {
      id: 'ext-2x4',
      name: 'Exterior 2x4',
      layers: [
        { id: 'sheathing', kind: 'sheathing', stock: OSB },
        {
          id: 'framing',
          kind: 'framing',
          stock: 'us-2x4',
          header: { stock: 'us-2x6', plies: 2, jacks: 1 },
        },
      ],
    },
  ],
};

function feature(id: string, extension: string, params: Record<string, unknown>): ExtensionFeature {
  return {
    id,
    kind: 'extension',
    name: id,
    suppressed: false,
    extension,
    schemaVersion: 1,
    dependsOn: [],
    references: [],
    expressions: {},
    params: params as ExtensionFeature['params'],
    operation: 'new',
  };
}

/** Fixed prices, as T6.3a's cost check has them. */
export const PRICES = {
  overrides: Object.fromEntries(
    (
      [
        ['us-2x4-precut-92-5-8', 4.5, 'piece'],
        ['us-2x4', 0.75, 'foot'],
        ['us-2x6', 1.1, 'foot'],
        ['us-2x8', 1.5, 'foot'],
        ['us-4x6', 2.5, 'foot'],
        [OSB, 16, 'sheet'],
        ['us-osb-23-32', 38, 'sheet'],
      ] as const
    ).map(([id, amount, per]) => [id, { price: { amount, per, currency: 'USD' } }]),
  ),
};

export function shedDocument(options: { prices?: boolean } = {}): ManufaktureDocument {
  let doc = createDocument({
    id: 'shed',
    name: 'Shed',
    units: {
      length: { unit: 'ft-in', denominator: 16 },
      angle: { unit: 'deg' },
    } as ManufaktureDocument['units'],
  });
  const commands: Command[] = [
    {
      type: 'setDomainData',
      namespace: 'construction',
      schemaVersion: 1,
      data: CONSTRUCTION as never,
    },
    ...(options.prices
      ? [
          {
            type: 'setDomainData',
            namespace: 'stock',
            schemaVersion: 1,
            data: PRICES as never,
          } as Command,
        ]
      : []),
    ...[FLOOR, A, B, C, D, ...WINDOWS, DOOR, ROOF].map((id): Command => ({
      type: 'addFeature',
      partId: PART,
      feature: feature(
        id,
        [A, B, C, D].includes(id)
          ? 'construction.wall'
          : id === FLOOR
            ? 'construction.floor'
            : id === ROOF
              ? 'construction.roof'
              : 'construction.opening',
        [A, B, C, D].includes(id) ? { level: 'level-1', wallType: 'ext-2x4', points: 2 } : {},
      ),
    })),
  ];
  for (const c of commands) {
    const r = applyCommand(doc, c);
    if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
    doc = r.value.document;
  }
  return doc;
}
