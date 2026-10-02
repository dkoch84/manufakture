// The cut list's input from a document part and its regen result. Typed structurally (no import
// of `@manufakture/regen`, which this package takes as a type-only devDependency): regen's
// `PartResult`, `FeatureResult` and `BodyResult` fit these shapes as they are.

import type { BodyPropsFields, Part } from '@manufakture/core';
import type { CutListBody, CutListPart, OrientedSize } from './input';

/** The fields of regen's `PartResult` the cut list reads. */
export interface PartResultLike {
  features: readonly { featureId: string; metadata?: unknown }[];
  bodies: readonly { bodyId: string; creator: string; inherited?: BodyPropsFields }[];
}

export interface CutListPartOptions {
  /** The build's id in the cut list (default the part id): `part#1@cfg#2` for a configuration. */
  id?: string;
  /** Measured volumes by body id, mm³ (for bodies whose size is unknown). */
  volumes?: ReadonlyMap<string, number>;
  /** Oriented sizes of bodies that are not boards (T4.3b's `obb` op through T4.3d). */
  orientedSizes?: readonly OrientedSize[];
}

/**
 * A `CutListPart` from a document part and its regen result: body names and materials from the
 * part's body settings (else what a derived body inherits, else the creating feature's name),
 * feature names from the part, metadata from the result.
 */
export function cutListPart(
  part: Pick<Part, 'id' | 'name' | 'material' | 'features' | 'bodies'>,
  result: PartResultLike,
  options: CutListPartOptions = {},
): CutListPart {
  const names = new Map(part.features.map((f) => [f.id, f.name]));
  const props = new Map(part.bodies.map((b) => [b.id, b]));
  const bodies = result.bodies.map((b): CutListBody => {
    const own = props.get(b.bodyId);
    const body: CutListBody = { bodyId: b.bodyId, creator: b.creator };
    const name = own?.name ?? b.inherited?.name;
    if (name !== undefined) body.name = name;
    const material = own?.material ?? b.inherited?.material;
    if (material !== undefined) body.material = material;
    const volume = options.volumes?.get(b.bodyId);
    if (volume !== undefined) body.volume = volume;
    return body;
  });
  const out: CutListPart = {
    id: options.id ?? part.id,
    name: part.name,
    bodies,
    features: result.features.map((f) => {
      const name = names.get(f.featureId);
      return {
        featureId: f.featureId,
        ...(name === undefined ? {} : { name }),
        ...(f.metadata === undefined ? {} : { metadata: f.metadata }),
      };
    }),
  };
  if (part.material !== undefined) out.material = part.material;
  if (options.orientedSizes !== undefined) out.orientedSizes = options.orientedSizes;
  return out;
}
