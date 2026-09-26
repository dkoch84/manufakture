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
  type ManufaktureDocument,
  type SketchFeature,
} from '@manufakture/core';
import type { SketchInput, SketchPlacement } from '@manufakture/sketch/model';
import type { SketchSource } from './session';
import { evaluateVariables } from './values';

export type SketchTarget =
  { kind: 'new'; placement: SketchPlacement } | { kind: 'edit'; featureId: string };

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

/** The placement of a sketch feature, or null when it lies on a face reference. */
export function sketchPlacement(feature: SketchFeature): SketchPlacement | null {
  const p = feature.plane;
  return p.type === 'plane' ? { origin: p.origin, normal: p.normal, xDir: p.xDir } : null;
}

/** What a session starts from, or an error message. */
export function startSketch(
  doc: ManufaktureDocument,
  target: SketchTarget,
  partId = DEFAULT_PART_ID,
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
  const placement = sketchPlacement(feature);
  if (!placement) {
    return {
      ok: false,
      message: 'Sketches on a face reference cannot be edited until regen resolves faces.',
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
    const feature: SketchFeature = {
      id: source.featureId,
      kind: 'sketch',
      name: source.name,
      suppressed: false,
      plane: { type: 'plane', origin: p.origin, normal: p.normal, xDir: p.xDir },
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
