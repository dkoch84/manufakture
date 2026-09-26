// Sketch mode: wires a sketch session to the viewport while the user edits a
// sketch. It takes the viewport's left button (drawing, selecting, dragging;
// the other buttons still navigate), handles the sketch shortcuts, and shows
// the overlay, the sketch toolbar, the status bar and the conflict panel.

import { useEffect, useMemo, useState } from 'react';
import { useStore } from 'zustand';
import type { CanvasPoint } from '../viewport/engine';
import type { ViewportApi } from '../viewport/Viewport';
import { CONSTRAINT_NAMES, CONSTRAINT_TOOLS, constraintsFromSelection } from './constraints';
import { isDimension } from './dimension';
import { indexEntities } from './geometry';
import { sketchView } from './projection';
import type { PointerInput, SketchSessionStore } from './session';
import { SketchOverlay } from './SketchOverlay';
import { selectModeOf } from './items';
import { conflictBlame, describeStatus } from './status';
import { toolPrompt, type ToolId } from './tools';
import { formatValue, valueKindOf, evaluateStored } from './values';

/** Pixels within which the pointer snaps to and picks sketch geometry. */
export const SNAP_PX = 10;
/** Pixels the pointer must move with the button down before a press becomes a drag. */
const DRAG_SLOP_PX = 4;

const TOOLS: readonly { id: ToolId; label: string; key: string; title: string }[] = [
  { id: 'select', label: 'Select', key: 's', title: 'Select and drag geometry (S)' },
  {
    id: 'line',
    label: 'Line',
    key: 'l',
    title: 'Line: click points, double-click or Esc to end (L)',
  },
  { id: 'rectangle', label: 'Rectangle', key: 'r', title: 'Corner rectangle (R)' },
  { id: 'centerRectangle', label: 'Center rectangle', key: '', title: 'Rectangle from its centre' },
  { id: 'circle', label: 'Circle', key: 'c', title: 'Circle from its centre (C)' },
  { id: 'arc3', label: '3-point arc', key: 'a', title: 'Arc through three points (A)' },
  {
    id: 'tangentArc',
    label: 'Tangent arc',
    key: 'g',
    title: 'Arc tangent to the end of a line or arc (G)',
  },
  { id: 'centerArc', label: 'Center arc', key: '', title: 'Arc from its centre' },
  {
    id: 'dimension',
    label: 'Dimension',
    key: 'd',
    title: 'Click one or two items, then place the dimension (D)',
  },
];

export interface SketchModeProps {
  session: SketchSessionStore;
  viewport: ViewportApi;
  /** Where the overlay goes: the viewport's own element, over the canvas. */
  size: { width: number; height: number };
}

/** The sketch drawing, attached to the viewport. Rendered inside the viewport element. */
export function SketchCanvas({ session, viewport, size }: SketchModeProps) {
  const placement = useStore(session, (s) => s.source?.placement ?? null);
  const [version, setVersion] = useState(0);

  useEffect(() => viewport.onViewChange(() => setVersion((v) => v + 1)), [viewport]);

  const view = useMemo(
    () => (placement ? sketchView(viewport, placement) : null),
    // `version` changes with the camera: the projection must be rebuilt then.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [viewport, placement, version],
  );

  // Left-button input goes to the session.
  useEffect(() => {
    if (!placement) return;
    const v = sketchView(viewport, placement);
    const input = (p: CanvasPoint, e: { shiftKey: boolean }): PointerInput | null => {
      const at = v.fromCanvas(p.x, p.y);
      if (!at) return null;
      return { at, tolerance: v.unitsPerPixel(p.x, p.y) * SNAP_PX, suppress: e.shiftKey };
    };
    let press: { p: CanvasPoint; mode: 'none' | 'drag' | 'draw' } | null = null;
    viewport.setPointerDelegate({
      down(_e, p) {
        press = { p, mode: 'none' };
        return true;
      },
      move(e, p) {
        const i = input(p, e);
        if (!i) return;
        const s = session.getState();
        if (press && (e.buttons & 1) !== 0) {
          if (
            press.mode === 'none' &&
            Math.hypot(p.x - press.p.x, p.y - press.p.y) > DRAG_SLOP_PX
          ) {
            const start = input(press.p, e);
            if (s.tool === 'select' && start && s.dragStart(start)) press.mode = 'drag';
            else if (s.draw && start) {
              // Press, drag, release draws from the press to the release, as a click at each.
              s.click({ ...start, mode: 'replace' });
              press.mode = 'draw';
            }
          }
          if (press.mode === 'drag') {
            s.dragMove(i);
            return;
          }
        }
        s.pointerMove(i);
      },
      up(e, p) {
        const pr = press;
        press = null;
        const s = session.getState();
        if (pr?.mode === 'drag') {
          void s.dragEnd();
          return;
        }
        const i = input(p, e);
        if (!i) return;
        s.click({ ...i, mode: selectModeOf(e) });
      },
      dblclick() {
        session.getState().doubleClick();
      },
      leave() {
        session.getState().pointerLeave();
      },
    });
    return () => viewport.setPointerDelegate(null);
  }, [viewport, placement, session]);

  if (!view) return null;
  return <SketchOverlay session={session} view={view} size={size} />;
}

export interface SketchToolbarProps {
  session: SketchSessionStore;
  onFinish: () => void;
  onCancel: () => void;
}

/** Tools, constraints, construction, undo and redo, and leaving the sketch. */
export function SketchToolbar({ session, onFinish, onCancel }: SketchToolbarProps) {
  const s = useStore(session);
  const index = useMemo(() => indexEntities(s.sketch.entities), [s.sketch.entities]);
  return (
    <div className="sketch-toolbar" role="toolbar" aria-label="Sketch">
      <span className="sketch-name" data-testid="sketch-name">
        {s.source?.name}
      </span>
      <div className="toolbar-group">
        <button
          type="button"
          className="primary"
          onClick={onFinish}
          title="Save the sketch and leave it"
        >
          Finish sketch
        </button>
        <button
          type="button"
          onClick={onCancel}
          title="Leave the sketch without saving the changes"
        >
          Cancel
        </button>
      </div>
      <div className="toolbar-group" role="group" aria-label="Sketch tools">
        {TOOLS.map((t) => (
          <button
            key={t.id}
            type="button"
            aria-pressed={s.tool === t.id}
            title={t.title}
            onClick={() => session.getState().setTool(t.id)}
          >
            {t.label}
          </button>
        ))}
        <button
          type="button"
          aria-pressed={s.construction}
          title="Construction geometry: new geometry, or the selected geometry (Q)"
          onClick={() => session.getState().toggleConstruction()}
        >
          Construction
        </button>
      </div>
      <div className="toolbar-group" role="group" aria-label="Constraints">
        {CONSTRAINT_TOOLS.map((t) => {
          const fits = constraintsFromSelection(t.kind, s.selection, index).length > 0;
          return (
            <button
              key={t.kind}
              type="button"
              disabled={!fits}
              title={`${t.label}: ${t.help}${t.key ? ` (${t.key.toUpperCase()})` : ''}`}
              onClick={() => session.getState().applyConstraint(t.kind)}
            >
              <span aria-hidden="true" className="glyph">
                {t.symbol}
              </span>{' '}
              {t.label}
            </button>
          );
        })}
      </div>
      <div className="toolbar-group">
        <button
          type="button"
          disabled={s.selection.length === 0}
          title="Delete the selected geometry and constraints (Delete)"
          onClick={() => session.getState().deleteSelection()}
        >
          Delete
        </button>
        <button
          type="button"
          disabled={!s.canUndo}
          onClick={() => session.getState().undo()}
          title="Undo (Ctrl+Z)"
        >
          Undo
        </button>
        <button
          type="button"
          disabled={!s.canRedo}
          onClick={() => session.getState().redo()}
          title="Redo (Ctrl+Y)"
        >
          Redo
        </button>
      </div>
    </div>
  );
}

/** Constraint state, DOF and the current tool's prompt. */
export function SketchStatusBar({ session }: { session: SketchSessionStore }) {
  const s = useStore(session);
  const status = describeStatus(s.solve, s.solverError);
  const prompt =
    s.message ??
    (s.draw
      ? toolPrompt(s.draw)
      : s.tool === 'dimension'
        ? dimensionPrompt(s.dimensionPicks.length)
        : null);
  return (
    <div
      className="sketch-status"
      data-testid="sketch-status"
      data-state={status.kind}
      data-dof={status.dof ?? ''}
      data-solving={s.solving ? 'true' : 'false'}
    >
      <span className={`sketch-state ${status.kind}`} data-testid="sketch-dof">
        {status.text}
      </span>
      {prompt && <span className="sketch-prompt">{prompt}</span>}
    </div>
  );
}

function dimensionPrompt(picks: number): string {
  if (picks === 0) return 'Click a line, circle or arc, or two items to dimension.';
  if (picks === 1) return 'Click where the dimension goes, or a second item.';
  return 'Click where the dimension goes.';
}

/** Explains a conflict and offers to delete a constraint to resolve it. */
export function ConflictPanel({ session }: { session: SketchSessionStore }) {
  const s = useStore(session);
  const conflicting = s.solve?.diagnosis.conflicting ?? [];
  if (conflicting.length === 0) return null;
  const { blamed, others } = conflictBlame(conflicting, s.sketch.constraints, s.lastAdded);
  const byId = new Map(s.sketch.constraints.map((c) => [c.id, c]));
  const describe = (id: string) => {
    const c = byId.get(id);
    if (!c) return id;
    if (isDimension(c) && s.source) {
      const kind = valueKindOf(c);
      const v = evaluateStored(c.value, kind, s.source.variables);
      return `${CONSTRAINT_NAMES[c.kind]} ${v === null ? c.value.source : formatValue(v, kind, s.source.units)}`;
    }
    return CONSTRAINT_NAMES[c.kind];
  };
  const row = (id: string, main: boolean) => (
    <li key={id} className={main ? 'blamed' : ''} data-constraint={id}>
      <button
        type="button"
        className="link"
        onClick={() => session.getState().select({ kind: 'constraint', id }, 'replace')}
        title="Show this constraint"
      >
        {describe(id)} <code>{id}</code>
      </button>
      <button
        type="button"
        className={main ? 'primary' : ''}
        aria-label={`Delete ${describe(id)} ${id}`}
        onClick={() => session.getState().deleteConstraint(id)}
      >
        Delete
      </button>
    </li>
  );
  return (
    <section
      className="conflict-panel"
      role="alert"
      aria-label="Conflicting constraints"
      data-testid="conflict-panel"
    >
      <h3>These constraints conflict</h3>
      <p>
        They cannot all hold at once, so the sketch keeps its last shape. Delete one of them
        {blamed ? ', most likely the newest' : ''}, or undo.
      </p>
      <ol>
        {blamed && row(blamed, true)}
        {others.map((id) => row(id, false))}
      </ol>
      <button type="button" disabled={!s.canUndo} onClick={() => session.getState().undo()}>
        Undo the last change
      </button>
    </section>
  );
}

/** What is selected in the sketch, for the side panel. */
export function SketchSelectionList({ session }: { session: SketchSessionStore }) {
  const selection = useStore(session, (s) => s.selection);
  const constraints = useStore(session, (s) => s.sketch.constraints);
  const byId = new Map(constraints.map((c) => [c.id, c]));
  if (selection.length === 0) {
    return <p>Nothing selected. Click geometry, a constraint glyph or a dimension.</p>;
  }
  return (
    <ol data-testid="sketch-selection">
      {selection.map((item) => {
        const text =
          item.kind === 'constraint'
            ? `${CONSTRAINT_NAMES[byId.get(item.id)?.kind ?? 'coincident']} ${item.id}`
            : item.kind === 'entity'
              ? item.id
              : `${item.ref.entity}${item.ref.at ? ` ${item.ref.at}` : ''}`;
        return (
          <li key={JSON.stringify(item)} data-kind={item.kind}>
            {text}
          </li>
        );
      })}
    </ol>
  );
}
