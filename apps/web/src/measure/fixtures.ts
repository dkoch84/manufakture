// A hand-made measurement for UI tests: the top and bottom faces of the demo
// part (a 60 x 40 x 20 block, fillets 3, a through hole of radius 8).

import type { MeasureResult } from '@manufakture/kernel';

export const TOP_AREA = 54 * 34 - Math.PI * 64;

export function twoFaces(): MeasureResult {
  return {
    items: [
      {
        ok: true,
        kind: 'face',
        index: 6,
        name: null,
        surface: 'plane',
        area: TOP_AREA,
        centroid: [0, 0, 20],
        normal: [0, 0, 1],
        axis: null,
        radius: null,
      },
      {
        ok: true,
        kind: 'face',
        index: 5,
        name: null,
        surface: 'plane',
        area: TOP_AREA,
        centroid: [0, 0, 0],
        normal: [0, 0, -1],
        axis: null,
        radius: null,
      },
    ],
    distance: { value: 20, from: [10, 10, 20], to: [10, 10, 0], solutions: 4, planes: 20 },
    angle: { value: 0, between: 'planes', normals: Math.PI },
    body: {
      volume: 44000,
      area: 9000,
      centerOfMass: [0, 0, 10],
      boundingBox: { min: [-30, -20, 0], max: [30, 20, 20] },
    },
  };
}
