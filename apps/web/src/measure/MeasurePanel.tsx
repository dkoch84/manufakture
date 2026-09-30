// The Measure panel: exact measurements of the current selection and of the
// body, in the document's display units, each with a copy button, and the
// part's material (one undoable command per change). In a part of several
// bodies, the body of the selection is shown with its own material (falling
// back to the part's), and with nothing selected every body is listed.

import { MATERIALS, findMaterial, type Material, type MaterialId } from '@manufakture/core';
import { useState } from 'react';
import { useStore } from 'zustand';
import type { DocumentStoreApi } from '../state/document';
import type { MeasureStore } from '../state/measure';
import { formatDensityIn } from './format';
import {
  bodySections,
  measureSections,
  sectionsText,
  type MeasureRow,
  type MeasureSection,
} from './rows';

/** A body of the active part, as the panel names it and weighs it. */
export interface MeasuredBody {
  /** Its viewport id, as measure requests name it. */
  viewId: string;
  name: string;
  /** Its material, or the part's when it has none; null when neither is set. */
  material: MaterialId | null;
}

export interface MeasurePanelProps {
  measure: MeasureStore;
  documents: DocumentStoreApi;
  /** The bodies of the active part, in body order (default: none known). */
  bodies?: readonly MeasuredBody[];
  /** Writes text to the clipboard; the browser's clipboard by default. */
  copy?: (text: string) => Promise<void>;
}

function browserCopy(text: string): Promise<void> {
  if (typeof navigator === 'undefined' || !navigator.clipboard) {
    return Promise.reject(new Error('No clipboard'));
  }
  return navigator.clipboard.writeText(text);
}

const NO_BODIES: readonly MeasuredBody[] = [];

const materialOf = (id: MaterialId | null): Material | null =>
  id === null ? null : (findMaterial(id) ?? null);

export function MeasurePanel({
  measure,
  documents,
  bodies = NO_BODIES,
  copy = browserCopy,
}: MeasurePanelProps) {
  const status = useStore(measure, (s) => s.status);
  const result = useStore(measure, (s) => s.result);
  const error = useStore(measure, (s) => s.error);
  const request = useStore(measure, (s) => s.request);
  const measured = useStore(measure, (s) => s.bodies);
  const units = useStore(documents, (s) => s.document.units);
  // The active part studio's material is its bodies' default.
  const part = useStore(
    documents,
    (s) => s.document.parts.find((p) => p.id === s.activePartId) ?? null,
  );
  const [copied, setCopied] = useState<string | null>(null);

  const several = bodies.length > 1;
  const shown = bodies.find((b) => b.viewId === request?.bodyId);
  const material = shown ? materialOf(shown.material) : materialOf(part?.material ?? null);
  const selected = request?.targets.length ?? 0;
  // Nothing selected in a part of several bodies: a section per body instead of one.
  const listed = several && selected === 0 && measured.length > 1;
  let sections: MeasureSection[] = [];
  if (result) {
    sections = measureSections(result, units, {
      material,
      ...(several && shown ? { title: `Body: ${shown.name}` } : {}),
    });
    if (listed) {
      sections = [
        ...sections.filter((s) => s.key !== 'body'),
        ...bodySections(
          measured.map((m) => {
            const info = bodies.find((b) => b.viewId === m.bodyId);
            return {
              title: info?.name ?? m.bodyId,
              body: m.body,
              ...(m.error ? { error: m.error } : {}),
              material: materialOf(info?.material ?? null),
            };
          }),
          units,
        ),
      ];
    }
  }
  const lastBody = [...sections].reverse().find((s) => s.key === 'body' || /^body\d+$/.test(s.key));
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
          {section === lastBody && part && (
            <label className="measure-material">
              {several ? 'Part material' : 'Material'}{' '}
              <select
                aria-label={several ? 'Part material' : 'Material'}
                title={several ? 'The material of every body without its own' : undefined}
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
