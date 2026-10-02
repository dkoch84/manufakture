// Documents for the woodworking tests: a part studio with a line sketch (a stick's line, 8 ft
// along x) and a rectangle sketch (a 600 x 300 mm panel region), both on the ground plane, and the
// model store reporting where regen solved them.

import {
  applyCommand,
  createDocument,
  DEFAULT_UNITS,
  type Command,
  type DisplayUnits,
  type ManufaktureDocument,
} from '@manufakture/core';
import type { FeatureResult } from '@manufakture/regen';
import { createModelStore, type ModelStore } from '../model/model';

export const EIGHT_FEET = 2438.4;
export const INCH_UNITS: DisplayUnits = {
  ...DEFAULT_UNITS,
  length: { unit: 'in-fraction', denominator: 16 },
};

const ground = { type: 'plane', origin: [0, 0, 0], normal: [0, 0, 1], xDir: [1, 0, 0] } as const;

function unwrap(r: ReturnType<typeof applyCommand>): ManufaktureDocument {
  if (!r.ok) throw new Error(r.error.message);
  return r.value.document;
}

export function woodDocument(units: DisplayUnits = DEFAULT_UNITS): ManufaktureDocument {
  const doc = createDocument({ id: 'wood', name: 'Shelf', units });
  const line = {
    id: 'sketch#1',
    kind: 'sketch',
    name: 'Rail line',
    suppressed: false,
    plane: ground,
    entities: [
      { id: 'e1', kind: 'line', construction: false, start: [0, 0], end: [EIGHT_FEET, 0] },
    ],
    constraints: [],
  };
  const c: [number, number][] = [
    [0, 0],
    [600, 0],
    [600, 300],
    [0, 300],
  ];
  const rect = {
    id: 'sketch#2',
    kind: 'sketch',
    name: 'Shelf outline',
    suppressed: false,
    plane: ground,
    entities: c.map((start, i) => ({
      id: `e${i + 2}`,
      kind: 'line',
      construction: false,
      start,
      end: c[(i + 1) % 4],
    })),
    constraints: [],
  };
  const commands = [line, rect].map(
    (feature) => ({ type: 'addFeature', partId: 'part#1', feature }) as unknown as Command,
  );
  return unwrap(applyCommand(doc, { type: 'batch', commands }));
}

/** A model store with both sketches solved on the ground plane. */
export function woodModel(): ModelStore {
  const model = createModelStore();
  const sketch = (featureId: string, index: number): FeatureResult =>
    ({
      featureId,
      kind: 'sketch',
      index,
      status: 'ok',
      errors: [],
      warnings: [],
      references: [],
      cached: false,
      ms: 0,
      placement: { origin: [0, 0, 0], normal: [0, 0, 1], xDir: [1, 0, 0] },
    }) as FeatureResult;
  model.setState({
    available: true,
    generation: 1,
    parts: [
      { partId: 'part#1', features: [sketch('sketch#1', 0), sketch('sketch#2', 1)], bodies: [] },
    ],
  });
  return model;
}
