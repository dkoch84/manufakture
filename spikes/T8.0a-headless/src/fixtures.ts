// The three documents the spike opens, built from core commands (so they are valid and their id
// counters are real), and the batches applied to them. Node only: the bookshelf and the shed come
// from the app's e2e fixtures, read in place, and the browser half is handed the serialized
// documents, so both sides regenerate exactly the same input.
//
// - **bracket**: the M1 bracket (apps/web/e2e/bracket.ts, docs/m1-acceptance.md), written here
//   as the commands its UI walkthrough ends with: `#thickness`, the L-profile on Front (XZ)
//   extruded 30 mm symmetric, two M4 counterbored holes from a sketch on the foot's top face, a
//   4 mm fillet on the inside corner. Plus, as the first batch, a text engraved into the
//   upright's outer face with the bundled Inter Bold: the text features and fonts the plan asks
//   for.
// - **bookshelf**: the M4 acceptance cabinet (apps/web/e2e/m4-fixtures.ts): twelve boards, sixteen
//   joints, a configuration table, and its assembly of one instance per board.
// - **shed**: the 12' x 16' shed of T6.3a (apps/web/e2e/shed-fixture.ts), the M6 drawing set's
//   model: four walls, two windows, a door, a floor on skids and a gable roof.

import {
  applyCommand,
  createDocument,
  type Command,
  type ManufaktureDocument,
  type StoredExpression,
} from '../../../packages/core/src/index';
import { INTER_BOLD } from '../../../packages/text/src/index';
import {
  INCH_UNITS,
  SHELF,
  assemblyCommands,
  boardFeature,
  boardNames,
  BOARDS,
  carcassSketches,
  configurationCommands,
  frameSketch,
  jointFeature,
  JOINTS,
} from '../../../apps/web/e2e/m4-fixtures';
import { FT_IN_UNITS, SHED } from '../../../apps/web/e2e/shed-fixture';

export type FixtureName = 'bracket' | 'bookshelf' | 'shed';
export const FIXTURES: readonly FixtureName[] = ['bracket', 'bookshelf', 'shed'];

export interface Batch {
  label: string;
  command: Command;
}

const PART = 'part#1';
const mm = (source: string | number): StoredExpression => ({
  source: String(source),
  lengthUnit: 'mm',
  angleUnit: 'deg',
});
const inch = (source: string | number): StoredExpression => ({
  source: String(source),
  lengthUnit: 'in',
  angleUnit: 'deg',
});

function build(id: string, name: string, commands: readonly unknown[]): ManufaktureDocument {
  let doc = createDocument({ id, name });
  for (const c of commands) {
    const r = applyCommand(doc, c as Command);
    if (!r.ok) throw new Error(`${id}: ${r.error.code}: ${r.error.message}`);
    doc = r.value.document;
  }
  return doc;
}

// The M1 bracket ---------------------------------------------------------------------------

/** docs/m1-acceptance.md: foot 50 along X, upright 40 up Z, 30 wide, M4 counterbores, 4 mm fillet. */
export const BRACKET = { length: 50, height: 40, width: 30, fillet: 4, holes: [25, 40] as const };

/** Exact volume (mm3) of the bracket for a wall thickness `t`, as apps/web/e2e/bracket.ts has it. */
export function bracketVolume(t: number): number {
  const { length, height, width, fillet } = BRACKET;
  const extruded = width * (length * t + (height - t) * t);
  const oneHole = Math.PI * (4 * 4 * 4.4 + 2.25 * 2.25 * (t - 4.4));
  return extruded - 2 * oneHole + width * fillet * fillet * (1 - Math.PI / 4);
}

/** The L-profile on Front (XZ): e1 the foot's underside from the origin, then round the outline. */
function profileSketch(): unknown {
  const { length: L, height: H } = BRACKET;
  const t = 6;
  const pts: [number, number][] = [
    [0, 0],
    [L, 0],
    [L, t],
    [t, t],
    [t, H],
    [0, H],
  ];
  const ids = pts.map((_, i) => `e${i + 1}`);
  let k = 0;
  const kid = () => `k${++k}`;
  return {
    id: 'sketch#1',
    kind: 'sketch',
    name: 'Sketch 1',
    suppressed: false,
    plane: { type: 'plane', origin: [0, 0, 0], normal: [0, -1, 0], xDir: [1, 0, 0] },
    entities: pts.map((p, i) => ({
      id: ids[i],
      kind: 'line',
      construction: false,
      start: p,
      end: pts[(i + 1) % pts.length],
    })),
    constraints: [
      ...ids.map((e, i) => ({
        id: kid(),
        kind: 'coincident',
        a: { entity: e, at: 'end' },
        b: { entity: ids[(i + 1) % ids.length], at: 'start' },
      })),
      { id: kid(), kind: 'coincident', a: { entity: 'e1', at: 'start' }, b: { entity: '@origin' } },
      ...['e1', 'e3', 'e5'].map((line) => ({ id: kid(), kind: 'horizontal', line })),
      ...['e2', 'e4', 'e6'].map((line) => ({ id: kid(), kind: 'vertical', line })),
      ...(
        [
          ['e1', String(L)],
          ['e6', String(H)],
          ['e2', '#thickness'],
          ['e5', '#thickness'],
        ] as const
      ).map(([e, v]) => ({
        id: kid(),
        kind: 'distance',
        a: { entity: e, at: 'start' },
        b: { entity: e, at: 'end' },
        value: mm(v),
      })),
    ],
  };
}

/** The bracket's document as the M1 walkthrough leaves it. */
export function bracketDocument(): ManufaktureDocument {
  const add = (feature: unknown) => ({ type: 'addFeature', partId: PART, feature });
  return build('m1-bracket', 'M1 bracket', [
    { type: 'setVariable', name: 'thickness', expression: mm(6) },
    add(profileSketch()),
    add({
      id: 'extrude#1',
      kind: 'extrude',
      name: 'Extrude 1',
      suppressed: false,
      profile: { sketch: 'sketch#1' },
      operation: 'new',
      extent: { type: 'symmetric', distance: mm(BRACKET.width) },
      reverse: false,
    }),
    // On the foot's top face (swept by e3); a face sketch's frame is the world origin projected,
    // x along world X, so the hole centres are at sketch (25, 0) and (40, 0).
    add({
      id: 'sketch#2',
      kind: 'sketch',
      name: 'Sketch 2',
      suppressed: false,
      plane: { type: 'face', face: { id: 'r1', ref: { face: 'extrude#1:side:e3' } } },
      entities: BRACKET.holes.map((x, i) => ({
        id: `e${7 + i}`,
        kind: 'point',
        construction: false,
        position: [x, 0],
      })),
      constraints: [],
    }),
    add({
      id: 'hole#1',
      kind: 'hole',
      name: 'Hole 1',
      suppressed: false,
      sketch: 'sketch#2',
      points: ['e7', 'e8'],
      diameter: mm(4.5),
      extent: { type: 'throughAll' },
      head: { type: 'counterbore', diameter: mm(8), depth: mm(4.4) },
      standard: { size: 'M4', fit: 'normal' },
    }),
    add({
      id: 'fillet#1',
      kind: 'fillet',
      name: 'Fillet 1',
      suppressed: false,
      // The inside corner: between the foot's top (e3) and the upright's inner face (e4).
      edges: [{ id: 'r2', ref: { faces: ['extrude#1:side:e3', 'extrude#1:side:e4'] } }],
      radius: mm(BRACKET.fillet),
    }),
  ]);
}

/** Engrave `text` 0.6 mm into the upright's outer face (x = 0, swept by e6), with Inter Bold. */
export function engraveBatch(text: string): Batch {
  return {
    label: 'Engrave the part number',
    command: {
      type: 'batch',
      commands: [
        {
          type: 'addFont',
          font: {
            id: 'font#1',
            family: 'Inter',
            style: 'Bold',
            source: { kind: 'bundled', id: INTER_BOLD.id, sha256: INTER_BOLD.sha256 },
          },
        },
        {
          type: 'addFeature',
          partId: PART,
          feature: {
            id: 'sketch#3',
            kind: 'sketch',
            name: 'Label',
            suppressed: false,
            plane: { type: 'face', face: { id: 'r3', ref: { face: 'extrude#1:side:e6' } } },
            entities: [
              {
                id: 'e9',
                kind: 'outline',
                construction: false,
                // The face's frame has x along world Y and y along world -Z (normal -X): the text
                // sits 26 mm up the upright, turned half a turn to read upright from outside.
                anchor: [0, -26],
                angle: Math.PI,
                source: {
                  kind: 'text',
                  text,
                  font: 'font#1',
                  size: mm(6),
                  align: { horizontal: 'center', vertical: 'middle' },
                },
              },
            ],
            constraints: [],
          },
        },
        {
          type: 'addFeature',
          partId: PART,
          feature: {
            id: 'extrude#2',
            kind: 'extrude',
            name: 'Engrave',
            suppressed: false,
            profile: { sketch: 'sketch#3', entities: ['e9'] },
            operation: 'cut',
            extent: { type: 'blind', distance: mm(0.6) },
            reverse: true,
          },
        },
      ],
    } as Command,
  };
}

// The M4 bookshelf -------------------------------------------------------------------------

export function bookshelfDocument(): ManufaktureDocument {
  const add = (feature: unknown) => ({ type: 'addFeature', partId: PART, feature });
  return build('m4-bookshelf', SHELF.name, [
    INCH_UNITS,
    { type: 'renameDocument', name: SHELF.name },
    { type: 'renamePart', partId: PART, name: 'Carcass' },
    { type: 'setVariable', name: 'width', expression: inch(`${SHELF.modelled} in`) },
    add(frameSketch()),
    ...BOARDS.slice(0, 4).map((b) => add(boardFeature(b))),
    ...carcassSketches(),
    ...BOARDS.slice(4).map((b) => add(boardFeature(b))),
    ...JOINTS.map((j) => add(jointFeature(j))),
    ...boardNames(),
    ...configurationCommands(),
    ...assemblyCommands(),
  ]);
}

// The M6 shed ------------------------------------------------------------------------------

export function shedDocument(): ManufaktureDocument {
  return build('m6-shed', 'Shed', [FT_IN_UNITS, SHED]);
}

/** The shed's front-wall window (extension#5), moved to `position` inches along the wall. */
export function moveShedWindow(doc: ManufaktureDocument, position: number): Batch {
  const feature = structuredClone(
    doc.parts[0]!.features.find((f) => f.id === 'extension#5')!,
  ) as unknown as { expressions: Record<string, StoredExpression> };
  feature.expressions.position = inch(position);
  return {
    label: `Move Window 1 to ${position}"`,
    command: { type: 'editFeature', partId: PART, feature } as unknown as Command,
  };
}

export function fixtureDocument(name: FixtureName): ManufaktureDocument {
  if (name === 'bracket') return bracketDocument();
  if (name === 'bookshelf') return bookshelfDocument();
  return shedDocument();
}

/**
 * The `i`-th batch of the long run on a fixture, from the document it applies to: an edit an
 * agent would make, whose value never repeats (regen's cache would otherwise serve repeats and
 * build nothing; `packages/domain-construction/bench/measure.ts` does the same).
 *
 * - bracket: `#thickness` between 5 and 9 mm;
 * - bookshelf: `#width` between 24" and 36";
 * - shed: the front window between 40" and 56" along the wall.
 */
export function longRunBatch(name: FixtureName, doc: ManufaktureDocument, i: number): Batch {
  // A fraction that walks the range without repeating: the golden ratio's sequence.
  const f = (i * 0.6180339887498949) % 1;
  const round = (x: number, digits: number) => Number(x.toFixed(digits));
  if (name === 'bracket') {
    const t = round(5 + 4 * f, 4);
    return {
      label: `Wall thickness ${t} mm`,
      command: { type: 'setVariable', name: 'thickness', expression: mm(t) },
    };
  }
  if (name === 'bookshelf') {
    const w = round(24 + 12 * f, 4);
    return {
      label: `Width ${w}"`,
      command: { type: 'setVariable', name: 'width', expression: inch(`${w} in`) },
    };
  }
  return moveShedWindow(doc, round(40 + 16 * f, 4));
}

/** A short scripted sequence per fixture: what the session test applies, saves and reopens. */
export function storyBatches(name: FixtureName): ((doc: ManufaktureDocument) => Batch)[] {
  if (name === 'bracket') {
    return [
      () => engraveBatch('MFK-1'),
      () => ({
        label: 'Thicker walls',
        command: { type: 'setVariable', name: 'thickness', expression: mm(8) },
      }),
      (doc) => {
        const fillet = structuredClone(doc.parts[0]!.features.find((f) => f.id === 'fillet#1')!);
        (fillet as { radius: StoredExpression }).radius = mm('#corner');
        return {
          label: 'Fillet radius from a variable',
          command: {
            type: 'batch',
            commands: [
              { type: 'setVariable', name: 'corner', expression: mm(6) },
              { type: 'editFeature', partId: PART, feature: fillet },
            ],
          } as Command,
        };
      },
    ];
  }
  if (name === 'bookshelf') {
    return [
      () => ({
        label: 'Make it 36" wide',
        command: { type: 'setVariable', name: 'width', expression: inch('36 in') },
      }),
      () => ({
        label: 'Rename the top shelf',
        command: {
          type: 'renameFeature',
          partId: PART,
          featureId: 'extension#11',
          name: 'Top shelf',
        },
      }),
    ];
  }
  return [(doc) => moveShedWindow(doc, 60), (doc) => moveShedWindow(doc, 36)];
}
