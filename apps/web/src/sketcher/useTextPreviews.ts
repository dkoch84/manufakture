// Keeps the layout of every text of the sketch being edited current: when a text's string, font,
// size, spacing or alignment changes (or a variable its size uses), the sketcher asks the regen
// worker's text outliner for a new layout and stores the reply in the session (`texts`). Moving
// the anchor or turning the text needs no new layout: the sketcher places the last one.
//
// Requests wait `TEXT_PREVIEW_DEBOUNCE_MS` after the last change, so typing a word sends one
// request, not one per key; a text with no layout yet (just placed, or the sketch just opened) is
// asked for at once. A reply for a key that is no longer current is dropped. Requests are never
// cancelled: cancelling would terminate the text worker (the watchdog's only way to stop one),
// and the next request would load the font again.
//
// Each run is a pass (`Texter.outline`'s `pass`): the texts it asks for share one time budget in
// the worker, so a hostile font whose every layout takes just under the time limit costs a pass
// about two time limits, not one per text of the sketch.

import { useEffect } from 'react';
import type { SketchSessionStore } from './session';
import { TEXT_PREVIEW_DEBOUNCE_MS, previewOf, textRequestOf, type Texter } from './text';

/** Numbers the passes of every session of the page, for the worker's per-pass budgets. */
let passes = 0;

export function startTextPreviews(
  session: SketchSessionStore,
  texter: Texter,
  debounceMs: number = TEXT_PREVIEW_DEBOUNCE_MS,
): () => void {
  /** The key last requested per entity, until its reply arrives. */
  const requested = new Map<string, string>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const run = () => {
    timer = null;
    const s = session.getState();
    if (!s.active || !s.source) return;
    const pass = ++passes;
    for (const e of s.sketch.entities) {
      if (e.kind !== 'outline') continue;
      const outcome = textRequestOf(e, s.fonts, s.source.variables);
      const shown = s.texts[e.id];
      if (shown?.key === outcome.key) {
        // Back to what is shown (an edit undone before its layout came): a reply still on its
        // way is for a key no longer current, and must not replace this one.
        requested.delete(e.id);
        continue;
      }
      if (requested.get(e.id) === outcome.key) continue;
      if (!outcome.ok) {
        requested.delete(e.id);
        s.setTextPreview(e.id, {
          key: outcome.key,
          layout: null,
          error: outcome.message,
          warnings: [],
        });
        continue;
      }
      requested.set(e.id, outcome.key);
      const id = e.id;
      const { key } = outcome;
      texter.outline(outcome.request, { pass }).then(
        (reply) => {
          if (stopped || requested.get(id) !== key) return;
          requested.delete(id);
          session.getState().setTextPreview(id, previewOf(key, reply));
        },
        (error: unknown) => {
          if (stopped || requested.get(id) !== key) return;
          requested.delete(id);
          session.getState().setTextPreview(id, {
            key,
            layout: null,
            error: error instanceof Error ? error.message : String(error),
            warnings: [],
          });
        },
      );
    }
  };

  const schedule = () => {
    const s = session.getState();
    // A text with nothing to show yet is laid out at once.
    const fresh = s.sketch.entities.some((e) => e.kind === 'outline' && !s.texts[e.id]);
    if (timer !== null) clearTimeout(timer);
    if (fresh) run();
    else timer = setTimeout(run, debounceMs);
  };

  run();
  const unsubscribe = session.subscribe((next, prev) => {
    if (
      next.sketch.entities !== prev.sketch.entities ||
      next.fonts !== prev.fonts ||
      next.source?.variables !== prev.source?.variables ||
      next.active !== prev.active
    ) {
      schedule();
    }
  });
  return () => {
    stopped = true;
    unsubscribe();
    if (timer !== null) clearTimeout(timer);
  };
}

/** `startTextPreviews` for the life of the component; nothing without a texter. */
export function useTextPreviews(session: SketchSessionStore, texter: Texter | null | undefined) {
  useEffect(() => {
    if (!texter) return;
    return startTextPreviews(session, texter);
  }, [session, texter]);
}
