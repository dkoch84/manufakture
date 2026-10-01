// A print setup resolved against the regenerated model (M3 plan, T3.1d; ADR 0012 decisions 1 to
// 3): the printer and thresholds it names, evaluated; each item's bodies, its orientation turned
// into a placement on the bed, and its copies laid out on the plate. Pure: the workspace calls it
// on every document or model change, and nothing it computes is stored.
//
// References never block modelling (ADR 0012 decision 2): an item whose body or lay-flat face is
// gone resolves as `reference-lost` with the missing name, and the panel offers a re-pick; a
// printer this build does not know resolves with `printer: null` and no checks run against it.
//
// The orientation is a display transform: every body keeps its mesh and names in part
// coordinates and gets a `transform` (the item's placement), so picking a face still returns the
// part's face name. Copies are laid out in a row along x, centred on the printable area, 5 mm
// apart; that is only a preview, since the slicer arranges the plate for real.
//
// Bed fit is therefore checked per item, apart from the preview: one copy, alone on the plate,
// at the first spot that fits among the centred one and spots pushed clear of each excluded
// area (`itemBedFit`). That is the blocking check (export refuses a part that fits nowhere,
// ADR 0012 decision 11). Whether all the copies of all the items fit on one plate together is
// only estimated from their footprints, and is a note, not a failure (`plateNote`).

import {
  configured,
  findPart,
  type ManufaktureDocument,
  type PrintItem,
  type PrintSetup,
  type StoredExpression,
} from '@manufakture/core';
import type { BoundingBox } from '@manufakture/kernel';
import {
  DEFAULT_OVERHANG_THRESHOLD,
  boundingBox,
  checkBedFit,
  findPrinter,
  hasNozzle,
  orientationPlacement,
  printThresholds,
  usableRegion,
  type BedFitResult,
  type Orientation,
  type Placement,
  type PrintThresholds,
  type Printer,
} from '@manufakture/print';
import { evaluate } from '@manufakture/units';
import { partBodies } from '../model/bodies';
import type { PartModel } from '../model/model';
import { evaluateVariables, type Variables } from '../sketcher/values';
import type { BodyInput } from '../viewport/bodies';

/** Space between copies on the previewed plate, mm. */
export const COPY_GAP = 5;
/** Copies beyond this many per item are checked as a count but not drawn or laid out. */
export const MAX_SHOWN_COPIES = 50;

/** One body of an item, as the workspace draws and checks it. */
export interface ItemBody {
  partId: string;
  bodyId: string;
  /** The part studio's viewport id of the body (`part#1/extrude#1`), which the kernel knows. */
  sourceId: string;
  name: string;
  /** `#rrggbb`. */
  color: string;
  /** Mesh, names and topology, in part coordinates (the export-tolerance mesh when there is one). */
  input: BodyInput;
  /** The part studio's own viewport body, as regen made it. */
  view: BodyInput;
}

/** One copy of an item where the preview puts it. */
export interface PlacedCopy {
  copy: number;
  /** Part coordinates to bed coordinates: the orientation, the drop to z = 0, the layout. */
  placement: Placement;
  /** Every body of the copy, placed. */
  box: BoundingBox;
}

/** An item's bed fit: one copy, alone on the plate, at `box` (the spot that fits, if any). */
export interface ItemBedFit extends BedFitResult {
  /** Where it was checked, bed coordinates: the first spot that fits, else the centred one. */
  box: BoundingBox;
}

export type ItemStatus = 'ok' | 'pending' | 'reference-lost' | 'invalid';

export interface ResolvedItem {
  item: PrintItem;
  /** The part's name, and the body's when the item prints one body. */
  label: string;
  status: ItemStatus;
  /** Why it is not `ok`; null when it is. */
  message: string | null;
  /** Names that no longer resolve (a body id, a face name), for `reference-lost`. */
  missing: string[];
  bodies: ItemBody[];
  /** The orientation as numbers; null when it does not evaluate or the face is gone. */
  orientation: Orientation | null;
  /** Up to `MAX_SHOWN_COPIES`, in plate order. Empty unless `status` is `ok`. */
  copies: PlacedCopy[];
  /** Against the setup's printer, wherever on the bed it fits; null when not checked. */
  fit: ItemBedFit | null;
}

export interface ResolvedSetup {
  setup: PrintSetup;
  /** Null when this build does not know the printer: the setup is shown, nothing is checked. */
  printer: Printer | null;
  thresholds: PrintThresholds;
  /** Overhang threshold, radians from vertical (ADR 0012 decision 6). */
  overhang: number;
  /** Setup-level problems: an unknown printer, a nozzle it is not sold with, a threshold that does not evaluate. */
  problems: string[];
  items: ResolvedItem[];
  /** Not blocking: the copies' footprints add up to more than the plate has room for. */
  plateNote: string | null;
}

/** The viewport id of one body of one copy of an item in the print view. */
export function printViewId(itemId: string, copy: number, sourceId: string): string {
  return `print:${itemId}:${copy}:${sourceId}`;
}

/** The item, copy and source body a print view id names, or null. */
export function parsePrintViewId(
  id: string,
): { itemId: string; copy: number; sourceId: string } | null {
  const m = /^print:(item#[0-9]+):([0-9]+):(.+)$/.exec(id);
  return m ? { itemId: m[1]!, copy: Number(m[2]), sourceId: m[3]! } : null;
}

type Evaluated = { ok: true; value: number } | { ok: false; message: string };

function evaluateStored(
  e: StoredExpression,
  kind: 'length' | 'angle',
  variables: Variables,
): Evaluated {
  const r = evaluate(e.source, {
    expected: kind,
    lengthUnit: e.lengthUnit,
    angleUnit: e.angleUnit,
    variables: (n) => variables[n],
  });
  return r.ok ? { ok: true, value: r.value } : { ok: false, message: r.error.message };
}

const THRESHOLD_LABELS = {
  overhang: 'Overhang angle',
  minWall: 'Minimum wall',
  minGap: 'Minimum gap',
  minHole: 'Minimum hole',
  teardrop: 'Teardrop size',
} as const;

/** The variables print expressions read: the document's, with its active configuration row. */
export function printVariables(doc: ManufaktureDocument): Variables {
  const c = configured(doc);
  return evaluateVariables(c.ok ? c.value : doc);
}

/** The setup's thresholds as numbers: its own where they evaluate, else the nozzle's defaults. */
export function setupThresholds(
  setup: PrintSetup,
  variables: Variables,
): { thresholds: PrintThresholds; overhang: number; problems: string[] } {
  const problems: string[] = [];
  const overrides: Partial<PrintThresholds> = {};
  let overhang = DEFAULT_OVERHANG_THRESHOLD;
  const t = setup.thresholds;
  if (t) {
    for (const key of ['minWall', 'minGap', 'minHole', 'teardrop'] as const) {
      const e = t[key];
      if (!e) continue;
      const r = evaluateStored(e, 'length', variables);
      if (r.ok) overrides[key] = r.value;
      else problems.push(`${THRESHOLD_LABELS[key]} does not evaluate: ${r.message}`);
    }
    if (t.overhang) {
      const r = evaluateStored(t.overhang, 'angle', variables);
      if (r.ok) overhang = r.value;
      else problems.push(`${THRESHOLD_LABELS.overhang} does not evaluate: ${r.message}`);
    }
  }
  return { thresholds: printThresholds(setup.nozzle, overrides), overhang, problems };
}

/** The face's outward normal (part coordinates), from the topology of the body that has it. */
function faceNormal(
  bodies: readonly ItemBody[],
  face: string,
): { found: boolean; normal: [number, number, number] | null } {
  for (const b of bodies) {
    const slot = b.input.names.indexOf(face);
    if (slot < 0) continue;
    const index = b.input.mesh.faceNames.indexOf(slot);
    if (index < 0) continue;
    const info = b.input.topology?.faces.find((f) => f.index === index + 1);
    const n = info?.normal ?? null;
    return { found: true, normal: n ? [n[0], n[1], n[2]] : null };
  }
  return { found: false, normal: null };
}

/** The orientation of an item as numbers, or why not. */
function itemOrientation(
  item: PrintItem,
  bodies: readonly ItemBody[],
  variables: Variables,
):
  | { ok: true; orientation: Orientation }
  | { ok: false; status: ItemStatus; message: string; missing: string[] } {
  const o = item.orientation;
  if (o.kind === 'asModelled') return { ok: true, orientation: { kind: 'asModelled' } };
  if (o.kind === 'layFlat') {
    const face = o.face.ref.face;
    const found = faceNormal(bodies, face);
    if (!found.found) {
      return {
        ok: false,
        status: 'reference-lost',
        message: `The face it lies flat on (${face}) is gone. Pick another face.`,
        missing: [face],
      };
    }
    if (!found.normal) {
      return {
        ok: false,
        status: 'invalid',
        message: `The face it lies flat on (${face}) is not planar any more. Pick a flat face.`,
        missing: [],
      };
    }
    let turn = 0;
    if (o.turn) {
      const r = evaluateStored(o.turn, 'angle', variables);
      if (!r.ok) {
        return { ok: false, status: 'invalid', message: `The turn: ${r.message}`, missing: [] };
      }
      turn = r.value;
    }
    return { ok: true, orientation: { kind: 'layFlat', normal: found.normal, turn } };
  }
  const angles: number[] = [];
  for (const axis of ['x', 'y', 'z'] as const) {
    const r = evaluateStored(o[axis], 'angle', variables);
    if (!r.ok) {
      return {
        ok: false,
        status: 'invalid',
        message: `The rotation about ${axis}: ${r.message}`,
        missing: [],
      };
    }
    angles.push(r.value);
  }
  return { ok: true, orientation: { kind: 'rotate', x: angles[0]!, y: angles[1]!, z: angles[2]! } };
}

/** The nozzles a copy is printed with on a two-nozzle printer: both when it uses two colours. */
function nozzlesFor(printer: Printer, bodies: readonly ItemBody[]): number[] | undefined {
  if (!printer.nozzleAreas || printer.nozzleAreas.length < 2) return undefined;
  const colours = new Set(bodies.map((b) => b.color.toLowerCase()));
  return colours.size >= 2 ? [0, 1] : undefined;
}

export interface ResolveOptions {
  /** The mesh to use for a body: the export-tolerance one when there is one. Default: as given. */
  meshOf?: (view: BodyInput) => BodyInput;
}

/** Resolve a setup against the model's parts. */
export function resolveSetup(
  doc: ManufaktureDocument,
  setup: PrintSetup,
  parts: readonly PartModel[],
  options: ResolveOptions = {},
): ResolvedSetup {
  const variables = printVariables(doc);
  const { thresholds, overhang, problems } = setupThresholds(setup, variables);
  const printer = findPrinter(setup.printer) ?? null;
  if (!printer) {
    problems.unshift(
      `This build does not know the printer "${setup.printer}" (a document from a newer version?), so nothing is checked. Pick a printer.`,
    );
  } else if (!hasNozzle(printer, setup.nozzle)) {
    problems.unshift(`The ${printer.name} is not sold with a ${setup.nozzle} mm nozzle.`);
  }
  const meshOf = options.meshOf ?? ((v: BodyInput) => v);

  const items: ResolvedItem[] = setup.items.map((item) => {
    const part = findPart(doc, item.part);
    const partName = part?.name ?? item.part;
    const model = parts.find((p) => p.partId === item.part);
    const all = partBodies(part, model);
    const chosen = item.body === undefined ? all : all.filter((b) => b.bodyId === item.body);
    const bodyName = item.body === undefined ? null : (chosen[0]?.name ?? item.body);
    const label = bodyName === null || all.length <= 1 ? partName : `${partName}: ${bodyName}`;
    const base = {
      item,
      label,
      bodies: [] as ItemBody[],
      orientation: null,
      copies: [],
      fit: null,
    };
    if (!part || !model) {
      return {
        ...base,
        status: 'pending' as const,
        message: 'Waiting for the model.',
        missing: [],
      };
    }
    if (chosen.length === 0) {
      return item.body === undefined
        ? { ...base, status: 'invalid' as const, message: 'The part has no bodies.', missing: [] }
        : {
            ...base,
            status: 'reference-lost' as const,
            message: `The body it prints (${item.body}) is gone. Pick another body.`,
            missing: [item.body],
          };
    }
    const bodies: ItemBody[] = chosen.map((b) => ({
      partId: item.part,
      bodyId: b.bodyId,
      sourceId: b.viewId,
      name: b.name,
      color: b.color,
      input: meshOf(b.view),
      view: b.view,
    }));
    const o = itemOrientation(item, bodies, variables);
    if (!o.ok) {
      return { ...base, bodies, status: o.status, message: o.message, missing: o.missing };
    }
    return {
      ...base,
      bodies,
      orientation: o.orientation,
      status: 'ok' as const,
      message: null,
      missing: [],
    };
  });

  layOut(items, printer);
  return {
    setup,
    printer,
    thresholds,
    overhang,
    problems,
    items,
    plateNote: plateNote(items, printer),
  };
}

/** An item's oriented placement (dropped onto the bed, not yet moved on it) and its box. */
function oriented(item: ResolvedItem): { placement: Placement; box: BoundingBox } | null {
  if (item.status !== 'ok' || !item.orientation) return null;
  const positions = item.bodies.map((b) => b.input.mesh.positions);
  const placement = orientationPlacement(item.orientation, positions);
  const box = boundingBox(positions, placement);
  return box ? { placement, box } : null;
}

function bounds2(points: readonly (readonly [number, number])[]): {
  min: [number, number];
  max: [number, number];
} {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return { min: [Math.min(...xs), Math.min(...ys)], max: [Math.max(...xs), Math.max(...ys)] };
}

/**
 * One copy of an item alone on the plate: does it fit anywhere? The footprint is tried centred
 * on the usable area, against each side of the area, and pushed clear of each excluded area on
 * either side, in every combination of those x and y spots; the first spot that fits wins. When
 * none does, the centred spot is reported, whose overshoot is how much too big the item is.
 */
export function itemBedFit(
  printer: Printer,
  box: BoundingBox,
  nozzles?: readonly number[],
): ItemBedFit {
  const region = usableRegion(printer, nozzles);
  const area = region.area.length > 0 ? region.area : printer.area;
  const b = bounds2(area);
  const size = [box.max[0] - box.min[0], box.max[1] - box.min[1]];
  const spots = [0, 1].map((a) => {
    const lo = b.min[a]!;
    const hi = b.max[a]!;
    const s = size[a]!;
    const out = [(lo + hi - s) / 2, lo, hi - s];
    for (const e of printer.excluded) {
      const eb = bounds2(e.polygon);
      out.push(eb.max[a]!, eb.min[a]! - s);
    }
    return [...new Set(out)];
  });
  const at = (x: number, y: number): BoundingBox => ({
    min: [x, y, box.min[2]],
    max: [x + size[0]!, y + size[1]!, box.max[2]],
  });
  const opts = nozzles ? { nozzles } : {};
  let first: ItemBedFit | null = null;
  for (const y of spots[1]!) {
    for (const x of spots[0]!) {
      const placed = at(x, y);
      const fit = checkBedFit(printer, { box: placed, ...opts });
      if (fit.fits) return { ...fit, box: placed };
      first ??= { ...fit, box: placed };
    }
  }
  return first!;
}

/** Place every copy of every resolved item in one row, centred on the printable area. */
function layOut(items: ResolvedItem[], printer: Printer | null): void {
  let cx = 0;
  let cy = 0;
  if (printer) {
    const b = bounds2(printer.area);
    cx = (b.min[0] + b.max[0]) / 2;
    cy = (b.min[1] + b.max[1]) / 2;
  }
  const row: { item: ResolvedItem; copy: number; oriented: Placement; box: BoundingBox }[] = [];
  for (const item of items) {
    const o = oriented(item);
    if (!o) continue;
    if (printer) {
      const nozzles = nozzlesFor(printer, item.bodies);
      item.fit = itemBedFit(printer, o.box, nozzles);
    }
    const copies = Math.min(item.item.copies ?? 1, MAX_SHOWN_COPIES);
    for (let copy = 0; copy < copies; copy++) {
      row.push({ item, copy, oriented: o.placement, box: o.box });
    }
  }
  const width =
    row.reduce((w, r) => w + (r.box.max[0] - r.box.min[0]), 0) +
    COPY_GAP * Math.max(0, row.length - 1);
  let x = cx - width / 2;
  for (const r of row) {
    const t: [number, number, number] = [
      x - r.box.min[0],
      cy - (r.box.min[1] + r.box.max[1]) / 2,
      r.oriented.translation[2],
    ];
    const placement: Placement = { rotation: r.oriented.rotation, translation: t };
    const box: BoundingBox = {
      min: [r.box.min[0] + t[0], r.box.min[1] + t[1], r.box.min[2]],
      max: [r.box.max[0] + t[0], r.box.max[1] + t[1], r.box.max[2]],
    };
    r.item.copies.push({ copy: r.copy, placement, box });
    x += r.box.max[0] - r.box.min[0] + COPY_GAP;
  }
}

function polygonArea(points: readonly (readonly [number, number])[]): number {
  let a = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    const q = points[(i + 1) % points.length]!;
    a += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(a) / 2;
}

/**
 * A note when the copies cannot all fit on one plate: the footprints of every copy of every
 * item that fits on its own (each with `COPY_GAP` around it) add up to more than the printable
 * area minus the excluded areas. An estimate in the copies' favour, and never blocking: the
 * slicer arranges the plate, and the rest can go on a second one.
 */
export function plateNote(items: readonly ResolvedItem[], printer: Printer | null): string | null {
  if (!printer) return null;
  let used = 0;
  let count = 0;
  for (const item of items) {
    if (!item.fit?.fits) continue;
    const { box } = item.fit;
    const copies = item.item.copies ?? 1;
    used += copies * (box.max[0] - box.min[0] + COPY_GAP) * (box.max[1] - box.min[1] + COPY_GAP);
    count += copies;
  }
  const room =
    polygonArea(printer.area) - printer.excluded.reduce((a, e) => a + polygonArea(e.polygon), 0);
  if (count < 2 || used <= room) return null;
  return `The ${count} copies need about ${Math.round((100 * used) / room)}% of the plate, so they will not all fit on one. Each fits on its own; the slicer arranges the plate, and the rest can go on another.`;
}

/** The bodies the viewport draws for a resolved setup: every body of every laid-out copy. */
export function printViewBodies(resolved: ResolvedSetup): BodyInput[] {
  const out: BodyInput[] = [];
  for (const item of resolved.items) {
    for (const copy of item.copies) {
      for (const b of item.bodies) {
        out.push({
          ...b.input,
          id: printViewId(item.item.id, copy.copy, b.sourceId),
          color: b.color,
          transform: { translation: copy.placement.translation, rotation: copy.placement.rotation },
        });
      }
    }
  }
  return out;
}
