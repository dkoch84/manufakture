// The drawing workspace (M4 plan, T4.4g): one drawing, shown over the part studio. A sheet is
// drawn as SVG in the page: the same markup the SVG export writes (`screenSvg`), so the screen
// shows exactly what the file holds, with an overlay for picks, drags and the selection. SVG was
// chosen over a three.js orthographic scene because the display list is already 2D paper
// geometry with text: the SVG writer renders it with no conversion, the browser draws text in
// the standard fonts, and a sheet of a few thousand items redraws in well under a frame.
//
// Regen computes views and dimensions on request (the drawer): the sheet shown is asked for again
// on every document change and every completed regen, with picking data, and the last answer for
// it stays on screen until the next one lands.
//
// Tools: Select (click a view, dimension or note to select it, drag it to move it; a dimension's
// drag sets its offset, or where its text sits), Dimension (pick one or two edges, vertices or
// cylinders in one view, then click where it goes) and Note (click where the text goes).
// Placement is the user's: nothing nudges dimensions or text apart.

import type {
  Command,
  Dimension,
  DimensionKind,
  DrawingView,
  ManufaktureDocument,
} from '@manufakture/core';
import { pickInView, type DrawingSheetResult } from '@manufakture/regen';
import { useEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import { useStore } from 'zustand';
import { downloadBytes } from '../io/files';
import type { DocumentStoreApi } from '../state/document';
import {
  DimensionList,
  InsertViewPanel,
  NewDrawingForm,
  NotePanel,
  SheetMessages,
  SheetPanel,
  ViewPanel,
  type InsertViewSettings,
  type NewDrawingSettings,
} from './DrawingPanels';
import type { Drawer } from './drawer';
import { drawingFile, printSheet, screenSvg, type DrawingFormat } from './exports';
import {
  DIMENSION_KIND_LABELS,
  addDimensionCommand,
  addNoteCommand,
  addSheetCommand,
  defaultViewPosition,
  deleteCommand,
  dragCommand,
  hitTest,
  insertViewCommand,
  newDimension,
  newDrawingCommand,
  newDrawingName,
  nextDimensionId,
  ownerOf,
  paperToView,
  parseScaleText,
  pickKinds,
  pickPrompt,
  pickedOf,
  projectedDirection,
  projectedPosition,
  refsNeeded,
  repicked,
  scaleFactorOf,
  sheetPaperSize,
  viewAt,
  viewPaperRect,
  type Owner,
  type Picked,
  type ProjectionSide,
  type Vec2,
} from './model';
import type { DrawingUiStore } from './state';
import './drawing.css';

/** How near, paper mm, a click must be to an edge or vertex to pick it. */
export const PICK_RADIUS = 3;

type Tool = 'select' | 'dimension' | 'note';

export interface DrawingWorkspaceProps {
  documents: DocumentStoreApi;
  drawingUi: DrawingUiStore;
  /** Null without the regen worker (kernel-free scenes): nothing can be drawn. */
  drawer: Drawer | null;
  /** The model's generation: a new one asks for the sheet again. */
  generation: number;
  /** Each part studio's body ids, for a view of some of them. */
  bodyIds?: Readonly<Record<string, readonly string[]>>;
  /** Nothing can be changed (a past version shown). */
  readOnly?: boolean;
  /** Saves an exported file (default: a browser download). */
  onSave?: (bytes: Uint8Array, fileName: string, type: string) => void;
}

/** The last answer for a sheet, and what it answered (to tell whether a newer one is due). */
interface Answer {
  key: string;
  doc: ManufaktureDocument;
  generation: number;
  result: DrawingSheetResult | null;
  error: string | null;
}

/**
 * Asks the drawer for the sheet on every document change and every regen; the last answer for
 * the same sheet stays (a superseded request answers null) until a newer one lands.
 */
function useSheet(
  drawer: Drawer | null,
  doc: ManufaktureDocument,
  drawingId: string | null,
  sheetId: string | null,
  generation: number,
): { result: DrawingSheetResult | null; pending: boolean; error: string | null } {
  const key = `${drawingId}/${sheetId}`;
  const [answer, setAnswer] = useState<Answer | null>(null);
  const latest = useRef(0);
  useEffect(() => {
    if (!drawer || drawingId === null || sheetId === null) return;
    const request = ++latest.current;
    const settle = (result: DrawingSheetResult | null, error: string | null) => {
      if (request !== latest.current) return;
      setAnswer((a) => ({
        key,
        doc,
        generation,
        result:
          result && result.drawingId === drawingId && result.sheetId === sheetId
            ? result
            : a?.key === key
              ? a.result
              : null,
        error,
      }));
    };
    drawer.sheet(doc, drawingId, sheetId, { pick: true }).then(
      (result) => settle(result, null),
      (e: unknown) => settle(null, e instanceof Error ? e.message : String(e)),
    );
  }, [drawer, doc, drawingId, sheetId, generation, key]);
  const same = answer?.key === key;
  return {
    result: same ? answer.result : null,
    pending: !same || answer.doc !== doc || answer.generation !== generation,
    error: same ? answer.error : null,
  };
}

export function DrawingWorkspace({
  documents,
  drawingUi,
  drawer,
  generation,
  bodyIds,
  readOnly = false,
  onSave = downloadBytes,
}: DrawingWorkspaceProps) {
  const doc = useStore(documents, (s) => s.document);
  const drawingId = useStore(drawingUi, (s) => s.drawingId);
  const creating = useStore(drawingUi, (s) => s.creating);
  const drawing = doc.drawings?.find((d) => d.id === drawingId);
  const [chosenSheet, setChosenSheet] = useState<string | null>(null);
  const sheet = drawing?.sheets.find((s) => s.id === chosenSheet) ?? drawing?.sheets[0];
  const [tool, setToolState] = useState<Tool>('select');
  const [kind, setKind] = useState<DimensionKind>('horizontal');
  const [picks, setPicks] = useState<readonly Picked[]>([]);
  const [repick, setRepick] = useState<string | null>(null);
  const [selected, setSelected] = useState<Owner | null>(null);
  const [noteText, setNoteText] = useState('');
  const [inserting, setInserting] = useState(false);
  const [insertError, setInsertError] = useState<string | null>(null);
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [drag, setDrag] = useState<{ owner: Owner; from: Vec2; to: Vec2 } | null>(null);
  const [busy, setBusy] = useState(false);
  const sheetRef = useRef<HTMLDivElement | null>(null);

  // A drawing undone away (or deleted) closes.
  useEffect(() => {
    if (drawingId !== null && !drawing) drawingUi.getState().close();
  }, [drawingId, drawing, drawingUi]);
  // Another drawing or sheet: nothing selected, nothing half picked (reset while rendering).
  const shown = `${drawingId}/${sheet?.id}`;
  const [shownBefore, setShownBefore] = useState(shown);
  if (shownBefore !== shown) {
    setShownBefore(shown);
    setSelected(null);
    setPicks([]);
    setRepick(null);
    setDrag(null);
  }

  const sheetState = useSheet(drawer, doc, drawing?.id ?? null, sheet?.id ?? null, generation);
  const result = sheetState.result;
  const display = result?.display ?? null;
  const paper = sheet ? sheetPaperSize(sheet, display) : { width: 297, height: 210 };
  const svg = useMemo(() => (display ? screenSvg(display) : null), [display]);

  const run = (command: Command, label: string): boolean => {
    const r = documents.getState().execute(command, label);
    setMessage(r.ok ? null : { error: true, text: r.error.message });
    return r.ok;
  };

  const setTool = (next: Tool) => {
    setToolState(next);
    setPicks([]);
    setRepick(null);
    setMessage(null);
  };

  // Escape drops the half-made dimension, then the tool; Delete deletes the selection.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) return;
      if (e.key === 'Escape') {
        if (picks.length > 0 || repick) {
          setPicks([]);
          setRepick(null);
        } else setToolState('select');
      } else if (
        (e.key === 'Delete' || e.key === 'Backspace') &&
        selected &&
        drawing &&
        sheet &&
        !readOnly
      ) {
        const c = deleteCommand(drawing, sheet, selected);
        if (!c) return;
        const r = documents.getState().execute(c.command, c.label);
        if (r.ok) setSelected(null);
        else setMessage({ error: true, text: r.error.message });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [picks, repick, selected, drawing, sheet, readOnly, documents]);

  if (creating || !drawing) {
    if (!creating) return null;
    return (
      <section className="drawing-workspace" data-testid="drawing-workspace">
        <div className="drawing-new-wrap">
          <NewDrawingForm
            defaultName={newDrawingName(doc)}
            documentName={doc.name}
            units={doc.units}
            onCancel={() => drawingUi.getState().close()}
            onCreate={(s: NewDrawingSettings) => {
              const c = newDrawingCommand(doc, s.name, {
                size: s.size,
                orientation: s.orientation,
                title: s.title,
              });
              if (run(c.command, c.label)) {
                setChosenSheet(c.sheetId);
                drawingUi.getState().open(c.drawingId);
                setInserting(true);
              }
            }}
          />
          {message && (
            <p className="field-error" role="alert">
              {message.text}
            </p>
          )}
        </div>
      </section>
    );
  }

  /** Paper coordinates of a pointer event, or null when the sheet has no size on screen. */
  const toPaper = (e: { clientX: number; clientY: number }): Vec2 | null => {
    const r = sheetRef.current?.getBoundingClientRect();
    if (!r || !(r.width > 0) || !(r.height > 0)) return null;
    return [
      ((e.clientX - r.left) / r.width) * paper.width,
      paper.height - ((e.clientY - r.top) / r.height) * paper.height,
    ];
  };

  const viewResult = (viewId: string) => result?.views.find((v) => v.viewId === viewId);

  const insertView = (s: InsertViewSettings) => {
    if (!sheet) return;
    const scale = parseScaleText(s.scale, doc.units);
    if (!scale.ok) {
      setInsertError(scale.message);
      return;
    }
    setInsertError(null);
    const c = insertViewCommand(drawing, sheet, {
      source: s.source,
      direction: s.direction,
      scale: scale.scale,
      position: defaultViewPosition(paper, sheet.views.length),
      hidden: s.hidden,
      smooth: s.smooth,
    });
    if (run(c.command, c.label)) setSelected({ kind: 'view', id: c.viewId });
  };

  const project = (parent: DrawingView, side: ProjectionSide) => {
    if (!sheet) return;
    const c = insertViewCommand(drawing, sheet, {
      source: parent.source,
      direction: projectedDirection(parent.direction, side),
      scale: parent.scale,
      position: projectedPosition(parent, viewResult(parent.id), side),
      hidden: parent.options.hidden,
      smooth: parent.options.smooth,
    });
    if (run(c.command, `Project ${side} view from ${parent.id}`))
      setSelected({ kind: 'view', id: c.viewId });
  };

  /** A click with the Dimension tool: a pick while references are missing, then the placement. */
  const dimensionClick = (p: Vec2) => {
    if (!sheet) return;
    const repicking = repick ? sheet.dimensions.find((d) => d.id === repick) : undefined;
    const k = repicking?.kind ?? kind;
    const needed = refsNeeded(k);
    if (picks.length < needed) {
      const view = repicking
        ? sheet.views.find((v) => v.id === repicking.view)
        : picks.length > 0
          ? sheet.views.find((v) => v.id === picks[0]!.viewId)
          : viewAt(sheet, result, p);
      if (!view) {
        setMessage({ error: false, text: 'Click on an edge or vertex of a view.' });
        return;
      }
      const vr = viewResult(view.id);
      const s = scaleFactorOf(vr);
      if (!vr?.pick || s === null) {
        setMessage({
          error: false,
          text: `${view.id} is not drawn yet: wait a moment and pick again.`,
        });
        return;
      }
      const hit = pickInView(vr.pick, paperToView(view, s, p) as [number, number], {
        radius: PICK_RADIUS / s,
        kinds: pickKinds(k),
      });
      const picked = hit ? pickedOf(vr, hit, p) : null;
      if (!picked) {
        setMessage({
          error: false,
          text: `Nothing to measure there in ${view.id}. ${pickPrompt(k, picks.length)}`,
        });
        return;
      }
      const next = [...picks, picked];
      setMessage(null);
      if (repicking && next.length === needed) {
        const changed: Dimension = repicked(
          repicking,
          next.map((x) => x.ref),
        );
        run(
          { type: 'editDimension', drawingId: drawing.id, sheetId: sheet.id, dimension: changed },
          `Re-pick ${repicking.id}`,
        );
        setPicks([]);
        setRepick(null);
        setToolState('select');
        return;
      }
      setPicks(next);
      return;
    }
    const view = sheet.views.find((v) => v.id === picks[0]!.viewId);
    const s = scaleFactorOf(view && viewResult(view.id));
    if (!view || s === null) return;
    const made = newDimension(nextDimensionId(drawing), k, picks, view, s, p);
    setPicks([]);
    if (!made.ok) {
      setMessage({ error: true, text: made.message });
      return;
    }
    const c = addDimensionCommand(drawing, sheet, made.dimension);
    if (run(c.command, c.label)) setSelected({ kind: 'dimension', id: made.dimension.id });
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !sheet) return;
    const p = toPaper(e);
    if (!p) return;
    if (tool === 'dimension' && !readOnly) {
      dimensionClick(p);
      return;
    }
    if (tool === 'note' && !readOnly) {
      if (!noteText.trim()) {
        setMessage({ error: false, text: 'Type the note first, then click where it goes.' });
        return;
      }
      const c = addNoteCommand(drawing, sheet, noteText.trim(), p, viewAt(sheet, result, p, 0));
      if (run(c.command, c.label)) {
        setSelected({ kind: 'note', id: c.noteId });
        setToolState('select');
        setNoteText('');
      }
      return;
    }
    const hit = hitTest(display, sheet, result, p);
    setSelected(hit);
    if (hit && !readOnly) {
      setDrag({ owner: hit, from: p, to: p });
      e.currentTarget.setPointerCapture?.(e.pointerId);
    }
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag) return;
    const p = toPaper(e);
    if (p) setDrag({ ...drag, to: p });
  };

  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag || !sheet) return;
    const p = toPaper(e) ?? drag.to;
    setDrag(null);
    const c = dragCommand(drawing, sheet, result, drag.owner, drag.from, p);
    if (c) run(c.command, c.label);
  };

  const save = async (format: DrawingFormat) => {
    if (!drawer || !sheet) return;
    setBusy(true);
    try {
      const sheets = format === 'pdf' ? drawing.sheets : [sheet];
      const results = await Promise.all(sheets.map((s) => drawer.sheet(doc, drawing.id, s.id)));
      const file = drawingFile(
        format,
        results.map((r) => r?.display ?? null),
        { drawing: drawing.name, sheets: sheets.map((s) => s.name) },
      );
      if (!file.ok) {
        setMessage({ error: true, text: file.message });
        return;
      }
      onSave(file.bytes, file.fileName, file.type);
      setMessage({ error: false, text: `Saved ${file.fileName}` });
    } catch (e) {
      setMessage({
        error: true,
        text: `Export failed: ${e instanceof Error ? e.message : String(e)}`,
      });
    } finally {
      setBusy(false);
    }
  };

  const selectedView =
    selected?.kind === 'view' ? sheet?.views.find((v) => v.id === selected.id) : undefined;
  const selectedNote =
    selected?.kind === 'note' ? sheet?.notes.find((n) => n.id === selected.id) : undefined;
  const repicking = repick ? sheet?.dimensions.find((d) => d.id === repick) : undefined;
  const flip = (p: Vec2): Vec2 => [p[0], paper.height - p[1]];
  const dragRect =
    drag?.owner.kind === 'view' && sheet
      ? (() => {
          const v = sheet.views.find((x) => x.id === drag.owner.id);
          const r = v && viewPaperRect(v, viewResult(v.id));
          if (!r) return null;
          const dx = drag.to[0] - drag.from[0];
          const dy = drag.to[1] - drag.from[1];
          return {
            x: r.min[0] + dx,
            y: paper.height - (r.max[1] + dy),
            w: r.max[0] - r.min[0],
            h: r.max[1] - r.min[1],
          };
        })()
      : null;
  const selectedRect = selectedView
    ? viewPaperRect(selectedView, viewResult(selectedView.id))
    : null;
  const drawnDims = new Set(
    (display?.items ?? []).map((i) => i.owner).filter((o) => o?.startsWith('dim#')),
  );
  const hint =
    tool === 'dimension' || repicking
      ? `${repicking ? `Re-pick ${repicking.id}: ` : ''}${pickPrompt(repicking?.kind ?? kind, picks.length)}`
      : tool === 'note'
        ? 'Click where the note goes.'
        : null;

  return (
    <section
      className="drawing-workspace"
      data-testid="drawing-workspace"
      aria-label={`Drawing ${drawing.name}`}
    >
      <div className="drawing-toolbar" role="toolbar" aria-label="Drawing">
        <span className="drawing-sheets" role="tablist" aria-label="Sheets">
          {drawing.sheets.map((s) => (
            <button
              key={s.id}
              type="button"
              role="tab"
              aria-selected={s.id === sheet?.id}
              data-testid={`drawing-sheet-tab-${s.id}`}
              onClick={() => setChosenSheet(s.id)}
            >
              {s.name}
            </button>
          ))}
          {!readOnly && (
            <button
              type="button"
              data-testid="drawing-sheet-add"
              title="Add a sheet like this one"
              onClick={() => {
                const c = addSheetCommand(drawing, sheet);
                if (run(c.command, c.label)) setChosenSheet(c.sheetId);
              }}
            >
              + Sheet
            </button>
          )}
          {!readOnly && sheet && drawing.sheets.length > 1 && (
            <button
              type="button"
              data-testid="drawing-sheet-delete"
              onClick={() =>
                run(
                  { type: 'deleteSheet', drawingId: drawing.id, sheetId: sheet.id },
                  `Delete ${sheet.name}`,
                )
              }
            >
              Delete sheet
            </button>
          )}
        </span>
        {!readOnly && (
          <span className="drawing-tools">
            <button
              type="button"
              aria-pressed={inserting}
              data-testid="drawing-insert-view"
              disabled={!sheet}
              onClick={() => setInserting(!inserting)}
            >
              Insert view
            </button>
            <button
              type="button"
              aria-pressed={tool === 'select'}
              data-testid="drawing-tool-select"
              onClick={() => setTool('select')}
            >
              Select
            </button>
            <button
              type="button"
              aria-pressed={tool === 'dimension'}
              data-testid="drawing-tool-dimension"
              title="Pick edges, vertices or cylinders in a view, then click where the dimension goes"
              onClick={() => setTool('dimension')}
            >
              Dimension
            </button>
            <select
              aria-label="Dimension kind"
              value={kind}
              data-testid="drawing-dimension-kind"
              onChange={(e) => {
                setKind(e.currentTarget.value as DimensionKind);
                setToolState('dimension');
                setPicks([]);
              }}
            >
              {Object.entries(DIMENSION_KIND_LABELS).map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </select>
            <button
              type="button"
              aria-pressed={tool === 'note'}
              data-testid="drawing-tool-note"
              onClick={() => setTool('note')}
            >
              Note
            </button>
            <input
              aria-label="Note text"
              placeholder="Note text"
              value={noteText}
              data-testid="drawing-note-text"
              onChange={(e) => setNoteText(e.currentTarget.value)}
              onFocus={() => setToolState('note')}
            />
          </span>
        )}
        <span className="drawing-files">
          <button
            type="button"
            data-testid="drawing-zoom-out"
            title="Zoom out"
            onClick={() => setZoom(Math.max(0.5, zoom / 1.25))}
          >
            -
          </button>
          <button
            type="button"
            data-testid="drawing-zoom-fit"
            title="Fit the sheet"
            onClick={() => setZoom(1)}
          >
            Fit
          </button>
          <button
            type="button"
            data-testid="drawing-zoom-in"
            title="Zoom in"
            onClick={() => setZoom(Math.min(8, zoom * 1.25))}
          >
            +
          </button>
          {(['svg', 'dxf', 'pdf'] as const).map((f) => (
            <button
              key={f}
              type="button"
              disabled={!drawer || busy || !sheet}
              data-testid={`drawing-export-${f}`}
              title={
                f === 'pdf'
                  ? 'Every sheet as one PDF, a page each'
                  : `This sheet as ${f.toUpperCase()}`
              }
              onClick={() => void save(f)}
            >
              {f.toUpperCase()}
            </button>
          ))}
          <button
            type="button"
            disabled={!display}
            data-testid="drawing-print"
            title="Print this sheet at its paper size"
            onClick={() => {
              if (!display) return;
              const r = printSheet(display, drawing.name);
              if (!r.ok) setMessage({ error: true, text: r.message ?? 'Printing failed.' });
            }}
          >
            Print
          </button>
        </span>
        {(hint || message) && (
          <span
            className={message?.error ? 'io-status io-error' : 'io-status'}
            role={message?.error ? 'alert' : 'status'}
            data-testid="drawing-status"
          >
            {message?.text ?? hint}
          </span>
        )}
      </div>
      <div className="drawing-body">
        <div className="drawing-canvas" data-testid="drawing-canvas">
          {!drawer ? (
            <p className="viewport-hint" data-testid="drawing-no-kernel">
              Drawings are made by the geometry kernel, which this page does not run.
            </p>
          ) : !sheet ? (
            <p className="viewport-hint">This drawing has no sheets: add one.</p>
          ) : (
            <div
              ref={sheetRef}
              className={`drawing-sheet tool-${tool}`}
              data-testid="drawing-sheet"
              data-state={sheetState.pending ? 'pending' : 'ready'}
              data-width={paper.width}
              data-height={paper.height}
              data-dimensions={drawnDims.size}
              style={{ width: `${zoom * 100}%`, aspectRatio: `${paper.width} / ${paper.height}` }}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
            >
              {svg?.ok ? (
                <div className="drawing-svg" dangerouslySetInnerHTML={{ __html: svg.markup }} />
              ) : (
                <p className="viewport-hint" data-testid="drawing-sheet-hint">
                  {svg && !svg.ok
                    ? `The sheet cannot be drawn: ${svg.message}`
                    : sheetState.error
                      ? `The sheet could not be made: ${sheetState.error}`
                      : result && !display
                        ? 'The sheet cannot be laid out: see Problems.'
                        : 'Drawing the sheet...'}
                </p>
              )}
              {selected && (
                <style>{`.drawing-sheet path[data-owner="${selected.id}"]{stroke:#1a6fe0}.drawing-sheet text[data-owner="${selected.id}"]{fill:#1a6fe0}`}</style>
              )}
              <svg
                className="drawing-overlay"
                viewBox={`0 0 ${paper.width} ${paper.height}`}
                preserveAspectRatio="none"
                aria-hidden="true"
              >
                {selectedRect && (
                  <rect
                    className="drawing-selected-view"
                    x={selectedRect.min[0] - 2}
                    y={paper.height - selectedRect.max[1] - 2}
                    width={selectedRect.max[0] - selectedRect.min[0] + 4}
                    height={selectedRect.max[1] - selectedRect.min[1] + 4}
                  />
                )}
                {dragRect && (
                  <rect
                    className="drawing-drag-ghost"
                    x={dragRect.x}
                    y={dragRect.y}
                    width={dragRect.w}
                    height={dragRect.h}
                  />
                )}
                {drag && drag.owner.kind !== 'view' && (
                  <circle
                    className="drawing-drag-point"
                    cx={flip(drag.to)[0]}
                    cy={flip(drag.to)[1]}
                    r={1.2}
                  />
                )}
                {picks.map((pk, i) => (
                  <circle
                    key={i}
                    className="drawing-pick"
                    data-testid={`drawing-pick-${i}`}
                    cx={flip(pk.at)[0]}
                    cy={flip(pk.at)[1]}
                    r={1.5}
                  />
                ))}
              </svg>
            </div>
          )}
        </div>
        <aside className="drawing-panel" aria-label="Drawing panel">
          {inserting && !readOnly && sheet && (
            <InsertViewPanel
              doc={doc}
              {...(bodyIds ? { bodyIds } : {})}
              error={insertError}
              onInsert={insertView}
              onClose={() => setInserting(false)}
            />
          )}
          {selectedView && (
            <ViewPanel
              key={selectedView.id}
              doc={doc}
              view={selectedView}
              readOnly={readOnly}
              scaleError={
                viewResult(selectedView.id)?.diagnostics.find((d) => d.code === 'expression')
                  ?.message ?? null
              }
              onEdit={(view, label) => {
                if (sheet)
                  run({ type: 'editView', drawingId: drawing.id, sheetId: sheet.id, view }, label);
              }}
              onProject={(side) => project(selectedView, side)}
              onDelete={() => {
                const c =
                  sheet && deleteCommand(drawing, sheet, { kind: 'view', id: selectedView.id });
                if (c && run(c.command, c.label)) setSelected(null);
              }}
            />
          )}
          {selectedNote && sheet && (
            <NotePanel
              key={selectedNote.id}
              note={selectedNote}
              readOnly={readOnly}
              onText={(text) =>
                text.trim() &&
                run(
                  {
                    type: 'editNote',
                    drawingId: drawing.id,
                    sheetId: sheet.id,
                    note: { ...selectedNote, text: text.trim() },
                  },
                  `Edit ${selectedNote.id}`,
                )
              }
              onDelete={() => {
                const c = deleteCommand(drawing, sheet, { kind: 'note', id: selectedNote.id });
                if (c && run(c.command, c.label)) setSelected(null);
              }}
            />
          )}
          {sheet && (
            <DimensionList
              sheet={sheet}
              result={result}
              display={display}
              selected={selected}
              readOnly={readOnly}
              onSelect={(id) => setSelected(ownerOf(id))}
              onRepick={(id) => {
                setToolState('dimension');
                setPicks([]);
                setRepick(id);
                setSelected(ownerOf(id));
              }}
              onDelete={(id) => {
                const c = deleteCommand(drawing, sheet, { kind: 'dimension', id });
                if (c && run(c.command, c.label) && selected?.id === id) setSelected(null);
              }}
            />
          )}
          <SheetMessages result={result} />
          {sheet && (
            <SheetPanel
              key={sheet.id}
              drawing={drawing}
              sheet={sheet}
              units={doc.units}
              readOnly={readOnly}
              run={run}
            />
          )}
        </aside>
      </div>
    </section>
  );
}
