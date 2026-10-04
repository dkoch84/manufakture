// The script editor: one script of the document's library (or a new one), its name, language
// and source, with the errors regen reports for it marked in the source and listed under it.
// Save writes it to the document as one undo step (`setScript`) and allows exactly this source to
// run on this device (policy.ts: what the user writes counts as allowed); Close leaves the
// document alone, asking first when there are unsaved changes. The code area is CodeMirror,
// loaded with the editor's first use (CodeEditor.tsx); tests pass a plain text area instead.

import { MAX_SCRIPT_NAME } from '@manufakture/core';
import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { useModel, type ModelStore } from '../model/model';
import type { DocumentStoreApi } from '../state/document';
import type { CodeEditorComponent, EditorMarker } from './editorTypes';
import type { ScriptGrantsStore } from './policy';
import { positionText, scriptProblems } from './problems';
import { draftOf, scriptFromDraft, type Draft } from './library';
import { NEW_SCRIPT_SOURCE } from './template';
import './scripts.css';

const LazyCodeEditor = lazy(() => import('./CodeEditor'));

export interface ScriptEditorProps {
  documents: DocumentStoreApi;
  model: ModelStore;
  grants: ScriptGrantsStore;
  /** The script to edit; null for a new one. */
  scriptId: string | null;
  /** A new script was saved under this id: the editor goes on editing it. */
  onSaved?: (scriptId: string) => void;
  onClose: () => void;
  /** The code area (default: CodeMirror, loaded on first use). */
  Editor?: CodeEditorComponent;
}

export function ScriptEditor({
  documents,
  model,
  grants,
  scriptId,
  onSaved,
  onClose,
  Editor = LazyCodeEditor,
}: ScriptEditorProps) {
  const doc = useStore(documents, (s) => s.document);
  const stored = scriptId === null ? undefined : doc.scripts?.find((s) => s.id === scriptId);
  const [draft, setDraft] = useState<Draft>(() => draftOf(documents.getState().document, scriptId));
  const [error, setError] = useState<string | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const [saving, setSaving] = useState(false);
  const dirty =
    stored === undefined ||
    draft.name.trim() !== stored.name ||
    draft.language !== stored.language ||
    draft.source !== stored.source;

  // Problems are those of the source as stored: a draft not saved yet has not been built.
  const parts = useModel(model, (s) => s.parts);
  const built = useModel(model, (s) => s.document);
  const problems = useMemo(
    () => (scriptId === null || built === null ? [] : scriptProblems(built, parts, scriptId)),
    [built, parts, scriptId],
  );
  const markers = useMemo<EditorMarker[]>(
    () =>
      stored !== undefined && draft.source === stored.source
        ? problems
            .filter((p) => p.line !== undefined)
            .map((p) => ({
              message: p.message,
              source: p.where,
              ...(p.line !== undefined ? { line: p.line } : {}),
              ...(p.column !== undefined ? { column: p.column } : {}),
            }))
        : [],
    [problems, stored, draft.source],
  );

  // Focus moves in on open and back on close.
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    const opener = document.activeElement;
    panel.current?.querySelector<HTMLInputElement>('input')?.focus();
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);

  const save = async () => {
    const current = documents.getState().document;
    const r = scriptFromDraft(current, scriptId, draft);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    setSaving(true);
    let granted = false;
    try {
      // Allowed first, so the regen the save starts runs it; taken back if the save fails.
      granted = await grants.getState().allowSource(current.id, r.script.id, r.script.source);
    } catch {
      // No Web Crypto: the script is saved, and runs once the document is allowed.
    }
    setSaving(false);
    const done = documents
      .getState()
      .execute(
        { type: 'setScript', script: r.script },
        `${stored ? 'Edit' : 'Add'} script ${r.script.name}`,
      );
    if (!done.ok) {
      if (granted) {
        void grants
          .getState()
          .revokeSource(current.id, r.script.id, r.script.source)
          .catch(() => undefined);
      }
      setError(done.error.message);
      return;
    }
    setError(null);
    if (scriptId === null) onSaved?.(r.script.id);
  };

  const close = () => {
    if (dirty && stored !== undefined) setConfirmClose(true);
    else if (dirty && draft.source !== NEW_SCRIPT_SOURCE) setConfirmClose(true);
    else onClose();
  };

  const title = stored?.name ?? 'New script';
  return (
    <section
      ref={panel}
      className="script-editor"
      role="dialog"
      aria-label={`Script: ${title}`}
      data-testid="script-editor"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !e.defaultPrevented) {
          e.preventDefault();
          e.stopPropagation();
          close();
        }
      }}
    >
      <header className="script-editor-head">
        <h2>Script: {title}</h2>
        <label>
          Name
          <input
            data-testid="script-name"
            value={draft.name}
            maxLength={MAX_SCRIPT_NAME}
            onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
          />
        </label>
        <label>
          Language
          <select
            data-testid="script-language"
            value={draft.language}
            onChange={(e) =>
              setDraft((d) => ({ ...d, language: e.target.value === 'ts' ? 'ts' : 'js' }))
            }
          >
            <option value="js">JavaScript</option>
            <option value="ts">TypeScript</option>
          </select>
        </label>
        {stored && <span className="badge">API version {stored.apiVersion}</span>}
      </header>
      <div className="script-editor-body">
        <Suspense fallback={<p className="field-note">Opening the editor...</p>}>
          <Editor
            value={draft.source}
            language={draft.language}
            markers={markers}
            label={`Source of ${title}`}
            onChange={(source) => setDraft((d) => ({ ...d, source }))}
          />
        </Suspense>
      </div>
      {problems.length > 0 && (
        <ul className="script-problems" data-testid="script-problems" aria-label="Problems">
          {problems.map((p, i) => (
            <li key={`${p.featureId}/${i}`} data-testid="script-problem">
              <strong>{p.where}</strong>
              {p.line !== undefined && (
                <span className="script-at"> ({positionText(p)})</span>
              )}: {p.message}
            </li>
          ))}
        </ul>
      )}
      {stored !== undefined && dirty && problems.length > 0 && (
        <p className="field-note">The problems above are those of the saved script.</p>
      )}
      {error && (
        <p className="field-error" role="alert" data-testid="script-error">
          {error}
        </p>
      )}
      {confirmClose ? (
        <div className="dialog-buttons" role="alert">
          <span>Discard the changes not saved?</span>
          <button type="button" data-testid="script-discard" onClick={onClose}>
            Discard
          </button>
          <button type="button" onClick={() => setConfirmClose(false)}>
            Keep editing
          </button>
        </div>
      ) : (
        <div className="dialog-buttons">
          <button
            type="button"
            className="primary"
            data-testid="script-save"
            disabled={saving || (!dirty && stored !== undefined)}
            onClick={() => void save()}
          >
            Save
          </button>
          <button type="button" data-testid="script-close" onClick={close}>
            Close
          </button>
        </div>
      )}
    </section>
  );
}

export default ScriptEditor;
