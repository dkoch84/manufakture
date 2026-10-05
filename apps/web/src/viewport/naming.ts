// THE NAMING SEAM. Picking returns names (ADR 0007, decision 8), and names come from the kernel's
// naming layer, which regen runs for every regenerated part: it fills every face and edge slot of
// the part's mesh in the kernel worker. Meshes that do not come from regen (an imported STL, the
// kernel-free test scenes) arrive with `UNNAMED` slots.
//
// This module is the one place the viewport makes names up. It fills only the slots the naming
// layer left `UNNAMED`, with names that start with `PLACEHOLDER_PREFIX`, are marked fragile, and
// are flagged `placeholder` on the selection (see GeometryRef), so nothing downstream can mistake
// them for real references or store them in a document. On a regenerated part,
// `fillPlaceholderNames` changes nothing.
//
// Two kinds of "not a real name" therefore exist, and they mean different things:
//
// - `?faceN` (the kernel's `UNNAMED_PREFIX`, `isUnnamed`) is a name the naming layer gives a
//   face of a regenerated part that no history reached. It sits in the part's name table like
//   any other name, can appear inside a wrapped name (`shell#2:offset:?face3`), and is fragile;
//   `?` is reserved in ids, so it can never be stored as a reference.
// - `placeholder:<kind>:<index>` (here) stands in for a slot no naming ran on at all. It is the
//   mesh's own 1-based sub-shape index, which the measurer reads back to address the kernel
//   (src/measure/measurer.ts), so it only means something for the mesh it was made for.
//
// A `?faceN` face is therefore never a viewport placeholder: picking returns it by name, marked
// fragile from the mesh's fragile flags. They are kept apart because the placeholder encodes an
// index the kernel name does not, and the kernel name lives in documents' name grammar
// (core's names.ts) where the viewport's cannot.
//
// Vertices have no name slots in `MeshData` yet, so vertex names are always placeholders.

// Narrow imports, not the package indexes: the viewer (src/viewer/) draws with this module and
// must not load the kernel or the rest of core (its bundle check, src/viewer/bundleCheck.ts).
import { featureIdsInName } from '@manufakture/core/names';
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
 * Whether a face name comes from feature `featureId`: one of the feature ids core reads in it
 * (`featureIdsInName`, the same rule validation and regen use for dependencies). That is the
 * feature that named it at birth (`extrude#1:cap:end`), and any feature whose name it holds in a
 * merge, corner, nested tail or instance (`(extrude#1:side:e1+extrude#2:side:e5)`,
 * `fillet#1:corner:A&B&C`, `shell#2:offset:extrude#1:cap:end`, `pattern#1:i2/hole#1:wall:e3`).
 * An id counts only at a token start (`xextrude#1:` is not `extrude#1`), and only with a known
 * feature kind and its `:`. What follows `<id>:from/` is a name in a derived part's source
 * document, so `derived#1:from/extrude#1:cap:end` comes from `derived#1` and not from this
 * document's `extrude#1`.
 */
export function nameFromFeature(name: string, featureId: string): boolean {
  return featureIdsInName(name).includes(featureId);
}
