// Mate connectors over the 3D view (M2 plan, T2.3e): while the pointer is over a face, edge or
// vertex of an instance, a dot where a connector picked there would sit (a face's centroid, a
// circle's centre, an edge's midpoint, a vertex), labelled with the rule; and the connectors a
// Mate dialog holds, labelled 1 and 2. An SVG that takes no pointer events, following the camera
// through `onViewChange`, like the measure overlay. The points come from the mesh's topology;
// regen finds the exact frame when the mate is solved.

import type { ConnectorInference } from '@manufakture/core';
import { useEffect, useState } from 'react';
import { useStore } from 'zustand';
import { isGeometryRef, type SelectionStore } from '../state/selection';
import { transformPoint, type BodyInput } from '../viewport/bodies';
import type { ViewportApi } from '../viewport/Viewport';
import {
  INFERENCE_LABELS,
  connectorPoint,
  geometryOf,
  inferencesFor,
  instanceOf,
  subShapeOf,
  type ConnectorChoice,
} from './assembly';

export interface ConnectorOverlayProps {
  viewport: ViewportApi;
  selection: SelectionStore;
  assemblyId: string;
  bodies: readonly BodyInput[];
  /** The Mate dialog's connectors, first and second, when it is open. */
  chosen?: readonly (ConnectorChoice | null)[];
}

export function ConnectorOverlay({
  viewport,
  selection,
  assemblyId,
  bodies,
  chosen = [],
}: ConnectorOverlayProps) {
  const [, setVersion] = useState(0);
  useEffect(() => viewport.onViewChange(() => setVersion((v) => v + 1)), [viewport]);
  const hovered = useStore(selection, (s) => s.hovered);

  const at = (
    viewId: string,
    kind: 'face' | 'edge' | 'vertex',
    index: number,
    inference: ConnectorInference,
  ) => {
    const body = bodies.find((b) => b.id === viewId);
    const local = body ? connectorPoint(body, kind, index, inference) : null;
    if (!body || !local) return null;
    return viewport.projectToCanvas(transformPoint(body.transform, local));
  };

  let hover: { x: number; y: number; label: string } | null = null;
  if (hovered && isGeometryRef(hovered) && instanceOf(hovered.bodyId, assemblyId) !== null) {
    const body = bodies.find((b) => b.id === hovered.bodyId);
    const index = body ? subShapeOf(body, hovered) : null;
    if (body && index !== null) {
      const inference = inferencesFor(hovered.kind, geometryOf(body, hovered.kind, index))[0]!;
      const p = at(hovered.bodyId, hovered.kind, index, inference);
      if (p) hover = { ...p, label: INFERENCE_LABELS[inference] };
    }
  }
  const marks = chosen.flatMap((c, i) => {
    if (!c || c.index === 0) return [];
    const p = at(c.viewId, c.kind, c.index, c.inference);
    return p ? [{ ...p, label: String(i + 1) }] : [];
  });
  if (!hover && marks.length === 0) return null;
  return (
    <svg className="measure-svg connector-svg" aria-hidden="true" data-testid="connector-overlay">
      {marks.map((m) => (
        <g key={m.label} data-testid={`connector-mark-${m.label}`}>
          <circle className="connector-chosen" cx={m.x} cy={m.y} r={6} />
          <text className="connector-label" x={m.x + 9} y={m.y - 7}>
            {m.label}
          </text>
        </g>
      ))}
      {hover && (
        <g data-testid="connector-hover" data-x={hover.x} data-y={hover.y}>
          <circle className="connector-hover" cx={hover.x} cy={hover.y} r={5} />
          <text className="connector-label" x={hover.x + 9} y={hover.y - 7}>
            {hover.label}
          </text>
        </g>
      )}
    </svg>
  );
}
