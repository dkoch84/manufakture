// The Board dialog (M4 plan T4.1d): a board cut from real stock, as a panel (a sketch region
// extruded by the stock's thickness, with a grain direction in the sketch plane) or a stick (the
// stock's section along a sketch line, turned and justified about it). While it is open the
// viewport shows the board it would build, with its grain arrow, computed on the main thread with
// the domain's own translator. OK applies the whole dialog as one core command (one undo step),
// with the body's material from the stock; Cancel or Escape leaves the document alone. The logic
// is in boards.ts.

import { findPart, type DisplayUnits, type ExtensionFeature } from '@manufakture/core';
import { resolveStock, type Justify } from '@manufakture/domain-wood';
import type { Vec3 } from '@manufakture/kernel';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ExpressionField } from '../components/ExpressionField';
import { featureResult, type ModelStore } from '../model/model';
import type { DocumentStoreApi } from '../state/document';
import type { SelectionStore } from '../state/selection';
import { evaluateVariables } from '../sketcher/values';
import {
  blankEdges,
  boardFormOf,
  boardSketches,
  buildBoard,
  documentRegion,
  documentStock,
  grainArrows,
  isBoard,
  newBoardForm,
  previewFrame,
  sizeText,
  sketchLines,
  withForm,
  type BoardForm,
  type GrainChoice,
} from './boards';
import { StockPicker } from './StockPicker';
import './wood.css';

export interface BoardDialogProps {
  /** Edit this board; absent for a new one. */
  featureId?: string | undefined;
  documents: DocumentStoreApi;
  model: ModelStore;
  selection: SelectionStore;
  /** The part studio the board is in; default: the active one when the dialog opens. */
  partId?: string;
  /** Draws the board the dialog would build (polylines in world coordinates); [] clears it. */
  onPreview?: (lines: Vec3[][]) => void;
  onClose: () => void;
}

const JUSTIFY_OPTIONS: Record<'thickness' | 'width', readonly [Justify, string][]> = {
  thickness: [
    ['centre', 'Centred on the line'],
    ['positive', 'On the left of the line'],
    ['negative', 'On the right of the line'],
  ],
  width: [
    ['centre', 'Centred on the line'],
    ['positive', 'Above the sketch plane'],
    ['negative', 'Below the sketch plane'],
  ],
};

export function BoardDialog({
  featureId,
  documents,
  model,
  selection,
  partId: givenPartId,
  onPreview,
  onClose,
}: BoardDialogProps) {
  const [partId] = useState(() => givenPartId ?? documents.getState().activePartId);
  const doc = documents.getState().document;
  const part = findPart(doc, partId)!;
  const found = featureId ? part.features.find((f) => f.id === featureId) : undefined;
  const existing: ExtensionFeature | undefined = found && isBoard(found) ? found : undefined;
  const units = doc.units;
  // The document is fixed for the dialog's life (nothing else edits it while a dialog is open).
  const variables = evaluateVariables(doc);
  const names = doc.variables.map((v) => v.name);

  const opened = existing ? boardFormOf(existing) : null;
  const [form, setForm] = useState<BoardForm>(() => {
    if (opened?.ok) return opened.form;
    const selected = selection
      .getState()
      .selected.filter((i) => i.kind === 'feature')
      .map((i) => i.id);
    return newBoardForm(doc, partId, selected);
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const unreadable = opened !== null && !opened.ok ? opened.message : null;

  const index = existing
    ? part.features.indexOf(existing)
    : (part.rollbackIndex ?? part.features.length);
  const sketches = boardSketches(part, index);
  const sketch = sketches.find((s) => s.id === form.sketch);
  const lines = sketchLines(sketch);
  const stock = documentStock(doc);
  const stockData = stock.ok ? stock.data : undefined;
  const resolved = resolveStock(form.stock, stockData);
  const title = existing?.name ?? 'New board';

  // The preview: the blank the form would build, and its grain arrow when the stock has one.
  const placement = featureResult(model.getState(), partId, form.sketch)?.placement;
  const frame = unreadable
    ? null
    : previewFrame(form, { doc, partId, placement, stock: stockData });
  const grain = resolved?.entry.grain ?? false;
  // Drawn again only when what it shows changes, not on every render.
  const previewKey = JSON.stringify([frame, grain]);
  useEffect(() => {
    if (!onPreview) return;
    const [f, g] = JSON.parse(previewKey) as [typeof frame, boolean];
    onPreview(f ? [...blankEdges(f), ...(g ? grainArrows(f) : [])] : []);
  }, [onPreview, previewKey]);
  useEffect(() => () => onPreview?.([]), [onPreview]);

  // Focus moves in on open and goes back on close, unless the user put it somewhere else.
  const dialogRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const opener = document.activeElement;
    const dialog = dialogRef.current;
    dialog?.focus();
    return () => {
      const now = document.activeElement;
      const inside = now === null || now === document.body || (dialog?.contains(now) ?? false);
      if (inside && opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);

  const set = (patch: Partial<BoardForm>) => {
    setForm((f) => ({ ...f, ...patch }));
    setErrors((e) => {
      const next = { ...e };
      for (const k of Object.keys(patch)) delete next[k];
      delete next.form;
      return next;
    });
  };

  const apply = () => {
    if (unreadable) return;
    const current = documents.getState().document;
    const r = buildBoard(
      form,
      existing ? { doc: current, partId, existing } : { doc: current, partId },
    );
    if (!r.ok) {
      setErrors(r.errors);
      return;
    }
    const done = documents.getState().execute(r.command, r.label);
    if (!done.ok) {
      setErrors({ form: done.error.message });
      return;
    }
    onClose();
  };

  const expression = (
    key: 'grainAngle' | 'rotation' | 'length' | 'width',
    label: string,
    kind: 'length' | 'angle',
  ) => (
    <ExpressionField
      key={key}
      label={label}
      testId={`field-${key}`}
      value={form[key]}
      kind={kind}
      units={units}
      variables={variables}
      names={names}
      error={errors[key]}
      onChange={(v) => set({ [key]: v })}
    />
  );

  const body: ReactNode[] = [];
  if (unreadable) {
    body.push(
      <p key="unreadable" className="field-error" role="alert">
        This board cannot be edited here: {unreadable}
      </p>,
    );
  } else {
    body.push(
      <Select
        key="form"
        label="Board"
        name="form"
        value={form.form}
        options={[
          ['panel', 'Panel: a sketch region, the stock thick'],
          ['stick', 'Stick: the stock along a sketch line'],
        ]}
        onChange={(v) => {
          setForm((f) => withForm(f, v as BoardForm['form'], documentRegion(units)));
          setErrors({});
        }}
      />,
      <Select
        key="sketch"
        label="Sketch"
        name="sketch"
        value={form.sketch}
        error={errors.sketch}
        options={[
          ...(sketch ? [] : ([[form.sketch, form.sketch || 'Choose a sketch']] as const)),
          ...sketches.map((s) => [s.id, s.name] as const),
        ]}
        onChange={(v) => {
          const next = sketches.find((s) => s.id === v);
          const first = sketchLines(next)[0]?.id ?? '';
          setForm((f) => {
            const { entities: _old, ...rest } = f;
            void _old;
            return { ...rest, sketch: v, line: first, grainLine: first };
          });
          setErrors({});
        }}
      />,
      <StockPicker
        key={`stock/${form.form}`}
        value={form.stock}
        units={units}
        form={form.form}
        error={errors.stock}
        onChange={(v) => set({ stock: v })}
      />,
    );
    if (resolved) body.push(<StockSummary key="summary" units={units} resolved={resolved} />);
    if (form.form === 'panel') {
      body.push(
        <Select
          key="grain"
          label="Grain"
          name="grain"
          value={form.grain}
          options={[
            ['longest', 'Along the longest side'],
            ['line', 'Along a line of the sketch'],
            ['angle', 'At an angle'],
          ]}
          error={errors.grain}
          onChange={(v) => set({ grain: v as GrainChoice })}
        />,
      );
      if (form.grain === 'line') {
        body.push(
          <Select
            key="grainLine"
            label="Grain line"
            name="grainLine"
            value={form.grainLine}
            options={lines.map((l) => [l.id, l.label] as const)}
            error={errors.grainLine}
            onChange={(v) => set({ grainLine: v })}
          />,
        );
      }
      if (form.grain === 'angle') {
        body.push(expression('grainAngle', 'Grain angle (from the sketch x axis)', 'angle'));
      }
      if (resolved && !resolved.entry.grain) {
        body.push(
          <p key="nograin" className="field-note">
            {resolved.entry.name} has no grain: the direction only sets which side the cut list
            calls the length.
          </p>,
        );
      }
      body.push(
        <Check
          key="flip"
          label="Opposite side of the sketch"
          checked={form.flip}
          onChange={(v) => set({ flip: v })}
        />,
      );
    } else {
      body.push(
        <Select
          key="line"
          label="Line"
          name="line"
          value={form.line}
          options={
            lines.length > 0
              ? lines.map((l) => [l.id, l.label] as const)
              : [['', 'The sketch has no lines']]
          }
          error={errors.line}
          onChange={(v) => set({ line: v })}
        />,
        expression('rotation', 'Rotation about the line (optional)', 'angle'),
        <Select
          key="justifyThickness"
          label="Thickness"
          name="justifyThickness"
          value={form.justifyThickness}
          options={JUSTIFY_OPTIONS.thickness}
          error={errors.justifyThickness}
          onChange={(v) => set({ justifyThickness: v as Justify })}
        />,
        <Select
          key="justifyWidth"
          label="Width"
          name="justifyWidth"
          value={form.justifyWidth}
          options={JUSTIFY_OPTIONS.width}
          error={errors.justifyWidth}
          onChange={(v) => set({ justifyWidth: v as Justify })}
        />,
        expression('length', "Length (optional: the line's)", 'length'),
        expression('width', "Width (optional: the stock's)", 'length'),
      );
    }
    body.push(
      <p key="preview" className="field-note" data-testid="board-preview">
        {frame
          ? `Blank: ${sizeText(frame.size.length, units)} x ${sizeText(frame.size.width, units)} x ${sizeText(frame.size.thickness, units)} (length along the grain, width, thickness), shown in the view.`
          : 'The board is shown in the view once its sketch is solved and the dialog is filled in.'}
      </p>,
    );
  }

  return (
    <aside
      ref={dialogRef}
      tabIndex={-1}
      className="selection-panel feature-dialog board-dialog"
      role="dialog"
      aria-label={`Board: ${title}`}
      data-testid="feature-dialog"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        } else if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') {
          e.preventDefault();
          apply();
        }
      }}
    >
      <h2>Board: {title}</h2>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          apply();
        }}
      >
        {body}
        {errors.form && (
          <p className="field-error" role="alert">
            {errors.form}
          </p>
        )}
        <div className="dialog-buttons">
          {!unreadable && (
            <button type="submit" className="primary" data-testid="dialog-ok">
              OK
            </button>
          )}
          <button type="button" onClick={onClose}>
            {unreadable ? 'Close' : 'Cancel'}
          </button>
        </div>
      </form>
    </aside>
  );
}

/** The chosen stock's real sizes in the document, marking what the document overrides. */
function StockSummary({
  units,
  resolved,
}: {
  units: DisplayUnits;
  resolved: NonNullable<ReturnType<typeof resolveStock>>;
}) {
  const { entry, overridden } = resolved;
  const parts = [
    `${sizeText(resolved.thickness, units)} thick${overridden.thickness ? ' (measured)' : ''}`,
  ];
  if (resolved.width !== undefined) {
    parts.push(`${sizeText(resolved.width, units)} wide${overridden.width ? ' (measured)' : ''}`);
  } else if (entry.kind === 'lumber') parts.push('random widths');
  if (resolved.sheet) {
    parts.push(
      `sheets ${sizeText(resolved.sheet.length, units)} x ${sizeText(resolved.sheet.width, units)}`,
    );
  }
  return (
    <p className="field-note" data-testid="stock-summary">
      {entry.name}: {parts.join(', ')}.
    </p>
  );
}

function Select({
  label,
  name,
  value,
  options,
  error,
  onChange,
}: {
  label: string;
  name: string;
  value: string;
  options: readonly (readonly [string, string])[];
  error?: string | undefined;
  onChange: (value: string) => void;
}) {
  return (
    <div className="dialog-field">
      <label>
        {label}
        <select
          value={value}
          data-testid={`field-${name}`}
          aria-invalid={error !== undefined}
          onChange={(e) => onChange(e.target.value)}
        >
          {options.map(([v, text]) => (
            <option key={v} value={v}>
              {text}
            </option>
          ))}
        </select>
      </label>
      {error && <span className="field-error">{error}</span>}
    </div>
  );
}

function Check({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="dialog-check">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}
