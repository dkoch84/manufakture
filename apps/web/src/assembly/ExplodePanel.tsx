// The Explode panel (M4 plan, T4.5a): an assembly's exploded views, each a list of steps that move
// instances along a direction by a distance, shown in the view while the panel is open. A slider
// plays the steps from assembled to exploded. A step is added here (instances ticked or taken
// from the selection, an axis, a distance expression), or by dragging an instance in the view
// along the axis. Steps can be reordered, their distances edited as expressions, and deleted;
// every change is one undoable command. Nothing here changes a solved pose.

import type { Command } from '@manufakture/core';
import type { AssemblyResult } from '@manufakture/regen';
import { useMemo, useState } from 'react';
import { useStore } from 'zustand';
import { ExpressionField } from '../components/ExpressionField';
import { checkExpression } from '../features/forms';
import { evaluateVariables } from '../sketcher/values';
import type { DocumentStoreApi } from '../state/document';
import { isGeometryRef, type SelectionStore } from '../state/selection';
import { fitsFirst } from '../variables/fits';
import { instanceOf } from './assembly';
import {
  EXPLODE_AXES,
  addExplodedViewCommand,
  addStepCommand,
  axisVector,
  deleteStepCommand,
  moveStepCommand,
  resolvedView,
  shownExplodedView,
  stepDistanceCommand,
  stepRows,
  type ExplodeAxis,
} from './explode';
import type { AssemblyUiStore } from './state';

export interface ExplodePanelProps {
  documents: DocumentStoreApi;
  assemblyId: string;
  assemblyUi: AssemblyUiStore;
  /** The last regen's result for the assembly (resolved steps and their warnings). */
  result: AssemblyResult | undefined;
  /** The view's selection: "Use selection" ticks the instances picked there. */
  selection?: SelectionStore;
  onClose: () => void;
}

const AXIS_LABELS: Record<ExplodeAxis, string> = {
  '+x': '+X',
  '-x': '-X',
  '+y': '+Y',
  '-y': '-Y',
  '+z': '+Z',
  '-z': '-Z',
};

export function ExplodePanel({
  documents,
  assemblyId,
  assemblyUi,
  result,
  selection,
  onClose,
}: ExplodePanelProps) {
  const doc = useStore(documents, (s) => s.document);
  const ui = useStore(assemblyUi, (s) => s.explode);
  const variables = useMemo(() => evaluateVariables(doc), [doc]);
  const [distance, setDistance] = useState('50');
  const [distanceError, setDistanceError] = useState<string | undefined>(undefined);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [editErrors, setEditErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);

  const assembly = doc.assemblies.find((a) => a.id === assemblyId);
  if (!assembly) return null;
  const view = shownExplodedView(assembly, ui.viewId);
  const rows = view ? stepRows(assembly, view, resolvedView(result, view.id)) : [];
  const checked = ui.checked.filter((id) => assembly.instances.some((x) => x.id === id));
  const set = assemblyUi.getState().setExplode;

  const run = (command: Command, label: string) => {
    const r = documents.getState().execute(command, label);
    setMessage(r.ok ? null : r.error.message);
    return r.ok;
  };

  const addView = () => {
    const { command, label, id } = addExplodedViewCommand(assembly);
    if (run(command, label)) set({ viewId: id, progress: 1 });
  };

  const addStep = () => {
    if (!view) return;
    if (checked.length === 0) {
      setMessage('Tick the instances the step moves, or drag one in the view.');
      return;
    }
    const r = checkExpression(distance, 'length', doc.units, variables);
    if (!r.ok) {
      setDistanceError(r.message);
      return;
    }
    setDistanceError(undefined);
    const { command, label } = addStepCommand(
      assembly,
      view,
      checked,
      { vector: axisVector(ui.axis) },
      r.expression,
    );
    if (run(command, label)) set({ progress: 1 });
  };

  const commitDistance = (stepId: string) => {
    const text = edits[stepId];
    const step = view?.steps.find((s) => s.id === stepId);
    if (!view || !step || text === undefined || text.trim() === step.distance.source) {
      setEdits((e) => without(e, stepId));
      return;
    }
    const r = checkExpression(text, 'length', doc.units, variables);
    if (!r.ok) {
      setEditErrors((e) => ({ ...e, [stepId]: r.message }));
      return;
    }
    const { command, label } = stepDistanceCommand(assembly, view, step, r.expression);
    if (run(command, label)) {
      setEdits((e) => without(e, stepId));
      setEditErrors((e) => without(e, stepId));
    }
  };

  const useSelection = () => {
    const picked = new Set<string>();
    for (const item of selection?.getState().selected ?? []) {
      if (!isGeometryRef(item)) continue;
      const id = instanceOf(item.bodyId, assemblyId);
      if (id !== null) picked.add(id);
    }
    const ids = assembly.instances.filter((x) => picked.has(x.id)).map((x) => x.id);
    set({ checked: ids });
    setMessage(ids.length === 0 ? 'Nothing of this assembly is selected in the view.' : null);
  };

  const toggle = (id: string) =>
    set({
      checked: checked.includes(id)
        ? checked.filter((x) => x !== id)
        : assembly.instances.filter((x) => x.id === id || checked.includes(x.id)).map((x) => x.id),
    });

  return (
    <aside
      className="selection-panel feature-dialog explode-panel"
      aria-label="Explode"
      data-testid="explode-panel"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          onClose();
        }
      }}
    >
      <h2>Explode</h2>
      <div className="explode-views">
        {view && (
          <label className="dialog-field">
            Exploded view
            <select
              value={view.id}
              data-testid="explode-view"
              onChange={(e) => set({ viewId: e.target.value })}
            >
              {(assembly.explodedViews ?? []).map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <button type="button" data-testid="explode-new" onClick={addView}>
          New exploded view
        </button>
        {view && (
          <button
            type="button"
            data-testid="explode-delete-view"
            onClick={() =>
              run(
                { type: 'deleteExplodedView', assemblyId, explodedViewId: view.id },
                `Delete ${view.name}`,
              )
            }
          >
            Delete view
          </button>
        )}
      </div>
      {!view ? (
        <p className="field-note" data-testid="explode-empty">
          No exploded view yet. <strong>New exploded view</strong>, then add steps that move
          instances apart. The assembly itself does not move.
        </p>
      ) : (
        <>
          <label className="dialog-field explode-slider">
            <span>
              Assembled to exploded:{' '}
              <output data-testid="explode-progress-value">{Math.round(ui.progress * 100)}%</output>
            </span>
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={Math.round(ui.progress * 100)}
              data-testid="explode-progress"
              aria-label="Assembled to exploded"
              onChange={(e) => set({ progress: Number(e.target.value) / 100 })}
            />
          </label>
          <h3>Steps</h3>
          {rows.length === 0 ? (
            <p className="field-note">No steps yet: add one below.</p>
          ) : (
            <ol className="assembly-list explode-steps" data-testid="explode-steps">
              {rows.map((row) => (
                <li
                  key={row.step.id}
                  className={row.warnings.length > 0 ? 'error' : ''}
                  data-testid={`explode-step-${row.step.id}`}
                >
                  <span className="assembly-item-name">
                    {row.index + 1}. {row.names.join(', ')}
                  </span>
                  <span
                    className="assembly-item-source"
                    data-testid={`explode-step-direction-${row.step.id}`}
                  >
                    {row.direction}
                  </span>
                  <ExpressionField
                    ariaLabel={`Distance of step ${row.index + 1}`}
                    variant="compact"
                    value={edits[row.step.id] ?? row.step.distance.source}
                    onChange={(v) => setEdits((e) => ({ ...e, [row.step.id]: v }))}
                    onBlur={() => commitDistance(row.step.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        commitDistance(row.step.id);
                      }
                    }}
                    kind="length"
                    units={doc.units}
                    variables={variables}
                    names={fitsFirst(Object.keys(variables))}
                    error={editErrors[row.step.id]}
                    testId={`explode-step-distance-${row.step.id}`}
                  />
                  {row.warnings.map((w) => (
                    <span key={w} className="assembly-item-message" role="note">
                      {w}
                    </span>
                  ))}
                  <span className="assembly-item-actions">
                    <button
                      type="button"
                      disabled={row.index === 0}
                      data-testid={`explode-step-up-${row.step.id}`}
                      onClick={() => {
                        const m = moveStepCommand(assembly, view, row.step.id, -1);
                        if (m) run(m.command, m.label);
                      }}
                    >
                      Up
                    </button>
                    <button
                      type="button"
                      disabled={row.index === rows.length - 1}
                      data-testid={`explode-step-down-${row.step.id}`}
                      onClick={() => {
                        const m = moveStepCommand(assembly, view, row.step.id, 1);
                        if (m) run(m.command, m.label);
                      }}
                    >
                      Down
                    </button>
                    <button
                      type="button"
                      data-testid={`explode-step-delete-${row.step.id}`}
                      onClick={() => {
                        const d = deleteStepCommand(assembly, view, row.step.id);
                        run(d.command, d.label);
                      }}
                    >
                      Delete
                    </button>
                  </span>
                </li>
              ))}
            </ol>
          )}
          <fieldset className="dialog-field explode-new-step">
            <legend>New step</legend>
            <div className="explode-instances" role="group" aria-label="Instances it moves">
              {assembly.instances.map((x) => (
                <label key={x.id}>
                  <input
                    type="checkbox"
                    checked={checked.includes(x.id)}
                    data-testid={`explode-instance-${x.id}`}
                    onChange={() => toggle(x.id)}
                  />{' '}
                  {x.name}
                </label>
              ))}
            </div>
            {selection && (
              <button type="button" data-testid="explode-use-selection" onClick={useSelection}>
                Use selection
              </button>
            )}
            <label className="dialog-field">
              Along
              <select
                value={ui.axis}
                data-testid="explode-axis"
                onChange={(e) => set({ axis: e.target.value as ExplodeAxis })}
              >
                {EXPLODE_AXES.map((a) => (
                  <option key={a} value={a}>
                    {AXIS_LABELS[a]}
                  </option>
                ))}
              </select>
            </label>
            <ExpressionField
              label="Distance"
              value={distance}
              onChange={(v) => {
                setDistance(v);
                setDistanceError(undefined);
              }}
              kind="length"
              units={doc.units}
              variables={variables}
              names={fitsFirst(Object.keys(variables))}
              error={distanceError}
              testId="explode-distance"
            />
            <button
              type="button"
              className="primary"
              data-testid="explode-add-step"
              onClick={addStep}
            >
              Add step
            </button>
            <p className="field-note">
              Or drag an instance in the view: it moves the ticked instances (or the one dragged)
              along the axis, and adds the step when you let go.
            </p>
          </fieldset>
        </>
      )}
      {message && (
        <p className="field-error" role="alert" data-testid="explode-message">
          {message}
        </p>
      )}
      <div className="dialog-buttons">
        <button type="button" data-testid="explode-close" onClick={onClose}>
          Done
        </button>
      </div>
    </aside>
  );
}

/** `record` without `key`. */
function without(record: Record<string, string>, key: string): Record<string, string> {
  const out = { ...record };
  delete out[key];
  return out;
}
