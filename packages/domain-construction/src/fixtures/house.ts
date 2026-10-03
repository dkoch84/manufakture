// The house-scale fixture of T6.5d (M6 plan, Part 3 "T6.5d"; the T6.5a spike's house rebuilt
// with the real features): a 50' x 40' (2,000 sq ft) single-storey house on one level.
//
// - Four exterior walls of 2x6 with 7/16" OSB outside and 1/2" drywall inside, separate features
//   running counter-clockwise with their exterior (right of the path) out and the path on the
//   framing's outside face, so they meet at L corners; each later wall names the earlier walls it
//   meets in `dependsOn`, so their layers join.
// - Seven interior walls of 2x4 with 1/2" gypsum on both faces (the first as a `sheathing`-kind
//   layer, since a wall type has its sheet layers outside then inside), centred on their paths:
//   a bearing wall down the middle (east to west, teeing into both end walls) and six partitions
//   teeing into the exterior walls, the middle wall or each other, as in the spike.
// - Ten openings: two 36" x 80" doors and eight windows, as in the spike (sizes and walls), at
//   positions moved where the real generator puts an opening's framing clear of a tee, each
//   scoped to its host's layer bodies as the app writes it.
// - A floor of 2x10 joists at 16" under 23/32" OSB in two spans of 20' (the spike's girder line
//   under the middle wall), as two floor features with outlines from points, each with mid-span
//   blocking. One floor spanning the full 40' would frame 40' joists, longer than any stock.
// - A 6/12 hip roof of 2x8 rafters, a 2x10 ridge and 2x10 hips, 7/16" OSB sheathing and 2x6
//   ceiling joists as ties, bearing on the exterior walls.
//
// Plain data (types from core only), so the Node bench (`bench/`), this package's tests and the
// app's e2e spec (`apps/web/e2e/m6-fixtures.ts`) build the same document. All lengths in inches.

import type { Command, ExtensionFeature, StoredExpression } from '@manufakture/core';

/** The house's outline, in inches: x along its 50' length, y along its 40' width. */
export const HOUSE_LENGTH_IN = 600;
export const HOUSE_WIDTH_IN = 480;

/** A length expression in inches (an inferred type, so it also fits where JSON is expected). */
const ins = (v: number | string) => ({
  source: String(v),
  lengthUnit: 'in' as const,
  angleUnit: 'deg' as const,
});

/** `domains.construction` of the house (schemaVersion 1). */
export const HOUSE_CONSTRUCTION = {
  levels: [{ id: 'level-1', name: 'Level 1', elevation: ins(0), height: ins(97.125) }],
  wallTypes: [
    {
      id: 'ext-2x6',
      name: 'Exterior 2x6',
      layers: [
        { id: 'sheathing', kind: 'sheathing', stock: 'us-osb-7-16' },
        {
          id: 'framing',
          kind: 'framing',
          stock: 'us-2x6',
          header: { stock: 'us-2x10', plies: 3, jacks: 1 },
        },
        { id: 'drywall', kind: 'drywall', stock: 'us-gyp-1-2-8ft' },
      ],
    },
    {
      id: 'int-2x4',
      name: 'Interior 2x4',
      layers: [
        { id: 'drywall-a', kind: 'sheathing', stock: 'us-gyp-1-2-8ft' },
        {
          id: 'framing',
          kind: 'framing',
          stock: 'us-2x4',
          header: { stock: 'us-2x8', plies: 2, jacks: 1 },
        },
        { id: 'drywall-b', kind: 'drywall', stock: 'us-gyp-1-2-8ft' },
      ],
    },
  ],
  floorTypes: [
    {
      id: 'house-floor',
      name: 'House floor',
      joistStock: 'us-2x10',
      rimStock: 'us-2x10',
      subfloor: 'us-osb-23-32',
    },
  ],
  roofTypes: [
    {
      id: 'house-roof',
      name: 'House roof',
      rafterStock: 'us-2x8',
      ridgeStock: 'us-2x10',
      hipStock: 'us-2x10',
      sheathing: 'us-osb-7-16',
    },
  ],
};

function extension(
  id: string,
  type: string,
  params: Record<string, unknown>,
  expressions: Record<string, StoredExpression>,
  dependsOn: string[],
  operation: 'new' | null,
  scope?: string[],
): ExtensionFeature {
  return {
    id,
    kind: 'extension',
    name: id,
    suppressed: false,
    extension: type,
    schemaVersion: 1,
    dependsOn,
    references: [],
    expressions,
    params: params as ExtensionFeature['params'],
    ...(operation === null ? {} : { operation }),
    ...(scope === undefined ? {} : { scope }),
  };
}

type P = readonly [number, number];

function wall(
  id: string,
  wallType: 'ext-2x6' | 'int-2x4',
  a: P,
  b: P,
  dependsOn: string[],
): ExtensionFeature {
  return extension(
    id,
    'construction.wall',
    {
      level: 'level-1',
      wallType,
      points: 2,
      ...(wallType === 'int-2x4' ? { justification: 'center' } : {}),
    },
    { x1: ins(a[0]), y1: ins(a[1]), x2: ins(b[0]), y2: ins(b[1]) },
    dependsOn,
    'new',
  );
}

/** The exterior walls' layer bodies, as the wall feature names them (`<id>:layer/<layer id>`). */
function exteriorLayerBodies(wallId: string): string[] {
  const type = HOUSE_CONSTRUCTION.wallTypes.find((t) => t.id === 'ext-2x6')!;
  return type.layers.filter((l) => l.kind !== 'framing').map((l) => `${wallId}:layer/${l.id}`);
}

/**
 * An opening centred `position` inches from its host's start; a door when `sill` is 0. Scoped to
 * its host's layer bodies, as the app's Opening tool writes it (`openingScope`), so moving one
 * rebuilds only the openings after it in the same wall.
 */
function opening(
  id: string,
  host: string,
  position: number,
  width: number,
  height: number,
  sill: number,
): ExtensionFeature {
  const door = sill === 0;
  return extension(
    id,
    'construction.opening',
    { kind: door ? 'door' : 'window' },
    {
      position: ins(position),
      width: ins(width),
      height: ins(height),
      ...(door ? {} : { sill: ins(sill) }),
    },
    [host],
    null,
    exteriorLayerBodies(host),
  );
}

const L = HOUSE_LENGTH_IN;
const W = HOUSE_WIDTH_IN;
const MID = W / 2;

/** Feature ids, by role. */
export const HOUSE_IDS = {
  /** South, east, north, west. */
  exterior: ['extension#1', 'extension#2', 'extension#3', 'extension#4'],
  interior: [
    'extension#5',
    'extension#6',
    'extension#7',
    'extension#8',
    'extension#9',
    'extension#10',
    'extension#11',
  ],
  openings: [
    'extension#12',
    'extension#13',
    'extension#14',
    'extension#15',
    'extension#16',
    'extension#17',
    'extension#18',
    'extension#19',
    'extension#20',
    'extension#21',
  ],
  /** South and north spans. */
  floors: ['extension#22', 'extension#23'],
  roof: 'extension#24',
  /** The window the warm regens move (in the south wall, as the spike's `opening#2`). */
  moved: 'extension#13',
} as const;

const [S, E, N, Wst] = HOUSE_IDS.exterior;

/** A floor over the whole length, from y0 to y1 inches, its joists across that span. */
function floor(id: string, y0: number, y1: number): ExtensionFeature {
  const corners: P[] = [
    [0, y0],
    [L, y0],
    [L, y1],
    [0, y1],
  ];
  const exprs: Record<string, StoredExpression> = {};
  corners.forEach(([x, y], i) => {
    exprs[`x${i + 1}`] = ins(x);
    exprs[`y${i + 1}`] = ins(y);
  });
  return extension(
    id,
    'construction.floor',
    {
      level: 'level-1',
      floorType: 'house-floor',
      outline: 'points',
      points: 4,
      blocking: 'mid-span',
    },
    exprs,
    [],
    'new',
  );
}

/** The 24 features of the house, in order. */
export function houseFeatures(): ExtensionFeature[] {
  const [i1, i2, i3, i4, i5, i6, i7] = HOUSE_IDS.interior;
  return [
    wall(S, 'ext-2x6', [0, 0], [L, 0], []),
    wall(E, 'ext-2x6', [L, 0], [L, W], [S]),
    wall(N, 'ext-2x6', [L, W], [0, W], [E]),
    wall(Wst, 'ext-2x6', [0, W], [0, 0], [N, S]),
    // The bearing wall down the middle, from the west wall's path to the east wall's.
    wall(i1, 'int-2x4', [0, MID], [L, MID], [Wst, E]),
    // Partitions south of it, from the south wall to the middle wall's centre line.
    wall(i2, 'int-2x4', [156, 0], [156, MID], [S, i1]),
    wall(i3, 'int-2x4', [424, 0], [424, MID], [S, i1]),
    // North of it, from the north wall down to the middle wall.
    wall(i4, 'int-2x4', [200, W], [200, MID], [N, i1]),
    wall(i5, 'int-2x4', [360, W], [360, MID], [N, i1]),
    wall(i6, 'int-2x4', [480, W], [480, MID], [N, i1]),
    // A short one from the last partition to the east wall.
    wall(i7, 'int-2x4', [480, 360], [L, 360], [i6, E]),
    // South wall: a door between two 48" x 48" windows.
    opening(HOUSE_IDS.openings[0], S, 300, 36, 80, 0),
    opening(HOUSE_IDS.openings[1], S, 96, 48, 48, 34),
    opening(HOUSE_IDS.openings[2], S, 480, 48, 48, 34),
    // North wall (runs from x = 600 to 0): a door and three 36" x 36" windows.
    opening(HOUSE_IDS.openings[3], N, 180, 36, 80, 0),
    opening(HOUSE_IDS.openings[4], N, 60, 36, 36, 46),
    opening(HOUSE_IDS.openings[5], N, 320, 36, 36, 46),
    opening(HOUSE_IDS.openings[6], N, 500, 36, 36, 46),
    // West wall (runs from y = 480 to 0): two 60" x 48" windows.
    opening(HOUSE_IDS.openings[7], Wst, 120, 60, 48, 34),
    opening(HOUSE_IDS.openings[8], Wst, 340, 60, 48, 34),
    // East wall: one 72" x 48" window.
    opening(HOUSE_IDS.openings[9], E, 120, 72, 48, 34),
    floor(HOUSE_IDS.floors[0], 0, MID),
    floor(HOUSE_IDS.floors[1], MID, W),
    extension(
      HOUSE_IDS.roof,
      'construction.roof',
      {
        roofType: 'house-roof',
        kind: 'hip',
        ties: { kind: 'ceiling-joists', stock: 'us-2x6' },
      },
      { pitch: ins('6/12') },
      [...HOUSE_IDS.exterior],
      'new',
    ),
  ];
}

/** The moved window's position, as `houseFeatures` has it. */
export const MOVED_POSITION_IN = 96;

/**
 * The moved window (`HOUSE_IDS.moved`) at `position` inches along the south wall: the warm regen's
 * edit, as in the spike (12" one way, then back).
 */
export function movedWindow(position: number): ExtensionFeature {
  const f = houseFeatures().find((x) => x.id === HOUSE_IDS.moved)!;
  return { ...f, expressions: { ...f.expressions, position: ins(position) } };
}

/** The commands that build the house in part `partId` of an empty document, as one batch. */
export function houseCommands(partId: string): Command {
  return {
    type: 'batch',
    commands: [
      {
        type: 'setDomainData',
        namespace: 'construction',
        schemaVersion: 1,
        data: HOUSE_CONSTRUCTION,
      },
      ...houseFeatures().map((feature): Command => ({ type: 'addFeature', partId, feature })),
    ],
  };
}
