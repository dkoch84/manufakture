// Generic views of the mechanical section (ADR 0017 decision 2, since version 19), as
// `features.ts` gives of features and CAM: the ids each item owns, with their counters, and every
// expression with the kind its field expects. Validation, commands, variables, changes and the id
// remap use these, so each shape is described once.

import { isPhysicalKind, type QuantityKind } from '@manufakture/units';
import {
  MECH_COUNTERS,
  type CatalogEntry,
  type CheckOverride,
  type Drivetrain,
  type Electrical,
  type FaceReference,
  type Hazard,
  type LoadCase,
  type ManufaktureDocument,
  type MechData,
  type PurchasedUse,
  type Requirement,
  type RequirementQuantity,
  type Schematic,
  type SpecNote,
  type StoredExpression,
  type Study,
  type SymbolDef,
  type TestBand,
} from './schema';

/** The list collections of `mech`, in schema order (`electrical` is one object, not a list). */
export const MECH_LISTS = [
  'requirements',
  'loadCases',
  'drivetrains',
  'purchased',
  'catalog',
  'schematics',
  'symbols',
  'studies',
  'checks',
  'specNotes',
  'hazards',
  'testBands',
] as const;
export type MechList = (typeof MECH_LISTS)[number];

/** The item type of each list collection. */
export interface MechListItems {
  requirements: Requirement;
  loadCases: LoadCase;
  drivetrains: Drivetrain;
  purchased: PurchasedUse;
  catalog: CatalogEntry;
  schematics: Schematic;
  symbols: SymbolDef;
  studies: Study;
  checks: CheckOverride;
  specNotes: SpecNote;
  hazards: Hazard;
  testBands: TestBand;
}

/** The counter of each list's own ids (`req` for `req#n`). */
export const MECH_LIST_COUNTERS: { readonly [K in MechList]: string } = {
  requirements: MECH_COUNTERS.requirement,
  loadCases: MECH_COUNTERS.loadCase,
  drivetrains: MECH_COUNTERS.drivetrain,
  purchased: MECH_COUNTERS.purchased,
  catalog: MECH_COUNTERS.entry,
  schematics: MECH_COUNTERS.schematic,
  symbols: MECH_COUNTERS.symbol,
  studies: MECH_COUNTERS.study,
  checks: MECH_COUNTERS.check,
  specNotes: MECH_COUNTERS.note,
  hazards: MECH_COUNTERS.hazard,
  testBands: MECH_COUNTERS.testBand,
};

/** A list's items (empty when the section or the list is absent). */
export function mechItems<K extends MechList>(
  mech: MechData | undefined,
  list: K,
): readonly MechListItems[K][] {
  return ((mech?.[list] as readonly MechListItems[K][] | undefined) ??
    []) as readonly MechListItems[K][];
}

/** An id an item owns, with where it is (from the item) and its counter. */
export interface OwnedId {
  readonly id: string;
  readonly counter: string;
  readonly path: readonly (string | number)[];
}

function faceIds(refs: readonly FaceReference[], path: readonly (string | number)[]): OwnedId[] {
  return refs.map((r, i) => ({
    id: r.id,
    counter: MECH_COUNTERS.reference,
    path: [...path, i, 'id'],
  }));
}

/**
 * Every id an item owns, its own first: a drivetrain's stages, a schematic's sheets and their
 * symbols, wires, labels, ports and notes, a study's face references. All are counted by
 * `mech.nextIds`.
 */
export function mechItemIds<K extends MechList>(list: K, item: MechListItems[K]): OwnedId[] {
  const own: OwnedId = { id: item.id, counter: MECH_LIST_COUNTERS[list], path: ['id'] };
  switch (list) {
    case 'drivetrains': {
      const d = item as Drivetrain;
      return [
        own,
        ...d.stages.map((s, i) => ({
          id: s.id,
          counter: MECH_COUNTERS.stage,
          path: ['stages', i, 'id'],
        })),
      ];
    }
    case 'schematics': {
      const s = item as Schematic;
      const out: OwnedId[] = [own];
      s.sheets.forEach((sheet, si) => {
        const at = (key: string, i: number) => ['sheets', si, key, i, 'id'];
        out.push({ id: sheet.id, counter: MECH_COUNTERS.sheet, path: ['sheets', si, 'id'] });
        sheet.symbols.forEach((x, i) =>
          out.push({ id: x.id, counter: MECH_COUNTERS.placed, path: at('symbols', i) }),
        );
        sheet.wires.forEach((x, i) =>
          out.push({ id: x.id, counter: MECH_COUNTERS.wire, path: at('wires', i) }),
        );
        sheet.labels.forEach((x, i) =>
          out.push({ id: x.id, counter: MECH_COUNTERS.label, path: at('labels', i) }),
        );
        sheet.ports.forEach((x, i) =>
          out.push({ id: x.id, counter: MECH_COUNTERS.port, path: at('ports', i) }),
        );
        sheet.notes.forEach((x, i) =>
          out.push({ id: x.id, counter: MECH_COUNTERS.text, path: at('notes', i) }),
        );
      });
      return out;
    }
    case 'studies': {
      const s = item as Study;
      return [
        own,
        ...s.fixtures.flatMap((f, i) => faceIds(f.faces, ['fixtures', i, 'faces'])),
        ...s.loads.flatMap((l, i) => faceIds(l.faces, ['loads', i, 'faces'])),
        ...faceIds(s.mesh.refine, ['mesh', 'refine']),
      ];
    }
    default:
      return [own];
  }
}

/** Every id the electrical system owns: components, connections, then segments. */
export function electricalIds(e: Electrical | undefined): OwnedId[] {
  if (e === undefined) return [];
  return [
    ...e.components.map((c, i) => ({
      id: c.id,
      counter: MECH_COUNTERS.component,
      path: ['components', i, 'id'],
    })),
    ...e.connections.map((c, i) => ({
      id: c.id,
      counter: MECH_COUNTERS.connection,
      path: ['connections', i, 'id'],
    })),
    ...e.harness.map((s, i) => ({
      id: s.id,
      counter: MECH_COUNTERS.segment,
      path: ['harness', i, 'id'],
    })),
  ];
}

// Expressions ---------------------------------------------------------------------------------

/**
 * What a mechanical expression must evaluate to: a `@manufakture/units` kind, or `any` where the
 * kind depends on something else (a requirement on a record or a series, a check input, a test
 * band, a damper coefficient whose unit has no kind).
 */
export type MechExpressionKind = QuantityKind | 'any';

export interface MechExpressionSite {
  /** Path from the item (or from `electrical`) to the expression. */
  readonly path: readonly (string | number)[];
  readonly expression: StoredExpression;
  readonly expected: MechExpressionKind;
}

/**
 * Whether an expression of this kind is read in the physical parse mode (`packages/units`,
 * "Physical fields"): a physical kind, or `any`, whose kind is inferred in the mechanical domain.
 * Lengths, angles and plain numbers keep the old reading, as in every other section.
 */
export function isPhysicalSite(expected: MechExpressionKind): boolean {
  return expected === 'any' || isPhysicalKind(expected);
}

function sites(): {
  out: MechExpressionSite[];
  add: (
    path: readonly (string | number)[],
    expression: StoredExpression | undefined,
    expected: MechExpressionKind,
  ) => void;
} {
  const out: MechExpressionSite[] = [];
  return {
    out,
    add: (path, expression, expected) => {
      if (expression !== undefined) out.push({ path, expression, expected });
    },
  };
}

/** The kind a requirement's value has, from its quantity. */
export function requirementKind(quantity: RequirementQuantity): MechExpressionKind {
  if (typeof quantity !== 'string') return 'any';
  switch (quantity) {
    case 'maxForce':
    case 'minForce':
    case 'forceStep':
      return 'force';
    case 'peakCableSpeed':
      return 'speed';
    case 'travel':
    case 'envelope':
      return 'length';
    case 'holdDuration':
    case 'chargeTime':
      return 'time';
    case 'sessionsPerCharge':
      return 'number';
    case 'packEnergy':
      return 'energy';
    case 'mass':
      return 'mass';
    case 'surfaceTemperature':
      return 'temperature';
  }
}

export function requirementExpressions(r: Requirement): MechExpressionSite[] {
  const { out, add } = sites();
  const kind = requirementKind(r.quantity);
  if (Array.isArray(r.value)) {
    (r.value as readonly StoredExpression[]).forEach((v, i) => add(['value', i], v, kind));
  } else add(['value'], r.value as StoredExpression, kind);
  // A tolerance on a temperature is a difference.
  add(['tolerance'], r.tolerance, kind === 'temperature' ? 'temperatureDelta' : kind);
  return out;
}

export function loadCaseExpressions(lc: LoadCase): MechExpressionSite[] {
  const { out, add } = sites();
  const d = lc.dynamic;
  if (d !== undefined) {
    const m = d.mode;
    switch (m.kind) {
      case 'eccentric':
        add(['dynamic', 'mode', 'factor'], m.factor, 'number');
        break;
      case 'band':
        add(['dynamic', 'mode', 'rate'], m.rate, 'stiffness');
        break;
      case 'chains':
        add(['dynamic', 'mode', 'rate'], m.rate, 'stiffness');
        add(['dynamic', 'mode', 'from'], m.from, 'length');
        break;
      case 'isokinetic':
        add(['dynamic', 'mode', 'speed'], m.speed, 'speed');
        break;
      case 'damper':
      case 'rowing':
        add(['dynamic', 'mode', 'coefficient'], m.coefficient, 'any');
        break;
      case 'isometric':
        add(['dynamic', 'mode', 'duration'], m.duration, 'time');
        break;
      default:
        break;
    }
    add(['dynamic', 'force'], d.force, 'force');
    if (d.motion.kind === 'half-cosine') {
      add(['dynamic', 'motion', 'stroke'], d.motion.stroke, 'length');
      add(['dynamic', 'motion', 'pullSpeed'], d.motion.pullSpeed, 'speed');
      add(['dynamic', 'motion', 'returnSpeed'], d.motion.returnSpeed, 'speed');
      add(['dynamic', 'motion', 'pause'], d.motion.pause, 'time');
    }
    add(['dynamic', 'reps'], d.reps, 'number');
    add(['dynamic', 'sets'], d.sets, 'number');
    add(['dynamic', 'rest'], d.rest, 'time');
    add(['dynamic', 'startCharge'], d.startCharge, 'number');
    add(['dynamic', 'ambient'], d.ambient, 'temperature');
  }
  (lc.static ?? []).forEach((s, i) => {
    switch (s.kind) {
      case 'cable':
        add(['static', i, 'force'], s.force, 'force');
        add(['static', i, 'angle'], s.angle, 'angle');
        add(['static', i, 'azimuth'], s.azimuth, 'angle');
        break;
      case 'point':
        add(['static', i, 'force'], s.force, 'force');
        break;
      case 'acceleration':
        add(['static', i, 'acceleration'], s.acceleration, 'acceleration');
        break;
    }
  });
  return out;
}

export function drivetrainExpressions(d: Drivetrain): MechExpressionSite[] {
  const { out, add } = sites();
  d.stages.forEach((s, i) => {
    if (s.kind === 'belt' || s.kind === 'gear' || s.kind === 'planetary') {
      if ('source' in s.ratio) add(['stages', i, 'ratio'], s.ratio, 'number');
      else {
        add(['stages', i, 'ratio', 'driver'], s.ratio.driver, 'number');
        add(['stages', i, 'ratio', 'driven'], s.ratio.driven, 'number');
      }
      add(['stages', i, 'efficiency'], s.efficiency, 'number');
    }
    add(['stages', i, 'inertia'], s.inertia, 'inertia');
  });
  const o = d.output;
  if (o.kind !== 'linear') add(['output', 'inertia'], o.inertia, 'inertia');
  if (o.kind === 'spool') {
    add(['output', 'length'], o.length, 'length');
    add(['output', 'core'], o.core, 'length');
    add(['output', 'flange'], o.flange, 'length');
    add(['output', 'width'], o.width, 'length');
    add(['output', 'fairlead', 'bendDiameter'], o.fairlead?.bendDiameter, 'length');
  } else if (o.kind === 'linear') {
    add(['output', 'lead'], o.lead, 'length');
    add(['output', 'efficiency'], o.efficiency, 'number');
  }
  return out;
}

export function purchasedExpressions(p: PurchasedUse): MechExpressionSite[] {
  const { out, add } = sites();
  add(['quantity'], p.quantity, 'number');
  return out;
}

export function studyExpressions(s: Study): MechExpressionSite[] {
  const { out, add } = sites();
  s.fixtures.forEach((f, i) => {
    if (f.kind === 'bolted') add(['fixtures', i, 'stiffness'], f.stiffness, 'stiffness');
  });
  s.loads.forEach((l, i) => {
    switch (l.kind) {
      case 'force':
      case 'bearing':
        add(['loads', i, 'force'], l.force, 'force');
        break;
      case 'pressure':
        add(['loads', i, 'pressure'], l.pressure, 'pressure');
        break;
      case 'torque':
        add(['loads', i, 'torque'], l.torque, 'torque');
        break;
      case 'simulated':
        break;
    }
  });
  add(['mesh', 'size'], s.mesh.size, 'length');
  return out;
}

export function checkOverrideExpressions(c: CheckOverride): MechExpressionSite[] {
  const { out, add } = sites();
  add(['factor'], c.factor, 'number');
  for (const [symbol, value] of Object.entries(c.inputs ?? {})) {
    if (typeof value === 'object') add(['inputs', symbol], value, 'any');
  }
  return out;
}

export function testBandExpressions(t: TestBand): MechExpressionSite[] {
  const { out, add } = sites();
  add(['low'], t.low, 'any');
  add(['high'], t.high, 'any');
  return out;
}

/** Every expression of one list item, with paths from the item. */
export function mechItemExpressions<K extends MechList>(
  list: K,
  item: MechListItems[K],
): MechExpressionSite[] {
  switch (list) {
    case 'requirements':
      return requirementExpressions(item as Requirement);
    case 'loadCases':
      return loadCaseExpressions(item as LoadCase);
    case 'drivetrains':
      return drivetrainExpressions(item as Drivetrain);
    case 'purchased':
      return purchasedExpressions(item as PurchasedUse);
    case 'studies':
      return studyExpressions(item as Study);
    case 'checks':
      return checkOverrideExpressions(item as CheckOverride);
    case 'testBands':
      return testBandExpressions(item as TestBand);
    default:
      return [];
  }
}

/** Every expression of the electrical system, with paths from it. */
export function electricalExpressions(e: Electrical | undefined): MechExpressionSite[] {
  const { out, add } = sites();
  if (e === undefined) return out;
  e.components.forEach((c, i) => {
    add(['components', i, 'load', 'current'], c.load?.current, 'current');
    add(['components', i, 'load', 'voltage'], c.load?.voltage, 'voltage');
  });
  e.harness.forEach((s, i) => {
    if ('source' in s.length) add(['harness', i, 'length'], s.length, 'length');
    else add(['harness', i, 'length', 'slack'], s.length.slack, 'length');
  });
  return out;
}

/** One expression of the section, with the item it belongs to. */
export interface MechSectionSite extends MechExpressionSite {
  /** The list, or `electrical`. */
  readonly collection: MechList | 'electrical';
  /** The item's id; for `electrical`, the component's or segment's. */
  readonly itemId: string;
}

/** Every expression of the section, list by list in schema order, then the electrical system. */
export function mechExpressions(mech: MechData | undefined): MechSectionSite[] {
  if (mech === undefined) return [];
  const out: MechSectionSite[] = [];
  for (const list of MECH_LISTS) {
    for (const item of mechItems(mech, list)) {
      for (const site of mechItemExpressions(list, item)) {
        out.push({ ...site, collection: list, itemId: item.id });
      }
    }
  }
  const e = mech.electrical;
  for (const site of electricalExpressions(e)) {
    const [key, i] = site.path as [string, number];
    const itemId = key === 'components' ? e!.components[i]!.id : e!.harness[i]!.id;
    out.push({ ...site, collection: 'electrical', itemId });
  }
  return out;
}

/** The document with `mech` replaced, dropping empty lists and an empty electrical system. */
export function withMech(
  doc: ManufaktureDocument,
  mech: MechData | undefined,
): ManufaktureDocument {
  const { mech: _old, ...rest } = doc;
  void _old;
  if (mech === undefined) return rest;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(mech)) {
    if (value === undefined) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    if (key === 'electrical') {
      const e = value as Electrical;
      if (e.components.length + e.connections.length + e.harness.length === 0) continue;
    }
    out[key] = value;
  }
  // A section that never allocated an id is no section at all.
  const counters = Object.keys((out.nextIds as Record<string, number> | undefined) ?? {});
  if (Object.keys(out).length === 1 && counters.length === 0) return rest;
  return { ...rest, mech: out as MechData };
}
