// Purchased parts with ratings in the app (ADR 0017 decision 7, T9.2a): the catalog (the built-in
// sample entries and the document's own), adding an entry from a datasheet field by field or many
// from a CSV file, attaching a STEP file, placing an entry as a part studio (with an instance in an
// assembly when one is picked), and the bill of materials lines with the ratings they rely on,
// saved as CSV. Every value goes through `@manufakture/units`; files are untrusted and bounded
// before they are read. Numbers and margins only: nothing here calls a part safe or suitable.

import { MAX_IMPORT_BYTES, type CatalogRef, type ManufaktureDocument } from '@manufakture/core';
import {
  BOM_COLUMNS,
  DISCLAIMER_SHORT,
  FAMILY_SCHEMAS,
  MAX_CSV_CHARS,
  bareLengthUnit,
  bareUnit,
  entryItem,
  familySchema,
  importCatalogCsv,
  latestBuiltins,
  nextEntryIds,
  placePurchasedPart,
  problemText,
  purchasedBom,
  purchasedBomCsv,
  readEntryFields,
  type CatalogFamily,
  type RatingField,
} from '@manufakture/domain-mech';
import { checkStepFile, documentFileName, FABRICATION_MIME, toBase64 } from '@manufakture/io';
import { formatRating } from '@manufakture/takeoff';
import { isPhysicalKind, type PhysicalKind } from '@manufakture/units';
import { useMemo, useState } from 'react';
import { useStore } from 'zustand';
import { downloadBytes } from '../../io/files';
import type { DocumentStoreApi } from '../../state/document';
import '../mech.css';
import './parts.css';

/** The largest CSV file the import reads, in bytes (4 bytes per character at worst). */
const MAX_CSV_BYTES = MAX_CSV_CHARS * 4;
/** The largest STEP file an entry may hold: core's import limit. */
const MAX_STEP_BYTES = MAX_IMPORT_BYTES;

interface CatalogRow {
  ref: CatalogRef;
  item: string;
  family: CatalogFamily;
  verified: boolean;
  url?: string;
  geometry: string;
}

function catalogRows(doc: ManufaktureDocument): CatalogRow[] {
  const builtin = latestBuiltins()
    .filter((e) => e.deprecated === undefined)
    .map((e) => ({
      ref: { source: 'builtin', id: e.id, version: e.version } as CatalogRef,
      item: entryItem(e),
      family: e.family,
      verified: e.verified,
      ...(e.sources[0]?.url !== undefined ? { url: e.sources[0].url } : {}),
      geometry: e.geometry?.kind === 'step' ? 'STEP' : 'placeholder',
    }));
  const own = (doc.mech?.catalog ?? []).map((e) => ({
    ref: { source: 'document', id: e.id } as CatalogRef,
    item: entryItem(e),
    family: e.family,
    verified: e.verified,
    ...(e.sources[0]?.url !== undefined ? { url: e.sources[0].url } : {}),
    geometry: e.geometry?.kind === 'step' ? 'STEP' : 'placeholder',
  }));
  return [...own, ...builtin];
}

const refKey = (ref: CatalogRef) =>
  ref.source === 'builtin' ? `${ref.id}@${ref.version}` : ref.id;

/** The unit hint of a field: what a bare number means. */
function hint(field: RatingField, doc: ManufaktureDocument): string {
  if (isPhysicalKind(field.kind)) return bareUnit(field.kind as PhysicalKind, doc.units);
  if (field.unit !== undefined) return field.unit;
  return field.options !== undefined ? field.options.join(' / ') : '';
}

function EntryForm({
  documents,
  onDone,
}: {
  documents: DocumentStoreApi;
  onDone: (message: string) => void;
}) {
  const doc = useStore(documents, (s) => s.document);
  const [family, setFamily] = useState<CatalogFamily>('bearing');
  const [fields, setFields] = useState<Record<string, string>>({});
  const [step, setStep] = useState<{ name: string; blob: string } | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const schema = familySchema(family);
  const set = (name: string, value: string) => setFields((f) => ({ ...f, [name]: value }));
  const text = (name: string, label: string, note = '') => (
    <label className="dialog-field" key={name}>
      <span>
        {label}
        {note !== '' && <em className="parts-unit"> {note}</em>}
      </span>
      <input
        type="text"
        data-testid={`parts-field-${name}`}
        value={fields[name] ?? ''}
        onChange={(e) => set(name, e.target.value)}
      />
    </label>
  );

  const attachStep = async (file: File) => {
    if (file.size > MAX_STEP_BYTES) {
      setProblems([`${file.name} is over ${MAX_STEP_BYTES} bytes.`]);
      return;
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const check = checkStepFile(bytes, MAX_STEP_BYTES);
    if (!check.ok) {
      setProblems([`${file.name}, line ${check.line}: ${check.message}`]);
      return;
    }
    setStep({ name: file.name, blob: toBase64(bytes) });
    setProblems([]);
  };

  const save = () => {
    const current = documents.getState().document;
    const [id] = nextEntryIds(current, 1);
    const values: Record<string, string> = { ...fields, family };
    // Only this family's fields: switching family keeps typed text out of the entry.
    const own = new Set([
      'family',
      'maker',
      'partNumber',
      'description',
      'mass',
      'verified',
      'notes',
      'shape',
      'axis',
      'sourceTitle',
      'sourceUrl',
      'sourceRevision',
      'sourceRead',
      ...schema.dimensions.map((d) => `dim.${d.name}`),
      ...schema.fields.flatMap((f) => [f.name, `${f.name}.convention`, `${f.name}.basis`]),
    ]);
    for (const k of Object.keys(values)) if (!own.has(k)) delete values[k];
    if (step !== null) {
      delete values.shape;
      delete values.axis;
    }
    const r = readEntryFields(
      values,
      id!,
      current.units,
      step !== null ? { geometry: { kind: 'step', blob: step.blob } } : {},
    );
    if (!r.ok) {
      setProblems(r.problems.map((p) => `${p.column}: ${p.message}`));
      return;
    }
    const done = documents
      .getState()
      .execute({ type: 'setCatalogEntry', entry: r.entry }, `Add ${entryItem(r.entry)}`);
    if (!done.ok) {
      setProblems([done.error.message]);
      return;
    }
    setFields({});
    setStep(null);
    setProblems([]);
    onDone(`Added ${entryItem(r.entry)} (${r.entry.id}), not verified.`);
  };

  return (
    <section className="parts-form" data-testid="parts-form">
      <h3>From a datasheet</h3>
      <label className="dialog-field">
        <span>Family</span>
        <select
          data-testid="parts-family"
          value={family}
          onChange={(e) => setFamily(e.target.value as CatalogFamily)}
        >
          {FAMILY_SCHEMAS.map((s) => (
            <option key={s.family} value={s.family}>
              {s.label}
            </option>
          ))}
        </select>
      </label>
      {text('maker', 'Maker')}
      {text('partNumber', 'Part number')}
      {text('description', 'Description')}
      <p className="field-note">
        Values take units (5.4 kN, 17000 rpm, 8 kHz); a bare number is in the unit shown. Write
        unknown for a value the datasheet does not give.
      </p>
      {schema.fields.map((f) => (
        <div key={f.name} className="parts-rating">
          {text(f.name, f.label, hint(f, doc))}
          {f.conventions !== undefined && (
            <label className="dialog-field">
              <span>{f.label}: convention</span>
              <select
                data-testid={`parts-field-${f.name}.convention`}
                value={fields[`${f.name}.convention`] ?? ''}
                onChange={(e) => set(`${f.name}.convention`, e.target.value)}
              >
                <option value="">not stated</option>
                {f.conventions.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
          )}
          {f.basis === true && text(`${f.name}.basis`, `${f.label}: conditions`)}
        </div>
      ))}
      {schema.dimensions.map((d) => text(`dim.${d.name}`, d.label, bareLengthUnit(doc.units)))}
      {text('mass', 'Mass', bareUnit('mass', doc.units))}
      {text('sourceTitle', 'Source: datasheet title')}
      {text('sourceUrl', 'Source: address (http or https)')}
      {text('sourceRead', 'Source: date read', 'YYYY-MM-DD')}
      <label className="dialog-field">
        <span>Geometry</span>
        <select
          data-testid="parts-field-shape"
          value={fields.shape ?? ''}
          disabled={step !== null}
          onChange={(e) => set('shape', e.target.value)}
        >
          <option value="">{`placeholder: ${schema.placeholder}`}</option>
          <option value="cylinder">placeholder: cylinder</option>
          <option value="ring">placeholder: ring</option>
          <option value="box">placeholder: box</option>
        </select>
      </label>
      <label className="dialog-field">
        <span>{step === null ? 'STEP file (optional)' : `STEP file: ${step.name}`}</span>
        <input
          type="file"
          accept=".step,.stp"
          data-testid="parts-step"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file !== undefined) void attachStep(file);
          }}
        />
      </label>
      <label className="dialog-field parts-check">
        <input
          type="checkbox"
          data-testid="parts-field-verified"
          checked={fields.verified === 'yes'}
          onChange={(e) => set('verified', e.target.checked ? 'yes' : 'no')}
        />
        <span>Checked against the maker&apos;s current datasheet</span>
      </label>
      {problems.length > 0 && (
        <ul className="text-error" role="alert" data-testid="parts-form-problems">
          {problems.map((p, i) => (
            <li key={i}>{p}</li>
          ))}
        </ul>
      )}
      <div className="dialog-buttons">
        <button type="button" className="primary" data-testid="parts-add" onClick={save}>
          Add entry
        </button>
      </div>
    </section>
  );
}

export function PartsDialog({
  documents,
  onClose,
  download = downloadBytes,
}: {
  documents: DocumentStoreApi;
  onClose: () => void;
  /** Saves a file (default: a browser download). */
  download?: (bytes: Uint8Array, fileName: string, type: string) => void;
}) {
  const doc = useStore(documents, (s) => s.document);
  const [assemblyId, setAssemblyId] = useState<string>('');
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [adding, setAdding] = useState(false);
  const rows = useMemo(() => catalogRows(doc), [doc]);
  const assembly = doc.assemblies.find((a) => a.id === assemblyId);
  const bom = useMemo(
    () => purchasedBom(doc, assembly !== undefined ? { assemblyId: assembly.id } : {}),
    [doc, assembly],
  );

  const place = async (ref: CatalogRef) => {
    const current = documents.getState().document;
    const placed = await placePurchasedPart(
      current,
      ref,
      assembly !== undefined ? { assemblyId: assembly.id } : {},
    );
    if (!placed.ok) {
      setMessage({ error: true, text: placed.message });
      return;
    }
    const done = documents.getState().execute(placed.command, placed.label);
    if (!done.ok) {
      setMessage({ error: true, text: done.error.message });
      return;
    }
    setMessage({
      error: false,
      text: `${placed.label}: part studio ${placed.partId}${placed.instanceId ? `, instance ${placed.instanceId}` : ''}.`,
    });
  };

  const importCsv = async (file: File) => {
    setProblems([]);
    if (file.size > MAX_CSV_BYTES) {
      setProblems([`${file.name} is over ${MAX_CSV_BYTES} bytes.`]);
      return;
    }
    const text = await file.text();
    const current = documents.getState().document;
    const r = importCatalogCsv(current, text, { units: current.units });
    if (!r.ok) {
      setProblems(r.problems.map(problemText));
      return;
    }
    const done = documents
      .getState()
      .execute(r.command, `Import ${r.entries.length} catalog entries`);
    if (!done.ok) {
      setProblems([done.error.message]);
      return;
    }
    setMessage({
      error: false,
      text: `Imported ${r.entries.length} entries from ${file.name}, none verified unless marked.`,
    });
  };

  const saveBom = () => {
    const text = purchasedBomCsv(bom.rows, doc.units);
    download(
      new TextEncoder().encode(text),
      documentFileName(doc.name, 'purchased parts', 'csv'),
      FABRICATION_MIME.csv,
    );
  };

  return (
    <div className="mech-start-backdrop">
      <section
        className="mech-start parts-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="parts-title"
        data-testid="parts-dialog"
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
        }}
      >
        <h2 id="parts-title">Purchased parts</h2>
        <p className="field-note" data-testid="parts-disclaimer">
          {DISCLAIMER_SHORT}
        </p>
        <label className="dialog-field">
          <span>Place into</span>
          <select
            data-testid="parts-assembly"
            value={assemblyId}
            onChange={(e) => setAssemblyId(e.target.value)}
          >
            <option value="">a new part studio only</option>
            {doc.assemblies.map((a) => (
              <option key={a.id} value={a.id}>
                {`a new part studio and an instance in ${a.name}`}
              </option>
            ))}
          </select>
        </label>
        <table className="parts-table" data-testid="parts-catalog">
          <thead>
            <tr>
              <th>Part</th>
              <th>Data</th>
              <th>Geometry</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={refKey(r.ref)} data-testid={`parts-entry-${refKey(r.ref)}`}>
                <td>
                  {r.url !== undefined ? (
                    <a href={r.url} target="_blank" rel="noopener noreferrer">
                      {r.item}
                    </a>
                  ) : (
                    r.item
                  )}
                  {r.ref.source === 'document' && <em className="parts-unit"> {r.ref.id}</em>}
                </td>
                <td>{r.verified ? 'verified' : 'not verified'}</td>
                <td>{r.geometry}</td>
                <td>
                  <button
                    type="button"
                    data-testid={`parts-place-${refKey(r.ref)}`}
                    onClick={() => void place(r.ref)}
                  >
                    Place
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="dialog-buttons">
          <button type="button" data-testid="parts-new" onClick={() => setAdding((a) => !a)}>
            {adding ? 'Hide the datasheet form' : 'Add from a datasheet'}
          </button>
          <label className="parts-file">
            <span>Import CSV</span>
            <input
              type="file"
              accept=".csv,text/csv"
              data-testid="parts-csv"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file !== undefined) void importCsv(file);
                e.target.value = '';
              }}
            />
          </label>
        </div>
        {problems.length > 0 && (
          <ul className="text-error" role="alert" data-testid="parts-csv-problems">
            {problems.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
        )}
        {adding && (
          <EntryForm
            documents={documents}
            onDone={(text) => {
              setAdding(false);
              setMessage({ error: false, text });
            }}
          />
        )}
        <h3>Bill of materials</h3>
        {bom.rows.length === 0 ? (
          <p className="field-note">No purchased parts are used yet.</p>
        ) : (
          <table className="parts-table" data-testid="parts-bom">
            <thead>
              <tr>
                {['Item', 'Quantity', 'Ratings', 'Alternates'].map((c) => (
                  <th key={c}>{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {bom.rows.map((r) => (
                <tr key={r.key}>
                  <td>
                    {r.item}
                    {r.flags.includes('unverified') && (
                      <em className="parts-unit"> not verified</em>
                    )}
                  </td>
                  <td>{Number(r.quantity.toPrecision(12))}</td>
                  <td>{(r.ratings ?? []).map(formatRating).join('; ')}</td>
                  <td>{(r.alternates ?? []).join('; ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {bom.warnings.map((w, i) => (
          <p key={i} className="text-error">
            {w}
          </p>
        ))}
        {message !== null && (
          <p
            className={message.error ? 'text-error' : 'field-note'}
            role={message.error ? 'alert' : 'status'}
            data-testid="parts-message"
          >
            {message.text}
          </p>
        )}
        <div className="dialog-buttons">
          <button
            type="button"
            data-testid="parts-save-bom"
            disabled={bom.rows.length === 0}
            title={`CSV with the columns ${BOM_COLUMNS.join(', ')}`}
            onClick={saveBom}
          >
            Save BOM CSV
          </button>
          <button type="button" data-testid="parts-close" onClick={onClose}>
            Close
          </button>
        </div>
      </section>
    </div>
  );
}

/** The Parts button of the part studio's toolbar. */
export function MechPartsButton({
  documents,
  disabled,
}: {
  documents: DocumentStoreApi;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="toolbar-group" role="toolbar" aria-label="Purchased parts">
      <button
        type="button"
        aria-pressed={open}
        disabled={disabled}
        data-testid="parts-open"
        title="Purchased parts with ratings: the catalog, datasheet entries, placing, the BOM"
        onClick={() => setOpen(true)}
      >
        Parts
      </button>
      {open && <PartsDialog documents={documents} onClose={() => setOpen(false)} />}
    </div>
  );
}
