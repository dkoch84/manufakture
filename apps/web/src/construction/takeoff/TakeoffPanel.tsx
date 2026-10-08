// The Takeoff panel (M6 plan T6.3b, ADR 0015 decision 10): the construction takeoff of the part
// studio, built on M4's cut list panel (T4.3d): its table, layout views and file buttons.
//
// - **Takeoff**: rows by section (as framed, linear length, sheet layers as laid, lumber and sheets
//   to buy), each with its total and cost; a row to buy says what its quantity is cut into, since
//   it counts sticks or sheets while naming the members or faces they become. Totals per section,
//   subtotals per level and feature, and the cost in all with the rows it leaves out. Clicking a
//   row selects its members or layer bodies in the viewport.
// - **Layouts**: every face's sheet layout to scale, the sheets packed from partial pieces, and
//   every lumber stick.
// - **Settings**: precut studs, waste, currency and the lengths the yard sells, stored in
//   `domains.construction` as one undo step.
// - **Files**: CSV and PDF, each opening with the short "not an engineering tool" text.
//
// As framed only: there is no estimating row (the project owner's decision).

import type { ManufaktureDocument } from '@manufakture/core';
import {
  DISCLAIMER_SHORT,
  LAYER_LABELS,
  SECTIONS,
  constructionTakeoff,
  costLines,
  displayRows,
  flagText,
  sections,
  subtotalLines,
  takeoffModel,
  totalsText,
  type ConstructionTakeoff,
  type TakeoffDisplayRow,
  type TakeoffModel,
} from '@manufakture/domain-construction';
import { takeoffFile } from '@manufakture/domain-construction/files';
import { exactFormat, type DisplayRow } from '@manufakture/domain-wood';
import { UNNAMED } from '@manufakture/kernel';
import { findStock } from '@manufakture/stock';
import { formatLength } from '@manufakture/units';
import { useMemo, useState } from 'react';
import { useStore } from 'zustand';
import { ExportGateNotice } from '../../io/ExportGateNotice';
import { currentExportSource, useExportRefusal } from '../../io/exportSource';
import { downloadBytes } from '../../io/files';
import { useModel, type ModelStore, type PartModel } from '../../model/model';
import type { DocumentStoreApi } from '../../state/document';
import { geometryRef, type SelectableItem, type SelectionStore } from '../../state/selection';
import { memberRef, type MemberSetView } from '../../viewport/members';
import type { MemberStore } from '../../viewport/memberStore';
import { documentStock } from '../../wood/catalog';
import { SheetView, StickView } from '../../wood/cutlist/SheetView';
import { documentConstruction } from '../settings';
import { FaceView } from './FaceView';
import {
  AS_CUT,
  takeoffForm,
  takeoffSettingsCommand,
  type TakeoffForm,
  type TakeoffFormErrors,
} from './settings';
import '../../wood/cutlist/cutlist.css';
import './takeoff.css';

export interface TakeoffPanelProps {
  documents: DocumentStoreApi;
  model: ModelStore;
  members: MemberStore;
  selection: SelectionStore;
  partId: string;
  /** Saves a file (default: a browser download). */
  download?: (bytes: Uint8Array, fileName: string, type: string) => void;
  disabled?: boolean;
  onClose?: () => void;
}

const EMPTY_FEATURES: readonly never[] = [];
const EMPTY_SETS: readonly MemberSetView[] = [];

/** The faces of a body of the part, for the selection. */
function bodyFaces(parts: readonly PartModel[], partId: string, bodyId: string): SelectableItem[] {
  const body = parts.find((p) => p.partId === partId)?.bodies.find((b) => b.bodyId === bodyId);
  if (body === undefined) return [];
  const view = body.view;
  const out: SelectableItem[] = [];
  view.mesh.faceNames.forEach((slot, i) => {
    const name = slot === UNNAMED ? undefined : view.names[slot];
    if (name !== undefined) {
      out.push(geometryRef('face', view.id, name, { fragile: view.mesh.faceFragile[i] === 1 }));
    }
  });
  return out;
}

/** A label for a layout view, shaped as the cut list's rows (number and name only matter). */
function label(number: number, item: string): DisplayRow {
  return {
    number,
    key: item,
    kind: 'shape',
    category: '',
    item,
    fullItem: item,
    stockId: undefined,
    stock: '',
    material: '',
    size: '',
    length: 0,
    width: 0,
    thickness: 0,
    quantity: 1,
    extended: '',
    boardFeet: undefined,
    flags: [],
    sources: [],
  };
}

type Computed =
  { ok: true; model: TakeoffModel; takeoff: ConstructionTakeoff } | { ok: false; message: string };

export function TakeoffPanel({
  documents,
  model,
  members,
  selection,
  partId,
  download = downloadBytes,
  disabled = false,
  onClose,
}: TakeoffPanelProps) {
  const doc = useStore(documents, (s) => s.document);
  const units = doc.units;
  const format = exactFormat(units);
  const parts = useModel(model, (s) => s.parts);
  const features = useModel(
    model,
    (s) => s.parts.find((p) => p.partId === partId)?.features ?? EMPTY_FEATURES,
  );
  const sets = useStore(members, (s) => s.parts.get(partId) ?? EMPTY_SETS);
  const data = useMemo(() => documentConstruction(doc), [doc]);
  const settings = data.ok ? data.data?.settings : undefined;
  const stock = useMemo(() => documentStock(doc), [doc]);
  const computed = useMemo((): Computed => {
    try {
      const m = takeoffModel({
        document: doc,
        partId,
        features,
        sets,
        settings,
        stock: stock.ok ? stock.data : undefined,
      });
      return { ok: true, model: m, takeoff: constructionTakeoff(m.input) };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }, [doc, partId, features, sets, settings, stock]);
  const rows = useMemo(
    () => (computed.ok ? displayRows(computed.takeoff, units) : []),
    [computed, units],
  );
  const subtotals = useMemo(
    () => (computed.ok ? subtotalLines(computed.takeoff, doc, partId, settings) : []),
    [computed, doc, partId, settings],
  );
  const [tab, setTab] = useState<'rows' | 'layouts'>('rows');
  const [picked, setPicked] = useState<string | null>(null);
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);
  const lumberStocks = useMemo(() => {
    if (!computed.ok) return [];
    const ids = new Set<string>();
    for (const m of computed.model.input.members) {
      if (findStock(m.stock.id)?.kind === 'lumber') ids.add(m.stock.id);
    }
    return [...ids].sort();
  }, [computed]);

  const pick = (row: TakeoffDisplayRow) => {
    if (!computed.ok) return;
    setPicked(row.key);
    const items: SelectableItem[] = [];
    for (const id of row.sources) {
      if (computed.model.members.has(id)) items.push(memberRef(id));
      else {
        for (const body of computed.model.bodies.get(id) ?? [])
          items.push(...bodyFaces(parts, partId, body));
      }
    }
    selection.getState().select(items);
  };
  const faceById = useMemo(
    () => new Map((computed.ok ? (computed.model.input.faces ?? []) : []).map((f) => [f.id, f])),
    [computed],
  );
  const pickedSources = useMemo(
    () => new Set(rows.find((r) => r.key === picked)?.sources ?? []),
    [rows, picked],
  );

  // The export gate (T8.3c): the takeoff shows on any branch, but its files are not written
  // from an agent's unreviewed branch.
  const gated = useExportRefusal();

  const save = (what: 'csv' | 'pdf') => {
    if (!computed.ok) return;
    try {
      const file = takeoffFile(what, computed.takeoff, rows, {
        documentName: doc.name,
        units,
        subtotals,
        notes: computed.model.notes,
        source: currentExportSource(),
      });
      download(file.bytes, file.name, file.type);
      setMessage(null);
    } catch (error) {
      setMessage({
        error: true,
        text: `The file could not be written: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  };

  const names = useMemo(
    () =>
      new Map((doc.parts.find((p) => p.id === partId)?.features ?? []).map((f) => [f.id, f.name])),
    [doc, partId],
  );
  const nameOf = (id: string) => names.get(id) ?? id;

  return (
    <aside
      className="selection-panel cutlist-panel takeoff-panel"
      aria-label="Takeoff"
      data-testid="takeoff-panel"
    >
      <div className="variables-head">
        <h2>Takeoff</h2>
        {onClose && (
          <button type="button" data-testid="takeoff-close" onClick={onClose}>
            Close
          </button>
        )}
      </div>
      <p className="takeoff-disclaimer" data-testid="takeoff-disclaimer">
        {DISCLAIMER_SHORT}
      </p>
      <p className="field-note">
        As framed: what the framing rules produced and the faces as laid, then what to buy for
        exactly that. No estimating allowance is added.
      </p>
      {!data.ok && (
        <p className="field-error" role="alert">
          The construction settings cannot be read: {data.message}
        </p>
      )}
      <div className="cutlist-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'rows'}
          data-testid="takeoff-tab-rows"
          onClick={() => setTab('rows')}
        >
          Takeoff
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'layouts'}
          data-testid="takeoff-tab-layouts"
          onClick={() => setTab('layouts')}
        >
          Sheet layouts
        </button>
      </div>
      <TakeoffSettings
        key={JSON.stringify(data.ok ? (data.data?.stored.takeoff ?? null) : null)}
        doc={doc}
        stocks={lumberStocks}
        disabled={disabled || !data.ok || data.data === undefined}
        onSave={(form) => {
          const r = takeoffSettingsCommand(documents.getState().document, form);
          if (!r.ok) return r;
          if (r.command) {
            const done = documents.getState().execute(r.command, r.label);
            if (!done.ok) return { ok: false as const, errors: {}, message: done.error.message };
          }
          return r;
        }}
      />
      {!computed.ok ? (
        <p className="field-error" role="alert" data-testid="takeoff-error">
          The takeoff could not be made: {computed.message}
        </p>
      ) : tab === 'rows' ? (
        <>
          {computed.model.notes.map((n) => (
            <p key={n} className="field-error" data-testid="takeoff-note">
              {n}
            </p>
          ))}
          {rows.length === 0 ? (
            <p className="field-note" data-testid="takeoff-empty">
              Nothing framed yet. Walls, floors and roofs appear here once regen has framed them.
            </p>
          ) : (
            <TakeoffTable
              takeoff={computed.takeoff}
              rows={rows}
              units={doc.units}
              picked={picked}
              onPick={pick}
            />
          )}
          {subtotals.length > 0 && (
            <>
              <h3>Subtotals as framed and laid</h3>
              <ul className="cutlist-totals" data-testid="takeoff-subtotals">
                {subtotals.map((s) => (
                  <li key={`${s.kind}|${s.id}`} data-testid={`takeoff-subtotal-${s.kind}-${s.id}`}>
                    {s.kind === 'level' ? 'Level' : ''} {s.name}: {s.text}
                  </li>
                ))}
              </ul>
            </>
          )}
          <div className="takeoff-cost" data-testid="takeoff-cost">
            {costLines(computed.takeoff, rows).map((line) => (
              <p key={line}>{line}</p>
            ))}
          </div>
        </>
      ) : (
        <div className="cutlist-layouts" data-testid="takeoff-layouts">
          {computed.takeoff.faces.length === 0 && computed.takeoff.lumber.length === 0 && (
            <p className="field-note">Nothing to lay out.</p>
          )}
          {computed.takeoff.sheets.map((s) => {
            const faces = computed.takeoff.faces.filter((f) => f.stock === s.stock);
            const packedLabels = new Map(
              (s.result?.sheets ?? [])
                .flatMap((sheet) => sheet.placements.map((p) => p.partId))
                .map((id, i) => [id, label(i + 1, id)] as const),
            );
            return (
              <section key={s.stock} data-testid={`takeoff-sheets-${s.stock}`}>
                <h3>
                  {findStock(s.stock)?.name ?? s.stock}: {s.bought}{' '}
                  {s.bought === 1 ? 'sheet' : 'sheets'} ({s.full} whole, {s.packed} for the partial
                  pieces)
                </h3>
                {faces.map((layout) => {
                  const face = faceById.get(layout.face);
                  if (face === undefined) return null;
                  const seg = /\/s(\d+)$/.exec(face.id);
                  return (
                    <FaceView
                      key={layout.face}
                      face={face}
                      layout={layout}
                      title={`${nameOf(face.owner)}: ${LAYER_LABELS[face.layer]}${seg ? ` (segment ${seg[1]})` : ''}`}
                      format={format}
                      highlight={pickedSources.has(face.id)}
                    />
                  );
                })}
                {(s.result?.sheets ?? []).map((sheet, i) => (
                  <SheetView
                    key={i}
                    sheet={sheet}
                    title={`${sheet.stockId === 'new' ? 'New sheet' : 'Offcut'} ${i + 1}: partial pieces`}
                    labels={packedLabels}
                    format={format}
                    testId="takeoff-packed"
                  />
                ))}
              </section>
            );
          })}
          {computed.takeoff.lumber.map((l) => {
            // Cuts are numbered by their length, longest first in the order they appear.
            const lengths = new Map<string, DisplayRow>();
            for (const stick of l.result.sticks) {
              for (const c of stick.cuts) {
                if (!lengths.has(c.partId)) {
                  lengths.set(c.partId, label(lengths.size + 1, formatLength(c.length, format)));
                }
              }
            }
            return (
              <section key={l.stock} data-testid={`takeoff-sticks-${l.stock}`}>
                <h3>
                  {findStock(l.stock)?.name ?? l.stock}: {l.result.totals.sticks}{' '}
                  {l.result.totals.sticks === 1 ? 'stick' : 'sticks'}
                </h3>
                {l.result.sticks.map((stick, i) => (
                  <StickView key={i} stick={stick} labels={lengths} format={format} />
                ))}
              </section>
            );
          })}
        </div>
      )}
      <ExportGateNotice refusal={gated} />
      <div className="cutlist-files">
        <button
          type="button"
          data-testid="takeoff-csv"
          disabled={!computed.ok || gated !== null}
          onClick={() => save('csv')}
        >
          Takeoff CSV
        </button>
        <button
          type="button"
          data-testid="takeoff-pdf"
          disabled={!computed.ok || gated !== null}
          onClick={() => save('pdf')}
        >
          PDF
        </button>
      </div>
      {message && (
        <p className={message.error ? 'field-error' : 'field-note'} role="status">
          {message.text}
        </p>
      )}
    </aside>
  );
}

function TakeoffTable({
  takeoff,
  rows,
  units,
  picked,
  onPick,
}: {
  takeoff: ConstructionTakeoff;
  rows: readonly TakeoffDisplayRow[];
  units: ManufaktureDocument['units'];
  picked: string | null;
  onPick: (row: TakeoffDisplayRow) => void;
}) {
  return (
    <table className="cutlist-table" data-testid="takeoff-table">
      <thead>
        <tr>
          <th scope="col">#</th>
          <th scope="col">Item</th>
          <th scope="col">Stock, size</th>
          <th scope="col">Qty</th>
          <th scope="col">Total</th>
          <th scope="col">Cost</th>
        </tr>
      </thead>
      {sections(rows).map((s) => {
        const totals = takeoff.totals.filter((t) => t.group === s.category);
        return (
          <tbody key={s.category} data-testid={`takeoff-section-${s.category}`}>
            <tr className="cutlist-group">
              <th colSpan={6} scope="rowgroup">
                {SECTIONS[s.category].title}
                <p className="takeoff-section-note">{SECTIONS[s.category].note}</p>
              </th>
            </tr>
            {s.rows.map((r) => (
              <tr
                key={r.key}
                data-testid="takeoff-row"
                data-key={r.key}
                className={picked === r.key ? 'picked' : undefined}
                onClick={() => onPick(r)}
              >
                <td>{r.number}</td>
                <td title={r.measures || undefined}>
                  <span data-testid="takeoff-item">{r.item}</span>
                  {r.counted && (
                    <span className="takeoff-counted" data-testid="takeoff-counted">
                      {r.counted}
                    </span>
                  )}
                  {r.flags.map((f) => (
                    <span key={f} className="cutlist-flag" data-testid={`takeoff-flag-${f}`}>
                      {flagText(f)}
                    </span>
                  ))}
                </td>
                <td className="takeoff-stock-size">
                  <span data-testid="takeoff-stock">{r.stock}</span>
                  <span className="takeoff-size" data-testid="takeoff-size">
                    {r.size}
                  </span>
                </td>
                <td data-testid="takeoff-qty">{r.quantity}</td>
                <td data-testid="takeoff-total">{r.extended}</td>
                <td data-testid="takeoff-row-cost">{r.cost}</td>
              </tr>
            ))}
            {totals.length > 0 && (
              <tr data-testid={`takeoff-totals-${s.category}`}>
                <td />
                <td colSpan={5} className="field-note">
                  In all: {totalsText(totals, units)}
                </td>
              </tr>
            )}
          </tbody>
        );
      })}
    </table>
  );
}

function TakeoffSettings({
  doc,
  stocks,
  disabled,
  onSave,
}: {
  doc: ManufaktureDocument;
  stocks: readonly string[];
  disabled: boolean;
  onSave: (
    form: TakeoffForm,
  ) => { ok: true } | { ok: false; errors: TakeoffFormErrors; message?: string };
}) {
  const stored = useMemo(() => {
    const r = documentConstruction(doc);
    return r.ok ? r.data?.stored.takeoff : undefined;
  }, [doc]);
  const [form, setForm] = useState(() => takeoffForm(stored, stocks));
  const [errors, setErrors] = useState<TakeoffFormErrors>({});
  const [failure, setFailure] = useState<string | null>(null);
  // Stocks framed since the form was made get a field too.
  const lengths = { ...Object.fromEntries(stocks.map((id) => [id, ''])), ...form.lengths };
  const save = () => {
    const r = onSave({ ...form, lengths });
    if (!r.ok) {
      setErrors(r.errors);
      setFailure(r.message ?? null);
    } else {
      setErrors({});
      setFailure(null);
    }
  };
  return (
    <details className="cutlist-settings" data-testid="takeoff-settings">
      <summary>Takeoff settings</summary>
      <div
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') {
            e.preventDefault();
            save();
          }
        }}
      >
        <label className="dialog-field">
          <input
            type="checkbox"
            data-testid="takeoff-precuts"
            checked={form.precuts}
            onChange={(e) => setForm((f) => ({ ...f, precuts: e.target.checked }))}
          />{' '}
          Buy studs as precut studs where their length matches
        </label>
        <label className="dialog-field">
          Sheet waste (%)
          <input
            data-testid="takeoff-waste"
            value={form.waste}
            maxLength={20}
            placeholder="0"
            onChange={(e) => setForm((f) => ({ ...f, waste: e.target.value }))}
          />
        </label>
        {errors.waste && <p className="field-error">{errors.waste}</p>}
        <label className="dialog-field">
          Currency
          <input
            data-testid="takeoff-currency"
            value={form.currency}
            maxLength={3}
            placeholder="as the prices state"
            onChange={(e) => setForm((f) => ({ ...f, currency: e.target.value }))}
          />
        </label>
        {errors.currency && <p className="field-error">{errors.currency}</p>}
        {Object.keys(lengths).length > 0 && (
          <div className="takeoff-lengths">
            <p className="field-note">
              Lengths the yard sells, separated by commas. Empty: the catalog&apos;s lengths;{' '}
              <code>{AS_CUT}</code>: each piece at its own length.
            </p>
            {Object.keys(lengths)
              .sort()
              .map((id) => (
                <label key={id}>
                  {findStock(id)?.name ?? id}
                  <input
                    data-testid={`takeoff-lengths-${id}`}
                    value={lengths[id]}
                    maxLength={400}
                    placeholder={(findStock(id)?.lengths ?? [])
                      .map((l) => formatLength(l, exactFormat(doc.units)))
                      .join(', ')}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, lengths: { ...f.lengths, [id]: e.target.value } }))
                    }
                  />
                  {errors.lengths?.[id] && (
                    <span className="field-error">{errors.lengths[id]}</span>
                  )}
                </label>
              ))}
          </div>
        )}
        {failure && (
          <p className="field-error" role="alert">
            {failure}
          </p>
        )}
        <div className="dialog-buttons">
          <button
            type="button"
            className="primary"
            data-testid="takeoff-settings-save"
            disabled={disabled}
            onClick={save}
          >
            Apply
          </button>
        </div>
      </div>
    </details>
  );
}
