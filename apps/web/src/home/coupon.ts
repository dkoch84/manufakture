// The fit-test coupon template (plan M3, T3.2g): a new document that measures which clearance
// gives a press, slip and sliding fit on the user's printer. Two bodies in one part studio:
//
// - the hole plate, 120 x 26 x 6 mm, with a row of eleven through holes of diameter
//   #peg_d + 0.00 mm, + 0.05 mm, ... + 0.50 mm (hole 1 to hole 11, left to right), each labelled
//   with its clearance ("0.15") in debossed text: Inter Bold (the bundled font) at a 5 mm cap
//   height, 0.6 mm deep. The labels alternate below (odd holes) and above (even holes) the row,
//   since a label is wider than the 10 mm hole pitch;
// - the peg plate, 50 x 15 x 3 mm, with three pegs of diameter #peg_d standing 10 mm on it.
//
// Each hole's feature name says its clearance too ("Hole 4: +0.15 mm"). The labels are sized for
// the printer this milestone targets: 5 mm is above the bundled font's recommended 4.2 mm
// (docs/user/text.md, "Size for printing"), and a little letter spacing keeps the plate between
// neighbouring letters at least two line widths wide. The document also holds a print setup for
// the Bambu Lab X1 Carbon with a 0.4 mm nozzle, so the print workspace and Insert fit variables
// read it. The procedure is in docs/user/fits.md and in `COUPON_PROCEDURE`.

import {
  applyCommand,
  createDocument,
  type Command,
  type DocumentFont,
  type Feature,
  type HoleFeature,
  type ManufaktureDocument,
  type OutlineEntity,
  type SketchConstraint,
  type SketchEntity,
  type SketchFeature,
  type StoredExpression,
} from '@manufakture/core';
import { COUPON_CLEARANCES, FIT_DESCRIPTIONS, FIT_KINDS } from '@manufakture/print';
import { DEFAULT_FONT_ID, bundledFont } from '@manufakture/regen/client';

export const COUPON_NAME = 'Fit-test coupon';
export const COUPON_PART_NAME = 'Coupon';
/** The printer and nozzle of the coupon's print setup. */
export const COUPON_PRINTER = 'bambu-x1c';
export const COUPON_NOZZLE = 0.4;
/** The peg's nominal diameter, mm (the variable #peg_d). */
export const COUPON_PEG_DIAMETER = 6;

const PART = 'part#1';
const HOLE_PLATE = { length: 120, width: 26, thickness: 6 };
const PEG_PLATE = { y: 32, length: 50, width: 15, thickness: 3 };
const PEG_HEIGHT = 10;
const PEG_XS = [10, 25, 40];
const HOLE_PITCH = 10;
/** The holes' centres are on this line of the plate. */
const HOLE_ROW_Y = 13;
/**
 * The clearance labels, mm: cap height, letter spacing, deboss depth, and where their middles
 * sit (odd holes below the row, even holes above). "0.00" is about 16 mm wide, so each row of
 * labels has a 20 mm pitch; the labels end 2.25 mm from the largest hole and 2.5 mm from the
 * plate's long edges.
 */
export const COUPON_LABEL = { size: 5, letterSpacing: 0.3, depth: 0.6, below: 5, above: 21 };
/** The id of the coupon's font, the bundled default. */
const FONT = 'font#1';

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

/** A hole's `clearance` as its debossed label says it: `0.15`. */
export function couponLabelText(clearance: number): string {
  return clearance.toFixed(2);
}

/** The bundled default font, as the coupon's document holds it. */
function couponFont(): DocumentFont {
  const font = bundledFont(DEFAULT_FONT_ID);
  if (!font) throw new Error(`The app has no bundled font ${DEFAULT_FONT_ID}.`);
  return {
    id: FONT,
    family: font.family,
    style: font.style,
    source: { kind: 'bundled', id: font.id, sha256: font.sha256 },
  };
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

  // Hole centres on the plate's top face.
  const centres: SketchEntity[] = COUPON_CLEARANCES.map((_, i) => ({
    id: ids.e(),
    kind: 'point',
    construction: false,
    position: [HOLE_PITCH * (i + 1), HOLE_ROW_Y],
  }));
  const holeSketch: SketchFeature = {
    id: 'sketch#2',
    kind: 'sketch',
    name: 'Hole centres',
    suppressed: false,
    plane: plane(HOLE_PLATE.thickness),
    entities: centres,
    constraints: centres.map((p) => ({
      id: ids.k(),
      kind: 'fix' as const,
      point: { entity: p.id },
    })),
  };
  features.push(holeSketch);
  COUPON_CLEARANCES.forEach((c, i) => {
    const text = couponClearanceText(c);
    features.push({
      id: `hole#${i + 1}`,
      kind: 'hole',
      name: `Hole ${i + 1}: +${text}`,
      suppressed: false,
      sketch: 'sketch#2',
      points: [centres[i]!.id],
      diameter: mm(`#peg_d + ${text}`),
      extent: { type: 'throughAll' },
      head: { type: 'simple' },
      scope: ['extrude#1'],
    } satisfies HoleFeature);
  });

  // The clearance labels, on the top face, debossed into the hole plate.
  const labels: OutlineEntity[] = COUPON_CLEARANCES.map((c, i) => ({
    id: ids.e(),
    kind: 'outline',
    construction: false,
    anchor: [HOLE_PITCH * (i + 1), i % 2 === 0 ? COUPON_LABEL.below : COUPON_LABEL.above],
    angle: 0,
    source: {
      kind: 'text',
      text: couponLabelText(c),
      font: FONT,
      size: mm(`${COUPON_LABEL.size} mm`),
      align: { horizontal: 'center', vertical: 'middle' },
      letterSpacing: mm(`${COUPON_LABEL.letterSpacing} mm`),
    },
  }));
  features.push(
    {
      id: 'sketch#3',
      kind: 'sketch',
      name: 'Clearance labels',
      suppressed: false,
      plane: plane(HOLE_PLATE.thickness),
      entities: labels,
      constraints: labels.map((l) => ({
        id: ids.k(),
        kind: 'fix' as const,
        point: { entity: l.id, at: 'anchor' as const },
      })),
    },
    {
      id: 'extrude#2',
      kind: 'extrude',
      name: 'Labels',
      suppressed: false,
      profile: { sketch: 'sketch#3', entities: labels.map((l) => l.id) },
      operation: 'cut',
      extent: { type: 'blind', distance: mm(`${COUPON_LABEL.depth} mm`) },
      reverse: true,
      scope: ['extrude#1'],
    },
  );

  // The peg plate and its pegs.
  features.push(
    rectangle(
      'sketch#4',
      'Peg plate outline',
      ids,
      [0, PEG_PLATE.y],
      [PEG_PLATE.length, PEG_PLATE.y + PEG_PLATE.width],
    ),
    {
      id: 'extrude#3',
      kind: 'extrude',
      name: 'Peg plate',
      suppressed: false,
      profile: { sketch: 'sketch#4' },
      operation: 'new',
      extent: { type: 'blind', distance: mm(`${PEG_PLATE.thickness} mm`) },
      reverse: false,
    },
  );
  PEG_XS.forEach((x, i) => {
    const circle = ids.e();
    const sketch = `sketch#${5 + i}`;
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
        id: `extrude#${4 + i}`,
        kind: 'extrude',
        name: `Peg ${i + 1}`,
        suppressed: false,
        profile: { sketch },
        operation: 'add',
        extent: { type: 'blind', distance: mm(`${PEG_HEIGHT} mm`) },
        reverse: false,
        scope: ['extrude#3'],
      },
    );
  });
  return features;
}

/** The commands that build the coupon on an empty document. */
export function couponCommands(): Command[] {
  return [
    { type: 'setVariable', name: 'peg_d', expression: mm(`${COUPON_PEG_DIAMETER} mm`) },
    { type: 'addFont', font: couponFont() },
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
  'Each hole is labelled with its clearance in mm, debossed next to it: the clearance grows by 0.05 mm per hole, from 0.00 (hole 1, on the left) to 0.50 (hole 11).',
  'Hold the peg plate at right angles to the hole plate and try one peg at a time: the pegs are 15 mm apart and the holes 10 mm, so held parallel, the other pegs land on solid plate.',
  ...FIT_KINDS.map(
    (k) =>
      `${k[0]!.toUpperCase()}${k.slice(1)} fit: the first hole where a peg ${FIT_DESCRIPTIONS[k]}.`,
  ),
  "Set #fit_press, #fit_slip and #fit_sliding to those holes' clearances.",
];
