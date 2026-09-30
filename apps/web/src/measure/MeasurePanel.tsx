// The Measure panel: exact measurements of the current selection and of the
// body, in the document's display units, each with a copy button, and the
// body's material (one undoable command per change).

import { MATERIALS, findMaterial, type Material, type MaterialId } from '@manufakture/core';
import { useState } from 'react';
import { useStore } from 'zustand';
import type { DocumentStoreApi } from '../state/document';
import type { MeasureStore } from '../state/measure';
import { formatDensityIn } from './format';
import { measureSections, sectionsText, type MeasureRow } from './rows';

export interface MeasurePanelProps {
  measure: MeasureStore;
  documents: DocumentStoreApi;
  /** Writes text to the clipboard; the browser's clipboard by default. */
  copy?: (text: string) => Promise<void>;
}

function browserCopy(text: string): Promise<void> {
  if (typeof navigator === 'undefined' || !navigator.clipboard) {
    return Promise.reject(new Error('No clipboard'));
  }
  return navigator.clipboard.writeText(text);
}

export function MeasurePanel({ measure, documents, copy = browserCopy }: MeasurePanelProps) {
  const status = useStore(measure, (s) => s.status);
  const result = useStore(measure, (s) => s.result);
  const error = useStore(measure, (s) => s.error);
  const request = useStore(measure, (s) => s.request);
  const units = useStore(documents, (s) => s.document.units);
  // The active part studio's material is its bodies' default.
  const part = useStore(
    documents,
    (s) => s.document.parts.find((p) => p.id === s.activePartId) ?? null,
  );
  const material: Material | null = part?.material ? (findMaterial(part.material) ?? null) : null;
  const [copied, setCopied] = useState<string | null>(null);

  const sections = result ? measureSections(result, units, { material }) : [];
  const doCopy = (key: string, text: string) => {
    copy(text).then(
      () => setCopied(key),
      () => setCopied(null),
    );
  };
  const setMaterial = (value: string) => {
    if (!part) return;
    const next = value === '' ? null : (value as MaterialId);
    const name = next === null ? 'none' : (findMaterial(next)?.name ?? next);
    documents
      .getState()
      .execute({ type: 'setMaterial', partId: part.id, material: next }, `Set material to ${name}`);
  };
  const selected = request?.targets.length ?? 0;

  return (
    <aside className="selection-panel measure-panel" aria-label="Measure" data-status={status}>
      <h2>Measure</h2>
      {status === 'unavailable' && (
        <p>Measuring needs the geometry kernel, and this scene has none.</p>
      )}
      {status !== 'unavailable' && selected === 0 && (
        <p className="measure-hint">
          Select faces, edges or vertices to measure them. Two give their distance and angle.
        </p>
      )}
      {status === 'measuring' && result === null && <p>Measuring...</p>}
      {error !== null && (
        <p className="measure-error" role="alert">
          {error}
        </p>
      )}
      {sections.map((section) => (
        <section key={section.key} data-testid={`measure-${section.key}`}>
          <h3>{section.title}</h3>
          <dl>
            {section.rows.map((row) => (
              <Row
                key={row.key}
                row={row}
                copied={copied === row.key}
                onCopy={() => doCopy(row.key, row.value)}
              />
            ))}
          </dl>
          {section.key === 'body' && part && (
            <label className="measure-material">
              Material{' '}
              <select
                aria-label="Material"
                value={part.material ?? ''}
                onChange={(e) => setMaterial(e.target.value)}
              >
                <option value="">None</option>
                {MATERIALS.map((m) => (
                  <option key={m.id} value={m.id} title={m.source}>
                    {m.name} ({formatDensityIn(m.density, units)}, typical)
                  </option>
                ))}
              </select>
            </label>
          )}
        </section>
      ))}
      {sections.length > 0 && (
        <button
          type="button"
          className="measure-copy-all"
          onClick={() => doCopy('all', sectionsText(sections))}
        >
          {copied === 'all' ? 'Copied' : 'Copy all'}
        </button>
      )}
    </aside>
  );
}

function Row({ row, copied, onCopy }: { row: MeasureRow; copied: boolean; onCopy: () => void }) {
  return (
    <div className="measure-row" data-key={row.key}>
      <dt title={row.note}>{row.label}</dt>
      <dd>
        <span className="measure-value" data-testid={`measure-value-${row.key}`}>
          {row.value}
        </span>
        <button
          type="button"
          className="measure-copy"
          aria-label={`Copy ${row.label}`}
          title={copied ? 'Copied' : `Copy ${row.label}`}
          onClick={onCopy}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </dd>
    </div>
  );
}
