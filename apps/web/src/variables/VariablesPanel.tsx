// The Variables panel: the document's variables table. Each variable has a name, an expression
// (which may read other variables), a type and its value in the display units, and lists where it
// is used. Adding, editing (renaming included) and deleting are one undo step each; a variable in
// use cannot simply be deleted, but its uses can take its current value first. Insert fit
// variables adds #fit_press, #fit_slip and #fit_sliding in one step (fits.ts). A variable may
// measure the model (`distance(...)`, #1202): its value is what the shown regen measured, read
// from the model store. The logic is in variables.ts.

import { useMemo, useState } from 'react';
import { measurementLookup as measureLookup, type Measurement } from '@manufakture/core';
import { useStore } from 'zustand';
import { ExpressionField } from '../components/ExpressionField';
import { createModelStore, type ModelStore } from '../model/model';
import type { DocumentStoreApi } from '../state/document';
import { featureItem, type SelectionStore } from '../state/selection';
import { insertFitVariables } from './fits';
import {
  VARIABLE_TYPES,
  checkDraft,
  configuredVariablesInfo,
  deleteCommand,
  draftOf,
  evaluateTable,
  inlineWarning,
  replaceWithValueCommand,
  tableValues,
  variableRows,
  type ConfiguredVariable,
  type UseRow,
  type VariableDraft,
  type VariableRow,
  type VariableType,
} from './variables';
import './variables.css';

export interface VariablesPanelProps {
  documents: DocumentStoreApi;
  /** Clicking a use selects its feature here, when given. */
  selection?: SelectionStore;
  /**
   * The print setup Insert fit variables takes its printer and nozzle from: the print
   * workspace's active setup. Absent: the document's first setup.
   */
  printSetupId?: string | undefined;
  /**
   * The regen model, whose measurements give variables that measure the model their values.
   * Absent: such variables show that they are measured at the next rebuild.
   */
  model?: ModelStore | undefined;
}

/** Stands in for an absent model: nothing measured. */
const NO_MODEL = createModelStore();
const NO_MEASUREMENTS: readonly Measurement[] = [];

interface Editing {
  /** The variable being edited, or null for a new one. */
  original: string | null;
  draft: VariableDraft;
  /** Save was pressed: show every problem, not only the live ones. */
  submitted: boolean;
  /** A command the store refused. */
  failure: string | null;
}

interface Blocked {
  name: string;
  message: string;
  uses: UseRow[];
  failure: string | null;
  /**
   * The configuration table configures the variable: replacing it with its value would delete
   * that parameter, so the user is warned (this text) and must confirm first.
   */
  warning: string | null;
}

export function VariablesPanel({ documents, selection, printSetupId, model }: VariablesPanelProps) {
  const doc = useStore(documents, (s) => s.document);
  const measured = useStore(model ?? NO_MODEL, (s) => s.measurements);
  const measurements = measured.length === 0 ? NO_MEASUREMENTS : measured;
  const table = useMemo(() => evaluateTable(doc.variables, measurements), [doc, measurements]);
  const rows = useMemo(() => variableRows(doc, table), [doc, table]);
  const configured = useMemo(() => configuredVariablesInfo(doc), [doc]);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [blocked, setBlocked] = useState<Blocked | null>(null);
  const [fitStatus, setFitStatus] = useState<{ ok: boolean; message: string } | null>(null);

  const insertFits = () => {
    const r = insertFitVariables(doc, printSetupId);
    const done = r.command ? documents.getState().execute(r.command, r.label) : null;
    setFitStatus(
      done && !done.ok
        ? { ok: false, message: done.error.message }
        : { ok: true, message: r.message },
    );
  };

  const startEdit = (name: string | null) => {
    setBlocked(null);
    setEditing({
      original: name,
      draft: draftOf(doc, name, measurements),
      submitted: false,
      failure: null,
    });
  };

  const remove = (name: string) => {
    const r = deleteCommand(doc, name);
    if (!r.ok) {
      setBlocked({
        name,
        message: r.message,
        uses: r.uses,
        failure: null,
        warning: inlineWarning(doc, name),
      });
      return;
    }
    setBlocked(null);
    documents.getState().execute(r.command, r.label);
  };

  const replaceAndDelete = (name: string) => {
    // A configured variable: the warning is shown with the button, which confirms it.
    const r = replaceWithValueCommand(doc, name, measurements);
    const done = r.ok ? documents.getState().execute(r.command, r.label) : null;
    if (!r.ok || (done && !done.ok)) {
      const failure = !r.ok ? r.message : done && !done.ok ? done.error.message : null;
      setBlocked((b) => (b ? { ...b, failure } : b));
      return;
    }
    setBlocked(null);
  };

  const selectFeature = (featureId: string) =>
    selection?.getState().select([featureItem(featureId)]);

  const editor = (e: Editing) => (
    <VariableEditor
      key={e.original ?? '(new)'}
      editing={e}
      documents={documents}
      measurements={measurements}
      onChange={setEditing}
      onDone={() => setEditing(null)}
      variables={tableValues(table, e.original ?? undefined)}
      names={doc.variables.map((v) => v.name).filter((n) => n !== e.original)}
    />
  );

  return (
    <aside className="selection-panel variables-panel" aria-label="Variables">
      <div className="variables-head">
        <h2>Variables</h2>
        <button
          type="button"
          data-testid="variable-add"
          disabled={editing !== null}
          onClick={() => startEdit(null)}
        >
          Add
        </button>
        <button
          type="button"
          data-testid="variable-insert-fits"
          disabled={editing !== null}
          title="Add #fit_press, #fit_slip and #fit_sliding: clearances for printed fits, from the print setup's printer and nozzle"
          onClick={insertFits}
        >
          Insert fit variables
        </button>
      </div>
      {fitStatus && (
        <p
          className={fitStatus.ok ? 'field-note' : 'field-error'}
          role="status"
          data-testid="variable-fits-status"
        >
          {fitStatus.message}
        </p>
      )}
      {rows.length === 0 && editing === null && (
        <p className="field-note">
          Name a value once and use it anywhere a number goes: type <code>#</code> and its name.
        </p>
      )}
      <ul className="variable-list" data-testid="variable-list">
        {rows.map((row) =>
          editing?.original === row.name ? (
            editor(editing)
          ) : (
            <VariableItem
              key={row.name}
              row={row}
              configured={configured.get(row.name) ?? null}
              busy={editing !== null}
              blocked={blocked?.name === row.name ? blocked : null}
              onEdit={() => startEdit(row.name)}
              onDelete={() => remove(row.name)}
              onReplace={() => replaceAndDelete(row.name)}
              onKeep={() => setBlocked(null)}
              onSelectUse={selection ? selectFeature : undefined}
            />
          ),
        )}
        {editing?.original === null && editor(editing)}
      </ul>
    </aside>
  );
}

function VariableItem({
  row,
  configured,
  busy,
  blocked,
  onEdit,
  onDelete,
  onReplace,
  onKeep,
  onSelectUse,
}: {
  row: VariableRow;
  configured: ConfiguredVariable | null;
  busy: boolean;
  blocked: Blocked | null;
  onEdit: () => void;
  onDelete: () => void;
  onReplace: () => void;
  onKeep: () => void;
  onSelectUse: ((featureId: string) => void) | undefined;
}) {
  const typeLabel = VARIABLE_TYPES.find(([t]) => t === row.type)?.[1];
  return (
    <li
      className={`variable-item${row.error ? ' failed' : ''}`}
      data-testid={`variable-${row.name}`}
      onDoubleClick={busy ? undefined : onEdit}
    >
      <div className="variable-main">
        <code className="variable-name">#{row.name}</code>
        <span className="variable-value" data-testid={`variable-${row.name}-value`}>
          {row.value ?? 'no value'}
        </span>
      </div>
      <div className="variable-sub">
        <span className="variable-source" title={row.source}>
          {row.source}
        </span>
        {configured?.parameter && (
          <span className="badge" title={`Configuration parameter ${configured.parameter}`}>
            Configured
          </span>
        )}
        {typeLabel && <span className="badge">{typeLabel}</span>}
      </div>
      {configured?.value && (
        <p className="variable-configured" data-testid={`variable-${row.name}-configured`}>
          In {configured.row}: {configured.value}
        </p>
      )}
      {row.error && (
        <p className="field-error" data-testid={`variable-${row.name}-error`}>
          {row.error}
        </p>
      )}
      {row.uses.length === 0 ? (
        <p className="variable-unused">Not used</p>
      ) : (
        <details className="variable-uses" data-testid={`variable-${row.name}-uses`}>
          <summary>
            Used in {row.uses.length} {row.uses.length === 1 ? 'place' : 'places'}
          </summary>
          <UseList uses={row.uses} onSelect={onSelectUse} />
        </details>
      )}
      <div className="variable-actions">
        <button type="button" disabled={busy} aria-label={`Edit #${row.name}`} onClick={onEdit}>
          Edit
        </button>
        <button type="button" disabled={busy} aria-label={`Delete #${row.name}`} onClick={onDelete}>
          Delete
        </button>
      </div>
      {blocked && (
        <div className="variable-blocked" role="alert" data-testid="variable-blocked">
          <p>{blocked.message}</p>
          <UseList uses={blocked.uses} onSelect={onSelectUse} />
          <p>Its uses can take its current value ({row.value ?? 'none'}) instead.</p>
          {blocked.warning && (
            <p className="variable-warning" data-testid="variable-inline-warning">
              {blocked.warning}
            </p>
          )}
          {blocked.failure && <p className="field-error">{blocked.failure}</p>}
          <div className="variable-actions">
            <button type="button" data-testid="variable-replace" onClick={onReplace}>
              {blocked.warning
                ? 'Replace with value, delete it and its parameter'
                : 'Replace with value and delete'}
            </button>
            <button type="button" onClick={onKeep}>
              Keep it
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

function UseList({
  uses,
  onSelect,
}: {
  uses: readonly UseRow[];
  onSelect: ((featureId: string) => void) | undefined;
}) {
  return (
    <ul className="variable-use-list">
      {uses.map((u) => (
        <li key={u.key}>
          {onSelect && u.featureId ? (
            <button type="button" className="link" onClick={() => onSelect(u.featureId!)}>
              {u.label}
            </button>
          ) : (
            u.label
          )}
        </li>
      ))}
    </ul>
  );
}

function VariableEditor({
  editing,
  documents,
  measurements,
  variables,
  names,
  onChange,
  onDone,
}: {
  editing: Editing;
  documents: DocumentStoreApi;
  measurements: readonly Measurement[];
  variables: ReturnType<typeof tableValues>;
  names: readonly string[];
  onChange: (e: Editing) => void;
  onDone: () => void;
}) {
  const doc = documents.getState().document;
  const { draft, original, submitted, failure } = editing;
  const check = checkDraft(doc, draft, original, measurements);
  const set = (patch: Partial<VariableDraft>) =>
    onChange({ ...editing, draft: { ...draft, ...patch }, failure: null });
  // Loops are shown as soon as they are typed; other problems the field shows itself, or on Save.
  const expressionError =
    failure ?? (!check.ok && (check.cycle || submitted) ? check.errors.expression : undefined);
  const nameError = !check.ok && (submitted || draft.name !== '') ? check.errors.name : undefined;

  const save = () => {
    if (!check.ok) {
      onChange({ ...editing, submitted: true });
      return;
    }
    if (check.command) {
      const r = documents.getState().execute(check.command, check.label);
      if (!r.ok) {
        onChange({ ...editing, submitted: true, failure: r.error.message });
        return;
      }
    }
    onDone();
  };

  return (
    <li className="variable-item editing" data-testid="variable-editor">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            onDone();
          }
        }}
      >
        <div className="dialog-field">
          <label>
            Name
            <input
              type="text"
              value={draft.name}
              spellCheck={false}
              autoComplete="off"
              // The editor opens on a click on Add or Edit: typing goes straight in.
              autoFocus
              aria-invalid={nameError !== undefined}
              data-testid="variable-name"
              onChange={(e) => set({ name: e.target.value })}
            />
          </label>
          {nameError && <span className="field-error">{nameError}</span>}
        </div>
        <div className="dialog-field">
          <label>
            Type
            <select
              value={draft.type}
              data-testid="variable-type"
              onChange={(e) => set({ type: e.target.value as VariableType })}
            >
              {VARIABLE_TYPES.map(([t, label]) => (
                <option key={t} value={t}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <ExpressionField
          label="Value"
          testId="variable-expression"
          value={draft.source}
          kind={draft.type}
          units={doc.units}
          variables={variables}
          names={names}
          error={expressionError}
          measure={measureLookup(measurements)}
          onChange={(source) => set({ source })}
        />
        <div className="dialog-buttons">
          <button type="submit" className="primary" data-testid="variable-save">
            {original === null ? 'Add' : 'Save'}
          </button>
          <button type="button" onClick={onDone}>
            Cancel
          </button>
        </div>
      </form>
    </li>
  );
}
