// The drawer-slides scenario's cabinet (M8 plan T8.6a): packages/session's cabinet (the one the
// authoring guide uses), made 22" deep by commands. The guide's cabinet is a bookshelf 11-1/4"
// deep, and an 18" slide does not fit in it (the scenario's test shows that on the guide's
// cabinet first). Here every sketch coordinate at the old depth moves to the new one: the sides'
// depth, the fixed panels' depth (to the back's front face) and the back's plane.

import {
  applyCommand,
  type Command,
  type Feature,
  type ManufaktureDocument,
} from '@manufakture/core';
import { CABINET, PART, cabinetDocument } from '@manufakture/session/test-fixtures';

export const BASE_CABINET = { ...CABINET, depth: 22 };
export const BASE_CABINET_ID = 'doc-base-cabinet';

const inch = (x: number) => x * 25.4;
const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;

type Sketch = Extract<Feature, { kind: 'sketch' }>;
type Line = { kind: 'line'; start: [number, number]; end: [number, number] };

/** `sketch` with every line coordinate on axis `axis` equal to `from` set to `to`. */
function moved(sketch: Sketch, axis: 0 | 1, from: number, to: number): Sketch {
  const point = (p: [number, number]): [number, number] => {
    const q: [number, number] = [p[0], p[1]];
    if (near(q[axis], from)) q[axis] = to;
    return q;
  };
  return {
    ...sketch,
    entities: sketch.entities.map((e) => {
      if (e.kind !== 'line') return e;
      const l = e as unknown as Line;
      return { ...e, start: point(l.start), end: point(l.end) };
    }) as Sketch['entities'],
  };
}

function apply(doc: ManufaktureDocument, command: unknown): ManufaktureDocument {
  const r = applyCommand(doc, command as Command);
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value.document;
}

/** The base cabinet: the guide's cabinet, 22" deep, as its own document. */
export function baseCabinetDocument(): ManufaktureDocument {
  const { depth: D, back: b } = CABINET;
  const D2 = BASE_CABINET.depth;
  let doc: ManufaktureDocument = { ...cabinetDocument(), id: BASE_CABINET_ID };
  doc = apply(doc, { type: 'renameDocument', name: 'Base cabinet' });
  const part = doc.parts.find((p) => p.id === PART)!;
  const sketch = (id: string) => part.features.find((f) => f.id === id) as Sketch;
  const edits: Sketch[] = [
    // The sides: sketch x is world Y.
    moved(sketch('sketch#1'), 0, inch(D), inch(D2)),
    moved(sketch('sketch#2'), 0, inch(D), inch(D2)),
    // Bottom, top and shelf: sketch y is world Y, up to the back's front face.
    moved(sketch('sketch#3'), 1, inch(D - b), inch(D2 - b)),
    moved(sketch('sketch#4'), 1, inch(D - b), inch(D2 - b)),
    moved(sketch('sketch#5'), 1, inch(D - b), inch(D2 - b)),
  ];
  const back = sketch('sketch#6');
  const plane = back.plane as unknown as { origin: [number, number, number] };
  edits.push({
    ...back,
    plane: { ...back.plane, origin: [plane.origin[0], inch(D2), plane.origin[2]] },
  } as Sketch);
  for (const feature of edits) doc = apply(doc, { type: 'editFeature', partId: PART, feature });
  return doc;
}
