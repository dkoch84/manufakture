// Import SVG (M5 T5.8): choose an SVG file, choose what it becomes (one outline, or editable
// sketch lines, arcs and circles), set its scale and placement, see what it makes, and add it to
// the open sketch as one undoable edit. A new sketch is a sketch started with New sketch and
// imported into before anything else is drawn.
//
// The file is untrusted. It is read as text and parsed once, when it is chosen, by
// `@manufakture/io`'s own bounded reader (no DOM, nothing rendered from it); the fields only
// re-fit (sketch geometry) or re-place it. Names from the file are shown as plain React text.

import { placeSvgImport, type ParsedSvg, type SvgAnchor } from '@manufakture/io';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { analyzeExpression } from '../components/expression';
import type { SketchSessionStore } from './session';
import {
  DEFAULT_SVG_SETTINGS,
  MAX_SVG_FILE_BYTES,
  describeCounts,
  fitArtwork,
  importProblem,
  outlineProblem,
  readSvg,
  svgArtwork,
  svgDraft,
  svgOutlineDraft,
  type SvgImportMode,
} from './svg-import';
import { checkValue, formatValue, type Variables } from './values';

const NO_VARIABLES: Variables = {};
/** Issues the dialog lists; past this it says how many more there are. */
const MAX_SHOWN_ISSUES = 8;

const ANCHORS: readonly { id: SvgAnchor; label: string }[] = [
  { id: 'bottom-left', label: "The artwork's bottom left corner" },
  { id: 'center', label: "The artwork's centre" },
  { id: 'page', label: "The SVG page's bottom left corner" },
];

export interface SvgImportDialogProps {
  session: SketchSessionStore;
  onClose: () => void;
}

export function SvgImportDialog({ session, onClose }: SvgImportDialogProps) {
  const source = useStore(session, (s) => s.source);
  const sketch = useStore(session, (s) => s.sketch);
  const [file, setFile] = useState<{ name: string; parsed: ParsedSvg } | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [mode, setMode] = useState<SvgImportMode>('outline');
  const [scale, setScale] = useState('1');
  const [tolerance, setTolerance] = useState('0.01 mm');
  const [anchor, setAnchor] = useState<SvgAnchor>(DEFAULT_SVG_SETTINGS.anchor);
  const [x, setX] = useState('0');
  const [y, setY] = useState('0');
  const [curves, setCurves] = useState<'arcs' | 'lines'>(DEFAULT_SVG_SETTINGS.curves);
  const pick = useRef(0);
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => first.current?.focus(), []);

  const units = source?.units;
  const variables = source?.variables ?? NO_VARIABLES;

  // Every field checked as typed: the scale a plain number, lengths in the document's units
  // (expressions allowed in both).
  const fields = useMemo(() => {
    if (!units) return null;
    const k = analyzeExpression(scale, 'number', units, variables, (v) =>
      v > 0 ? null : 'The scale must be above 0.',
    );
    const tol = checkValue(tolerance, 'distance', units, variables);
    const at = [x, y].map((v) => checkValue(v, 'horizontalDistance', units, variables));
    const problems: string[] = [];
    if (k.state !== 'ok') {
      problems.push(k.state === 'error' ? `Scale: ${k.message}` : 'Enter a scale.');
    }
    if (mode === 'entities') {
      if (!tol.ok) problems.push(`Tolerance: ${tol.message}`);
      else if (tol.value < 1e-4 || tol.value > 1) {
        problems.push('The tolerance must be between 0.0001 mm and 1 mm.');
      }
    }
    at.forEach((r, i) => {
      if (!r.ok) problems.push(`${i === 0 ? 'X' : 'Y'}: ${r.message}`);
    });
    if (problems.length > 0 || k.state !== 'ok') return { problems, settings: null };
    return {
      problems,
      settings: {
        scale: k.value,
        scaleExpression: k.expression,
        tolerance: tol.ok ? tol.value : DEFAULT_SVG_SETTINGS.tolerance,
        anchor,
        at: [at[0]!.ok ? at[0]!.value : 0, at[1]!.ok ? at[1]!.value : 0] as const,
        curves,
      },
    };
  }, [units, variables, scale, tolerance, anchor, x, y, curves, mode]);
  const settings = fields?.settings ?? null;

  // The outline needs no fit: its paths depend on the file alone.
  const art = useMemo(() => (file ? svgArtwork(file.parsed) : null), [file]);
  // Sketch geometry is fitted at its final size; placing it again is only a translation.
  const fitScale = settings?.scale;
  const fitTolerance = settings?.tolerance;
  const fitted = useMemo(
    () =>
      file && mode === 'entities' && fitScale !== undefined && fitTolerance !== undefined
        ? fitArtwork(file.parsed, { scale: fitScale, tolerance: fitTolerance, curves })
        : null,
    [file, mode, fitScale, fitTolerance, curves],
  );
  const placed = useMemo(
    () =>
      fitted?.ok && settings ? placeSvgImport(fitted.value, settings.anchor, settings.at) : null,
    [fitted, settings],
  );
  const draft = useMemo(() => (placed ? svgDraft(placed) : null), [placed]);
  const tooMuch =
    mode === 'entities'
      ? draft
        ? importProblem(sketch, draft, curves)
        : null
      : art?.ok
        ? outlineProblem(sketch, art.value)
        : null;

  const choose = async (f: File | undefined) => {
    if (!f) return;
    const mine = ++pick.current;
    setFile(null);
    if (f.size > MAX_SVG_FILE_BYTES) {
      setFileError(`The file is over ${MAX_SVG_FILE_BYTES / 1048576} MB, too large to import.`);
      return;
    }
    let text: string;
    try {
      text = await f.text();
    } catch (e) {
      if (pick.current === mine) {
        setFileError(`The file could not be read: ${e instanceof Error ? e.message : String(e)}`);
      }
      return;
    }
    if (pick.current !== mine) return;
    const read = readSvg(text);
    if (!read.ok) {
      setFileError(read.message);
      return;
    }
    setFileError(null);
    setFile({ name: f.name, parsed: read.value });
  };

  const outlineReady =
    mode === 'outline' && art?.ok === true && settings !== null && tooMuch === null;
  const entitiesReady = mode === 'entities' && draft !== null && tooMuch === null;

  const doImport = () => {
    if (!file || !settings) return;
    if (outlineReady && art?.ok) {
      const d = svgOutlineDraft(
        art.value,
        file.name,
        settings.anchor,
        settings.at,
        settings.scaleExpression,
      );
      session.getState().importGeometry(d, `Imported ${file.name} as one outline.`);
      onClose();
      return;
    }
    if (entitiesReady && placed && draft) {
      session
        .getState()
        .importGeometry(
          draft,
          `Imported ${describeCounts(placed)} from ${file.name}, unconstrained.`,
        );
      onClose();
    }
  };

  const length = (mm: number) => (units ? formatValue(mm, 'length', units) : `${mm} mm`);
  // The size shown: the outline's extent times the scale, or the fitted geometry's.
  const size =
    mode === 'outline'
      ? art?.ok && settings
        ? [
            (art.value.bounds.max[0] - art.value.bounds.min[0]) * settings.scale,
            (art.value.bounds.max[1] - art.value.bounds.min[1]) * settings.scale,
          ]
        : null
      : placed?.bounds
        ? [placed.bounds.max[0] - placed.bounds.min[0], placed.bounds.max[1] - placed.bounds.min[1]]
        : null;
  const failure =
    fileError ??
    (art && !art.ok && mode === 'outline' ? art.message : null) ??
    (fitted && !fitted.ok ? fitted.message : null);
  // The file's issues, then (for sketch geometry) the fit's own, which `fitSvg` appends after
  // them; at most MAX_SHOWN_ISSUES are listed.
  const shownIssues = useMemo(() => {
    const all = file ? [...file.parsed.issues] : [];
    if (file && mode === 'entities' && fitted?.ok) {
      all.push(...fitted.value.issues.slice(file.parsed.issues.length));
    }
    return {
      shown: all.slice(0, MAX_SHOWN_ISSUES),
      more: Math.max(0, all.length - MAX_SHOWN_ISSUES),
    };
  }, [file, mode, fitted]);

  return (
    <div
      className="svg-import"
      role="dialog"
      aria-label="Import SVG"
      data-testid="svg-import"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <h4>Import SVG</h4>
      <p className="field-note">
        Paths and shapes of an SVG file, into this sketch. Convert text to paths in your drawing
        program first.
      </p>
      <input
        ref={first}
        type="file"
        accept=".svg,image/svg+xml"
        aria-label="SVG file"
        data-testid="svg-import-file"
        onChange={(e) => void choose(e.currentTarget.files?.[0])}
      />
      <label>
        Import as
        <select
          value={mode}
          data-testid="svg-import-mode"
          onChange={(e) => setMode(e.currentTarget.value as SvgImportMode)}
        >
          <option value="outline">One outline (any size of artwork)</option>
          <option value="entities">Sketch lines, arcs and circles (to edit)</option>
        </select>
      </label>
      <label>
        Scale
        <input
          type="text"
          inputMode="decimal"
          value={scale}
          data-testid="svg-import-scale"
          title={
            mode === 'outline'
              ? 'A number or an expression such as #k; the outline keeps it, so a variable can resize it later'
              : 'A number or an expression'
          }
          onChange={(e) => setScale(e.currentTarget.value)}
        />
      </label>
      {mode === 'entities' && (
        <>
          <label>
            Tolerance
            <input
              type="text"
              value={tolerance}
              data-testid="svg-import-tolerance"
              title="Largest distance between a curve of the file and the arcs that replace it"
              onChange={(e) => setTolerance(e.currentTarget.value)}
            />
          </label>
          <label>
            Curves
            <select
              value={curves}
              data-testid="svg-import-curves"
              title="Arcs follow curves with few entities; lines only let the solver hold much larger drawings"
              onChange={(e) => setCurves(e.currentTarget.value as 'arcs' | 'lines')}
            >
              <option value="arcs">Arcs and lines</option>
              <option value="lines">Lines only</option>
            </select>
          </label>
        </>
      )}
      <label>
        Place
        <select
          value={anchor}
          data-testid="svg-import-anchor"
          onChange={(e) => setAnchor(e.currentTarget.value as SvgAnchor)}
        >
          {ANCHORS.map((a) => (
            <option key={a.id} value={a.id}>
              {a.label}
            </option>
          ))}
        </select>
      </label>
      <div className="svg-import-at">
        <label>
          at X
          <input
            type="text"
            value={x}
            data-testid="svg-import-x"
            onChange={(e) => setX(e.currentTarget.value)}
          />
        </label>
        <label>
          Y
          <input
            type="text"
            value={y}
            data-testid="svg-import-y"
            onChange={(e) => setY(e.currentTarget.value)}
          />
        </label>
      </div>
      {fields?.problems.map((p) => (
        <p key={p} className="text-error" role="alert">
          {p}
        </p>
      ))}
      {failure && (
        <p className="text-error" role="alert" data-testid="svg-import-error">
          {failure}
        </p>
      )}
      {file && !failure && ((mode === 'outline' && art?.ok) || placed) && (
        <div className="svg-import-summary" data-testid="svg-import-summary">
          <p>
            <span data-testid="svg-import-name">{file.name}</span>:{' '}
            <span data-testid="svg-import-counts">
              {mode === 'outline' && art?.ok
                ? `${art.value.paths.length} shape${art.value.paths.length === 1 ? '' : 's'} as one outline`
                : placed
                  ? describeCounts(placed)
                  : ''}
            </span>
            {size && (
              <>
                , <span data-testid="svg-import-size">{length(size[0]!)}</span> by{' '}
                {length(size[1]!)}
              </>
            )}
            .
          </p>
          {tooMuch && (
            <p className="text-error" role="alert" data-testid="svg-import-too-much">
              {tooMuch}
            </p>
          )}
          {shownIssues.shown.map((issue, i) => (
            <p key={i} className="text-warning" role="note">
              {issue.message}
            </p>
          ))}
          {shownIssues.more > 0 && (
            <p className="text-warning" role="note" data-testid="svg-import-more-issues">
              And {shownIssues.more.toLocaleString('en')} more.
            </p>
          )}
          <p className="field-note">
            {mode === 'outline'
              ? 'One outline, placed by its anchor like a text: its shapes become regions by their fill rules, and the solver never sees them.'
              : 'The geometry is added without constraints, so the solver leaves it where it is placed.'}
          </p>
        </div>
      )}
      <div className="dialog-buttons">
        <button
          type="button"
          className="primary"
          disabled={!(outlineReady || entitiesReady)}
          data-testid="svg-import-ok"
          onClick={doImport}
        >
          Import
        </button>
        <button type="button" data-testid="svg-import-cancel" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}
