import { expect, type Page } from '@playwright/test';
import {
  checkSheetLayout,
  layoutSheets,
  type SheetInput,
  type SheetLayoutResult,
} from '@manufakture/nesting';
import { regenerated } from './bracket';
import { settle } from './helpers';
import { execute } from './m2-fixtures';

// The M4 acceptance model, a bookshelf (docs/m4-acceptance.md), its dimensions and the cut list
// and sheet layouts computed by hand, shared by the m4-*.spec.ts chapters.
//
// An inch document (`in-fraction` display, to 1/32"). World axes: the width W = #width runs
// along +X, the depth along +Y from the front (y = 0) to the back, the height along +Z from the
// floor. One part studio of twelve boards:
//
// - A face frame of 1x2 sticks (3/4" x 1-1/2" actual), in front of the carcass, y -3/4..0: two
//   stiles x 0..1-1/2 and W - 1-1/2..W, z 0..72, and two rails between them, x 1-1/2..W - 1-1/2,
//   at the bottom (z 0..1-1/2) and the top (z 70-1/2..72). All four are sticks along the lines
//   of one sketch on the front plane, turned 90 degrees about their lines so the thickness runs
//   front to back. Each rail is joined to each stile with pocket screws, pockets on its back
//   face.
// - Two sides of 3/4" plywood (23/32" actual, t), 11-1/4" deep (D) and 72" tall: the left one
//   x 0..t, the right one W - t..W. The right side is sketched on the right stile's outer face
//   (x = W), so it follows #width, and made on the opposite side of that sketch.
// - A bottom, a top and three shelves of 3/4" plywood between the sides, reaching 1/4" (d) into
//   each: x t - d..W - t + d, so W - 2t + 2d = W - 15/16 long, and D - b = 11-1/32 deep (in
//   front of the back). The bottom at z 0..t and the top at z 72 - t..72, each in a rabbet at
//   the sides' ends; the shelves at z 18, 36 and 54 (their undersides), each in a dado.
// - A back of 1/4" plywood (7/32" actual, b), y D - b..D, x t - d..W - t + d, the full 72" tall,
//   in a rabbet along each side's back edge: W - 15/16 wide.
//
// Each board's blank includes its joinery (domain-wood README, "The joint feature"): the panels
// overlap the sides by the depth of their dados and rabbets, and the joints cut the overlap.
//
// #width is 30" as modelled, and a configuration table makes it 24", 30" and 36".

export const INCH = 25.4;
export const inch = (x: number) => x * INCH;

/** Exact inch fractions, in inches. */
export const SHELF = {
  name: 'Bookshelf',
  /** The configuration table's widths; 30 is #width as modelled. */
  widths: [24, 30, 36] as const,
  modelled: 30,
  height: 72,
  /** The sides' depth. */
  depth: 11.25,
  /** 3/4" plywood, actual. */
  ply: 23 / 32,
  /** 1/4" plywood, actual. */
  back: 7 / 32,
  /** How far every panel reaches into the sides: the dados' and rabbets' depth. */
  dado: 1 / 4,
  /** The shelves' undersides. */
  shelves: [18, 36, 54] as const,
  /** 1x2, actual: thickness and width. */
  stick: { thickness: 3 / 4, width: 3 / 2 },
  /** A plywood measured thinner than sold, for the last chapter. */
  measured: 11 / 16,
  /** The sawing settings' default kerf (DEFAULT_WOOD_SETTINGS). */
  kerf: 1 / 8,
  sheet: { length: 96, width: 48 },
} as const;

/** The panels' length between the sides: W - 2t + 2d. */
export const panelLength = (w: number, t: number = SHELF.ply) => w - 2 * t + 2 * SHELF.dado;
/** The rails' length between the stiles. */
export const railLength = (w: number) => w - 2 * SHELF.stick.width;
/** The panels in front of the back. */
export const PANEL_DEPTH = SHELF.depth - SHELF.back;

const expr = (source: string) => ({ source, lengthUnit: 'in', angleUnit: 'deg' });

type V3 = [number, number, number];
const plane = (origin: V3, normal: V3, xDir: V3) =>
  ({ type: 'plane', origin: origin.map(inch), normal, xDir }) as const;

/** The front plane, y = 0, facing the viewer: sketch x is world X, sketch y is world Z. */
const FRONT = plane([0, 0, 0], [0, -1, 0], [1, 0, 0]);

// --- Sketches ------------------------------------------------------------------------------
//
// Entity and constraint ids are counted per part studio: lines e1..e4 (the face frame) and the
// rectangles' e5 upwards, constraints k1 upwards. Everything that moves with #width is fixed to
// the sketch origin by signed distances (as m2-fixtures.ts does), the rest is left as drawn.

const ORIGIN = { entity: '@origin' };

interface LineSpec {
  id: string;
  /** Start and end, drawn at #width = 30, inches. */
  start: [number, number];
  end: [number, number];
  /** Expressions for start x, start y, end x, end y (inches). */
  at: [string, string, string, string];
}

let constraintId = 0;
const nextK = () => `k${++constraintId}`;

function pointAt(entity: string, at: 'start' | 'end', x: string, y: string) {
  const p = { entity, at };
  return [
    { id: nextK(), kind: 'horizontalDistance', a: ORIGIN, b: p, value: expr(x) },
    { id: nextK(), kind: 'verticalDistance', a: ORIGIN, b: p, value: expr(y) },
  ];
}

function sketchFeature(
  id: string,
  name: string,
  p: unknown,
  entities: { id: string; start: [number, number]; end: [number, number] }[],
  constraints: unknown[],
) {
  return {
    id,
    kind: 'sketch',
    name,
    suppressed: false,
    plane: p,
    entities: entities.map((e) => ({
      id: e.id,
      kind: 'line',
      construction: false,
      start: e.start.map(inch),
      end: e.end.map(inch),
    })),
    constraints,
  };
}

/** Four fixed lines; each is a stick. */
function linesSketch(id: string, name: string, p: unknown, lines: LineSpec[]) {
  return sketchFeature(
    id,
    name,
    p,
    lines,
    lines.flatMap((l) => [
      ...pointAt(l.id, 'start', l.at[0], l.at[1]),
      ...pointAt(l.id, 'end', l.at[2], l.at[3]),
    ]),
  );
}

/**
 * A rectangle from (x0, y0), `w` by `h` (inches, drawn at #width = 30), its first corner and
 * size given by expressions when `exprs` is given (otherwise left as drawn).
 */
function rectangleSketch(
  id: string,
  name: string,
  p: unknown,
  first: number,
  at: { x0: number; y0: number; w: number; h: number },
  exprs?: { x0: string; y0: string; w: string; h: string },
) {
  const c: [number, number][] = [
    [at.x0, at.y0],
    [at.x0 + at.w, at.y0],
    [at.x0 + at.w, at.y0 + at.h],
    [at.x0, at.y0 + at.h],
  ];
  const ids = [0, 1, 2, 3].map((i) => `e${first + i}`);
  const lines = c.map((start, i) => ({ id: ids[i]!, start, end: c[(i + 1) % 4]! }));
  const constraints: unknown[] = [];
  if (exprs) {
    constraints.push(
      ...ids.map((e, i) => ({
        id: nextK(),
        kind: 'coincident',
        a: { entity: e, at: 'end' },
        b: { entity: ids[(i + 1) % 4], at: 'start' },
      })),
      { id: nextK(), kind: 'horizontal', line: ids[0] },
      { id: nextK(), kind: 'horizontal', line: ids[2] },
      { id: nextK(), kind: 'vertical', line: ids[1] },
      { id: nextK(), kind: 'vertical', line: ids[3] },
      ...pointAt(ids[0]!, 'start', exprs.x0, exprs.y0),
      {
        id: nextK(),
        kind: 'horizontalDistance',
        a: { entity: ids[0], at: 'start' },
        b: { entity: ids[0], at: 'end' },
        value: expr(exprs.w),
      },
      {
        id: nextK(),
        kind: 'verticalDistance',
        a: { entity: ids[1], at: 'start' },
        b: { entity: ids[1], at: 'end' },
        value: expr(exprs.h),
      },
    );
  }
  return sketchFeature(id, name, p, lines, constraints);
}

/** The face frame's sketch (sketch#1): its four lines, stiles e1 and e2, rails e3 and e4. */
export function frameSketch(): unknown {
  constraintId = 0;
  const { height: H, modelled: W } = SHELF;
  const s = SHELF.stick.width;
  return linesSketch('sketch#1', 'Face frame', FRONT, [
    { id: 'e1', start: [0, 0], end: [0, H], at: ['0 in', '0 in', '0 in', `${H} in`] },
    {
      id: 'e2',
      start: [W - s, 0],
      end: [W - s, H],
      at: [`#width - ${s} in`, '0 in', `#width - ${s} in`, `${H} in`],
    },
    {
      id: 'e3',
      start: [s, s],
      end: [W - s, s],
      at: [`${s} in`, `${s} in`, `#width - ${s} in`, `${s} in`],
    },
    {
      id: 'e4',
      start: [s, H],
      end: [W - s, H],
      at: [`${s} in`, `${H} in`, `#width - ${s} in`, `${H} in`],
    },
  ]);
}

/** The face the right side is sketched on: the right stile's outer face, x = W. */
export const RIGHT_STILE_OUTER = 'extension#2:side:w0';

/** The carcass's sketches (sketch#2 to sketch#9), after the face frame's boards. */
export function carcassSketches(): unknown[] {
  constraintId = 20;
  const { height: H, depth: D, ply: t, dado: d, modelled: W } = SHELF;
  const L = panelLength(W);
  const x0 = t - d;
  const across = { x0: `${x0} in`, w: `#width - ${2 * t - 2 * d} in` };
  const horizontal = (id: string, name: string, z: number, first: number, flipped = false) =>
    flipped
      ? // Seen from below (normal -z): sketch y is world -Y.
        rectangleSketch(
          id,
          name,
          plane([0, 0, z], [0, 0, -1], [1, 0, 0]),
          first,
          { x0, y0: -PANEL_DEPTH, w: L, h: PANEL_DEPTH },
          { ...across, y0: `${-PANEL_DEPTH} in`, h: `${PANEL_DEPTH} in` },
        )
      : rectangleSketch(
          id,
          name,
          plane([0, 0, z], [0, 0, 1], [1, 0, 0]),
          first,
          { x0, y0: 0, w: L, h: PANEL_DEPTH },
          { ...across, y0: '0 in', h: `${PANEL_DEPTH} in` },
        );
  return [
    // Sketch x is world Y, sketch y is world Z.
    rectangleSketch('sketch#2', 'Left side', plane([0, 0, 0], [1, 0, 0], [0, 1, 0]), 5, {
      x0: 0,
      y0: 0,
      w: D,
      h: H,
    }),
    // On the right stile's outer face: its sketch frame has x along world Y and y along world
    // Z (kernel `frameOnPlane`), the same numbers at any #width.
    rectangleSketch(
      'sketch#3',
      'Right side',
      { type: 'face', face: { id: 'r1', ref: { face: RIGHT_STILE_OUTER } } },
      9,
      { x0: 0, y0: 0, w: D, h: H },
    ),
    horizontal('sketch#4', 'Bottom', 0, 13),
    horizontal('sketch#5', 'Top', H, 17, true),
    ...SHELF.shelves.map((z, i) => horizontal(`sketch#${6 + i}`, `Shelf ${i + 1}`, z, 21 + 4 * i)),
    // Facing forward at y = D: the back is made towards the front, D - b..D.
    rectangleSketch(
      'sketch#9',
      'Back',
      plane([0, D, 0], [0, -1, 0], [1, 0, 0]),
      33,
      { x0, y0: 0, w: L, h: H },
      { ...across, y0: '0 in', h: `${H} in` },
    ),
  ].map((feature) => ({ type: 'addFeature', partId: 'part#1', feature }));
}

// --- Boards and joints -------------------------------------------------------------------------

export interface BoardSpec {
  id: string;
  name: string;
  sketch: string;
  stock: 'us-1x2' | 'us-ply-23-32' | 'us-ply-7-32';
  /** Sticks: the line; panels: absent. */
  line?: string;
  flip?: boolean;
}

/** The twelve boards in the order they are made (their feature ids). */
export const BOARDS: readonly BoardSpec[] = [
  { id: 'extension#1', name: 'Left stile', sketch: 'sketch#1', stock: 'us-1x2', line: 'e1' },
  { id: 'extension#2', name: 'Right stile', sketch: 'sketch#1', stock: 'us-1x2', line: 'e2' },
  { id: 'extension#3', name: 'Bottom rail', sketch: 'sketch#1', stock: 'us-1x2', line: 'e3' },
  { id: 'extension#4', name: 'Top rail', sketch: 'sketch#1', stock: 'us-1x2', line: 'e4' },
  { id: 'extension#5', name: 'Left side', sketch: 'sketch#2', stock: 'us-ply-23-32' },
  {
    id: 'extension#6',
    name: 'Right side',
    sketch: 'sketch#3',
    stock: 'us-ply-23-32',
    flip: true,
  },
  { id: 'extension#7', name: 'Bottom', sketch: 'sketch#4', stock: 'us-ply-23-32' },
  { id: 'extension#8', name: 'Top', sketch: 'sketch#5', stock: 'us-ply-23-32' },
  { id: 'extension#9', name: 'Shelf 1', sketch: 'sketch#6', stock: 'us-ply-23-32' },
  { id: 'extension#10', name: 'Shelf 2', sketch: 'sketch#7', stock: 'us-ply-23-32' },
  { id: 'extension#11', name: 'Shelf 3', sketch: 'sketch#8', stock: 'us-ply-23-32' },
  { id: 'extension#12', name: 'Back', sketch: 'sketch#9', stock: 'us-ply-7-32' },
];

export const board = (name: string) => BOARDS.find((b) => b.name === name)!;

/** A stick's placement: turned a quarter about its line, on the positive side of both axes. */
export const STICK_SETTINGS = {
  rotation: '90',
  justify: { thickness: 'positive', width: 'positive' },
} as const;

export interface JointSpec {
  id: string;
  kind: 'dado' | 'rabbet' | 'pocket-screw';
  /** Receives (the side, the stile). */
  a: string;
  /** Enters, or carries the pockets. */
  b: string;
}

const L = 'extension#5';
const R = 'extension#6';

/** The sixteen joints in the order they are made, after the boards. */
export const JOINTS: readonly JointSpec[] = [
  ...(['extension#7', 'extension#8'] as const).flatMap((b) => [
    { kind: 'rabbet' as const, a: L, b },
    { kind: 'rabbet' as const, a: R, b },
  ]),
  ...(['extension#9', 'extension#10', 'extension#11'] as const).flatMap((b) => [
    { kind: 'dado' as const, a: L, b },
    { kind: 'dado' as const, a: R, b },
  ]),
  { kind: 'rabbet' as const, a: L, b: 'extension#12' },
  { kind: 'rabbet' as const, a: R, b: 'extension#12' },
  ...(['extension#3', 'extension#4'] as const).flatMap((b) => [
    { kind: 'pocket-screw' as const, a: 'extension#1', b },
    { kind: 'pocket-screw' as const, a: 'extension#2', b },
  ]),
].map((j, i) => ({ ...j, id: `extension#${13 + i}` }));

/** A board feature as the Board dialog makes it. */
export function boardFeature(spec: BoardSpec): unknown {
  const params: Record<string, unknown> =
    spec.line !== undefined
      ? {
          form: 'stick',
          stock: spec.stock,
          sketch: spec.sketch,
          line: spec.line,
          justify: STICK_SETTINGS.justify,
        }
      : {
          form: 'panel',
          stock: spec.stock,
          sketch: spec.sketch,
          ...(spec.flip ? { flip: true } : {}),
        };
  return {
    id: spec.id,
    kind: 'extension',
    name: spec.name,
    suppressed: false,
    extension: 'wood.board',
    schemaVersion: 1,
    operation: 'new',
    dependsOn: [spec.sketch],
    references: [],
    expressions:
      spec.line !== undefined
        ? { rotation: { source: STICK_SETTINGS.rotation, lengthUnit: 'in', angleUnit: 'deg' } }
        : {},
    params,
  };
}

/** What the Joint dialog names each kind. */
export const JOINT_NAMES = {
  rabbet: 'Rabbet',
  dado: 'Dado',
  'pocket-screw': 'Pocket screws',
} as const;

/** A joint feature as the Joint dialog makes it. */
export function jointFeature(spec: JointSpec): unknown {
  return {
    id: spec.id,
    kind: 'extension',
    name: `${JOINT_NAMES[spec.kind]} ${spec.id.slice('extension#'.length)}`,
    suppressed: false,
    extension: 'wood.joint',
    schemaVersion: 1,
    dependsOn: [spec.a, spec.b],
    scope: [spec.a, spec.b],
    references: [],
    expressions: {},
    params: { kind: spec.kind, a: spec.a, b: spec.b },
  };
}

export const INCH_UNITS = {
  type: 'setDisplayUnits',
  units: { length: { unit: 'in-fraction', denominator: 32 }, angle: { unit: 'deg' } },
};

/** The boards' names, as the feature tree's Rename (F2) sets them; the cut list lists them. */
export function boardNames(): unknown[] {
  return BOARDS.map((b) => ({
    type: 'renameFeature',
    partId: 'part#1',
    featureId: b.id,
    name: b.name,
  }));
}

export const ASSEMBLY = 'assembly#1';
const IDENTITY = { translation: [0, 0, 0], rotation: [0, 0, 0, 1] };

/** The bookshelf assembled per board (M4 plan decision 5): one instance per board, fixed. */
export function assemblyCommands(): unknown[] {
  return [
    { type: 'addAssembly', assemblyId: ASSEMBLY, name: 'Bookshelf' },
    ...BOARDS.map((b, i) => ({
      type: 'addInstance',
      assemblyId: ASSEMBLY,
      instance: {
        id: `inst#${i + 1}`,
        name: b.name,
        source: { part: 'part#1' },
        bodies: [b.id],
        fixed: true,
        suppressed: false,
        pose: IDENTITY,
      },
    })),
  ];
}

/** The instance showing a board. */
export const instanceOf = (name: string) => `inst#${BOARDS.findIndex((b) => b.name === name) + 1}`;

/**
 * The exploded view the walkthrough makes in the Explode panel, as one command: the top up, the
 * back out behind, the face frame forward and the sides apart, each 12".
 */
export function explodeCommand(): unknown {
  const steps: [string[], [number, number, number]][] = [
    [['Top'], [0, 0, 1]],
    [['Back'], [0, 1, 0]],
    [
      ['Left stile', 'Right stile', 'Bottom rail', 'Top rail'],
      [0, -1, 0],
    ],
    [['Left side'], [-1, 0, 0]],
    [['Right side'], [1, 0, 0]],
  ];
  return {
    type: 'addExplodedView',
    assemblyId: ASSEMBLY,
    explodedView: {
      id: 'explode#1',
      name: 'Exploded view 1',
      steps: steps.map(([names, vector], i) => ({
        id: `step#${i + 1}`,
        instances: names.map(instanceOf),
        direction: { vector },
        distance: expr('12 in'),
      })),
    },
  };
}

/** The configuration table: #width at 24", 30" and 36". */
export function configurationCommands(): unknown[] {
  return [
    {
      type: 'setConfigParameter',
      parameter: { id: 'cp#1', name: '#width', kind: 'variable', variable: 'width' },
    },
    ...SHELF.widths.map((w, i) => ({
      type: 'setConfigRow',
      row: { id: `cfg#${i + 1}`, name: `${w} in`, values: { 'cp#1': expr(`${w} in`) } },
    })),
  ];
}

/**
 * The whole bookshelf part studio with commands: what the walkthrough (m4-bookshelf.spec.ts)
 * makes through the dialogs. For the views and anything that only needs the finished model.
 */
export async function buildBookshelf(page: Page): Promise<void> {
  await execute(
    page,
    {
      type: 'batch',
      commands: [
        INCH_UNITS,
        { type: 'renameDocument', name: SHELF.name },
        { type: 'renamePart', partId: 'part#1', name: 'Carcass' },
        { type: 'setVariable', name: 'width', expression: expr(`${SHELF.modelled} in`) },
        { type: 'addFeature', partId: 'part#1', feature: frameSketch() },
        ...BOARDS.slice(0, 4).map((b) => ({
          type: 'addFeature',
          partId: 'part#1',
          feature: boardFeature(b),
        })),
        ...carcassSketches(),
        ...BOARDS.slice(4).map((b) => ({
          type: 'addFeature',
          partId: 'part#1',
          feature: boardFeature(b),
        })),
        ...JOINTS.map((j) => ({ type: 'addFeature', partId: 'part#1', feature: jointFeature(j) })),
        ...boardNames(),
        ...configurationCommands(),
      ],
    },
    'Make the bookshelf',
  );
  const results = await regenerated(page);
  for (const [id, r] of Object.entries(results)) {
    expect(r, id).toMatchObject({ status: 'ok', errors: [] });
  }
  await settle(page);
}

// --- The cut list, by hand ------------------------------------------------------------------

export interface HandRow {
  item: string;
  /** Length along the grain x width x thickness, as the panel shows it. */
  size: string;
  quantity: number;
  total: string;
}

/** Inches as the app writes them at 1/32": whole, then a reduced fraction. */
export function fraction(x: number): string {
  const n = Math.round(x * 32);
  const whole = Math.floor(n / 32);
  let num = n - whole * 32;
  let den = 32;
  while (num > 0 && num % 2 === 0) {
    num /= 2;
    den /= 2;
  }
  if (num === 0) return `${whole}"`;
  return whole === 0 ? `${num}/${den}"` : `${whole}-${num}/${den}"`;
}

/** Square feet of `n` parts `l` by `w` inches. */
export const sqft = (n: number, l: number, w: number) => (n * l * w) / 144;
/** Board feet of `n` 1x2 pieces `l` inches long, at nominal 1" x 2". */
export const boardFeet1x2 = (n: number, l: number) => (n * 1 * 2 * l) / 144;

/**
 * The part studio's cut list at width `w` (and plywood `t` thick), as the Cut list panel lists
 * it: each row's item, blank size, quantity and total.
 */
export function handCutList(w: number, t: number = SHELF.ply) {
  const { height: H, depth: D, back: b } = SHELF;
  const L = panelLength(w);
  const rail = railLength(w);
  // Sheets, then lumber; each in catalog order (1/4" plywood before 3/4"), then thickest,
  // longest, widest first (domain-wood README, "Order and totals").
  const rows: HandRow[] = [
    {
      item: 'Back',
      size: `${fraction(H)} x ${fraction(L)} x ${fraction(b)}`,
      quantity: 1,
      total: `${sqft(1, H, L).toFixed(2)} sq ft`,
    },
    {
      item: 'Left side, Right side',
      size: `${fraction(H)} x ${fraction(D)} x ${fraction(t)}`,
      quantity: 2,
      total: `${sqft(2, H, D).toFixed(2)} sq ft`,
    },
    {
      item: 'Bottom, Top, Shelf 1-3',
      size: `${fraction(L)} x ${fraction(PANEL_DEPTH)} x ${fraction(t)}`,
      quantity: 5,
      total: `${sqft(5, L, PANEL_DEPTH).toFixed(2)} sq ft`,
    },
    {
      item: 'Left stile, Right stile',
      size: `${fraction(H)} x ${fraction(SHELF.stick.width)} x ${fraction(SHELF.stick.thickness)}`,
      quantity: 2,
      total: `${boardFeet1x2(2, H).toFixed(2)} bd ft`,
    },
    {
      item: 'Bottom rail, Top rail',
      size: `${fraction(rail)} x ${fraction(SHELF.stick.width)} x ${fraction(SHELF.stick.thickness)}`,
      quantity: 2,
      total: `${boardFeet1x2(2, rail).toFixed(2)} bd ft`,
    },
  ];
  return {
    rows,
    boardFeet: boardFeet1x2(2, H) + boardFeet1x2(2, rail),
    plywood34: sqft(2, H, D) + sqft(5, L, PANEL_DEPTH),
    plywood14: sqft(1, H, L),
    /** Four pocket screws: one per rail end (a 1-1/2" row with 3/4" from each end). */
    screws: 4,
    /** The chart's screw for 3/4" stock. */
    screw: 1.25,
  };
}

/** The sheet layout input by hand, in millimetres (the app nests in mm): grain-locked parts. */
export function handSheetInput(w: number, stock: '3/4' | '1/4'): SheetInput {
  const L = panelLength(w);
  const parts =
    stock === '3/4'
      ? [
          { id: 'side', length: inch(SHELF.height), width: inch(SHELF.depth), quantity: 2 },
          { id: 'panel', length: inch(L), width: inch(PANEL_DEPTH), quantity: 5 },
        ]
      : [{ id: 'back', length: inch(SHELF.height), width: inch(L), quantity: 1 }];
  return {
    parts: parts.map((p) => ({ ...p, grainLocked: true })),
    stock: [
      {
        id: stock,
        length: inch(SHELF.sheet.length),
        width: inch(SHELF.sheet.width),
        grain: 'length',
      },
    ],
    settings: { kerf: inch(SHELF.kerf) },
  };
}

/**
 * The sheets the hand calculation needs (docs/m4-acceptance.md, "Sheet layout"): 3/4" plywood
 * takes one sheet at 24" and 30" and two at 36"; the back always one.
 */
export const HAND_SHEETS: Record<number, { ply34: number; ply14: number }> = {
  24: { ply34: 1, ply14: 1 },
  30: { ply34: 1, ply14: 1 },
  36: { ply34: 2, ply14: 1 },
};

/** The T4.3c packer and checker on the hand input: the layout and its problems (none). */
export function checkedLayout(input: SheetInput): {
  result: SheetLayoutResult;
  problems: string[];
} {
  const result = layoutSheets(input);
  return { result, problems: checkSheetLayout(input, result) };
}

/** A rectangle on a drawn sheet, mm, x along the sheet's length, y across it. */
export interface DrawnPart {
  x: number;
  y: number;
  sizeX: number;
  sizeY: number;
}

/** Every drawn sheet of a stock in the Layouts tab: its size and its parts, mm. */
export async function drawnSheets(
  page: Page,
  stock: string,
): Promise<{ length: number; width: number; parts: DrawnPart[] }[]> {
  return page.evaluate((s) => {
    const section = document.querySelector(`[data-testid="cutlist-sheets-${s}"]`);
    if (!section) return [];
    return [...section.querySelectorAll('[data-testid="cutlist-sheet"] svg')].map((svg) => {
      const [, , length, width] = svg.getAttribute('viewBox')!.split(' ').map(Number) as [
        number,
        number,
        number,
        number,
      ];
      const parts = [...svg.querySelectorAll('g[data-part] > rect')].map((r) => {
        const sizeY = Number(r.getAttribute('height'));
        return {
          x: Number(r.getAttribute('x')),
          // The drawing flips y (SheetView): back to the layout's own coordinates.
          y: width - Number(r.getAttribute('y')) - sizeY,
          sizeX: Number(r.getAttribute('width')),
          sizeY,
        };
      });
      return { length, width, parts };
    });
  }, stock);
}

/**
 * Problems with drawn parts on a sheet, checked on their own: each inside the sheet, and every
 * two at least a kerf apart along one axis (so they do not overlap, kerf included).
 */
export function kerfProblems(
  sheet: { length: number; width: number; parts: DrawnPart[] },
  kerf: number,
): string[] {
  const eps = 1e-6;
  const out: string[] = [];
  sheet.parts.forEach((p, i) => {
    if (p.x < -eps || p.y < -eps || p.x + p.sizeX > sheet.length + eps) {
      out.push(`part ${i} leaves the sheet`);
    }
    if (p.y + p.sizeY > sheet.width + eps) out.push(`part ${i} leaves the sheet`);
    sheet.parts.slice(i + 1).forEach((q, j) => {
      const apartX = q.x >= p.x + p.sizeX + kerf - eps || p.x >= q.x + q.sizeX + kerf - eps;
      const apartY = q.y >= p.y + p.sizeY + kerf - eps || p.y >= q.y + q.sizeY + kerf - eps;
      if (!apartX && !apartY) out.push(`parts ${i} and ${i + 1 + j} are closer than the kerf`);
    });
  });
  return out;
}

/** Placements of a T4.3c layout in the same shape, sorted, for comparing with drawn ones. */
export function layoutParts(result: SheetLayoutResult): DrawnPart[][] {
  return result.sheets.map((s) =>
    sortParts(s.placements.map((p) => ({ x: p.x, y: p.y, sizeX: p.sizeX, sizeY: p.sizeY }))),
  );
}

export function sortParts(parts: DrawnPart[]): DrawnPart[] {
  return [...parts].sort((a, b) => a.x - b.x || a.y - b.y);
}

// --- Volumes, by hand --------------------------------------------------------------------------

const CUBIC_INCH = INCH ** 3;

/**
 * The boards' exact volumes after the joints, mm3, with the plywood `t` thick and #width `w`.
 * Every panel reaches 15/32" in from a side's outside face (its sketch), so a side `t` thick is
 * cut `t - 15/32` deep (1/4" at 23/32"). A side loses, through its whole depth D, a rabbet `t`
 * wide at each end and a dado `t` wide for each shelf (five grooves, each that deep by t by D),
 * and a rabbet b wide along its back edge, H long; where the back's rabbet crosses the five
 * grooves it is counted twice, so five blocks (that deep by b by t) are added back. The shelves,
 * the top, the bottom, the back and the stiles lose nothing (a dado or rabbet cuts only A, and
 * pocket screws only B); the rails lose their pockets, not computed here.
 */
export function handVolumes(w: number, t: number = SHELF.ply): Record<string, number> {
  const { height: H, depth: D, back: b } = SHELF;
  const depth = t - (SHELF.ply - SHELF.dado);
  const side = t * D * H - 5 * depth * t * D - depth * b * H + 5 * depth * b * t;
  const L = panelLength(w);
  const panel = L * PANEL_DEPTH * t;
  const stile = SHELF.height * SHELF.stick.width * SHELF.stick.thickness;
  const out: Record<string, number> = {
    'extension#1': stile,
    'extension#2': stile,
    'extension#5': side,
    'extension#6': side,
    'extension#7': panel,
    'extension#8': panel,
    'extension#9': panel,
    'extension#10': panel,
    'extension#11': panel,
    'extension#12': H * L * b,
  };
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v * CUBIC_INCH]));
}

/** A rail's blank before its two pockets, mm3. */
export const railBlank = (w: number) =>
  railLength(w) * SHELF.stick.width * SHELF.stick.thickness * CUBIC_INCH;
