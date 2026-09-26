import { applyCommand, type Command } from './commands';
import { createDocument } from './document';
import type { CoreResult } from './result';
import type {
  ExtrudeFeature,
  Feature,
  FilletFeature,
  ManufaktureDocument,
  SketchFeature,
  StoredExpression,
} from './schema';

/** Test-only helpers; not exported from the package. */

export const PART = 'part#1';

export function mm(source: string): StoredExpression {
  return { source, lengthUnit: 'mm', angleUnit: 'deg' };
}

export function unwrap<T>(r: CoreResult<T>): T {
  if (!r.ok) throw new Error(`Expected ok, got ${r.error.code}: ${r.error.message}`);
  return r.value;
}

/** Freezes an object graph so a test fails loudly if code under test mutates it. */
export function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function rectangleSketch(): SketchFeature {
  return {
    id: 'sketch#1',
    kind: 'sketch',
    name: 'Sketch 1',
    suppressed: false,
    plane: { type: 'plane', origin: [0, 0, 0], normal: [0, 0, 1], xDir: [1, 0, 0] },
    entities: [
      { id: 'e1', kind: 'line', construction: false, start: [0, 0], end: [40, 0] },
      { id: 'e2', kind: 'line', construction: false, start: [40, 0], end: [40, 20] },
      { id: 'e3', kind: 'line', construction: false, start: [40, 20], end: [0, 20] },
      { id: 'e4', kind: 'line', construction: false, start: [0, 20], end: [0, 0] },
    ],
    constraints: [
      {
        id: 'k1',
        kind: 'coincident',
        a: { entity: 'e1', at: 'end' },
        b: { entity: 'e2', at: 'start' },
      },
      { id: 'k2', kind: 'horizontal', line: 'e1' },
      {
        id: 'k3',
        kind: 'distance',
        a: { entity: 'e1', at: 'start' },
        b: { entity: 'e1', at: 'end' },
        value: mm('width'),
      },
      {
        id: 'k4',
        kind: 'distance',
        a: { entity: 'e2', at: 'start' },
        b: { entity: 'e2', at: 'end' },
        value: mm('height'),
      },
      { id: 'k5', kind: 'coincident', a: { entity: 'e1', at: 'start' }, b: { entity: '@origin' } },
    ],
  };
}

export function baseExtrude(): ExtrudeFeature {
  return {
    id: 'extrude#1',
    kind: 'extrude',
    name: 'Extrude 1',
    suppressed: false,
    profile: { sketch: 'sketch#1' },
    operation: 'new',
    extent: { type: 'blind', distance: mm('thickness') },
    reverse: false,
  };
}

export function holeSketch(): SketchFeature {
  return {
    id: 'sketch#2',
    kind: 'sketch',
    name: 'Sketch 2',
    suppressed: false,
    plane: { type: 'face', face: { id: 'r1', ref: { face: 'extrude#1:cap:end' } } },
    entities: [{ id: 'e5', kind: 'circle', construction: false, center: [20, 10], radius: 3 }],
    constraints: [{ id: 'k6', kind: 'diameter', entity: 'e5', value: mm('6mm') }],
  };
}

export function holeCut(): ExtrudeFeature {
  return {
    id: 'extrude#2',
    kind: 'extrude',
    name: 'Extrude 2',
    suppressed: false,
    profile: { sketch: 'sketch#2' },
    operation: 'cut',
    extent: { type: 'throughAll' },
    reverse: false,
  };
}

export function cornerFillet(): FilletFeature {
  return {
    id: 'fillet#1',
    kind: 'fillet',
    name: 'Fillet 1',
    suppressed: false,
    edges: [{ id: 'r2', ref: { faces: ['extrude#1:side:e1', 'extrude#1:side:e2'] } }],
    radius: mm('2mm'),
  };
}

/** The commands that build the bracket, in order. */
export function bracketCommands(): Command[] {
  const add = (feature: Feature): Command => ({ type: 'addFeature', partId: PART, feature });
  return [
    { type: 'setVariable', name: 'thickness', expression: mm('6mm') },
    { type: 'setVariable', name: 'width', expression: mm('40') },
    { type: 'setVariable', name: 'height', expression: mm('width / 2') },
    add(rectangleSketch()),
    add(baseExtrude()),
    add(holeSketch()),
    add(holeCut()),
    add(cornerFillet()),
  ];
}

/**
 * A plate with a hole and a filleted corner: sketch#1, extrude#1, sketch#2 (on the top cap),
 * extrude#2 (a through cut), fillet#1. Built through commands, so counters are real.
 */
export function bracket(): ManufaktureDocument {
  let doc = createDocument({ id: 'doc-1', name: 'Bracket' });
  for (const c of bracketCommands()) doc = unwrap(applyCommand(doc, c)).document;
  return doc;
}

export function featureIds(doc: ManufaktureDocument, part = 0): string[] {
  return doc.parts[part]!.features.map((f) => f.id);
}
