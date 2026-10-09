// What the renderer draws of a regen result: every part's body meshes (with their face and edge
// names from the result's name table, and their colours from the document) and framing members
// as instances of shared meshes (a column-major 4x4 per member), as the app's viewport gets them.

import type { ManufaktureDocument, Pose } from '@manufakture/core';
import { UNNAMED, type MeshData } from '@manufakture/kernel/types';
import type {
  BodyResult,
  InstanceSourceRef,
  MemberInstances,
  MemberMeshData,
  RegenResult,
} from '@manufakture/regen';
import { BODY_PALETTE, memberColor, parseColor } from './colors';
import { err, ok, type RenderResult, type Rgb } from './types';

/** A triangle mesh drawn once per instance (once at the identity when `matrices` is null). */
export interface SceneMesh {
  kind: 'body' | 'member';
  partId: string;
  /** xyz per vertex, in the mesh's own frame. */
  positions: Float32Array;
  indices: Uint32Array;
  /** Edge polylines: xyz per point, and [first point, point count] per edge. */
  edgePositions: Float32Array;
  edgeRanges: Uint32Array;
  /** Bodies: per triangle, its 1-based face. Null for members. */
  triangleFaces: Uint32Array | null;
  /** Bodies: per face, its name, or null when regen did not name it. Empty for members. */
  faceNames: readonly (string | null)[];
  /** Per edge, its name or null (members' crease edges have none). */
  edgeNames: readonly (string | null)[];
  /** A column-major 4x4 per instance, mesh to world; null for one instance at the identity. */
  matrices: Float32Array | null;
  /** Per instance: its colour. */
  colors: Rgb[];
  /** Per instance: its name (a body id, or a member's full id). */
  names: string[];
  /**
   * The assembly instance this mesh is drawn as (`buildAssemblyScene`): its names then also
   * match patterns qualified with it (`inst#2/extrude#1`). Absent in a part studio scene.
   */
  instanceId?: string;
}

export interface Scene {
  meshes: SceneMesh[];
}

/** A body mesh from an earlier result, with that result's name table. */
export interface CachedBodyMesh {
  mesh: MeshData;
  names: readonly string[];
}

export interface SceneInput {
  /** The regen result: its parts, bodies, member sets and name table. */
  result: Pick<RegenResult, 'names' | 'parts'>;
  /**
   * Member shape meshes by key: everything `memberMeshes.added` has sent since the engine
   * started, less what `removed` dropped (as the app's member store keeps them).
   */
  memberMeshes?: ReadonlyMap<string, MemberMeshData>;
  /** For body colours: a body's own colour, else the colour it inherits, else the palette's. */
  document?: Pick<ManufaktureDocument, 'parts'>;
  /** Meshes of bodies the result reports unchanged (no mesh), by `<part id>/<body id>`. */
  bodyMeshes?: ReadonlyMap<string, CachedBodyMesh>;
  /** Instances of member sets the result reports unchanged, by `<part id>/<group>`. */
  memberInstances?: ReadonlyMap<string, readonly MemberInstances[]>;
}

/** One body's mesh as a scene mesh: its names from `names`, one instance at `matrix` (or none). */
function bodySceneMesh(
  partId: string,
  bodyId: string,
  mesh: MeshData,
  names: readonly string[],
  hex: string,
  matrix: Float32Array | null,
): SceneMesh {
  const name = (slot: number) => (slot === UNNAMED ? null : (names[slot] ?? null));
  return {
    kind: 'body',
    partId,
    positions: mesh.positions,
    indices: mesh.indices,
    edgePositions: mesh.edgePositions,
    edgeRanges: mesh.edgeRanges,
    triangleFaces: mesh.triangleFaces,
    faceNames: Array.from(mesh.faceNames, name),
    edgeNames: Array.from(mesh.edgeNames, name),
    matrices: matrix,
    colors: [parseColor(hex)],
    names: [bodyId],
  };
}

/** The scene of a regen result; an error when a mesh is neither in the result nor supplied. */
export function buildScene(input: SceneInput): RenderResult<Scene> {
  const meshes: SceneMesh[] = [];
  const missing: string[] = [];
  const { result } = input;
  for (const part of result.parts) {
    const docPart = input.document?.parts.find((p) => p.id === part.partId);
    part.bodies.forEach((body, index) => {
      const key = `${part.partId}/${body.bodyId}`;
      let mesh = body.mesh;
      let names: readonly string[] = result.names;
      if (!mesh) {
        const cached = input.bodyMeshes?.get(key);
        if (!cached) {
          missing.push(key);
          return;
        }
        mesh = cached.mesh;
        names = cached.names;
      }
      const props = docPart?.bodies.find((b) => b.id === body.bodyId);
      const hex =
        props?.color ?? body.inherited?.color ?? BODY_PALETTE[index % BODY_PALETTE.length]!;
      meshes.push(bodySceneMesh(part.partId, body.bodyId, mesh, names, hex, null));
    });
    for (const set of part.members ?? []) {
      const key = `${part.partId}/${set.group}`;
      const instances = set.instances ?? input.memberInstances?.get(key);
      if (!instances) {
        missing.push(key);
        continue;
      }
      for (const inst of instances) {
        const shape = input.memberMeshes?.get(inst.shape);
        if (!shape) {
          missing.push(`${key} (shape ${inst.shape})`);
          continue;
        }
        const creases = creaseEdgesOf(shape);
        meshes.push({
          kind: 'member',
          partId: part.partId,
          positions: shape.positions,
          indices: shape.indices,
          edgePositions: creases.edgePositions,
          edgeRanges: creases.edgeRanges,
          triangleFaces: null,
          faceNames: [],
          edgeNames: [],
          matrices: inst.matrices,
          colors: inst.roles.map((r) => parseColor(memberColor(r))),
          names: [...inst.ids],
        });
      }
    }
  }
  if (missing.length > 0)
    return err('missing-mesh', `no mesh for ${missing.join(', ')}: pass them in the input`);
  return ok({ meshes });
}

// Assemblies ------------------------------------------------------------------------------------

/** An assembly instance to draw: the bodies it shows, where. */
export interface AssemblySceneInstance {
  instanceId: string;
  /** Where its bodies are in the result (`InstanceResult.source`). */
  source: InstanceSourceRef;
  /** The body ids it shows (`InstanceResult.bodies`). */
  bodies: readonly string[];
  /** Instance coordinates to world. */
  pose: Pose;
}

export interface AssemblySceneInput {
  /** The regen result: its parts, the sources instances show, and its name table. */
  result: Pick<RegenResult, 'names' | 'parts' | 'sources'>;
  /** The instances drawn, in order (suppressed ones left out by the caller). */
  instances: readonly AssemblySceneInstance[];
  /** For body colours of this document's parts, as in `SceneInput`. */
  document?: Pick<ManufaktureDocument, 'parts'>;
  /**
   * Meshes of bodies the result reports unchanged (no mesh): `<part id>/<body id>` for a part of
   * this document, `<source key>/<body id>` for a source.
   */
  bodyMeshes?: ReadonlyMap<string, CachedBodyMesh>;
}

/**
 * The column-major 4x4 of a pose (instance coordinates to world), from its translation and unit
 * quaternion [x, y, z, w] (normalised here).
 */
export function poseMatrix(pose: Pose): Float32Array {
  const [qx, qy, qz, qw] = pose.rotation;
  const n = Math.hypot(qx, qy, qz, qw) || 1;
  const x = qx / n;
  const y = qy / n;
  const z = qz / n;
  const w = qw / n;
  const [tx, ty, tz] = pose.translation;
  // prettier-ignore
  return new Float32Array([
    1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w), 0,
    2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w), 0,
    2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y), 0,
    tx, ty, tz, 1,
  ]);
}

/**
 * The scene of an assembly: each instance's bodies (meshes of its part or source, coloured as in
 * the part studio) placed at its pose, named by body id and matched qualified with the instance
 * too. Framing members are not drawn: an instance shows bodies. An error when an instance's
 * source or a body's mesh is neither in the result nor supplied.
 */
export function buildAssemblyScene(input: AssemblySceneInput): RenderResult<Scene> {
  const meshes: SceneMesh[] = [];
  const missing: string[] = [];
  const { result } = input;
  for (const inst of input.instances) {
    let partId: string;
    let key: string;
    let bodies: readonly BodyResult[];
    let docPart: ManufaktureDocument['parts'][number] | undefined;
    if ('part' in inst.source) {
      const id = inst.source.part;
      const part = result.parts.find((p) => p.partId === id);
      if (part === undefined) {
        missing.push(`${inst.instanceId} (part ${id})`);
        continue;
      }
      partId = id;
      key = id;
      bodies = part.bodies;
      docPart = input.document?.parts.find((p) => p.id === id);
    } else {
      const k = inst.source.source;
      const source = result.sources.find((x) => x.key === k);
      if (source === undefined) {
        missing.push(`${inst.instanceId} (source ${k})`);
        continue;
      }
      partId = source.partId;
      key = k;
      bodies = source.bodies;
      docPart = undefined;
    }
    const matrix = poseMatrix(inst.pose);
    for (const bodyId of inst.bodies) {
      const index = bodies.findIndex((b) => b.bodyId === bodyId);
      const body = bodies[index];
      if (body === undefined) {
        missing.push(`${inst.instanceId} (${key}/${bodyId})`);
        continue;
      }
      let mesh = body.mesh;
      let names: readonly string[] = result.names;
      if (!mesh) {
        const cached = input.bodyMeshes?.get(`${key}/${bodyId}`);
        if (!cached) {
          missing.push(`${inst.instanceId} (${key}/${bodyId})`);
          continue;
        }
        mesh = cached.mesh;
        names = cached.names;
      }
      const props = docPart?.bodies.find((b) => b.id === bodyId);
      const hex =
        props?.color ?? body.inherited?.color ?? BODY_PALETTE[index % BODY_PALETTE.length]!;
      const m = bodySceneMesh(partId, bodyId, mesh, names, hex, matrix);
      m.instanceId = inst.instanceId;
      meshes.push(m);
    }
  }
  if (missing.length > 0)
    return err('missing-mesh', `no mesh for ${missing.join(', ')}: pass them in the input`);
  return ok({ meshes });
}

// Crease edges ----------------------------------------------------------------------------------

interface Creases {
  edgePositions: Float32Array;
  edgeRanges: Uint32Array;
}

/** Computed once per member shape mesh (regen sends a shape once and shares it). */
const creaseCache = new WeakMap<MemberMeshData, Creases>();

function creaseEdgesOf(mesh: MemberMeshData): Creases {
  let c = creaseCache.get(mesh);
  if (!c) creaseCache.set(mesh, (c = creaseEdges(mesh.positions, mesh.indices)));
  return c;
}

/** cos 20 degrees, as a literal: no transcendental function anywhere in the pipeline. */
const COS_CREASE = 0.9396926207859084;

/**
 * Crease edges of a mesh: every edge whose two triangles meet at more than 20 degrees, plus
 * boundary edges. Vertices are matched by position (a flat-shaded mesh repeats them per face).
 * What three.js `EdgesGeometry` does, as the viewport draws members.
 */
export function creaseEdges(
  positions: Float32Array,
  indices: Uint32Array,
  cos = COS_CREASE,
): Creases {
  const ids = new Map<string, number>();
  const vid = new Uint32Array(positions.length / 3);
  for (let i = 0; i < vid.length; i++) {
    const k = `${Math.round(positions[3 * i]! * 1e4)},${Math.round(positions[3 * i + 1]! * 1e4)},${Math.round(positions[3 * i + 2]! * 1e4)}`;
    let id = ids.get(k);
    if (id === undefined) ids.set(k, (id = i));
    vid[i] = id;
  }
  const normals = new Float64Array(indices.length);
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t]!;
    const b = indices[t + 1]!;
    const c = indices[t + 2]!;
    const ux = positions[3 * b]! - positions[3 * a]!;
    const uy = positions[3 * b + 1]! - positions[3 * a + 1]!;
    const uz = positions[3 * b + 2]! - positions[3 * a + 2]!;
    const vx = positions[3 * c]! - positions[3 * a]!;
    const vy = positions[3 * c + 1]! - positions[3 * a + 1]!;
    const vz = positions[3 * c + 2]! - positions[3 * a + 2]!;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    normals[t] = nx / l;
    normals[t + 1] = ny / l;
    normals[t + 2] = nz / l;
  }
  const edges = new Map<string, { a: number; b: number; tris: number[] }>();
  for (let t = 0; t < indices.length / 3; t++) {
    for (let e = 0; e < 3; e++) {
      const a = vid[indices[3 * t + e]!]!;
      const b = vid[indices[3 * t + ((e + 1) % 3)]!]!;
      if (a === b) continue;
      const k = a < b ? `${a},${b}` : `${b},${a}`;
      let entry = edges.get(k);
      if (!entry) edges.set(k, (entry = { a: Math.min(a, b), b: Math.max(a, b), tris: [] }));
      entry.tris.push(t);
    }
  }
  const out: number[] = [];
  for (const { a, b, tris } of edges.values()) {
    let crease = tris.length !== 2;
    if (!crease) {
      const s = 3 * tris[0]!;
      const t = 3 * tris[1]!;
      const d =
        normals[s]! * normals[t]! +
        normals[s + 1]! * normals[t + 1]! +
        normals[s + 2]! * normals[t + 2]!;
      crease = d < cos;
    }
    if (crease)
      out.push(
        positions[3 * a]!,
        positions[3 * a + 1]!,
        positions[3 * a + 2]!,
        positions[3 * b]!,
        positions[3 * b + 1]!,
        positions[3 * b + 2]!,
      );
  }
  const n = out.length / 6;
  const ranges = new Uint32Array(2 * n);
  for (let i = 0; i < n; i++) {
    ranges[2 * i] = 2 * i;
    ranges[2 * i + 1] = 2;
  }
  return { edgePositions: new Float32Array(out), edgeRanges: ranges };
}
