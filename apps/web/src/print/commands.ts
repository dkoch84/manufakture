// The commands the print workspace runs (M3 plan, T3.1d): a new setup, a new item, lay flat on a
// face, a quarter turn about a bed axis, back to as modelled. Each is one core command, so one undo
// step. Ids come from the print section's own counters (`print#n`, `item#n`, `r<n>`, ADR 0012
// decision 1), previewed here and checked fresh by core.

import {
  PRINT_ITEM_COUNTER,
  PRINT_SETUP_COUNTER,
  bareUnits,
  createPrintSetup,
  previewIds,
  type Command,
  type ManufaktureDocument,
  type PrintItem,
  type PrintSetup,
  type StoredExpression,
} from '@manufakture/core';
import {
  orientationRotation,
  placementMatrix,
  quatFromAxisAngle,
  quatMultiply,
  type Orientation,
} from '@manufakture/print';

/** The printer and nozzle a new setup starts with: the X1 Carbon at 0.4 mm (the owner's printer). */
export const DEFAULT_PRINTER = 'bambu-x1c';
export const DEFAULT_NOZZLE = 0.4;

/** A bed axis the orientation tools turn about. */
export type BedAxis = 'x' | 'y' | 'z';

const AXES: Readonly<Record<BedAxis, [number, number, number]>> = {
  x: [1, 0, 0],
  y: [0, 1, 0],
  z: [0, 0, 1],
};

/** The first `Plate n` no setup is called yet. */
export function newSetupName(doc: ManufaktureDocument): string {
  const names = new Set(doc.print.setups.map((s) => s.name));
  let n = doc.print.setups.length + 1;
  while (names.has(`Plate ${n}`)) n++;
  return `Plate ${n}`;
}

/** Add a setup on the default printer, with no items and default thresholds. */
export function addSetupCommand(doc: ManufaktureDocument): { command: Command; setupId: string } {
  const [setupId] = previewIds(doc.print.nextIds, PRINT_SETUP_COUNTER);
  const setup = createPrintSetup(setupId!, newSetupName(doc), DEFAULT_PRINTER, DEFAULT_NOZZLE);
  return { command: { type: 'addPrintSetup', setup }, setupId: setupId! };
}

/** Add an item: a part (every body, or one), as modelled, one copy. */
export function addItemCommand(
  doc: ManufaktureDocument,
  setupId: string,
  partId: string,
  bodyId?: string,
): { command: Command; itemId: string } {
  const [itemId] = previewIds(doc.print.nextIds, PRINT_ITEM_COUNTER);
  const item: PrintItem = {
    id: itemId!,
    part: partId,
    ...(bodyId !== undefined ? { body: bodyId } : {}),
    orientation: { kind: 'asModelled' },
  };
  return { command: { type: 'addPrintItem', setupId, item }, itemId: itemId! };
}

/** Change an item: one `editPrintItem`. */
export function editItemCommand(setupId: string, item: PrintItem): Command {
  return { type: 'editPrintItem', setupId, item };
}

/** Lay the item flat on the planar face named `face`, with a fresh reference id. */
export function layFlatCommand(
  doc: ManufaktureDocument,
  setupId: string,
  item: PrintItem,
  face: string,
): Command {
  const [refId] = previewIds(doc.print.nextIds, 'r');
  return editItemCommand(setupId, {
    ...item,
    orientation: { kind: 'layFlat', face: { id: refId!, ref: { face } } },
  });
}

/** Back to the item as modelled. */
export function resetOrientationCommand(setupId: string, item: PrintItem): Command {
  return editItemCommand(setupId, { ...item, orientation: { kind: 'asModelled' } });
}

/** An angle in degrees as a stored expression, whatever the document's display units. */
export function degrees(doc: ManufaktureDocument, value: number): StoredExpression {
  return { source: String(value), lengthUnit: bareUnits(doc.units).lengthUnit, angleUnit: 'deg' };
}

/** `expression` plus `degrees`, keeping what it reads (its variables and its own units). */
function plusDegrees(expression: StoredExpression, value: number): StoredExpression {
  return { ...expression, source: `(${expression.source}) + ${value} deg` };
}

/** Degrees rounded to 1e-6, with -0 and -180 written as 0 and 180. */
function cleanDegrees(radians: number): number {
  let d = Math.round(((radians * 180) / Math.PI) * 1e6) / 1e6;
  if (d === -180) d = 180;
  return d + 0;
}

/**
 * The extrinsic x-y-z angles (radians) of a rotation, the convention `rotate` orientations use
 * (matrix Rz * Ry * Rx, `packages/print`). In gimbal lock (y at +-90 degrees) x is taken as 0.
 */
export function eulerAngles(orientation: Orientation): [number, number, number] {
  return eulerOfQuat(orientationRotation(orientation));
}

/**
 * A quarter turn about a bed axis, after the orientation the item has now. `current` is that
 * orientation evaluated (null when it does not evaluate: the turn is then about the model as it
 * is). A turn about z keeps the stored expression and adds 90 degrees to it (`turn` of a lay-flat,
 * `z` of a rotation); any other turn is worked out and stored as numbers.
 */
export function rotateCommand(
  doc: ManufaktureDocument,
  setupId: string,
  item: PrintItem,
  current: Orientation | null,
  axis: BedAxis,
  degreesBy = 90,
): Command {
  const o = item.orientation;
  if (axis === 'z' && o.kind === 'layFlat') {
    const turn = o.turn ? plusDegrees(o.turn, degreesBy) : degrees(doc, degreesBy);
    return editItemCommand(setupId, { ...item, orientation: { ...o, turn } });
  }
  if (axis === 'z' && o.kind === 'rotate') {
    return editItemCommand(setupId, {
      ...item,
      orientation: { ...o, z: plusDegrees(o.z, degreesBy) },
    });
  }
  const before: Orientation = current ?? { kind: 'asModelled' };
  const q = quatMultiply(
    quatFromAxisAngle(AXES[axis], (degreesBy * Math.PI) / 180),
    orientationRotation(before),
  );
  // As a rotation about the fixed axes: the composite, read back as x, y and z angles.
  const [x, y, z] = eulerOfQuat(q);
  return editItemCommand(setupId, {
    ...item,
    orientation: {
      kind: 'rotate',
      x: degrees(doc, cleanDegrees(x)),
      y: degrees(doc, cleanDegrees(y)),
      z: degrees(doc, cleanDegrees(z)),
    },
  });
}

/** The x, y and z angles of a rotation (see `eulerAngles`). */
function eulerOfQuat(q: readonly [number, number, number, number]): [number, number, number] {
  const m = placementMatrix({ rotation: q, translation: [0, 0, 0] });
  const sy = Math.max(-1, Math.min(1, -m[6]));
  const y = Math.asin(sy);
  if (Math.abs(sy) < 1 - 1e-12) return [Math.atan2(m[7], m[8]), y, Math.atan2(m[3], m[0])];
  return [0, y, Math.atan2(-m[1], m[4])];
}

/** Change a setup's name, printer, nozzle or thresholds: one `editPrintSetup`. */
export function editSetupCommand(
  setupId: string,
  patch: Partial<Pick<PrintSetup, 'name' | 'printer' | 'nozzle'>> & {
    thresholds?: PrintSetup['thresholds'] | null;
  },
): Command {
  return { type: 'editPrintSetup', setupId, ...patch } as Command;
}
