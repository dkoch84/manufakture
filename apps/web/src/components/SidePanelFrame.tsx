// A side panel of the editor that can be resized by dragging its inner edge and collapsed to a
// thin rail. Width and collapsed state live in the panel layout store (per device).

import { useRef, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { useStore } from 'zustand';
import {
  PANEL_MAX_WIDTH,
  PANEL_MIN_WIDTH,
  panelLayoutStore,
  type PanelLayoutStore,
  type PanelSide,
} from '../state/panelLayout';
import './sidePanelFrame.css';

/** Keyboard resize steps, CSS pixels (Shift: the larger step). */
const STEP = 16;
const BIG_STEP = 64;

export interface SidePanelFrameProps {
  side: PanelSide;
  /** What the panel holds, for the controls' labels ("Feature tree", "Properties"). */
  label: string;
  children: ReactNode;
  store?: PanelLayoutStore;
}

export function SidePanelFrame({
  side,
  label,
  children,
  store = panelLayoutStore,
}: SidePanelFrameProps) {
  const { width, collapsed } = useStore(store, (s) => s[side]);
  const drag = useRef<{ pointer: number; x: number; width: number } | null>(null);
  // Dragging the edge toward the viewport widens the panel.
  const sign = side === 'left' ? 1 : -1;

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { pointer: e.pointerId, x: e.clientX, width };
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.pointer !== e.pointerId) return;
    store.getState().setWidth(side, d.width + sign * (e.clientX - d.x));
  };
  const onPointerEnd = (e: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointer === e.pointerId) drag.current = null;
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? BIG_STEP : STEP;
    const s = store.getState();
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const wider = (e.key === 'ArrowRight') === (side === 'left');
      s.setWidth(side, width + (wider ? step : -step));
    } else if (e.key === 'Home') {
      e.preventDefault();
      s.setWidth(side, PANEL_MIN_WIDTH);
    } else if (e.key === 'End') {
      e.preventDefault();
      s.setWidth(side, PANEL_MAX_WIDTH);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      s.toggle(side);
    }
  };

  const toggleLabel = `${collapsed ? 'Show' : 'Hide'} the ${label.toLowerCase()} panel`;
  // The arrow points the way the panel will move: toward its edge to hide, back out to show.
  const toggleGlyph = (side === 'left') === collapsed ? '›' : '‹';

  const edge = (
    <div className="side-frame-edge">
      <button
        type="button"
        className="side-frame-toggle"
        aria-expanded={!collapsed}
        aria-label={toggleLabel}
        title={toggleLabel}
        data-testid={`panel-${side}-toggle`}
        onClick={() => store.getState().toggle(side)}
      >
        {toggleGlyph}
      </button>
      {!collapsed && (
        <div
          className="side-frame-handle"
          role="separator"
          aria-orientation="vertical"
          aria-label={`Resize the ${label.toLowerCase()} panel`}
          aria-valuemin={PANEL_MIN_WIDTH}
          aria-valuemax={PANEL_MAX_WIDTH}
          aria-valuenow={width}
          tabIndex={0}
          data-testid={`panel-${side}-handle`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerEnd}
          onPointerCancel={onPointerEnd}
          onKeyDown={onKeyDown}
        />
      )}
    </div>
  );

  return (
    <div
      className={`side-frame side-frame-${side}${collapsed ? ' collapsed' : ''}`}
      style={collapsed ? undefined : { width }}
      data-testid={`panel-${side}`}
    >
      {side === 'right' && edge}
      {!collapsed && <div className="side-frame-body">{children}</div>}
      {side === 'left' && edge}
    </div>
  );
}
