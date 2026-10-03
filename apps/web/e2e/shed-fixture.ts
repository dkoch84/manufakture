// The 12' x 16' shed of T6.3a, built in a feet-and-inches document, for the M6 e2e specs that
// need it whole (M6 T6.4b's drawing set): the same batch as construction-takeoff.spec.ts. A floor
// on three 4x6 skids under 23/32" OSB, four 2x4 walls with 7/16" OSB sheathing (the 16' walls run
// through the corners, the 12' walls butt between them; the path on the framing's outside face),
// two 2' x 3' windows centred 4' and 12' along the front wall, a 3' x 6' 8" door centred 6' along
// the right wall, a 6/12 gable roof with 12" overhangs and rafter ties on every other pair.

/** Feet and inches to a sixteenth, as the shed's document shows lengths. */
export const FT_IN_UNITS = {
  type: 'setDisplayUnits',
  units: { length: { unit: 'ft-in', denominator: 16 }, angle: { unit: 'deg' } },
};

const IN = (v: number | string) => ({ source: String(v), lengthUnit: 'in', angleUnit: 'deg' });
const PART = 'part#1';
const OSB = 'us-osb-7-16';

export const CONSTRUCTION = {
  levels: [{ id: 'level-1', name: 'Level 1', elevation: IN(0), height: IN(97.125) }],
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
  floorTypes: [
    { id: 'shed-floor', name: 'Shed floor', joistStock: 'us-2x6', subfloor: 'us-osb-23-32' },
  ],
  roofTypes: [
    {
      id: 'shed-roof',
      name: 'Shed roof',
      rafterStock: 'us-2x6',
      ridgeStock: 'us-2x8',
      sheathing: OSB,
      overhang: IN(12),
      rakeOverhang: IN(12),
    },
  ],
};

const PRICES = {
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

function ext(
  id: string,
  name: string,
  extension: string,
  params: Record<string, unknown>,
  expressions: Record<string, unknown>,
  dependsOn: string[] = [],
  operation: 'new' | null = 'new',
) {
  return {
    type: 'addFeature',
    partId: PART,
    feature: {
      id,
      kind: 'extension',
      name,
      suppressed: false,
      extension,
      schemaVersion: 1,
      dependsOn,
      references: [],
      expressions,
      params,
      ...(operation ? { operation } : {}),
    },
  };
}

const wall = (id: string, name: string, a: [number, number], b: [number, number]) =>
  ext(
    id,
    name,
    'construction.wall',
    { level: 'level-1', wallType: 'ext-2x4', points: 2 },
    { x1: IN(a[0]), y1: IN(a[1]), x2: IN(b[0]), y2: IN(b[1]) },
  );

// Counter-clockwise, the exterior to the right, the path on the framing's outside face. The 16'
// walls come first, so they run through the corners and the 12' walls butt between them.
export const WALLS = ['extension#1', 'extension#2', 'extension#3', 'extension#4'];
const opening = (
  id: string,
  name: string,
  host: string,
  kind: 'door' | 'window',
  at: Record<string, unknown>,
) =>
  ext(
    id,
    name,
    'construction.opening',
    { kind, segment: 1, from: 'start', header: { kind: 'auto' } },
    at,
    [host],
    null,
  );

export const SHED = {
  type: 'batch',
  commands: [
    { type: 'setDomainData', namespace: 'construction', schemaVersion: 1, data: CONSTRUCTION },
    { type: 'setDomainData', namespace: 'stock', schemaVersion: 1, data: PRICES },
    wall('extension#1', 'Front', [0, 0], [192, 0]),
    wall('extension#2', 'Back', [192, 144], [0, 144]),
    wall('extension#3', 'Right', [192, 0], [192, 144]),
    wall('extension#4', 'Left', [0, 144], [0, 0]),
    opening('extension#5', 'Window 1', 'extension#1', 'window', {
      position: IN(48),
      width: IN(24),
      height: IN(36),
      sill: IN(44),
    }),
    opening('extension#6', 'Window 2', 'extension#1', 'window', {
      position: IN(144),
      width: IN(24),
      height: IN(36),
      sill: IN(44),
    }),
    opening('extension#7', 'Door', 'extension#3', 'door', {
      position: IN(72),
      width: IN(36),
      height: IN(80),
    }),
    ext(
      'extension#8',
      'Floor',
      'construction.floor',
      {
        level: 'level-1',
        floorType: 'shed-floor',
        outline: 'walls',
        skids: { stock: 'us-4x6', count: 3 },
      },
      {},
      WALLS,
    ),
    ext(
      'extension#9',
      'Roof',
      'construction.roof',
      {
        roofType: 'shed-roof',
        kind: 'gable',
        ties: { kind: 'rafter-ties', stock: 'us-2x4', every: 2 },
      },
      { pitch: IN('6/12'), tieHeight: IN(24) },
      WALLS,
    ),
  ],
};
