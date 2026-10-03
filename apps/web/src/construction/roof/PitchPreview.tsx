// The Roof tool's pitch preview in the viewport: the roof's eave rectangle at the wall line, its
// ridge and its gable ends or hips, drawn as preview lines at the plates' top, with the pitch
// (`6/12, 26.57°`) shown at the middle of the ridge. The label is a fixed-position element that
// takes no pointer events and follows the camera through the viewport's `onViewChange`.

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ViewportApi } from '../../viewport/Viewport';
import { pitchSummary } from './pitch';
import type { V3 } from './roofs';

export function PitchPreview({
  viewport,
  lines,
  apex,
  pitch,
}: {
  viewport: ViewportApi | null;
  lines: readonly (readonly V3[])[] | null;
  apex: V3 | null;
  pitch: number | null;
}) {
  const [, setVersion] = useState(0);
  useEffect(
    () => (viewport ? viewport.onViewChange(() => setVersion((v) => v + 1)) : undefined),
    [viewport],
  );
  const key = JSON.stringify(lines);
  useEffect(() => {
    if (!viewport) return;
    viewport.setPreviewLines(lines ?? []);
    viewport.requestRender();
  }, [viewport, key]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => viewport?.setPreviewLines([]), [viewport]);
  if (!viewport || !apex || pitch === null || !lines) return null;
  const at = viewport.projectToClient(apex);
  return createPortal(
    <div
      className="roof-pitch-label"
      data-testid="roof-pitch-label"
      aria-hidden="true"
      style={{ left: at.x, top: at.y }}
    >
      {pitchSummary(pitch)}
    </div>,
    document.body,
  );
}
