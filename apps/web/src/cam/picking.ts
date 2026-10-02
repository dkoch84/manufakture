// From a face picked in the viewport to the `FaceRef` a CAM geometry source or a WCS stores (ADR
// 0014 decision 5): only a planar face of the setup's part, named by the kernel's `pick` op (the
// referencer) where there is one. A curved face, an edge, a vertex, a placeholder name or a face of
// another part (or, when the setup names one, another body) is refused with a reason the dialog
// shows.

import type { FaceRef } from '@manufakture/core';
import type { Referencer } from '../io/exchange';
import { subShapeIndex } from '../features/references';
import { viewBodyId } from '../model/bodies';
import { facePlacement } from '../sketcher/planes';
import type { GeometryRef } from '../state/selection';
import type { BodyInput } from '../viewport/bodies';

export type FacePick = { ok: true; ref: FaceRef } | { ok: false; message: string };

export interface CamPickContext {
  /** The bodies shown, for the face's surface type. */
  bodies: readonly BodyInput[];
  /** Viewport ids of the regenerated part bodies. */
  partBodies: ReadonlySet<string>;
  referencer: Referencer | undefined;
}

/** Resolves a viewport face for a CAM field; the App binds the context. */
export type CamFaceResolver = (geo: GeometryRef, partId: string) => Promise<FacePick>;

/** What a setup machines: its part and, on a part with several bodies, the body. */
export interface CamPickScope {
  part: string;
  body?: string;
}

/** Why a face is not on the scope's part or body; null: it is. */
export function outsideScope(geo: GeometryRef, scope: string | CamPickScope): string | null {
  const { part, body } = typeof scope === 'string' ? { part: scope, body: undefined } : scope;
  if (!geo.bodyId.startsWith(`${part}/`)) return "Pick a face of the setup's part.";
  if (body !== undefined && geo.bodyId !== viewBodyId(part, body)) {
    return "Pick a face of the setup's body.";
  }
  return null;
}

export async function camFaceReference(
  geo: GeometryRef,
  scope: string | CamPickScope,
  context: CamPickContext,
): Promise<FacePick> {
  if (geo.kind !== 'face') return { ok: false, message: `Pick a planar face, not a ${geo.kind}.` };
  if (geo.placeholder || !context.partBodies.has(geo.bodyId)) {
    return { ok: false, message: 'Pick a face of the part.' };
  }
  const outside = outsideScope(geo, scope);
  if (outside) return { ok: false, message: outside };
  if (!facePlacement(context.bodies, geo)) {
    return { ok: false, message: 'Pick a planar face: CAM takes flat faces only.' };
  }
  const body = context.bodies.find((b) => b.id === geo.bodyId);
  const index = body ? subShapeIndex(body, 'face', geo.name) : null;
  if (index === null || !context.referencer) return { ok: true, ref: { face: geo.name } };
  const r = await context.referencer.reference(geo.bodyId, 'face', index);
  if (!r.ok) return { ok: false, message: r.message };
  if (!('face' in r.value)) return { ok: false, message: 'That face has no stable name.' };
  return { ok: true, ref: r.value };
}

/**
 * Resolves a face for a setup through the App's resolver (which knows the part only), then refuses
 * one on another body of the part when the setup names its body.
 */
export async function setupFaceReference(
  resolve: CamFaceResolver,
  geo: GeometryRef,
  scope: CamPickScope,
): Promise<FacePick> {
  const r = await resolve(geo, scope.part);
  if (!r.ok) return r;
  const outside = outsideScope(geo, scope);
  return outside ? { ok: false, message: outside } : r;
}
