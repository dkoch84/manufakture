// The sketch editing session: the sketch being edited, its last solve, the
// active tool, the sketch selection and the sketch's own undo history.
//
// Every edit makes a new SketchInput and sends it to the solver (a worker,
// ADR 0003 and 0007) through `SketchSolverApi.update`; replies older than the
// newest edit are dropped. Dragging a point uses the solver's drag API, whose
// moves the worker coalesces; dragging a curve moves it and re-solves, with
// at most one solve in flight. The session knows nothing about the document:
// `begin` gets the sketch and the id counters, `finish` hands back the result
// for the caller to commit as one document command.

import type {
  DimensionalConstraint,
  PointRef,
  SketchConstraint,
  SketchEntity,
  SketchInput,
  SketchPlacement,
  SolveResult,
  Vec2,
} from '@manufakture/sketch/model';
import { applyCoordinates } from '@manufakture/sketch/model';
import type { DisplayUnits, FaceRef } from '@manufakture/core';
import type { SketchSolverApi } from '@manufakture/sketch';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { constraintsFromSelection, type ConstraintToolKind } from './constraints';
import { isDimension, proposeDimension, type DimensionPick } from './dimension';
import { materialize, renamePick, type Draft, type DraftConstraint } from './draft';
import { add, distance, indexEntities, sameRef, sub, type EntityIndex } from './geometry';
import { hitTest, isBuiltinItem, itemKey, sameItem, type SketchItem } from './items';
import { inferFromAnchor, snapCursor, type PickPoint } from './snap';
import {
  anchorOf,
  initialDrawState,
  isDrawTool,
  isIdle,
  toolClick,
  toolEscape,
  toolMove,
  type DrawState,
  type ToolId,
} from './tools';
import { checkValue, measuredSource, type ValueCheck, type Variables } from './values';

export interface SketchSource {
  /** The sketch feature id: an existing feature, or the id the new one will get. */
  featureId: string;
  isNew: boolean;
  name: string;
  placement: SketchPlacement;
  /** A new sketch on a named face: stored as a reference to it, so it follows the face. */
  face?: FaceRef;
  entities: readonly SketchEntity[];
  constraints: readonly SketchConstraint[];
  /** Next numbers of the part's `e` and `k` counters. */
  nextEntity: number;
  nextConstraint: number;
  units: DisplayUnits;
  variables: Variables;
}

/** What the last solve said, without the entities (those are in `sketch`). */
export interface SolveInfo {
  status: SolveResult['status'];
  diagnosis: SolveResult['diagnosis'];
  issues: SolveResult['issues'];
  message?: string;
}

export type SelectMode = 'replace' | 'add' | 'toggle';

/** Pointer input in sketch coordinates, with the pixel-derived tolerance. */
export interface PointerInput {
  at: Vec2;
  /** Snap and pick radius, in sketch units. */
  tolerance: number;
  /** Shift held: no snapping, no inferred constraints. */
  suppress?: boolean;
}

interface DragState {
  item: SketchItem;
  /** Sketch before the drag, for undo. */
  before: SketchInput;
  /** Where the pointer grabbed, and the grabbed point's offset from it. */
  grab: Vec2;
  offset: Vec2;
  moved: boolean;
  /** Point drags use the solver's drag API; curve drags re-solve moved geometry. */
  mode: 'point' | 'curve';
  /** Resolves when the solver has the drag started. */
  started: Promise<void>;
}

export interface SketchSessionState {
  active: boolean;
  source: SketchSource | null;
  sketch: SketchInput;
  solve: SolveInfo | null;
  solving: boolean;
  /** A solver call failed outright (worker error). */
  solverError: string | null;

  tool: ToolId;
  draw: DrawState | null;
  dimensionPicks: DimensionPick[];
  construction: boolean;
  /** The snapped cursor for drawing tools, the plain one otherwise. */
  cursor: PickPoint | null;
  hovered: SketchItem | null;
  selection: SketchItem[];
  /** Label positions of dimensions placed in this session (sketch coordinates). */
  labels: Record<string, Vec2>;
  /** The dimension whose value is being edited, if any. */
  editing: { id: string; fresh: boolean } | null;
  /** Constraint ids added by the most recent edit: the likely cause of a new conflict. */
  lastAdded: string[];
  message: string | null;
  canUndo: boolean;
  canRedo: boolean;
  dragging: boolean;

  begin(source: SketchSource): void;
  /** End the session and return the sketch to commit. */
  finish(): { source: SketchSource; sketch: SketchInput } | null;
  cancel(): void;

  setTool(tool: ToolId): void;
  toggleConstruction(): void;
  setVariables(variables: Variables): void;

  pointerMove(input: PointerInput): void;
  click(input: PointerInput & { mode?: SelectMode }): void;
  doubleClick(): void;
  /** The pointer left the view: no cursor, nothing hovered. */
  pointerLeave(): void;
  escape(): void;
  /** Start dragging what is under the pointer (select tool); false when there is nothing. */
  dragStart(input: PointerInput): boolean;
  dragMove(input: PointerInput): void;
  dragEnd(): Promise<void>;

  select(item: SketchItem | null, mode?: SelectMode): void;
  clearSelection(): void;
  deleteSelection(): void;
  deleteConstraint(id: string): void;
  applyConstraint(kind: ConstraintToolKind): boolean;

  openEditor(id: string): void;
  closeEditor(): void;
  setDimensionValue(id: string, source: string): ValueCheck;
  moveLabel(id: string, at: Vec2): void;

  undo(): void;
  redo(): void;
  /** Resolves when no solve is in flight. */
  idle(): Promise<void>;
}

export type SketchSessionStore = StoreApi<SketchSessionState>;

const HISTORY_LIMIT = 200;
const EMPTY: SketchInput = { entities: [], constraints: [] };

export function createSketchSession(solver: SketchSolverApi): SketchSessionStore {
  let undoStack: SketchInput[] = [];
  let redoStack: SketchInput[] = [];
  let generation = 0;
  let inflight: Promise<unknown> = Promise.resolve();
  let drag: DragState | null = null;
  /** Curve drags: the latest moved sketch waiting for the solve in flight. */
  let curvePending: SketchInput | null = null;
  let curveBusy: Promise<void> | null = null;
  let nextE = 1;
  let nextK = 1;

  return createStore<SketchSessionState>()((set, get) => {
    const index = (): EntityIndex => indexEntities(get().sketch.entities);
    const sessionId = () => get().source?.featureId ?? 'sketch';
    const variables = () => get().source?.variables ?? {};
    const history = () => ({ canUndo: undoStack.length > 0, canRedo: redoStack.length > 0 });

    /** Take a solve result: solved geometry, and the diagnosis in any case. */
    const accept = (r: SolveResult) => {
      const { entities, ...info } = r;
      const patch: Partial<SketchSessionState> = { solve: info, solverError: null };
      if (r.status === 'solved') patch.sketch = { ...get().sketch, entities };
      set(patch);
    };

    const resolve = () => {
      const gen = ++generation;
      const sketch = get().sketch;
      set({ solving: true });
      const p = solver.update(sessionId(), sketch, variables()).then(
        (r) => {
          if (gen !== generation) return;
          accept(r);
          set({ solving: false });
        },
        (e: unknown) => {
          if (gen !== generation) return;
          set({ solving: false, solverError: e instanceof Error ? e.message : String(e) });
        },
      );
      inflight = p;
      return p;
    };

    /** Replace the sketch as one undo step, and solve. */
    const edit = (next: SketchInput, added: string[] = [], record = true) => {
      if (record) {
        undoStack.push(get().sketch);
        if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
        redoStack = [];
      }
      set({ sketch: next, lastAdded: added, ...history() });
      void resolve();
    };

    const entityId = () => `e${nextE++}`;
    const constraintId = () => `k${nextK++}`;

    const addDraft = (draft: Draft) => {
      const m = materialize(draft, entityId, constraintId);
      const { sketch } = get();
      edit(
        {
          entities: [...sketch.entities, ...m.entities],
          constraints: [...sketch.constraints, ...m.constraints],
        },
        m.constraints.map((c) => c.id),
      );
      return m;
    };

    const addConstraints = (drafts: readonly DraftConstraint[]) =>
      addDraft({ entities: [], constraints: [...drafts] }).constraints;

    /** The cursor for a drawing tool: snapped, then inferred from the tool's anchor. */
    const drawPick = (input: PointerInput, draw: DrawState): PickPoint => {
      const { sketch } = get();
      const options = { tolerance: input.tolerance, suppress: input.suppress ?? false };
      let pick = snapCursor(sketch.entities, input.at, options);
      const anchor = anchorOf(draw);
      if (anchor) pick = inferFromAnchor(pick, anchor, index(), options);
      return pick;
    };

    const resetTool = (tool: ToolId): Partial<SketchSessionState> => ({
      tool,
      draw: isDrawTool(tool) ? initialDrawState(tool) : null,
      dimensionPicks: [],
      message: null,
      hovered: null,
    });

    const removeConstraints = (ids: ReadonlySet<string>) => {
      const { sketch } = get();
      edit({
        entities: sketch.entities,
        constraints: sketch.constraints.filter((c) => !ids.has(c.id)),
      });
    };

    return {
      active: false,
      source: null,
      sketch: EMPTY,
      solve: null,
      solving: false,
      solverError: null,
      tool: 'select',
      draw: null,
      dimensionPicks: [],
      construction: false,
      cursor: null,
      hovered: null,
      selection: [],
      labels: {},
      editing: null,
      lastAdded: [],
      message: null,
      canUndo: false,
      canRedo: false,
      dragging: false,

      begin(source) {
        undoStack = [];
        redoStack = [];
        drag = null;
        nextE = source.nextEntity;
        nextK = source.nextConstraint;
        set({
          active: true,
          source,
          sketch: { entities: source.entities, constraints: source.constraints },
          solve: null,
          solverError: null,
          construction: false,
          cursor: null,
          selection: [],
          labels: {},
          editing: null,
          lastAdded: [],
          dragging: false,
          ...resetTool('select'),
          ...history(),
        });
        void resolve();
      },

      finish() {
        const { source, sketch } = get();
        if (!source) return null;
        generation++; // a solve still running must not land on the next session
        void solver.close(source.featureId).catch(() => undefined);
        set({
          active: false,
          source: null,
          sketch: EMPTY,
          solve: null,
          editing: null,
          selection: [],
        });
        return { source, sketch };
      },

      cancel() {
        const { source } = get();
        if (source) void solver.close(source.featureId).catch(() => undefined);
        generation++;
        set({
          active: false,
          source: null,
          sketch: EMPTY,
          solve: null,
          editing: null,
          selection: [],
        });
      },

      setTool(tool) {
        set({
          ...resetTool(tool),
          cursor: null,
          selection: tool === 'select' ? get().selection : [],
        });
      },

      toggleConstruction() {
        const { selection, sketch } = get();
        const ids = new Set(
          selection.flatMap((i) => (i.kind === 'entity' && !isBuiltinItem(i) ? [i.id] : [])),
        );
        if (ids.size === 0) {
          set({ construction: !get().construction });
          return;
        }
        // Flip the selected entities: all to construction unless all already are.
        const chosen = sketch.entities.filter((e) => ids.has(e.id));
        const to = !chosen.every((e) => e.construction);
        edit({
          entities: sketch.entities.map((e) => (ids.has(e.id) ? { ...e, construction: to } : e)),
          constraints: sketch.constraints,
        });
      },

      setVariables(vars) {
        const { source } = get();
        if (!source) return;
        set({ source: { ...source, variables: vars } });
        void resolve();
      },

      pointerMove(input) {
        const { tool, draw, sketch } = get();
        if (draw) {
          const pick = drawPick(input, draw);
          set({ cursor: pick, draw: toolMove(draw, pick), hovered: null });
          return;
        }
        const hovered = hitTest(sketch.entities, input.at, input.tolerance);
        const cursor: PickPoint = { position: input.at, target: null };
        if (!sameItem(hovered, get().hovered)) set({ hovered, cursor });
        else if (tool === 'dimension') set({ cursor });
      },

      click(input) {
        const state = get();
        const { draw, tool, sketch } = state;
        if (draw) {
          const pick = drawPick(input, draw);
          const step = toolClick(draw, pick, {
            index: index(),
            construction: state.construction,
            tolerance: input.tolerance,
          });
          let next = step.state;
          if (step.draft) {
            const m = addDraft(step.draft);
            const rename = (id: string) => m.ids.get(id) ?? id;
            if (next.tool === 'line' && next.start)
              next = { ...next, start: renamePick(next.start, rename) };
          }
          set({ draw: next, cursor: pick, message: step.message ?? null });
          return;
        }
        const item = hitTest(sketch.entities, input.at, input.tolerance);
        if (tool === 'dimension') {
          const picks = state.dimensionPicks;
          const pick: DimensionPick | null =
            item?.kind === 'point'
              ? { kind: 'point', ref: item.ref }
              : item?.kind === 'entity'
                ? { kind: 'curve', entity: item.id }
                : null;
          const idx = index();
          if (pick && picks.length < 2) {
            const already = picks.some((p) => JSON.stringify(p) === JSON.stringify(pick));
            if (already) return;
            const candidate = [...picks, pick];
            // Two picks that make no dimension together: start over from the new one.
            if (candidate.length === 2 && !proposeDimension(candidate, idx)) {
              set({ dimensionPicks: [pick], message: null });
            } else {
              set({ dimensionPicks: candidate, message: null });
            }
            return;
          }
          if (picks.length === 0) return;
          const proposal = proposeDimension(picks, idx);
          if (!proposal) {
            set({ dimensionPicks: [], message: 'These cannot be dimensioned together.' });
            return;
          }
          const units = state.source!.units;
          const source = measuredSource(proposal.measured, proposal.kind, units);
          const check = checkValue(source, proposal.constraint.kind, units, variables());
          if (!check.ok) {
            set({ dimensionPicks: [], message: check.message });
            return;
          }
          const [added] = addConstraints([
            { ...proposal.constraint, value: check.expression } as DraftConstraint,
          ]);
          set({
            dimensionPicks: [],
            labels: { ...get().labels, [added!.id]: input.at },
            editing: { id: added!.id, fresh: true },
            message: null,
          });
          return;
        }
        get().select(item, input.mode ?? 'replace');
      },

      pointerLeave() {
        if (get().cursor || get().hovered) set({ cursor: null, hovered: null });
      },

      doubleClick() {
        const { draw } = get();
        if (draw?.tool === 'line') set({ draw: initialDrawState('line') });
      },

      escape() {
        const { draw, tool, editing, dimensionPicks } = get();
        if (editing) {
          set({ editing: null });
          return;
        }
        if (draw) {
          const r = toolEscape(draw);
          if (r.exit) set({ ...resetTool('select'), cursor: null });
          else set({ draw: r.state, message: null });
          return;
        }
        if (tool === 'dimension') {
          if (dimensionPicks.length > 0) set({ dimensionPicks: [] });
          else set({ ...resetTool('select'), cursor: null });
          return;
        }
        get().clearSelection();
      },

      dragStart(input) {
        const { tool, sketch } = get();
        if (tool !== 'select') return false;
        const item = hitTest(sketch.entities, input.at, input.tolerance);
        if (!item || item.kind === 'constraint' || isBuiltinItem(item)) return false;
        const idx = index();
        let mode: DragState['mode'] = 'curve';
        let point: PointRef | null = null;
        if (item.kind === 'point') point = item.ref;
        else if (idx.get(item.id)?.kind === 'point') point = { entity: item.id };
        let offset: Vec2 = [0, 0];
        let started: Promise<void> = Promise.resolve();
        if (point) {
          mode = 'point';
          const e = idx.get(point.entity)!;
          const at =
            e.kind === 'point'
              ? e.position
              : point.at === 'center'
                ? (e as { center: Vec2 }).center
                : point.at === 'end'
                  ? (e as { end: Vec2 }).end
                  : (e as { start: Vec2 }).start;
          offset = sub(at, input.at);
          const ref = point;
          // Start after any solve in flight, so the drag starts from solved geometry.
          started = inflight.then(() => solver.dragStart(sessionId(), ref));
        }
        drag = { item, before: sketch, grab: input.at, offset, moved: false, mode, started };
        set({ dragging: true, hovered: item });
        return true;
      },

      dragMove(input) {
        const d = drag;
        if (!d) return;
        d.moved = true;
        generation++; // a solve from before the drag must not land on top of it
        if (d.mode === 'point') {
          const target = add(input.at, d.offset);
          void d.started
            .then(() => solver.dragMove(sessionId(), target))
            .then((r) => {
              if (drag !== d || !r || r.status !== 'solved') return;
              const { sketch } = get();
              set({
                sketch: { ...sketch, entities: applyCoordinates(sketch.entities, r.coordinates) },
              });
            })
            .catch((e: unknown) =>
              set({ solverError: e instanceof Error ? e.message : String(e) }),
            );
          return;
        }
        // A curve: move it with the pointer and let the solver pull it back into its constraints.
        const delta = sub(input.at, d.grab);
        const id = d.item.kind === 'entity' ? d.item.id : null;
        const moved = moveCurve(d.before, id, delta, input.at, d.grab);
        curvePending = moved;
        const pump = async () => {
          while (curvePending && drag === d) {
            const sketch = curvePending;
            curvePending = null;
            const r = await solver.update(sessionId(), sketch, variables(), { analyze: false });
            if (drag === d && r.status === 'solved')
              set({ sketch: { ...sketch, entities: r.entities } });
          }
        };
        if (!curveBusy) {
          curveBusy = pump()
            .catch((e: unknown) => set({ solverError: e instanceof Error ? e.message : String(e) }))
            .finally(() => (curveBusy = null));
        }
      },

      dragEnd() {
        const d = drag;
        if (!d) return Promise.resolve();
        set({ dragging: false });
        if (d.moved) {
          // One undo step for the whole drag, recorded now so that an undo
          // pressed while the last solve is still running reverts the drag.
          undoStack.push(d.before);
          if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
          redoStack = [];
          set({ lastAdded: [], ...history() });
        }
        const gen = ++generation;
        const finish = async () => {
          if (d.mode === 'point') {
            await d.started.catch(() => undefined);
            try {
              const r = await solver.dragEnd(sessionId());
              if (gen === generation) accept(r);
            } catch (e) {
              set({ solverError: e instanceof Error ? e.message : String(e) });
            }
          } else {
            while (curveBusy) await curveBusy;
          }
          if (drag === d) drag = null;
          if (gen === generation) {
            if (d.moved) await resolve();
            else set({ solving: false });
          }
        };
        const p = finish();
        inflight = p;
        return p;
      },

      select(item, mode = 'replace') {
        const { selection } = get();
        if (!item) {
          if (mode === 'replace' && selection.length > 0) set({ selection: [] });
          return;
        }
        const key = itemKey(item);
        const present = selection.some((s) => itemKey(s) === key);
        if (mode === 'replace') set({ selection: [item] });
        else if (mode === 'add') {
          if (!present) set({ selection: [...selection, item] });
        } else {
          set({
            selection: present ? selection.filter((s) => itemKey(s) !== key) : [...selection, item],
          });
        }
      },

      clearSelection() {
        if (get().selection.length > 0) set({ selection: [] });
      },

      deleteSelection() {
        const { selection, sketch } = get();
        if (selection.length === 0) return;
        const entities = new Set<string>();
        const constraints = new Set<string>();
        const points: PointRef[] = [];
        for (const item of selection) {
          if (isBuiltinItem(item)) continue;
          if (item.kind === 'constraint') constraints.add(item.id);
          else if (item.kind === 'entity') entities.add(item.id);
          else if (item.ref.at === undefined) entities.add(item.ref.entity);
          else points.push(item.ref);
        }
        const touches = (c: SketchConstraint) =>
          Object.entries(c).some(([k, v]) => {
            if (k === 'id' || k === 'kind' || k === 'value' || k === 'at') return false;
            if (typeof v === 'string') return entities.has(v);
            if (v && typeof v === 'object' && 'entity' in v) {
              const ref = v as PointRef;
              return entities.has(ref.entity) || points.some((p) => sameRef(p, ref));
            }
            return false;
          });
        const next: SketchInput = {
          entities: sketch.entities.filter((e) => !entities.has(e.id)),
          constraints: sketch.constraints.filter((c) => !constraints.has(c.id) && !touches(c)),
        };
        set({ selection: [], hovered: null, editing: null });
        if (
          next.entities.length !== sketch.entities.length ||
          next.constraints.length !== sketch.constraints.length
        ) {
          edit(next);
        }
      },

      deleteConstraint(id) {
        const { selection, editing } = get();
        set({
          selection: selection.filter((s) => !(s.kind === 'constraint' && s.id === id)),
          editing: editing?.id === id ? null : editing,
        });
        removeConstraints(new Set([id]));
      },

      applyConstraint(kind) {
        const { selection } = get();
        const drafts = constraintsFromSelection(kind, selection, index());
        if (drafts.length === 0) {
          set({ message: 'Select what this constraint applies to first.' });
          return false;
        }
        addConstraints(drafts);
        set({ selection: [], message: null });
        return true;
      },

      openEditor(id) {
        const c = get().sketch.constraints.find((k) => k.id === id);
        if (c && isDimension(c)) set({ editing: { id, fresh: false } });
      },

      closeEditor() {
        set({ editing: null });
      },

      setDimensionValue(id, text) {
        const { sketch, source, editing } = get();
        const c = sketch.constraints.find((k) => k.id === id);
        if (!c || !isDimension(c) || !source) return { ok: false, message: 'No such dimension.' };
        const check = checkValue(text, c.kind, source.units, variables());
        if (!check.ok) return check;
        const fresh = editing?.id === id && editing.fresh;
        set({ editing: null });
        // Unchanged only when the text and both bare-number units are: an angle typed as `30`
        // under degrees and under radians are different values.
        if (
          check.expression.source === c.value.source &&
          check.expression.lengthUnit === c.value.lengthUnit &&
          check.expression.angleUnit === c.value.angleUnit
        ) {
          return check;
        }
        const next: SketchInput = {
          entities: sketch.entities,
          constraints: sketch.constraints.map((k) =>
            k.id === id
              ? ({ ...(k as DimensionalConstraint), value: check.expression } as SketchConstraint)
              : k,
          ),
        };
        // Typing the value of a dimension just placed is part of placing it: one undo step.
        edit(next, [id], !fresh);
        return check;
      },

      moveLabel(id, at) {
        set({ labels: { ...get().labels, [id]: at } });
      },

      undo() {
        const prev = undoStack.pop();
        if (!prev) return;
        redoStack.push(get().sketch);
        set({ sketch: prev, selection: [], editing: null, lastAdded: [], ...history() });
        void resolve();
      },

      redo() {
        const next = redoStack.pop();
        if (!next) return;
        undoStack.push(get().sketch);
        set({ sketch: next, selection: [], editing: null, lastAdded: [], ...history() });
        void resolve();
      },

      async idle() {
        for (;;) {
          const p = inflight;
          await p;
          if (curveBusy) await curveBusy;
          if (p === inflight && !curveBusy) return;
        }
      },
    };
  });
}

/**
 * The sketch with one curve dragged: the curve translated (a circle resized
 * from its rim), and every point joined to its ends carried along, so the
 * solve starts next to where the user wants the geometry, not across it.
 */
export function moveCurve(
  sketch: SketchInput,
  id: string | null,
  delta: Vec2,
  at: Vec2,
  grab: Vec2,
): SketchInput {
  const target = sketch.entities.find((e) => e.id === id);
  if (!target) return sketch;
  const joined = target.kind === 'circle' ? [] : joinedPoints(sketch.constraints, target);
  const entities = sketch.entities.map((e) => {
    if (e.id === id) return moveEntity(e, delta, at, grab);
    let next = e;
    for (const ref of joined) if (ref.entity === e.id) next = movePoint(next, ref.at, delta);
    return next;
  });
  return { entities, constraints: sketch.constraints };
}

/** Points of other entities joined (coincident or tangent at an end) to the entity's points. */
function joinedPoints(constraints: readonly SketchConstraint[], e: SketchEntity): PointRef[] {
  const key = (r: PointRef) => `${r.entity}.${r.at ?? ''}`;
  const own =
    e.kind === 'point'
      ? [{ entity: e.id }]
      : e.kind === 'line'
        ? [
            { entity: e.id, at: 'start' as const },
            { entity: e.id, at: 'end' as const },
          ]
        : [
            { entity: e.id, at: 'start' as const },
            { entity: e.id, at: 'end' as const },
            { entity: e.id, at: 'center' as const },
          ];
  const seen = new Set(own.map(key));
  const out: PointRef[] = [];
  const queue: PointRef[] = [...own];
  const pairs: [PointRef, PointRef][] = [];
  for (const c of constraints) {
    if (c.kind === 'coincident') pairs.push([c.a, c.b]);
    else if (c.kind === 'tangent' && c.at)
      pairs.push([
        { entity: c.a, at: c.at[0] },
        { entity: c.b, at: c.at[1] },
      ]);
  }
  while (queue.length > 0) {
    const r = queue.pop()!;
    for (const [a, b] of pairs) {
      const other = key(a) === key(r) ? b : key(b) === key(r) ? a : null;
      if (!other || seen.has(key(other))) continue;
      seen.add(key(other));
      if (other.entity !== e.id) out.push(other);
      queue.push(other);
    }
  }
  return out;
}

function movePoint(e: SketchEntity, at: PointRef['at'], delta: Vec2): SketchEntity {
  switch (e.kind) {
    case 'point':
      return at === undefined ? { ...e, position: add(e.position, delta) } : e;
    case 'line':
      if (at === 'start') return { ...e, start: add(e.start, delta) };
      if (at === 'end') return { ...e, end: add(e.end, delta) };
      return e;
    case 'circle':
      return at === 'center' ? { ...e, center: add(e.center, delta) } : e;
    case 'arc':
      // Moving one end of an arc off its circle is for the solver to mend.
      if (at === 'start') return { ...e, start: add(e.start, delta) };
      if (at === 'end') return { ...e, end: add(e.end, delta) };
      if (at === 'center') return { ...e, center: add(e.center, delta) };
      return e;
  }
}

/** An entity moved by a curve drag: translated, or a circle resized from its rim. */
function moveEntity(e: SketchEntity, delta: Vec2, at: Vec2, grab: Vec2): SketchEntity {
  switch (e.kind) {
    case 'point':
      return { ...e, position: add(e.position, delta) };
    case 'line':
      return { ...e, start: add(e.start, delta), end: add(e.end, delta) };
    case 'circle': {
      // Grabbed on the rim: the rim follows the pointer.
      const r = Math.max(1e-6, e.radius + distance(at, e.center) - distance(grab, e.center));
      return { ...e, radius: r };
    }
    case 'arc':
      return {
        ...e,
        center: add(e.center, delta),
        start: add(e.start, delta),
        end: add(e.end, delta),
      };
  }
}

/** Whether the drawing tool is in the middle of a shape. */
export function isDrawing(state: Pick<SketchSessionState, 'draw'>): boolean {
  return state.draw !== null && !isIdle(state.draw);
}
