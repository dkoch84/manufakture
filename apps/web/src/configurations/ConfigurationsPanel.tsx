// The Configurations panel, beside Variables: the document's configuration table. Parameters
// are the columns (a variable whose expression a row overrides, or a feature a row suppresses
// or not); each configuration is a row with a name and a value per parameter, and an empty
// value keeps the document's own. Every edit is one undo step. Which row is shown is chosen
// here or in the toolbar's switcher. The logic is in configurations.ts.

import { useMemo, useState, type KeyboardEvent } from 'react';
import { useStore } from 'zustand';
import type { ConfigRow, DisplayUnits } from '@manufakture/core';
import { ExpressionField } from '../components/ExpressionField';
import type { Analysis } from '../components/expression';
import type { DocumentStoreApi } from '../state/document';
import {
  addParameter,
  addRow,
  cellExpression,
  cellFlag,
  cellSource,
  deleteParameter,
  deleteRow,
  keepUnits,
  nameProblem,
  parameterCandidates,
  parameterColumns,
  renameParameter,
  renameRow,
  rowVariables,
  setActive,
  setCell,
  type Edit,
  type ParameterColumn,
} from './configurations';
import './configurations.css';

export interface ConfigurationsPanelProps {
  documents: DocumentStoreApi;
  /** Why the active row could not be applied (the model says), if it could not. */
  configurationError?: string | null;
  /** Nothing can be changed (a dialog or an export is open). */
  disabled?: boolean;
}

export function ConfigurationsPanel({
  documents,
  configurationError = null,
  disabled = false,
}: ConfigurationsPanelProps) {
  const doc = useStore(documents, (s) => s.document);
  const partId = useStore(documents, (s) => s.activePartId);
  const columns = useMemo(() => parameterColumns(doc), [doc]);
  const candidates = useMemo(() => parameterCandidates(doc, partId), [doc, partId]);
  const rows = doc.configurations?.rows ?? [];
  const active = doc.configurations?.active ?? null;
  const [failure, setFailure] = useState<string | null>(null);

  const run = (edit: Edit | null): boolean => {
    if (!edit) return true;
    const r = documents.getState().execute(edit.command, edit.label);
    setFailure(r.ok ? null : r.error.message);
    return r.ok;
  };

  return (
    <aside className="selection-panel configurations-panel" aria-label="Configurations">
      <div className="variables-head">
        <h2>Configurations</h2>
        <button
          type="button"
          data-testid="config-add-row"
          disabled={disabled}
          onClick={() => run(addRow(documents.getState().document))}
        >
          Add
        </button>
      </div>
      {columns.length === 0 && rows.length === 0 && (
        <p className="field-note">
          Variants of this design: add parameters (variables, or features to suppress), then a
          configuration per variant with its values.
        </p>
      )}
      {configurationError && (
        <p className="field-error" role="alert" data-testid="config-model-error">
          {configurationError}
        </p>
      )}
      {failure && (
        <p className="field-error" role="alert" data-testid="config-failure">
          {failure}
        </p>
      )}
      <section aria-label="Parameters" className="config-section">
        <h3>Parameters</h3>
        <ul className="config-list" data-testid="config-parameters">
          {columns.map((c) => (
            <li
              key={c.parameter.id}
              className="config-param"
              data-testid={`config-param-${c.parameter.id}`}
            >
              <NameField
                key={c.parameter.name}
                name={c.parameter.name}
                label={`Name of parameter ${c.parameter.name}`}
                disabled={disabled}
                problem={(n) =>
                  nameProblem(documents.getState().document, n, 'parameter', c.parameter.id)
                }
                onCommit={(n) =>
                  run(renameParameter(documents.getState().document, c.parameter.id, n))
                }
              />
              <span className="config-target" title={c.missing ? 'Not found' : undefined}>
                {c.target}
              </span>
              <button
                type="button"
                className="config-delete"
                disabled={disabled}
                aria-label={`Delete parameter ${c.parameter.name}`}
                onClick={() => run(deleteParameter(documents.getState().document, c.parameter.id))}
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
        <label className="config-add-parameter">
          Add parameter
          <select
            value=""
            disabled={disabled || candidates.length === 0}
            data-testid="config-add-parameter"
            onChange={(e) => {
              const c = candidates.find((x) => x.key === e.target.value);
              if (c) run(addParameter(documents.getState().document, c));
            }}
          >
            <option value="">{candidates.length === 0 ? 'Nothing to add' : 'Choose...'}</option>
            {candidates.some((c) => c.kind === 'variable') && (
              <optgroup label="Variables">
                {candidates
                  .filter((c) => c.kind === 'variable')
                  .map((c) => (
                    <option key={c.key} value={c.key}>
                      {c.label}
                    </option>
                  ))}
              </optgroup>
            )}
            {candidates.some((c) => c.kind === 'suppression') && (
              <optgroup label="Features">
                {candidates
                  .filter((c) => c.kind === 'suppression')
                  .map((c) => (
                    <option key={c.key} value={c.key}>
                      {c.label}
                    </option>
                  ))}
              </optgroup>
            )}
          </select>
        </label>
      </section>
      <ul className="config-list config-rows" data-testid="config-rows">
        {rows.map((row) => (
          <RowItem
            key={row.id}
            row={row}
            columns={columns}
            active={row.id === active}
            disabled={disabled}
            documents={documents}
            units={doc.units}
            run={run}
          />
        ))}
      </ul>
    </aside>
  );
}

function RowItem({
  row,
  columns,
  active,
  disabled,
  documents,
  units,
  run,
}: {
  row: ConfigRow;
  columns: readonly ParameterColumn[];
  active: boolean;
  disabled: boolean;
  documents: DocumentStoreApi;
  units: DisplayUnits;
  run: (edit: Edit | null) => boolean;
}) {
  const doc = () => documents.getState().document;
  return (
    <li
      className={`config-row${active ? ' active' : ''}`}
      data-testid={`config-row-${row.id}`}
      aria-current={active ? 'true' : undefined}
    >
      <div className="config-row-head">
        <NameField
          key={row.name}
          name={row.name}
          label={`Name of configuration ${row.name}`}
          disabled={disabled}
          problem={(n) => nameProblem(doc(), n, 'row', row.id)}
          onCommit={(n) => run(renameRow(doc(), row.id, n))}
        />
        {active ? (
          <span className="badge" data-testid={`config-row-${row.id}-shown`}>
            Shown
          </span>
        ) : (
          <button
            type="button"
            disabled={disabled}
            aria-label={`Show ${row.name}`}
            onClick={() => run(setActive(doc(), row.id))}
          >
            Show
          </button>
        )}
        <button
          type="button"
          className="config-delete"
          disabled={disabled}
          aria-label={`Delete configuration ${row.name}`}
          onClick={() => run(deleteRow(doc(), row.id))}
        >
          Delete
        </button>
      </div>
      {columns.map((c) =>
        c.parameter.kind === 'variable' ? (
          <VariableCell
            key={`${c.parameter.id}:${cellSource(row, c.parameter.id)}`}
            row={row}
            column={c}
            variable={c.parameter.variable}
            documents={documents}
            units={units}
            run={run}
          />
        ) : (
          <label key={c.parameter.id} className="config-cell">
            <span className="config-cell-name">{c.parameter.name}</span>
            <select
              value={flagValue(cellFlag(row, c.parameter.id))}
              disabled={disabled}
              aria-label={`${c.parameter.name} in ${row.name}`}
              data-testid={`config-cell-${row.id}-${c.parameter.id}`}
              onChange={(e) => {
                const v = e.target.value;
                run(setCell(doc(), row.id, c.parameter.id, v === '' ? null : v === 'on'));
              }}
            >
              <option value="">As modelled ({c.base ? 'suppressed' : 'active'})</option>
              <option value="on">Suppressed</option>
              <option value="off">Not suppressed</option>
            </select>
          </label>
        ),
      )}
    </li>
  );
}

function flagValue(flag: boolean | undefined): string {
  return flag === undefined ? '' : flag ? 'on' : 'off';
}

function VariableCell({
  row,
  column,
  variable,
  documents,
  units,
  run,
}: {
  row: ConfigRow;
  column: ParameterColumn;
  variable: string;
  documents: DocumentStoreApi;
  units: DisplayUnits;
  run: (edit: Edit | null) => boolean;
}) {
  const id = column.parameter.id;
  const stored = cellSource(row, id);
  const [draft, setDraft] = useState(stored);
  const [error, setError] = useState<string | undefined>(undefined);
  const doc = documents.getState().document;
  const variables = useMemo(() => rowVariables(doc, row.id, variable), [doc, row.id, variable]);
  const commit = (analysis: Analysis) => {
    if (draft === stored) return;
    const now = documents.getState().document;
    if (analysis.state === 'empty') {
      if (!run(setCell(now, row.id, id, null))) setError('Could not clear the value.');
      return;
    }
    if (analysis.state === 'error') return;
    const old = now.configurations?.rows.find((r) => r.id === row.id)?.values[id];
    const typed = cellExpression(draft, column.kind, units, variables);
    const edit = setCell(now, row.id, id, keepUnits(old, typed));
    if (!run(edit)) setError('This value was refused: see the message above.');
  };
  return (
    <div className="config-cell">
      <ExpressionField
        label={column.parameter.name}
        testId={`config-cell-${row.id}-${id}`}
        value={draft}
        kind={column.kind}
        units={units}
        variables={variables}
        error={error}
        onChange={(v) => {
          setError(undefined);
          setDraft(v);
        }}
        onBlur={(_e, analysis) => commit(analysis)}
        onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            e.currentTarget.blur();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            setDraft(stored);
            setError(undefined);
          }
        }}
      />
      {draft === '' && (
        <span className="field-note config-base">As modelled: {String(column.base)}</span>
      )}
    </div>
  );
}

function NameField({
  name,
  label,
  disabled,
  problem,
  onCommit,
}: {
  name: string;
  label: string;
  disabled: boolean;
  problem: (name: string) => string | null;
  onCommit: (name: string) => boolean;
}) {
  const [text, setText] = useState(name);
  const error = text === name ? null : problem(text);
  const commit = () => {
    if (text === name) return;
    if (error) return;
    if (!onCommit(text)) setText(name);
  };
  return (
    <span className="config-name">
      <input
        type="text"
        value={text}
        aria-label={label}
        aria-invalid={error !== null}
        disabled={disabled}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            setText(name);
          }
        }}
      />
      {error && <span className="field-error">{error}</span>}
    </span>
  );
}
