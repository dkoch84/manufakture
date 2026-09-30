import type { AngleUnit, LengthUnit } from '@manufakture/units';
import {
  FORMAT_TAG,
  FORMAT_VERSION,
  NAMING_SCHEME,
  type DisplayUnits,
  type Feature,
  type ManufaktureDocument,
  type Part,
  type StoredExpression,
} from './schema';

export const DEFAULT_UNITS: DisplayUnits = {
  length: { unit: 'mm' },
  angle: { unit: 'deg' },
};

export const DEFAULT_PART_ID = 'part#1';

export interface NewDocumentOptions {
  /** A unique, stable id (for example a UUID); core never generates ids from randomness. */
  readonly id: string;
  readonly name: string;
  readonly units?: DisplayUnits;
}

/** An empty document at the current format version, with one empty part. */
export function createDocument(options: NewDocumentOptions): ManufaktureDocument {
  return {
    format: FORMAT_TAG,
    version: FORMAT_VERSION,
    namingScheme: NAMING_SCHEME,
    id: options.id,
    name: options.name,
    units: options.units ?? DEFAULT_UNITS,
    variables: [],
    parts: [createPart(DEFAULT_PART_ID, 'Part 1')],
    nextIds: { part: 2 },
  };
}

export function createPart(id: string, name: string): Part {
  return { id, name, features: [], rollbackIndex: null, nextIds: {}, bodies: [] };
}

/**
 * The units a bare number means under these display units (ADR 0005 decision 5): the decimal
 * format's own unit, and `'in'` under `ft-in` and `in-fraction`.
 */
export function bareUnits(units: DisplayUnits): { lengthUnit: LengthUnit; angleUnit: AngleUnit } {
  const l = units.length.unit;
  return {
    lengthUnit: l === 'ft-in' || l === 'in-fraction' ? 'in' : l,
    angleUnit: units.angle.unit,
  };
}

/** A `StoredExpression` for text typed under the given display units. */
export function storedExpression(source: string, units: DisplayUnits): StoredExpression {
  return { source, ...bareUnits(units) };
}

export function findPart(doc: ManufaktureDocument, partId: string): Part | undefined {
  return doc.parts.find((p) => p.id === partId);
}

export function findFeature(part: Part, featureId: string): Feature | undefined {
  return part.features.find((f) => f.id === featureId);
}

/** Whether a feature is regenerated: not suppressed and before the rollback bar. */
export function isFeatureActive(part: Part, index: number): boolean {
  const f = part.features[index];
  if (!f || f.suppressed) return false;
  return part.rollbackIndex === null || index < part.rollbackIndex;
}
