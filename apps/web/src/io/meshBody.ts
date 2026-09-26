// Mesh reference bodies: an imported STL has no B-rep, so the viewport gets
// it as one face with flat-shaded triangles and no edges, and it is measured
// from the mesh itself (volume, area, centre of mass, bounding box). No
// B-rep feature can use it.

import { checkManifold, meshProperties, type TriMesh } from '@manufakture/io';
import { UNNAMED, type MeasureTarget, type MeshData } from '@manufakture/kernel';
import type { BodyMeasurement, Measurement, Measurer } from '../measure/measurer';
import type { BodyInput } from '../viewport/bodies';
import { fillPlaceholderNames } from '../viewport/naming';

/** A viewport body for a mesh: one face, vertices per triangle so every facet is flat. */
export function meshBody(id: string, mesh: TriMesh): BodyInput {
  const triangles = mesh.indices.length / 3;
  const positions = new Float32Array(triangles * 9);
  const normals = new Float32Array(triangles * 9);
  const p = mesh.positions;
  for (let t = 0; t < triangles; t++) {
    const corners = [0, 1, 2].map((k) => mesh.indices[t * 3 + k]! * 3);
    const [a, b, c] = corners.map((o) => [p[o]!, p[o + 1]!, p[o + 2]!]) as [
      number[],
      number[],
      number[],
    ];
    const u = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!];
    const v = [c[0]! - a[0]!, c[1]! - a[1]!, c[2]! - a[2]!];
    const n = [
      u[1]! * v[2]! - u[2]! * v[1]!,
      u[2]! * v[0]! - u[0]! * v[2]!,
      u[0]! * v[1]! - u[1]! * v[0]!,
    ];
    const len = Math.hypot(n[0]!, n[1]!, n[2]!) || 1;
    for (let k = 0; k < 3; k++) {
      positions.set([a, b, c][k]!, t * 9 + k * 3);
      normals.set([n[0]! / len, n[1]! / len, n[2]! / len], t * 9 + k * 3);
    }
  }
  const data: MeshData = {
    positions,
    normals,
    indices: Uint32Array.from({ length: triangles * 3 }, (_, i) => i),
    faceRanges: new Uint32Array([0, triangles * 3]),
    triangleFaces: new Uint32Array(triangles).fill(1),
    edgePositions: new Float32Array(),
    edgeRanges: new Uint32Array(),
    faceNames: new Uint32Array([UNNAMED]),
    faceFragile: new Uint8Array(1),
    edgeNames: new Uint32Array(),
    edgeFragile: new Uint8Array(),
  };
  return { id, mesh: data, names: fillPlaceholderNames(data, []) };
}

/** Why an open mesh has no volume, for the Measure panel. */
export const OPEN_MESH_NOTE =
  'The mesh is not closed (open, non-manifold or inconsistently wound edges), so it encloses no volume to measure';

/** Body properties of a mesh, worked out once per mesh (it never changes). */
const bodies = new WeakMap<TriMesh, BodyMeasurement>();

function meshBodyMeasure(mesh: TriMesh): BodyMeasurement {
  const cached = bodies.get(mesh);
  if (cached) return cached;
  const p = meshProperties(mesh);
  const report = checkManifold(mesh);
  // Degenerate triangles do not change the volume; holes and bad edges do.
  const closed =
    report.boundaryEdges === 0 && report.nonManifoldEdges === 0 && report.inconsistentEdges === 0;
  const out: BodyMeasurement = closed
    ? {
        // A closed mesh wound inside out has the same volume, negative.
        volume: Math.abs(p.volume),
        area: p.area,
        centerOfMass: p.centerOfMass,
        boundingBox: p.boundingBox,
      }
    : {
        volume: null,
        area: p.area,
        // The centre of mass is of the volume: without one there is none.
        centerOfMass: null,
        boundingBox: p.boundingBox,
        note: OPEN_MESH_NOTE,
      };
  bodies.set(mesh, out);
  return out;
}

/**
 * The measure result of a mesh body: body properties only; its facets are
 * not B-rep faces. An open or non-manifold mesh reports no volume (null, with
 * a note), since the signed volume of an open surface means nothing.
 */
export function measureMesh(
  mesh: TriMesh,
  targets: readonly MeasureTarget[],
  body: boolean,
): Measurement {
  return {
    items: targets.map((t) => ({
      ok: false,
      kind: t.kind,
      status: 'not-found',
      message: 'An imported mesh has no faces, edges or vertices to measure; only the whole body.',
    })),
    distance: null,
    angle: null,
    body: body ? meshBodyMeasure(mesh) : null,
  };
}

/**
 * A measurer that answers for mesh bodies itself and passes every other body
 * on to `next` (the kernel's).
 */
export function withMeshBodies(
  next: Measurer | null,
  meshes: () => ReadonlyMap<string, TriMesh>,
): Measurer {
  return {
    async measure(bodyId, targets, body) {
      const mesh = meshes().get(bodyId);
      if (mesh) return { ok: true, result: measureMesh(mesh, targets, body) };
      if (next === null)
        return { ok: false, message: `There is nothing to measure ${bodyId} with.` };
      return next.measure(bodyId, targets, body);
    },
  };
}
