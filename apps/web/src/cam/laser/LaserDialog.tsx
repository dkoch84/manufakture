// The laser and plasma export dialog (M5 plan, T5.6b), opened from the Export menu: what to cut
// (planar faces picked in the view, a sketch's regions, or a section of the body across a model
// axis), each on a named layer; the file format (DXF or SVG); and the kerf, checked as it is
// typed (zero or more, at most `MAX_KERF`, and at most a quarter of the outline's smaller side).
// The outline is read again whenever the sources change, so its size is shown and the kerf is
// checked against it before anything is written. Export hands the file to the app's download.

import type { CamFaceResolver } from '../picking';
import { findPart } from '@manufakture/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { ExpressionField } from '../../components/ExpressionField';
import type { ExportedFile } from '../../io/actions';
import { formatBytes } from '../../io/files';
import type { DocumentStoreApi } from '../../state/document';
import {
  isGeometryRef,
  itemKey,
  type GeometryRef,
  type SelectableItem,
  type SelectionStore,
} from '../../state/selection';
import { setupFaceReference } from '../picking';
import { camVariables, checkField } from '../values';
import {
  LASER_FORMATS,
  defaultLayer,
  extractLoops,
  kerfProblem,
  laserFile,
  middleAlong,
  outlineSize,
  withSource,
  type LaserBody,
  type LaserFormat,
  type LaserLayer,
  type LaserServices,
  type LaserSource,
  type OutlineSize,
  type SectionAxis,
} from '@manufakture/cam/export';
import './laser.css';

export interface LaserDialogProps {
  documents: DocumentStoreApi;
  partId: string;
  bodies: readonly LaserBody[];
  selection: SelectionStore;
  resolveFace: CamFaceResolver;
  services: LaserServices;
  /** Save the file (the app's download) and say so. */
  onSave: (file: ExportedFile, message: string) => void;
  onClose: () => void;
}

const AXES: readonly [SectionAxis, string][] = [
  ['x', 'X (seen from the right)'],
  ['y', 'Y (seen from the front)'],
  ['z', 'Z (seen from the top)'],
];

type Outline =
  | { state: 'empty' }
  | { state: 'reading' }
  | { state: 'ok'; layers: readonly LaserLayer[]; size: OutlineSize | null; warnings: string[] }
  | { state: 'error'; messages: string[] };

const round = (v: number) => String(Math.round(v * 1000) / 1000);

/**
 * A section's default position as field text: the middle of the body along the axis, with its
 * unit written in (the bounds are millimetres, and a bare number would be read in the document's
 * units).
 */
const defaultPosition = (body: LaserBody | undefined, axis: SectionAxis) =>
  `${round(middleAlong(body, axis))} mm`;

export function LaserDialog({
  documents,
  partId,
  bodies,
  selection,
  resolveFace,
  services,
  onSave,
  onClose,
}: LaserDialogProps) {
  const doc = useStore(documents, (s) => s.document);
  const part = findPart(doc, partId);
  const units = doc.units;
  const variables = useMemo(() => camVariables(doc), [doc]);
  const names = useMemo(() => doc.variables.map((v) => v.name), [doc]);
  const sketches = (part?.features ?? []).filter((f) => f.kind === 'sketch');

  const [bodyId, setBodyId] = useState(bodies[0]?.bodyId ?? '');
  const body = bodies.find((b) => b.bodyId === bodyId) ?? bodies[0];
  const [sources, setSources] = useState<readonly LaserSource[]>([]);
  const [picking, setPicking] = useState(true);
  const [pickMessage, setPickMessage] = useState<string | null>(null);
  const [sketch, setSketch] = useState(sketches[0]?.id ?? '');
  const [axis, setAxis] = useState<SectionAxis>('y');
  const [position, setPosition] = useState(() => defaultPosition(bodies[0], 'y'));
  const [positionError, setPositionError] = useState<string | undefined>(undefined);
  const [format, setFormat] = useState<LaserFormat>('dxf');
  const [kerf, setKerf] = useState('0');
  // The last outline read, for the request it answers.
  const [read, setRead] = useState<{ request: object; outline: Outline } | null>(null);
  const [result, setResult] = useState<{ error: boolean; text: string; warnings: string[] } | null>(
    null,
  );

  const add = (make: (existing: readonly LaserSource[]) => LaserSource) => {
    setSources((list) => withSource(list, make));
    setResult(null);
  };

  // Faces picked in the view while picking is on.
  const pickingRef = useRef(picking);
  useEffect(() => {
    pickingRef.current = picking;
  }, [picking]);
  const scopeBody = bodies.length > 1 ? body?.bodyId : undefined;
  const scope = useMemo(
    () => ({ part: partId, ...(scopeBody === undefined ? {} : { body: scopeBody }) }),
    [partId, scopeBody],
  );
  const scopeRef = useRef(scope);
  useEffect(() => {
    scopeRef.current = scope;
  }, [scope]);
  const pick = useCallback(
    (geo: GeometryRef) => {
      if (!pickingRef.current) return;
      void setupFaceReference(resolveFace, geo, scopeRef.current).then((r) => {
        if (!r.ok) {
          setPickMessage(r.message);
          return;
        }
        setPickMessage(null);
        setSources((list) =>
          withSource(list, (l) => ({
            kind: 'face',
            ref: r.ref,
            label: `Face ${r.ref.face}`,
            layer: defaultLayer('face', l),
          })),
        );
        setResult(null);
      });
    },
    [resolveFace, setSources, setResult],
  );
  useEffect(() => {
    let previous: readonly SelectableItem[] = selection.getState().selected;
    // Faces already selected when the dialog opens are taken too (pick first, then export).
    for (const item of previous) if (isGeometryRef(item) && item.kind === 'face') pick(item);
    return selection.subscribe((s) => {
      if (s.selected === previous) return;
      const before = new Set(previous.map(itemKey));
      previous = s.selected;
      for (const item of s.selected) {
        if (isGeometryRef(item) && item.kind === 'face' && !before.has(itemKey(item))) pick(item);
      }
    });
  }, [selection, pick]);

  // The outline, read again whenever the sources or the body change. A reply is kept with the
  // request it answers, so an older one never shows for newer sources. The document is read when
  // the request is made, not on every edit.
  const chosenBody = body?.bodyId;
  const chosenView = body?.viewId;
  const several = bodies.length > 1;
  const request = useMemo(() => {
    if (sources.length === 0 || chosenBody === undefined || chosenView === undefined) return null;
    return {
      sources,
      scope: { partId, ...(several ? { body: chosenBody } : {}), viewId: chosenView },
    };
  }, [sources, chosenBody, chosenView, several, partId]);
  useEffect(() => {
    if (request === null) return;
    const done = (outline: Outline) =>
      setRead((last) => (last?.request === request ? last : { request, outline }));
    void extractLoops(documents.getState().document, request.scope, request.sources, services).then(
      (r) =>
        done(
          r.ok
            ? { state: 'ok', layers: r.layers, size: outlineSize(r.layers), warnings: r.warnings }
            : { state: 'error', messages: r.messages },
        ),
      (e: unknown) =>
        done({ state: 'error', messages: [e instanceof Error ? e.message : String(e)] }),
    );
  }, [request, services, documents]);
  const outline: Outline =
    request === null
      ? { state: 'empty' }
      : read?.request === request
        ? read.outline
        : { state: 'reading' };

  // Focus moves in on open and back on close, unless the user put it somewhere else meanwhile.
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

  const size = outline.state === 'ok' ? outline.size : null;
  const kerfCheck = checkField(kerf, 'length', 'nonNegative', units, variables, true);
  const kerfValue = kerfCheck.ok ? (kerfCheck.value ?? 0) : null;
  const kerfError = kerfCheck.ok ? (kerfProblem(kerfValue!, size) ?? undefined) : undefined;
  const ready = outline.state === 'ok' && kerfValue !== null && kerfError === undefined;

  const addSection = () => {
    const c = checkField(position, 'length', 'any', units, variables);
    if (!c.ok) {
      setPositionError(c.message);
      return;
    }
    setPositionError(undefined);
    const at = c.value ?? 0;
    add((list) => ({
      kind: 'section',
      axis,
      position: at,
      label: `Section across ${axis.toUpperCase()} at ${round(at)} mm`,
      layer: defaultLayer('section', list),
    }));
  };

  const save = () => {
    if (outline.state !== 'ok' || kerfValue === null) return;
    const base = body?.name ?? part?.name ?? doc.name;
    const r = laserFile(outline.layers, { format, kerf: kerfValue, baseName: base });
    if (!r.ok) {
      setResult({ error: true, text: r.message, warnings: [] });
      return;
    }
    const text = `Exported ${r.file.name} (${formatBytes(r.file.bytes.length)}): ${round(r.size.width)} x ${round(r.size.height)} mm${kerfValue > 0 ? `, kerf ${round(kerfValue)} mm` : ''}.`;
    setResult({ error: false, text, warnings: r.warnings });
    onSave(r.file, text);
  };

  return (
    <aside
      ref={dialogRef}
      tabIndex={-1}
      className="selection-panel feature-dialog laser-dialog"
      role="dialog"
      aria-label="Laser and plasma export"
      data-testid="laser-dialog"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <h2>Laser and plasma export</h2>
      <p className="field-note">
        Outlines of {part?.name ?? partId} as DXF or SVG, in millimetres, with the lower left corner
        at 0, 0.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        {bodies.length > 1 && (
          <div className="dialog-field">
            <label>
              Body
              <select
                data-testid="laser-body"
                value={body?.bodyId ?? ''}
                onChange={(e) => {
                  setBodyId(e.target.value);
                  setSources([]);
                  setPosition(
                    defaultPosition(
                      bodies.find((b) => b.bodyId === e.target.value),
                      axis,
                    ),
                  );
                  setPositionError(undefined);
                }}
              >
                {bodies.map((b) => (
                  <option key={b.bodyId} value={b.bodyId}>
                    {b.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}
        <fieldset
          className={`dialog-field ref-field${picking ? ' active' : ''}`}
          data-testid="laser-sources"
        >
          <legend>What to cut</legend>
          <button
            type="button"
            aria-pressed={picking}
            data-testid="laser-pick-faces"
            onClick={() => setPicking(!picking)}
          >
            {picking ? 'Picking: click planar faces in the view' : 'Pick faces'}
          </button>
          {sketches.length > 0 && (
            <div className="laser-add-source">
              <select
                aria-label="Sketch"
                data-testid="laser-sketch"
                value={sketch}
                onChange={(e) => setSketch(e.target.value)}
              >
                {sketches.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                data-testid="laser-add-region"
                disabled={sketch === ''}
                onClick={() => {
                  const name = sketches.find((s) => s.id === sketch)?.name ?? sketch;
                  add((list) => ({
                    kind: 'region',
                    sketch,
                    label: `Regions of ${name}`,
                    layer: defaultLayer('region', list),
                  }));
                }}
              >
                Add its regions
              </button>
            </div>
          )}
          <div className="laser-add-source">
            <select
              aria-label="Section axis"
              data-testid="laser-section-axis"
              value={axis}
              onChange={(e) => {
                const a = e.target.value as SectionAxis;
                setAxis(a);
                setPosition(defaultPosition(body, a));
                setPositionError(undefined);
              }}
            >
              {AXES.map(([a, label]) => (
                <option key={a} value={a}>
                  {label}
                </option>
              ))}
            </select>
            <ExpressionField
              ariaLabel="Section position along the axis"
              testId="laser-section-position"
              value={position}
              kind="length"
              units={units}
              variables={variables}
              names={names}
              variant="compact"
              error={positionError}
              onChange={(v) => {
                setPosition(v);
                setPositionError(undefined);
              }}
            />
            <button type="button" data-testid="laser-add-section" onClick={addSection}>
              Add section
            </button>
          </div>
          {sources.length > 0 && (
            <ul className="laser-source-list">
              {sources.map((s, i) => (
                <li key={`${s.label}/${i}`} data-testid={`laser-source-${i}`}>
                  <span title={s.label}>{s.label}</span>
                  <label>
                    Layer
                    <input
                      type="text"
                      data-testid={`laser-layer-${i}`}
                      value={s.layer}
                      aria-invalid={s.layer.trim() === ''}
                      onChange={(e) => {
                        const layer = e.target.value;
                        setSources((list) => list.map((x, k) => (k === i ? { ...x, layer } : x)));
                        setResult(null);
                      }}
                    />
                  </label>
                  <button
                    type="button"
                    aria-label={`Remove ${s.label}`}
                    onClick={() => setSources((list) => list.filter((_, k) => k !== i))}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
          {pickMessage && (
            <p className="field-error" role="status" data-testid="laser-pick-message">
              {pickMessage}
            </p>
          )}
        </fieldset>
        <OutlineNote outline={outline} />
        <div className="dialog-field">
          <label>
            Format
            <select
              data-testid="laser-format"
              value={format}
              onChange={(e) => setFormat(e.target.value as LaserFormat)}
            >
              {LASER_FORMATS.map(([f, label, title]) => (
                <option key={f} value={f} title={title}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <ExpressionField
          label="Kerf"
          testId="laser-kerf"
          errorTestId="laser-kerf-error"
          value={kerf}
          kind="length"
          units={units}
          variables={variables}
          names={names}
          validate={(v) => kerfProblem(v, size)}
          onChange={(v) => {
            setKerf(v);
            setResult(null);
          }}
        />
        <p className="field-note">
          The width the beam or arc removes. Outer loops move out and holes in by half of it; 0 cuts
          on the outline.
        </p>
        {result && (
          <div
            className={result.error ? 'field-error' : 'field-note'}
            role={result.error ? 'alert' : 'status'}
            data-testid="laser-result"
          >
            {result.text}
            {result.warnings.map((w) => (
              <p key={w}>{w}</p>
            ))}
          </div>
        )}
        <div className="dialog-buttons">
          <button type="submit" className="primary" data-testid="laser-export" disabled={!ready}>
            Export
          </button>
          <button type="button" data-testid="laser-close" onClick={onClose}>
            Close
          </button>
        </div>
      </form>
    </aside>
  );
}

function OutlineNote({ outline }: { outline: Outline }) {
  switch (outline.state) {
    case 'empty':
      return (
        <p className="field-note" data-testid="laser-outline" data-state="empty">
          Pick a planar face, add a sketch&apos;s regions or a section.
        </p>
      );
    case 'reading':
      return (
        <p className="field-note" data-testid="laser-outline" data-state="reading">
          Reading the outline...
        </p>
      );
    case 'error':
      return (
        <div className="field-error" role="alert" data-testid="laser-outline" data-state="error">
          {outline.messages.map((m) => (
            <p key={m}>{m}</p>
          ))}
        </div>
      );
    case 'ok': {
      const loops = outline.layers.reduce((n, l) => n + l.loops.length, 0);
      const s = outline.size;
      return (
        <div
          className="field-note"
          role="status"
          data-testid="laser-outline"
          data-state="ok"
          data-width={s ? round(s.width) : undefined}
          data-height={s ? round(s.height) : undefined}
        >
          Outline {s ? `${round(s.width)} x ${round(s.height)} mm` : ''}: {loops}{' '}
          {loops === 1 ? 'loop' : 'loops'} on {outline.layers.length}{' '}
          {outline.layers.length === 1 ? 'layer' : 'layers'}.
          {outline.warnings.map((w) => (
            <p key={w}>{w}</p>
          ))}
        </div>
      );
    }
  }
}
