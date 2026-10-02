// The Stock panel (M4 plan T4.1d): the stocks the document's boards are cut from, with the
// document's overrides of them (`domains.stock`): a measured thickness or width, the sheet size in
// stock, a price. One stock is edited at a time; Save or Clear is one undo step, and every board
// of that stock rebuilds. Overrides are constants (`18.2mm`), never variables (ADR 0013 decision
// 3). The panel also turns the boards' grain arrows on and off. The logic is in stock.ts.

import type { DisplayUnits } from '@manufakture/core';
import { findStock, type StockEntry } from '@manufakture/domain-wood';
import { useMemo, useState } from 'react';
import { useStore } from 'zustand';
import { ExpressionField } from '../components/ExpressionField';
import type { DocumentStoreApi } from '../state/document';
import { documentStock, sizeText, stockLabel } from './catalog';
import { grainStore } from './grain';
import {
  PRICE_UNIT_LABELS,
  PRICE_UNITS,
  buildOverride,
  overrideCommand,
  overrideForm,
  stockRows,
  type OverrideForm,
  type StockRow,
} from './stock';
import { StockPicker } from './StockPicker';
import './wood.css';

export interface StockPanelProps {
  documents: DocumentStoreApi;
  /** Nothing can be changed (a dialog or an export is open). */
  disabled?: boolean;
}

/** Overrides take constants only, so no variable is offered or evaluated. */
const NO_VARIABLES = {};

export function StockPanel({ documents, disabled = false }: StockPanelProps) {
  const doc = useStore(documents, (s) => s.document);
  const units = doc.units;
  const stock = useMemo(() => documentStock(doc), [doc]);
  const rows = useMemo(() => stockRows(doc, stock.ok ? stock.data : undefined), [doc, stock]);
  const showGrain = useStore(grainStore, (s) => s.show);
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const run = (stockId: string, override: Parameters<typeof overrideCommand>[2]): boolean => {
    const r = overrideCommand(documents.getState().document, stockId, override);
    if (!r.ok) {
      setFailure(r.message);
      return false;
    }
    if (r.command) {
      const done = documents.getState().execute(r.command, r.label);
      if (!done.ok) {
        setFailure(done.error.message);
        return false;
      }
    }
    setFailure(null);
    return true;
  };

  const editedEntry = editing ? findStock(editing) : undefined;
  return (
    <aside className="selection-panel stock-panel" aria-label="Stock">
      <div className="variables-head">
        <h2>Stock</h2>
      </div>
      {!stock.ok && (
        <p className="field-error" role="alert">
          The stock overrides cannot be read, so they are kept as they are: {stock.message}
        </p>
      )}
      {rows.length === 0 && (
        <p className="field-note">
          No boards yet. Overrides set a stock&apos;s measured thickness, the sheets you have and
          prices.
        </p>
      )}
      <ul className="stock-rows">
        {rows.map((row) => (
          <li key={row.id} data-testid={`stock-row-${row.id}`}>
            <StockRowView
              row={row}
              units={units}
              disabled={disabled || !stock.ok || editing !== null}
              onEdit={() => {
                setEditing(row.id);
                setFailure(null);
              }}
            />
            {editing === row.id && editedEntry && (
              <OverrideEditor
                entry={editedEntry}
                initial={overrideForm(editedEntry, row.stored)}
                units={units}
                canClear={row.stored !== undefined}
                onSave={(override) => {
                  if (run(row.id, override)) setEditing(null);
                }}
                onClear={() => {
                  if (run(row.id, undefined)) setEditing(null);
                }}
                onCancel={() => setEditing(null)}
              />
            )}
          </li>
        ))}
      </ul>
      {stock.ok && editing === null && (
        <div className="stock-add">
          <StockPicker
            value={adding ?? ''}
            units={units}
            label="Override another stock"
            testId="stock-add-picker"
            onChange={setAdding}
          />
          <button
            type="button"
            data-testid="stock-add"
            disabled={disabled || adding === null}
            onClick={() => {
              if (adding === null) return;
              setEditing(adding);
              setAdding(null);
            }}
          >
            Override
          </button>
        </div>
      )}
      {editing !== null && !rows.some((r) => r.id === editing) && editedEntry && (
        <OverrideEditor
          entry={editedEntry}
          initial={overrideForm(editedEntry, undefined)}
          units={units}
          canClear={false}
          onSave={(override) => {
            if (run(editedEntry.id, override)) setEditing(null);
          }}
          onClear={() => setEditing(null)}
          onCancel={() => setEditing(null)}
        />
      )}
      {failure && (
        <p className="field-error" role="alert">
          {failure}
        </p>
      )}
      <label className="dialog-check">
        <input
          type="checkbox"
          data-testid="stock-show-grain"
          checked={showGrain}
          onChange={(e) => grainStore.getState().setShow(e.target.checked)}
        />
        Show grain arrows on boards
      </label>
    </aside>
  );
}

function StockRowView({
  row,
  units,
  disabled,
  onEdit,
}: {
  row: StockRow;
  units: DisplayUnits;
  disabled: boolean;
  onEdit: () => void;
}) {
  const r = row.resolved;
  if (!r) {
    return (
      <span className="stock-row">
        <span>{row.id}</span>
        <span className="field-note">Not a stock this version knows; kept as it is.</span>
      </span>
    );
  }
  // A measured size reads as typed (`18.2mm`): a fraction of an inch could round it away.
  const t = row.stored?.thickness;
  const w = row.stored?.width;
  const sizes = [
    t ? `${t.source} (measured)` : sizeText(r.thickness, units),
    ...(r.width !== undefined ? [w ? `${w.source} (measured)` : sizeText(r.width, units)] : []),
  ].join(' x ');
  const notes: string[] = [];
  if (r.sheet && r.overridden.sheet) {
    notes.push(`sheets ${sizeText(r.sheet.length, units)} x ${sizeText(r.sheet.width, units)}`);
  }
  if (r.price) {
    notes.push(
      `${r.price.amount}${r.price.currency ? ` ${r.price.currency}` : ''} ${PRICE_UNIT_LABELS[r.price.per]}`,
    );
  }
  if (!row.used) notes.push('no board uses it');
  return (
    <span className="stock-row">
      <span className="stock-name" title={stockLabel(r.entry, units)}>
        {r.entry.name}
      </span>
      <span className="stock-size" data-testid="stock-size">
        {sizes}
      </span>
      {notes.length > 0 && <span className="field-note">{notes.join('; ')}</span>}
      <button type="button" data-testid="stock-edit" disabled={disabled} onClick={onEdit}>
        {row.stored ? 'Edit' : 'Override'}
      </button>
    </span>
  );
}

function OverrideEditor({
  entry,
  initial,
  units,
  canClear,
  onSave,
  onClear,
  onCancel,
}: {
  entry: StockEntry;
  initial: OverrideForm;
  units: DisplayUnits;
  canClear: boolean;
  onSave: (override: NonNullable<Parameters<typeof overrideCommand>[2]>) => void;
  onClear: () => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const set = (patch: Partial<OverrideForm>) => setForm((f) => ({ ...f, ...patch }));
  const save = () => {
    const r = buildOverride(entry, form, units);
    if (!r.ok) setErrors(r.errors);
    else onSave(r.override);
  };
  const length = (key: 'thickness' | 'width' | 'sheetLength' | 'sheetWidth', label: string) => (
    <ExpressionField
      key={key}
      label={label}
      testId={`override-${key}`}
      value={form[key]}
      kind="length"
      units={units}
      variables={NO_VARIABLES}
      names={[]}
      error={errors[key]}
      onChange={(v) => set({ [key]: v })}
    />
  );
  const catalog = (mm: number | undefined) => (mm === undefined ? 'random' : sizeText(mm, units));
  return (
    <div
      className="stock-editor"
      role="group"
      aria-label={`Override ${entry.name}`}
      data-testid="stock-editor"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onCancel();
        } else if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') {
          e.preventDefault();
          save();
        }
      }}
    >
      <p className="field-note">
        {stockLabel(entry, units)}. Leave a field empty to use the catalog&apos;s value (thickness{' '}
        {catalog(entry.actual.thickness)}
        {entry.kind === 'lumber' ? `, width ${catalog(entry.actual.width)}` : ''}).
      </p>
      {length('thickness', 'Measured thickness')}
      {entry.kind === 'lumber' && length('width', 'Measured width')}
      {entry.kind === 'sheet' && length('sheetLength', 'Sheet length')}
      {entry.kind === 'sheet' && length('sheetWidth', 'Sheet width')}
      <div className="dialog-field stock-price">
        <label>
          Price
          <input
            type="text"
            inputMode="decimal"
            data-testid="override-price"
            value={form.price}
            aria-invalid={errors.price !== undefined}
            onChange={(e) => set({ price: e.target.value })}
          />
        </label>
        <label>
          Per
          <select
            data-testid="override-per"
            value={form.per}
            onChange={(e) => set({ per: e.target.value as OverrideForm['per'] })}
          >
            {PRICE_UNITS.map((u) => (
              <option key={u} value={u}>
                {PRICE_UNIT_LABELS[u]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Currency
          <input
            type="text"
            data-testid="override-currency"
            maxLength={3}
            size={4}
            value={form.currency}
            aria-invalid={errors.currency !== undefined}
            onChange={(e) => set({ currency: e.target.value })}
          />
        </label>
        {errors.price && <span className="field-error">{errors.price}</span>}
        {errors.currency && <span className="field-error">{errors.currency}</span>}
      </div>
      <div className="dialog-buttons">
        <button type="button" className="primary" data-testid="override-save" onClick={save}>
          Save
        </button>
        {canClear && (
          <button type="button" data-testid="override-clear" onClick={onClear}>
            Clear
          </button>
        )}
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
