// The heat-set inserts scenario's document (M8 plan T8.6b): a printed enclosure, built from core
// commands like packages/session's test fixtures.
//
// One part, two bodies:
// - the base (`extrude#1`): an 80 x 60 x 40 mm box (sketch#1, extrude#1) shelled 2 mm with its top
//   open (shell#1), and four round lid bosses (sketch#2, extrude#2 added to the base), 7 mm across,
//   standing on the floor (z = 2) up to the rim (z = 40), centred 8 mm in from each corner;
// - the lid (`extrude#3`): a 2 mm plate on the rim (z = 40 to 42), with four screw holes over the
//   bosses (sketch#4, hole#1) at 3.0 mm, which is the screw's own size: a screw does not pass.
//
// So the bosses are plain (nothing drilled in them yet) and the lid holes are too tight: exactly
// the state the request "put M3 heat-set inserts in the four lid bosses and make the lid screw
// holes clear" starts from. The bosses are 7 mm across, a common size for self-tapping screws:
// with a 4.0 mm insert hole their wall is 1.5 mm, under the 1.6 mm the insert's vendor asks for.

import {
  applyCommand,
  createDocument,
  type Command,
  type ManufaktureDocument,
} from '@manufakture/core';

export const ENCLOSURE_ID = 'doc-enclosure';
export const PART = 'part#1';
/** Outside of the box, mm. */
export const BOX = { length: 80, width: 60, height: 40, wall: 2, lid: 2 } as const;
/** The bosses: centres (x, y) in mm, radius, and where they stand. */
export const BOSSES = {
  centres: [
    [8, 8],
    [72, 8],
    [8, 52],
    [72, 52],
  ] as [number, number][],
  radius: 3.5,
  /** Entity ids of the boss circles in sketch#2, in the order of `centres`. */
  entities: ['e5', 'e6', 'e7', 'e8'],
  bottom: 2,
  top: 40,
} as const;
/** The lid holes as the fixture has them: the screw's own size, so not clear. */
export const LID_HOLE = { diameter: 3, entities: ['e13', 'e14', 'e15', 'e16'] } as const;

const mm = (v: number | string) => ({ source: `${v} mm`, lengthUnit: 'mm', angleUnit: 'deg' });

const line = (id: string, a: [number, number], b: [number, number]) => ({
  id,
  kind: 'line',
  construction: false,
  start: a,
  end: b,
});

const rectangle = (first: number, l: number, w: number) => {
  const c: [number, number][] = [
    [0, 0],
    [l, 0],
    [l, w],
    [0, w],
  ];
  return c.map((start, i) => line(`e${first + i}`, start, c[(i + 1) % 4]!));
};

const feature = (f: Record<string, unknown>) => ({
  type: 'addFeature',
  partId: PART,
  feature: { suppressed: false, ...f },
});

const plane = (z: number) => ({
  type: 'plane',
  origin: [0, 0, z],
  normal: [0, 0, 1],
  xDir: [1, 0, 0],
});

export function enclosureCommands(): unknown[] {
  const { length: L, width: W, height: H, wall, lid } = BOX;
  return [
    { type: 'renamePart', partId: PART, name: 'Enclosure' },
    feature({
      id: 'sketch#1',
      kind: 'sketch',
      name: 'Box outline',
      plane: plane(0),
      entities: rectangle(1, L, W),
      constraints: [],
    }),
    feature({
      id: 'extrude#1',
      kind: 'extrude',
      name: 'Box',
      profile: { sketch: 'sketch#1' },
      operation: 'new',
      extent: { type: 'blind', distance: mm(H) },
      reverse: false,
    }),
    feature({
      id: 'shell#1',
      kind: 'shell',
      name: 'Hollow the box',
      faces: [{ id: 'r1', ref: { face: 'extrude#1:cap:end' } }],
      thickness: mm(wall),
      outward: false,
    }),
    feature({
      id: 'sketch#2',
      kind: 'sketch',
      name: 'Lid boss outlines',
      plane: plane(BOSSES.bottom),
      entities: BOSSES.centres.map((center, i) => ({
        id: BOSSES.entities[i],
        kind: 'circle',
        construction: false,
        center,
        radius: BOSSES.radius,
      })),
      constraints: [],
    }),
    feature({
      id: 'extrude#2',
      kind: 'extrude',
      name: 'Lid bosses',
      profile: { sketch: 'sketch#2' },
      operation: 'add',
      extent: { type: 'blind', distance: mm(BOSSES.top - BOSSES.bottom) },
      reverse: false,
      scope: ['extrude#1'],
    }),
    feature({
      id: 'sketch#3',
      kind: 'sketch',
      name: 'Lid outline',
      plane: plane(H),
      entities: rectangle(9, L, W),
      constraints: [],
    }),
    feature({
      id: 'extrude#3',
      kind: 'extrude',
      name: 'Lid',
      profile: { sketch: 'sketch#3' },
      operation: 'new',
      extent: { type: 'blind', distance: mm(lid) },
      reverse: false,
    }),
    feature({
      id: 'sketch#4',
      kind: 'sketch',
      name: 'Lid screw centres',
      plane: plane(H + lid),
      entities: BOSSES.centres.map((position, i) => ({
        id: LID_HOLE.entities[i],
        kind: 'point',
        construction: false,
        position,
      })),
      constraints: [],
    }),
    feature({
      id: 'hole#1',
      kind: 'hole',
      name: 'Lid screw holes',
      sketch: 'sketch#4',
      points: [...LID_HOLE.entities],
      diameter: mm(LID_HOLE.diameter),
      extent: { type: 'throughAll' },
      head: { type: 'simple' },
      scope: ['extrude#3'],
    }),
  ];
}

/** The enclosure as a document, on Main of a new library entry. */
export function enclosureDocument(): ManufaktureDocument {
  let doc = createDocument({ id: ENCLOSURE_ID, name: 'Enclosure' });
  for (const c of enclosureCommands()) {
    const r = applyCommand(doc, c as Command);
    if (!r.ok) throw new Error(`enclosure: ${r.error.code}: ${r.error.message}`);
    doc = r.value.document;
  }
  return doc;
}
