// Overhang classes per triangle and per B-rep face (plan T3.1b, decision 5).
//
// Angles are measured FROM VERTICAL, in radians: a vertical wall is 0, the underside of a 45
// degree chamfer is pi/4, a ceiling facing straight down is pi/2. Faces that look up have a
// negative angle and are never an overhang. This is the "45 degree rule" convention the print
// panel shows. OrcaSlicer's `support_threshold_angle` measures the same slope FROM HORIZONTAL
// (support goes under surfaces whose slope from horizontal is below it, default 30 degrees), so
// threshold_from_vertical = pi/2 - support_threshold_angle: OrcaSlicer's 30 is our 60.
//
// Classes, for a triangle facing down at angle a against a threshold T and warning band B:
//   onBed         every vertex within the bed tolerance of the bed plane: it rests on the bed
//   downwardFlat  a within ANGLE_TOLERANCE of pi/2: a horizontal ceiling, needs a bridge or support
//   overhang      a > T, strictly and by more than ANGLE_TOLERANCE
//   steep         T - B < a <= T (within ANGLE_TOLERANCE of either end counts as the milder side)
//   ok            everything else, upward and vertical faces included
//
// A triangle exactly at the threshold is steep, not overhang, matching OrcaSlicer, which supports
// surfaces whose slope is strictly below `support_threshold_angle`. ANGLE_TOLERANCE is 1e-6 rad:
// the normals come from `MeshData.normals`, a Float32Array, and rounding a unit normal to 32 bits
// moves its angle by up to about 1e-7 rad, so a tighter tolerance would misclassify a face
// modelled at exactly the threshold. 1e-6 rad is still far below anything a printer resolves.

import type { MeshData } from '@manufakture/kernel';
import { cross, quatToMatrix, type Placement } from './geometry';

export type OverhangClass = 'ok' | 'steep' | 'overhang' | 'downwardFlat' | 'onBed';

/** Every class; a class's code in `OverhangResult.classes` is its index here. */
export const OVERHANG_CLASSES = [
  'ok',
  'steep',
  'overhang',
  'downwardFlat',
  'onBed',
] as const satisfies readonly OverhangClass[];

/** How bad a class is, for "the worst class of a face": onBed < ok < steep < overhang < downwardFlat. */
export const OVERHANG_SEVERITY: Readonly<Record<OverhangClass, number>> = {
  onBed: 0,
  ok: 1,
  steep: 2,
  overhang: 3,
  downwardFlat: 4,
};

/** Default overhang threshold: 60 degrees from vertical (OrcaSlicer's default 30 from horizontal). */
export const DEFAULT_OVERHANG_THRESHOLD = Math.PI / 3;

/** Default warning band below the threshold: 10 degrees. An estimate, not a slicer value. */
export const DEFAULT_WARNING_BAND = Math.PI / 18;

/** Angles within this many radians of a class boundary count as at the boundary. */
export const ANGLE_TOLERANCE = 1e-6;

/** A triangle whose vertices are all within this many mm of the bed plane rests on the bed. */
export const DEFAULT_BED_TOLERANCE = 1e-3;

/**
 * Converts OrcaSlicer's `support_threshold_angle` (slope from horizontal, radians) to an overhang
 * threshold from vertical (radians): pi/2 minus it.
 */
export function supportThresholdToOverhang(fromHorizontal: number): number {
  return Math.PI / 2 - fromHorizontal;
}

/** The inverse of `supportThresholdToOverhang`. */
export function overhangToSupportThreshold(fromVertical: number): number {
  return Math.PI / 2 - fromVertical;
}

/** What the overhang check reads from a mesh. Normals are float32, as the kernel sends them. */
export type OverhangMesh = Pick<MeshData, 'positions' | 'normals' | 'indices'> &
  Partial<Pick<MeshData, 'triangleFaces' | 'faceRanges'>>;

export interface OverhangOptions {
  /** The item's orientation on the bed (`orientationPlacement`); default the mesh as it is. */
  placement?: Placement;
  /** Overhang threshold, radians from vertical; default `DEFAULT_OVERHANG_THRESHOLD`. */
  threshold?: number;
  /** Width of the steep band below the threshold, radians; default `DEFAULT_WARNING_BAND`. */
  band?: number;
  /** z of the bed plane after placement; default the lowest placed vertex of this mesh. */
  bedZ?: number;
  /** mm; default `DEFAULT_BED_TOLERANCE`. */
  bedTolerance?: number;
}

export interface FaceOverhang {
  /** 1-based face index (topology numbering). */
  face: number;
  /** The most severe class of any of its triangles (`OVERHANG_SEVERITY`); 'ok' with none. */
  worst: OverhangClass;
  /** Area in mm2 of its triangles in each class. */
  areas: Record<OverhangClass, number>;
  /** The largest angle from vertical of its triangles, radians; -pi/2 with none. */
  maxAngle: number;
  triangles: number;
}

export interface OverhangResult {
  /** Per triangle: the index of its class in `OVERHANG_CLASSES`. */
  classes: Uint8Array;
  /** Per triangle: angle from vertical, radians, in [-pi/2, pi/2]; positive faces down. */
  angles: Float64Array;
  /** Per face, slot i for face i + 1; empty when the mesh has no `triangleFaces`. */
  faces: FaceOverhang[];
  /** The bed plane z the onBed test used. */
  bedZ: number;
}

/**
 * The angle from vertical of a direction, radians: 0 horizontal, pi/2 straight down, -pi/2
 * straight up. Computed with atan2, so it stays accurate near the vertical.
 */
export function angleFromVertical(nx: number, ny: number, nz: number): number {
  return Math.atan2(-nz, Math.hypot(nx, ny)) + 0; // + 0 turns -0 into 0
}

/** The class of one angle from vertical, ignoring the bed. */
export function classifyAngle(
  angle: number,
  threshold = DEFAULT_OVERHANG_THRESHOLD,
  band = DEFAULT_WARNING_BAND,
): Exclude<OverhangClass, 'onBed'> {
  if (angle >= Math.PI / 2 - ANGLE_TOLERANCE) return 'downwardFlat';
  if (angle > threshold + ANGLE_TOLERANCE) return 'overhang';
  if (angle > threshold - band + ANGLE_TOLERANCE) return 'steep';
  return 'ok';
}

const CODE: Readonly<Record<OverhangClass, number>> = {
  ok: 0,
  steep: 1,
  overhang: 2,
  downwardFlat: 3,
  onBed: 4,
};

/**
 * Overhang classes of every triangle of a mesh and, when it has `triangleFaces`, of every face.
 * A triangle's direction is the mean of its three vertex normals (for a planar face, the face's
 * normal at float32 precision), falling back to its winding when they cancel out.
 */
export function classifyOverhangs(
  mesh: OverhangMesh,
  options: OverhangOptions = {},
): OverhangResult {
  const threshold = options.threshold ?? DEFAULT_OVERHANG_THRESHOLD;
  const band = options.band ?? DEFAULT_WARNING_BAND;
  const bedTolerance = options.bedTolerance ?? DEFAULT_BED_TOLERANCE;
  const m = quatToMatrix(options.placement?.rotation ?? [0, 0, 0, 1]);
  const t = options.placement?.translation ?? [0, 0, 0];

  const { positions, normals, indices } = mesh;
  const vertexCount = Math.floor(positions.length / 3);
  const placed = new Float64Array(vertexCount * 3);
  let lowest = Infinity;
  for (let v = 0; v < vertexCount; v++) {
    const x = positions[3 * v]!,
      y = positions[3 * v + 1]!,
      z = positions[3 * v + 2]!;
    placed[3 * v] = m[0] * x + m[1] * y + m[2] * z + t[0];
    placed[3 * v + 1] = m[3] * x + m[4] * y + m[5] * z + t[1];
    const pz = m[6] * x + m[7] * y + m[8] * z + t[2];
    placed[3 * v + 2] = pz;
    if (pz < lowest) lowest = pz;
  }
  const bedZ = options.bedZ ?? (Number.isFinite(lowest) ? lowest : 0);

  const triangleCount = Math.floor(indices.length / 3);
  const classes = new Uint8Array(triangleCount);
  const angles = new Float64Array(triangleCount);
  const areas = new Float64Array(triangleCount);

  for (let k = 0; k < triangleCount; k++) {
    const a = indices[3 * k]!,
      b = indices[3 * k + 1]!,
      c = indices[3 * k + 2]!;
    const ax = placed[3 * a]!,
      ay = placed[3 * a + 1]!,
      az = placed[3 * a + 2]!;
    const bx = placed[3 * b]!,
      by = placed[3 * b + 1]!,
      bz = placed[3 * b + 2]!;
    const cx = placed[3 * c]!,
      cy = placed[3 * c + 1]!,
      cz = placed[3 * c + 2]!;
    const winding = cross([bx - ax, by - ay, bz - az], [cx - ax, cy - ay, cz - az]);
    areas[k] = Math.hypot(winding[0], winding[1], winding[2]) / 2;

    // Mean vertex normal in body coordinates, then rotated (no translation for directions).
    let nx = normals[3 * a]! + normals[3 * b]! + normals[3 * c]!;
    let ny = normals[3 * a + 1]! + normals[3 * b + 1]! + normals[3 * c + 1]!;
    let nz = normals[3 * a + 2]! + normals[3 * b + 2]! + normals[3 * c + 2]!;
    let dx: number, dy: number, dz: number;
    if (Math.hypot(nx, ny, nz) > 1e-12) {
      dx = m[0] * nx + m[1] * ny + m[2] * nz;
      dy = m[3] * nx + m[4] * ny + m[5] * nz;
      dz = m[6] * nx + m[7] * ny + m[8] * nz;
    } else {
      [dx, dy, dz] = winding;
    }
    nx = dx;
    ny = dy;
    nz = dz;
    const angle = Math.hypot(nx, ny, nz) > 0 ? angleFromVertical(nx, ny, nz) : 0;
    angles[k] = angle;

    const onBed =
      angle > 0 &&
      Math.abs(az - bedZ) <= bedTolerance &&
      Math.abs(bz - bedZ) <= bedTolerance &&
      Math.abs(cz - bedZ) <= bedTolerance;
    classes[k] = CODE[onBed ? 'onBed' : classifyAngle(angle, threshold, band)];
  }

  return { classes, angles, faces: faceSummaries(mesh, classes, angles, areas), bedZ };
}

function faceSummaries(
  mesh: OverhangMesh,
  classes: Uint8Array,
  angles: Float64Array,
  areas: Float64Array,
): FaceOverhang[] {
  const triangleFaces = mesh.triangleFaces;
  if (!triangleFaces) return [];
  let faceCount = mesh.faceRanges ? Math.floor(mesh.faceRanges.length / 2) : 0;
  for (let k = 0; k < triangleFaces.length; k++) faceCount = Math.max(faceCount, triangleFaces[k]!);
  const faces: FaceOverhang[] = [];
  for (let f = 1; f <= faceCount; f++) {
    faces.push({
      face: f,
      worst: 'ok',
      areas: { ok: 0, steep: 0, overhang: 0, downwardFlat: 0, onBed: 0 },
      maxAngle: -Math.PI / 2,
      triangles: 0,
    });
  }
  for (let k = 0; k < classes.length && k < triangleFaces.length; k++) {
    const face = faces[triangleFaces[k]! - 1];
    if (!face) continue;
    const cls = OVERHANG_CLASSES[classes[k]!]!;
    face.areas[cls] += areas[k]!;
    face.maxAngle = Math.max(face.maxAngle, angles[k]!);
    face.worst =
      face.triangles === 0 || OVERHANG_SEVERITY[cls] > OVERHANG_SEVERITY[face.worst]
        ? cls
        : face.worst;
    face.triangles++;
  }
  return faces;
}
