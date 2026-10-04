// A read bundle as the viewport draws it. Each body of each instance becomes one viewport body
// (`<instance>/<body>`), placed by the instance's matrix; the instances of a part share one mesh,
// so the engine shares its buffers. Names arrive as strings and go into a name table, as a regen
// reply's would; picking and highlighting then work as in the app.

import type { MfkviewBodyInfo, MfkviewMesh, Mfkview } from '@manufakture/io/mfkview';
import type { MeshData, Vec3 } from '@manufakture/kernel/types';
import { UNNAMED } from '@manufakture/kernel/types';
import { transformBounds, type BodyInput, type BodyTransform } from '../viewport/bodies';
import { displayText } from './displayText';

/** One body of one instance, ready for the viewport and the body list. */
export interface ViewerBody {
  /** The viewport id: `<instance index>/<body index>`. */
  id: string;
  /** Shown names, cleaned (displayText.ts). */
  name: string;
  instanceName: string;
  instance: number;
  /** Index into the manifest's bodies (and the meshes). */
  body: number;
  info: MfkviewBodyInfo;
  input: BodyInput;
  /** World bounds (the instance's placement applied). */
  bounds: { min: Vec3; max: Vec3 } | null;
}

/** A bundle's mesh as the kernel's `MeshData`, its names in a table. */
export function toMeshData(mesh: MfkviewMesh): { mesh: MeshData; names: string[] } {
  const names: string[] = [];
  const index = new Map<string, number>();
  const intern = (name: string | null): number => {
    if (name === null) return UNNAMED;
    let i = index.get(name);
    if (i === undefined) {
      i = names.length;
      names.push(name);
      index.set(name, i);
    }
    return i;
  };
  const faces = mesh.faceRanges.length / 2;
  const triangleFaces = new Uint32Array(mesh.indices.length / 3);
  for (let f = 0; f < faces; f++) {
    const first = mesh.faceRanges[f * 2]! / 3;
    const count = mesh.faceRanges[f * 2 + 1]! / 3;
    triangleFaces.fill(f + 1, first, first + count);
  }
  const edges = mesh.edgeRanges.length / 2;
  return {
    mesh: {
      positions: mesh.positions,
      normals: mesh.normals,
      indices: mesh.indices,
      faceRanges: mesh.faceRanges,
      triangleFaces,
      edgePositions: mesh.edgePositions,
      edgeRanges: mesh.edgeRanges,
      faceNames: Uint32Array.from(mesh.faceNames, intern),
      faceFragile: new Uint8Array(faces),
      edgeNames: Uint32Array.from(mesh.edgeNames, intern),
      edgeFragile: new Uint8Array(edges),
    },
    names,
  };
}

/**
 * A rigid 3 x 4 matrix of the bundle (io's `Matrix3x4`: the rotation stored transposed, then the
 * translation; the reader has checked it is rigid) as the viewport's placement.
 */
export function matrixToTransform(m: readonly number[]): BodyTransform {
  // R[r][c] = m[c * 3 + r].
  const r = (row: number, col: number) => m[col * 3 + row]!;
  const trace = r(0, 0) + r(1, 1) + r(2, 2);
  let x: number, y: number, z: number, w: number;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    w = s / 4;
    x = (r(2, 1) - r(1, 2)) / s;
    y = (r(0, 2) - r(2, 0)) / s;
    z = (r(1, 0) - r(0, 1)) / s;
  } else if (r(0, 0) > r(1, 1) && r(0, 0) > r(2, 2)) {
    const s = Math.sqrt(1 + r(0, 0) - r(1, 1) - r(2, 2)) * 2;
    w = (r(2, 1) - r(1, 2)) / s;
    x = s / 4;
    y = (r(0, 1) + r(1, 0)) / s;
    z = (r(0, 2) + r(2, 0)) / s;
  } else if (r(1, 1) > r(2, 2)) {
    const s = Math.sqrt(1 + r(1, 1) - r(0, 0) - r(2, 2)) * 2;
    w = (r(0, 2) - r(2, 0)) / s;
    x = (r(0, 1) + r(1, 0)) / s;
    y = s / 4;
    z = (r(1, 2) + r(2, 1)) / s;
  } else {
    const s = Math.sqrt(1 + r(2, 2) - r(0, 0) - r(1, 1)) * 2;
    w = (r(1, 0) - r(0, 1)) / s;
    x = (r(0, 2) + r(2, 0)) / s;
    y = (r(1, 2) + r(2, 1)) / s;
    z = s / 4;
  }
  const n = Math.hypot(x, y, z, w);
  return { translation: [m[9]!, m[10]!, m[11]!], rotation: [x / n, y / n, z / n, w / n] };
}

const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
const isIdentity = (m: readonly number[]) => m.every((v, i) => v === IDENTITY[i]);

type Mutable3 = [number, number, number];

function localBounds(positions: Float32Array): { min: Vec3; max: Vec3 } | null {
  if (positions.length < 3) return null;
  const min: Mutable3 = [Infinity, Infinity, Infinity];
  const max: Mutable3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = positions[i + k]!;
      if (v < min[k]!) min[k] = v;
      if (v > max[k]!) max[k] = v;
    }
  }
  return { min, max };
}

/** Every body of every instance, in manifest order. */
export function viewerBodies(view: Mfkview): ViewerBody[] {
  const { manifest } = view;
  const prepared = view.meshes.map((m) => ({ ...toMeshData(m), bounds: localBounds(m.positions) }));
  const out: ViewerBody[] = [];
  manifest.instances.forEach((instance, i) => {
    const part = manifest.parts[instance.part];
    if (!part) return;
    const transform = isIdentity(instance.transform)
      ? undefined
      : matrixToTransform(instance.transform);
    const instanceName = displayText(instance.name, `Instance ${i + 1}`);
    for (const b of part.bodies) {
      const info = manifest.bodies[b];
      const mesh = prepared[b];
      if (!info || !mesh) continue;
      const input: BodyInput = {
        id: `${i}/${b}`,
        mesh: mesh.mesh,
        names: mesh.names,
        ...(info.color ? { color: info.color } : {}),
        ...(transform ? { transform } : {}),
      };
      out.push({
        id: input.id,
        name: displayText(info.name, `Body ${b + 1}`),
        instanceName,
        instance: i,
        body: b,
        info,
        input,
        bounds: mesh.bounds ? transformBounds(mesh.bounds, transform) : null,
      });
    }
  });
  return out;
}

/** The box around `bodies`, or null when there is nothing to bound. */
export function boundsOf(bodies: readonly ViewerBody[]): { min: Vec3; max: Vec3 } | null {
  let box: { min: Mutable3; max: Mutable3 } | null = null;
  for (const b of bodies) {
    if (!b.bounds) continue;
    if (!box) {
      box = { min: [...b.bounds.min], max: [...b.bounds.max] };
      continue;
    }
    for (let k = 0; k < 3; k++) {
      box.min[k] = Math.min(box.min[k]!, b.bounds.min[k]!);
      box.max[k] = Math.max(box.max[k]!, b.bounds.max[k]!);
    }
  }
  return box;
}
