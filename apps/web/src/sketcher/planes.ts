// Where a new sketch can go: one of the three datum planes, or a planar face
// picked in the viewport. A face is found from its name through the body's
// name table and its plane from the kernel topology (centroid and outward
// normal). The sketch stores the plane itself, not a face reference: face
// names are viewport placeholders until the naming layer (#931) fills them,
// and a placeholder must never be stored in a document.

import { XY_PLANE, XZ_PLANE, YZ_PLANE, placementFromNormal } from '@manufakture/sketch';
import type { SketchPlacement, Vec2, Vec3 } from '@manufakture/sketch/model';
import type { GeometryRef } from '../state/selection';
import type { BodyInput } from '../viewport/bodies';

export type DatumPlane = 'XY' | 'XZ' | 'YZ';

export const DATUM_PLANES: readonly {
  id: DatumPlane;
  label: string;
  placement: SketchPlacement;
}[] = [
  { id: 'XY', label: 'Top (XY)', placement: XY_PLANE },
  { id: 'XZ', label: 'Front (XZ)', placement: XZ_PLANE },
  { id: 'YZ', label: 'Right (YZ)', placement: YZ_PLANE },
];

/** The sketch placement on a planar face, or null when the face is not planar or unknown. */
export function facePlacement(
  bodies: readonly BodyInput[],
  face: GeometryRef,
): SketchPlacement | null {
  if (face.kind !== 'face') return null;
  const body = bodies.find((b) => b.id === face.bodyId);
  if (!body?.topology) return null;
  const nameIndex = body.names.indexOf(face.name);
  if (nameIndex < 0) return null;
  const slot = body.mesh.faceNames.indexOf(nameIndex);
  if (slot < 0) return null;
  const info = body.topology.faces.find((f) => f.index === slot + 1);
  if (!info || info.surface !== 'plane' || !info.normal) return null;
  return placementFromNormal(info.centroid, info.normal);
}

/** The world direction of the sketch's y axis: normal x xDir. */
export function sketchUp(p: SketchPlacement): Vec3 {
  const [nx, ny, nz] = p.normal;
  const [x, y, z] = p.xDir;
  // `+ 0` turns -0 into 0.
  return [ny * z - nz * y + 0, nz * x - nx * z + 0, nx * y - ny * x + 0];
}

/** Points of the sketch origin and axes to draw, `extent` sketch units long. */
export function axisSegments(extent: number): { x: [Vec2, Vec2]; y: [Vec2, Vec2] } {
  return {
    x: [
      [-extent, 0],
      [extent, 0],
    ],
    y: [
      [0, -extent],
      [0, extent],
    ],
  };
}
