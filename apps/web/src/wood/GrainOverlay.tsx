// Draws the grain arrows of the shown part's boards (grain.ts) in the viewport, for the bodies
// that are shown, while grain arrows are on. Renders nothing itself: the engine draws the lines
// in the 3D scene, depth-tested, so each sits on its board's broad faces.

import { useEffect, useMemo } from 'react';
import { useStore } from 'zustand';
import { viewBodyId } from '../model/bodies';
import { useModel, type ModelStore } from '../model/model';
import type { BodyInput } from '../viewport/bodies';
import type { ViewportApi } from '../viewport/Viewport';
import { boardGrainLines, grainStore } from './grain';

export interface GrainOverlayProps {
  viewport: ViewportApi;
  model: ModelStore;
  partId: string;
  /** The part's bodies the viewport shows. */
  bodies: readonly BodyInput[];
}

export function GrainOverlay({ viewport, model, partId, bodies }: GrainOverlayProps) {
  const part = useModel(model, (s) => s.parts.find((p) => p.partId === partId));
  const show = useStore(grainStore, (s) => s.show);
  const lines = useMemo(() => {
    if (!show || part === undefined) return [];
    const shown = new Set(bodies.map((b) => b.id));
    const ids = new Set(
      part.bodies.filter((b) => shown.has(viewBodyId(partId, b.bodyId))).map((b) => b.bodyId),
    );
    return boardGrainLines(part, ids);
  }, [show, part, partId, bodies]);
  useEffect(() => viewport.setGrainLines(lines), [viewport, lines]);
  useEffect(() => () => viewport.setGrainLines([]), [viewport]);
  return null;
}
