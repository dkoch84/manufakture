import {
  HOUSE_IDS,
  MOVED_POSITION_IN,
  houseCommands,
  movedWindow,
} from '@manufakture/domain-construction/fixtures/house';
import type { Page } from '@playwright/test';

// M6 fixtures for the e2e specs: the T6.5d house (packages/domain-construction/src/fixtures/
// house.ts, the same document the Node bench and the domain's tests build), as document commands
// for the app's store, and what it should show.

export { HOUSE_IDS, MOVED_POSITION_IN };

/** What the house builds (the domain's `src/fixtures/house.test.ts` checks the same in Node). */
export const HOUSE = {
  members: 794,
  /** A member group per wall (with its openings), per floor and for the roof. */
  groups: 14,
  /** Two layers per wall (11 walls), a subfloor per floor (2), four roof planes. */
  bodies: 28,
  features: 24,
} as const;

/**
 * Every layer id of the house's bodies (`<feature id>:layer/<layer id>`): hiding them all leaves
 * the framing alone in the view.
 */
export const HOUSE_LAYERS = [
  'sheathing',
  'drywall',
  'drywall-a',
  'drywall-b',
  'subfloor',
  'sheathing-e1',
  'sheathing-e2',
  'sheathing-e3',
  'sheathing-e4',
];

/** The batch that builds the house in the active part (one undo step). */
export async function houseBatch(page: Page): Promise<unknown> {
  const partId = await page.evaluate(() => window.__manufakture!.document.getState().activePartId);
  return houseCommands(partId);
}

/** The edit that moves the house's south-wall window to `position` inches. */
export async function moveWindow(page: Page, position: number): Promise<unknown> {
  const partId = await page.evaluate(() => window.__manufakture!.document.getState().activePartId);
  return { type: 'editFeature', partId, feature: movedWindow(position) };
}

// The M6 acceptance shed (m6-shed.spec.ts, docs/m6-acceptance.md) --------------------------------
//
// Everything below is the hand calculation of docs/m6-acceptance/hand-calculation.md, worked out
// from the generators' documented defaults (packages/domain-construction/README.md, ADR 0015) and
// not read back from the app. Lengths in inches.

/** Feature ids in the order the spec adds them through the UI. */
export const SHED_IDS = {
  wall: 'extension#1',
  door: 'extension#2',
  windows: ['extension#3', 'extension#4'],
  floor: 'extension#5',
  roof: 'extension#6',
} as const;

/** Feet and inches to a sixteenth, as the shed's document shows lengths. */
export const FT_IN_UNITS = {
  type: 'setDisplayUnits',
  units: { length: { unit: 'ft-in', denominator: 16 }, angle: { unit: 'deg' } },
};

/** Fixed prices for the cost check (T6.3a's), as stock overrides in one step. */
export const SHED_PRICES = {
  type: 'setDomainData',
  namespace: 'stock',
  schemaVersion: 1,
  data: {
    overrides: Object.fromEntries(
      (
        [
          ['us-2x4-precut-92-5-8', 4.5, 'piece'],
          ['us-2x4', 0.75, 'foot'],
          ['us-2x6', 1.1, 'foot'],
          ['us-2x8', 1.5, 'foot'],
          ['us-4x6', 2.5, 'foot'],
          ['us-osb-7-16', 16, 'sheet'],
          ['us-osb-23-32', 38, 'sheet'],
        ] as const
      ).map(([id, amount, per]) => [id, { price: { amount, per, currency: 'USD' } }]),
    ),
  },
};

/** The rafter ties' length: 24" above the plates, to where their underside meets the roof. */
const TIE = 144 - 2 * ((24 - (5.5 / Math.cos(Math.atan(0.5)) - 3.5 * 0.5)) / 0.5);
/** A common or fly rafter's blank: (run 71-1/4" + overhang 12" + 5-1/2" x sin) / cos. */
const RAFTER = (71.25 + 12 + 5.5 * Math.sin(Math.atan(0.5))) / Math.cos(Math.atan(0.5));

/** Members by role in each member group, studs at 16". */
export const SHED_ROLES = {
  wall: {
    stud: 39,
    corner: 4,
    'bottom-plate': 5,
    'top-plate': 8,
    king: 6,
    jack: 6,
    header: 6,
    'rough-sill': 2,
    cripple: 8,
  },
  door: 8,
  window: 10,
  floor: { joist: 13, rim: 2, skid: 3 },
  roof: { 'common-rafter': 26, 'fly-rafter': 4, ridge: 2, 'rafter-tie': 6, 'gable-stud': 16 },
} as const;

/** The same at 24": the walls' studs and cripples, and the gable studs, change. */
export const SHED_ROLES_24 = {
  wall: { ...SHED_ROLES.wall, stud: 28, cripple: 5 },
  door: 7,
  window: 9,
  floor: SHED_ROLES.floor,
  roof: { ...SHED_ROLES.roof, 'gable-stud': 10 },
} as const;

/** A row of the takeoff's "As framed" section: the roles it names, its stock, blank length and count. */
export interface FramedRow {
  roles: string[];
  stock: string;
  length: number;
  qty: number;
}

const row = (stock: string, length: number, qty: number, ...roles: string[]): FramedRow => ({
  roles,
  stock,
  length,
  qty,
});

/** Every member by stock and blank length, as framed, studs at 16" (hand table 1). */
export const SHED_FRAMED: FramedRow[] = [
  row('2x4', 188.5, 6, 'Bottom plate', 'Top plate'),
  row('2x4', 140.5, 5, 'Bottom plate', 'Top plate'),
  row('2x4', 92.625, 49, 'Corner stud', 'King stud', 'Stud'),
  row('2x4', 78.5, 6, 'Jack stud'),
  row('2x4', TIE, 6, 'Rafter tie'),
  row('2x4', 54, 1, 'Bottom plate'),
  row('2x4', 50.5, 1, 'Bottom plate'),
  row('2x4', 41, 2, 'Cripple'),
  row('2x4', 32.375, 2, 'Gable stud'),
  row('2x4', 28.875, 2, 'Gable stud'),
  row('2x4', 24.375, 2, 'Gable stud'),
  row('2x4', 24, 2, 'Rough sill'),
  row('2x4', 20.875, 2, 'Gable stud'),
  row('2x4', 16.375, 2, 'Gable stud'),
  row('2x4', 12.875, 2, 'Gable stud'),
  row('2x4', 8.625, 6, 'Cripple'),
  row('2x4', 8.375, 2, 'Gable stud'),
  row('2x4', 4.875, 2, 'Gable stud'),
  row('2x6', 192, 2, 'Rim joist'),
  row('2x6', 141, 13, 'Joist'),
  row('2x6', RAFTER, 30, 'Common rafter', 'Fly rafter'),
  row('2x6', 39, 2, 'Header'),
  row('2x6', 27, 4, 'Header'),
  row('2x8', 188, 1, 'Ridge board'),
  row('2x8', 28, 1, 'Ridge board'),
  row('4x6', 192, 3, 'Skid'),
];

/** The rows of hand table 1 that change with the walls at 24" (hand table 2); the rest stay. */
export const SHED_FRAMED_24: FramedRow[] = [
  row('2x4', 92.625, 38, 'Corner stud', 'King stud', 'Stud'),
  row('2x4', 41, 2, 'Cripple'),
  row('2x4', 32.875, 2, 'Gable stud'),
  row('2x4', 24.375, 2, 'Gable stud'),
  row('2x4', 20.875, 2, 'Gable stud'),
  row('2x4', 12.375, 2, 'Gable stud'),
  row('2x4', 8.875, 2, 'Gable stud'),
  row('2x4', 8.625, 3, 'Cripple'),
];

/** The roles whose rows hand table 2 replaces. */
export const STUD_ROLES = ['Stud', 'Corner stud', 'King stud', 'Cripple', 'Gable stud'];

/** Plates in all: 6 x 188-1/2" + 5 x 140-1/2" + 54" + 50-1/2" = 1938". */
export const SHED_PLATES = { pieces: 13, length: 1938 };

/** Precut studs to buy: studs, kings and corner studs of 92-5/8", not packed. */
export const SHED_PRECUT = `2x4 precut stud 92-5/8" 7' 8-5/8": 49`;

/**
 * The least lumber that holds every member cut from sticks (hand table 3), per stock: the members
 * cut and the fewest feet of sticks (8' to 16'), each proven a lower bound. The takeoff's 1D
 * packer is a heuristic ("good, not optimal"), so the spec asks for at least this and at most one
 * 16' stick more.
 */
export const SHED_LUMBER_MIN = [
  { stock: '2x4', members: 51, length: 3282.3305, feet: 278 },
  { stock: '2x6', members: 51, length: 5277.79, feet: 444 },
  { stock: '2x8', members: 2, length: 216, feet: 24 },
  { stock: '4x6', members: 3, length: 576, feet: 48 },
];

/** The least sheets per stock (hand table 3), the faces they cover and the area laid, sq in. */
export const SHED_SHEETS_MIN = [
  { stock: '7/16" OSB', faces: 8, sheets: 25, whole: 18, area: 65844 + 2 * 20285.61 },
  { stock: '3/4" OSB', faces: 1, sheets: 6, whole: 6, area: 192 * 144 },
];

/** The fixed prices, by the takeoff's stock names: per foot for lumber, per sheet or piece. */
export const SHED_UNIT_PRICES: Record<string, number> = {
  '2x4 precut stud 92-5/8"': 4.5,
  '2x4': 0.75,
  '2x6': 1.1,
  '2x8': 1.5,
  '4x6': 2.5,
  '7/16" OSB': 16,
  '3/4" OSB': 38,
};

/** The cost of the hand calculation's least quantities at the fixed prices. */
export const SHED_COST_MIN = 1701.4;

/** Precut studs at 24": 28 studs, 6 kings, 4 corners. */
export const SHED_PRECUT_24 = `2x4 precut stud 92-5/8" 7' 8-5/8": 38`;

/** Sheet layers as laid: pieces and area, by layer. */
export const SHED_FACES = [
  `Roof sheathing 7/16" OSB: 12 pieces, 281.74 sq ft`,
  `Wall sheathing 7/16" OSB: 34 pieces, 457.25 sq ft`,
  `Subfloor 3/4" OSB: 6 pieces, 192.00 sq ft`,
];
