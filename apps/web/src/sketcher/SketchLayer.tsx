// Everything the sketcher draws over the 3D view: the committed sketches in
// grey, and the sketch being edited with its overlay. Rendered inside the
// viewport element, on top of the canvas.

import type { SketchFeature } from '@manufakture/core';
import type { OutlineShape } from '@manufakture/sketch/geometry';
import { useEffect, useMemo, useState } from 'react';
import { useStore } from 'zustand';
import type { ViewportApi } from '../viewport/Viewport';
import { sketchPlacement, type SketchPlacements } from './commit';
import { tessellate } from './geometry';
import { pathData, sketchView } from './projection';
import type { SketchSessionStore } from './session';
import { SketchCanvas } from './SketchMode';
import { glyphOutlines, pointBudget, type Texter } from './text';

export interface SketchLayerProps {
  viewport: ViewportApi;
  session: SketchSessionStore;
  sketches: readonly SketchFeature[];
  /** Where regen placed sketches on faces. */
  placements?: SketchPlacements;
  /** A sketch to highlight (hovered in the feature tree). */
  highlighted?: string | null;
  /** The texts of each sketch as regen last placed them (`FeatureResult.outlines`), by feature id. */
  outlines?: ReadonlyMap<string, readonly OutlineShape[]>;
  /** Lays texts out while a sketch is edited. */
  texter?: Texter | null;
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
  outlines,
  texter = null,
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
        outlines={outlines}
      />
      {editing !== null && (
        <SketchCanvas session={session} viewport={viewport} size={size} texter={texter} />
      )}
    </>
  );
}

function CommittedSketches({
  viewport,
  sketches,
  placements,
  highlighted,
  version,
  outlines,
}: {
  viewport: ViewportApi;
  sketches: readonly SketchFeature[];
  placements: SketchPlacements | undefined;
  highlighted: string | null;
  version: number;
  outlines: ReadonlyMap<string, readonly OutlineShape[]> | undefined;
}) {
  const paths = useMemo(() => {
    // One point budget for the texts of every committed sketch, however many there are.
    const budget = pointBudget();
    return sketches.flatMap((f) => {
      const placement = sketchPlacement(f, placements);
      if (!placement) return [];
      const view = sketchView(viewport, placement);
      const curves = f.entities
        .filter((e) => e.kind !== 'point' && e.kind !== 'outline')
        .map((e) => ({
          key: `${f.id}/${e.id}`,
          feature: f.id,
          construction: e.construction,
          text: false,
          d: pathData(view, tessellate(e)),
        }));
      // Texts as regen built them, one path per glyph.
      const shapes = outlines?.get(f.id) ?? [];
      const construction = new Set(
        f.entities.filter((e) => e.kind === 'outline' && e.construction).map((e) => e.id),
      );
      const upp = view.unitsPerPixel(0, 0);
      const tolerance = Number.isFinite(upp) && upp > 0 ? upp * 0.5 : 0.05;
      const glyphs = glyphOutlines(shapes, tolerance, budget).map((g) => ({
        key: `${f.id}/${g.key}`,
        feature: f.id,
        construction: construction.has(g.key.split('.')[0]!),
        text: true,
        d: g.loops.map((l) => pathData(view, l, true)).join(' '),
      }));
      return [...curves, ...glyphs].filter((p) => p.d !== '');
    });
    // `version` stands for the camera: re-project when it changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewport, sketches, placements, version, outlines]);
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
          className={`sk-committed${p.text ? ' text' : ''}${p.construction ? ' construction' : ''}${p.feature === highlighted ? ' hovered' : ''}`}
          data-feature={p.feature}
          {...(p.text ? { fillRule: 'evenodd' as const, 'data-text': 'true' } : {})}
          d={p.d}
        />
      ))}
    </svg>
  );
}
