// Trail lines of an exploded view (T4.5a), over the 3D view: for every step that has started, a
// dashed line from where it picks each instance up (the middle of its bounding box) to where it
// has taken it, so an exploded drawing reads as a sequence. An SVG that takes no pointer events,
// following the camera through `onViewChange`, like the connector and interference overlays.

import { useEffect, useState } from 'react';
import type { ViewportApi } from '../viewport/Viewport';
import type { WorldTrail } from './explode';

export interface ExplodeOverlayProps {
  viewport: ViewportApi;
  trails: readonly WorldTrail[];
}

export function ExplodeOverlay({ viewport, trails }: ExplodeOverlayProps) {
  const [, setVersion] = useState(0);
  useEffect(() => viewport.onViewChange(() => setVersion((v) => v + 1)), [viewport]);
  if (trails.length === 0) return null;
  return (
    <svg
      className="measure-svg explode-svg"
      aria-hidden="true"
      data-testid="explode-overlay"
      data-trails={trails.length}
    >
      {trails.map((t) => {
        const a = viewport.projectToCanvas(t.start);
        const b = viewport.projectToCanvas(t.end);
        return (
          <g
            key={`${t.stepId}/${t.instanceId}`}
            data-testid={`explode-trail-${t.stepId}-${t.instanceId}`}
            data-end={t.end.map((c) => Math.round(c * 1000) / 1000).join(',')}
          >
            <line className="explode-trail" x1={a.x} y1={a.y} x2={b.x} y2={b.y} />
            <circle className="explode-trail-end" cx={b.x} cy={b.y} r={2.5} />
          </g>
        );
      })}
    </svg>
  );
}
