// Keyboard shortcuts of sketch mode, on the window while a sketch is open.
// Tool keys (L, R, C, A, G, D, S), Q for construction, the constraint keys
// (H, V, I, E, T) with a selection, Delete, and Esc. Typing in a field and
// chords with Ctrl, Cmd or Alt are left alone (undo and redo are the app's).

import { useEffect } from 'react';
import { isTextField } from '../state/document';
import { CONSTRAINT_TOOLS } from './constraints';
import type { SketchSessionStore } from './session';
import { TOOL_KEYS } from './tools';

/** Sketch shortcuts on the window while sketch mode is on. */
export function useSketchShortcuts(session: SketchSessionStore, active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || isTextField(e.target)) return;
      const s = session.getState();
      if (e.key === 'Escape') {
        s.escape();
        return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        s.deleteSelection();
        return;
      }
      const key = e.key.toLowerCase();
      if (key === 'q') {
        s.toggleConstruction();
        return;
      }
      if (s.selection.length > 0 && s.tool === 'select') {
        const tool = CONSTRAINT_TOOLS.find((t) => t.key === key);
        if (tool) {
          s.applyConstraint(tool.kind);
          return;
        }
      }
      const tool = TOOL_KEYS[key];
      if (tool) s.setTool(tool);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [session, active]);
}
