// Draws the witness points of a measured distance over the 3D view: a dot on
// each target where the minimum is reached and the line between them, with
// the distance beside it. An SVG over the canvas that takes no pointer
// events, so picking is unaffected; it follows the camera through the
// viewport's `onViewChange` and `projectToCanvas`.

import type { DisplayUnits } from '@manufakture/core';
import { useEffect, useState } from 'react';
import { useStore } from 'zustand';
import type { MeasureStore } from '../state/measure';
import type { ViewportApi } from '../viewport/Viewport';
import { formatLengthIn } from './format';

export interface MeasureOverlayProps {
  viewport: ViewportApi;
  measure: MeasureStore;
  units: DisplayUnits;
}

export function MeasureOverlay({ viewport, measure, units }: MeasureOverlayProps) {
  const [, setVersion] = useState(0);
  useEffect(() => viewport.onViewChange(() => setVersion((v) => v + 1)), [viewport]);
  const distance = useStore(measure, (s) =>
    s.status === 'ready' ? (s.result?.distance ?? null) : null,
  );
  useEffect(() => viewport.requestRender(), [viewport, distance]);
  if (distance === null) return null;
  const a = viewport.projectToCanvas(distance.from);
  const b = viewport.projectToCanvas(distance.to);
  const label = formatLengthIn(distance.value, units);
  return (
    <svg className="measure-svg" data-testid="measure-witness" aria-hidden="true">
      <line className="measure-line" x1={a.x} y1={a.y} x2={b.x} y2={b.y} />
      <circle className="measure-point" cx={a.x} cy={a.y} r={4} data-testid="measure-from" />
      <circle className="measure-point" cx={b.x} cy={b.y} r={4} data-testid="measure-to" />
      <text className="measure-label" x={(a.x + b.x) / 2 + 8} y={(a.y + b.y) / 2 - 8}>
        {label}
      </text>
    </svg>
  );
}
