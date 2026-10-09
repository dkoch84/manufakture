// What the session knows of the model between regens. A regen sends a body's mesh and topology
// and a member set's members only when they changed since the regen before (ADR 0007), as the app
// keeps them on its side; this keeps the plain data the read queries need: each body's face and
// edge names with their geometry (the name table, `findGeometry`'s index), and each framing set's
// members (the takeoff). Every completed regen of the session's engine must pass through
// `update`, in order; after the engine is replaced, the next regen sends everything again.

import type { EdgeInfo, FaceInfo, VertexInfo } from '@manufakture/kernel';
import { UNNAMED } from '@manufakture/kernel';
import type { JsonValue, MemberData, MemberInstances, RegenResult } from '@manufakture/regen';

export interface NamedFace extends FaceInfo {
  /** The face's persistent name, or null when regen has not named it. */
  name: string | null;
  /** The name is positional (ADR 0007 decision 7): it may move to another face on an edit. */
  fragile: boolean;
}

export interface NamedEdge extends EdgeInfo {
  name: string | null;
  fragile: boolean;
}

export interface BodyGeometry {
  faces: NamedFace[];
  edges: NamedEdge[];
  vertices: VertexInfo[];
}

export interface KnownSet {
  partId: string;
  group: string;
  namespace: string;
  setKey: string;
  members: MemberData[];
  instances: MemberInstances[];
  /** What the member stage returned beside the members (override statuses, header sources). */
  metadata?: JsonValue;
}

export class ModelState {
  /** Geometry by body key: equal keys are identical bodies. */
  readonly #geometry = new Map<string, BodyGeometry>();
  readonly #sets = new Map<string, KnownSet>();
  #last: RegenResult | null = null;

  /** The last completed regen. */
  get last(): RegenResult | null {
    return this.#last;
  }

  /** Forget everything: the engine was replaced, and its next regen sends it all again. */
  reset(): void {
    this.#geometry.clear();
    this.#sets.clear();
    this.#last = null;
  }

  update(result: RegenResult): void {
    const live = new Set<string>();
    for (const part of result.parts) {
      for (const body of part.bodies) {
        live.add(body.bodyKey);
        if (body.mesh === null || body.topology === null) continue;
        const name = (slot: number | undefined) =>
          slot === undefined || slot === UNNAMED ? null : (result.names[slot] ?? null);
        const { mesh, topology } = body;
        this.#geometry.set(body.bodyKey, {
          faces: topology.faces.map((f, i) => ({
            ...f,
            name: name(mesh.faceNames[i]),
            fragile: mesh.faceFragile[i] === 1,
          })),
          edges: topology.edges.map((e, i) => ({
            ...e,
            name: name(mesh.edgeNames[i]),
            fragile: mesh.edgeFragile[i] === 1,
          })),
          vertices: topology.vertices,
        });
      }
    }
    for (const key of [...this.#geometry.keys()]) if (!live.has(key)) this.#geometry.delete(key);

    const sets = new Set<string>();
    for (const part of result.parts) {
      for (const set of part.members ?? []) {
        const key = `${part.partId}\u0000${set.group}`;
        sets.add(key);
        if (set.members !== null && set.instances !== null) {
          this.#sets.set(key, {
            partId: part.partId,
            group: set.group,
            namespace: set.namespace,
            setKey: set.setKey,
            members: set.members,
            instances: set.instances,
            ...(set.metadata === undefined ? {} : { metadata: set.metadata }),
          });
        }
      }
    }
    for (const key of [...this.#sets.keys()]) if (!sets.has(key)) this.#sets.delete(key);
    this.#last = result;
  }

  /** The geometry of a body by its key, when known. */
  geometry(bodyKey: string): BodyGeometry | undefined {
    return this.#geometry.get(bodyKey);
  }

  /** The member sets of a part, as the last regen left them. */
  sets(partId: string): KnownSet[] {
    return [...this.#sets.values()].filter((s) => s.partId === partId);
  }
}
