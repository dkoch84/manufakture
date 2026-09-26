// Name tables for meshes (ADR 0007, decision 7). The kernel only knows
// sub-shape indices; the regen engine's naming layer knows names. It fills a
// mesh's name slots through a NameTable, and the table's strings travel once
// per reply next to the meshes.

import { UNNAMED, type MeshData } from './types';

export interface SubShapeName {
  name: string;
  /** The name is positional, so the UI warns when it is picked (T0.5). */
  fragile?: boolean;
}

/** Interns strings; `names` is what goes into a reply. */
export class NameTable {
  private readonly index = new Map<string, number>();
  readonly names: string[] = [];

  intern(name: string): number {
    let i = this.index.get(name);
    if (i === undefined) {
      i = this.names.length;
      if (i >= UNNAMED) throw new RangeError('name table is full');
      this.names.push(name);
      this.index.set(name, i);
    }
    return i;
  }

  lookup(slot: number): string | undefined {
    return slot === UNNAMED ? undefined : this.names[slot];
  }
}

/**
 * Fill a mesh's face and edge name slots. The callbacks get 1-based face and
 * edge indices (the numbering of history and topology) and return a name, or
 * null to leave the slot `UNNAMED`.
 */
export function applyNames(
  mesh: MeshData,
  table: NameTable,
  faceName: (face: number) => SubShapeName | null,
  edgeName: (edge: number) => SubShapeName | null = () => null,
): void {
  for (let i = 0; i < mesh.faceNames.length; i++) {
    const n = faceName(i + 1);
    mesh.faceNames[i] = n === null ? UNNAMED : table.intern(n.name);
    mesh.faceFragile[i] = n?.fragile ? 1 : 0;
  }
  for (let i = 0; i < mesh.edgeNames.length; i++) {
    const n = edgeName(i + 1);
    mesh.edgeNames[i] = n === null ? UNNAMED : table.intern(n.name);
    mesh.edgeFragile[i] = n?.fragile ? 1 : 0;
  }
}

/** The face picked by a triangle, then its name (ADR 0007, decision 8: picking returns a name). */
export function faceNameOfTriangle(
  mesh: MeshData,
  names: readonly string[],
  triangle: number,
): string | undefined {
  const face = mesh.triangleFaces[triangle];
  if (face === undefined || face === 0) return undefined;
  const slot = mesh.faceNames[face - 1];
  return slot === undefined || slot === UNNAMED ? undefined : names[slot];
}
