// The Framing settings section of the Construction panel: the document's framing defaults (stud
// spacing and layout, plates, king studs, corners, blocking, plate splices, the lengths plates
// and precut studs come in), which every wall uses unless its wall type or the wall overrides
// them, and the user's header rules (`opening width up to X: header, jack studs`). A new document
// has no header rules and none are suggested (ADR 0015 decision 7). Each Save is one undo step.

import type { DisplayUnits, StoredExpression } from '@manufakture/core';
import {
  DEFAULT_WALL_SETTINGS,
  MAX_HEADER_RULES,
  type FramingSettings,
  type HeaderRuleData,
} from '@manufakture/domain-construction';
import { formatLength } from '@manufakture/units';
import { useState } from 'react';
import { useStore } from 'zustand';
import { lengthFormat } from '../../sketcher/values';
import type { DocumentStoreApi } from '../../state/document';
import { Select } from '../../wood/Select';
import { Field } from '../LevelsPanel';
import type { Outcome } from '../settings';
import { HeaderFields } from '../WallTypesEditor';
import {
  EMPTY_RULE,
  framingFormOf,
  framingOf,
  headerRuleFormOf,
  headerRulesOf,
  saveFraming,
  saveHeaderRules,
  type FramingForm,
  type HeaderRuleForm,
} from './framing';

const DEFAULT = ['', 'Default'] as const;

export function FramingSettingsPanel({
  documents,
  framing,
  headerRules,
  disabled,
  run,
}: {
  documents: DocumentStoreApi;
  framing: FramingSettings<StoredExpression>;
  headerRules: readonly HeaderRuleData<StoredExpression>[];
  disabled: boolean;
  run: (outcome: Outcome) => boolean;
}) {
  const units = useStore(documents, (s) => s.document.units);
  return (
    <section
      className="construction-section"
      aria-label="Framing settings"
      data-testid="framing-settings"
    >
      <details>
        <summary>
          <h3 className="construction-summary">Framing settings</h3>
        </summary>
        <p className="field-note">
          Document defaults: a wall type or a wall may override them. Empty fields use the defaults
          shown.
        </p>
        <FramingDefaults
          key={JSON.stringify(framing)}
          documents={documents}
          framing={framing}
          units={units}
          disabled={disabled}
          run={run}
        />
        <HeaderRulesEditor
          key={JSON.stringify(headerRules)}
          documents={documents}
          rules={headerRules}
          units={units}
          disabled={disabled}
          run={run}
        />
      </details>
    </section>
  );
}

function FramingDefaults({
  documents,
  framing,
  units,
  disabled,
  run,
}: {
  documents: DocumentStoreApi;
  framing: FramingSettings<StoredExpression>;
  units: DisplayUnits;
  disabled: boolean;
  run: (outcome: Outcome) => boolean;
}) {
  const initial = framingFormOf(framing);
  const [form, setForm] = useState<FramingForm>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const set = (patch: Partial<FramingForm>) => setForm((f) => ({ ...f, ...patch }));
  const fmt = (mm: number) => formatLength(mm, lengthFormat(units));
  const d = DEFAULT_WALL_SETTINGS;
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);
  const save = () => {
    const r = framingOf(form, units);
    if (!r.ok) {
      setErrors(r.errors);
      return;
    }
    setErrors({});
    run(saveFraming(documents.getState().document, r.value));
  };
  return (
    <div className="construction-form" data-testid="framing-defaults">
      <h4>Framing defaults</h4>
      <div className="construction-row">
        <Field
          label="Stud spacing"
          testId="framing-spacing"
          value={form.spacing}
          error={errors.spacing}
          placeholder={fmt(d.spacing)}
          onChange={(spacing) => set({ spacing })}
        />
        <Select
          label="Layout from"
          name="framing-layout-from"
          value={form.layoutFrom}
          options={[DEFAULT, ['start', 'The wall start'], ['end', 'The wall end']]}
          onChange={(v) => set({ layoutFrom: v as FramingForm['layoutFrom'] })}
        />
      </div>
      <Field
        label="Layout origin (first stud's centre from that end)"
        testId="framing-layout-origin"
        value={form.layoutOrigin}
        error={errors.layoutOrigin}
        placeholder={fmt(d.layoutOrigin)}
        onChange={(layoutOrigin) => set({ layoutOrigin })}
      />
      <div className="construction-row">
        <Select
          label="Bottom plates"
          name="framing-bottom-plates"
          value={form.bottomPlates}
          options={[DEFAULT, ['1', '1'], ['2', '2'], ['3', '3']]}
          onChange={(v) => set({ bottomPlates: v as FramingForm['bottomPlates'] })}
        />
        <Select
          label="Top plates"
          name="framing-top-plates"
          value={form.topPlates}
          options={[DEFAULT, ['1', '1'], ['2', '2'], ['3', '3']]}
          onChange={(v) => set({ topPlates: v as FramingForm['topPlates'] })}
        />
        <Select
          label="King studs"
          name="framing-kings"
          value={form.kings}
          options={[DEFAULT, ['1', '1'], ['2', '2'], ['3', '3'], ['4', '4']]}
          onChange={(v) => set({ kings: v as FramingForm['kings'] })}
        />
      </div>
      <p className="field-note">
        Defaults: {d.bottomPlates} bottom plate, {d.topPlates} top plates, {d.kings} king stud each
        side, two-stud corners, no blocking.
      </p>
      <Select
        label="Corners"
        name="framing-corners"
        value={form.cornerStyle}
        options={[
          DEFAULT,
          ['two-stud', 'Two-stud'],
          ['three-stud', 'Three-stud'],
          ['ladder', 'Ladder'],
        ]}
        onChange={(v) => set({ cornerStyle: v as FramingForm['cornerStyle'] })}
      />
      <Field
        label="Ladder spacing"
        testId="framing-ladder-spacing"
        value={form.ladderSpacing}
        error={errors.ladderSpacing}
        placeholder={fmt(d.ladderSpacing)}
        onChange={(ladderSpacing) => set({ ladderSpacing })}
      />
      <Select
        label="Blocking"
        name="framing-blocking"
        value={form.blocking}
        options={[
          DEFAULT,
          ['none', 'None'],
          ['mid-height', 'One row at mid-height'],
          ['heights', 'Rows at given heights'],
        ]}
        onChange={(v) => set({ blocking: v as FramingForm['blocking'] })}
      />
      {form.blocking === 'heights' && (
        <Field
          label="Blocking heights above the wall base (comma separated)"
          testId="framing-blocking-heights"
          value={form.heights}
          error={errors.heights}
          onChange={(heights) => set({ heights })}
        />
      )}
      <Field
        label="Least distance between plate splices"
        testId="framing-splice-offset"
        value={form.spliceOffset}
        error={errors.spliceOffset}
        placeholder={fmt(d.spliceOffset)}
        onChange={(spliceOffset) => set({ spliceOffset })}
      />
      <Field
        label="Plate stock lengths (comma separated)"
        testId="framing-plate-lengths"
        value={form.plateStockLengths}
        error={errors.plateStockLengths}
        placeholder={d.plateStockLengths.map(fmt).join(', ')}
        onChange={(plateStockLengths) => set({ plateStockLengths })}
      />
      <Field
        label="Precut stud lengths (comma separated)"
        testId="framing-precut-lengths"
        value={form.precutLengths}
        error={errors.precutLengths}
        placeholder={d.precutLengths.map(fmt).join(', ')}
        onChange={(precutLengths) => set({ precutLengths })}
      />
      <div className="dialog-buttons">
        <button
          type="button"
          className="primary"
          data-testid="framing-save"
          disabled={disabled || !dirty}
          onClick={save}
        >
          Save
        </button>
        <button
          type="button"
          data-testid="framing-reset"
          disabled={disabled || !dirty}
          onClick={() => {
            setForm(initial);
            setErrors({});
          }}
        >
          Revert
        </button>
      </div>
    </div>
  );
}

function HeaderRulesEditor({
  documents,
  rules,
  units,
  disabled,
  run,
}: {
  documents: DocumentStoreApi;
  rules: readonly HeaderRuleData<StoredExpression>[];
  units: DisplayUnits;
  disabled: boolean;
  run: (outcome: Outcome) => boolean;
}) {
  const initial = rules.map(headerRuleFormOf);
  const [rows, setRows] = useState<HeaderRuleForm[]>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const dirty = JSON.stringify(rows) !== JSON.stringify(initial);
  const setRow = (i: number, patch: Partial<HeaderRuleForm>) =>
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const save = () => {
    const r = headerRulesOf(rows, units);
    if (!r.ok) {
      setErrors(r.errors);
      return;
    }
    setErrors({});
    run(saveHeaderRules(documents.getState().document, r.value));
  };
  return (
    <div className="construction-form" data-testid="header-rules">
      <h4>Header rules</h4>
      <p className="field-note">
        Your table: an opening up to a width gets the header you set. An opening wider than every
        rule uses its wall type&apos;s default header. The sizes are yours to choose: manufakture
        does no structural calculation and ships no rules.
      </p>
      {rows.length === 0 && (
        <p className="field-note" data-testid="header-rules-empty">
          No header rules: every opening uses its wall type&apos;s default header.
        </p>
      )}
      <ol className="construction-list">
        {rows.map((row, i) => {
          const rowErrors: Record<string, string> = {};
          for (const k of ['stock', 'plies', 'jacks'] as const) {
            const e = errors[`${i}.${k}`];
            if (e) rowErrors[`header${k[0]!.toUpperCase()}${k.slice(1)}`] = e;
          }
          return (
            <li key={i} data-testid={`header-rule-${i + 1}`}>
              <Field
                label="Openings up to"
                testId={`header-rule-width-${i + 1}`}
                value={row.maxWidth}
                error={errors[`${i}.maxWidth`]}
                onChange={(maxWidth) => setRow(i, { maxWidth })}
              />
              <HeaderFields
                value={row}
                units={units}
                errors={rowErrors}
                prefix={`header-rule-${i + 1}`}
                legend="Header"
                onChange={(v) => setRow(i, v)}
              />
              <button
                type="button"
                data-testid={`header-rule-remove-${i + 1}`}
                disabled={disabled}
                onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}
              >
                Remove rule
              </button>
            </li>
          );
        })}
      </ol>
      {errors.form && <p className="field-error">{errors.form}</p>}
      <div className="dialog-buttons">
        <button
          type="button"
          data-testid="header-rule-add"
          disabled={disabled || rows.length >= MAX_HEADER_RULES}
          onClick={() => setRows((rs) => [...rs, { ...EMPTY_RULE }])}
        >
          Add rule
        </button>
        <button
          type="button"
          className="primary"
          data-testid="header-rules-save"
          disabled={disabled || !dirty}
          onClick={save}
        >
          Save rules
        </button>
      </div>
    </div>
  );
}
