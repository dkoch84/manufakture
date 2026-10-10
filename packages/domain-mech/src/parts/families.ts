// The rating fields of each catalog family (ADR 0017 decision 7, T9.0c's field lists): what a
// purchased part of that family states, the `@manufakture/units` kind each number is read in, the
// conventions and bases a field must carry (decision 8), and which ratings a bill of materials line
// relies on, with the comparison a substitute must meet ("C at least 5.4 kN").
//
// Ratings are stored in coherent SI (core's `Rated.value`), dimensions in millimetres, mass in
// kilograms. Geometric sizes (a bearing's bore, a belt's pitch, a rope's diameter) are dimensions,
// not ratings, so every rating is a physical kind, a plain number, a count or a text.
//
// Each family's fields have a version (`fieldsVersion`): an entry written at an older version is
// migrated in memory by the family's migrations and written back only when the user edits it
// (decision 7, as ADR 0013 decision 4 does for params). Version 1 is the first; T9.2b to T9.2e
// add fields by raising it with a migration.

import { CATALOG_FAMILIES, type CatalogEntry } from '@manufakture/core';
import type { PhysicalKind } from '@manufakture/units';

export type CatalogFamily = (typeof CATALOG_FAMILIES)[number];

/** What a rating field holds: a physical kind (SI), a plain number, a whole count or a text. */
export type RatingKind = PhysicalKind | 'number' | 'count' | 'text';

/** How a bill of materials line states a rating a substitute must meet. */
export type RatingComparison = 'at-least' | 'at-most' | 'equals';

export interface RatingField {
  /** The stored key (`dynamicLoad`). */
  name: string;
  /** For people (`dynamic load rating C`). */
  label: string;
  /** The short symbol a BOM line uses (`C`); the label otherwise. */
  symbol?: string;
  kind: RatingKind;
  /** The allowed texts of a `text` field that is a choice; absent: free text. */
  options?: readonly string[];
  /** The conventions a value may be entered in (decision 8); the entry must say which. */
  conventions?: readonly string[];
  /** The value needs its test conditions (decision 8, the fields marked "basis"). */
  basis?: true;
  /** Shown on a BOM line with this comparison; absent: not on the BOM line. */
  bom?: RatingComparison;
  /** A unit for a `number` field whose quantity has no kind (`Ω/m`), shown next to it. */
  unit?: string;
}

/** The dimension names a placeholder reads, in millimetres. */
export const DIMENSION_NAMES = [
  'diameter',
  'length',
  'outerDiameter',
  'innerDiameter',
  'width',
  'height',
  'pitch',
  'module',
] as const;
export type DimensionName = (typeof DIMENSION_NAMES)[number];

export interface DimensionField {
  name: DimensionName;
  label: string;
  /** On the BOM line (always `equals`): a bearing's bore and outside diameter. */
  bom?: true;
}

export interface FamilySchema {
  family: CatalogFamily;
  label: string;
  /** The current version of the family's field schema. */
  fieldsVersion: number;
  fields: readonly RatingField[];
  dimensions: readonly DimensionField[];
  /** The placeholder solid an entry of this family gets when it names none. */
  placeholder: 'cylinder' | 'ring' | 'box';
}

const choice = (
  name: string,
  label: string,
  options: readonly string[],
  extra: Partial<RatingField> = {},
): RatingField => ({ name, label, kind: 'text', options, ...extra });

const dim = (name: DimensionName, label: string, bom?: true): DimensionField =>
  bom ? { name, label, bom } : { name, label };

const BOX: readonly DimensionField[] = [
  dim('length', 'length'),
  dim('width', 'width'),
  dim('height', 'height'),
];
const CYLINDER: readonly DimensionField[] = [dim('diameter', 'diameter'), dim('length', 'length')];

/** Every family's fields at their current version. */
export const FAMILY_SCHEMAS: readonly FamilySchema[] = [
  {
    family: 'motor',
    label: 'Motor',
    fieldsVersion: 1,
    placeholder: 'cylinder',
    dimensions: CYLINDER,
    fields: [
      choice('kind', 'kind', [
        'outrunner',
        'inrunner',
        'gimbal',
        'frameless',
        'hub',
        'geared actuator',
      ]),
      choice('winding', 'winding', ['wye', 'delta', 'unknown']),
      {
        name: 'kv',
        label: 'velocity constant Kv',
        symbol: 'Kv',
        kind: 'velocityConstant',
        conventions: ['line-to-line amplitude', 'line-to-line rms', 'line-to-line peak-to-peak'],
      },
      {
        name: 'kt',
        label: 'torque constant Kt',
        symbol: 'Kt',
        kind: 'torqueConstant',
        conventions: ['phase amplitude', 'phase rms', 'dc (six-step)'],
      },
      {
        name: 'resistance',
        label: 'winding resistance',
        symbol: 'R',
        kind: 'resistance',
        conventions: ['phase-neutral', 'line-to-line', 'delta winding'],
      },
      {
        name: 'inductance',
        label: 'winding inductance',
        symbol: 'L',
        kind: 'inductance',
        conventions: ['phase-neutral', 'line-to-line', 'delta winding'],
      },
      { name: 'polePairs', label: 'pole pairs', kind: 'count' },
      {
        name: 'ratedCurrent',
        label: 'rated current',
        kind: 'current',
        basis: true,
        bom: 'at-least',
      },
      { name: 'peakCurrent', label: 'peak current', kind: 'current', basis: true },
      {
        name: 'ratedTorque',
        label: 'rated torque',
        kind: 'torque',
        basis: true,
        bom: 'at-least',
      },
      { name: 'peakTorque', label: 'peak torque', kind: 'torque', basis: true, bom: 'at-least' },
      { name: 'noLoadSpeed', label: 'no-load speed', kind: 'angularSpeed', basis: true },
      { name: 'ratedSpeed', label: 'rated speed', kind: 'angularSpeed' },
      { name: 'maxVoltage', label: 'maximum voltage', kind: 'voltage', bom: 'at-least' },
      { name: 'rotorInertia', label: 'rotor inertia', kind: 'inertia' },
      {
        name: 'thermalResistance',
        label: 'thermal resistance, winding to ambient',
        kind: 'thermalResistance',
        basis: true,
      },
      { name: 'thermalTimeConstant', label: 'winding thermal time constant', kind: 'time' },
      { name: 'maxWindingTemperature', label: 'maximum winding temperature', kind: 'temperature' },
    ],
  },
  {
    family: 'controller',
    label: 'Motor controller',
    fieldsVersion: 1,
    placeholder: 'box',
    dimensions: BOX,
    fields: [
      { name: 'minBusVoltage', label: 'minimum bus voltage', kind: 'voltage' },
      {
        name: 'maxBusVoltage',
        label: 'absolute maximum bus voltage',
        kind: 'voltage',
        bom: 'at-least',
      },
      {
        name: 'continuousPhaseCurrent',
        label: 'continuous phase current',
        kind: 'current',
        basis: true,
        bom: 'at-least',
      },
      { name: 'peakPhaseCurrent', label: 'peak phase current', kind: 'current', basis: true },
      { name: 'busCurrentLimit', label: 'bus current limit', kind: 'current' },
      choice('regeneration', 'regeneration', ['to bus only', 'chopper on board', 'chopper output']),
      { name: 'loopRate', label: 'current loop rate', kind: 'frequency' },
      { name: 'pwmFrequency', label: 'PWM frequency', kind: 'frequency' },
      { name: 'maxElectricalFrequency', label: 'maximum electrical frequency', kind: 'frequency' },
    ],
  },
  {
    family: 'cell',
    label: 'Cell',
    fieldsVersion: 1,
    placeholder: 'cylinder',
    dimensions: CYLINDER,
    fields: [
      choice('chemistry', 'chemistry', ['NMC', 'NCA', 'LFP', 'LCO', 'other']),
      choice('format', 'format', ['18650', '21700', '26650', 'pouch', 'prismatic']),
      { name: 'capacity', label: 'capacity', kind: 'charge', bom: 'at-least' },
      { name: 'nominalVoltage', label: 'nominal voltage', kind: 'voltage', bom: 'equals' },
      { name: 'chargeVoltage', label: 'charge voltage', kind: 'voltage' },
      { name: 'cutoffVoltage', label: 'cutoff voltage', kind: 'voltage' },
      { name: 'maxChargeCurrent', label: 'maximum charge current', kind: 'current', basis: true },
      {
        name: 'continuousDischarge',
        label: 'continuous discharge current',
        kind: 'current',
        basis: true,
        bom: 'at-least',
      },
      { name: 'resistanceDC', label: 'DC internal resistance', kind: 'resistance', basis: true },
    ],
  },
  {
    family: 'pack',
    label: 'Battery pack',
    fieldsVersion: 1,
    placeholder: 'box',
    dimensions: BOX,
    fields: [
      { name: 'series', label: 'cells in series', kind: 'count' },
      { name: 'parallel', label: 'cells in parallel', kind: 'count' },
      { name: 'nominalVoltage', label: 'nominal voltage', kind: 'voltage', bom: 'equals' },
      { name: 'capacity', label: 'capacity', kind: 'charge', bom: 'at-least' },
      { name: 'energy', label: 'energy (nominal voltage x capacity)', kind: 'energy' },
      {
        name: 'continuousDischarge',
        label: 'continuous discharge current',
        kind: 'current',
        basis: true,
        bom: 'at-least',
      },
    ],
  },
  {
    family: 'bms',
    label: 'Battery management system',
    fieldsVersion: 1,
    placeholder: 'box',
    dimensions: BOX,
    fields: [
      { name: 'minCells', label: 'fewest cells', kind: 'count' },
      { name: 'maxCells', label: 'most cells', kind: 'count' },
      {
        name: 'continuousDischarge',
        label: 'continuous discharge current',
        kind: 'current',
        bom: 'at-least',
      },
      {
        name: 'continuousCharge',
        label: 'continuous charge current',
        kind: 'current',
        bom: 'at-least',
      },
      choice('balancing', 'balancing', ['passive', 'active', 'none']),
      { name: 'balanceCurrent', label: 'balancing current', kind: 'current' },
      { name: 'standbyCurrent', label: 'standby current', kind: 'current' },
    ],
  },
  {
    family: 'bearing',
    label: 'Bearing',
    fieldsVersion: 1,
    placeholder: 'ring',
    dimensions: [
      dim('innerDiameter', 'bore d', true),
      dim('outerDiameter', 'outside diameter D', true),
      dim('width', 'width B', true),
    ],
    fields: [
      choice('type', 'type', ['deep groove ball', 'angular contact', 'needle', 'bushing']),
      {
        name: 'dynamicLoad',
        label: 'dynamic load rating C',
        symbol: 'C',
        kind: 'force',
        bom: 'at-least',
      },
      {
        name: 'staticLoad',
        label: 'static load rating C0',
        symbol: 'C0',
        kind: 'force',
        bom: 'at-least',
      },
      { name: 'fatigueLimit', label: 'fatigue limit Pu', symbol: 'Pu', kind: 'force' },
      {
        name: 'limitingSpeed',
        label: 'limiting speed',
        symbol: 'n',
        kind: 'angularSpeed',
        bom: 'at-least',
      },
      { name: 'referenceSpeed', label: 'reference speed', kind: 'angularSpeed' },
      choice('closure', 'closure', ['open', 'shield', 'contact seal'], { bom: 'equals' }),
      choice('clearance', 'clearance', ['C2', 'CN', 'C3']),
    ],
  },
  {
    family: 'belt',
    label: 'Timing belt',
    fieldsVersion: 1,
    placeholder: 'box',
    dimensions: [dim('pitch', 'pitch', true), dim('width', 'width', true), dim('length', 'length')],
    fields: [
      choice(
        'profile',
        'profile',
        ['GT2', '3MGT', '5MGT', 'HTD 3M', 'HTD 5M', 'HTD 8M', 'T', 'MXL', 'XL'],
        { bom: 'equals' },
      ),
      {
        name: 'ratedWorkingTension',
        label: 'rated working tension',
        kind: 'force',
        basis: true,
        bom: 'at-least',
      },
      { name: 'breakingStrength', label: 'minimum breaking strength', kind: 'force' },
      choice('cord', 'cord', ['fibreglass', 'aramid', 'steel', 'carbon']),
      { name: 'minimumPulleyGrooves', label: 'fewest pulley grooves', kind: 'count' },
    ],
  },
  {
    family: 'pulley',
    label: 'Pulley',
    fieldsVersion: 1,
    placeholder: 'ring',
    dimensions: [
      dim('outerDiameter', 'outside diameter'),
      dim('innerDiameter', 'bore', true),
      dim('width', 'width'),
      dim('pitch', 'pitch', true),
    ],
    fields: [
      { name: 'grooves', label: 'grooves', kind: 'count', bom: 'equals' },
      choice(
        'profile',
        'profile',
        ['GT2', '3MGT', '5MGT', 'HTD 3M', 'HTD 5M', 'HTD 8M', 'T', 'MXL', 'XL'],
        { bom: 'equals' },
      ),
    ],
  },
  {
    family: 'gear',
    label: 'Gear',
    fieldsVersion: 1,
    placeholder: 'ring',
    dimensions: [
      dim('outerDiameter', 'outside diameter'),
      dim('innerDiameter', 'bore', true),
      dim('width', 'face width'),
      dim('module', 'module', true),
    ],
    fields: [
      { name: 'teeth', label: 'teeth', kind: 'count', bom: 'equals' },
      { name: 'pressureAngle', label: 'pressure angle (degrees)', kind: 'number' },
      { name: 'ratedTorque', label: 'rated torque', kind: 'torque', basis: true, bom: 'at-least' },
    ],
  },
  {
    family: 'rope',
    label: 'Rope or cable',
    fieldsVersion: 1,
    placeholder: 'cylinder',
    dimensions: [dim('diameter', 'diameter', true), dim('length', 'length')],
    fields: [
      choice('material', 'material', [
        'HMPE',
        'aramid',
        'polyester',
        'steel 7x7',
        'steel 7x19',
        'steel-core composite',
      ]),
      { name: 'construction', label: 'construction', kind: 'text' },
      {
        name: 'minimumBreakingLoad',
        label: 'minimum breaking load',
        kind: 'force',
        bom: 'at-least',
      },
      { name: 'averageBreakingLoad', label: 'average breaking load', kind: 'force' },
      { name: 'minimumBendRatio', label: 'minimum bend ratio D/d', kind: 'number' },
      { name: 'massPerLength', label: 'mass per length', kind: 'linearDensity' },
    ],
  },
  {
    family: 'wire',
    label: 'Wire',
    fieldsVersion: 1,
    placeholder: 'cylinder',
    dimensions: [dim('diameter', 'outer diameter'), dim('length', 'length')],
    fields: [
      { name: 'gauge', label: 'gauge (AWG or mm²)', kind: 'text', bom: 'equals' },
      {
        name: 'resistancePerLength',
        label: 'resistance per length at 20 °C',
        kind: 'number',
        unit: 'Ω/m',
      },
      choice('insulation', 'insulation', ['PVC', 'silicone', 'PTFE', 'other']),
      { name: 'voltageRating', label: 'voltage rating', kind: 'voltage', bom: 'at-least' },
      { name: 'ampacity', label: 'ampacity', kind: 'current', basis: true, bom: 'at-least' },
    ],
  },
  {
    family: 'connector',
    label: 'Connector',
    fieldsVersion: 1,
    placeholder: 'box',
    dimensions: BOX,
    fields: [
      { name: 'poles', label: 'poles', kind: 'count', bom: 'equals' },
      {
        name: 'continuousCurrent',
        label: 'continuous current',
        kind: 'current',
        basis: true,
        bom: 'at-least',
      },
      { name: 'voltageRating', label: 'voltage rating', kind: 'voltage', bom: 'at-least' },
      { name: 'contactResistance', label: 'contact resistance', kind: 'resistance' },
      { name: 'matingCycles', label: 'mating cycles', kind: 'count' },
    ],
  },
  {
    family: 'fuse',
    label: 'Fuse',
    fieldsVersion: 1,
    placeholder: 'box',
    dimensions: BOX,
    fields: [
      { name: 'rating', label: 'current rating', kind: 'current', bom: 'equals' },
      { name: 'voltageRating', label: 'DC voltage rating', kind: 'voltage', bom: 'at-least' },
      {
        name: 'interruptingRating',
        label: 'interrupting rating',
        kind: 'current',
        basis: true,
        bom: 'at-least',
      },
      choice('format', 'format', ['ATO', 'MINI', 'MAXI', 'MIDI', 'ANL', 'cartridge', 'PCB']),
      { name: 'timeCurrentClass', label: 'time-current class', kind: 'text' },
    ],
  },
  {
    family: 'switch',
    label: 'Switch or contactor',
    fieldsVersion: 1,
    placeholder: 'box',
    dimensions: BOX,
    fields: [
      choice('kind', 'kind', ['toggle', 'rocker', 'push', 'contactor', 'solid-state']),
      {
        name: 'continuousCurrent',
        label: 'continuous current',
        kind: 'current',
        bom: 'at-least',
      },
      { name: 'breakingCurrent', label: 'DC breaking current', kind: 'current', bom: 'at-least' },
      { name: 'voltageRating', label: 'DC voltage rating', kind: 'voltage', bom: 'at-least' },
      { name: 'electricalLife', label: 'electrical life (cycles)', kind: 'count' },
    ],
  },
  {
    family: 'resistor',
    label: 'Braking resistor',
    fieldsVersion: 1,
    placeholder: 'box',
    dimensions: BOX,
    fields: [
      { name: 'resistance', label: 'resistance', kind: 'resistance', bom: 'equals' },
      {
        name: 'continuousPower',
        label: 'continuous power',
        kind: 'power',
        basis: true,
        bom: 'at-least',
      },
      { name: 'pulseEnergy', label: 'pulse energy', kind: 'energy', basis: true },
      { name: 'thermalTimeConstant', label: 'thermal time constant', kind: 'time' },
      { name: 'voltageRating', label: 'voltage rating', kind: 'voltage', bom: 'at-least' },
    ],
  },
  {
    family: 'generic',
    label: 'Other purchased part',
    fieldsVersion: 1,
    placeholder: 'box',
    dimensions: [...BOX, dim('diameter', 'diameter'), dim('outerDiameter', 'outside diameter')],
    fields: [{ name: 'note', label: 'rating note', kind: 'text' }],
  },
];

const BY_FAMILY = new Map(FAMILY_SCHEMAS.map((s) => [s.family, s]));

/** The schema of a family (every family has one). */
export function familySchema(family: CatalogFamily): FamilySchema {
  return BY_FAMILY.get(family)!;
}

/** A field of a family by name, at the family's current version. */
export function ratingField(family: CatalogFamily, name: string): RatingField | undefined {
  return familySchema(family).fields.find((f) => f.name === name);
}

/**
 * One family's migration from `fieldsVersion` n to n + 1 of its ratings, pure. None yet: every
 * family is at version 1. T9.2b to T9.2e add theirs here as they raise a version.
 */
type RatingsMigration = (ratings: CatalogEntry['ratings']) => CatalogEntry['ratings'];
const MIGRATIONS: Partial<Record<CatalogFamily, readonly RatingsMigration[]>> = {};

export type ReadEntry =
  { ok: true; entry: CatalogEntry } | { ok: false; reason: 'newer-fields'; message: string };

/**
 * An entry with its ratings migrated in memory to the family's current fields version. An entry
 * written by a newer build (a higher `fieldsVersion`) is refused, never guessed at.
 */
export function migrateEntry(entry: CatalogEntry): ReadEntry {
  const schema = familySchema(entry.family);
  if (entry.fieldsVersion > schema.fieldsVersion) {
    return {
      ok: false,
      reason: 'newer-fields',
      message: `${entry.maker} ${entry.partNumber} is written in version ${entry.fieldsVersion} of the ${entry.family} fields; this build reads up to ${schema.fieldsVersion}`,
    };
  }
  let ratings = entry.ratings;
  const steps = MIGRATIONS[entry.family] ?? [];
  for (let v = entry.fieldsVersion; v < schema.fieldsVersion; v++) {
    const step = steps[v - 1];
    if (step !== undefined) ratings = step(ratings);
  }
  return {
    ok: true,
    entry:
      ratings === entry.ratings && entry.fieldsVersion === schema.fieldsVersion
        ? entry
        : { ...entry, ratings, fieldsVersion: schema.fieldsVersion },
  };
}

/** Bidirectional overrides and isolates (U+202A to U+202E, U+2066 to U+2069). */
const BIDI_CONTROL = /[\u202A-\u202E\u2066-\u2069]/;

/**
 * Whether a text holds a bidirectional override or isolate, which can make a short field show
 * other text than it holds (a part number read backwards). Short fields refuse them.
 */
export function hasBidiControl(text: string): boolean {
  return BIDI_CONTROL.test(text);
}

/**
 * The kinds a rating may hold below zero. Every other physical kind is a magnitude a datasheet
 * states (a load rating, a speed, a current, a voltage, a time), so a negative one is a typo.
 * `number` fields are left to their meaning.
 */
const SIGNED_KINDS: ReadonlySet<RatingKind> = new Set(['temperatureDelta', 'number']);

/** A problem with an entry's fields, against its family's schema. */
export interface FieldProblem {
  field: string;
  message: string;
}

/**
 * What is wrong with an entry's fields for its family (core checks only the shape): a rating the
 * family does not have, a number where a text is wanted or the other way round, a count that is
 * not whole, a physical value below zero, a choice outside its options, a convention outside the
 * field's list, a dimension the family does not read or that is not above zero, and a
 * bidirectional control character in a short text (the maker, the part number, a text rating, a
 * convention, the source's title and revision). Pure.
 */
export function entryProblems(entry: CatalogEntry): FieldProblem[] {
  const schema = familySchema(entry.family);
  const out: FieldProblem[] = [];
  const bidi = (field: string, text: string | undefined) => {
    if (text !== undefined && hasBidiControl(text)) {
      out.push({ field, message: 'a bidirectional control character' });
    }
  };
  bidi('maker', entry.maker);
  bidi('partNumber', entry.partNumber);
  // The first source's fields under the names the form and the CSV import give them.
  entry.sources.forEach((source, i) => {
    bidi(i === 0 ? 'sourceTitle' : `sources.${i}.title`, source.title);
    bidi(i === 0 ? 'sourceRevision' : `sources.${i}.revision`, source.revision);
  });
  for (const [name, rated] of Object.entries(entry.ratings)) {
    const field = schema.fields.find((f) => f.name === name);
    if (field === undefined) {
      out.push({ field: name, message: `a ${entry.family} has no rating "${name}"` });
      continue;
    }
    if ('unknown' in rated) continue;
    if ('text' in rated) {
      bidi(name, rated.text);
      if (field.kind !== 'text') {
        out.push({ field: name, message: `${field.label} is a number, not a text` });
      } else if (field.options !== undefined && !field.options.includes(rated.text)) {
        out.push({
          field: name,
          message: `${field.label} is one of ${field.options.join(', ')}, not "${rated.text}"`,
        });
      }
      continue;
    }
    if (field.kind === 'text') {
      out.push({ field: name, message: `${field.label} is a text, not a number` });
      continue;
    }
    if (field.kind === 'count' && (!Number.isInteger(rated.value) || rated.value < 0)) {
      out.push({ field: name, message: `${field.label} is a whole number` });
    } else if (!SIGNED_KINDS.has(field.kind) && rated.value < 0) {
      out.push({ field: name, message: `${field.label} is not below zero` });
    }
    bidi(`${name}.convention`, rated.convention);
    if (
      rated.convention !== undefined &&
      field.conventions !== undefined &&
      !field.conventions.includes(rated.convention)
    ) {
      out.push({
        field: name,
        message: `${field.label} is entered as ${field.conventions.join(', ')}, not "${rated.convention}"`,
      });
    }
  }
  for (const [name, rated] of Object.entries(entry.dimensions ?? {})) {
    if (!schema.dimensions.some((d) => d.name === name)) {
      out.push({
        field: `dimensions.${name}`,
        message: `a ${entry.family} has no dimension "${name}"`,
      });
      continue;
    }
    if ('text' in rated) {
      out.push({ field: `dimensions.${name}`, message: `a dimension is a length, not a text` });
    } else if ('value' in rated && !(rated.value > 0)) {
      out.push({ field: `dimensions.${name}`, message: `a dimension is above zero` });
    }
  }
  if (entry.mass !== undefined) {
    if ('text' in entry.mass) out.push({ field: 'mass', message: 'a mass is a number' });
    else if ('value' in entry.mass && !(entry.mass.value > 0)) {
      out.push({ field: 'mass', message: 'a mass is above zero' });
    }
  }
  return out;
}
