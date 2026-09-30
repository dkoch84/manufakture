// A part of two bodies for tests: the demo part (its block is extrude#1) plus a new body,
// extrude#3, from the demo's second sketch; and the model regen would make of it.

import { applyCommand, type ExtrudeFeature, type ManufaktureDocument } from '@manufakture/core';
import { boxBody } from '../viewport/testMeshes';
import { demoDocument } from './demo';
import type { ModelBody, PartModel } from './model';

export const SECOND_BODY: ExtrudeFeature = {
  id: 'extrude#3',
  kind: 'extrude',
  name: 'Extrude 3',
  suppressed: false,
  profile: { sketch: 'sketch#2' },
  operation: 'new',
  extent: { type: 'blind', distance: { source: '10', lengthUnit: 'mm', angleUnit: 'deg' } },
  reverse: false,
};

export function twoBodyDocument(): ManufaktureDocument {
  const r = applyCommand(demoDocument(), {
    type: 'addFeature',
    partId: 'part#1',
    feature: SECOND_BODY,
  });
  if (!r.ok) throw new Error(r.error.message);
  return r.value.document;
}

export function modelBody(bodyId: string, solids = 1, min: [number, number, number] = [0, 0, 0]) {
  return {
    bodyId,
    creator: bodyId,
    solids,
    view: boxBody({ id: `part#1/${bodyId}`, min }),
  } satisfies ModelBody;
}

export function twoBodyModel(): PartModel {
  return {
    partId: 'part#1',
    features: [],
    bodies: [modelBody('extrude#1'), modelBody('extrude#3', 2, [20, 0, 0])],
  };
}
