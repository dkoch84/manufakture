// Which regions of a sketch with text a profile picks (T3.2d): every region, the text only, or
// everything but the text. The entity lists regen's `selectRegions` reads; see ProfileRegions.tsx.

import type { SketchFeature } from '@manufakture/core';

export type RegionChoice = 'all' | 'text' | 'others' | 'custom';

/** The ids of a sketch's texts that bound regions (construction texts bound none). */
export function textEntities(sketch: SketchFeature | undefined): string[] {
  return (sketch?.entities ?? [])
    .filter((e) => e.kind === 'outline' && !e.construction)
    .map((e) => e.id);
}

/** The ids of a sketch's other curves that bound regions: lines, arcs and circles. */
export function otherEntities(sketch: SketchFeature | undefined): string[] {
  return (sketch?.entities ?? [])
    .filter((e) => e.kind !== 'outline' && e.kind !== 'point' && !e.construction)
    .map((e) => e.id);
}

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((id) => b.includes(id));

/** What a profile's entity list picks, in the terms of the choice. */
export function regionChoice(
  sketch: SketchFeature | undefined,
  entities: readonly string[] | undefined,
): RegionChoice {
  if (entities === undefined || entities.length === 0) return 'all';
  const texts = textEntities(sketch);
  if (texts.length > 0 && sameSet(entities, texts)) return 'text';
  const others = otherEntities(sketch);
  if (others.length > 0 && sameSet(entities, others)) return 'others';
  return 'custom';
}

/** The entity list for a choice (undefined: every region). */
export function entitiesFor(
  sketch: SketchFeature | undefined,
  choice: Exclude<RegionChoice, 'custom'>,
): string[] | undefined {
  if (choice === 'text') return textEntities(sketch);
  if (choice === 'others') return otherEntities(sketch);
  return undefined;
}
