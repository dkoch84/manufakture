// Everything the sketcher draws over the 3D view: the committed sketches in
// grey, and the sketch being edited with its overlay. Rendered inside the
// viewport element, on top of the canvas.

import type { SketchFeature } from '@manufakture/core';
import { useEffect, useMemo, useState } from 'react';
import { useStore } from 'zustand';
import type { ViewportApi } from '../viewport/Viewport';
import { sketchPlacement, type SketchPlacements } from './commit';
import { tessellate } from './geometry';
import { pathData, sketchView } from './projection';
import type { SketchSessionStore } from './session';
import { SketchCanvas } from './SketchMode';

export interface SketchLayerProps {
  viewport: ViewportApi;
  session: SketchSessionStore;
  sketches: readonly SketchFeature[];
  /** Where regen placed sketches on faces. */
  placements?: SketchPlacements;
  /** A sketch to highlight (hovered in the feature tree). */
  highlighted?: string | null;
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

export function SketchLayer({
  viewport,
  session,
  sketches,
  placements,
  highlighted = null,
}: SketchLayerProps) {
  const version = useViewVersion(viewport);
  const editing = useStore(session, (s) => (s.active ? (s.source?.featureId ?? null) : null));
  const size = canvasSize(viewport);
  return (
    <>
      <CommittedSketches
        viewport={viewport}
        sketches={sketches.filter((f) => f.id !== editing && !f.suppressed)}
        placements={placements}
        highlighted={highlighted}
        version={version}
      />
      {editing !== null && <SketchCanvas session={session} viewport={viewport} size={size} />}
    </>
  );
}

function CommittedSketches({
  viewport,
  sketches,
  placements,
  highlighted,
  version,
}: {
  viewport: ViewportApi;
  sketches: readonly SketchFeature[];
  placements: SketchPlacements | undefined;
  highlighted: string | null;
  version: number;
}) {
  const paths = useMemo(
    () =>
      sketches.flatMap((f) => {
        const placement = sketchPlacement(f, placements);
        if (!placement) return [];
        const view = sketchView(viewport, placement);
        return f.entities
          .filter((e) => e.kind !== 'point')
          .map((e) => ({
            key: `${f.id}/${e.id}`,
            feature: f.id,
            construction: e.construction,
            d: pathData(view, tessellate(e)),
          }))
          .filter((p) => p.d !== '');
      }),
    // `version` stands for the camera: re-project when it changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [viewport, sketches, placements, version],
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
          className={`sk-committed${p.construction ? ' construction' : ''}${p.feature === highlighted ? ' hovered' : ''}`}
          data-feature={p.feature}
          d={p.d}
        />
      ))}
    </svg>
  );
}
