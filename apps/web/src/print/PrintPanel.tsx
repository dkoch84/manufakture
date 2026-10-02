// The print workspace's side panel (M3 plan, T3.1d): the document's print setups (pick, add,
// rename, delete), the printer and nozzle pickers, the thresholds as expressions, the items with
// their part and body pickers and copies, the bed-fit summary and the Issues list. Every change
// is one core command, so one undo step; the panel holds only drafts.
//
// An item whose body or lay-flat face is gone shows `reference-lost` with the missing name and a
// re-pick: another body from the picker, or Lay flat again (ADR 0012 decision 2).
//
// Below the items, Export for printing and Open in slicer (`PrintExport`, T3.3b).

import {
  bareUnits,
  type Command,
  type DisplayUnits,
  type ManufaktureDocument,
  type PrintItem,
  type PrintSetup,
  type StoredExpression,
} from '@manufakture/core';
import {
  DEFAULT_OVERHANG_THRESHOLD,
  PRINTERS,
  findPrinter,
  overhangToSupportThreshold,
  printThresholds,
} from '@manufakture/print';
import { useMemo, useState } from 'react';
import { useStore } from 'zustand';
import { ExpressionField } from '../components/ExpressionField';
import { analyzeExpression, formatKind } from '../components/expression';
import { partBodies } from '../model/bodies';
import type { PartModel } from '../model/model';
import type { Variables } from '../sketcher/values';
import type { DocumentStoreApi } from '../state/document';
import type { AnalysisState } from './analysis';
import { addItemCommand, addSetupCommand, editItemCommand, editSetupCommand } from './commands';
import { IssuesList } from './IssuesList';
import { PrintExport, type PrintExporter } from './PrintExport';
import type { PrintIssue } from './issues';
import { printVariables, type ResolvedSetup } from './resolve';
import { activeItemId, activeSetup, type PrintUiStore } from './state';
import { OVERHANG_COLORS, THICKNESS_COLORS } from '../viewport/printView';

export interface PrintPanelProps {
  documents: DocumentStoreApi;
  printUi: PrintUiStore;
  /** The regenerated parts, for the body pickers. */
  parts: readonly PartModel[];
  /** The active setup resolved against the model; null when there is no setup. */
  resolved: ResolvedSetup | null;
  issues: readonly PrintIssue[];
  analysis: AnalysisState;
  onIssue: (issue: PrintIssue | null) => void;
  /** Meshes and regens for Export for printing; null or absent: export is not available. */
  exporter?: PrintExporter | null;
  disabled?: boolean;
  /** The model is regenerating: export waits for it (see `PrintExport`). */
  modelPending?: boolean;
  /** Told when an export from the panel starts and ends. */
  onExportBusy?: (busy: boolean) => void;
}

type ThresholdKey = 'overhang' | 'minWall' | 'minGap' | 'minHole' | 'teardrop';

const THRESHOLDS: readonly {
  key: ThresholdKey;
  label: string;
  kind: 'angle' | 'length';
  note: string;
}[] = [
  {
    key: 'overhang',
    label: 'Overhang angle',
    kind: 'angle',
    note: 'measured from vertical; OrcaSlicer states the same limit from horizontal',
  },
  { key: 'minWall', label: 'Minimum wall', kind: 'length', note: 'two line widths, an estimate' },
  { key: 'minGap', label: 'Minimum gap', kind: 'length', note: 'an estimate' },
  { key: 'minHole', label: 'Minimum hole', kind: 'length', note: 'two nozzle widths, an estimate' },
  {
    key: 'teardrop',
    label: 'Teardrop size',
    kind: 'length',
    note: 'horizontal holes above it need a teardrop or support; an estimate',
  },
];

/** A threshold's default, formatted, for the field's note. */
function defaultText(key: ThresholdKey, nozzle: number, units: DisplayUnits): string {
  if (key === 'overhang') return formatKind(DEFAULT_OVERHANG_THRESHOLD, 'angle', units);
  return formatKind(printThresholds(nozzle)[key], 'length', units);
}

function orientationText(item: PrintItem): string {
  const o = item.orientation;
  if (o.kind === 'asModelled') return 'As modelled';
  if (o.kind === 'layFlat') {
    return `Flat on ${o.face.ref.face}${o.turn ? `, turned ${o.turn.source}` : ''}`;
  }
  return `Turned x ${o.x.source}, y ${o.y.source}, z ${o.z.source}`;
}

export function PrintPanel({
  documents,
  printUi,
  parts,
  resolved,
  issues,
  analysis,
  onIssue,
  exporter = null,
  disabled = false,
  modelPending = false,
  onExportBusy,
}: PrintPanelProps) {
  const doc = useStore(documents, (s) => s.document);
  const setupId = useStore(printUi, (s) => s.setupId);
  const itemId = useStore(printUi, (s) => s.itemId);
  const focus = useStore(printUi, (s) => s.focus);
  const message = useStore(printUi, (s) => s.message);
  const shading = useStore(printUi, (s) => s.shading);
  const setup = activeSetup(doc, setupId);
  const activeItem = activeItemId(setup, itemId);

  const run: Run = (command, label) => {
    const r = documents.getState().execute(command, label);
    printUi.getState().setMessage(r.ok ? null : r.error.message);
    return r.ok;
  };

  const addSetup = () => {
    const { command, setupId: id } = addSetupCommand(doc);
    if (run(command, 'Add print setup')) printUi.getState().setSetup(id);
  };

  return (
    <aside className="selection-panel print-panel" aria-label="Print" data-testid="print-panel">
      <div className="print-head">
        <h2>Print</h2>
        {doc.print.setups.length > 0 && (
          <select
            aria-label="Print setup"
            data-testid="print-setup-select"
            value={setup?.id ?? ''}
            disabled={disabled}
            onChange={(e) => printUi.getState().setSetup(e.target.value)}
          >
            {doc.print.setups.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        )}
        <button type="button" data-testid="print-add-setup" disabled={disabled} onClick={addSetup}>
          New setup
        </button>
      </div>
      {message && (
        <p className="field-error" role="alert" data-testid="print-message">
          {message}
        </p>
      )}
      {!setup ? (
        <p className="field-note" data-testid="print-empty">
          No print setup yet. A setup names a printer and nozzle and the bodies to print, each
          oriented on the bed. <strong>New setup</strong> starts one on a Bambu Lab X1 Carbon with a
          0.4 mm nozzle.
        </p>
      ) : (
        <SetupEditor
          key={setup.id}
          doc={doc}
          setup={setup}
          parts={parts}
          resolved={resolved?.setup.id === setup.id ? resolved : null}
          activeItem={activeItem}
          disabled={disabled}
          run={run}
          printUi={printUi}
        />
      )}
      {setup && resolved?.setup.id === setup.id && (
        <PrintExport
          doc={doc}
          resolved={resolved}
          issues={issues}
          exporter={exporter}
          disabled={disabled}
          modelPending={modelPending}
          {...(onExportBusy ? { onBusy: onExportBusy } : {})}
        />
      )}
      {setup && resolved && (
        <>
          <IssuesList
            issues={issues}
            focus={focus}
            analysis={analysis}
            checking={resolved.printer !== null && resolved.items.some((i) => i.copies.length > 0)}
            onPick={onIssue}
          />
          <Legend shading={shading} />
        </>
      )}
    </aside>
  );
}

function Legend({ shading }: { shading: 'normal' | 'overhang' | 'thickness' }) {
  if (shading === 'normal') return null;
  const rows =
    shading === 'overhang'
      ? [
          [OVERHANG_COLORS.downwardFlat, 'Flat ceiling'],
          [OVERHANG_COLORS.overhang, 'Overhang'],
          [OVERHANG_COLORS.steep, 'Near the limit'],
          [OVERHANG_COLORS.onBed, 'On the bed'],
        ]
      : [
          [THICKNESS_COLORS.belowMinFeature, 'Too thin to print'],
          [THICKNESS_COLORS.thin, 'Thin wall'],
          [THICKNESS_COLORS.near, 'Near the minimum'],
          [THICKNESS_COLORS.ok, 'Thick enough'],
        ];
  return (
    <ul className="print-legend" aria-label="Colours" data-testid="print-legend">
      {rows.map(([color, label]) => (
        <li key={label}>
          <span className="print-swatch" style={{ background: color }} aria-hidden="true" />
          {label}
        </li>
      ))}
    </ul>
  );
}

type Run = (command: Command, label: string) => boolean;

interface SetupEditorProps {
  doc: ManufaktureDocument;
  setup: PrintSetup;
  parts: readonly PartModel[];
  resolved: ResolvedSetup | null;
  activeItem: string | null;
  disabled: boolean;
  run: Run;
  printUi: PrintUiStore;
}

function SetupEditor({
  doc,
  setup,
  parts,
  resolved,
  activeItem,
  disabled,
  run,
  printUi,
}: SetupEditorProps) {
  const [name, setName] = useState(setup.name);
  const printer = findPrinter(setup.printer);
  const units = doc.units;
  // The same evaluation `resolveSetup` uses: the active configuration's values.
  const variables = useMemo(() => printVariables(doc), [doc]);

  const commitName = () => {
    const text = name.trim();
    if (text === setup.name || text === '') {
      setName(setup.name);
      return;
    }
    if (!run(editSetupCommand(setup.id, { name: text }), 'Rename print setup')) setName(setup.name);
  };

  // Bed fit is per item (one copy alone on the plate); the plate note is separate and advisory.
  const fits = resolved?.items.flatMap((i) => (i.fit ? [i.fit] : [])) ?? [];
  const failing = fits.filter((f) => !f.fits).length;

  return (
    <>
      <div className="print-setup">
        <label className="print-field">
          <span>Name</span>
          <input
            type="text"
            data-testid="print-setup-name"
            value={name}
            disabled={disabled}
            onChange={(e) => setName(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitName();
              if (e.key === 'Escape') setName(setup.name);
            }}
          />
        </label>
        <label className="print-field">
          <span>Printer</span>
          <select
            data-testid="print-printer"
            value={setup.printer}
            disabled={disabled}
            onChange={(e) => {
              const next = findPrinter(e.target.value);
              if (!next) return;
              const keep = next.nozzles.some((n) => Math.abs(n - setup.nozzle) < 1e-9);
              run(
                editSetupCommand(setup.id, {
                  printer: next.id,
                  ...(keep ? {} : { nozzle: next.defaultNozzle }),
                }),
                `Print on ${next.name}`,
              );
            }}
          >
            {!printer && <option value={setup.printer}>Unknown: {setup.printer}</option>}
            {PRINTERS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label className="print-field">
          <span>Nozzle</span>
          <select
            data-testid="print-nozzle"
            value={String(setup.nozzle)}
            disabled={disabled}
            onChange={(e) =>
              run(
                editSetupCommand(setup.id, { nozzle: Number(e.target.value) }),
                `${e.target.value} mm nozzle`,
              )
            }
          >
            {(printer?.nozzles ?? []).every((n) => Math.abs(n - setup.nozzle) > 1e-9) && (
              <option value={String(setup.nozzle)}>{setup.nozzle} mm</option>
            )}
            {(printer?.nozzles ?? []).map((n) => (
              <option key={n} value={String(n)}>
                {n} mm
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="print-delete-setup"
          data-testid="print-delete-setup"
          disabled={disabled}
          onClick={() => {
            if (run({ type: 'deletePrintSetup', setupId: setup.id }, `Delete ${setup.name}`)) {
              printUi.getState().setSetup(null);
            }
          }}
        >
          Delete setup
        </button>
      </div>
      {resolved?.problems.map((p) => (
        <p key={p} className="field-error" role="alert" data-testid="print-setup-problem">
          {p}
        </p>
      ))}
      {resolved && printer && fits.length > 0 && (
        <p
          className={failing > 0 ? 'print-fit print-fit-fails' : 'print-fit'}
          role="status"
          data-testid="print-bed-fit"
          data-fits={failing === 0 ? 'true' : 'false'}
        >
          {failing === 0
            ? `Fits the ${printer.name}'s bed.`
            : `${failing === fits.length ? 'Does' : `${failing} of ${fits.length} items do`} not fit the ${printer.name}'s bed.`}
        </p>
      )}
      {resolved?.plateNote && (
        <p className="print-fit-note" data-testid="print-plate-note">
          {resolved.plateNote}
        </p>
      )}
      <Thresholds
        key={JSON.stringify(setup.thresholds ?? null)}
        setup={setup}
        units={units}
        variables={variables}
        disabled={disabled}
        run={run}
      />
      <Items
        doc={doc}
        setup={setup}
        parts={parts}
        resolved={resolved}
        activeItem={activeItem}
        disabled={disabled}
        run={run}
        printUi={printUi}
      />
    </>
  );
}

function Thresholds({
  setup,
  units,
  variables,
  disabled,
  run,
}: {
  setup: PrintSetup;
  units: DisplayUnits;
  variables: Variables;
  disabled: boolean;
  run: Run;
}) {
  const initial = Object.fromEntries(
    THRESHOLDS.map((t) => [t.key, setup.thresholds?.[t.key]?.source ?? '']),
  ) as Record<ThresholdKey, string>;
  const [drafts, setDrafts] = useState(initial);
  const changed = THRESHOLDS.some((t) => drafts[t.key] !== initial[t.key]);
  const errors = THRESHOLDS.some(
    (t) => analyzeExpression(drafts[t.key], t.kind, units, variables).state === 'error',
  );
  const apply = () => {
    const out: Partial<Record<ThresholdKey, StoredExpression>> = {};
    for (const t of THRESHOLDS) {
      const text = drafts[t.key].trim();
      if (text === '') continue;
      // Unchanged text keeps the units it was stored with.
      const before = setup.thresholds?.[t.key];
      out[t.key] =
        before && before.source === text ? before : { source: text, ...bareUnits(units) };
    }
    const thresholds = Object.keys(out).length === 0 ? null : out;
    run(editSetupCommand(setup.id, { thresholds }), 'Change print thresholds');
  };
  return (
    <details className="print-thresholds" data-testid="print-thresholds">
      <summary>Thresholds</summary>
      <p className="field-note">
        Empty fields use the defaults for the printer and nozzle. Most are estimates: a part past
        them may print badly, not certainly fail.
      </p>
      {THRESHOLDS.map((t) => (
        <div key={t.key} className="print-threshold">
          <ExpressionField
            label={t.label}
            value={drafts[t.key]}
            onChange={(v) => setDrafts((d) => ({ ...d, [t.key]: v }))}
            kind={t.kind}
            units={units}
            variables={variables}
            testId={`print-threshold-${t.key}`}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && changed && !errors) apply();
            }}
          />
          <p className="field-note">
            Default {defaultText(t.key, setup.nozzle, units)}: {t.note}
            {t.key === 'overhang' &&
              ` (its support threshold angle ${formatKind(overhangToSupportThreshold(DEFAULT_OVERHANG_THRESHOLD), 'angle', units)} is 90° minus this)`}
            .
          </p>
        </div>
      ))}
      <div className="dialog-buttons">
        <button
          type="button"
          className="primary"
          data-testid="print-thresholds-apply"
          disabled={disabled || !changed || errors}
          onClick={apply}
        >
          Apply
        </button>
        <button
          type="button"
          data-testid="print-thresholds-reset"
          disabled={disabled || !changed}
          onClick={() => setDrafts(initial)}
        >
          Reset
        </button>
      </div>
    </details>
  );
}

function Items({
  doc,
  setup,
  parts,
  resolved,
  activeItem,
  disabled,
  run,
  printUi,
}: SetupEditorProps) {
  const [partId, setPartId] = useState(doc.parts[0]?.id ?? '');
  const [bodyId, setBodyId] = useState('');
  const part = doc.parts.find((p) => p.id === partId) ?? doc.parts[0];
  const bodiesOf = (id: string) =>
    partBodies(
      doc.parts.find((p) => p.id === id),
      parts.find((m) => m.partId === id),
    );
  const bodies = part ? bodiesOf(part.id) : [];

  const add = () => {
    if (!part) return;
    const { command, itemId } = addItemCommand(doc, setup.id, part.id, bodyId || undefined);
    if (run(command, `Print ${part.name}`)) {
      printUi.getState().setItem(itemId);
      setBodyId('');
    }
  };

  return (
    <section className="print-items" aria-label="Items">
      <h3>Items</h3>
      {setup.items.length === 0 && (
        <p className="field-note">Nothing to print yet: add a part studio or one of its bodies.</p>
      )}
      <ul className="print-item-list" data-testid="print-item-list">
        {setup.items.map((item) => {
          const r = resolved?.items.find((x) => x.item.id === item.id);
          const status = r?.status ?? 'pending';
          const choices = bodiesOf(item.part);
          return (
            <li
              key={item.id}
              className={`print-item${item.id === activeItem ? ' active' : ''}`}
              data-testid={`print-item-${item.id}`}
              data-status={status}
            >
              <button
                type="button"
                className="print-item-pick"
                aria-pressed={item.id === activeItem}
                title="The orientation tools act on this item"
                onClick={() => printUi.getState().setItem(item.id)}
              >
                <span className="print-item-name">{r?.label ?? item.part}</span>
                <span className="print-item-orientation">{orientationText(item)}</span>
              </button>
              {r?.message && (
                <span
                  className={`print-item-message print-item-${status}`}
                  data-testid={`print-item-${item.id}-message`}
                >
                  {status === 'reference-lost' ? 'Reference lost: ' : ''}
                  {r.message}
                </span>
              )}
              <div className="print-item-actions">
                <label>
                  <span>Body</span>
                  <select
                    aria-label="Body"
                    data-testid={`print-item-${item.id}-body`}
                    value={item.body ?? ''}
                    disabled={disabled}
                    onChange={(e) => {
                      const { body: _old, ...rest } = item;
                      void _old;
                      const next: PrintItem = e.target.value
                        ? { ...rest, body: e.target.value }
                        : rest;
                      run(editItemCommand(setup.id, next), 'Change print item');
                    }}
                  >
                    <option value="">All bodies</option>
                    {item.body !== undefined && !choices.some((b) => b.bodyId === item.body) && (
                      <option value={item.body}>Missing: {item.body}</option>
                    )}
                    {choices.map((b) => (
                      <option key={b.bodyId} value={b.bodyId}>
                        {b.name}
                      </option>
                    ))}
                  </select>
                </label>
                <CopiesField item={item} setupId={setup.id} disabled={disabled} run={run} />
                {status === 'reference-lost' && item.orientation.kind === 'layFlat' && (
                  <button
                    type="button"
                    data-testid={`print-item-${item.id}-repick`}
                    disabled={disabled}
                    onClick={() => {
                      printUi.getState().setItem(item.id);
                      printUi.getState().setLayingFlat(true);
                    }}
                  >
                    Pick a face
                  </button>
                )}
                <button
                  type="button"
                  data-testid={`print-item-${item.id}-remove`}
                  disabled={disabled}
                  onClick={() =>
                    run(
                      { type: 'deletePrintItem', setupId: setup.id, itemId: item.id },
                      'Remove print item',
                    )
                  }
                >
                  Remove
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      <div className="print-add-item">
        <select
          aria-label="Part studio"
          data-testid="print-add-part"
          value={part?.id ?? ''}
          disabled={disabled}
          onChange={(e) => {
            setPartId(e.target.value);
            setBodyId('');
          }}
        >
          {doc.parts.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <select
          aria-label="Body to print"
          data-testid="print-add-body"
          value={bodyId}
          disabled={disabled}
          onChange={(e) => setBodyId(e.target.value)}
        >
          <option value="">All bodies</option>
          {bodies.map((b) => (
            <option key={b.bodyId} value={b.bodyId}>
              {b.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          data-testid="print-add-item"
          disabled={disabled || !part}
          onClick={add}
        >
          Add item
        </button>
      </div>
    </section>
  );
}

/**
 * How many copies of an item. A draft while typing (so the field can be cleared and retyped);
 * committed as one command, one undo step, on blur or Enter, like the app's other numeric
 * fields. Escape, or a value that is not a whole number from 1 to 1000, puts the stored one back.
 * A new stored count (a commit, an undo) replaces the draft in place: the field is not mounted
 * again, so Enter keeps the focus in it.
 */
function CopiesField({
  item,
  setupId,
  disabled,
  run,
}: {
  item: PrintItem;
  setupId: string;
  disabled: boolean;
  run: Run;
}) {
  const stored = item.copies ?? 1;
  const [draft, setDraft] = useState(String(stored));
  const [shown, setShown] = useState(stored);
  if (shown !== stored) {
    setShown(stored);
    setDraft(String(stored));
  }
  const commit = () => {
    const n = Number(draft.trim());
    if (draft.trim() === '' || !Number.isInteger(n) || n < 1 || n > 1000 || n === stored) {
      setDraft(String(stored));
      return;
    }
    const { copies: _old, ...rest } = item;
    void _old;
    if (!run(editItemCommand(setupId, n === 1 ? rest : { ...rest, copies: n }), 'Change copies')) {
      setDraft(String(stored));
    }
  };
  return (
    <label>
      <span>Copies</span>
      <input
        type="number"
        min={1}
        max={1000}
        step={1}
        data-testid={`print-item-${item.id}-copies`}
        value={draft}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') setDraft(String(stored));
        }}
      />
    </label>
  );
}
