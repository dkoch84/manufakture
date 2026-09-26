// THE NAMING SEAM. Picking returns names (ADR 0007, decision 8), and names
// come from the regen engine's naming layer (#931), which fills a mesh's name
// slots in the kernel worker. Until it does, every slot arrives `UNNAMED`.
//
// This module is the one place the viewport makes names up. It fills only the
// slots the naming layer left `UNNAMED`, with names that start with
// `PLACEHOLDER_PREFIX`, are marked fragile, and are flagged `placeholder` on
// the selection (see GeometryRef), so nothing downstream can mistake them for
// real references or store them in a document. Once #931 names every face and
// edge, `fillPlaceholderNames` becomes a no-op for faces and edges.
//
// Vertices have no name slots in `MeshData` yet, so vertex names are always
// placeholders; extending the mesh with vertex slots is #931's to decide.

import { NameTable, UNNAMED, type MeshData } from '@manufakture/kernel';

export const PLACEHOLDER_PREFIX = 'placeholder:';

export function isPlaceholderName(name: string): boolean {
  return name.startsWith(PLACEHOLDER_PREFIX);
}

export function placeholderName(kind: 'face' | 'edge' | 'vertex', index: number): string {
  return `${PLACEHOLDER_PREFIX}${kind}:${index}`;
}

/**
 * Fill the `UNNAMED` face and edge slots of `mesh` in place with placeholder
 * names (fragile), and return the name table extended with them. Slots that
 * already have a name keep it, with the same index.
 */
export function fillPlaceholderNames(mesh: MeshData, names: readonly string[]): string[] {
  const table = new NameTable();
  for (const n of names) table.intern(n);
  const fill = (slots: Uint32Array, fragile: Uint8Array, kind: 'face' | 'edge') => {
    for (let i = 0; i < slots.length; i++) {
      if (slots[i] !== UNNAMED) continue;
      slots[i] = table.intern(placeholderName(kind, i + 1));
      fragile[i] = 1;
    }
  };
  fill(mesh.faceNames, mesh.faceFragile, 'face');
  fill(mesh.edgeNames, mesh.edgeFragile, 'edge');
  return table.names;
}
