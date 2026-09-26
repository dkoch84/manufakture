// From a face or edge picked in the viewport to the reference a feature stores (ADR 0007
// decision 8: picking returns a name). A face is stored by its name; an edge by the minimal
// `EdgeRef` the kernel works out for it (its faces, with end faces or an ordinal only when
// needed). Only faces and edges of the regenerated part can be referenced: a placeholder name,
// a reference body's faces or a vertex are refused with a reason.

import type { Referencer } from '../io/exchange';
import type { GeometryRef } from '../state/selection';
import type { BodyInput } from '../viewport/bodies';
import { refLabel, type RefItem, type RefKind } from './forms';

export type PickOutcome = { ok: true; item: RefItem } | { ok: false; message: string };

/** The 1-based face or edge index of a named sub-shape on a body, or null. */
export function subShapeIndex(body: BodyInput, kind: RefKind, name: string): number | null {
  const slot = body.names.indexOf(name);
  if (slot < 0) return null;
  const slots = kind === 'face' ? body.mesh.faceNames : body.mesh.edgeNames;
  const i = slots.indexOf(slot);
  return i < 0 ? null : i + 1;
}

export async function referenceFor(
  geo: GeometryRef,
  accepts: readonly RefKind[],
  context: {
    bodies: readonly BodyInput[];
    /** Ids of the regenerated part bodies. */
    partBodies: ReadonlySet<string>;
    referencer: Referencer | undefined;
  },
): Promise<PickOutcome> {
  const wanted = accepts.map((k) => `${k}s`).join(' or ');
  if (geo.kind === 'vertex' || !accepts.includes(geo.kind)) {
    return { ok: false, message: `This takes ${wanted}, not a ${geo.kind}.` };
  }
  if (geo.placeholder || !context.partBodies.has(geo.bodyId)) {
    return { ok: false, message: `Pick ${wanted} of the part.` };
  }
  if (geo.kind === 'face') {
    const ref = { face: geo.name };
    return { ok: true, item: { id: null, ref, label: refLabel(ref) } };
  }
  const body = context.bodies.find((b) => b.id === geo.bodyId);
  const index = body ? subShapeIndex(body, 'edge', geo.name) : null;
  if (index === null || !context.referencer) {
    return { ok: false, message: 'That edge cannot be referenced here.' };
  }
  const r = await context.referencer.reference(geo.bodyId, 'edge', index);
  if (!r.ok) return { ok: false, message: r.message };
  return { ok: true, item: { id: null, ref: r.value, label: refLabel(r.value) } };
}
