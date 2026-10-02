// Documents for the joint tests: a part studio with two boards (A, then B) and a third, and a model
// store reporting the board frames regen would, so the joint's preview runs the domain's real
// translator. The scenes follow the domain's own regen tests: a side panel 600 x 300 x 18 mm on
// the ground with a shelf standing in it, a 2x4 leg with a rail entering it, and two boards
// meeting at their ends for a box joint.

import {
  applyCommand,
  createDocument,
  DEFAULT_UNITS,
  type Command,
  type DisplayUnits,
  type ManufaktureDocument,
} from '@manufakture/core';
import type { FeatureResult } from '@manufakture/regen';
import { createModelStore, type ModelStore } from '../../model/model';

type V = [number, number, number];

export interface Frame {
  origin: V;
  axes: { length: V; width: V; thickness: V };
  size: { length: number; width: number; thickness: number };
}

/** A board lying on the ground: length along x, width along y, thickness up. */
export function flat(length: number, width: number, thickness: number, origin: V = [0, 0, 0]) {
  return {
    origin,
    axes: { length: [1, 0, 0], width: [0, 1, 0], thickness: [0, 0, 1] },
    size: { length, width, thickness },
  } as Frame;
}

/**
 * A board standing up: thickness along +x from `x`, width along y from `y` (`width` long), length
 * up from `z` (`length` long). Its frame runs width along -y so the axes are right-handed.
 */
export function standing(x: number, y: number, z: number, width: number, length: number, t = 18) {
  return {
    origin: [x, y + width, z],
    axes: { length: [0, 0, 1], width: [0, -1, 0], thickness: [1, 0, 0] },
    size: { length, width, thickness: t },
  } as Frame;
}

/** `standing`, turned 30 degrees about the vertical: a splayed board. */
export function splayed(x: number, z: number): Frame {
  const c = Math.cos(Math.PI / 6);
  const s = Math.sin(Math.PI / 6);
  return {
    origin: [x, 0, z],
    axes: { length: [0, 0, 1], width: [s, -c, 0], thickness: [c, s, 0] },
    size: { length: 400, width: 300, thickness: 18 },
  };
}

/** The scenes: A and B by kind, as the domain's regen tests build them. */
export const SCENES = {
  dado: { a: flat(600, 300, 18), b: standing(200, 0, 12, 300, 400) },
  deep: { a: flat(600, 300, 18), b: standing(200, 0, 8, 300, 400) },
  rabbet: { a: flat(600, 300, 18), b: standing(582, 0, 12, 300, 400) },
  tenon: { a: flat(400, 100, 38.1), b: standing(150, 10, 38.1 - 25, 80, 300) },
  touching: { a: flat(600, 300, 18), b: standing(200, 0, 18, 300, 400) },
  box: { a: flat(300, 100, 18), b: standing(282, 0, 0, 100, 200) },
  splayed: { a: flat(600, 300, 18), b: splayed(200, 12) },
} satisfies Record<string, { a: Frame; b: Frame }>;

const ground = { type: 'plane', origin: [0, 0, 0], normal: [0, 0, 1], xDir: [1, 0, 0] } as const;

function unwrap(r: ReturnType<typeof applyCommand>): ManufaktureDocument {
  if (!r.ok) throw new Error(r.error.message);
  return r.value.document;
}

/**
 * A document with a sketch and three boards: Side (`extension#1`), Shelf (`extension#2`) and Back
 * (`extension#3`). Their geometry is whatever the model store says (`jointsModel`).
 */
export function jointsDocument(units: DisplayUnits = DEFAULT_UNITS): ManufaktureDocument {
  const doc = createDocument({ id: 'joints', name: 'Shelf', units });
  const c: [number, number][] = [
    [0, 0],
    [600, 0],
    [600, 300],
    [0, 300],
  ];
  const sketch = {
    id: 'sketch#1',
    kind: 'sketch',
    name: 'Outline',
    suppressed: false,
    plane: ground,
    entities: c.map((start, i) => ({
      id: `e${i + 1}`,
      kind: 'line',
      construction: false,
      start,
      end: c[(i + 1) % 4],
    })),
    constraints: [],
  };
  const board = (n: number, name: string) => ({
    id: `extension#${n}`,
    kind: 'extension',
    name,
    suppressed: false,
    extension: 'wood.board',
    schemaVersion: 1,
    operation: 'new',
    dependsOn: ['sketch#1'],
    references: [],
    expressions: {},
    params: { form: 'panel', stock: 'mm-ply-18', sketch: 'sketch#1' },
  });
  const commands = [sketch, board(1, 'Side'), board(2, 'Shelf'), board(3, 'Back')].map(
    (feature) => ({ type: 'addFeature', partId: 'part#1', feature }) as unknown as Command,
  );
  return unwrap(applyCommand(doc, { type: 'batch', commands }));
}

function boardResult(featureId: string, index: number, frame: Frame): FeatureResult {
  return {
    featureId,
    kind: 'extension',
    index,
    status: 'ok',
    errors: [],
    warnings: [],
    references: [],
    cached: false,
    ms: 0,
    metadata: {
      form: 'panel',
      stock: 'mm-ply-18',
      material: 'plywood',
      grain: true,
      frame,
      overridden: { thickness: false, width: false },
    },
  } as unknown as FeatureResult;
}

/** A model store with the boards built at `scene`'s frames (Back far away from both). */
export function jointsModel(scene: { a: Frame; b: Frame } = SCENES.dado): ModelStore {
  const model = createModelStore();
  model.setState({
    available: true,
    generation: 1,
    parts: [
      {
        partId: 'part#1',
        features: [
          boardResult('extension#1', 1, scene.a),
          boardResult('extension#2', 2, scene.b),
          boardResult('extension#3', 3, flat(600, 300, 18, [0, 0, 1000])),
        ],
        bodies: [],
      },
    ],
  });
  return model;
}
