// Entering and leaving sketch mode: start a session on a plane or on an
// existing sketch feature, turn the camera normal to the sketch plane, and on
// finish commit the sketch to the document as one undoable command.

import { useCallback, useRef, useState } from 'react';
import { useStore } from 'zustand';
import type { DocumentStoreApi } from '../state/document';
import type { ViewportApi } from '../viewport/Viewport';
import { commitSketch, startSketch, type SketchPlacements, type SketchTarget } from './commit';
import { sketchUp } from './planes';
import type { SketchSessionStore } from './session';

export interface Sketching {
  active: boolean;
  /** Why entering or finishing failed, for the UI to show. */
  error: string | null;
  enter(target: SketchTarget): boolean;
  /** Commit and leave; false (staying in the sketch) when the document refuses it. */
  finish(): Promise<boolean>;
  cancel(): void;
  dismissError(): void;
}

export function useSketching(
  session: SketchSessionStore,
  documents: DocumentStoreApi,
  viewport: ViewportApi | null,
  placements?: SketchPlacements,
): Sketching {
  const active = useStore(session, (s) => s.active);
  const [error, setError] = useState<string | null>(null);
  const partId = useRef<string | null>(null);

  const enter = useCallback(
    (target: SketchTarget) => {
      if (session.getState().active) return false;
      const r = startSketch(documents.getState().document, target, undefined, placements);
      if (!r.ok) {
        setError(r.message);
        return false;
      }
      setError(null);
      partId.current = r.value.partId;
      const p = r.value.source.placement;
      session.getState().begin(r.value.source);
      // Look straight at the sketch, with its x axis to the right.
      viewport?.alignView(p.normal, sketchUp(p), p.origin);
      return true;
    },
    [session, documents, viewport, placements],
  );

  const finish = useCallback(async () => {
    const s = session.getState();
    if (!s.active || !s.source || !partId.current) return false;
    await s.idle();
    const { source, sketch } = session.getState();
    if (!source) return false;
    const commit = commitSketch(documents.getState().document, partId.current, source, sketch);
    if (commit) {
      const r = documents.getState().execute(commit.command, commit.label);
      if (!r.ok) {
        setError(`The sketch could not be saved: ${r.error.message}`);
        return false;
      }
    }
    session.getState().finish();
    setError(null);
    return true;
  }, [session, documents]);

  const cancel = useCallback(() => {
    session.getState().cancel();
    setError(null);
  }, [session]);

  return { active, error, enter, finish, cancel, dismissError: () => setError(null) };
}
