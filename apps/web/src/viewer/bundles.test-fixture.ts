// Small `.mfkview` bundles for the viewer's tests, written with the real writer.

import { IDENTITY_MATRIX, placementMatrix } from '@manufakture/io';
import { writeMfkview, type MfkviewInput, type MfkviewMesh } from '@manufakture/io/mfkview';
import { UNNAMED } from '@manufakture/kernel/types';
import type { BodyInput } from '../viewport/bodies';
import { boxBody } from '../viewport/testMeshes';

export function meshOf(view: BodyInput): MfkviewMesh {
  const name = (slot: number) => (slot === UNNAMED ? null : (view.names[slot] ?? null));
  const m = view.mesh;
  return {
    positions: m.positions,
    normals: m.normals,
    indices: m.indices,
    faceRanges: m.faceRanges,
    edgePositions: m.edgePositions,
    edgeRanges: m.edgeRanges,
    faceNames: Array.from(m.faceNames, name),
    edgeNames: Array.from(m.edgeNames, name),
  };
}

export interface BoxBundleOptions {
  name?: string;
  bodyNames?: string[];
  source?: Uint8Array | null;
  displayUnits?: string;
}

/** A part studio of two boxes: 40 x 30 x 20 at the origin and 10 x 10 x 10 at x = 50. */
export function boxBundle(options: BoxBundleOptions = {}): Promise<Uint8Array> {
  const [a, b] = options.bodyNames ?? ['Base', 'Block'];
  const input: MfkviewInput = {
    name: options.name ?? 'Bracket',
    kind: 'part',
    displayUnits: options.displayUnits ?? 'mm',
    bodies: [
      {
        name: a!,
        color: '#3366cc',
        material: { id: 'pla', name: 'PLA', density: 1240 },
        volume: 24000,
        mass: 29.76,
        mesh: meshOf(boxBody({ id: 'a', size: [40, 30, 20] })),
      },
      {
        name: b!,
        color: null,
        material: null,
        volume: null,
        mass: null,
        mesh: meshOf(boxBody({ id: 'b', min: [50, 0, 0], size: [10, 10, 10] })),
      },
    ],
    parts: [{ name: options.name ?? 'Bracket', bodies: [0, 1] }],
    instances: [{ name: options.name ?? 'Bracket', part: 0, transform: [...IDENTITY_MATRIX] }],
    source: options.source ?? null,
  };
  return writeMfkview(input);
}

/** An assembly placing one 10 mm cube twice: at the origin, and turned 90 degrees about Z at x = 100. */
export function assemblyBundle(): Promise<Uint8Array> {
  return writeMfkview({
    name: 'Pair',
    kind: 'assembly',
    bodies: [
      {
        name: 'Cube',
        color: '#cc3333',
        material: null,
        volume: 1000,
        mass: null,
        mesh: meshOf(boxBody({ id: 'c', size: [10, 10, 10] })),
      },
    ],
    parts: [{ name: 'Cube part', bodies: [0] }],
    instances: [
      { name: 'Left', part: 0, transform: [...IDENTITY_MATRIX] },
      {
        name: 'Right',
        part: 0,
        transform: placementMatrix({
          translation: [100, 0, 0],
          rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2],
        }),
      },
    ],
  });
}
