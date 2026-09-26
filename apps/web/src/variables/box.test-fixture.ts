// A test document: a box whose sketch is dimensioned by #w and #d and extruded by #h, plus a
// fillet whose radius nothing else reads. Built through commands, so ids and counters are real.

import {
  applyCommand,
  createDocument,
  type Command,
  type ManufaktureDocument,
  type SketchFeature,
  type StoredExpression,
} from '@manufakture/core';

export const mm = (source: string): StoredExpression => ({
  source,
  lengthUnit: 'mm',
  angleUnit: 'deg',
});

function rectangle(): SketchFeature {
  const corners: [number, number][] = [
    [0, 0],
    [40, 0],
    [40, 25],
    [0, 25],
  ];
  return {
    id: 'sketch#1',
    kind: 'sketch',
    name: 'Sketch 1',
    suppressed: false,
    plane: { type: 'plane', origin: [0, 0, 0], normal: [0, 0, 1], xDir: [1, 0, 0] },
    entities: corners.map((start, i) => ({
      id: `e${i + 1}`,
      kind: 'line' as const,
      construction: false,
      start,
      end: corners[(i + 1) % 4]!,
    })),
    constraints: [
      { id: 'k1', kind: 'horizontal', line: 'e1' },
      { id: 'k2', kind: 'vertical', line: 'e2' },
      {
        id: 'k3',
        kind: 'distance',
        a: { entity: 'e1', at: 'start' },
        b: { entity: 'e1', at: 'end' },
        value: mm('#w'),
      },
      {
        id: 'k4',
        kind: 'distance',
        a: { entity: 'e2', at: 'start' },
        b: { entity: 'e2', at: 'end' },
        value: mm('#d'),
      },
    ],
  };
}

export function boxCommands(): Command[] {
  return [
    { type: 'setVariable', name: 'w', expression: mm('40 mm') },
    { type: 'setVariable', name: 'd', expression: mm('25 mm') },
    { type: 'setVariable', name: 'h', expression: mm('#d - 10mm') },
    { type: 'setVariable', name: 'r', expression: mm('2 mm') },
    { type: 'addFeature', partId: 'part#1', feature: rectangle() },
    {
      type: 'addFeature',
      partId: 'part#1',
      feature: {
        id: 'extrude#1',
        kind: 'extrude',
        name: 'Extrude 1',
        suppressed: false,
        profile: { sketch: 'sketch#1' },
        operation: 'new',
        extent: { type: 'blind', distance: mm('#h') },
        reverse: false,
      },
    },
    {
      type: 'addFeature',
      partId: 'part#1',
      feature: {
        id: 'fillet#1',
        kind: 'fillet',
        name: 'Fillet 1',
        suppressed: false,
        edges: [{ id: 'r1', ref: { faces: ['extrude#1:cap:end', 'extrude#1:side:e1'] } }],
        radius: mm('#r'),
      },
    },
  ];
}

export function boxDocument(): ManufaktureDocument {
  let doc = createDocument({ id: 'box', name: 'Box' });
  for (const c of boxCommands()) {
    const r = applyCommand(doc, c);
    if (!r.ok) throw new Error(r.error.message);
    doc = r.value.document;
  }
  return doc;
}
