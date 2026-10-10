// The checks panel (ADR 0017 decision 15, T9.5a): every record the mechanical checks made in the
// last regen, each with its line ("Cable tension, Rope in Hold: load 890 N, rated load 4.50 kN;
// factor 5.06, above your 2") and its working on request: method, formula, every input with its
// value and where it came from, the values derived on the way, the comparison, the assumptions
// and the published sources. An `unknown` record names what is missing. Numbers and margins only
// (decision 6): nothing here calls a design safe, and the notice is shown with the records.

import {
  DISCLAIMER_SHORT,
  formatSI,
  mechEvaluationOf,
  statusLabel,
} from '@manufakture/domain-mech';
import type { CheckEntry } from '@manufakture/domain-mech';
import { useState } from 'react';
import { useStore } from 'zustand';
import type { ModelStore } from '../../model/model';
import '../mech.css';
import './checks.css';

function value(v: number | null, unit: string): string {
  return v === null ? 'not given' : formatSI(v, unit);
}

/** The working of one record. */
function Working({ entry }: { entry: CheckEntry }) {
  const r = entry.record;
  return (
    <div className="checks-working" data-testid={`checks-working-${r.id}`}>
      <p>
        <strong>Method:</strong> {r.method}
        {r.formula !== '' && (
          <>
            {' '}
            <code>{r.formula}</code>
          </>
        )}
      </p>
      {r.inputs.length > 0 && (
        <table className="checks-table">
          <thead>
            <tr>
              <th>Input</th>
              <th>Value</th>
              <th>From</th>
            </tr>
          </thead>
          <tbody>
            {r.inputs.map((i) => (
              <tr key={i.symbol}>
                <td>
                  {i.name} <em className="checks-symbol">{i.symbol}</em>
                </td>
                <td>{value(i.value, i.unit)}</td>
                <td>{i.source}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {r.derived.length > 0 && (
        <ul className="checks-list">
          {r.derived.map((d) => (
            <li key={d.symbol}>
              {d.name} <em className="checks-symbol">{d.symbol}</em> = {formatSI(d.value, d.unit)}
            </li>
          ))}
        </ul>
      )}
      {r.result !== null && (
        <p>
          <strong>Result:</strong> {formatSI(r.result, r.unit)}
          {r.limit !== undefined &&
            `, against ${entry.factor !== undefined ? 'your factor' : 'your limit'} ${formatSI(r.limit, r.unit)}`}
          {r.margin !== undefined && ` (margin ${(r.margin * 100).toFixed(1)} %)`}
        </p>
      )}
      {r.missing !== undefined && (
        <p data-testid={`checks-missing-${r.id}`}>
          <strong>Missing:</strong> {r.missing.join(', ')}
        </p>
      )}
      {r.note !== undefined && <p className="field-note">{r.note}</p>}
      {r.loadCase !== undefined && <p className="field-note">Load case: {r.loadCase}</p>}
      {r.assumptions.length > 0 && (
        <>
          <p>
            <strong>Assumptions</strong>
          </p>
          <ul className="checks-list">
            {r.assumptions.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ul>
        </>
      )}
      {r.sources.length > 0 && (
        <p className="field-note">
          Sources: {r.sources.map((s) => `${s.title}, ${s.locator}`).join('; ')}
        </p>
      )}
    </div>
  );
}

export function ChecksPanel({ model, onClose }: { model: ModelStore; onClose: () => void }) {
  const evaluations = useStore(model, (s) => s.evaluations);
  const pending = useStore(model, (s) => s.pending);
  const evaluation = mechEvaluationOf(evaluations);
  const error = evaluations.find((e) => e.namespace === 'mech')?.error;
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const entries = evaluation?.checks ?? [];
  const toggle = (id: string) =>
    setOpen((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="mech-start-backdrop">
      <section
        className="mech-start checks-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="checks-title"
        data-testid="checks-panel"
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
        }}
      >
        <h2 id="checks-title">Checks</h2>
        <p className="field-note" data-testid="checks-disclaimer">
          {DISCLAIMER_SHORT}
        </p>
        {pending && <p className="field-note">Recomputing after your last edit.</p>}
        {error !== undefined && (
          <p className="field-error" role="alert" data-testid="checks-error">
            {error.message}
          </p>
        )}
        {entries.length === 0 && error === undefined && (
          <p className="field-note" data-testid="checks-empty">
            No checks apply yet. They appear once the design has the parts and load cases a check
            reads (a rope and a load case that pulls it, for the cable tension).
          </p>
        )}
        {entries.length > 0 && (
          <ul className="checks-records" data-testid="checks-records">
            {entries.map((entry) => {
              const r = entry.record;
              const shown = open.has(r.id);
              return (
                <li
                  key={r.id}
                  className={`checks-record checks-${r.status === 'ok' ? 'computed' : r.status}`}
                  data-testid={`checks-record-${r.id}`}
                >
                  <div className="checks-head">
                    <span className="checks-status" data-testid={`checks-status-${r.id}`}>
                      {statusLabel(r, entry.factor !== undefined)}
                    </span>
                    <span className="checks-text">{entry.text}</span>
                    <button
                      type="button"
                      aria-expanded={shown}
                      data-testid={`checks-toggle-${r.id}`}
                      onClick={() => toggle(r.id)}
                    >
                      {shown ? 'Hide working' : 'Working'}
                    </button>
                  </div>
                  {shown && <Working entry={entry} />}
                </li>
              );
            })}
          </ul>
        )}
        <div className="dialog-buttons">
          <button type="button" data-testid="checks-close" onClick={onClose}>
            Close
          </button>
        </div>
      </section>
    </div>
  );
}

/** The toolbar button that opens the checks panel, with the count of records to look at. */
export function MechChecksButton({ model, disabled }: { model: ModelStore; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const count = useStore(
    model,
    (s) =>
      mechEvaluationOf(s.evaluations)?.checks.filter((c) => c.record.status !== 'ok').length ?? 0,
  );
  return (
    <div className="toolbar-group" role="toolbar" aria-label="Checks">
      <button
        type="button"
        aria-pressed={open}
        disabled={disabled}
        data-testid="checks-open"
        title="The mechanical checks: each record with its working, against your own factors"
        onClick={() => setOpen(true)}
      >
        {count > 0 ? `Checks (${count})` : 'Checks'}
      </button>
      {open && <ChecksPanel model={model} onClose={() => setOpen(false)} />}
    </div>
  );
}
