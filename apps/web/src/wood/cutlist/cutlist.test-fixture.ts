// The cut list tests' bookshelf (bookshelf A of `@manufakture/nesting`'s fixtures): a 30" wide,
// 72" tall, 11-1/4" deep carcass in 3/4" plywood (23/32" actual): two sides 72" long, a top, a
// bottom and three shelves 29" long. Next to it a 2x4 rail 8 ft long, a glued-up 2x4 blank 10"
// wide (wider than the stock), a pattern copy of a shelf with no material, and an extruded oak
// panel that is not a board. Board metadata is a fixture (the real translator is tested in
// `@manufakture/domain-wood`); the model store holds it as a regen would report it.

import {
  applyCommand,
  createDocument,
  type Command,
  type DisplayUnits,
  type ManufaktureDocument,
} from '@manufakture/core';
import { findStock, type BoardMetadata } from '@manufakture/domain-wood';
import type { FeatureResult } from '@manufakture/regen';
import { createModelStore, type ModelBody, type ModelStore } from '../../model/model';
import { boxBody } from '../../viewport/testMeshes';
import { INCH_UNITS } from '../wood.test-fixture';

export const IN = 25.4;
export const PLY = 'us-ply-23-32';

interface Spec {
  id: string;
  name: string;
  stock: string;
  /** [length, width, thickness] in inches. */
  size: [number, number, number];
  form?: 'panel' | 'stick';
}

export const BOARDS: Spec[] = [
  { id: 'extension#1', name: 'Side 1', stock: PLY, size: [72, 11.25, 23 / 32] },
  { id: 'extension#2', name: 'Side 2', stock: PLY, size: [72, 11.25, 23 / 32] },
  { id: 'extension#3', name: 'Top', stock: PLY, size: [29, 11.25, 23 / 32] },
  { id: 'extension#4', name: 'Bottom', stock: PLY, size: [29, 11.25, 23 / 32] },
  { id: 'extension#5', name: 'Shelf 1', stock: PLY, size: [29, 11.25, 23 / 32] },
  { id: 'extension#6', name: 'Shelf 2', stock: PLY, size: [29, 11.25, 23 / 32] },
  { id: 'extension#7', name: 'Shelf 3', stock: PLY, size: [29, 11.25, 23 / 32] },
  { id: 'extension#8', name: 'Rail', stock: 'us-2x4', size: [96, 3.5, 1.5], form: 'stick' },
  { id: 'extension#9', name: 'Glued top', stock: 'us-2x4', size: [30, 10, 1.5], form: 'stick' },
];

export function boardMetadata(spec: Spec): BoardMetadata {
  const entry = findStock(spec.stock)!;
  const [length, width, thickness] = spec.size.map((x) => x * IN) as [number, number, number];
  return {
    form: spec.form ?? 'panel',
    stock: spec.stock,
    material: entry.material,
    grain: entry.grain,
    frame: {
      origin: [0, 0, 0],
      axes: { length: [1, 0, 0], width: [0, 1, 0], thickness: [0, 0, 1] },
      size: { length, width, thickness },
    },
    overridden: { thickness: false, width: false },
  };
}

const unwrap = (r: ReturnType<typeof applyCommand>): ManufaktureDocument => {
  if (!r.ok) throw new Error(r.error.message);
  return r.value.document;
};

const ground = { type: 'plane', origin: [0, 0, 0], normal: [0, 0, 1], xDir: [1, 0, 0] } as const;

/** The document: a sketch, the boards, a pattern of shelf 3 and an oak extrusion. */
export function bookshelfDocument(
  units: DisplayUnits = INCH_UNITS,
  boards: readonly Spec[] = BOARDS,
): ManufaktureDocument {
  const doc = createDocument({ id: 'shelf', name: 'Bookshelf', units });
  const features: unknown[] = [
    {
      id: 'sketch#1',
      kind: 'sketch',
      name: 'Outline',
      suppressed: false,
      plane: ground,
      entities: [],
      constraints: [],
    },
    ...boards.map((b) => ({
      id: b.id,
      kind: 'extension',
      name: b.name,
      suppressed: false,
      extension: 'wood.board',
      schemaVersion: 1,
      operation: 'new',
      dependsOn: ['sketch#1'],
      references: [],
      expressions: {},
      params: { sketch: 'sketch#1', form: b.form ?? 'panel', stock: b.stock },
    })),
  ];
  const commands = features.map(
    (feature) => ({ type: 'addFeature', partId: 'part#1', feature }) as unknown as Command,
  );
  return unwrap(applyCommand(doc, { type: 'batch', commands }));
}

function result(featureId: string, index: number, metadata?: unknown): FeatureResult {
  return {
    featureId,
    kind: featureId.startsWith('sketch') ? 'sketch' : 'extension',
    index,
    status: 'ok',
    errors: [],
    warnings: [],
    references: [],
    cached: false,
    ms: 0,
    ...(metadata === undefined ? {} : { metadata }),
  } as unknown as FeatureResult;
}

function body(bodyId: string, creator: string, i: number): ModelBody {
  return {
    bodyId,
    creator,
    solids: 1,
    view: boxBody({ id: `part#1/${bodyId}`, min: [i * 100, 0, 0], size: [50, 40, 10] }),
  };
}

/**
 * The model of the bookshelf. With `extras`, also a body made by `pattern#1` (a copy of shelf 3,
 * no material) and one by `extrude#1`, which the tests give a wood material.
 */
export function bookshelfModel(
  options: { extras?: boolean; boards?: readonly Spec[] } = {},
): ModelStore {
  const boards = options.boards ?? BOARDS;
  const model = createModelStore();
  const features = [
    result('sketch#1', 0),
    ...boards.map((b, i) => result(b.id, i + 1, boardMetadata(b))),
  ];
  const bodies = boards.map((b, i) => body(b.id, b.id, i));
  if (options.extras) {
    bodies.push(body('pattern#1:1/extension#7', 'pattern#1', bodies.length));
    bodies.push(body('extrude#1', 'extrude#1', bodies.length));
  }
  model.setState({
    available: true,
    generation: 1,
    document: null,
    parts: [{ partId: 'part#1', features, bodies }],
  });
  return model;
}

/** The document with an oak extrusion body (`extrude#1`) named "Oak panel". */
export function withOakPanel(given: ManufaktureDocument): ManufaktureDocument {
  const extrude = {
    id: 'extrude#1',
    kind: 'extrude',
    name: 'Panel extrude',
    suppressed: false,
    profile: { sketch: 'sketch#1' },
    operation: 'new',
    extent: { type: 'blind', distance: { source: '1', lengthUnit: 'in', angleUnit: 'deg' } },
    reverse: false,
  };
  const doc = unwrap(
    applyCommand(given, {
      type: 'addFeature',
      partId: 'part#1',
      feature: extrude,
    } as unknown as Command),
  );
  return {
    ...doc,
    parts: doc.parts.map((p) =>
      p.id === 'part#1'
        ? { ...p, bodies: [...p.bodies, { id: 'extrude#1', name: 'Oak panel', material: 'oak' }] }
        : p,
    ),
  };
}
