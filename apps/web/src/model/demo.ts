// The demo part as a document, for the `?scene=demo` test scene (see scenes.ts): a 60 x 40 x 20
// mm block from (-30, -20, 0) to (30, 20, 20), every edge filleted at 3 mm, with a through hole
// of radius 8 on the z axis. It is built by the regen engine like any user's part, so its faces
// and edges carry real names.

import {
  applyCommand,
  createDocument,
  type Command,
  type EdgeReference,
  type Feature,
  type ManufaktureDocument,
  type SketchFeature,
  type StoredExpression,
} from '@manufakture/core';

export const DEMO_PART_NAME = 'Demo part';

const mm = (source: string): StoredExpression => ({ source, lengthUnit: 'mm', angleUnit: 'deg' });

/** The block's outline: e1 front, e2 right, e3 back, e4 left, counter-clockwise from above. */
function outline(): SketchFeature {
  const corners: [number, number][] = [
    [-30, -20],
    [30, -20],
    [30, 20],
    [-30, 20],
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
      ...[1, 2, 3, 4].map((i) => ({
        id: `k${i}`,
        kind: 'coincident' as const,
        a: { entity: `e${i}`, at: 'end' as const },
        b: { entity: `e${(i % 4) + 1}`, at: 'start' as const },
      })),
      { id: 'k5', kind: 'horizontal', line: 'e1' },
      { id: 'k6', kind: 'horizontal', line: 'e3' },
      { id: 'k7', kind: 'vertical', line: 'e2' },
      { id: 'k8', kind: 'vertical', line: 'e4' },
    ],
  };
}

/** Every edge of the extruded block, by the names of its two faces. */
function blockEdges(): EdgeReference[] {
  const side = (i: number) => `extrude#1:side:e${i}`;
  const pairs: [string, string][] = [];
  for (let i = 1; i <= 4; i++) {
    pairs.push(['extrude#1:cap:end', side(i)], ['extrude#1:cap:start', side(i)]);
    pairs.push([side(i), side((i % 4) + 1)]);
  }
  return pairs.map((faces, i) => ({ id: `r${i + 1}`, ref: { faces: [...faces].sort() } }));
}

export function demoFeatures(): Feature[] {
  return [
    outline(),
    {
      id: 'extrude#1',
      kind: 'extrude',
      name: 'Extrude 1',
      suppressed: false,
      profile: { sketch: 'sketch#1' },
      operation: 'new',
      extent: { type: 'blind', distance: mm('20') },
      reverse: false,
    },
    {
      id: 'fillet#1',
      kind: 'fillet',
      name: 'Fillet 1',
      suppressed: false,
      edges: blockEdges(),
      radius: mm('3'),
    },
    {
      id: 'sketch#2',
      kind: 'sketch',
      name: 'Sketch 2',
      suppressed: false,
      // Below the block, so the cut's end faces never coincide with the block's.
      plane: { type: 'plane', origin: [0, 0, -5], normal: [0, 0, 1], xDir: [1, 0, 0] },
      entities: [{ id: 'e5', kind: 'circle', construction: false, center: [0, 0], radius: 8 }],
      constraints: [],
    },
    {
      id: 'extrude#2',
      kind: 'extrude',
      name: 'Hole',
      suppressed: false,
      profile: { sketch: 'sketch#2' },
      operation: 'cut',
      extent: { type: 'blind', distance: mm('30') },
      reverse: false,
    },
  ];
}

export function demoDocument(id = 'demo'): ManufaktureDocument {
  const base = createDocument({ id, name: 'Demo' });
  let doc: ManufaktureDocument = {
    ...base,
    parts: base.parts.map((p) => ({ ...p, name: DEMO_PART_NAME })),
  };
  for (const feature of demoFeatures()) {
    const command: Command = { type: 'addFeature', partId: 'part#1', feature };
    const r = applyCommand(doc, command);
    if (!r.ok) throw new Error(`The demo document is invalid: ${r.error.message}`);
    doc = r.value.document;
  }
  return doc;
}
