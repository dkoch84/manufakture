// Everything the sketcher draws over the 3D view: the committed sketches in
// grey, and the sketch being edited with its overlay. Rendered inside the
// viewport element, on top of the canvas.

import type { SketchFeature } from '@manufakture/core';
import { useEffect, useMemo, useState } from 'react';
import { useStore } from 'zustand';
import type { ViewportApi } from '../viewport/Viewport';
import { sketchPlacement } from './commit';
import { tessellate } from './geometry';
import { pathData, sketchView } from './projection';
import type { SketchSessionStore } from './session';
import { SketchCanvas } from './SketchMode';

export interface SketchLayerProps {
  viewport: ViewportApi;
  session: SketchSessionStore;
  sketches: readonly SketchFeature[];
}

/** Re-renders the caller whenever the viewport's camera or size changes. */
function useViewVersion(viewport: ViewportApi): number {
  const [version, setVersion] = useState(0);
  useEffect(() => viewport.onViewChange(() => setVersion((v) => v + 1)), [viewport]);
  return version;
}

function canvasSize(viewport: ViewportApi): { width: number; height: number } {
  const size = (viewport.info() as { size?: { width: number; height: number } } | undefined)?.size;
  return size ?? { width: 1, height: 1 };
}

export function SketchLayer({ viewport, session, sketches }: SketchLayerProps) {
  const version = useViewVersion(viewport);
  const editing = useStore(session, (s) => (s.active ? (s.source?.featureId ?? null) : null));
  const size = canvasSize(viewport);
  return (
    <>
      <CommittedSketches
        viewport={viewport}
        sketches={sketches.filter((f) => f.id !== editing && !f.suppressed)}
        version={version}
      />
      {editing !== null && <SketchCanvas session={session} viewport={viewport} size={size} />}
    </>
  );
}

function CommittedSketches({
  viewport,
  sketches,
  version,
}: {
  viewport: ViewportApi;
  sketches: readonly SketchFeature[];
  version: number;
}) {
  const paths = useMemo(
    () =>
      sketches.flatMap((f) => {
        const placement = sketchPlacement(f);
        if (!placement) return [];
        const view = sketchView(viewport, placement);
        return f.entities
          .filter((e) => e.kind !== 'point')
          .map((e) => ({
            key: `${f.id}/${e.id}`,
            feature: f.id,
            construction: e.construction,
            d: pathData(view, tessellate(e)),
          }));
      }),
    // `version` stands for the camera: re-project when it changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [viewport, sketches, version],
  );
  if (paths.length === 0) return null;
  return (
    <svg
      className="sketch-svg committed"
      data-testid="committed-sketches"
      width="100%"
      height="100%"
    >
      {paths.map((p) => (
        <path
          key={p.key}
          className={`sk-committed${p.construction ? ' construction' : ''}`}
          data-feature={p.feature}
          d={p.d}
        />
      ))}
    </svg>
  );
}
