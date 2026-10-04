// THE NAMING SEAM. Picking returns names (ADR 0007, decision 8), and names
// come from the regen engine's naming layer (#931), which fills every face and
// edge slot of a regenerated part's mesh in the kernel worker. Meshes that do
// not come from regen (an imported STL, the kernel-free test scenes) arrive
// with `UNNAMED` slots.
//
// This module is the one place the viewport makes names up. It fills only the
// slots the naming layer left `UNNAMED`, with names that start with
// `PLACEHOLDER_PREFIX`, are marked fragile, and are flagged `placeholder` on
// the selection (see GeometryRef), so nothing downstream can mistake them for
// real references or store them in a document. On a regenerated part,
// `fillPlaceholderNames` changes nothing.
//
// Vertices have no name slots in `MeshData` yet, so vertex names are always
// placeholders; extending the mesh with vertex slots is #931's to decide.

// Narrow imports, not the package index: the viewer (src/viewer/) draws with this module and must
// not load the kernel (its bundle check, src/viewer/bundleCheck.ts).
import { NameTable } from '@manufakture/kernel/names';
import { UNNAMED, type MeshData } from '@manufakture/kernel/types';

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

/**
 * Whether a face name comes from feature `featureId`: the feature named it at birth
 * (`extrude#1:cap:end`), or it holds such a name inside a merge, corner, edge or instance name
 * (`(extrude#1:side:e1+extrude#2:side:e5)`, `fillet#1:corner:A&B&C`, `pattern#1:i2/hole#1:wall:e3`).
 */
export function nameFromFeature(name: string, featureId: string): boolean {
  let at = name.indexOf(`${featureId}:`);
  while (at >= 0) {
    if (at === 0 || '(+&/|'.includes(name[at - 1]!)) return true;
    at = name.indexOf(`${featureId}:`, at + 1);
  }
  return false;
}
