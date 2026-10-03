// The construction side of the drawing workspace (M6 plan T6.4b): the New construction set form,
// and for a selected construction view, its dimension strings with Hide, Show and Convert to
// dimensions. The logic is in `set.ts` and `strings.ts`; these only collect what the user chose.

import {
  SHEET_SIZES,
  type Command,
  type Drawing,
  type DrawingView,
  type ManufaktureDocument,
  type Sheet,
  type SheetSize,
} from '@manufakture/core';
import { DISCLAIMER_SHORT } from '@manufakture/domain-construction';
import type { DrawingViewResult } from '@manufakture/regen';
import { useState } from 'react';
import { SHEET_SIZE_LABELS } from '../../drawing/model';
import { isWall } from '../kinds';
import { setScales, type SetOptions } from './set';
import {
  convertStringCommand,
  hiddenStrings,
  hideStringsCommand,
  stringId,
  stringLabel,
} from './strings';
import './drawings.css';

/** The part studios with walls, for the set's Of field. */
function wallParts(doc: ManufaktureDocument): { id: string; name: string }[] {
  return doc.parts.filter((p) => p.features.some(isWall)).map((p) => ({ id: p.id, name: p.name }));
}

/** The sheet size a set defaults to: tabloid (11" x 17") for imperial units, else A3. */
function defaultSize(doc: ManufaktureDocument): SheetSize {
  return setScales(doc.units)[0]!.includes('"') ? 'tabloid' : 'A3';
}

export function ConstructionSetPanel({
  doc,
  activePart,
  error,
  onCreate,
  onClose,
}: {
  doc: ManufaktureDocument;
  /** The part studio to offer first (the one open under the drawing). */
  activePart?: string;
  error: string | null;
  onCreate: (options: SetOptions) => void;
  onClose: () => void;
}) {
  const parts = wallParts(doc);
  const scales = setScales(doc.units);
  const [part, setPart] = useState(
    parts.find((p) => p.id === activePart)?.id ?? parts[0]?.id ?? '',
  );
  const [size, setSize] = useState<SheetSize>(defaultSize(doc));
  const [orientation, setOrientation] = useState<Sheet['orientation']>('landscape');
  const [planScale, setPlanScale] = useState('auto');
  const [framingScale, setFramingScale] = useState('auto');
  const scaleSelect = (value: string, set: (v: string) => void, testId: string) => (
    <select value={value} data-testid={testId} onChange={(e) => set(e.currentTarget.value)}>
      <option value="auto">Largest that fits</option>
      {scales.map((s) => (
        <option key={s} value={s}>
          {s}
        </option>
      ))}
    </select>
  );
  return (
    <section
      className="drawing-section"
      aria-label="New construction set"
      data-testid="construction-set-panel"
    >
      <h3>New construction set</h3>
      <p className="construction-drawings-hint">
        Adds sheets to this drawing: a plan of each level, the four elevations, a framing elevation
        of each wall and a roof framing plan. Each sheet is drawn when it is shown.
      </p>
      <label className="drawing-field">
        <span>Of</span>
        <select
          value={part}
          data-testid="construction-set-part"
          onChange={(e) => setPart(e.currentTarget.value)}
        >
          {parts.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <label className="drawing-field">
        <span>Sheet size</span>
        <select
          value={typeof size === 'string' ? size : 'tabloid'}
          data-testid="construction-set-size"
          onChange={(e) => setSize(e.currentTarget.value as SheetSize)}
        >
          {SHEET_SIZES.map((s) => (
            <option key={s} value={s}>
              {SHEET_SIZE_LABELS[s]}
            </option>
          ))}
        </select>
      </label>
      <label className="drawing-field">
        <span>Orientation</span>
        <select
          value={orientation}
          data-testid="construction-set-orientation"
          onChange={(e) => setOrientation(e.currentTarget.value as Sheet['orientation'])}
        >
          <option value="landscape">Landscape</option>
          <option value="portrait">Portrait</option>
        </select>
      </label>
      <label className="drawing-field">
        <span>Plans and elevations</span>
        {scaleSelect(planScale, setPlanScale, 'construction-set-plan-scale')}
      </label>
      <label className="drawing-field">
        <span>Framing</span>
        {scaleSelect(framingScale, setFramingScale, 'construction-set-framing-scale')}
      </label>
      <p className="construction-drawings-hint" data-testid="construction-set-disclaimer">
        {DISCLAIMER_SHORT}
      </p>
      {error && (
        <p className="field-error" role="alert" data-testid="construction-set-error">
          {error}
        </p>
      )}
      <div className="drawing-actions">
        <button
          type="button"
          disabled={!part}
          data-testid="construction-set-create"
          onClick={() => onCreate({ part, size, orientation, planScale, framingScale })}
        >
          Create sheets
        </button>
        <button type="button" data-testid="construction-set-close" onClick={onClose}>
          Close
        </button>
      </div>
    </section>
  );
}

/**
 * A construction view's dimension strings: those drawn (Hide, Convert to dimensions) and those
 * hidden (Show). `result` is the view as last drawn, with picking data.
 */
export function ConstructionStrings({
  doc,
  drawing,
  sheet,
  view,
  result,
  readOnly,
  run,
}: {
  doc: ManufaktureDocument;
  drawing: Drawing;
  sheet: Sheet;
  view: DrawingView;
  result: DrawingViewResult | undefined;
  readOnly: boolean;
  run: (command: Command, label: string) => boolean;
}) {
  const [message, setMessage] = useState<string | null>(null);
  const names = new Map(doc.parts.flatMap((p) => p.features.map((f) => [f.id, f.name] as const)));
  const drawn = (result?.chains ?? []).map((c) => ({ chain: c.id, id: stringId(view, c) }));
  const hidden = hiddenStrings(view);
  return (
    <section
      className="drawing-section"
      aria-label="Dimension strings"
      data-testid="construction-strings"
    >
      <h3>Dimension strings</h3>
      <p className="construction-drawings-hint">
        Derived from the walls and openings at every redraw. Convert one to edit it as ordinary
        dimensions.
      </p>
      {drawn.length === 0 && hidden.length === 0 && (
        <p className="construction-drawings-hint">
          {result ? 'This view has none.' : 'Drawing the view...'}
        </p>
      )}
      <ul className="construction-strings" data-testid="construction-strings-list">
        {drawn.map(({ chain, id }) => (
          <li key={id} data-testid={`construction-string-${id}`}>
            <span>{stringLabel(id, names)}</span>
            {!readOnly && (
              <span className="construction-string-actions">
                <button
                  type="button"
                  data-testid={`construction-string-hide-${id}`}
                  onClick={() => {
                    const c = hideStringsCommand(drawing, sheet, view, [id], true);
                    if (c) run(c.command, c.label);
                  }}
                >
                  Hide
                </button>
                <button
                  type="button"
                  data-testid={`construction-string-convert-${id}`}
                  title="Replace the string with ordinary dimensions between layer corners"
                  onClick={() => {
                    const c = convertStringCommand(drawing, sheet, view, result, chain);
                    if (!c.ok) {
                      setMessage(c.message);
                      return;
                    }
                    setMessage(run(c.command, c.label) ? null : 'The conversion failed.');
                  }}
                >
                  Convert to dimensions
                </button>
              </span>
            )}
          </li>
        ))}
        {hidden.map((id) => (
          <li
            key={id}
            className="construction-string-hidden"
            data-testid={`construction-string-${id}`}
          >
            <span>{stringLabel(id, names)} (hidden)</span>
            {!readOnly && (
              <button
                type="button"
                data-testid={`construction-string-show-${id}`}
                onClick={() => {
                  const c = hideStringsCommand(drawing, sheet, view, [id], false);
                  if (c) run(c.command, c.label);
                }}
              >
                Show
              </button>
            )}
          </li>
        ))}
      </ul>
      {message && (
        <p className="field-error" role="alert" data-testid="construction-strings-error">
          {message}
        </p>
      )}
    </section>
  );
}
