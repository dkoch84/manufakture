// Representations B and C: member data in TypeScript, one mesh per distinct member shape, one
// transform per member. A warm regen replaces one group's members, meshes only shapes the cache
// does not have yet, and rebuilds the instance lists.

import { clipMesh, triangleCount, type MeshData } from './clip.ts';
import { placementMatrix } from './geom.ts';
import { shapeKey, type Member } from './members.ts';

export type Mesher = (m: Member) => MeshData;

/** The meshes of uncut members are always computed in TypeScript; `cut` meshes the others. */
export function mesherFor(cut: Mesher): Mesher {
  return (m) => (m.cuts.length === 0 ? clipMesh(m) : cut(m));
}

export interface InstanceList {
  key: string;
  /** `<group>:<member id>` per instance, the pick result. */
  ids: string[];
  roles: string[];
  groups: string[];
  /** Column-major 4x4 per instance. */
  matrices: Float32Array;
}

export class MemberSet {
  readonly groups = new Map<string, Member[]>();
  readonly meshes = new Map<string, MeshData>();
  meshed = 0;
  private readonly mesher: Mesher;

  constructor(mesher: Mesher) {
    this.mesher = mesher;
  }

  /** Set a group's members, meshing shapes not seen before. */
  setGroup(group: string, members: Member[]): void {
    this.groups.set(group, members);
    for (const m of members) {
      const key = shapeKey(m);
      if (!this.meshes.has(key)) {
        this.meshes.set(key, this.mesher(m));
        this.meshed++;
      }
    }
  }

  /** Drop meshes no member uses any more. */
  prune(): number {
    const used = new Set<string>();
    for (const ms of this.groups.values()) for (const m of ms) used.add(shapeKey(m));
    let n = 0;
    for (const k of this.meshes.keys())
      if (!used.has(k)) {
        this.meshes.delete(k);
        n++;
      }
    return n;
  }

  instances(): InstanceList[] {
    const by = new Map<string, Member[]>();
    for (const ms of this.groups.values())
      for (const m of ms) {
        const key = shapeKey(m);
        const list = by.get(key);
        if (list) list.push(m);
        else by.set(key, [m]);
      }
    return [...by].map(([key, ms]) => {
      const matrices = new Float32Array(ms.length * 16);
      ms.forEach((m, i) => matrices.set(placementMatrix(m.placement), i * 16));
      return {
        key,
        ids: ms.map((m) => `${m.group}:${m.id}`),
        roles: ms.map((m) => m.role),
        groups: ms.map((m) => m.group),
        matrices,
      };
    });
  }

  members(): Member[] {
    return [...this.groups.values()].flat();
  }

  stats() {
    let meshBytes = 0;
    let meshTriangles = 0;
    for (const m of this.meshes.values()) {
      meshBytes += m.positions.byteLength + m.normals.byteLength + m.indices.byteLength;
      meshTriangles += triangleCount(m);
    }
    let sceneTriangles = 0;
    for (const ms of this.groups.values())
      for (const m of ms) sceneTriangles += triangleCount(this.meshes.get(shapeKey(m))!);
    const members = this.members().length;
    return {
      members,
      meshes: this.meshes.size,
      meshTriangles,
      sceneTriangles,
      meshBytes,
      matrixBytes: members * 64,
    };
  }
}
