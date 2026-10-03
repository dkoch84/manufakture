// What the feature tree, the toolbar and the app shell need to know about construction features,
// without loading the construction domain (its panels and tools load on demand): whether a
// feature is a wall, an opening, a floor or a roof, the domain's name for it, and whether a document has any
// construction at all. The type names are the domain's (`WALL_TYPE`, `OPENING_TYPE`; a test checks
// they agree, and `FLOOR_TYPE`, `ROOF_TYPE`).

import type { ExtensionFeature, Feature, ManufaktureDocument } from '@manufakture/core';

export const WALL_FEATURE = 'construction.wall';
export const OPENING_FEATURE = 'construction.opening';
export const FLOOR_FEATURE = 'construction.floor';
export const ROOF_FEATURE = 'construction.roof';
export const CONSTRUCTION_DOMAIN = 'construction';

/** A wall feature (the literal type keeps a false check from narrowing other extensions away). */
export type WallFeature = ExtensionFeature & { extension: typeof WALL_FEATURE };
export type OpeningFeature = ExtensionFeature & { extension: typeof OPENING_FEATURE };
export type FloorFeature = ExtensionFeature & { extension: typeof FLOOR_FEATURE };
export type RoofFeature = ExtensionFeature & { extension: typeof ROOF_FEATURE };

export function isWall(f: Feature): f is WallFeature {
  return f.kind === 'extension' && f.extension === WALL_FEATURE;
}

export function isOpening(f: Feature): f is OpeningFeature {
  return f.kind === 'extension' && f.extension === OPENING_FEATURE;
}

export function isFloor(f: Feature): f is FloorFeature {
  return f.kind === 'extension' && f.extension === FLOOR_FEATURE;
}

export function isRoof(f: Feature): f is RoofFeature {
  return f.kind === 'extension' && f.extension === ROOF_FEATURE;
}

/** Any construction feature: a wall, an opening, a floor or a roof. */
export function isConstruction(f: Feature): boolean {
  return isWall(f) || isOpening(f) || isFloor(f) || isRoof(f);
}

/** "Wall", "Door", "Window", "Opening", "Floor", "Roof"; null for anything else. */
export function constructionLabel(f: Feature): string | null {
  if (isWall(f)) return 'Wall';
  if (isFloor(f)) return 'Floor';
  if (isRoof(f)) return 'Roof';
  if (!isOpening(f)) return null;
  const kind = f.params.kind;
  return kind === 'door' ? 'Door' : kind === 'window' ? 'Window' : 'Opening';
}

/** Whether the document has construction settings or any construction feature. */
export function hasConstruction(doc: ManufaktureDocument): boolean {
  if (doc.domains?.[CONSTRUCTION_DOMAIN] !== undefined) return true;
  return doc.parts.some((p) => p.features.some(isConstruction));
}

/** Whether floors and roofs can be added: the document has a level (as stored). */
export function constructionHasLevel(doc: ManufaktureDocument): boolean {
  const data = doc.domains?.[CONSTRUCTION_DOMAIN]?.data as { levels?: unknown } | undefined;
  return Array.isArray(data?.levels) && data.levels.length > 0;
}

/** Whether walls can be drawn: the document has a level and a wall type (as stored). */
export function constructionReady(doc: ManufaktureDocument): boolean {
  const data = doc.domains?.[CONSTRUCTION_DOMAIN]?.data as
    { levels?: unknown; wallTypes?: unknown } | undefined;
  return (
    Array.isArray(data?.levels) &&
    data.levels.length > 0 &&
    Array.isArray(data.wallTypes) &&
    data.wallTypes.length > 0
  );
}

/** `o` without `key`. */
export function omit<T extends object, K extends keyof T>(o: T, key: K): Omit<T, K> {
  const out = { ...o };
  delete out[key];
  return out;
}

/** Whether the part studio has a wall (for the Opening tool). */
export function partHasWalls(doc: ManufaktureDocument, partId: string): boolean {
  return doc.parts.some((p) => p.id === partId && p.features.some(isWall));
}
