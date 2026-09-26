// The drawing tools as pure state machines. A tool gets snapped pick points
// (see snap.ts) for moves and clicks and answers with its next state, a
// preview to draw, and on completion a draft (see draft.ts) of the entities
// and constraints to add. Everything the tools create is counter-clockwise
// where it has a direction, and never reversed afterwards, so the region ids
// of `@manufakture/sketch` stay stable.

import type { EndPosition, PointRef, SketchEntity, Vec2 } from '@manufakture/sketch/model';
import {
  directionConstraints,
  snapConstraints,
  tempId,
  type Draft,
  type DraftConstraint,
} from './draft';
import {
  angleOf,
  centerArc,
  distance,
  outwardTangent,
  sub,
  tangentArc,
  arcThroughPoints,
  wrapDelta,
  type ArcGeometry,
  type EntityIndex,
} from './geometry';
import type { PickPoint } from './snap';

export type DrawToolId =
  | 'line'
  | 'rectangle'
  | 'centerRectangle'
  | 'circle'
  | 'arc3'
  | 'tangentArc'
  | 'centerArc'
  | 'point';

export type ToolId = 'select' | 'dimension' | DrawToolId;

export const DRAW_TOOLS: readonly DrawToolId[] = [
  'line',
  'rectangle',
  'centerRectangle',
  'circle',
  'arc3',
  'tangentArc',
  'centerArc',
  'point',
];

/** Keyboard shortcuts for the tools. */
export const TOOL_KEYS: Readonly<Record<string, ToolId>> = {
  s: 'select',
  l: 'line',
  r: 'rectangle',
  c: 'circle',
  a: 'arc3',
  g: 'tangentArc',
  p: 'point',
  d: 'dimension',
};

export function isDrawTool(tool: ToolId): tool is DrawToolId {
  return (DRAW_TOOLS as readonly string[]).includes(tool);
}

export type DrawState =
  | { tool: 'point' }
  | { tool: 'line'; start: PickPoint | null }
  | { tool: 'rectangle' | 'centerRectangle' | 'circle'; first: PickPoint | null }
  | { tool: 'arc3'; start: PickPoint | null; end: PickPoint | null }
  | { tool: 'tangentArc'; start: PickPoint | null }
  | {
      tool: 'centerArc';
      center: PickPoint | null;
      start: PickPoint | null;
      /** Angle swept so far by the cursor from the start, counter-clockwise positive. */
      sweep: number;
      lastAngle: number | null;
    };

export interface ToolContext {
  index: EntityIndex;
  /** New geometry is construction geometry. */
  construction: boolean;
  /** Snap tolerance in sketch units, for "is this the same place". */
  tolerance: number;
}

export interface ToolStep {
  state: DrawState;
  draft?: Draft;
  /** A hint for the status bar, e.g. why a click did nothing. */
  message?: string;
}

/** Status bar prompts per tool and step. */
export function toolPrompt(state: DrawState): string {
  switch (state.tool) {
    case 'point':
      return 'Click where the point goes (a hole centre, a reference point).';
    case 'line':
      return state.start
        ? 'Click the next point. Double-click or Esc ends the line.'
        : 'Click the start of the line.';
    case 'rectangle':
      return state.first ? 'Click the opposite corner.' : 'Click the first corner.';
    case 'centerRectangle':
      return state.first ? 'Click a corner.' : 'Click the centre of the rectangle.';
    case 'circle':
      return state.first ? 'Click a point on the circle.' : 'Click the centre of the circle.';
    case 'arc3':
      return !state.start
        ? 'Click the start of the arc.'
        : !state.end
          ? 'Click the end of the arc.'
          : 'Click a point the arc passes through.';
    case 'tangentArc':
      return state.start
        ? 'Click the end of the arc.'
        : 'Click the end of a line or arc to continue from.';
    case 'centerArc':
      return !state.center
        ? 'Click the centre of the arc.'
        : !state.start
          ? 'Click the start of the arc.'
          : 'Click the end of the arc.';
  }
}

export function initialDrawState(tool: DrawToolId): DrawState {
  switch (tool) {
    case 'point':
      return { tool };
    case 'line':
    case 'tangentArc':
      return { tool, start: null };
    case 'rectangle':
    case 'centerRectangle':
    case 'circle':
      return { tool, first: null };
    case 'arc3':
      return { tool, start: null, end: null };
    case 'centerArc':
      return { tool, center: null, start: null, sweep: 0, lastAngle: null };
  }
}

/** Whether the tool is part way through a shape. */
export function isIdle(state: DrawState): boolean {
  return JSON.stringify(state) === JSON.stringify(initialDrawState(state.tool));
}

/**
 * The point horizontal, vertical and tangent inference is relative to: the
 * start of the line being drawn.
 */
export function anchorOf(state: DrawState): PickPoint | null {
  return state.tool === 'line' ? state.start : null;
}

/** Update state that depends on the cursor path (the centre arc's sweep). */
export function toolMove(state: DrawState, pick: PickPoint): DrawState {
  if (state.tool !== 'centerArc' || !state.center || !state.start) return state;
  const angle = angleOf(sub(pick.position, state.center.position));
  if (state.lastAngle === null) {
    const a0 = angleOf(sub(state.start.position, state.center.position));
    return { ...state, sweep: wrapDelta(angle - a0), lastAngle: angle };
  }
  return { ...state, sweep: state.sweep + wrapDelta(angle - state.lastAngle), lastAngle: angle };
}

/** Esc: drop the shape in progress, or leave the tool when there is none. */
export function toolEscape(state: DrawState): { state: DrawState; exit: boolean } {
  if (isIdle(state)) return { state, exit: true };
  return { state: initialDrawState(state.tool), exit: false };
}

const line = (id: string, start: Vec2, end: Vec2, construction: boolean): SketchEntity => ({
  id,
  kind: 'line',
  construction,
  start,
  end,
});

const arcEntity = (id: string, g: ArcGeometry, construction: boolean): SketchEntity => ({
  id,
  kind: 'arc',
  construction,
  center: g.center,
  start: g.start,
  end: g.end,
});

/** The ends of an arc as drawn: where the user started and where they ended. */
function drawnEnds(g: ArcGeometry, id: string): { first: PointRef; last: PointRef } {
  return g.reversed
    ? { first: { entity: id, at: 'end' }, last: { entity: id, at: 'start' } }
    : { first: { entity: id, at: 'start' }, last: { entity: id, at: 'end' } };
}

interface RectangleCorners {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Four lines, counter-clockwise from the bottom left, joined and axis aligned. */
function rectangleDraft(r: RectangleCorners, construction: boolean): Draft {
  const [b, rt, t, l] = [0, 1, 2, 3].map(tempId) as [string, string, string, string];
  const bl: Vec2 = [r.x0, r.y0];
  const br: Vec2 = [r.x1, r.y0];
  const tr: Vec2 = [r.x1, r.y1];
  const tl: Vec2 = [r.x0, r.y1];
  const join = (a: string, bb: string): DraftConstraint => ({
    kind: 'coincident',
    a: { entity: a, at: 'end' },
    b: { entity: bb, at: 'start' },
  });
  return {
    entities: [
      line(b, bl, br, construction),
      line(rt, br, tr, construction),
      line(t, tr, tl, construction),
      line(l, tl, bl, construction),
    ],
    constraints: [
      join(b, rt),
      join(rt, t),
      join(t, l),
      join(l, b),
      { kind: 'horizontal', line: b },
      { kind: 'vertical', line: rt },
      { kind: 'horizontal', line: t },
      { kind: 'vertical', line: l },
    ],
  };
}

/** Which rectangle corner (as a line start) a point is. */
function cornerRef(r: RectangleCorners, p: Vec2): PointRef {
  const left = Math.abs(p[0] - r.x0) <= Math.abs(p[0] - r.x1);
  const bottom = Math.abs(p[1] - r.y0) <= Math.abs(p[1] - r.y1);
  const n = bottom ? (left ? 0 : 1) : left ? 3 : 2;
  return { entity: tempId(n), at: 'start' };
}

function cornersOf(a: Vec2, c: Vec2): RectangleCorners {
  return {
    x0: Math.min(a[0], c[0]),
    y0: Math.min(a[1], c[1]),
    x1: Math.max(a[0], c[0]),
    y1: Math.max(a[1], c[1]),
  };
}

function tangentStart(
  pick: PickPoint,
  index: EntityIndex,
): { entity: SketchEntity; at: EndPosition; dir: Vec2 } | null {
  const t = pick.target;
  if (t?.kind !== 'point' || (t.ref.at !== 'start' && t.ref.at !== 'end')) return null;
  const e = index.get(t.ref.entity);
  if (!e || (e.kind !== 'line' && e.kind !== 'arc')) return null;
  const dir = outwardTangent(e, t.ref.at);
  return dir ? { entity: e, at: t.ref.at, dir } : null;
}

/** The shape the tool would make if the user clicked at `pick` now. */
export function toolPreview(
  state: DrawState,
  pick: PickPoint | null,
  ctx: ToolContext,
): SketchEntity[] {
  if (!pick) return [];
  const step = toolClick(state, pick, ctx, true);
  if (step.draft) return step.draft.entities;
  // Part-way previews for tools that need more than two clicks.
  if (state.tool === 'arc3' && state.start && !state.end) {
    if (distance(state.start.position, pick.position) < 1e-9) return [];
    return [line(tempId(0), state.start.position, pick.position, true)];
  }
  if (state.tool === 'centerArc' && state.center && !state.start) {
    const r = distance(state.center.position, pick.position);
    if (r < 1e-9) return [];
    return [
      {
        id: tempId(0),
        kind: 'circle',
        construction: true,
        center: state.center.position,
        radius: r,
      },
    ];
  }
  return [];
}

/**
 * A click at `pick`. With `preview`, the draft is only for drawing the
 * shape under the cursor and the state is not meant to be kept.
 */
export function toolClick(
  state: DrawState,
  pick: PickPoint,
  ctx: ToolContext,
  preview = false,
): ToolStep {
  const c = ctx.construction;
  const same = (a: Vec2, b: Vec2) => distance(a, b) <= Math.max(ctx.tolerance * 0.25, 1e-9);
  switch (state.tool) {
    case 'point': {
      if (preview) return { state };
      const id = tempId(0);
      return {
        state,
        draft: {
          entities: [{ id, kind: 'point', construction: c, position: pick.position }],
          constraints: snapConstraints(pick.target, { entity: id }),
        },
      };
    }
    case 'line': {
      const start = state.start;
      if (!start) return preview ? { state } : { state: { tool: 'line', start: pick } };
      if (same(start.position, pick.position)) return { state };
      const id = tempId(0);
      const startRef: PointRef = { entity: id, at: 'start' };
      const endRef: PointRef = { entity: id, at: 'end' };
      const constraints: DraftConstraint[] = [];
      if (pick.tangent) {
        // An endpoint tangency includes the coincidence.
        constraints.push({
          kind: 'tangent',
          a: pick.tangent.entity,
          b: id,
          at: [pick.tangent.at, 'start'],
        });
      } else {
        constraints.push(...snapConstraints(start.target, startRef));
      }
      constraints.push(...snapConstraints(pick.target, endRef));
      constraints.push(...directionConstraints(pick, id));
      const draft: Draft = { entities: [line(id, start.position, pick.position, c)], constraints };
      // Chain: the next line starts at this one's end, unless this one closed
      // onto existing geometry.
      const closed = pick.target?.kind === 'point';
      const next: DrawState = {
        tool: 'line',
        start: closed ? null : { position: pick.position, target: { kind: 'point', ref: endRef } },
      };
      return { state: next, draft };
    }

    case 'rectangle':
    case 'centerRectangle': {
      const first = state.first;
      if (!first) return preview ? { state } : { state: { tool: state.tool, first: pick } };
      const centered = state.tool === 'centerRectangle';
      const a = first.position;
      const p = pick.position;
      const corners = centered ? cornersOf([2 * a[0] - p[0], 2 * a[1] - p[1]], p) : cornersOf(a, p);
      const size = Math.min(corners.x1 - corners.x0, corners.y1 - corners.y0);
      if (size <= Math.max(ctx.tolerance * 0.25, 1e-9)) {
        return { state, message: 'A rectangle needs a width and a height.' };
      }
      const draft = rectangleDraft(corners, c);
      if (centered) {
        let center: PointRef;
        if (first.target?.kind === 'point') {
          center = first.target.ref;
        } else {
          const id = tempId(4);
          draft.entities.push({ id, kind: 'point', construction: true, position: a });
          center = { entity: id };
          draft.constraints.push(...snapConstraints(first.target, center));
        }
        draft.constraints.push({
          kind: 'symmetric',
          a: { entity: tempId(0), at: 'start' },
          b: { entity: tempId(2), at: 'start' },
          center,
        });
      } else {
        draft.constraints.push(...snapConstraints(first.target, cornerRef(corners, a)));
      }
      draft.constraints.push(...snapConstraints(pick.target, cornerRef(corners, p)));
      return { state: { tool: state.tool, first: null }, draft };
    }

    case 'circle': {
      const first = state.first;
      if (!first) return preview ? { state } : { state: { tool: 'circle', first: pick } };
      const radius = distance(first.position, pick.position);
      if (radius <= Math.max(ctx.tolerance * 0.25, 1e-9)) return { state };
      const id = tempId(0);
      const constraints = snapConstraints(first.target, { entity: id, at: 'center' });
      if (pick.target?.kind === 'point') {
        constraints.push({ kind: 'pointOnObject', point: pick.target.ref, on: id });
      }
      return {
        state: { tool: 'circle', first: null },
        draft: {
          entities: [{ id, kind: 'circle', construction: c, center: first.position, radius }],
          constraints,
        },
      };
    }

    case 'arc3': {
      if (!state.start) return preview ? { state } : { state: { ...state, start: pick } };
      if (!state.end) {
        if (same(state.start.position, pick.position)) return { state };
        return preview ? { state } : { state: { ...state, end: pick } };
      }
      const g = arcThroughPoints(state.start.position, state.end.position, pick.position);
      if (!g) return { state, message: 'The three points are in a line.' };
      const id = tempId(0);
      const ends = drawnEnds(g, id);
      return {
        state: initialDrawState('arc3'),
        draft: {
          entities: [arcEntity(id, g, c)],
          constraints: [
            ...snapConstraints(state.start.target, ends.first),
            ...snapConstraints(state.end.target, ends.last),
          ],
        },
      };
    }

    case 'tangentArc': {
      if (!state.start) {
        if (!tangentStart(pick, ctx.index)) {
          return { state, message: 'Start a tangent arc on the end of a line or arc.' };
        }
        return preview ? { state } : { state: { tool: 'tangentArc', start: pick } };
      }
      const from = tangentStart(state.start, ctx.index);
      if (!from) return { state: initialDrawState('tangentArc') };
      const g = tangentArc(state.start.position, from.dir, pick.position);
      if (!g) return { state, message: 'The end is straight ahead: draw a line instead.' };
      const id = tempId(0);
      const ends = drawnEnds(g, id);
      return {
        state: initialDrawState('tangentArc'),
        draft: {
          entities: [arcEntity(id, g, c)],
          constraints: [
            {
              kind: 'tangent',
              a: from.entity.id,
              b: id,
              at: [from.at, ends.first.at as EndPosition],
            },
            ...snapConstraints(pick.target, ends.last),
          ],
        },
      };
    }

    case 'centerArc': {
      if (!state.center) return preview ? { state } : { state: { ...state, center: pick } };
      if (!state.start) {
        if (same(state.center.position, pick.position)) return { state };
        return preview
          ? { state }
          : { state: { ...state, start: pick, sweep: 0, lastAngle: null } };
      }
      const moved = toolMove(state, pick);
      if (moved.tool !== 'centerArc') return { state };
      const g = centerArc(state.center.position, state.start.position, moved.sweep);
      if (!g) return { state };
      const id = tempId(0);
      const ends = drawnEnds(g, id);
      const endPos = g.reversed ? g.start : g.end;
      const constraints = [
        ...snapConstraints(state.center.target, { entity: id, at: 'center' }),
        ...snapConstraints(state.start.target, ends.first),
      ];
      // The end is projected onto the circle: keep its snap only if it still holds.
      if (distance(endPos, pick.position) <= ctx.tolerance) {
        constraints.push(...snapConstraints(pick.target, ends.last));
      }
      return {
        state: initialDrawState('centerArc'),
        draft: { entities: [arcEntity(id, g, c)], constraints },
      };
    }
  }
}
