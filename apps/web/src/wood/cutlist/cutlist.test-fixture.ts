// The cut list tests' bookshelf as the app's model store holds it: the document and the parts
// come from `@manufakture/domain-wood/fixtures` (which the package's own cut list tests use), and
// each body gets a box for the viewport, so a row's bodies can be selected.

import { bookshelfParts, type Spec } from '@manufakture/domain-wood/fixtures';
import { createModelStore, type ModelStore } from '../../model/model';
import { boxBody } from '../../viewport/testMeshes';

export { IN, PLY, bookshelfDocument, withOakPanel } from '@manufakture/domain-wood/fixtures';

/**
 * The model of the bookshelf. With `extras`, also a body made by `pattern#1` (a copy of shelf 3,
 * no material) and one by `extrude#1`, which the tests give a wood material.
 */
export function bookshelfModel(
  options: { extras?: boolean; boards?: readonly Spec[] } = {},
): ModelStore {
  const model = createModelStore();
  model.setState({
    available: true,
    generation: 1,
    document: null,
    parts: bookshelfParts(options).map((p) => ({
      ...p,
      bodies: p.bodies.map((b, i) => ({
        ...b,
        solids: 1,
        view: boxBody({ id: `part#1/${b.bodyId}`, min: [i * 100, 0, 0], size: [50, 40, 10] }),
      })),
    })),
  });
  return model;
}
