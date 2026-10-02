// The drawing workspace's side panels (M4 plan, T4.4g): the New drawing form, Insert view, the
// sheet's settings and title block, the selected view or note, the dimensions with their status
// (lost ones in red, with a re-pick), and what regen said of the sheet. Every change is one
// undoable command; text fields commit on Enter or when they lose focus.

import {
  SHEET_SIZES,
  STANDARD_VIEW_NAMES,
  storedExpression,
  type Command,
  type DisplayUnits,
  type Drawing,
  type DrawingView,
  type ManufaktureDocument,
  type Note,
  type Sheet,
  type SheetSize,
  type StandardViewName,
  type ViewDirection,
  type ViewSource,
} from '@manufakture/core';
import type { DisplayList } from '@manufakture/drawing';
import type { DrawingSheetResult } from '@manufakture/regen';
import { useState } from 'react';
import {
  DIMENSION_KIND_LABELS,
  SHEET_SIZE_LABELS,
  TITLE_FIELDS,
  VIEW_DIRECTION_LABELS,
  parseScaleText,
  scaleText,
  sourceLabel,
  titleValues,
  dimensionText,
  sheetMessages,
  viewSources,
  type Owner,
  type ProjectionSide,
} from './model';

/** A text field that commits on Enter or blur, when its text changed; Escape puts it back. */
export function CommitInput({
  value,
  onCommit,
  testId,
  label,
  disabled,
  error,
}: {
  value: string;
  onCommit: (text: string) => void;
  testId: string;
  label: string;
  disabled?: boolean;
  error?: string | null;
}) {
  const [text, setText] = useState<string | null>(null);
  const shown = text ?? value;
  const commit = () => {
    if (text !== null && text !== value) onCommit(text);
    setText(null);
  };
  return (
    <label className="drawing-field">
      <span>{label}</span>
      <input
        value={shown}
        disabled={disabled}
        data-testid={testId}
        aria-invalid={error ? true : undefined}
        onChange={(e) => setText(e.currentTarget.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            setText(null);
          }
        }}
      />
      {error && (
        <span className="field-error" role="alert">
          {error}
        </span>
      )}
    </label>
  );
}

// Sources ------------------------------------------------------------------------------------

// New drawing --------------------------------------------------------------------------------

export interface NewDrawingSettings {
  name: string;
  size: SheetSize;
  orientation: Sheet['orientation'];
  title: Record<string, string> | null;
}

export function NewDrawingForm({
  defaultName,
  documentName,
  units,
  onCreate,
  onCancel,
}: {
  defaultName: string;
  documentName: string;
  units: DisplayUnits;
  onCreate: (settings: NewDrawingSettings) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(defaultName);
  const [size, setSize] = useState<string>('A3');
  const [custom, setCustom] = useState({ width: '500', height: '350' });
  const [orientation, setOrientation] = useState<Sheet['orientation']>('landscape');
  const [withTitle, setWithTitle] = useState(true);
  const [title, setTitle] = useState<Record<string, string>>({ Title: documentName });
  return (
    <form
      className="drawing-new"
      aria-label="New drawing"
      data-testid="drawing-new"
      onSubmit={(e) => {
        e.preventDefault();
        onCreate({
          name,
          size:
            size === 'custom'
              ? {
                  width: storedExpression(custom.width.trim() || '0', units),
                  height: storedExpression(custom.height.trim() || '0', units),
                }
              : (size as (typeof SHEET_SIZES)[number]),
          orientation,
          title: withTitle ? title : null,
        });
      }}
    >
      <h2>New drawing</h2>
      <label className="drawing-field">
        <span>Name</span>
        <input
          value={name}
          data-testid="drawing-new-name"
          onChange={(e) => setName(e.currentTarget.value)}
        />
      </label>
      <label className="drawing-field">
        <span>Sheet size</span>
        <select
          value={size}
          data-testid="drawing-new-size"
          onChange={(e) => setSize(e.currentTarget.value)}
        >
          {SHEET_SIZES.map((s) => (
            <option key={s} value={s}>
              {SHEET_SIZE_LABELS[s]}
            </option>
          ))}
          <option value="custom">Custom</option>
        </select>
      </label>
      {size === 'custom' && (
        <>
          <label className="drawing-field">
            <span>Width</span>
            <input
              value={custom.width}
              data-testid="drawing-new-width"
              onChange={(e) => setCustom({ ...custom, width: e.currentTarget.value })}
            />
          </label>
          <label className="drawing-field">
            <span>Height</span>
            <input
              value={custom.height}
              data-testid="drawing-new-height"
              onChange={(e) => setCustom({ ...custom, height: e.currentTarget.value })}
            />
          </label>
        </>
      )}
      <label className="drawing-field">
        <span>Orientation</span>
        <select
          value={orientation}
          data-testid="drawing-new-orientation"
          onChange={(e) => setOrientation(e.currentTarget.value as Sheet['orientation'])}
        >
          <option value="landscape">Landscape</option>
          <option value="portrait">Portrait</option>
        </select>
      </label>
      <label className="drawing-check">
        <input
          type="checkbox"
          checked={withTitle}
          data-testid="drawing-new-title-block"
          onChange={(e) => setWithTitle(e.currentTarget.checked)}
        />
        Title block
      </label>
      {withTitle &&
        TITLE_FIELDS.map((label) => (
          <label key={label} className="drawing-field">
            <span>{label}</span>
            <input
              value={title[label] ?? ''}
              data-testid={`drawing-new-field-${label}`}
              onChange={(e) => setTitle({ ...title, [label]: e.currentTarget.value })}
            />
          </label>
        ))}
      <div className="drawing-actions">
        <button type="submit" data-testid="drawing-new-create">
          Create
        </button>
        <button type="button" data-testid="drawing-new-cancel" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

// Insert view ---------------------------------------------------------------------------------

export interface InsertViewSettings {
  source: ViewSource;
  direction: StandardViewName;
  scale: string;
  hidden: boolean;
  smooth: boolean;
}

export function InsertViewPanel({
  doc,
  bodyIds,
  onInsert,
  onClose,
  error,
}: {
  doc: ManufaktureDocument;
  /** The bodies of each part studio, from the last regen, for a view of some of them. */
  bodyIds?: Readonly<Record<string, readonly string[]>>;
  onInsert: (settings: InsertViewSettings) => void;
  onClose: () => void;
  error: string | null;
}) {
  const sources = viewSources(doc);
  const [key, setKey] = useState(sources[0]?.key ?? '');
  const [direction, setDirection] = useState<StandardViewName>('front');
  const [scale, setScale] = useState('1:1');
  const [hidden, setHidden] = useState(true);
  const [smooth, setSmooth] = useState(false);
  const [bodies, setBodies] = useState<readonly string[]>([]);
  const chosen = sources.find((s) => s.key === key);
  const partBodies = chosen && 'part' in chosen.source ? (bodyIds?.[chosen.source.part] ?? []) : [];
  return (
    <section
      className="drawing-section"
      aria-label="Insert view"
      data-testid="drawing-insert-panel"
    >
      <h3>Insert view</h3>
      <label className="drawing-field">
        <span>Of</span>
        <select
          value={key}
          data-testid="drawing-insert-source"
          onChange={(e) => {
            setKey(e.currentTarget.value);
            setBodies([]);
          }}
        >
          {sources.map((s) => (
            <option key={s.key} value={s.key}>
              {s.label}
            </option>
          ))}
        </select>
      </label>
      {partBodies.length > 1 && (
        <fieldset className="drawing-bodies" data-testid="drawing-insert-bodies">
          <legend>Bodies (none ticked: all)</legend>
          {partBodies.map((id) => (
            <label key={id} className="drawing-check">
              <input
                type="checkbox"
                checked={bodies.includes(id)}
                data-testid={`drawing-insert-body-${id}`}
                onChange={(e) =>
                  setBodies(
                    e.currentTarget.checked ? [...bodies, id] : bodies.filter((b) => b !== id),
                  )
                }
              />
              {id}
            </label>
          ))}
        </fieldset>
      )}
      <label className="drawing-field">
        <span>Direction</span>
        <select
          value={direction}
          data-testid="drawing-insert-direction"
          onChange={(e) => setDirection(e.currentTarget.value as StandardViewName)}
        >
          {STANDARD_VIEW_NAMES.map((n) => (
            <option key={n} value={n}>
              {VIEW_DIRECTION_LABELS[n]}
            </option>
          ))}
        </select>
      </label>
      <label className="drawing-field">
        <span>Scale</span>
        <input
          value={scale}
          data-testid="drawing-insert-scale"
          onChange={(e) => setScale(e.currentTarget.value)}
        />
      </label>
      <label className="drawing-check">
        <input
          type="checkbox"
          checked={hidden}
          onChange={(e) => setHidden(e.currentTarget.checked)}
        />
        Hidden lines
      </label>
      <label className="drawing-check">
        <input
          type="checkbox"
          checked={smooth}
          onChange={(e) => setSmooth(e.currentTarget.checked)}
        />
        Tangent edges
      </label>
      {error && (
        <p className="field-error" role="alert" data-testid="drawing-insert-error">
          {error}
        </p>
      )}
      <div className="drawing-actions">
        <button
          type="button"
          disabled={!chosen}
          data-testid="drawing-insert-ok"
          onClick={() => {
            if (!chosen) return;
            const source: ViewSource =
              'part' in chosen.source && bodies.length > 0
                ? { part: chosen.source.part, bodies: [...bodies] }
                : chosen.source;
            onInsert({ source, direction, scale, hidden, smooth });
          }}
        >
          Insert
        </button>
        <button type="button" data-testid="drawing-insert-close" onClick={onClose}>
          Close
        </button>
      </div>
    </section>
  );
}

// The sheet -----------------------------------------------------------------------------------

export function SheetPanel({
  drawing,
  sheet,
  units,
  readOnly,
  run,
}: {
  drawing: Drawing;
  sheet: Sheet;
  units: DisplayUnits;
  readOnly: boolean;
  run: (command: Command, label: string) => boolean;
}) {
  const base = { type: 'editSheet' as const, drawingId: drawing.id, sheetId: sheet.id };
  const values = titleValues(sheet.titleBlock);
  const labels = sheet.titleBlock
    ? [...new Set([...TITLE_FIELDS, ...sheet.titleBlock.fields.map((f) => f.label)])]
    : [];
  const setField = (label: string, value: string) => {
    const fields = labels.map((l) => ({
      label: l,
      value: l === label ? value : (values[l] ?? ''),
    }));
    run({ ...base, titleBlock: { fields } }, `Set ${label} of ${sheet.name}`);
  };
  const custom = typeof sheet.size === 'string' ? null : sheet.size;
  return (
    <section className="drawing-section" aria-label="Sheet" data-testid="drawing-sheet-panel">
      <h3>Sheet</h3>
      <CommitInput
        label="Name"
        value={sheet.name}
        testId="drawing-sheet-name"
        disabled={readOnly}
        onCommit={(name) => run({ ...base, name }, `Rename ${sheet.name}`)}
      />
      <label className="drawing-field">
        <span>Size</span>
        <select
          value={custom ? 'custom' : (sheet.size as string)}
          disabled={readOnly}
          data-testid="drawing-sheet-size"
          onChange={(e) => {
            const v = e.currentTarget.value;
            const size: SheetSize =
              v === 'custom'
                ? { width: storedExpression('500', units), height: storedExpression('350', units) }
                : (v as (typeof SHEET_SIZES)[number]);
            run({ ...base, size }, `Resize ${sheet.name}`);
          }}
        >
          {SHEET_SIZES.map((s) => (
            <option key={s} value={s}>
              {SHEET_SIZE_LABELS[s]}
            </option>
          ))}
          <option value="custom">Custom</option>
        </select>
      </label>
      {custom &&
        (['width', 'height'] as const).map((side) => (
          <CommitInput
            key={side}
            label={side === 'width' ? 'Width' : 'Height'}
            value={custom[side].source}
            testId={`drawing-sheet-${side}`}
            disabled={readOnly}
            onCommit={(text) =>
              run(
                { ...base, size: { ...custom, [side]: storedExpression(text.trim(), units) } },
                `Resize ${sheet.name}`,
              )
            }
          />
        ))}
      <label className="drawing-field">
        <span>Orientation</span>
        <select
          value={sheet.orientation}
          disabled={readOnly}
          data-testid="drawing-sheet-orientation"
          onChange={(e) =>
            run(
              { ...base, orientation: e.currentTarget.value as Sheet['orientation'] },
              `Turn ${sheet.name}`,
            )
          }
        >
          <option value="landscape">Landscape</option>
          <option value="portrait">Portrait</option>
        </select>
      </label>
      <label className="drawing-check">
        <input
          type="checkbox"
          checked={sheet.titleBlock !== undefined}
          disabled={readOnly}
          data-testid="drawing-sheet-title-block"
          onChange={(e) =>
            run(
              {
                ...base,
                titleBlock: e.currentTarget.checked
                  ? {
                      fields: TITLE_FIELDS.map((label) => ({
                        label,
                        value: label === 'Title' ? drawing.name : '',
                      })),
                    }
                  : null,
              },
              e.currentTarget.checked
                ? `Add a title block to ${sheet.name}`
                : `Remove the title block of ${sheet.name}`,
            )
          }
        />
        Title block
      </label>
      {labels.map((label) => (
        <CommitInput
          key={label}
          label={label}
          value={values[label] ?? ''}
          testId={`drawing-title-${label}`}
          disabled={readOnly}
          onCommit={(value) => setField(label, value)}
        />
      ))}
    </section>
  );
}

// The selected view ---------------------------------------------------------------------------

export function ViewPanel({
  doc,
  view,
  readOnly,
  scaleError,
  onEdit,
  onProject,
  onDelete,
}: {
  doc: ManufaktureDocument;
  view: DrawingView;
  readOnly: boolean;
  scaleError: string | null;
  onEdit: (view: DrawingView, label: string) => void;
  onProject: (side: ProjectionSide) => void;
  onDelete: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const named = typeof view.direction === 'string' ? view.direction : null;
  return (
    <section className="drawing-section" aria-label="View" data-testid="drawing-view-panel">
      <h3>
        {view.id}: {sourceLabel(doc, view.source)}
      </h3>
      <label className="drawing-field">
        <span>Direction</span>
        <select
          value={named ?? 'custom'}
          disabled={readOnly}
          data-testid="drawing-view-direction"
          onChange={(e) => {
            const v = e.currentTarget.value;
            if (v !== 'custom')
              onEdit({ ...view, direction: v as ViewDirection }, `Turn ${view.id}`);
          }}
        >
          {STANDARD_VIEW_NAMES.map((n) => (
            <option key={n} value={n}>
              {VIEW_DIRECTION_LABELS[n]}
            </option>
          ))}
          {!named && <option value="custom">Custom</option>}
        </select>
      </label>
      <CommitInput
        label="Scale"
        value={scaleText(view.scale)}
        testId="drawing-view-scale"
        disabled={readOnly}
        error={error ?? scaleError}
        onCommit={(text) => {
          const r = parseScaleText(text, doc.units);
          if (!r.ok) {
            setError(r.message);
            return;
          }
          setError(null);
          onEdit({ ...view, scale: r.scale }, `Scale ${view.id} to ${text.trim()}`);
        }}
      />
      <label className="drawing-check">
        <input
          type="checkbox"
          checked={view.options.hidden}
          disabled={readOnly}
          data-testid="drawing-view-hidden"
          onChange={(e) =>
            onEdit(
              { ...view, options: { ...view.options, hidden: e.currentTarget.checked } },
              `${e.currentTarget.checked ? 'Show' : 'Hide'} hidden lines of ${view.id}`,
            )
          }
        />
        Hidden lines
      </label>
      <label className="drawing-check">
        <input
          type="checkbox"
          checked={view.options.smooth}
          disabled={readOnly}
          data-testid="drawing-view-smooth"
          onChange={(e) =>
            onEdit(
              { ...view, options: { ...view.options, smooth: e.currentTarget.checked } },
              `${e.currentTarget.checked ? 'Show' : 'Hide'} tangent edges of ${view.id}`,
            )
          }
        />
        Tangent edges
      </label>
      {!readOnly && (
        <>
          <p className="drawing-subhead">Project a view from it, aligned:</p>
          <div className="drawing-actions">
            {(['top', 'right', 'left', 'bottom'] as const).map((side) => (
              <button
                key={side}
                type="button"
                data-testid={`drawing-project-${side}`}
                onClick={() => onProject(side)}
              >
                {side[0]!.toUpperCase() + side.slice(1)}
              </button>
            ))}
          </div>
          <div className="drawing-actions">
            <button type="button" data-testid="drawing-view-delete" onClick={onDelete}>
              Delete view
            </button>
          </div>
        </>
      )}
    </section>
  );
}

export function NotePanel({
  note,
  readOnly,
  onText,
  onDelete,
}: {
  note: Note;
  readOnly: boolean;
  onText: (text: string) => void;
  onDelete: () => void;
}) {
  return (
    <section className="drawing-section" aria-label="Note" data-testid="drawing-note-panel">
      <h3>{note.id}</h3>
      <CommitInput
        label="Text"
        value={note.text}
        testId="drawing-note-edit"
        disabled={readOnly}
        onCommit={onText}
      />
      {!readOnly && (
        <div className="drawing-actions">
          <button type="button" data-testid="drawing-note-delete" onClick={onDelete}>
            Delete note
          </button>
        </div>
      )}
    </section>
  );
}

// Dimensions and diagnostics ------------------------------------------------------------------

const OUTCOME_TEXT = {
  exact: 'OK',
  warning: 'Warning',
  lost: 'Lost: re-pick',
  ambiguous: 'Ambiguous: re-pick',
  error: 'Cannot be drawn',
} as const;

export function DimensionList({
  sheet,
  result,
  display,
  selected,
  readOnly,
  onSelect,
  onRepick,
  onDelete,
}: {
  sheet: Sheet;
  result: DrawingSheetResult | null;
  display: DisplayList | null;
  selected: Owner | null;
  readOnly: boolean;
  onSelect: (id: string) => void;
  onRepick: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  if (sheet.dimensions.length === 0) return null;
  return (
    <section className="drawing-section" aria-label="Dimensions">
      <h3>Dimensions</h3>
      <ul className="drawing-dimensions" data-testid="drawing-dimensions">
        {sheet.dimensions.map((d) => {
          const r = result?.views.flatMap((v) => v.dimensions).find((x) => x.dimensionId === d.id);
          const outcome = r?.outcome;
          const bad = outcome === 'lost' || outcome === 'ambiguous' || outcome === 'error';
          const note = r?.errors[0]?.message ?? r?.warnings[0]?.message ?? null;
          return (
            <li
              key={d.id}
              className={`drawing-dimension outcome-${outcome ?? 'pending'}${selected?.id === d.id ? ' selected' : ''}`}
              data-testid={`drawing-dimension-${d.id}`}
              data-outcome={outcome ?? ''}
            >
              <button type="button" className="drawing-link" onClick={() => onSelect(d.id)}>
                {d.id} {DIMENSION_KIND_LABELS[d.kind]}
                {dimensionText(display, d.id) !== null && (
                  <span
                    className="drawing-dim-value"
                    data-testid={`drawing-dimension-value-${d.id}`}
                  >
                    {' '}
                    {dimensionText(display, d.id)}
                  </span>
                )}
              </button>
              <span className="drawing-dim-status" data-testid={`drawing-dimension-status-${d.id}`}>
                {outcome ? OUTCOME_TEXT[outcome] : 'Measuring...'}
              </span>
              {note && <span className="drawing-dim-note">{note}</span>}
              {!readOnly && (
                <span className="drawing-actions">
                  {bad && (
                    <button
                      type="button"
                      data-testid={`drawing-dimension-repick-${d.id}`}
                      onClick={() => onRepick(d.id)}
                    >
                      Re-pick
                    </button>
                  )}
                  <button
                    type="button"
                    data-testid={`drawing-dimension-delete-${d.id}`}
                    onClick={() => onDelete(d.id)}
                  >
                    Delete
                  </button>
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function SheetMessages({ result }: { result: DrawingSheetResult | null }) {
  const messages = sheetMessages(result);
  if (messages.length === 0) return null;
  return (
    <section className="drawing-section" aria-label="Problems">
      <h3>Problems</h3>
      <ul className="drawing-messages" data-testid="drawing-messages">
        {messages.map((m, i) => (
          <li key={i} className={`drawing-message ${m.severity}`}>
            {m.text}
          </li>
        ))}
      </ul>
    </section>
  );
}
