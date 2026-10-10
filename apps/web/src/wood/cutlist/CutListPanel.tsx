// The Cut list panel (M4 plan T4.3d): the cut list and bill of materials of the shown model, the
// sheet layouts and lumber plans, and the files for the shop.
//
// - **Cut list**: rows as `@manufakture/domain-wood`'s `cutList` gives them, grouped by stock and
//   sortable within a group, with totals and board feet; clicking a row selects its bodies. Bodies
//   the list leaves out (a pattern copy of a board has no material) are listed above it, so the
//   list never undercounts in silence. Bodies that are not boards are sized by the kernel's
//   oriented box, asked of the regen worker (`Sizer`) when the model changes.
// - **Layouts**: every sheet drawn to scale with its cut order, and every lumber plan, computed
//   in the nesting worker (`Nester`) from the list and the document's settings (kerf, trims,
//   stages, grain), which the settings form stores in `domains.wood` as one undo step.
// - **Files**: CSV of the cut list and of the bill of materials, and a PDF of both with the
//   layouts.
//
// The model is built in the active configuration row, so the list is that row's.

import type { DisplayUnits, ManufaktureDocument } from '@manufakture/core';
import {
  BOARD_TYPE,
  bodiesToSize,
  displayRows,
  documentCutList,
  documentSettings,
  excludedLines,
  exactFormat,
  flagText,
  groupRows,
  missingLines,
  nestingJob,
  totalBoardFeet,
  totalLines,
  type CutList,
  type DisplayRow,
  type JobProgress,
  type NestingResult,
  type OrientedSize,
  type SortKey,
} from '@manufakture/domain-wood';
import { cutListFile } from '@manufakture/domain-wood/files';
import { UNNAMED } from '@manufakture/kernel';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { ExpressionField } from '../../components/ExpressionField';
import { downloadBytes } from '../../io/files';
import { useModel, type ModelStore, type PartModel } from '../../model/model';
import type { DocumentStoreApi } from '../../state/document';
import { geometryRef, type GeometryRef, type SelectionStore } from '../../state/selection';
import type { Nester } from './nester';
import { settingsCommand, settingsForm, trimNotes, type SettingsForm } from './settings';
import { SheetView, StickView } from './SheetView';
import type { Sizer } from './sizer';

export type { Sizer } from './sizer';
import { documentStock } from '../catalog';
import { formatLength } from '@manufakture/units';
import './cutlist.css';

export interface CutListPanelProps {
  documents: DocumentStoreApi;
  model: ModelStore;
  selection: SelectionStore;
  /** Count through this assembly's instances; null: every body of every part. */
  assemblyId?: string | null;
  /** Null: bodies that are not boards are listed with their size unknown. */
  sizer?: Sizer | null;
  /** Makes the nester on the first layout (default: the nesting worker). */
  createNester?: () => Nester;
  /** Saves a file (default: a browser download). */
  download?: (bytes: Uint8Array, fileName: string, type: string) => void;
  /** Nothing can be changed (a dialog or an export is open). */
  disabled?: boolean;
  onClose?: () => void;
}

const NO_VARIABLES = {};

async function defaultNester(): Promise<Nester> {
  const { spawnNester } = await import('./nesting-spawn');
  return spawnNester();
}

/** The faces of the bodies a row counts, for the selection (part studio bodies only). */
function rowFaces(row: DisplayRow, parts: readonly PartModel[]): GeometryRef[] {
  const out: GeometryRef[] = [];
  for (const s of row.sources) {
    if (s.instance !== undefined) continue;
    const body = parts.find((p) => p.partId === s.part)?.bodies.find((b) => b.bodyId === s.id);
    if (body === undefined) continue;
    const view = body.view;
    view.mesh.faceNames.forEach((slot, i) => {
      const name = slot === UNNAMED ? undefined : view.names[slot];
      if (name !== undefined) {
        out.push(geometryRef('face', view.id, name, { fragile: view.mesh.faceFragile[i] === 1 }));
      }
    });
  }
  return out;
}

/** The model's document (its parts and bodies) with the open document's settings and name. */
function withSettings(source: ManufaktureDocument, doc: ManufaktureDocument): ManufaktureDocument {
  if (source === doc) return doc;
  const out: ManufaktureDocument = { ...source, name: doc.name };
  if (doc.domains === undefined) delete out.domains;
  else out.domains = doc.domains;
  return out;
}

/** The oriented sizes of the shown model's bodies that are not boards, by part. */
function useOrientedSizes(
  sizer: Sizer | null,
  document: ManufaktureDocument | null,
  parts: readonly PartModel[],
): { sizes: ReadonlyMap<string, readonly OrientedSize[]>; busy: boolean; error: string | null } {
  // What to ask for: the parts with such bodies, for this model. Null: nothing to ask.
  const request = useMemo(() => {
    if (sizer === null || document === null) return null;
    const wanted = parts.flatMap((model) => {
      const part = document.parts.find((p) => p.id === model.partId);
      const bodies = part ? bodiesToSize(part, model) : [];
      return bodies.length > 0 ? [{ partId: model.partId, bodies }] : [];
    });
    return wanted.length > 0 ? { sizer, document, wanted } : null;
  }, [sizer, document, parts]);
  const [state, setState] = useState<{
    request: unknown;
    sizes: ReadonlyMap<string, readonly OrientedSize[]>;
    error: string | null;
  }>({ request: null, sizes: new Map(), error: null });
  useEffect(() => {
    if (request === null) return;
    let live = true;
    const { sizer: s, document: d, wanted } = request;
    Promise.all(
      wanted.map((w) =>
        s
          .orientedSizes(d, w.partId, { bodies: w.bodies, skipExtensions: [BOARD_TYPE] })
          .then((r) => [w.partId, r] as const),
      ),
    ).then(
      (results) => {
        if (!live) return;
        setState((before) => {
          // Sizes kept from before for a part whose request a newer regen superseded (null):
          // that regen's model asks again.
          const sizes = new Map(before.sizes);
          const failed: string[] = [];
          for (const [partId, r] of results) {
            if (r === null) continue;
            sizes.set(
              partId,
              r.sizes.map((x) => ({ bodyId: x.bodyId, sizes: x.sizes })),
            );
            failed.push(...r.failures.map((f) => `${f.bodyId}: ${f.message}`));
          }
          return {
            request,
            sizes,
            error:
              failed.length > 0 ? `Some shapes could not be sized (${failed.join('; ')})` : null,
          };
        });
      },
      (error: unknown) => {
        if (!live) return;
        setState((before) => ({
          ...before,
          request,
          error: `The shapes could not be sized: ${error instanceof Error ? error.message : String(error)}`,
        }));
      },
    );
    return () => {
      live = false;
    };
  }, [request]);
  if (request === null) return { sizes: EMPTY_SIZES, busy: false, error: null };
  return { sizes: state.sizes, busy: state.request !== request, error: state.error };
}

const EMPTY_SIZES: ReadonlyMap<string, readonly OrientedSize[]> = new Map();

export function CutListPanel({
  documents,
  model,
  selection,
  assemblyId = null,
  sizer = null,
  createNester,
  download = downloadBytes,
  disabled = false,
  onClose,
}: CutListPanelProps) {
  const doc = useStore(documents, (s) => s.document);
  const modelDocument = useModel(model, (s) => s.document);
  const parts = useModel(model, (s) => s.parts);
  const assemblies = useModel(model, (s) => s.assemblies);
  const units = doc.units;
  const format = exactFormat(units);
  // Names and settings from the document as stored; the bodies from the model built from it.
  const source = modelDocument ?? doc;
  const oriented = useOrientedSizes(sizer, modelDocument, parts);
  const list = useMemo(
    () =>
      documentCutList({
        document: withSettings(source, doc),
        parts,
        assemblies,
        assemblyId,
        sizes: oriented.sizes,
      }),
    [source, doc, parts, assemblies, assemblyId, oriented.sizes],
  );
  const rows = useMemo(() => displayRows(list.rows, units), [list, units]);
  const labels = useMemo(() => new Map(rows.map((r) => [r.key, r])), [rows]);
  const [tab, setTab] = useState<'list' | 'layouts'>('list');
  const [sort, setSort] = useState<{ key: SortKey; descending: boolean }>({
    key: 'number',
    descending: false,
  });
  const [picked, setPicked] = useState<string | null>(null);
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);

  // Layouts in the nesting worker, again whenever the job changes.
  const { settings, error: settingsError } = useMemo(() => documentSettings(doc), [doc]);
  const stock = useMemo(() => documentStock(doc), [doc]);
  const job = useMemo(
    () => nestingJob(list, settings, stock.ok ? stock.data : undefined),
    [list, settings, stock],
  );
  const jobKey = useMemo(() => JSON.stringify(job), [job]);
  const [layouts, setLayouts] = useState<{ key: string; result: NestingResult } | null>(null);
  const [progress, setProgress] = useState<JobProgress | null>(null);
  const [layoutError, setLayoutError] = useState<string | null>(null);
  const nester = useRef<Promise<Nester> | null>(null);
  useEffect(
    () => () => {
      void nester.current?.then((n) => n.terminate());
      nester.current = null;
    },
    [],
  );
  const nothingToLayOut = job.sheets.length === 0 && job.sticks.length === 0;
  useEffect(() => {
    if (nothingToLayOut) {
      // A layout still running for the job before is not wanted any more.
      void nester.current?.then((n) => n.cancel());
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      nester.current ??= createNester ? Promise.resolve(createNester()) : defaultNester();
      setProgress({ done: 0, total: 1 });
      void nester.current
        .then((n) => n.layout(job, (p) => live && setProgress(p)))
        .then(
          (result) => {
            if (!live || result === null) return;
            setLayouts({ key: jobKey, result });
            setLayoutError(null);
            setProgress(null);
          },
          (error: unknown) => {
            if (!live) return;
            setLayoutError(error instanceof Error ? error.message : String(error));
            setProgress(null);
          },
        );
    }, 120);
    return () => {
      live = false;
      clearTimeout(timer);
    };
    // The job's content, not its identity: an equal job is not laid out again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobKey, createNester, nothingToLayOut]);
  const current: NestingResult | null = nothingToLayOut
    ? { sheets: [], sticks: [], notes: job.notes }
    : layouts !== null && layouts.key === jobKey
      ? layouts.result
      : null;

  const pick = (row: DisplayRow) => {
    setPicked(row.key);
    selection.getState().select(rowFaces(row, parts));
  };

  const warnings = [
    ...excludedLines(list, source),
    ...missingLines(list),
    ...(oriented.error ? [oriented.error] : []),
  ];

  const save = (what: 'list' | 'bom' | 'pdf') => {
    try {
      const file = cutListFile(what, list, {
        documentName: doc.name,
        units,
        layouts: current,
        notes: job.notes,
        warnings,
      });
      download(file.bytes, file.name, file.type);
      setMessage(null);
    } catch (error) {
      // The PDF writer refuses input it cannot write with a RangeError: report it, never crash.
      setMessage({
        error: true,
        text: `The file could not be written: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  };

  return (
    <aside className="selection-panel cutlist-panel" aria-label="Cut list">
      <div className="variables-head">
        <h2>Cut list</h2>
        {onClose && (
          <button type="button" data-testid="cutlist-close" onClick={onClose}>
            Close
          </button>
        )}
      </div>
      {list.configuration && (
        <p className="field-note" data-testid="cutlist-configuration">
          For the configuration {list.configuration.name}.
        </p>
      )}
      <div className="cutlist-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'list'}
          data-testid="cutlist-tab-list"
          onClick={() => setTab('list')}
        >
          Cut list
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'layouts'}
          data-testid="cutlist-tab-layouts"
          onClick={() => setTab('layouts')}
        >
          Layouts
        </button>
      </div>
      {warnings.length > 0 && (
        // Folded to its summary line: a long list of excluded bodies (reference shapes) would
        // otherwise push the table out of the panel.
        <details className="cutlist-warnings" role="alert" data-testid="cutlist-excluded">
          <summary>
            <strong>
              {list.excluded.length > 0
                ? `${list.excluded.length} ${list.excluded.length === 1 ? 'body is' : 'bodies are'} not in the cut list`
                : 'The cut list may be incomplete'}
            </strong>
          </summary>
          <ul>
            {warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </details>
      )}
      {oriented.busy && <p className="field-note">Measuring the shapes that are not boards...</p>}
      {tab === 'list' ? (
        <ListTab
          list={list}
          rows={rows}
          units={units}
          sort={sort}
          picked={picked}
          onSort={(key) =>
            setSort((s) => ({ key, descending: s.key === key ? !s.descending : false }))
          }
          onPick={pick}
        />
      ) : (
        <div className="cutlist-layouts" data-testid="cutlist-layouts">
          <SettingsEditor
            key={JSON.stringify(doc.domains?.wood ?? null)}
            doc={doc}
            units={units}
            disabled={disabled}
            error={settingsError}
            onSave={(form) => {
              const r = settingsCommand(documents.getState().document, form, units);
              if (!r.ok) return r;
              if (r.command) {
                const done = documents.getState().execute(r.command, r.label);
                if (!done.ok)
                  return { ok: false as const, errors: {}, message: done.error.message };
              }
              return r;
            }}
          />
          {progress && !nothingToLayOut && (
            <p className="field-note" data-testid="cutlist-progress">
              Laying out: {Math.round((100 * progress.done) / Math.max(1, progress.total))}%
            </p>
          )}
          {layoutError && (
            <p className="field-error" role="alert">
              The layouts could not be made: {layoutError}
            </p>
          )}
          {(current?.notes ?? job.notes).map((n, i) => (
            <p key={i} className="field-error" data-testid="cutlist-layout-note">
              {n.row && labels.get(n.row)
                ? `${labels.get(n.row)!.number}. ${labels.get(n.row)!.item}: `
                : ''}
              {n.message}
            </p>
          ))}
          {current?.sheets.map((s) => (
            <section key={s.stock} data-testid={`cutlist-sheets-${s.stock}`}>
              <h3>
                {s.name}: {s.result.totals.sheets}{' '}
                {s.result.totals.sheets === 1 ? 'sheet' : 'sheets'}
              </h3>
              <p className="field-note">
                Kerf {formatLength(settings.kerf, format)}; waste{' '}
                {s.result.totals.wastePercent.toFixed(1)}%
                {s.result.unplaced.length > 0 &&
                  `; ${s.result.unplaced.reduce((a, u) => a + u.quantity, 0)} parts do not fit a sheet`}
              </p>
              {s.result.sheets.map((sheet, i) => (
                <SheetView
                  key={i}
                  sheet={sheet}
                  title={`Sheet ${i + 1} of ${s.result.sheets.length}`}
                  labels={labels}
                  format={format}
                  highlight={picked}
                  testId="cutlist-sheet"
                />
              ))}
            </section>
          ))}
          {current?.sticks.map((s) => (
            <section key={s.stock} data-testid={`cutlist-sticks-${s.stock}`}>
              <h3>
                {s.name}: {s.result.totals.sticks}{' '}
                {s.result.totals.sticks === 1 ? 'stick' : 'sticks'}
              </h3>
              {s.result.unplaced.length > 0 && (
                <p className="field-error">
                  {s.result.unplaced.reduce((a, u) => a + u.quantity, 0)} pieces are longer than any
                  stick sold
                </p>
              )}
              {s.result.sticks.map((stick, i) => (
                <StickView
                  key={i}
                  stick={stick}
                  labels={labels}
                  format={format}
                  highlight={picked}
                />
              ))}
            </section>
          ))}
          {current && current.sheets.length === 0 && current.sticks.length === 0 && (
            <p className="field-note">Nothing to lay out.</p>
          )}
        </div>
      )}
      <div className="cutlist-files">
        <button type="button" data-testid="cutlist-csv" onClick={() => save('list')}>
          Cut list CSV
        </button>
        <button type="button" data-testid="cutlist-bom-csv" onClick={() => save('bom')}>
          BOM CSV
        </button>
        <button
          type="button"
          data-testid="cutlist-pdf"
          disabled={current === null && (job.sheets.length > 0 || job.sticks.length > 0)}
          title={current === null ? 'Waiting for the layouts' : undefined}
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

function ListTab({
  list,
  rows,
  units,
  sort,
  picked,
  onSort,
  onPick,
}: {
  list: CutList;
  rows: readonly DisplayRow[];
  units: DisplayUnits;
  sort: { key: SortKey; descending: boolean };
  picked: string | null;
  onSort: (key: SortKey) => void;
  onPick: (row: DisplayRow) => void;
}) {
  const groups = groupRows(rows, sort.key, sort.descending);
  const hardware = displayRows(list.hardware, units);
  const boardFeet = totalBoardFeet(list);
  const head = (key: SortKey, label: string) => (
    <th scope="col">
      <button
        type="button"
        className="cutlist-sort"
        data-testid={`cutlist-sort-${key}`}
        aria-sort={sort.key === key ? (sort.descending ? 'descending' : 'ascending') : undefined}
        onClick={() => onSort(key)}
      >
        {label}
        {sort.key === key ? (sort.descending ? ' ▾' : ' ▴') : ''}
      </button>
    </th>
  );
  if (rows.length === 0 && hardware.length === 0) {
    return (
      <p className="field-note" data-testid="cutlist-empty">
        No boards or wood parts yet. Boards appear here with their blank sizes; other bodies need a
        wood material.
      </p>
    );
  }
  return (
    <div className="cutlist-list">
      <table className="cutlist-table" data-testid="cutlist-table">
        <thead>
          <tr>
            {head('number', '#')}
            {head('item', 'Item')}
            {head('length', 'Size')}
            {head('quantity', 'Qty')}
            <th scope="col">Total</th>
          </tr>
        </thead>
        {groups.map((g) => (
          <tbody key={g.stock} data-testid={`cutlist-group-${g.stock || 'other'}`}>
            <tr className="cutlist-group">
              <th colSpan={5} scope="rowgroup">
                {g.title}
              </th>
            </tr>
            {g.rows.map((r) => (
              <tr
                key={r.key}
                data-testid="cutlist-row"
                data-key={r.key}
                className={picked === r.key ? 'picked' : undefined}
                onClick={() => onPick(r)}
              >
                <td>{r.number}</td>
                <td title={r.fullItem}>
                  <span data-testid="cutlist-item">{r.item}</span>
                  {r.flags.map((f) => (
                    <span key={f} className="cutlist-flag" data-testid={`cutlist-flag-${f}`}>
                      {flagText(f)}
                    </span>
                  ))}
                </td>
                <td data-testid="cutlist-size">{r.size}</td>
                <td data-testid="cutlist-qty">{r.quantity}</td>
                <td data-testid="cutlist-total">{r.extended}</td>
              </tr>
            ))}
          </tbody>
        ))}
      </table>
      {hardware.length > 0 && (
        <>
          <h3>Hardware</h3>
          <ul className="cutlist-hardware" data-testid="cutlist-hardware">
            {hardware.map((h) => (
              <li key={h.key}>
                {h.quantity} x {h.item} {h.size}
              </li>
            ))}
          </ul>
        </>
      )}
      <h3>Totals</h3>
      <ul className="cutlist-totals" data-testid="cutlist-totals">
        {totalLines(list, units).map((t) => (
          <li key={t}>{t}</li>
        ))}
        {boardFeet > 0 && (
          <li data-testid="cutlist-board-feet">{boardFeet.toFixed(2)} bd ft in all</li>
        )}
      </ul>
    </div>
  );
}

function SettingsEditor({
  doc,
  units,
  disabled,
  error,
  onSave,
}: {
  doc: ManufaktureDocument;
  units: DisplayUnits;
  disabled: boolean;
  error: string | null;
  onSave: (form: SettingsForm) => ReturnType<typeof settingsCommand>;
}) {
  const [form, setForm] = useState(() => settingsForm(doc));
  const [errors, setErrors] = useState<Partial<Record<keyof SettingsForm, string>>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const set = (patch: Partial<SettingsForm>) => setForm((f) => ({ ...f, ...patch }));
  const save = () => {
    const r = onSave(form);
    if (!r.ok) {
      setErrors(r.errors);
      setFailure(r.message ?? null);
    } else {
      setErrors({});
      setFailure(null);
    }
  };
  const length = (key: 'kerf' | 'sheetTrim' | 'lumberTrim', label: string, note: string) => (
    <ExpressionField
      label={label}
      testId={`cutlist-${key}`}
      value={form[key]}
      kind="length"
      units={units}
      variables={NO_VARIABLES}
      names={[]}
      error={errors[key]}
      onChange={(v) => set({ [key]: v })}
      previewTestId={`cutlist-${key}-note`}
      validate={(v) => (v < 0 ? note : null)}
    />
  );
  return (
    <details className="cutlist-settings" data-testid="cutlist-settings">
      <summary>Saw and layout settings</summary>
      {error && <p className="field-error">{error}</p>}
      <div
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') {
            e.preventDefault();
            save();
          }
        }}
      >
        <p className="field-note">Empty fields use the defaults: a 1/8&quot; kerf, no trims.</p>
        {length('kerf', 'Kerf', 'A kerf of zero or more.')}
        {length('sheetTrim', 'Sheet edge trim', 'A trim of zero or more.')}
        {length('lumberTrim', 'Lumber end trim', 'A trim of zero or more.')}
        {trimNotes(doc).map((note) => (
          <p key={note} className="field-note" data-testid="cutlist-trim-note">
            {note}
          </p>
        ))}
        <label className="dialog-field">
          Stages
          <select
            data-testid="cutlist-stages"
            value={form.maxStages}
            onChange={(e) => set({ maxStages: e.target.value })}
          >
            <option value="2">2 (rip, then crosscut)</option>
            <option value="3">3</option>
            <option value="unlimited">Unlimited</option>
            {!['2', '3', 'unlimited'].includes(form.maxStages) && (
              <option value={form.maxStages}>{form.maxStages}</option>
            )}
          </select>
        </label>
        <label className="dialog-field">
          Grain
          <select
            data-testid="cutlist-grain"
            value={form.grain}
            onChange={(e) => set({ grain: e.target.value as SettingsForm['grain'] })}
          >
            <option value="respect">Parts follow the sheet&apos;s grain</option>
            <option value="ignore">Parts may turn</option>
          </select>
        </label>
        {errors.maxStages && <p className="field-error">{errors.maxStages}</p>}
        {failure && (
          <p className="field-error" role="alert">
            {failure}
          </p>
        )}
        <div className="dialog-buttons">
          <button
            type="button"
            className="primary"
            data-testid="cutlist-settings-save"
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
