// The fit-test coupon template (plan M3, T3.2g): a new document that measures which clearance
// gives a press, slip and sliding fit on the user's printer. Two bodies in one part studio:
//
// - the hole plate, 120 x 20 x 6 mm, with a row of eleven through holes of diameter
//   #peg_d + 0.00 mm, + 0.05 mm, ... + 0.50 mm (hole 1 to hole 11, left to right), and a small
//   marker hole next to hole 1 so the row can be read without labels;
// - the peg plate, 50 x 15 x 3 mm, with three pegs of diameter #peg_d standing 10 mm on it.
//
// Each hole's feature name says its clearance ("Hole 4: +0.15 mm"). Debossed numbers come with
// the text tool (T3.2d); until then the marker and the names stand in for labels. The document
// also holds a print setup for the Bambu Lab X1 Carbon with a 0.4 mm nozzle, the printer this
// milestone targets, so the print workspace and Insert fit variables read it. The procedure is in
// docs/user/fits.md and in `COUPON_PROCEDURE`.

import {
  applyCommand,
  createDocument,
  type Command,
  type Feature,
  type HoleFeature,
  type ManufaktureDocument,
  type SketchConstraint,
  type SketchEntity,
  type SketchFeature,
  type StoredExpression,
} from '@manufakture/core';
import { COUPON_CLEARANCES, FIT_DESCRIPTIONS, FIT_KINDS } from '@manufakture/print';

export const COUPON_NAME = 'Fit-test coupon';
export const COUPON_PART_NAME = 'Coupon';
/** The printer and nozzle of the coupon's print setup. */
export const COUPON_PRINTER = 'bambu-x1c';
export const COUPON_NOZZLE = 0.4;
/** The peg's nominal diameter, mm (the variable #peg_d). */
export const COUPON_PEG_DIAMETER = 6;

const PART = 'part#1';
const HOLE_PLATE = { length: 120, width: 20, thickness: 6 };
const PEG_PLATE = { y: 30, length: 50, width: 15, thickness: 3 };
const PEG_HEIGHT = 10;
const PEG_XS = [10, 25, 40];
const HOLE_PITCH = 10;
const MARKER = { at: [3.5, 16.5] as [number, number], diameter: 2 };

const mm = (source: string): StoredExpression => ({ source, lengthUnit: 'mm', angleUnit: 'deg' });
const plane = (z: number) =>
  ({ type: 'plane', origin: [0, 0, z], normal: [0, 0, 1], xDir: [1, 0, 0] }) as const;

/** Running entity and constraint ids: both counters are per part. */
function counters() {
  let e = 0;
  let k = 0;
  return { e: () => `e${++e}`, k: () => `k${++k}` };
}

function rectangle(
  id: string,
  name: string,
  ids: ReturnType<typeof counters>,
  [x0, y0]: [number, number],
  [x1, y1]: [number, number],
): SketchFeature {
  const corners: [number, number][] = [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
  const lines = corners.map((start, i) => ({
    id: ids.e(),
    kind: 'line' as const,
    construction: false,
    start,
    end: corners[(i + 1) % 4]!,
  }));
  const constraints: SketchConstraint[] = [
    ...lines.map((l, i) => ({
      id: ids.k(),
      kind: 'coincident' as const,
      a: { entity: l.id, at: 'end' as const },
      b: { entity: lines[(i + 1) % 4]!.id, at: 'start' as const },
    })),
    { id: ids.k(), kind: 'horizontal', line: lines[0]!.id },
    { id: ids.k(), kind: 'horizontal', line: lines[2]!.id },
    { id: ids.k(), kind: 'vertical', line: lines[1]!.id },
    { id: ids.k(), kind: 'vertical', line: lines[3]!.id },
    {
      id: ids.k(),
      kind: 'horizontalDistance',
      a: { entity: lines[0]!.id, at: 'start' },
      b: { entity: lines[0]!.id, at: 'end' },
      value: mm(`${x1 - x0} mm`),
    },
    {
      id: ids.k(),
      kind: 'verticalDistance',
      a: { entity: lines[1]!.id, at: 'start' },
      b: { entity: lines[1]!.id, at: 'end' },
      value: mm(`${y1 - y0} mm`),
    },
    { id: ids.k(), kind: 'fix', point: { entity: lines[0]!.id, at: 'start' } },
  ];
  return {
    id,
    kind: 'sketch',
    name,
    suppressed: false,
    plane: plane(0),
    entities: lines,
    constraints,
  };
}

/** A hole's `clearance` in mm as the text its diameter and name use: `0.15 mm`. */
export function couponClearanceText(clearance: number): string {
  return `${clearance.toFixed(2)} mm`;
}

/** The coupon's features, in order. */
export function couponFeatures(): Feature[] {
  const ids = counters();
  const features: Feature[] = [];

  // The hole plate.
  features.push(
    rectangle('sketch#1', 'Hole plate outline', ids, [0, 0], [HOLE_PLATE.length, HOLE_PLATE.width]),
    {
      id: 'extrude#1',
      kind: 'extrude',
      name: 'Hole plate',
      suppressed: false,
      profile: { sketch: 'sketch#1' },
      operation: 'new',
      extent: { type: 'blind', distance: mm(`${HOLE_PLATE.thickness} mm`) },
      reverse: false,
    },
  );

  // Hole centres on the plate's top face, then the marker.
  const centres: SketchEntity[] = COUPON_CLEARANCES.map((_, i) => ({
    id: ids.e(),
    kind: 'point',
    construction: false,
    position: [HOLE_PITCH * (i + 1), HOLE_PLATE.width / 2],
  }));
  const marker: SketchEntity = {
    id: ids.e(),
    kind: 'point',
    construction: false,
    position: MARKER.at,
  };
  const holeSketch: SketchFeature = {
    id: 'sketch#2',
    kind: 'sketch',
    name: 'Hole centres',
    suppressed: false,
    plane: plane(HOLE_PLATE.thickness),
    entities: [...centres, marker],
    constraints: [...centres, marker].map((p) => ({
      id: ids.k(),
      kind: 'fix' as const,
      point: { entity: p.id },
    })),
  };
  features.push(holeSketch);
  const hole = (n: number, name: string, point: string, diameter: string): HoleFeature => ({
    id: `hole#${n}`,
    kind: 'hole',
    name,
    suppressed: false,
    sketch: 'sketch#2',
    points: [point],
    diameter: mm(diameter),
    extent: { type: 'throughAll' },
    head: { type: 'simple' },
    scope: ['extrude#1'],
  });
  COUPON_CLEARANCES.forEach((c, i) => {
    const text = couponClearanceText(c);
    features.push(hole(i + 1, `Hole ${i + 1}: +${text}`, centres[i]!.id, `#peg_d + ${text}`));
  });
  features.push(
    hole(
      COUPON_CLEARANCES.length + 1,
      'Marker: hole 1 is next to it',
      marker.id,
      `${MARKER.diameter} mm`,
    ),
  );

  // The peg plate and its pegs.
  features.push(
    rectangle(
      'sketch#3',
      'Peg plate outline',
      ids,
      [0, PEG_PLATE.y],
      [PEG_PLATE.length, PEG_PLATE.y + PEG_PLATE.width],
    ),
    {
      id: 'extrude#2',
      kind: 'extrude',
      name: 'Peg plate',
      suppressed: false,
      profile: { sketch: 'sketch#3' },
      operation: 'new',
      extent: { type: 'blind', distance: mm(`${PEG_PLATE.thickness} mm`) },
      reverse: false,
    },
  );
  PEG_XS.forEach((x, i) => {
    const circle = ids.e();
    const sketch = `sketch#${4 + i}`;
    features.push(
      {
        id: sketch,
        kind: 'sketch',
        name: `Peg ${i + 1} outline`,
        suppressed: false,
        plane: plane(PEG_PLATE.thickness),
        entities: [
          {
            id: circle,
            kind: 'circle',
            construction: false,
            center: [x, PEG_PLATE.y + PEG_PLATE.width / 2],
            radius: COUPON_PEG_DIAMETER / 2,
          },
        ],
        constraints: [
          { id: ids.k(), kind: 'fix', point: { entity: circle, at: 'center' } },
          { id: ids.k(), kind: 'diameter', entity: circle, value: mm('#peg_d') },
        ],
      },
      {
        id: `extrude#${3 + i}`,
        kind: 'extrude',
        name: `Peg ${i + 1}`,
        suppressed: false,
        profile: { sketch },
        operation: 'add',
        extent: { type: 'blind', distance: mm(`${PEG_HEIGHT} mm`) },
        reverse: false,
        scope: ['extrude#2'],
      },
    );
  });
  return features;
}

/** The commands that build the coupon on an empty document. */
export function couponCommands(): Command[] {
  return [
    { type: 'setVariable', name: 'peg_d', expression: mm(`${COUPON_PEG_DIAMETER} mm`) },
    ...couponFeatures().map((feature): Command => ({ type: 'addFeature', partId: PART, feature })),
    {
      type: 'addPrintSetup',
      setup: {
        id: 'print#1',
        name: 'X1 Carbon, 0.4 mm nozzle',
        printer: COUPON_PRINTER,
        nozzle: COUPON_NOZZLE,
        items: [{ id: 'item#1', part: PART, orientation: { kind: 'asModelled' } }],
      },
    },
  ];
}

/** A new fit-test coupon document. */
export function couponDocument(id: string = crypto.randomUUID()): ManufaktureDocument {
  const base = createDocument({ id, name: COUPON_NAME });
  let doc: ManufaktureDocument = {
    ...base,
    parts: base.parts.map((p) => ({ ...p, name: COUPON_PART_NAME })),
  };
  for (const command of couponCommands()) {
    const r = applyCommand(doc, command);
    if (!r.ok) throw new Error(`The fit-test coupon is invalid: ${r.error.message}`);
    doc = r.value.document;
  }
  return doc;
}

/** How to read the coupon, as the home screen and the docs say it. */
export const COUPON_PROCEDURE: readonly string[] = [
  'Print both plates flat, as modelled, with the slicer profile you use for real parts.',
  'Hole 1 is the one next to the small marker hole; the clearance grows by 0.05 mm per hole, from +0.00 mm (hole 1) to +0.50 mm (hole 11).',
  'Hold the peg plate at right angles to the hole plate and try one peg at a time: the pegs are 15 mm apart and the holes 10 mm, so held parallel, the other pegs land on solid plate.',
  ...FIT_KINDS.map(
    (k) =>
      `${k[0]!.toUpperCase()}${k.slice(1)} fit: the first hole where a peg ${FIT_DESCRIPTIONS[k]}.`,
  ),
  "Set #fit_press, #fit_slip and #fit_sliding to those holes' clearances.",
];
