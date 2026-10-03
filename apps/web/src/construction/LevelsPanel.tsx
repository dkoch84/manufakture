// The Levels section of the Construction panel: add a level, rename it, set its elevation and
// default wall height (constants: `8'`, `2.4m`), and choose the level the Wall tool draws on.
// Each Save is one undo step.

import type { DisplayUnits, ManufaktureDocument } from '@manufakture/core';
import type { StoredLevel } from '@manufakture/domain-construction';
import { useState } from 'react';
import { useStore } from 'zustand';
import type { DocumentStoreApi } from '../state/document';
import { checkLength } from './lengths';
import { addLevel, editLevel, type Outcome } from './settings';
import type { ConstructionUiStore } from './state';

export function LevelsPanel({
  documents,
  ui,
  levels,
  disabled,
  run,
}: {
  documents: DocumentStoreApi;
  ui: ConstructionUiStore;
  levels: readonly StoredLevel[];
  disabled: boolean;
  run: (outcome: Outcome) => boolean;
}) {
  const units = useStore(documents, (s) => s.document.units);
  const active = useStore(ui, (s) => s.level) ?? levels[0]?.id ?? null;
  return (
    <section className="construction-section" aria-label="Levels" data-testid="levels-panel">
      <h3>Levels</h3>
      <ul className="construction-list">
        {levels.map((level) => (
          <li key={level.id} data-testid={`level-${level.id}`}>
            <LevelRow
              key={JSON.stringify(level)}
              documents={documents}
              level={level}
              units={units}
              active={active === level.id}
              disabled={disabled}
              onActivate={() => ui.getState().setLevel(level.id)}
              run={run}
            />
          </li>
        ))}
      </ul>
      <button
        type="button"
        data-testid="level-add"
        disabled={disabled}
        onClick={() => run(addLevel(documents.getState().document))}
      >
        Add level
      </button>
    </section>
  );
}

function LevelRow({
  documents,
  level,
  units,
  active,
  disabled,
  onActivate,
  run,
}: {
  documents: DocumentStoreApi;
  level: StoredLevel;
  units: DisplayUnits;
  active: boolean;
  disabled: boolean;
  onActivate: () => void;
  run: (outcome: Outcome) => boolean;
}) {
  const [name, setName] = useState(level.name);
  const [elevation, setElevation] = useState(level.elevation.source);
  const [height, setHeight] = useState(level.height.source);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const dirty =
    name !== level.name || elevation !== level.elevation.source || height !== level.height.source;

  const save = () => {
    const errs: Record<string, string> = {};
    const e = checkLength(elevation, units, {}, { sign: 'any', constant: true });
    const h = checkLength(height, units, {}, { constant: true });
    if (!e.ok) errs.elevation = e.message;
    if (!h.ok) errs.height = h.message;
    if (name.trim() === '') errs.name = 'Give the level a name.';
    setErrors(errs);
    if (Object.keys(errs).length > 0 || !e.ok || !h.ok) return;
    // One undo step per field changed, in order: name, elevation, height.
    let doc: ManufaktureDocument = documents.getState().document;
    if (name !== level.name && !run(editLevel(doc, level.id, { field: 'name', value: name }))) {
      return;
    }
    doc = documents.getState().document;
    if (
      elevation !== level.elevation.source &&
      !run(editLevel(doc, level.id, { field: 'elevation', value: e.expression }))
    ) {
      return;
    }
    doc = documents.getState().document;
    if (height !== level.height.source) {
      run(editLevel(doc, level.id, { field: 'height', value: h.expression }));
    }
  };

  return (
    <div className="level-row">
      <label className="dialog-check">
        <input
          type="radio"
          name="active-level"
          checked={active}
          data-testid={`level-active-${level.id}`}
          onChange={onActivate}
        />
        Draw here
      </label>
      <Field
        label="Name"
        testId={`level-name-${level.id}`}
        value={name}
        error={errors.name}
        onChange={setName}
      />
      <Field
        label="Elevation"
        testId={`level-elevation-${level.id}`}
        value={elevation}
        error={errors.elevation}
        onChange={setElevation}
      />
      <Field
        label="Wall height"
        testId={`level-height-${level.id}`}
        value={height}
        error={errors.height}
        onChange={setHeight}
      />
      <button
        type="button"
        data-testid={`level-save-${level.id}`}
        disabled={disabled || !dirty}
        onClick={save}
      >
        Save
      </button>
    </div>
  );
}

/** A plain labelled text field with its error under it. */
export function Field({
  label,
  testId,
  value,
  error,
  placeholder,
  onChange,
}: {
  label: string;
  testId: string;
  value: string;
  error?: string | undefined;
  placeholder?: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="dialog-field">
      <label>
        {label}
        <input
          type="text"
          value={value}
          maxLength={200}
          placeholder={placeholder}
          data-testid={testId}
          aria-invalid={error !== undefined}
          onChange={(e) => onChange(e.target.value)}
        />
      </label>
      {error && (
        <span className="field-error" data-testid={`${testId}-error`}>
          {error}
        </span>
      )}
    </div>
  );
}
