import type { AngleUnit, LengthUnit } from '@manufakture/units';
import {
  FORMAT_TAG,
  FORMAT_VERSION,
  NAMING_SCHEME,
  type Assembly,
  type CamData,
  type CamSetup,
  type CamTool,
  type DisplayUnits,
  type DocumentFont,
  type Drawing,
  type Feature,
  type ManufaktureDocument,
  type Part,
  type PrintData,
  type PrintSetup,
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
    assemblies: [],
    print: createPrintData(),
    fonts: [],
    cam: createCamData(),
    nextIds: { part: 2 },
  };
}

export function createPart(id: string, name: string): Part {
  return { id, name, features: [], rollbackIndex: null, nextIds: {}, bodies: [] };
}

/** An empty assembly: no instances, no mates, fresh counters. */
export function createAssembly(id: string, name: string): Assembly {
  return { id, name, instances: [], mates: [], nextIds: {} };
}

/** An empty drawing: no sheets, fresh counters. */
export function createDrawing(id: string, name: string): Drawing {
  return { id, name, sheets: [], nextIds: {} };
}

/** An empty print section: no setups, fresh counters. */
export function createPrintData(): PrintData {
  return { setups: [], nextIds: {} };
}

/** An empty CAM section: no tools, no setups, fresh counters. */
export function createCamData(): CamData {
  return { tools: [], setups: [], nextIds: {} };
}

/**
 * A CAM setup of part `part` with no operations: stock from the body's bounds with no margins,
 * Z up, origin at the front left of the stock top, and the given heights as expressions in
 * millimetres. The app fills in its own defaults (margins, the default machine) before adding it.
 */
export function createCamSetup(
  id: string,
  name: string,
  part: string,
  machine: string,
  post: string,
): CamSetup {
  const zero = { source: '0', lengthUnit: 'mm', angleUnit: 'deg' } as const;
  return {
    id,
    name,
    part,
    machine,
    post,
    stock: {
      kind: 'fromBody',
      margins: { xMin: zero, xMax: zero, yMin: zero, yMax: zero, top: zero, bottom: zero },
    },
    wcs: { up: { kind: 'axis', axis: '+z' }, origin: { xy: 'front-left', z: 'top' } },
    heights: {
      clearance: { ...zero, source: '10' },
      retract: { ...zero, source: '5' },
    },
    operations: [],
  };
}

/** A print setup with no items and default thresholds. */
export function createPrintSetup(
  id: string,
  name: string,
  printer: string,
  nozzle: number,
): PrintSetup {
  return { id, name, printer, nozzle, items: [] };
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

export function findAssembly(doc: ManufaktureDocument, assemblyId: string): Assembly | undefined {
  return doc.assemblies.find((a) => a.id === assemblyId);
}

export function findDrawing(doc: ManufaktureDocument, drawingId: string): Drawing | undefined {
  return doc.drawings?.find((d) => d.id === drawingId);
}

export function findFont(doc: ManufaktureDocument, fontId: string): DocumentFont | undefined {
  return doc.fonts.find((f) => f.id === fontId);
}

export function findPrintSetup(doc: ManufaktureDocument, setupId: string): PrintSetup | undefined {
  return doc.print.setups.find((s) => s.id === setupId);
}

export function findCamSetup(doc: ManufaktureDocument, setupId: string): CamSetup | undefined {
  return doc.cam.setups.find((s) => s.id === setupId);
}

export function findCamTool(doc: ManufaktureDocument, toolId: string): CamTool | undefined {
  return doc.cam.tools.find((t) => t.id === toolId);
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
