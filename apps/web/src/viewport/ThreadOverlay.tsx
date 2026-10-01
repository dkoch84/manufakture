// Draws the cosmetic threads of the part shown (threadLines.ts) in the viewport, for the bodies
// that are shown (a hidden body's thread is not drawn). Renders nothing itself: the engine draws
// the lines in the 3D scene, depth-tested, so they sit on the face like its edges.

import { useEffect, useMemo } from 'react';
import { viewBodyId } from '../model/bodies';
import { useModel, type ModelStore } from '../model/model';
import type { BodyInput } from './bodies';
import { cosmeticThreadLines } from './threadLines';
import type { ViewportApi } from './Viewport';

export interface ThreadOverlayProps {
  viewport: ViewportApi;
  model: ModelStore;
  partId: string;
  /** The part's bodies the viewport shows. */
  bodies: readonly BodyInput[];
}

export function ThreadOverlay({ viewport, model, partId, bodies }: ThreadOverlayProps) {
  const part = useModel(model, (s) => s.parts.find((p) => p.partId === partId));
  const lines = useMemo(() => {
    if (part === undefined) return [];
    const shown = new Set(bodies.map((b) => b.id));
    return cosmeticThreadLines({
      features: part.features.filter(
        (f) => f.thread !== undefined && shown.has(viewBodyId(partId, f.thread.bodyId)),
      ),
    });
  }, [part, partId, bodies]);
  useEffect(() => viewport.setThreadLines(lines), [viewport, lines]);
  useEffect(() => () => viewport.setThreadLines([]), [viewport]);
  return null;
}
