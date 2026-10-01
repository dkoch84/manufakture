// The pinned-part picker: a document from the library, one of its named versions (or a version
// made there and then with **Create version now**), and a part studio of it. Once all three are
// chosen it reads that version back (its imports and pins inline) and hands over the pin. Used by
// the derived part dialog; assembly instances of pinned parts (T2.3e) take the same picker.
//
// Every read is one short library call: the document list, the chosen document's versions, the
// chosen version. Nothing else of other documents is opened, so the open document's autosave
// never waits long behind it. A choice made while an earlier one is still being read wins: the
// earlier read's result is dropped.

import { useEffect, useRef, useState } from 'react';
import type { DerivedSource, ManufaktureDocument } from '@manufakture/core';
import type { DocumentSummary, LibraryResult, Version } from '../persistence/library';
import type { CreateVersion } from '../history/history';
import { VersionList } from '../history/VersionList';
import '../history/history.css';
import { pinOf, sourceParts, type PinLibrary, type PinnedPart } from './derived';

export interface PinnedPartPickerProps {
  library: PinLibrary;
  /** The open document: its versions are made through `createVersion` (which saves first). */
  currentDocumentId: string;
  /** Name the open document's current state; null when it cannot (nothing is saved). */
  createVersion?: CreateVersion | null;
  /** The pin to start from (editing one): its document, version and part are chosen. */
  initial?: Pick<DerivedSource, 'documentId' | 'versionId' | 'partId'> | null;
  /** Carried onto the pin unchanged (a configuration row, T2.4c). */
  configuration?: string | undefined;
  /** A complete choice, read and pinned; null while it is not (or no longer) complete. */
  onChange: (pinned: PinnedPart | null) => void;
  disabled?: boolean;
}

type Loading<T> =
  { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; value: T };

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** A library call that throws becomes a failed result. */
async function settled<T>(call: () => Promise<LibraryResult<T>>): Promise<LibraryResult<T>> {
  try {
    return await call();
  } catch (e) {
    return { ok: false, message: message(e) };
  }
}

export function PinnedPartPicker({
  library,
  currentDocumentId,
  createVersion = null,
  initial = null,
  configuration,
  onChange,
  disabled = false,
}: PinnedPartPickerProps) {
  const [documents, setDocuments] = useState<Loading<DocumentSummary[]>>({ state: 'loading' });
  const [documentId, setDocumentId] = useState<string>(initial?.documentId ?? '');
  const [versions, setVersions] = useState<Loading<Version[]> | null>(
    initial ? { state: 'loading' } : null,
  );
  const [version, setVersion] = useState<Version | null>(null);
  const [read, setRead] = useState<Loading<ManufaktureDocument> | null>(null);
  const [partId, setPartId] = useState<string>(initial?.partId ?? '');
  const [naming, setNaming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  // What the async steps read when they finish: the latest callbacks and choices.
  const latest = useRef({ onChange, configuration, partId, names: new Map<string, string>() });
  useEffect(() => {
    latest.current.onChange = onChange;
    latest.current.configuration = configuration;
  }, [onChange, configuration]);
  // Each choice numbers itself; a step that finds a later number gives up.
  const seq = useRef(0);

  /** Pin part `part` of `doc` at `v` and hand it over. */
  const emit = async (doc: ManufaktureDocument, v: Version, part: string, mine: number) => {
    const { configuration: row, names } = latest.current;
    const name = names.get(doc.id);
    const r = await pinOf(doc, v, part, {
      ...(name !== undefined ? { documentName: name } : {}),
      ...(row !== undefined ? { configuration: row } : {}),
    });
    if (mine !== seq.current) return;
    setFailure(r.ok ? null : r.message);
    latest.current.onChange(r.ok ? { source: r.value, document: doc } : null);
  };

  /** Read version `v` of document `id`, choose a part studio of it, and pin it. */
  const readAt = async (id: string, v: Version, mine: number) => {
    setVersion(v);
    setRead({ state: 'loading' });
    latest.current.onChange(null);
    const r = await settled(() => library.readVersion(id, v.id));
    if (mine !== seq.current) return;
    if (!r.ok) {
      setRead({ state: 'error', message: r.message });
      return;
    }
    const doc = r.value.document;
    setRead({ state: 'ready', value: doc });
    // The part studio chosen before, if this version has it; else its first.
    const wanted = latest.current.partId;
    const part = doc.parts.some((p) => p.id === wanted) ? wanted : (doc.parts[0]?.id ?? '');
    latest.current.partId = part;
    setPartId(part);
    if (part !== '') await emit(doc, v, part, mine);
  };

  /** List document `id`'s versions, then read the one `want` names, if any. */
  const listAt = async (id: string, want: string | null, mine: number) => {
    const r = await settled(() => library.listVersions(id));
    if (mine !== seq.current) return;
    if (!r.ok) {
      setVersions({ state: 'error', message: r.message });
      return;
    }
    setVersions({ state: 'ready', value: r.value });
    const found = want === null ? undefined : r.value.find((v) => v.id === want);
    if (found) await readAt(id, found, mine);
  };

  // The documents, and the initial pin's document and version, once.
  useEffect(() => {
    let cancelled = false;
    library.list().then(
      (list) => {
        if (cancelled) return;
        const usable = list.filter((d) => d.damaged === undefined);
        latest.current.names = new Map(usable.map((d) => [d.id, d.name]));
        setDocuments({ state: 'ready', value: usable });
      },
      (e: unknown) => {
        if (!cancelled) setDocuments({ state: 'error', message: message(e) });
      },
    );
    if (initial) void listAt(initial.documentId, initial.versionId, ++seq.current);
    return () => {
      cancelled = true;
      seq.current += 1;
    };
    // Once per picker: a new initial pin is a new picker (the dialog keys it).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [library]);

  const chooseDocument = (id: string) => {
    const mine = ++seq.current;
    setDocumentId(id);
    setVersion(null);
    setRead(null);
    setNaming(null);
    setFailure(null);
    latest.current.onChange(null);
    setVersions(id === '' ? null : { state: 'loading' });
    if (id !== '') void listAt(id, null, mine);
  };

  const chooseVersion = (v: Version) => {
    setFailure(null);
    void readAt(documentId, v, ++seq.current);
  };

  const choosePart = (part: string) => {
    const mine = ++seq.current;
    latest.current.partId = part;
    setPartId(part);
    if (read?.state === 'ready' && version) void emit(read.value, version, part, mine);
  };

  const create = () => {
    if (naming === null) return;
    const name = naming.trim();
    if (name === '') {
      setFailure('A version needs a name.');
      return;
    }
    setBusy(true);
    const id = documentId;
    const made: Promise<LibraryResult<Version>> =
      id === currentDocumentId
        ? createVersion
          ? settled(() => createVersion({ name }))
          : Promise.resolve({ ok: false, message: 'The open document is not saved yet.' })
        : settled(() => library.createVersion(id, { name }));
    void made
      .then(async (r) => {
        if (!r.ok) {
          setFailure(r.message);
          return;
        }
        setNaming(null);
        setFailure(null);
        await listAt(id, r.value.id, ++seq.current);
      })
      .finally(() => setBusy(false));
  };

  const canCreate =
    documentId !== '' && (documentId !== currentDocumentId || createVersion !== null);
  const sourceDoc = read?.state === 'ready' ? read.value : null;
  const parts = sourceDoc ? sourceParts(sourceDoc) : [];

  return (
    <fieldset className="dialog-field pin-picker" data-testid="pin-picker" disabled={disabled}>
      <legend>Source</legend>
      <div className="dialog-field">
        <label>
          Document
          <select
            value={documentId}
            data-testid="pin-document"
            onChange={(e) => chooseDocument(e.target.value)}
          >
            <option value="">
              {documents.state === 'loading' ? 'Loading documents...' : 'Choose a document'}
            </option>
            {documents.state === 'ready' &&
              documents.value.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.id === currentDocumentId ? `${d.name} (this document)` : d.name}
                </option>
              ))}
          </select>
        </label>
        {documents.state === 'error' && <span className="field-error">{documents.message}</span>}
        {documents.state === 'ready' && documents.value.length === 0 && (
          <p className="field-note">No saved documents yet.</p>
        )}
      </div>
      {documentId !== '' && (
        <div className="dialog-field pin-versions" data-testid="pin-versions">
          <span>Version</span>
          {versions?.state === 'loading' && <p className="field-note">Loading versions...</p>}
          {versions?.state === 'error' && <span className="field-error">{versions.message}</span>}
          {versions?.state === 'ready' && (
            <VersionList
              versions={versions.value}
              pickLabel="Use"
              currentId={version?.id ?? null}
              disabled={disabled || busy}
              onPick={chooseVersion}
            />
          )}
          {canCreate &&
            (naming === null ? (
              <button
                type="button"
                data-testid="pin-create-version"
                disabled={disabled || busy}
                onClick={() => setNaming('')}
              >
                Create version now
              </button>
            ) : (
              <div className="pin-create" data-testid="pin-create-form">
                <label>
                  Version name
                  <input
                    type="text"
                    value={naming}
                    autoFocus
                    data-testid="pin-version-name"
                    onChange={(e) => setNaming(e.target.value)}
                    onKeyDown={(e) => {
                      // The dialog around takes Enter and Escape otherwise.
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        e.stopPropagation();
                        create();
                      } else if (e.key === 'Escape') {
                        e.preventDefault();
                        e.stopPropagation();
                        setNaming(null);
                      }
                    }}
                  />
                </label>
                <button
                  type="button"
                  data-testid="pin-version-save"
                  disabled={busy}
                  onClick={create}
                >
                  Create
                </button>
                <button type="button" disabled={busy} onClick={() => setNaming(null)}>
                  Cancel
                </button>
              </div>
            ))}
        </div>
      )}
      {version && (
        <div className="dialog-field">
          {read?.state === 'loading' && <p className="field-note">Reading {version.name}...</p>}
          {read?.state === 'error' && <span className="field-error">{read.message}</span>}
          {sourceDoc && (
            <label>
              Part studio
              <select
                value={partId}
                data-testid="pin-part"
                onChange={(e) => choosePart(e.target.value)}
              >
                {parts.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      )}
      {failure && (
        <span className="field-error" role="alert" data-testid="pin-error">
          {failure}
        </span>
      )}
    </fieldset>
  );
}
