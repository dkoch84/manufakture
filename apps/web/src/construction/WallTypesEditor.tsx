// The Wall types section of the Construction panel: a wall type is a layer stack, outside to
// inside (siding, sheathing, the stud layer, drywall), each layer's stock chosen with the M4 stock
// picker (studs from lumber, the other layers from sheet goods), and the stud layer's spacing,
// plates and default header. A new wall type asks for its default header (ADR 0015 decision 7):
// no stock, ply or jack count is filled in for the user. Saving a type is one undo step, and
// keeps its walls building (a wall makes layer bodies only while its type has sheet layers).

import type { DisplayUnits, StoredExpression } from '@manufakture/core';
import type { FramingLayer, HeaderData, WallLayer } from '@manufakture/domain-construction';
import { findStock } from '@manufakture/stock';
import { useState } from 'react';
import { useStore } from 'zustand';
import type { DocumentStoreApi } from '../state/document';
import { documentRegion } from '../wood/catalog';
import { Select } from '../wood/Select';
import { StockPicker } from '../wood/StockPicker';
import { omit } from './kinds';
import { Field } from './LevelsPanel';
import { checkLength } from './lengths';
import {
  addWallType,
  editWallType,
  withLayer,
  withLayerChanged,
  withoutLayer,
  type Outcome,
  type StoredWallType,
} from './settings';

const LAYER_LABELS: Record<WallLayer['kind'], string> = {
  siding: 'Siding',
  sheathing: 'Sheathing',
  framing: 'Studs',
  drywall: 'Drywall',
};

const COUNTS = [
  ['1', '1'],
  ['2', '2'],
  ['3', '3'],
  ['4', '4'],
] as const;

const CHOOSE = ['', 'Choose'] as const;

export function WallTypesEditor({
  documents,
  types,
  disabled,
  run,
}: {
  documents: DocumentStoreApi;
  types: readonly StoredWallType[];
  disabled: boolean;
  run: (outcome: Outcome) => boolean;
}) {
  const units = useStore(documents, (s) => s.document.units);
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const edited = types.find((t) => t.id === editing);
  return (
    <section className="construction-section" aria-label="Wall types" data-testid="wall-types">
      <h3>Wall types</h3>
      {types.length === 0 && !adding && (
        <p className="field-note">
          No wall types yet. A wall type is the layers a wall is built of.
        </p>
      )}
      <ul className="construction-list">
        {types.map((t) => (
          <li key={t.id} data-testid={`wall-type-${t.id}`}>
            <span>{t.name}</span>{' '}
            <span className="field-note">
              {t.layers.map((l) => stockName(l.stock) ?? LAYER_LABELS[l.kind]).join(' | ')}
            </span>{' '}
            <button
              type="button"
              data-testid={`wall-type-edit-${t.id}`}
              disabled={disabled || editing !== null || adding}
              onClick={() => setEditing(t.id)}
            >
              Edit
            </button>
          </li>
        ))}
      </ul>
      {edited && (
        <WallTypeForm
          key={`${edited.id}/${JSON.stringify(edited)}`}
          type={edited}
          units={units}
          onSave={(next) => {
            if (
              run(
                editWallType(
                  documents.getState().document,
                  next,
                  `Edit the ${next.name} wall type`,
                ),
              )
            ) {
              setEditing(null);
            }
          }}
          onCancel={() => setEditing(null)}
        />
      )}
      {adding ? (
        <NewWallTypeForm
          units={units}
          onCreate={(input) => {
            const r = addWallType(documents.getState().document, input);
            if (run(r)) setAdding(false);
          }}
          onCancel={() => setAdding(false)}
        />
      ) : (
        <button
          type="button"
          data-testid="wall-type-new"
          disabled={disabled || editing !== null}
          onClick={() => setAdding(true)}
        >
          New wall type
        </button>
      )}
    </section>
  );
}

function stockName(id: string | undefined): string | undefined {
  return id === undefined ? undefined : (findStock(id)?.name ?? id);
}

/** The default header's fields, every one chosen by the user. */
function HeaderFields({
  value,
  units,
  errors,
  prefix,
  onChange,
}: {
  value: { stock: string; plies: string; jacks: string };
  units: DisplayUnits;
  errors: Record<string, string>;
  prefix: string;
  onChange: (v: { stock: string; plies: string; jacks: string }) => void;
}) {
  return (
    <fieldset className="construction-header">
      <legend>Default header (used when no header rule covers an opening)</legend>
      <StockPicker
        value={value.stock}
        units={units}
        only="lumber"
        label="Header stock"
        testId={`${prefix}-header-stock`}
        error={errors.headerStock}
        onChange={(stock) => onChange({ ...value, stock })}
      />
      <Select
        label="Plies"
        name={`${prefix}-header-plies`}
        value={value.plies}
        options={[CHOOSE, ...COUNTS]}
        error={errors.headerPlies}
        onChange={(plies) => onChange({ ...value, plies })}
      />
      <Select
        label="Jack studs each end"
        name={`${prefix}-header-jacks`}
        value={value.jacks}
        options={[CHOOSE, ...COUNTS]}
        error={errors.headerJacks}
        onChange={(jacks) => onChange({ ...value, jacks })}
      />
    </fieldset>
  );
}

function headerOf(
  v: { stock: string; plies: string; jacks: string },
  errors: Record<string, string>,
): HeaderData | undefined {
  if (v.stock === '' || findStock(v.stock)?.kind !== 'lumber')
    errors.headerStock = 'Choose the header stock.';
  if (!/^[1-4]$/.test(v.plies)) errors.headerPlies = 'Choose how many plies.';
  if (!/^[1-4]$/.test(v.jacks)) errors.headerJacks = 'Choose how many jack studs.';
  if (errors.headerStock || errors.headerPlies || errors.headerJacks) return undefined;
  return { stock: v.stock, plies: Number(v.plies), jacks: Number(v.jacks) };
}

function NewWallTypeForm({
  units,
  onCreate,
  onCancel,
}: {
  units: DisplayUnits;
  onCreate: (input: Parameters<typeof addWallType>[1]) => void;
  onCancel: () => void;
}) {
  const us = documentRegion(units) === 'us';
  const [name, setName] = useState(us ? 'Exterior 2x4' : 'Exterior 38 x 89');
  const [stud, setStud] = useState(us ? 'us-2x4' : 'mm-38x89');
  const [sheathing, setSheathing] = useState<string | null>(us ? 'us-osb-7-16' : null);
  const [drywall, setDrywall] = useState<string | null>(null);
  const [header, setHeader] = useState({ stock: '', plies: '', jacks: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const create = () => {
    const errs: Record<string, string> = {};
    if (name.trim() === '') errs.name = 'Give the wall type a name.';
    const h = headerOf(header, errs);
    setErrors(errs);
    if (Object.keys(errs).length > 0 || !h) return;
    onCreate({ name, studStock: stud, sheathing, drywall, header: h });
  };
  return (
    <div className="construction-form" data-testid="wall-type-form">
      <h4>New wall type</h4>
      <Field
        label="Name"
        testId="wall-type-name"
        value={name}
        error={errors.name}
        onChange={setName}
      />
      <OptionalSheet
        label="Sheathing outside the studs"
        testId="wall-type-sheathing"
        value={sheathing}
        fallback={us ? 'us-osb-7-16' : 'mm-ply-18'}
        units={units}
        onChange={setSheathing}
      />
      <StockPicker
        value={stud}
        units={units}
        only="lumber"
        label="Stud stock"
        testId="wall-type-stud"
        onChange={setStud}
      />
      <OptionalSheet
        label="Drywall inside the studs"
        testId="wall-type-drywall"
        value={drywall}
        fallback={us ? 'us-gyp-1-2-8ft' : 'mm-ply-18'}
        units={units}
        onChange={setDrywall}
      />
      <HeaderFields
        value={header}
        units={units}
        errors={errors}
        prefix="wall-type"
        onChange={setHeader}
      />
      <p className="field-note">
        The header sizes are yours to choose: manufakture does no structural calculation.
      </p>
      <div className="dialog-buttons">
        <button type="button" className="primary" data-testid="wall-type-create" onClick={create}>
          Create
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function OptionalSheet({
  label,
  testId,
  value,
  fallback,
  units,
  onChange,
}: {
  label: string;
  testId: string;
  value: string | null;
  fallback: string;
  units: DisplayUnits;
  onChange: (v: string | null) => void;
}) {
  return (
    <div>
      <label className="dialog-check">
        <input
          type="checkbox"
          checked={value !== null}
          data-testid={`${testId}-on`}
          onChange={(e) => onChange(e.target.checked ? fallback : null)}
        />
        {label}
      </label>
      {value !== null && (
        <StockPicker
          value={value}
          units={units}
          only="sheet"
          label="Sheet stock"
          testId={testId}
          onChange={onChange}
        />
      )}
    </div>
  );
}

/** Edit an existing wall type: its layers, stocks, spacing, plates and default header. */
function WallTypeForm({
  type,
  units,
  onSave,
  onCancel,
}: {
  type: StoredWallType;
  units: DisplayUnits;
  onSave: (next: StoredWallType) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(type);
  const framing = draft.layers.find(
    (l): l is FramingLayer<StoredExpression> => l.kind === 'framing',
  )!;
  const [spacing, setSpacing] = useState(framing.spacing?.source ?? '');
  const [header, setHeader] = useState({
    stock: framing.header.stock,
    plies: String(framing.header.plies),
    jacks: String(framing.header.jacks),
  });
  const [newKind, setNewKind] = useState<'siding' | 'sheathing' | 'drywall'>('drywall');
  const [errors, setErrors] = useState<Record<string, string>>({});

  const setFraming = (change: {
    [K in keyof FramingLayer<StoredExpression>]?: FramingLayer<StoredExpression>[K] | undefined;
  }) =>
    setDraft((d) =>
      withLayerChanged(d, framing.id, (l) => {
        const next = { ...l, ...change } as Record<string, unknown>;
        for (const [k, v] of Object.entries(change)) if (v === undefined) delete next[k];
        return next as unknown as WallLayer<StoredExpression>;
      }),
    );

  const save = () => {
    const errs: Record<string, string> = {};
    const h = headerOf(header, errs);
    let spacingExpr: StoredExpression | undefined;
    if (spacing.trim() !== '') {
      const r = checkLength(
        spacing,
        units,
        {},
        { constant: true, min: { value: 50, text: '50 mm' } },
      );
      if (r.ok) spacingExpr = r.expression;
      else errs.spacing = r.message;
    }
    setErrors(errs);
    if (Object.keys(errs).length > 0 || !h) return;
    const next = withLayerChanged(draft, framing.id, (l) => {
      const rest = omit(l as FramingLayer<StoredExpression>, 'spacing');
      return { ...rest, header: h, ...(spacingExpr ? { spacing: spacingExpr } : {}) };
    });
    onSave(next);
  };

  return (
    <div className="construction-form" data-testid="wall-type-editor">
      <h4>{type.name}</h4>
      <ol className="construction-layers">
        {draft.layers.map((l) => (
          <li key={l.id} data-testid={`layer-${l.id}`}>
            <strong>{LAYER_LABELS[l.kind]}</strong>
            {l.kind === 'framing' ? (
              <>
                <StockPicker
                  value={l.stock}
                  units={units}
                  only="lumber"
                  label="Stud stock"
                  testId="layer-framing-stock"
                  onChange={(stock) => setFraming({ stock })}
                />
                <Field
                  label="Spacing on centre (empty: the document's framing setting)"
                  testId="layer-spacing"
                  value={spacing}
                  error={errors.spacing}
                  onChange={setSpacing}
                />
                <Select
                  label="Bottom plates"
                  name="layer-bottom-plates"
                  value={l.bottomPlates === undefined ? '' : String(l.bottomPlates)}
                  options={[['', 'Default (1)'], ...COUNTS.slice(0, 3)]}
                  onChange={(v) => setFraming({ bottomPlates: v === '' ? undefined : Number(v) })}
                />
                <Select
                  label="Top plates"
                  name="layer-top-plates"
                  value={l.topPlates === undefined ? '' : String(l.topPlates)}
                  options={[['', 'Default (2)'], ...COUNTS.slice(0, 3)]}
                  onChange={(v) => setFraming({ topPlates: v === '' ? undefined : Number(v) })}
                />
                <HeaderFields
                  value={header}
                  units={units}
                  errors={errors}
                  prefix="layer"
                  onChange={setHeader}
                />
              </>
            ) : (
              <>
                <StockPicker
                  value={l.stock ?? ''}
                  units={units}
                  only="sheet"
                  label="Sheet stock"
                  testId={`layer-${l.id}-stock`}
                  onChange={(stock) =>
                    setDraft((d) =>
                      withLayerChanged(
                        d,
                        l.id,
                        (x) => ({ ...x, stock }) as WallLayer<StoredExpression>,
                      ),
                    )
                  }
                />
                <button
                  type="button"
                  data-testid={`layer-${l.id}-remove`}
                  onClick={() => setDraft((d) => withoutLayer(d, l.id))}
                >
                  Remove
                </button>
              </>
            )}
          </li>
        ))}
      </ol>
      <div className="construction-row">
        <Select
          label="Add a layer"
          name="layer-new-kind"
          value={newKind}
          options={[
            ['siding', 'Siding'],
            ['sheathing', 'Sheathing'],
            ['drywall', 'Drywall'],
          ]}
          onChange={(v) => setNewKind(v as typeof newKind)}
        />
        <button
          type="button"
          data-testid="layer-add"
          onClick={() => {
            const stock =
              documentRegion(units) === 'us'
                ? newKind === 'drywall'
                  ? 'us-gyp-1-2-8ft'
                  : 'us-osb-7-16'
                : 'mm-ply-18';
            const r = withLayer(draft, newKind, stock);
            if (typeof r === 'string') setErrors({ form: r });
            else setDraft(r);
          }}
        >
          Add
        </button>
      </div>
      {errors.form && (
        <p className="field-error" role="alert">
          {errors.form}
        </p>
      )}
      <div className="dialog-buttons">
        <button type="button" className="primary" data-testid="wall-type-save" onClick={save}>
          Save
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
