// What Node and Chromium are compared on, from one complete regen (a fresh engine, so every body
// and member set carries its mesh): per feature its status, cache key and how its references
// resolved; the name table; per body a hash of its mesh and the names on its faces and edges; per
// framing set a hash of its instance matrices and of each member shape's mesh; and per body the
// kernel's exact measurements (volume, area, centre of mass, bounding box).
//
// Browser-safe: no Node imports. Hashes are SHA-256 over the arrays' bytes (`crypto.subtle`, in
// Node and in a secure browser context alike), so "equal" means bit for bit.

import type { RegenResult } from '../../../packages/regen/src/types';
import type { MeshData } from '../../../packages/kernel/src/types';

export interface BodyMeasureLike {
  volume: number;
  area: number;
  centerOfMass: [number, number, number] | null;
  boundingBox: { min: [number, number, number]; max: [number, number, number] } | null;
}

export interface FeatureSummary {
  id: string;
  status: string;
  key: string | null;
  errors: string[];
  warnings: string[];
  references: string[];
}

export interface BodySummary {
  part: string;
  body: string;
  bodyKey: string;
  solids: number;
  mesh: string;
  triangles: number;
  /** The names on the mesh's faces and edges, in mesh order, `~` marking a positional one. */
  faceNames: string;
  edgeNames: string;
  measure: BodyMeasureLike | null;
}

export interface Summary {
  features: Record<string, FeatureSummary[]>;
  names: string;
  bodies: BodySummary[];
  /** Per framing group: count, set key and a hash of its instance lists. */
  members: { group: string; count: number; setKey: string; instances: string }[];
  /** Member shape meshes by key, hashed. */
  memberMeshes: Record<string, string>;
  /**
   * The member meshes' vertex positions, to say how far apart two that differ are. Not compared
   * by `compareSummaries` (the hashes are); see `maxPositionDifference`.
   */
  memberPositions: Record<string, { positions: number[]; indices: number[] }>;
  assemblies: { assembly: string; instances: string }[];
}

async function sha256(chunks: readonly ArrayBufferView[]): Promise<string> {
  let size = 0;
  for (const c of chunks) size += c.byteLength + 8;
  const all = new Uint8Array(size);
  const view = new DataView(all.buffer);
  let at = 0;
  for (const c of chunks) {
    // Length-prefixed, so two arrays never hash like their concatenation.
    view.setFloat64(at, c.byteLength, true);
    at += 8;
    all.set(new Uint8Array(c.buffer, c.byteOffset, c.byteLength), at);
    at += c.byteLength;
  }
  const digest = await crypto.subtle.digest('SHA-256', all);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const text = (s: string) => new TextEncoder().encode(s);

export function meshHash(mesh: MeshData): Promise<string> {
  return sha256([
    mesh.positions,
    mesh.normals,
    mesh.indices,
    mesh.faceRanges,
    mesh.triangleFaces,
    mesh.edgePositions,
    mesh.edgeRanges,
  ]);
}

function slotNames(names: readonly string[], slots: Uint32Array, fragile: Uint8Array): string {
  return Array.from(slots, (s, i) => `${fragile[i] ? '~' : ''}${names[s] ?? '?'}`).join('\n');
}

/**
 * The summary of `result`, a complete regen (every body's mesh present). `measure` gives the
 * kernel's `measure` op with `body: true` for a shape of the result.
 */
export async function summarize(
  result: RegenResult,
  measure: (shape: number) => Promise<BodyMeasureLike | null>,
): Promise<Summary> {
  const features: Summary['features'] = {};
  const bodies: BodySummary[] = [];
  const members: Summary['members'] = [];
  for (const part of result.parts) {
    features[part.partId] = part.features.map((f) => ({
      id: f.featureId,
      status: f.status,
      key: f.key ?? null,
      errors: f.errors.map((e) => `${e.code}: ${e.message}`),
      warnings: f.warnings.map((w) => JSON.stringify(w)),
      references: f.references.map((r) => `${r.referenceId}=${r.target}/${r.via}`),
    }));
    for (const b of part.bodies) {
      if (b.mesh === null) throw new Error(`${part.partId} ${b.bodyId}: no mesh in a full regen`);
      bodies.push({
        part: part.partId,
        body: b.bodyId,
        bodyKey: b.bodyKey,
        solids: b.solids,
        mesh: await meshHash(b.mesh),
        triangles: b.mesh.indices.length / 3,
        faceNames: slotNames(result.names, b.mesh.faceNames, b.mesh.faceFragile),
        edgeNames: slotNames(result.names, b.mesh.edgeNames, b.mesh.edgeFragile),
        measure: await measure(b.shape as unknown as number),
      });
    }
    for (const set of part.members ?? []) {
      const lists = set.instances ?? [];
      members.push({
        group: set.group,
        count: set.count,
        setKey: set.setKey,
        instances: await sha256(
          lists.flatMap((l) => [
            text(`${l.shape}|${l.ids.join(',')}|${l.roles.join(',')}`),
            l.matrices,
          ]),
        ),
      });
    }
  }
  const memberMeshes: Record<string, string> = {};
  const memberPositions: Summary['memberPositions'] = {};
  for (const m of result.memberMeshes?.added ?? []) {
    memberMeshes[m.key] = await sha256([m.positions, m.normals, m.indices]);
    memberPositions[m.key] = { positions: Array.from(m.positions), indices: Array.from(m.indices) };
  }
  const assemblies = result.assemblies.map((a) => ({
    assembly: a.assemblyId,
    instances: JSON.stringify(
      a.instances.map((i) => [i.instanceId, i.status, i.bodies, i.transform, i.moved]),
    ),
  }));
  return {
    features,
    names: result.names.join('\n'),
    bodies,
    members,
    memberMeshes,
    memberPositions,
    assemblies,
  };
}

/** Where two summaries differ, as readable lines (empty: identical). */
export function compareSummaries(a: Summary, b: Summary): string[] {
  const out: string[] = [];
  const diff = (path: string, x: unknown, y: unknown) => {
    const sx = JSON.stringify(x);
    const sy = JSON.stringify(y);
    if (sx !== sy) out.push(`${path}: ${sx.slice(0, 300)} != ${sy.slice(0, 300)}`);
  };
  diff('names', a.names, b.names);
  diff('features', a.features, b.features);
  diff('bodies.length', a.bodies.length, b.bodies.length);
  a.bodies.forEach((x, i) => {
    const y = b.bodies[i];
    if (!y) return;
    for (const k of Object.keys(x) as (keyof BodySummary)[]) {
      diff(`bodies[${x.part}/${x.body}].${k}`, x[k], y[k]);
    }
  });
  diff('members', a.members, b.members);
  diff('memberMeshes', a.memberMeshes, b.memberMeshes);
  diff('assemblies', a.assemblies, b.assemblies);
  return out;
}

/** The volume a closed triangle mesh encloses (mm3), by the divergence theorem. */
function meshVolume(positions: readonly number[], indices: readonly number[]): number {
  let v = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const [a, b, c] = [indices[t]! * 3, indices[t + 1]! * 3, indices[t + 2]! * 3];
    const [ax, ay, az] = [positions[a]!, positions[a + 1]!, positions[a + 2]!];
    const [bx, by, bz] = [positions[b]!, positions[b + 1]!, positions[b + 2]!];
    const [cx, cy, cz] = [positions[c]!, positions[c + 1]!, positions[c + 2]!];
    v += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  return v / 6;
}

/**
 * The farthest any vertex of one mesh is from the nearest vertex of the other, both ways (mm): two
 * meshes with the same corners in another order are 0 apart.
 */
function vertexDistance(a: readonly number[], b: readonly number[]): number {
  const oneWay = (p: readonly number[], q: readonly number[]) => {
    let worst = 0;
    for (let i = 0; i < p.length; i += 3) {
      let best = Infinity;
      for (let j = 0; j < q.length; j += 3) {
        best = Math.min(
          best,
          Math.hypot(p[i]! - q[j]!, p[i + 1]! - q[j + 1]!, p[i + 2]! - q[j + 2]!),
        );
      }
      worst = Math.max(worst, best);
    }
    return worst;
  };
  return Math.max(oneWay(a, b), oneWay(b, a));
}

/**
 * For each member mesh whose hash differs: the vertex counts, the largest difference of a vertex
 * coordinate in mesh order, how far apart the two vertex sets are in any order (mm), and the
 * volumes both enclose.
 */
export function memberMeshDifferences(a: Summary, b: Summary) {
  const out: {
    key: string;
    vertices: [number, number];
    maxAbsMm: number;
    vertexSetDistanceMm: number;
    volumes: [number, number];
  }[] = [];
  for (const [key, hash] of Object.entries(a.memberMeshes)) {
    if (b.memberMeshes[key] === undefined || b.memberMeshes[key] === hash) continue;
    const ma = a.memberPositions[key]!;
    const mb = b.memberPositions[key]!;
    let max = Infinity;
    if (ma.positions.length === mb.positions.length) {
      max = 0;
      for (let i = 0; i < ma.positions.length; i++) {
        max = Math.max(max, Math.abs(ma.positions[i]! - mb.positions[i]!));
      }
    }
    out.push({
      key,
      vertices: [ma.positions.length / 3, mb.positions.length / 3],
      maxAbsMm: max,
      vertexSetDistanceMm: vertexDistance(ma.positions, mb.positions),
      volumes: [meshVolume(ma.positions, ma.indices), meshVolume(mb.positions, mb.indices)],
    });
  }
  return out;
}
