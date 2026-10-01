// The overlap of the pair the Interference panel highlights (M2 plan, T2.3d), outlined over the
// 3D view: the edges of the overlap's mesh, projected and drawn on top of everything, since the
// overlap lies inside both instances. An SVG that takes no pointer events, following the camera
// through `onViewChange`, like the connector and measure overlays.

import type { MeshData } from '@manufakture/kernel';
import { useEffect, useMemo, useState } from 'react';
import type { ViewportApi } from '../viewport/Viewport';
import { overlapSegments } from './interference';

export interface InterferenceOverlayProps {
  viewport: ViewportApi;
  /** The overlap's mesh, in world coordinates; nothing is drawn without one. */
  mesh: MeshData | null;
}

export function InterferenceOverlay({ viewport, mesh }: InterferenceOverlayProps) {
  const [, setVersion] = useState(0);
  useEffect(() => viewport.onViewChange(() => setVersion((v) => v + 1)), [viewport]);
  const lines = useMemo(() => (mesh ? overlapSegments(mesh) : []), [mesh]);
  if (lines.length === 0) return null;
  return (
    <svg
      className="measure-svg interference-svg"
      aria-hidden="true"
      data-testid="interference-overlay"
      data-edges={lines.length}
    >
      {lines.map((line, i) => (
        <polyline
          key={i}
          className="interference-edge"
          points={line
            .map((p) => {
              const c = viewport.projectToCanvas(p);
              return `${c.x},${c.y}`;
            })
            .join(' ')}
        />
      ))}
    </svg>
  );
}
