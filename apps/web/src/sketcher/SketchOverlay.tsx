// Draws the sketch being edited over the 3D view: region fills, geometry
// coloured by constraint state, the tool preview, snap and inference hints,
// constraint glyphs, dimensions with their labels, and the inline editor for
// a dimension value. Geometry is SVG; glyphs, labels and the editor are HTML
// so they can be clicked and typed into. Everything is projected through the
// viewport camera, so it follows the view when the user orbits.

import { detectRegions, flattenRegion } from '@manufakture/sketch';
import type { DimensionalConstraint, SketchEntity, Vec2 } from '@manufakture/sketch/model';
import { useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useStore } from 'zustand';
import { CONSTRAINT_NAMES, constraintGlyphs } from './constraints';
import { isDimension, layoutDimension, proposeDimension, type DimensionLayout } from './dimension';
import { entityVertices, indexEntities, tessellate } from './geometry';
import { itemKey, selectModeOf, type SketchItem } from './items';
import { axisSegments } from './planes';
import { pathData, type SketchView } from './projection';
import type { SketchSessionStore } from './session';
import { constraintState, entityStatus } from './status';
import { toolPreview } from './tools';
import { checkValue, evaluateStored, formatValue, isPlainNumber, valueKindOf } from './values';

/** Pixel sizes of the overlay. */
const PX = { gap: 28, glyph: 16, snap: 10 };

export interface SketchOverlayProps {
  session: SketchSessionStore;
  view: SketchView;
  /** Canvas size in CSS pixels, for sizing the axes. */
  size: { width: number; height: number };
}

export function SketchOverlay({ session, view, size }: SketchOverlayProps) {
  const s = useStore(session);
  const { sketch, solve, source } = s;
  const index = useMemo(() => indexEntities(sketch.entities), [sketch.entities]);
  const selected = useMemo(() => new Set(s.selection.map(itemKey)), [s.selection]);
  const hoveredKey = s.hovered ? itemKey(s.hovered) : null;
  const upp = view.unitsPerPixel(size.width / 2, size.height / 2);

  // Closed regions as subtle fills. Detection depends on the geometry only.
  const regions = useMemo(() => {
    try {
      return detectRegions(sketch.entities).regions.map((r) =>
        flattenRegion(r, { linear: 0.05, angular: 0.2 }),
      );
    } catch {
      return [];
    }
  }, [sketch.entities]);

  if (!source) return null;
  const units = source.units;
  const variables = source.variables;

  const preview: SketchEntity[] =
    s.draw && s.cursor
      ? toolPreview(s.draw, s.cursor, {
          index,
          construction: s.construction,
          tolerance: upp * PX.snap,
        })
      : [];

  // The dimension the tool would place at the cursor.
  let dimPreview: DimensionLayout | null = null;
  if (s.tool === 'dimension' && s.dimensionPicks.length > 0 && s.cursor) {
    const p = proposeDimension(s.dimensionPicks, index);
    if (p) dimPreview = layoutDimension(p.constraint, index, upp * PX.gap, s.cursor.position);
  }

  const glyphs = constraintGlyphs(sketch.constraints, index);
  const dimensions = sketch.constraints.filter(isDimension);
  const extent = Math.max(size.width, size.height) * upp;
  const axes = axisSegments(extent);

  const entityClass = (e: SketchEntity) => {
    const key = itemKey({ kind: 'entity', id: e.id });
    return [
      'sk-entity',
      entityStatus(solve, e.id),
      e.construction ? 'construction' : '',
      selected.has(key) ? 'selected' : '',
      hoveredKey === key ? 'hovered' : '',
    ]
      .filter(Boolean)
      .join(' ');
  };

  const select = (item: SketchItem, e: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }) =>
    session.getState().select(item, selectModeOf(e));

  return (
    <div className="sketch-overlay" data-testid="sketch-overlay">
      <svg className="sketch-svg" width={size.width} height={size.height}>
        <g className="sk-fills">
          {regions.map((loops, i) => (
            <path
              key={i}
              className="sk-fill"
              data-testid="region-fill"
              fillRule="evenodd"
              d={loops.map((l) => pathData(view, l, true)).join(' ')}
            />
          ))}
        </g>
        <g className="sk-axes">
          <path className="sk-axis x" d={pathData(view, axes.x)} />
          <path className="sk-axis y" d={pathData(view, axes.y)} />
        </g>
        <g className="sk-entities">
          {sketch.entities.map((e) =>
            e.kind === 'point' ? null : (
              <path
                key={e.id}
                className={entityClass(e)}
                data-testid={`entity-${e.id}`}
                data-status={entityStatus(solve, e.id)}
                data-construction={e.construction ? 'true' : 'false'}
                d={pathData(view, tessellate(e))}
              />
            ),
          )}
        </g>
        <g className="sk-vertices">
          {sketch.entities.flatMap((e) =>
            entityVertices(e).map((v) => {
              const c = view.toCanvas(v.position);
              const key = itemKey({ kind: 'point', ref: v.ref });
              const cls = [
                'sk-vertex',
                entityStatus(solve, e.id),
                selected.has(key) || selected.has(itemKey({ kind: 'entity', id: e.id }))
                  ? 'selected'
                  : '',
                hoveredKey === key ? 'hovered' : '',
              ]
                .filter(Boolean)
                .join(' ');
              return (
                <circle
                  key={key}
                  className={cls}
                  cx={c.x}
                  cy={c.y}
                  r={e.kind === 'point' ? 4 : 3}
                />
              );
            }),
          )}
          <OriginMarker view={view} selected={selected.has('point:@origin')} />
        </g>
        <g className="sk-preview" data-testid="sketch-preview">
          {preview.map((e) =>
            e.kind === 'point' ? null : (
              <path key={e.id} className="sk-entity preview" d={pathData(view, tessellate(e))} />
            ),
          )}
        </g>
        <g className="sk-dimensions">
          {dimensions.map((c) => {
            const layout = layoutDimension(c, index, upp * PX.gap, s.labels[c.id]);
            if (!layout) return null;
            const state = constraintState(solve, c.id);
            const sel = selected.has(itemKey({ kind: 'constraint', id: c.id }));
            return (
              <DimensionLines
                key={c.id}
                view={view}
                layout={layout}
                className={`sk-dim ${state}${sel ? ' selected' : ''}`}
              />
            );
          })}
          {dimPreview && (
            <DimensionLines view={view} layout={dimPreview} className="sk-dim preview" />
          )}
        </g>
        {s.cursor?.target && (
          <SnapMarker view={view} at={s.cursor.position} kind={s.cursor.target.kind} />
        )}
      </svg>

      <div className="sketch-labels">
        {glyphs.map((g, i) => {
          const c = view.toCanvas(g.anchor);
          const state = constraintState(solve, g.constraintId);
          const item: SketchItem = { kind: 'constraint', id: g.constraintId };
          const sel = selected.has(itemKey(item));
          return (
            <button
              key={`${g.constraintId}:${i}`}
              type="button"
              className={`sk-glyph ${state}${sel ? ' selected' : ''}`}
              data-testid={`constraint-${g.constraintId}`}
              data-kind={g.kind}
              data-state={state}
              title={`${CONSTRAINT_NAMES[g.kind]} (${g.constraintId})`}
              style={{ left: c.x + 8 + g.slot * PX.glyph, top: c.y - 22 }}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => select(item, e)}
            >
              {g.symbol}
            </button>
          );
        })}
        {dimensions.map((c) => (
          <DimensionLabel
            key={c.id}
            constraint={c}
            session={session}
            view={view}
            upp={upp}
            selected={selected.has(itemKey({ kind: 'constraint', id: c.id }))}
            state={constraintState(solve, c.id)}
            text={labelText(c, units, variables)}
            select={(e) => select({ kind: 'constraint', id: c.id }, e)}
          />
        ))}
        {s.cursor && <InferenceHints view={view} session={session} />}
        {s.editing && (
          <DimensionEditor key={s.editing.id} session={session} view={view} upp={upp} />
        )}
      </div>
    </div>
  );
}

function labelText(
  c: DimensionalConstraint,
  units: Parameters<typeof formatValue>[2],
  variables: Parameters<typeof evaluateStored>[2],
): string {
  const kind = valueKindOf(c);
  const v = evaluateStored(c.value, kind, variables);
  const shown = v === null ? '?' : formatValue(v, kind, units);
  const prefix = c.kind === 'diameter' ? '⌀ ' : c.kind === 'radius' ? 'R ' : '';
  return isPlainNumber(c.value.source)
    ? `${prefix}${shown}`
    : `${prefix}${c.value.source} = ${shown}`;
}

function OriginMarker({ view, selected }: { view: SketchView; selected: boolean }) {
  const c = view.toCanvas([0, 0]);
  return (
    <circle
      className={`sk-origin${selected ? ' selected' : ''}`}
      data-testid="sketch-origin"
      cx={c.x}
      cy={c.y}
      r={4}
    />
  );
}

function SnapMarker({ view, at, kind }: { view: SketchView; at: Vec2; kind: 'point' | 'curve' }) {
  const c = view.toCanvas(at);
  if (kind === 'point') {
    return (
      <rect
        className="sk-snap"
        data-testid="snap-marker"
        x={c.x - 6}
        y={c.y - 6}
        width={12}
        height={12}
      />
    );
  }
  return (
    <path
      className="sk-snap"
      data-testid="snap-marker"
      d={`M${c.x - 5} ${c.y - 5}L${c.x + 5} ${c.y + 5}M${c.x - 5} ${c.y + 5}L${c.x + 5} ${c.y - 5}`}
    />
  );
}

function DimensionLines({
  view,
  layout,
  className,
}: {
  view: SketchView;
  layout: DimensionLayout;
  className: string;
}) {
  const arrows = layout.arrows.map((a) => {
    const tip = view.toCanvas(a.at);
    const ahead = view.toCanvas([a.at[0] + a.dir[0] * 1e-3, a.at[1] + a.dir[1] * 1e-3]);
    let dx = ahead.x - tip.x;
    let dy = ahead.y - tip.y;
    const l = Math.hypot(dx, dy) || 1;
    dx /= l;
    dy /= l;
    const back = (angle: number) => {
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      return `${(tip.x - 8 * (dx * cos - dy * sin)).toFixed(1)} ${(tip.y - 8 * (dx * sin + dy * cos)).toFixed(1)}`;
    };
    return `M${back(0.4)}L${tip.x.toFixed(1)} ${tip.y.toFixed(1)}L${back(-0.4)}`;
  });
  return (
    <g className={className}>
      {layout.lines.map((l, i) => (
        <path key={i} d={pathData(view, l)} />
      ))}
      {arrows.map((d, i) => (
        <path key={`a${i}`} d={d} />
      ))}
    </g>
  );
}

function DimensionLabel({
  constraint,
  session,
  view,
  upp,
  selected,
  state,
  text,
  select,
}: {
  constraint: DimensionalConstraint;
  session: SketchSessionStore;
  view: SketchView;
  upp: number;
  selected: boolean;
  state: 'ok' | 'conflicting' | 'redundant';
  text: string;
  select: (e: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }) => void;
}) {
  const s = session.getState();
  const index = indexEntities(s.sketch.entities);
  const layout = layoutDimension(constraint, index, upp * PX.gap, s.labels[constraint.id]);
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  if (!layout) return null;
  const c = view.toCanvas(layout.label);
  const onDown = (e: ReactPointerEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    if (e.button !== 0) return;
    drag.current = { x: e.clientX, y: e.clientY, moved: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onMove = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (!d) return;
    if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 4) return;
    d.moved = true;
    // Drag the label: the dimension line follows it.
    const rect = e.currentTarget.parentElement!.getBoundingClientRect();
    const at = view.fromCanvas(e.clientX - rect.left, e.clientY - rect.top);
    if (at) session.getState().moveLabel(constraint.id, at);
  };
  const onUp = () => {
    drag.current = null;
  };
  return (
    <button
      type="button"
      className={`sk-dim-label ${state}${selected ? ' selected' : ''}`}
      data-testid={`dimension-${constraint.id}`}
      data-kind={constraint.kind}
      data-state={state}
      data-source={constraint.value.source}
      title={`${CONSTRAINT_NAMES[constraint.kind]}: ${constraint.value.source}. Double-click to edit.`}
      style={{ left: c.x, top: c.y }}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onClick={(e) => select(e)}
      onDoubleClick={() => session.getState().openEditor(constraint.id)}
    >
      {text}
    </button>
  );
}

function InferenceHints({ view, session }: { view: SketchView; session: SketchSessionStore }) {
  const cursor = useStore(session, (s) => s.cursor);
  if (!cursor) return null;
  const hints: string[] = [];
  if (cursor.target?.kind === 'point') hints.push('Coincident');
  else if (cursor.target?.kind === 'curve') hints.push('On curve');
  if (cursor.horizontal) hints.push('Horizontal');
  if (cursor.vertical) hints.push('Vertical');
  if (cursor.tangent) hints.push('Tangent');
  if (hints.length === 0) return null;
  const c = view.toCanvas(cursor.position);
  return (
    <div
      className="sk-hints"
      data-testid="inference-hints"
      style={{ left: c.x + 14, top: c.y + 12 }}
    >
      {hints.map((h) => (
        <span key={h} className="sk-hint" data-hint={h}>
          {h}
        </span>
      ))}
    </div>
  );
}

function DimensionEditor({
  session,
  view,
  upp,
}: {
  session: SketchSessionStore;
  view: SketchView;
  upp: number;
}) {
  const s = session.getState();
  const id = s.editing!.id;
  const c = s.sketch.constraints.find((k) => k.id === id);
  const [text, setText] = useState(c && isDimension(c) ? c.value.source : '');
  const [error, setError] = useState<string | null>(null);
  const done = useRef(false);
  if (!c || !isDimension(c) || !s.source) return null;
  const layout = layoutDimension(c, indexEntities(s.sketch.entities), upp * PX.gap, s.labels[id]);
  const at = layout ? view.toCanvas(layout.label) : { x: 0, y: 0 };
  const source = s.source;
  const live = checkValue(text, c.kind, source.units, source.variables);

  const commit = () => {
    if (done.current) return;
    const r = session.getState().setDimensionValue(id, text);
    if (r.ok) done.current = true;
    else setError(r.message);
  };
  return (
    <div
      className="sk-editor"
      style={{ left: at.x, top: at.y }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <input
        aria-label="Dimension value"
        data-testid="dimension-input"
        aria-invalid={!live.ok}
        value={text}
        autoFocus
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => {
          setText(e.target.value);
          setError(null);
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') commit();
          else if (e.key === 'Escape') {
            done.current = true;
            session.getState().closeEditor();
          }
        }}
        onBlur={() => {
          if (done.current) return;
          if (live.ok) commit();
          else {
            done.current = true;
            session.getState().closeEditor();
          }
        }}
      />
      {(error ?? (!live.ok && text.trim() !== '' ? live.message : null)) && (
        <div className="sk-editor-error" role="alert" data-testid="dimension-error">
          {error ?? (live.ok ? '' : live.message)}
        </div>
      )}
      {live.ok && !isPlainNumber(text) && (
        <div className="sk-editor-value" data-testid="dimension-preview">
          = {formatValue(live.value, valueKindOf(c), source.units)}
        </div>
      )}
    </div>
  );
}
