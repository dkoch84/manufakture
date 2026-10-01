// Interference (M2 plan, T2.3d): which instances of the assembly overlap, and by how much. A check
// runs on demand in the regen worker (never on every regen: the pairwise booleans are the costly
// part); pairs are listed as they arrive, and a check can be stopped. A click on a pair selects both
// instances and outlines the overlap in the view; a second click clears it. When the assembly
// changes after a check, the list says so: check again.

import type { AssemblyResult } from '@manufakture/regen';
import { useEffect, useRef } from 'react';
import { useStore } from 'zustand';
import type { DocumentStoreApi } from '../state/document';
import type { Assembler } from './assembly';
import { finishedView, interferenceRows, interferenceSummary, startedView } from './interference';
import type { AssemblyUiStore } from './state';

export interface InterferencePanelProps {
  documents: DocumentStoreApi;
  assemblyId: string;
  assemblyUi: AssemblyUiStore;
  /** Runs the check; without one (no kernel) the panel cannot check. */
  assembler?: Assembler | undefined;
  /** The model's current result for the assembly, to tell when a check is out of date. */
  result: AssemblyResult | undefined;
  onClose: () => void;
}

let runs = 0;

export function InterferencePanel({
  documents,
  assemblyId,
  assemblyUi,
  assembler,
  result,
  onClose,
}: InterferencePanelProps) {
  const doc = useStore(documents, (s) => s.document);
  const view = useStore(assemblyUi, (s) =>
    s.interference?.assemblyId === assemblyId ? s.interference : null,
  );
  const highlight = useStore(assemblyUi, (s) => s.highlight);
  const resultRef = useRef(result);
  useEffect(() => {
    resultRef.current = result;
  }, [result]);
  // A check this panel started that is still running when the panel goes stops before its next
  // pair (closing the panel drops the view at once, so the view cannot tell).
  const checking = view?.status === 'checking';
  const running = useRef(0);
  useEffect(
    () => () => {
      if (running.current !== 0) assembler?.cancelInterference?.(assemblyId);
    },
    [assembler, assemblyId],
  );

  const assembly = doc.assemblies.find((a) => a.id === assemblyId);
  if (!assembly) return null;
  const canCheck = assembler?.interference !== undefined;

  const check = () => {
    const ask = assembler?.interference;
    if (!ask) return;
    const run = ++runs;
    const ui = assemblyUi.getState();
    ui.setInterference(startedView(assemblyId, run));
    running.current = run;
    ask
      .call(assembler, assemblyId, (pair) =>
        ui.updateInterference(run, (v) => ({ ...v, pairs: [...v.pairs, pair] })),
      )
      .finally(() => {
        if (running.current === run) running.current = 0;
      })
      .then(
        (report) => ui.updateInterference(run, (v) => finishedView(v, report, resultRef.current)),
        (error: unknown) =>
          ui.updateInterference(run, (v) => ({
            ...v,
            status: 'failed',
            message: error instanceof Error ? error.message : String(error),
          })),
      );
  };

  const changed = view !== null && view.status === 'done' && view.basis !== result;
  const rows = view ? interferenceRows(assembly, view.pairs, doc.units) : [];
  const summary = interferenceSummary(view, changed);

  return (
    <aside
      className="selection-panel feature-dialog interference-panel"
      aria-label="Interference"
      data-testid="interference-panel"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          onClose();
        }
      }}
    >
      <h2>Interference</h2>
      <p
        className={
          view !== null && view.pairs.length > 0
            ? 'interference-summary found'
            : 'interference-summary'
        }
        role="status"
        data-testid="interference-status"
        data-status={view?.status ?? 'idle'}
        data-changed={changed ? 'true' : 'false'}
      >
        {summary}
      </p>
      {rows.length > 0 && (
        <ul className="assembly-list interference-list" data-testid="interference-list">
          {rows.map((row) => (
            <li key={row.key} className={highlight === row.key ? 'highlighted' : ''}>
              <button
                type="button"
                className="interference-pair"
                aria-pressed={highlight === row.key}
                data-testid={`interference-pair-${row.key}`}
                data-volume={row.volume}
                title="Show both instances and their overlap"
                onClick={() =>
                  assemblyUi.getState().setHighlight(highlight === row.key ? null : row.key)
                }
              >
                <span className="assembly-item-name">{row.label}</span>
                <span className="interference-volume">{row.volumeText}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {view !== null && view.failures.length > 0 && (
        <p className="field-error" role="alert" data-testid="interference-failures">
          Could not check{' '}
          {view.failures
            .map((f) => {
              const name = (id: string) => assembly.instances.find((x) => x.id === id)?.name ?? id;
              return `${name(f.a)} and ${name(f.b)}`;
            })
            .join(', ')}
          : the kernel could not intersect them.
        </p>
      )}
      {!canCheck && (
        <p className="field-note">Checking needs the geometry kernel, which is not loaded here.</p>
      )}
      <div className="dialog-buttons">
        {checking ? (
          <button
            type="button"
            data-testid="interference-stop"
            onClick={() => assembler?.cancelInterference?.(assemblyId)}
          >
            Stop
          </button>
        ) : (
          <button
            type="button"
            className="primary"
            disabled={!canCheck || assembly.instances.length < 2}
            data-testid="interference-check"
            title="Intersect every pair of instances whose bounding boxes overlap"
            onClick={check}
          >
            {view === null ? 'Check' : 'Check again'}
          </button>
        )}
        <button type="button" data-testid="interference-close" onClick={onClose}>
          Done
        </button>
      </div>
    </aside>
  );
}
