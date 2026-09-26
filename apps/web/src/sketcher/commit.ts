// Between the document and a sketch session: what a session starts from
// (a new sketch on a plane, or an existing sketch feature), and the one
// document command that commits it when the user exits the sketch.

import {
  DEFAULT_PART_ID,
  findPart,
  parseFeatureId,
  peekCounter,
  previewIds,
  type Command,
  type FaceRef,
  type ManufaktureDocument,
  type SketchFeature,
} from '@manufakture/core';
import type { SketchInput, SketchPlacement } from '@manufakture/sketch/model';
import type { SketchSource } from './session';
import { evaluateVariables } from './values';

/**
 * A new sketch on a placement (a datum plane, or a face where the placement is the face's plane),
 * or an existing sketch. `face` is set for a face with a name from the naming layer: the sketch
 * then stores a reference to the face and follows it through later edits.
 */
export type SketchTarget =
  { kind: 'new'; placement: SketchPlacement; face?: FaceRef } | { kind: 'edit'; featureId: string };

/** Where regen last placed each sketch (face sketches have no stored placement). */
export type SketchPlacements = ReadonlyMap<string, SketchPlacement>;

export interface SketchStart {
  partId: string;
  source: SketchSource;
}

/** The sketch features of a part, in feature order. */
export function sketchFeatures(
  doc: ManufaktureDocument,
  partId = DEFAULT_PART_ID,
): SketchFeature[] {
  const part = findPart(doc, partId);
  return (part?.features ?? []).filter((f): f is SketchFeature => f.kind === 'sketch');
}

/**
 * The placement of a sketch feature: its stored plane, or for a sketch on a face reference where
 * regen last resolved it (null before regen has).
 */
export function sketchPlacement(
  feature: SketchFeature,
  placements?: SketchPlacements,
): SketchPlacement | null {
  const p = feature.plane;
  if (p.type === 'plane') return { origin: p.origin, normal: p.normal, xDir: p.xDir };
  return placements?.get(feature.id) ?? null;
}

/** What a session starts from, or an error message. */
export function startSketch(
  doc: ManufaktureDocument,
  target: SketchTarget,
  partId = DEFAULT_PART_ID,
  placements?: SketchPlacements,
): { ok: true; value: SketchStart } | { ok: false; message: string } {
  const part = findPart(doc, partId);
  if (!part) return { ok: false, message: `There is no part ${partId}.` };
  const base = {
    nextEntity: peekCounter(part.nextIds, 'e'),
    nextConstraint: peekCounter(part.nextIds, 'k'),
    units: doc.units,
    variables: evaluateVariables(doc),
  };
  if (target.kind === 'new') {
    const [featureId] = previewIds(part.nextIds, 'sketch');
    const n = parseFeatureId(featureId!)?.n ?? 1;
    return {
      ok: true,
      value: {
        partId,
        source: {
          ...base,
          featureId: featureId!,
          isNew: true,
          name: `Sketch ${n}`,
          placement: target.placement,
          ...(target.face ? { face: target.face } : {}),
          entities: [],
          constraints: [],
        },
      },
    };
  }
  const feature = part.features.find((f) => f.id === target.featureId);
  if (!feature || feature.kind !== 'sketch') {
    return { ok: false, message: `There is no sketch ${target.featureId}.` };
  }
  const placement = sketchPlacement(feature, placements);
  if (!placement) {
    return {
      ok: false,
      message: `${feature.name} is on a face that could not be found; fix the features before it first.`,
    };
  }
  return {
    ok: true,
    value: {
      partId,
      source: {
        ...base,
        featureId: feature.id,
        isNew: false,
        name: feature.name,
        placement,
        entities: feature.entities,
        constraints: feature.constraints,
      },
    },
  };
}

/**
 * The command that commits a finished session, with its undo label, or null
 * when an edited sketch did not change.
 */
export function commitSketch(
  doc: ManufaktureDocument,
  partId: string,
  source: SketchSource,
  sketch: SketchInput,
): { command: Command; label: string } | null {
  const entities = [...sketch.entities];
  const constraints = [...sketch.constraints];
  if (source.isNew) {
    const p = source.placement;
    const part = findPart(doc, partId);
    const [refId] = part ? previewIds(part.nextIds, 'r') : [];
    const feature: SketchFeature = {
      id: source.featureId,
      kind: 'sketch',
      name: source.name,
      suppressed: false,
      plane:
        source.face && refId
          ? { type: 'face', face: { id: refId, ref: source.face } }
          : { type: 'plane', origin: p.origin, normal: p.normal, xDir: p.xDir },
      entities,
      constraints,
    };
    return { command: { type: 'addFeature', partId, feature }, label: `Add ${source.name}` };
  }
  const part = findPart(doc, partId);
  const existing = part?.features.find((f) => f.id === source.featureId);
  if (!existing || existing.kind !== 'sketch') return null;
  if (sameData(existing.entities, entities) && sameData(existing.constraints, constraints)) {
    return null;
  }
  return {
    command: { type: 'editFeature', partId, feature: { ...existing, entities, constraints } },
    label: `Edit ${existing.name}`,
  };
}

/** Deep equality of plain JSON data, ignoring key order. */
export function sameData(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  const rb = b as Record<string, unknown>;
  const ra = a as Record<string, unknown>;
  return ka.every((k) => Object.hasOwn(rb, k) && sameData(ra[k], rb[k]));
}
